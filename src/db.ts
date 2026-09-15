import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const dbPath = path.join(dataDir, "mailpilot.db");
fs.mkdirSync(dataDir, { recursive: true }); // premier lancement sur une install fraîche

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
addColumn("campaigns", "unsubscribe", "INTEGER NOT NULL DEFAULT 0");

/** Crée une campagne + ses destinataires dans une transaction. Refuse > 100. */
export function createCampaign(input: {
  name: string;
  accountId: number;
  subject: string;
  body: string;
  mode: "common" | "personalized";
  scheduledAt: string | null;
  unsubscribe?: boolean;
  recipients: { email: string; vars: Record<string, string> }[];
}): { id: number } {
  const max = Number(getSetting("max_recipients", "100"));
  if (input.recipients.length === 0) throw new Error("Aucun destinataire.");
  if (input.recipients.length > max) {
    throw new Error(
      `${input.recipients.length} destinataires : le maximum par campagne est ${max}. ` +
      `Crée une seconde campagne pour les suivants.`
    );
  }
  const insertCampaign = db.prepare(`
    INSERT INTO campaigns (name, account_id, subject, body, mode, status, scheduled_at, unsubscribe)
    VALUES (@name, @accountId, @subject, @body, @mode, @status, @scheduledAt, @unsubscribe)
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
    });
    const id = Number(res.lastInsertRowid);
    for (const r of input.recipients) {
      insertRecipient.run(id, r.email, JSON.stringify(r.vars));
    }
    return id;
  });
  return { id: tx() };
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