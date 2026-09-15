import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { db, getSetting, retryFailedRecipients, saveTemplate, listTemplates, deleteTemplate } from "./db.js";
import { encrypt } from "./crypto.js";
import { queueCampaign } from "./campaigns.js";
import { sendTest } from "./mailer.js";
import { parseCsv, renderTemplate, findMissingVars } from "./render.js";

/**
 * Serveur MCP MailPilot (stdio). Il n'envoie rien lui-même :
 * il écrit dans la SQLite partagée, le daemon (npm start) envoie.
 * Démarrage : claude mcp add mailpilot -- npm --prefix <chemin-vers-MailPilot> run mcp
 */

const server = new McpServer({ name: "mailpilot", version: "1.0.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function fail(err: unknown) {
  return { content: [{ type: "text" as const, text: `Erreur : ${err instanceof Error ? err.message : String(err)}` }], isError: true };
}

/** True si le daemon a battu son coeur il y a moins de 90 s. */
function daemonActive(): boolean {
  const hb = getSetting("daemon_heartbeat", "");
  return hb !== "" && Date.now() - new Date(hb).getTime() < 90_000;
}

const daemonHint = () =>
  daemonActive()
    ? ""
    : "\n\n⚠️ Le daemon ne tourne pas : lance `npm start` dans le dossier MailPilot, sinon rien ne partira.";

// ---------- Comptes ----------

server.registerTool(
  "list_accounts",
  {
    title: "Comptes SMTP",
    description: "Liste les comptes SMTP (envoyeurs) configurés, sans jamais exposer les mots de passe.",
    inputSchema: {},
  },
  async () => {
    const rows = db
      .prepare("SELECT label, user, host, port FROM smtp_accounts ORDER BY id")
      .all() as { label: string; user: string; host: string; port: number }[];
    if (rows.length === 0) {
      return text("Aucun compte SMTP configuré. Utilise add_account d'abord.");
    }
    return text(rows.map((r) => `- ${r.label} (${r.user} via ${r.host}:${r.port})`).join("\n") + daemonHint());
  }
);

server.registerTool(
  "add_account",
  {
    title: "Ajouter un compte SMTP",
    description:
      "Configure un compte envoyeur. Le mot de passe est chiffré localement (AES-256-GCM) et ne quitte jamais la machine. Pour Gmail : activer la 2FA puis créer un mot de passe d'application.",
    inputSchema: {
      label: z.string().describe("Nom court du compte, ex: Pro Gmail"),
      host: z.string().describe("Serveur SMTP, ex: smtp.gmail.com"),
      port: z.number().int().default(465).describe("Port (465 = SSL, 587 = STARTTLS)"),
      user: z.string().describe("Adresse de l'envoyeur"),
      password: z.string().describe("Mot de passe ou mot de passe d'application"),
      from_name: z.string().default("").describe("Nom affiché, ex: Mala"),
    },
  },
  async (b) => {
    try {
      const res = db
        .prepare(
          "INSERT INTO smtp_accounts (label, host, port, secure, user, password_enc, from_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(b.label.trim(), b.host.trim(), b.port, b.port === 587 ? 0 : 1, b.user.trim(), encrypt(b.password), b.from_name.trim());
      return text(`Compte "${b.label}" ajouté (id ${Number(res.lastInsertRowid)}).`);
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "test_account",
  {
    title: "Tester un compte SMTP",
    description: "Envoie un mail de test du compte vers sa propre adresse. Utilisé après add_account pour vérifier la connexion.",
    inputSchema: { label: z.string().describe("Libellé du compte à tester") },
  },
  async (b) => {
    const account = db
      .prepare("SELECT * FROM smtp_accounts WHERE label = ?")
      .get(b.label) as Parameters<typeof sendTest>[0] | undefined;
    if (!account) return fail(new Error(`Compte "${b.label}" introuvable.`));
    try {
      await sendTest(account);
      return text(`Mail test envoyé à ${account.user}. Vérifie la boîte de réception.`);
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------- Envois ----------

const recipientsShape = {
  recipients: z
    .string()
    .optional()
    .describe("Destinataires, une ligne par contact : `email ; nom ; cle=valeur ; cle=valeur` (max 100)"),
  list: z.string().optional().describe("Nom d'une liste de contacts existante (voir list_contacts)"),
  csv: z.string().optional().describe("Contacts en CSV brut (1re ligne d'en-tête optionnelle : email,nom,prenom,...)"),
};

const bodyShape = {
  account: z.string().describe("Libellé du compte envoyeur (voir list_accounts)"),
  subject: z.string().describe("Sujet du mail. Variables {prenom}, {nom}, {entreprise}... autorisées"),
  body: z.string().describe("Corps du mail en texte. Variables {prenom}, {nom}... remplacées par contact"),
  mode: z.enum(["personalized", "common"]).default("personalized")
    .describe("personalized : variables remplacées par contact. common : même texte pour tous"),
  unsubscribe: z.boolean().default(true)
    .describe("Ajoute la mention de désinscription + header List-Unsubscribe (recommandé, obligatoire en cold email FR)"),
};

function resolveRecipients(b: {
  account: string;
  subject: string;
  body: string;
  mode: "common" | "personalized";
  unsubscribe?: boolean;
  scheduled_at?: string;
  recipients?: string;
  list?: string;
  csv?: string;
}) {
  return queueCampaign({
    accountLabel: b.account,
    subject: b.subject,
    body: b.body,
    mode: b.mode,
    unsubscribe: b.unsubscribe,
    scheduledAt: b.scheduled_at ?? null,
    recipientsText: b.recipients,
    listName: b.list,
    csvText: b.csv,
  });
}

/** Formate le résultat de création de campagne avec les warnings utiles. */
function campaignReport(prefix: string, out: ReturnType<typeof resolveRecipients>): string {
  return (
    `${prefix} Campagne #${out.id} : ${out.count} destinataire(s).` +
    (out.warnings.length ? `\n⚠️ ${out.warnings.join("\n⚠️ ")}` : "")
  );
}

server.registerTool(
  "send_now",
  {
    title: "Envoyer maintenant",
    description:
      "Crée une campagne d'envoi immédiat (maximum 100 destinataires). Chaque contact reçoit son propre mail, jamais de liste visible. Le daemon effectue l'envoi avec un délai anti-spam entre chaque mail.",
    inputSchema: { ...bodyShape, ...recipientsShape },
  },
  async (b) => {
    try {
      const out = resolveRecipients(b);
      return text(
        campaignReport(`Envoi immédiat depuis "${b.account}".`, out) + daemonHint()
      );
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "schedule_campaign",
  {
    title: "Programmer un envoi",
    description:
      "Crée une campagne planifiée (maximum 100 destinataires). Le daemon enverra à la date donnée, même si la session Claude Code est fermée.",
    inputSchema: {
      ...bodyShape,
      ...recipientsShape,
      scheduled_at: z
        .string()
        .describe("Date et heure d'envoi ISO, ex: 2026-09-16T09:00:00 (heure locale acceptée)"),
    },
  },
  async (b) => {
    try {
      const out = resolveRecipients(b);
      return text(
        campaignReport(`Programmée le ${b.scheduled_at} depuis "${b.account}".`, out) + daemonHint()
      );
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "preview_campaign",
  {
    title: "Aperçu d'un mail",
    description: "Montre le rendu du sujet et du corps avec des variables d'exemple, avant tout envoi. Signale aussi les variables {x} absentes des contacts.",
    inputSchema: {
      subject: z.string().describe("Sujet avec ses variables {x}"),
      body: z.string().describe("Corps avec ses variables {x}"),
      sample_vars: z.record(z.string()).optional().describe("Valeurs d'exemple, ex: {prenom: 'Amélie', entreprise: 'ACME'}. prenom/nom/email ont des défauts"),
    },
  },
  async (b) => {
    const vars = { prenom: "Amélie", nom: "Amélie Dufour", email: "exemple@destinataire.fr", ...(b.sample_vars ?? {}) };
    const subject = renderTemplate(b.subject, vars, vars["nom"] ?? "", vars["email"] ?? "");
    const body = renderTemplate(b.body, vars, vars["nom"] ?? "", vars["email"] ?? "");
    const missing = findMissingVars(`${b.subject}\n${b.body}`, [{ name: vars["nom"] ?? "", email: vars["email"] ?? "", vars }]);
    return text(
      `Aperçu (destinataire d'exemple) :\n\n--- SUJET ---\n${subject}\n\n--- CORPS ---\n${body}` +
      (missing.length ? `\n\n⚠️ Variables sans valeur dans l'exemple : ${missing.map((m) => `{${m}}`).join(", ")}` : "")
    );
  }
);

// ---------- Suivi ----------

server.registerTool(
  "list_campaigns",
  {
    title: "Lister les campagnes",
    description: "Liste les campagnes récentes avec leur statut et leur progression.",
    inputSchema: {
      status: z.enum(["draft", "scheduled", "sending", "done", "cancelled", "failed"]).optional()
        .describe("Filtrer par statut (optionnel)"),
    },
  },
  async (b) => {
    let query = `SELECT c.id, c.name, c.status, c.scheduled_at,
        COUNT(r.id) AS total,
        SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM campaigns c LEFT JOIN recipients r ON r.campaign_id = c.id`;
    const params: string[] = [];
    if (b.status) {
      query += " WHERE c.status = ?";
      params.push(b.status);
    }
    query += " GROUP BY c.id ORDER BY c.id DESC LIMIT 30";
    const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
    if (rows.length === 0) return text("Aucune campagne" + (b.status ? ` en statut ${b.status}` : "") + ".");
    return text(
      rows
        .map((r) => {
          const sched = r.scheduled_at ? ` · prévu ${r.scheduled_at}` : "";
          return `#${r.id} ${r.name} — ${r.status} — ${r.sent ?? 0}/${r.total} envoyé(s), ${r.failed ?? 0} échec(s)${sched}`;
        })
        .join("\n") + daemonHint()
    );
  }
);

server.registerTool(
  "campaign_status",
  {
    title: "Détail d'une campagne",
    description: "Détail d'une campagne : destinataires, statuts et erreurs d'envoi.",
    inputSchema: { id: z.number().int().describe("Numéro de la campagne (voir list_campaigns)") },
  },
  async (b) => {
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(b.id) as
      | { id: number; name: string; status: string; error: string | null; subject: string }
      | undefined;
    if (!campaign) return fail(new Error(`Campagne #${b.id} introuvable.`));
    const rows = db
      .prepare("SELECT email, status, error FROM recipients WHERE campaign_id = ? ORDER BY id")
      .all(b.id) as { email: string; status: string; error: string | null }[];
    const lines = rows.map((r) => `- ${r.email} : ${r.status}${r.error ? ` (${r.error})` : ""}`);
    return text(
      `Campagne #${campaign.id} "${campaign.name}" — ${campaign.status}` +
      (campaign.error ? `\nErreur campagne : ${campaign.error}` : "") +
      `\nSujet : ${campaign.subject}\n\n${lines.join("\n") || "Aucun destinataire."}`
    );
  }
);

server.registerTool(
  "cancel_campaign",
  {
    title: "Annuler une campagne",
    description: "Annule une campagne planifiée tant qu'elle n'a pas commencé à être envoyée.",
    inputSchema: { id: z.number().int().describe("Numéro de la campagne à annuler") },
  },
  async (b) => {
    const res = db
      .prepare("UPDATE campaigns SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'")
      .run(b.id);
    if (res.changes === 0) {
      return fail(new Error("Impossible d'annuler : campagne déjà envoyée, en cours ou inexistante."));
    }
    return text(`Campagne #${b.id} annulée.`);
  }
);

server.registerTool(
  "retry_failed_campaign",
  {
    title: "Relancer les échecs",
    description: "Remet en file d'attente les destinataires d'une campagne dont l'envoi a échoué (boîte pleine, erreur réseau...). La campagne repart immédiatement si le daemon tourne.",
    inputSchema: { id: z.number().int().describe("Numéro de la campagne dont on relance les échecs") },
  },
  async (b) => {
    const exists = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(b.id);
    if (!exists) return fail(new Error(`Campagne #${b.id} introuvable.`));
    const { retried } = retryFailedRecipients(b.id);
    if (retried === 0) return text(`Aucun envoi en échec à relancer pour la campagne #${b.id}.`);
    return text(`${retried} envoi(s) remis en file pour la campagne #${b.id}.` + daemonHint());
  }
);

// ---------- Modèles ----------

server.registerTool(
  "save_template",
  {
    title: "Sauver un modèle",
    description: "Sauvegarde un sujet + corps de mail réutilisable (créé ou mis à jour si le nom existe).",
    inputSchema: {
      name: z.string().describe("Nom du modèle, ex: Relance Qualiopi"),
      subject: z.string().describe("Sujet du modèle (variables {x} autorisées)"),
      body: z.string().describe("Corps du modèle (variables {x} autorisées)"),
    },
  },
  async (b) => {
    const { id } = saveTemplate(b.name, b.subject, b.body);
    return text(`Modèle "${b.name}" sauvegardé (id ${id}). Utilise-le avec list_templates / en le recopiant dans un envoi.`);
  }
);

server.registerTool(
  "list_templates",
  {
    title: "Lister les modèles",
    description: "Liste les modèles de mails sauvegardés (sujet + corps) prêts à être réutilisés.",
    inputSchema: {},
  },
  async () => {
    const rows = listTemplates();
    if (rows.length === 0) return text("Aucun modèle sauvegardé. Utilise save_template.");
    return text(rows.map((t) => `#${t.id} ${t.name}\n  Sujet : ${t.subject}\n  Corps : ${t.body.slice(0, 120)}${t.body.length > 120 ? "…" : ""}`).join("\n\n"));
  }
);

server.registerTool(
  "delete_template",
  {
    title: "Supprimer un modèle",
    description: "Supprime un modèle de mail sauvegardé.",
    inputSchema: { id: z.number().int().describe("Numéro du modèle (voir list_templates)") },
  },
  async (b) => {
    return text(deleteTemplate(b.id) ? `Modèle #${b.id} supprimé.` : `Modèle #${b.id} introuvable.`);
  }
);

// ---------- Contacts ----------

server.registerTool(
  "import_contacts",
  {
    title: "Importer des contacts",
    description:
      "Importe des contacts dans une liste (créée ou mise à jour). CSV brut ou lignes `email ; nom ; cle=valeur`.",
    inputSchema: {
      list: z.string().describe("Nom de la liste, ex: Prospection OF"),
      csv: z.string().describe("Contenu CSV. 1re ligne d'en-tête optionnelle : email,nom,prenom,entreprise"),
    },
  },
  async (b) => {
    try {
      const contacts = parseCsv(b.csv);
      if (contacts.length === 0) return fail(new Error("Aucun contact valide dans le CSV."));
      const upsert = db.prepare(
        `INSERT INTO contacts (list_name, email, name, vars_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(list_name, email) DO UPDATE SET name = excluded.name, vars_json = excluded.vars_json`
      );
      const tx = db.transaction(() => {
        for (const c of contacts) upsert.run(b.list, c.email, c.name, JSON.stringify(c.vars));
      });
      tx();
      return text(`${contacts.length} contact(s) importé(s) dans la liste "${b.list}".`);
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "list_contacts",
  {
    title: "Lister les contacts",
    description: "Liste les listes de contacts et leurs membres.",
    inputSchema: { list: z.string().optional().describe("Filtrer sur une liste précise (optionnel)") },
  },
  async (b) => {
    const rows = (b.list
      ? db.prepare("SELECT list_name, email, name FROM contacts WHERE list_name = ? ORDER BY name").all(b.list)
      : db.prepare("SELECT list_name, email, name FROM contacts ORDER BY list_name, name").all()
    ) as { list_name: string; email: string; name: string }[];
    if (rows.length === 0) return text("Aucun contact. Utilise import_contacts.");
    const byList = new Map<string, string[]>();
    for (const r of rows) {
      const arr = byList.get(r.list_name) ?? [];
      arr.push(r.name ? `${r.name} <${r.email}>` : r.email);
      byList.set(r.list_name, arr);
    }
    return text(
      [...byList.entries()]
        .map(([list, mails]) => `${list} (${mails.length}) :\n  ${mails.join("\n  ")}`)
        .join("\n\n")
    );
  }
);

// ---------- Démarrage ----------

const dashboardUrl = `http://localhost:${getSetting("dashboard_port", "3777")}`;
console.error(`MailPilot MCP démarré. Dashboard : ${dashboardUrl}`);

await server.connect(new StdioServerTransport());