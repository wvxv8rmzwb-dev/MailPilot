import { db, getSetting, setSetting, sentToday, remainingQuota, suppressedEmails, createCampaign } from "./db.js";
import { sendToRecipients, isTransientError, createTransport, type SmtpAccount } from "./mailer.js";
import { pollImapAccounts } from "./imap.js";

type CampaignRow = {
  id: number;
  account_id: number;
  subject: string;
  body: string;
  mode: "common" | "personalized";
  unsubscribe: number;
  body_format: string;
  attachments_json: string | null;
};

type RecipientRow = {
  id: number;
  email: string;
  vars_json: string;
};

let running = false;
let lastImapPoll = 0;
let lastReportDate = "";

/** Boucle du daemon : toutes les 15 s, envoie les campagnes dues. */
export function startScheduler(): void {
  const intervalMs = Number(getSetting("scheduler_interval_ms", "15000"));
  recoverOrphanedCampaigns();
  void tick();
  setInterval(() => void tick(), Math.max(5000, intervalMs));
}

/**
 * Au démarrage du daemon, une campagne en `sending` est forcément orpheline :
 * le processus précédent a été tué en plein envoi. On la remet en `scheduled`
 * pour qu'elle reparte — les destinataires déjà `sent` sont ignorés par
 * sendCampaign (seuls les `pending` sont repris).
 */
function recoverOrphanedCampaigns(): void {
  const orphans = db
    .prepare("SELECT id FROM campaigns WHERE status = 'sending'")
    .all() as { id: number }[];
  for (const o of orphans) {
    db.prepare("UPDATE campaigns SET status = 'scheduled' WHERE id = ?").run(o.id);
    console.log(`Campagne #${o.id} : reprise après arrêt du daemon (envoi interrompu).`);
  }
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    setSetting("daemon_heartbeat", new Date().toISOString());
    await maybePollImap();
    maybeSendDailyReport();
    // Fenêtre d'envoi (heure locale) : hors fenêtre, on attend la prochaine ouverture.
    if (!inSendWindow()) return;
    const due = db
      .prepare(
        `SELECT id, account_id, subject, body, mode, unsubscribe, body_format, attachments_json
         FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= datetime('now')`
      )
      .all() as CampaignRow[];
    for (const c of due) {
      if (postponeIfDailyCapped(c)) continue; // cap déjà atteint : repart demain
      await sendCampaign(c);
    }
  } finally {
    running = false;
  }
}

/** Poll IMAP (réponses STOP, bounces) au plus toutes les imap_poll_minutes. */
async function maybePollImap(): Promise<void> {
  const minutes = Math.max(1, Number(getSetting("imap_poll_minutes", "5")));
  if (Date.now() - lastImapPoll < minutes * 60_000) return;
  lastImapPoll = Date.now();
  await pollImapAccounts().catch(() => undefined);
}

/**
 * Rapport quotidien à soi-même (une fois par jour, après report_hour local,
 * défaut 20:00) : envois/échecs du jour, campagnes en attente, quota restant.
 */
export function maybeSendDailyReport(now = new Date()): void {
  const today = new Date().toISOString().slice(0, 10);
  if (lastReportDate === today) return;
  const [h, m] = getSetting("report_hour", "20:00").split(":").map(Number);
  const cur = now.getHours() * 60 + (now.getMinutes() ?? 0);
  if (cur < (h ?? 20) * 60 + (m ?? 0)) return;
  lastReportDate = today;

  const accounts = db.prepare("SELECT * FROM smtp_accounts").all() as SmtpAccount[];
  for (const acc of accounts) {
    const sent = sentToday(acc.id);
    const failedToday = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM recipients r JOIN campaigns cp ON cp.id = r.campaign_id
           WHERE cp.account_id = ? AND r.status = 'failed' AND r.sent_at IS NULL AND r.error IS NOT NULL`
        )
        .get(acc.id) as { n: number }
    ).n;
    const campList = (
      db
        .prepare(
          `SELECT id, name, scheduled_at FROM campaigns
           WHERE account_id = ? AND status = 'scheduled' ORDER BY scheduled_at LIMIT 5`
        )
        .all(acc.id) as { id: number; name: string; scheduled_at: string }[]
    )
      .map((c) => `  - #${c.id} ${c.name} — prévu ${c.scheduled_at}`)
      .join("\n");
    const cap = Number(
      (db.prepare("SELECT daily_cap FROM smtp_accounts WHERE id = ?").get(acc.id) as { daily_cap: number }).daily_cap
    );
    const quota =
      cap > 0
        ? `Quota du jour : ${sent}/${cap} (reste ${Math.max(0, cap - sent)}).`
        : `Envois du jour : ${sent} (illimité).`;
    const body =
      `Rapport quotidien MailPilot — compte ${acc.label} (${acc.user})\n\n` +
      `${quota}\n` +
      `Échecs en attente de relance manuelle : ${failedToday}.\n` +
      (campList ? `\nCampagnes programmées :\n${campList}\n` : "") +
      `\nDashboard : http://localhost:3777`;
    if (sent === 0 && failedToday === 0) continue; // rien à signaler sur ce compte
    createTransport(acc)
      .sendMail({
        from: acc.from_name ? { name: acc.from_name, address: acc.user } : acc.user,
        to: acc.user,
        subject: `MailPilot — rapport du jour (${today})`,
        text: body,
      })
      .then(() => console.log(`Rapport quotidien envoyé à ${acc.user}.`))
      .catch((err: unknown) =>
        console.log(`Rapport quotidien : échec d'envoi à ${acc.user} : ${err instanceof Error ? err.message : String(err)}`)
      );
  }
}

