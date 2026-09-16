import { db, createCampaign, remainingQuota, suppressedEmails, recentlyContactedEmails, globalVars, getSetting, sqliteNow } from "./db.js";
import { parseCsv, parseRecipientLines, findMissingVars, type ParsedContact } from "./render.js";

export type CampaignInput = {
  accountLabel: string;
  subject: string;
  body: string;
  mode: "common" | "personalized";
  scheduledAt: string | null;
  unsubscribe?: boolean;
  bodyFormat?: "text" | "html";
  followup?: { days: number; subject: string; body: string } | null;
  attachments?: { filename: string; base64: string }[];
  recipientsText?: string;
  listName?: string;
  csvText?: string;
  name?: string;
};

export type CampaignOutcome = {
  id: number;
  count: number;
  status: "scheduled" | "sending";
  warnings: string[];
};

/** Point d'entrée unique : résout le compte + les destinataires, crée la campagne. */
export function queueCampaign(input: CampaignInput): CampaignOutcome {
  const account = db
    .prepare("SELECT id, label FROM smtp_accounts WHERE label = ?")
    .get(input.accountLabel) as { id: number; label: string } | undefined;
  if (!account) {
    const labels = (db.prepare("SELECT label FROM smtp_accounts").all() as { label: string }[])
      .map((r) => r.label)
      .join(", ");
    throw new Error(
      `Compte SMTP "${input.accountLabel}" introuvable. Comptes configurés : ${labels || "aucun"}`
    );
  }

  let recipients: ParsedContact[];
  if (input.csvText) {
    recipients = parseCsv(input.csvText);
  } else if (input.listName) {
    const rows = db
      .prepare("SELECT email, name, vars_json FROM contacts WHERE list_name = ?")
      .all(input.listName) as { email: string; name: string; vars_json: string }[];
    recipients = rows.map((r) => {
      const vars = safeVars(r.vars_json);
      vars["nom"] = vars["nom"] || r.name;
      return { email: r.email, name: r.name, vars };
    });
    if (recipients.length === 0) {
      throw new Error(`Liste "${input.listName}" vide ou inexistante.`);
    }
  } else if (input.recipientsText) {
    recipients = parseRecipientLines(input.recipientsText);
    if (recipients.length === 0) {
      throw new Error("Aucune ligne de destinataire valide (format : email ; nom ; cle=valeur).");
    }
  } else {
    throw new Error("Fournis des destinataires : recipientsText, listName ou csvText.");
  }

  const warnings: string[] = [];

  // Relance auto : sans sujet ou corps, elle ne partirait jamais — on refuse.
  if (input.followup && input.followup.days > 0) {
    if (!input.followup.subject?.trim() || !input.followup.body?.trim()) {
      throw new Error("Relance auto (followup_days) : followup_subject et followup_body sont requis.");
    }
  }

  // Désinscrits du compte : exclus d'office, ils ne doivent plus rien recevoir.
  const supp = suppressedEmails(account.id);
  if (supp.size > 0) {
    const before = recipients.length;
    recipients = recipients.filter((r) => !supp.has(r.email.toLowerCase()));
    const excluded = before - recipients.length;
    if (excluded > 0) {
      warnings.push(`${excluded} destinataire(s) exclu(s) : désinscrit(s) de ce compte (liste de suppression).`);
    }
    if (recipients.length === 0) {
      throw new Error("Tous les destinataires sont désinscrits pour ce compte.");
    }
  }

  // Cooldown : pas de 2e mail au même contact avant N jours (réglage cooldown_days, défaut 7).
  const cooldownDays = Number(getSetting("cooldown_days", "7"));
  if (cooldownDays > 0) {
    const recent = recentlyContactedEmails(account.id, cooldownDays);
    if (recent.size > 0) {
      const before = recipients.length;
      recipients = recipients.filter((r) => !recent.has(r.email.toLowerCase()));
      const excluded = before - recipients.length;
      if (excluded > 0) {
        warnings.push(
          `${excluded} destinataire(s) exclu(s) : contacté(s) il y a moins de ${cooldownDays} jour(s) (cooldown, réglage cooldown_days).`
        );
      }
      if (recipients.length === 0) {
        throw new Error(
          `Tous les destinataires ont reçu un mail de ce compte il y a moins de ${cooldownDays} jours (cooldown).`
        );
      }
    }
  }

  // Doublons (insensible à la casse) : on garde la 1re occurrence.
  const seen = new Set<string>();
  const unique = recipients.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const duplicates = recipients.length - unique.length;
  if (duplicates > 0) {
    warnings.push(`${duplicates} doublon(s) ignoré(s) : un même email ne reçoit qu'un seul mail.`);
  }
  recipients = unique;

  // Variables utilisées dans le texte mais absentes de tous les contacts
  // (les variables globales comptent comme définies).
  const globals = globalVars();
  const missing = findMissingVars(`${input.subject}\n${input.body}`, recipients).filter(
    (k) => globals[k] === undefined
  );
  if (missing.length > 0 && input.mode === "personalized") {
    warnings.push(
      `Variable(s) ${missing.map((m) => `{${m}}`).join(", ")} absente(s) des contacts : elles resteront vides dans les mails.`
    );
  }

  const when = input.scheduledAt ? normalizeDate(input.scheduledAt) : sqliteNow();
  const remaining = remainingQuota(account.id);
  if (remaining !== null && recipients.length > remaining) {
    warnings.push(
      `Quota du compte épuisé dans ${remaining} envoi(s) : seuls les ${remaining} premiers partiront aujourd'hui, ` +
      `le reste demain même heure (limites du fournisseur SMTP).`
    );
  }
  const { id } = createCampaign({
    name: input.name ?? input.subject.slice(0, 60),
    accountId: account.id,
    subject: input.subject,
    body: input.body,
    mode: input.mode,
    scheduledAt: when,
    unsubscribe: input.unsubscribe,
    bodyFormat: input.bodyFormat,
    followup: input.followup,
    attachments: input.attachments,
    recipients: recipients.map((r) => ({ email: r.email, vars: r.vars })),
  });

  return { id, count: recipients.length, status: "scheduled", warnings };
}

function normalizeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Date invalide : "${iso}" (format attendu : ISO, ex 2026-09-16T09:00:00)`);
  }
  if (d.getTime() < Date.now() - 60_000) {
    throw new Error("La date d'envoi est dans le passé.");
  }
  // Format SQLite "YYYY-MM-DD HH:MM:SS" (UTC) pour comparer avec datetime('now')
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function safeVars(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}