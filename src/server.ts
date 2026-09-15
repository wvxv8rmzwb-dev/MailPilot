import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, getSetting, retryFailedRecipients, saveTemplate, listTemplates, deleteTemplate } from "./db.js";
import { encrypt } from "./crypto.js";
import { queueCampaign } from "./campaigns.js";
import { sendTest } from "./mailer.js";
import { parseCsv, renderTemplate, textToHtml, findMissingVars, type RecipientVars } from "./render.js";
import { startScheduler } from "./scheduler.js";

const app = new Hono();
const dashboardPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dashboard.html"
);

// ---------- Pages ----------

app.get("/", (c) => c.html(readFileSync(dashboardPath, "utf8")));

// ---------- Statut ----------

app.get("/api/status", (c) => {
  const hb = getSetting("daemon_heartbeat", "");
  const age = hb ? Date.now() - new Date(hb).getTime() : Infinity;
  const due = db
    .prepare("SELECT COUNT(*) AS n FROM campaigns WHERE status = 'scheduled'")
    .get() as { n: number };
  return c.json({
    daemon_active: age < 90_000,
    scheduler_interval_ms: Number(getSetting("scheduler_interval_ms", "15000")),
    pending_campaigns: due.n,
  });
});

// ---------- Comptes SMTP ----------

app.get("/api/accounts", (c) => {
  const rows = db
    .prepare("SELECT id, label, host, port, secure, user, from_name, daily_cap, created_at FROM smtp_accounts ORDER BY id")
    .all();
  return c.json(rows);
});

app.post("/api/accounts", async (c) => {
  try {
    const b = (await c.req.json()) as {
      label: string; host: string; port?: number; secure?: boolean;
      user: string; password: string; from_name?: string; daily_cap?: number;
    };
    if (!b.label || !b.host || !b.user || !b.password) {
      return c.json({ error: "label, host, user et password sont obligatoires." }, 400);
    }
    const res = db
      .prepare(
        "INSERT INTO smtp_accounts (label, host, port, secure, user, password_enc, from_name, daily_cap) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        b.label.trim(),
        b.host.trim(),
        b.port ?? 465,
        b.secure === false ? 0 : 1,
        b.user.trim(),
        encrypt(b.password),
        b.from_name?.trim() ?? "",
        Math.max(0, Number(b.daily_cap) || 0)
      );
    return c.json({ id: Number(res.lastInsertRowid) }, 201);
  } catch (err) {
    return c.json({ error: msg(err) }, 400);
  }
});

app.post("/api/accounts/:id/test", async (c) => {
  const account = db
    .prepare("SELECT * FROM smtp_accounts WHERE id = ?")
    .get(Number(c.req.param("id"))) as Parameters<typeof sendTest>[0] | undefined;
  if (!account) return c.json({ error: "Compte introuvable." }, 404);
  try {
    await sendTest(account);
    return c.json({ ok: true, message: `Mail test envoyé à ${account.user}.` });
  } catch (err) {
    return c.json({ error: msg(err) }, 502);
  }
});

// ---------- Campagnes ----------