/** True si l'heure locale est dans la fenêtre d'envoi (settings, défaut 08:00–20:00). */
export function inSendWindow(now = new Date()): boolean {
  const start = getSetting("send_window_start", "08:00");
  const end = getSetting("send_window_end", "20:00");
  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= minutes(start) && cur <= minutes(end);
}

/**
 * Cap effectif du compte (daily_cap ∩ warm-up) : si déjà atteint, la campagne
 * attend demain même heure (le compte SMTP risque un blocage au-delà).
 * Retourne true si la campagne a été repoussée.
 */
function postponeIfDailyCapped(c: CampaignRow): boolean {
  const rem = remainingQuota(c.account_id);
  if (rem === null || rem > 0) return false;
  db.prepare(
    "UPDATE campaigns SET scheduled_at = datetime(scheduled_at, '+1 day') WHERE id = ? AND status = 'scheduled'"
  ).run(c.id);
  console.log(`Campagne #${c.id} : cap quotidien (ou warm-up) atteint, repoussée à demain.`);
  return true;
}

export async function sendCampaign(c: CampaignRow): Promise<void> {
  const claim = db.prepare(
    "UPDATE campaigns SET status = 'sending' WHERE id = ? AND status = 'scheduled'"
  );
  if (claim.run(c.id).changes === 0) return; // déjà pris (autre process ou annulé)

  const account = db
    .prepare("SELECT * FROM smtp_accounts WHERE id = ?")
    .get(c.account_id) as SmtpAccount | undefined;
  const recipients = db
    .prepare(
      "SELECT r.id, r.email, r.vars_json FROM recipients r WHERE r.campaign_id = ? AND r.status = 'pending'"
    )
    .all(c.id) as RecipientRow[];

  if (!account || recipients.length === 0) {
    db.prepare("UPDATE campaigns SET status = 'failed', error = ? WHERE id = ?").run(
      account ? "Aucun destinataire en attente" : "Compte SMTP introuvable",
      c.id
    );
    return;
  }

  const delayMs = Number(getSetting("send_delay_ms", "3000"));
  const updOk = db.prepare(
    "UPDATE recipients SET status = 'sent', sent_at = datetime('now'), error = NULL WHERE id = ?"
  );
  const updKo = db.prepare(
    "UPDATE recipients SET status = 'failed', error = ? WHERE id = ?"
  );

  await sendToRecipients(
    account,
    c.subject,
    c.body,
    c.mode,
    recipients.map((r) => {
      const vars = safeVars(r.vars_json);
      return { email: r.email, name: vars["nom"] ?? "", vars };
    }),
    delayMs,
    (email, ok, info) => {
      const row = recipients.find((r) => r.email === email);
      if (!row) return;
      if (ok) updOk.run(row.id);
      else updKo.run(info.error ?? "Erreur inconnue", row.id);
    },
    { unsubscribe: c.unsubscribe === 1, bodyFormat: c.body_format === "html" ? "html" : "text", remaining: remainingQuota(c.account_id), attachments: safeAttachments(c.attachments_json) }
  );

  const counts = db
    .prepare(
      `SELECT SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM recipients WHERE campaign_id = ?`
    )
    .get(c.id) as { sent: number | null; failed: number | null; pending: number | null };
  const sent = counts.sent ?? 0;
  const failed = counts.failed ?? 0;
  const pending = counts.pending ?? 0;

  // Des destinataires n'ont pas été touchés : le quota s'est épuisé en cours
  // d'envoi. La campagne repart demain (même heure) pour le reste.
  if (pending > 0) {
    db.prepare(
      "UPDATE campaigns SET status = 'scheduled', scheduled_at = datetime(scheduled_at, '+1 day'), error = ? WHERE id = ?"
    ).run(`${pending} envoi(s) reportés à demain : cap quotidien atteint.`, c.id);
    console.log(`Campagne #${c.id} : cap quotidien atteint en cours d'envoi, ${pending} reporté(s) à demain.`);
    return;
  }

  // Échec global d'origine temporaire (SMTP injoignable...) : un essai auto
  // plus tard, sauf si le plafond d'essais est déjà atteint.
  if (sent === 0 && failed > 0 && maybeAutoRetry(c.id)) return;

  const status = sent ? "done" : "failed";
  db.prepare("UPDATE campaigns SET status = ?, error = ? WHERE id = ?").run(
    status,
    failed ? `${failed} envoi(s) en échec` : null,
    c.id
  );
  if (sent > 0) scheduleFollowUp(c.id, c);
}

