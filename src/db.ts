import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const dataDir = process.env.MAILPILOT_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const dbPath = path.join(dataDir, "mailpilot.db");
fs.mkdirSync(dataDir, { recursive: true }); // premier lancement sur une install fraîche

/** Dossier où sont stockées les pièces jointes des campagnes (data/attachments). */
export const attachmentsDir = path.join(dataDir, "attachments");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS smtp_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 465,
  secure INTEGER NOT NULL DEFAULT 1,
  user TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_name TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  vars_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(list_name, email)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  account_id INTEGER NOT NULL REFERENCES smtp_accounts(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'personalized' CHECK(mode IN ('common','personalized')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','scheduled','sending','done','cancelled','failed')),
  scheduled_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  vars_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  error TEXT,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipients_campaign ON recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status, scheduled_at);

CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES smtp_accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, email)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrations tolérantes (la DB peut déjà exister avec l'ancien schéma).
function addColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn("smtp_accounts", "daily_cap", "INTEGER NOT NULL DEFAULT 0");
addColumn("smtp_accounts", "warmup", "INTEGER NOT NULL DEFAULT 0");
addColumn("smtp_accounts", "imap_host", "TEXT NOT NULL DEFAULT ''");
addColumn("smtp_accounts", "imap_port", "INTEGER NOT NULL DEFAULT 993");
addColumn("smtp_accounts", "imap_user", "TEXT NOT NULL DEFAULT ''");
addColumn("smtp_accounts", "imap_password_enc", "TEXT NOT NULL DEFAULT ''");
addColumn("campaigns", "unsubscribe", "INTEGER NOT NULL DEFAULT 0");
addColumn("campaigns", "attachments_json", "TEXT");
addColumn("campaigns", "body_format", "TEXT NOT NULL DEFAULT 'text'");
addColumn("campaigns", "parent_id", "INTEGER");
addColumn("campaigns", "followup_days", "INTEGER NOT NULL DEFAULT 0");
addColumn("campaigns", "followup_subject", "TEXT");
addColumn("campaigns", "followup_body", "TEXT");
addColumn("campaigns", "auto_retries", "INTEGER NOT NULL DEFAULT 0");

/** Cap par défaut selon l'hôte : Gmail plafonne à ~500 envois/jour côté serveur. */
export function defaultDailyCap(host: string): number {
  return /gmail|googlemail/i.test(host) ? 500 : 0;
}

/** Nombre d'envois réussis par ce compte depuis le début de la journée (UTC). */
export function sentToday(accountId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM recipients r JOIN campaigns cp ON cp.id = r.campaign_id
       WHERE cp.account_id = ? AND r.status = 'sent' AND r.sent_at >= date('now')`
    )
    .get(accountId) as { n: number };
  return row.n;
}

/** Plafond du warm-up aujourd'hui (jour N depuis la création du compte) : null si warm-up inactif. */
export function warmupCap(accountId: number): number | null {
  const acc = db
    .prepare("SELECT warmup, created_at FROM smtp_accounts WHERE id = ?")
    .get(accountId) as { warmup: number; created_at: string } | undefined;
  if (!acc || acc.warmup !== 1) return null;
  const created = new Date(acc.created_at.replace(" ", "T") + "Z");
  const day = Number.isNaN(created.getTime())
    ? 1
    : Math.floor((Date.now() - created.getTime()) / 86_400_000) + 1;
  const base = Number(getSetting("warmup_base", "15"));
  const step = Number(getSetting("warmup_step", "15"));
  return Math.max(1, base + Math.max(0, day - 1) * step);
}

/**
 * Cap effectif du compte aujourd'hui : le plus strict entre daily_cap
 * (limite du fournisseur, 0 = illimité) et le plan de warm-up (si activé).
 * null = aucune limite appliquée par MailPilot.
 */
export function effectiveCap(accountId: number): number | null {
  const acc = db
    .prepare("SELECT daily_cap FROM smtp_accounts WHERE id = ?")
    .get(accountId) as { daily_cap: number } | undefined;
  const cap = acc?.daily_cap ?? 0;
  const warm = warmupCap(accountId);
  const merged = cap > 0 && warm !== null ? Math.min(cap, warm) : cap > 0 ? cap : warm;
  return merged !== null && merged > 0 ? merged : null;
}

/** Quota restant aujourd'hui (null = illimité). Respecte le warm-up s'il est activé. */
export function remainingQuota(accountId: number): number | null {
  const cap = effectiveCap(accountId);
  if (cap === null) return null;
  return Math.max(0, cap - sentToday(accountId));
}

/** Emails auxquels ce compte a envoyé un mail dans les N derniers jours (cooldown). */
export function recentlyContactedEmails(accountId: number, days: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT r.email FROM recipients r JOIN campaigns cp ON cp.id = r.campaign_id
       WHERE cp.account_id = ? AND r.status = 'sent' AND r.sent_at >= datetime('now', ?)`
    )
    .all(accountId, `-${Math.max(1, Math.floor(days))} days`) as { email: string }[];
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

// ---------- Variables globales ----------

/** Variables globales {signature}... définies une fois, valables pour tous les contacts. */
export function globalVars(): Record<string, string> {
  try {
    const raw = JSON.parse(getSetting("global_vars", "{}"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // réglage corrompu : on ignore, les {x} resteront simplement vides
  }
  return {};
}

/** Fusionne/remplace des variables globales (vide = suppression de toutes). */
export function setGlobalVars(vars: Record<string, string>): void {
  setSetting("global_vars", JSON.stringify(vars));
}

/** Crée une campagne + ses destinataires dans une transaction. Refuse > max (settings max_recipients, défaut 500). */
export function createCampaign(input: {
  name: string;
  accountId: number;
  subject: string;
  body: string;
  mode: "common" | "personalized";
  scheduledAt: string | null;
  unsubscribe?: boolean;
  bodyFormat?: "text" | "html";
  parentId?: number;
  followup?: { days: number; subject: string; body: string } | null;
  attachments?: { filename: string; base64: string }[];
  recipients: { email: string; vars: Record<string, string> }[];
}): { id: number } {
  const max = Number(getSetting("max_recipients", "500"));
  if (input.recipients.length === 0) throw new Error("Aucun destinataire.");
  if (input.recipients.length > max) {
    throw new Error(
      `${input.recipients.length} destinataires : le maximum par campagne est ${max}. ` +
      `Crée une seconde campagne pour les suivants.`
    );
  }
  const insertCampaign = db.prepare(`
    INSERT INTO campaigns (name, account_id, subject, body, mode, status, scheduled_at, unsubscribe,
                           body_format, parent_id, followup_days, followup_subject, followup_body)
    VALUES (@name, @accountId, @subject, @body, @mode, @status, @scheduledAt, @unsubscribe,
            @bodyFormat, @parentId, @followupDays, @followupSubject, @followupBody)
  `);
  const insertRecipient = db.prepare(`
    INSERT INTO recipients (campaign_id, email, vars_json) VALUES (?, ?, ?)
  `);
  const status = input.scheduledAt ? "scheduled" : "sending";
  const tx = db.transaction(() => {
    const res = insertCampaign.run({
      name: input.name,
      accountId: input.accountId,
      subject: input.subject,
      body: input.body,
      mode: input.mode,
      status,
      scheduledAt: input.scheduledAt,
      unsubscribe: input.unsubscribe ? 1 : 0,
      bodyFormat: input.bodyFormat ?? "text",
      parentId: input.parentId ?? null,
      followupDays: input.followup?.days ?? 0,
      followupSubject: input.followup?.subject ?? null,
      followupBody: input.followup?.body ?? null,
    });
    const id = Number(res.lastInsertRowid);
    for (const r of input.recipients) {
      insertRecipient.run(id, r.email, JSON.stringify(r.vars));
    }
    if (input.attachments && input.attachments.length > 0) {
      writeAttachments(id, input.attachments);
    }
    return id;
  });
  return { id: tx() };
}

/**
 * Écrit les pièces jointes d'une campagne sur disque (data/attachments/<id>/)
 * et enregistre la liste dans campaigns.attachments_json. Lève si un base64
 * est invalide ou le nom de fichier dangereux.
 */
function writeAttachments(
  campaignId: number,
  files: { filename: string; base64: string }[]
): void {
  const safeName = (name: string): string => {
    const base = name.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "_").trim();
    if (!base || base === "." || base === "..") throw new Error(`Nom de pièce jointe invalide : "${name}"`);
    return base.slice(0, 120);
  };
  const dir = path.join(attachmentsDir, String(campaignId));
  const list: { filename: string; path: string; size: number }[] = [];
  for (const f of files) {
    const filename = safeName(f.filename);
    const buf = Buffer.from(f.base64, "base64");
    if (buf.length === 0) throw new Error(`Pièce jointe vide : "${f.filename}"`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buf);
    list.push({ filename, path: path.join(dir, filename), size: buf.length });
  }
  db.prepare("UPDATE campaigns SET attachments_json = ? WHERE id = ?").run(
    JSON.stringify(list),
    campaignId
  );
}

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

/** Horodatage UTC au format SQLite "YYYY-MM-DD HH:MM:SS" (comparables à datetime('now')). */
export function sqliteNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Remet les destinataires en échec d'une campagne en file d'attente.
 * Si la campagne était terminée/échouée, elle repart immédiatement.
 */
export function retryFailedRecipients(campaignId: number): { retried: number } {
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        "UPDATE recipients SET status = 'pending', error = NULL, sent_at = NULL WHERE campaign_id = ? AND status = 'failed'"
      )
      .run(campaignId);
    if (res.changes > 0) {
      db.prepare(
        "UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, error = NULL WHERE id = ? AND status IN ('done','failed')"
      ).run(sqliteNow(), campaignId);
    }
    return res.changes;
  });
  return { retried: tx() };
}