app.get("/api/campaigns", (c) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.subject, c.mode, c.status, c.scheduled_at, c.error, c.created_at,
              a.label AS account_label,
              COUNT(r.id) AS total,
              SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM campaigns c
       JOIN smtp_accounts a ON a.id = c.account_id
       LEFT JOIN recipients r ON r.campaign_id = c.id
       GROUP BY c.id ORDER BY c.id DESC LIMIT 200`
    )
    .all();
  return c.json(rows);
});

app.get("/api/campaigns/:id", (c) => {
  const id = Number(c.req.param("id"));
  const campaign = db
    .prepare(
      `SELECT c.*, a.label AS account_label FROM campaigns c
       JOIN smtp_accounts a ON a.id = c.account_id WHERE c.id = ?`
    )
    .get(id);
  if (!campaign) return c.json({ error: "Campagne introuvable." }, 404);
  const recipients = db
    .prepare("SELECT email, status, error, sent_at FROM recipients WHERE campaign_id = ? ORDER BY id")
    .all(id);
  return c.json({ ...campaign, recipients });
});

app.post("/api/campaigns/:id/cancel", (c) => {
  const id = Number(c.req.param("id"));
  const res = db
    .prepare("UPDATE campaigns SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'")
    .run(id);
  if (res.changes === 0) {
    return c.json({ error: "Impossible d'annuler : campagne déjà envoyée, en cours ou inexistante." }, 409);
  }
  return c.json({ ok: true });
});

app.post("/api/campaigns/:id/retry-failed", (c) => {
  const id = Number(c.req.param("id"));
  const exists = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(id);
  if (!exists) return c.json({ error: "Campagne introuvable." }, 404);
  const { retried } = retryFailedRecipients(id);
  return c.json({ ok: true, retried });
});

/** Export CSV d'une campagne : email, nom, statut, erreur, date d'envoi. */
app.get("/api/campaigns/:id/export", (c) => {
  const id = Number(c.req.param("id"));
  const campaign = db.prepare("SELECT name FROM campaigns WHERE id = ?").get(id) as
    | { name: string }
    | undefined;
  if (!campaign) return c.json({ error: "Campagne introuvable." }, 404);
  const rows = db
    .prepare(
      `SELECT email, vars_json, status, error, sent_at FROM recipients WHERE campaign_id = ? ORDER BY id`
    )
    .all(id) as { email: string; vars_json: string; status: string; error: string | null; sent_at: string | null }[];
  const header = "email,nom,statut,erreur,envoye_le";
  const lines = rows.map((r) => {
    const vars = safeVars(r.vars_json);
    return [r.email, vars["nom"] ?? "", r.status, r.error ?? "", r.sent_at ?? ""].map(csvField).join(",");
  });
  const filename = `campagne-${id}-${campaign.name.replace(/[^\w-]+/g, "_").slice(0, 40) || "export"}.csv`;
  return new Response([header, ...lines].join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

app.post("/api/send", async (c) => {
  try {
    const b = (await c.req.json()) as {
      account: string; subject: string; body: string;
      mode?: "common" | "personalized";
      recipients?: string; list?: string; csv?: string;
      scheduled_at?: string | null; name?: string; unsubscribe?: boolean;
    };
    if (!b.account || !b.subject || !b.body) {
      return c.json({ error: "account, subject et body sont obligatoires." }, 400);
    }
    const out = queueCampaign({
      accountLabel: b.account,
      subject: b.subject,
      body: b.body,
      mode: b.mode ?? "personalized",
      scheduledAt: b.scheduled_at || null,
      unsubscribe: b.unsubscribe,
      recipientsText: b.recipients,
      listName: b.list,
      csvText: b.csv,
      name: b.name,
    });
    return c.json(out, 201);
  } catch (err) {
    return c.json({ error: msg(err) }, 400);
  }
});

// ---------- Aperçu ----------

/** Rendu du mail avec des variables d'exemple, avant envoi. */
app.post("/api/preview", async (c) => {
  const b = (await c.req.json()) as {
    subject: string; body: string; mode?: "common" | "personalized"; sample_vars?: Record<string, string>;
  };
  const vars: RecipientVars = { prenom: "Amélie", nom: "Amélie Dufour", email: "exemple@destinataire.fr", ...(b.sample_vars ?? {}) };
  const name = vars["nom"] ?? "";
  const email = vars["email"] ?? "";
  const mode = b.mode ?? "personalized";
  const v = mode === "personalized" ? vars : {};
  const subject = renderTemplate(b.subject ?? "", v, name, email);
  const text = renderTemplate(b.body ?? "", v, name, email);
  const missing = findMissingVars(`${b.subject ?? ""}\n${b.body ?? ""}`, [{ name, email, vars }]);
  return c.json({ subject, text, html: textToHtml(text), missing_vars: mode === "personalized" ? missing : [] });
});

// ---------- Modèles ----------

app.get("/api/templates", (c) => c.json(listTemplates()));

app.post("/api/templates", async (c) => {
  try {
    const b = (await c.req.json()) as { name: string; subject: string; body: string };
    if (!b.name || !b.subject || !b.body) {
      return c.json({ error: "name, subject et body sont obligatoires." }, 400);
    }
    const { id } = saveTemplate(b.name, b.subject, b.body);
    return c.json({ id, ok: true }, 201);
  } catch (err) {
    return c.json({ error: msg(err) }, 400);
  }
});

app.delete("/api/templates/:id", (c) => {
  return c.json({ ok: deleteTemplate(Number(c.req.param("id"))) });
});

// ---------- Contacts ----------

app.get("/api/contacts", (c) => {
  const rows = db
    .prepare("SELECT list_name, email, name, vars_json FROM contacts ORDER BY list_name, name")
    .all() as { list_name: string; email: string; name: string; vars_json: string }[];
  const lists = new Map<string, { name: string; email: string; vars: Record<string, string> }[]>();
  for (const r of rows) {
    const arr = lists.get(r.list_name) ?? [];
    arr.push({
      name: r.name,
      email: r.email,
      vars: safeVars(r.vars_json),
    });
    lists.set(r.list_name, arr);
  }
  return c.json(Object.fromEntries(lists));
});

app.post("/api/contacts/import", async (c) => {
  try {
    const b = (await c.req.json()) as { list_name: string; csv: string };
    if (!b.list_name || !b.csv) {
      return c.json({ error: "list_name et csv sont obligatoires." }, 400);
    }
    const contacts = parseCsv(b.csv);
    if (contacts.length === 0) {
      return c.json({ error: "Aucun contact valide trouvé dans le CSV." }, 400);
    }
    const upsert = db.prepare(
      `INSERT INTO contacts (list_name, email, name, vars_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(list_name, email) DO UPDATE SET name = excluded.name, vars_json = excluded.vars_json`
    );
    const tx = db.transaction(() => {
      for (const ct of contacts) upsert.run(b.list_name, ct.email, ct.name, JSON.stringify(ct.vars));
    });
    tx();
    return c.json({ ok: true, imported: contacts.length });
  } catch (err) {
    return c.json({ error: msg(err) }, 400);
  }
});

// ---------- Démarrage ----------

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Échappe un champ CSV (guillemets, virgules, retours ligne). */
function csvField(value: string): string {
  return /[",\r\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function safeVars(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const port = Number(getSetting("dashboard_port", "3777"));
startScheduler();
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`MailPilot dashboard : http://localhost:${info.port}`);
});