/**
 * Un seul essai auto (réglable via settings max_auto_retries) si tous les
 * échecs de la campagne sont d'origine temporaire. True si un essai est programmé.
 */
function maybeAutoRetry(campaignId: number): boolean {
  const max = Number(getSetting("max_auto_retries", "1"));
  const row = db.prepare("SELECT auto_retries FROM campaigns WHERE id = ?").get(campaignId) as
    | { auto_retries: number }
    | undefined;
  if ((row?.auto_retries ?? 0) >= max) return false;
  const errs = db
    .prepare("SELECT error FROM recipients WHERE campaign_id = ? AND status = 'failed'")
    .all(campaignId) as { error: string | null }[];
  const allTransient = errs.length > 0 && errs.every((e) => isTransientError(e.error ?? ""));
  if (!allTransient) return false;
  db.transaction(() => {
    db.prepare(
      "UPDATE recipients SET status = 'pending', error = NULL, sent_at = NULL WHERE campaign_id = ? AND status = 'failed'"
    ).run(campaignId);
    db.prepare(
      "UPDATE campaigns SET status = 'scheduled', scheduled_at = datetime('now', '+15 minutes'), auto_retries = auto_retries + 1, error = ? WHERE id = ?"
    ).run("Échec temporaire (SMTP injoignable ?) : nouvel essai auto dans 15 min.", campaignId);
  })();
  console.log(`Campagne #${campaignId} : échec temporaire global, nouvel essai dans 15 min.`);
  return true;
}

/** Programme la relance de la campagne auprès de ses destinataires servis. */
function scheduleFollowUp(parentId: number, c: CampaignRow): void {
  const follow = db
    .prepare("SELECT followup_days, followup_subject, followup_body FROM campaigns WHERE id = ?")
    .get(parentId) as { followup_days: number; followup_subject: string | null; followup_body: string | null } | undefined;
  const days = follow?.followup_days ?? 0;
  if (days <= 0 || !follow?.followup_subject || !follow?.followup_body) return;
  const rows = db
    .prepare("SELECT email, vars_json FROM recipients WHERE campaign_id = ? AND status = 'sent'")
    .all(parentId) as { email: string; vars_json: string }[];
  const supp = suppressedEmails(c.account_id);
  const kept = rows.filter((r) => !supp.has(r.email.toLowerCase()));
  if (kept.length === 0) return;
  const when = inDays(days);
  const { id } = createCampaign({
    name: `Relance de la campagne #${parentId}`,
    accountId: c.account_id,
    subject: follow.followup_subject,
    body: follow.followup_body,
    mode: c.mode,
    scheduledAt: when,
    unsubscribe: c.unsubscribe === 1,
    bodyFormat: c.body_format === "html" ? "html" : "text",
    parentId,
    recipients: kept.map((r) => ({ email: r.email, vars: safeVars(r.vars_json) })),
  });
  console.log(`Relance programmée : campagne #${id} (${kept.length} destinataire(s)) le ${when}.`);
}

/** Horodatage UTC "YYYY-MM-DD HH:MM:SS" dans N jours. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

function safeVars(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Pièces jointes enregistrées pour la campagne ([] si aucune / JSON invalide). */
function safeAttachments(json: string | null): { filename: string; path: string }[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is { filename: string; path: string } =>
        typeof a === "object" && a !== null &&
        typeof (a as { filename?: unknown }).filename === "string" &&
        typeof (a as { path?: unknown }).path === "string"
    );
  } catch {
    return [];
  }
}