// ---------- Modèles ----------

export type TemplateRow = {
  id: number;
  name: string;
  subject: string;
  body: string;
  created_at: string;
};

export function saveTemplate(name: string, subject: string, body: string): { id: number } {
  const res = db
    .prepare(
      `INSERT INTO templates (name, subject, body) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET subject = excluded.subject, body = excluded.body`
    )
    .run(name.trim(), subject, body);
  const row = db.prepare("SELECT id FROM templates WHERE name = ?").get(name.trim()) as
    | { id: number }
    | undefined;
  return { id: row?.id ?? Number(res.lastInsertRowid) };
}

export function listTemplates(): TemplateRow[] {
  return db.prepare("SELECT id, name, subject, body, created_at FROM templates ORDER BY name").all() as TemplateRow[];
}

export function deleteTemplate(id: number): boolean {
  return db.prepare("DELETE FROM templates WHERE id = ?").run(id).changes > 0;
}

// ---------- Suppressions (désinscriptions) ----------

export type SuppressionRow = {
  id: number;
  account_id: number;
  email: string;
  reason: string;
  created_at: string;
};

/** Ajoute un email à la liste de suppression d'un compte. False si déjà présent. */
export function addSuppression(accountId: number, email: string, reason = ""): boolean {
  return (
    db
      .prepare(
        `INSERT INTO suppressions (account_id, email, reason) VALUES (?, ?, ?)
         ON CONFLICT(account_id, email) DO NOTHING`
      )
      .run(accountId, email.trim().toLowerCase(), reason.trim()).changes > 0
  );
}

export function listSuppressions(accountId?: number): SuppressionRow[] {
  return (
    accountId !== undefined
      ? db
          .prepare("SELECT id, account_id, email, reason, created_at FROM suppressions WHERE account_id = ? ORDER BY created_at DESC")
          .all(accountId)
      : db.prepare("SELECT id, account_id, email, reason, created_at FROM suppressions ORDER BY created_at DESC").all()
  ) as SuppressionRow[];
}

export function removeSuppression(accountId: number, email: string): boolean {
  return (
    db
      .prepare("DELETE FROM suppressions WHERE account_id = ? AND email = ?")
      .run(accountId, email.trim().toLowerCase()).changes > 0
  );
}

/** Emails désinscrits d'un compte (minuscules). */
export function suppressedEmails(accountId: number): Set<string> {
  const rows = db
    .prepare("SELECT email FROM suppressions WHERE account_id = ?")
    .all(accountId) as { email: string }[];
  return new Set(rows.map((r) => r.email.toLowerCase()));
}