import { db, getSetting, setSetting } from "./db.js";
import { sendToRecipients, type SmtpAccount } from "./mailer.js";

type CampaignRow = {
  id: number;
  account_id: number;
  subject: string;
  body: string;
  mode: "common" | "personalized";
  unsubscribe: number;
};

type RecipientRow = {
  id: number;
  email: string;
  vars_json: string;
};

let running = false;

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
    // Fenêtre d'envoi (heure locale) : hors fenêtre, on attend la prochaine ouverture.
    if (!inSendWindow()) return;
    const due = db
      .prepare(
        "SELECT id, account_id, subject, body, mode, unsubscribe FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= datetime('now')"
      )
      .all() as CampaignRow[];
    for (const c of due) {
      postponeIfDailyCapped(c);
      await sendCampaign(c);
    }
  } finally {
    running = false;
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
 * Cap quotidien du compte : si déjà atteint, la campagne attend demain même
 * heure (le compte SMTP risque un blocage au-delà de sa limite).
 */
function postponeIfDailyCapped(c: CampaignRow): void {
  const cap = db
    .prepare("SELECT daily_cap FROM smtp_accounts WHERE id = ?")
    .get(c.account_id) as { daily_cap: number } | undefined;
  const max = cap?.daily_cap ?? 0;
  if (max <= 0) return;
  const sent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM recipients r JOIN campaigns cp ON cp.id = r.campaign_id
       WHERE cp.account_id = ? AND r.status = 'sent' AND r.sent_at >= date('now')`
    )
    .get(c.account_id) as { n: number };
  if (sent.n >= max) {
    db.prepare("UPDATE campaigns SET scheduled_at = datetime(scheduled_at, '+1 day') WHERE id = ? AND status = 'scheduled'").run(c.id);
    console.log(`Campagne #${c.id} : cap quotidien de ${max} atteint, repoussée à demain.`);
  }
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
    { unsubscribe: c.unsubscribe === 1 }
  );

  const counts = db
    .prepare(
      "SELECT SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM recipients WHERE campaign_id = ?"
    )
    .get(c.id) as { sent: number | null; failed: number | null };
  const failed = counts.failed ?? 0;
  const status = counts.sent ? (failed ? "done" : "done") : "failed";
  db.prepare("UPDATE campaigns SET status = ?, error = ? WHERE id = ?").run(
    status,
    failed ? `${failed} envoi(s) en échec` : null,
    c.id
  );
}

function safeVars(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}