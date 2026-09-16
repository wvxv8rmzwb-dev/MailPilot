import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, getSetting, setSetting, retryFailedRecipients, saveTemplate, listTemplates, deleteTemplate, defaultDailyCap, sentToday, effectiveCap, warmupCap, addSuppression, listSuppressions, removeSuppression, globalVars, setGlobalVars } from "./db.js";
import { encrypt } from "./crypto.js";
import { queueCampaign } from "./campaigns.js";
import { sendTest, sendPreview } from "./mailer.js";
import { parseCsv, parseRecipientLines, renderTemplate, textToHtml, htmlToText, findMissingVars, type RecipientVars } from "./render.js";
import { startScheduler } from "./scheduler.js";

const app = new Hono();
const dashboardPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dashboard.html"
);

// ---------- Pages ----------

app.get("/", (c) => c.html(readFileSync(dashboardPath, "utf8")));

// GSAP servi localement (pas de CDN : le dashboard doit marcher hors-ligne).
const gsapPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "node_modules", "gsap", "dist", "gsap.min.js"
);
app.get("/vendor/gsap.min.js", (c) => {
  try {
    return new Response(readFileSync(gsapPath), {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  } catch {
    return new Response("", { status: 404 });
  }
});

// Polices servies localement (idem : hors-ligne, le design reste identique).
const FONTS: Record<string, string> = {
  "inter-var.woff2": "font/woff2",
  "plexmono-400.woff2": "font/woff2",
  "plexmono-500.woff2": "font/woff2",
  "instrumentserif-400.woff2": "font/woff2",
  "instrumentserif-italic.woff2": "font/woff2",
};
app.get("/fonts/:name", (c) => {
  const name = c.req.param("name");
  const type = FONTS[name];
  if (!type) return new Response("", { status: 404 });
  try {
    return new Response(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fonts", name)), {
      headers: { "Content-Type": type, "Cache-Control": "max-age=604800" },
    });
  } catch {
    return new Response("", { status: 404 });
  }
});

// ---------- Statut ----------

app.get("/api/status", (c) => {
  const hb = getSetting("daemon_heartbeat", "");
  const age = hb ? Date.now() - new Date(hb).getTime() : Infinity;
  const due = db
    .prepare("SELECT COUNT(*) AS n FROM campaigns WHERE status = 'scheduled'")
    .get() as { n: number };
  const accounts = db
    .prepare("SELECT id, label, daily_cap FROM smtp_accounts ORDER BY id")
    .all() as { id: number; label: string; daily_cap: number }[];
  return c.json({
    daemon_active: age < 90_000,
    scheduler_interval_ms: Number(getSetting("scheduler_interval_ms", "15000")),
    pending_campaigns: due.n,
    accounts: accounts.map((a) => ({
      label: a.label,
      sent_today: sentToday(a.id),
      cap: a.daily_cap,
      remaining: a.daily_cap > 0 ? Math.max(0, a.daily_cap - sentToday(a.id)) : null,
    })),
  });
});

// ---------- Comptes SMTP ----------

app.get("/api/accounts", (c) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.label, a.host, a.port, a.secure, a.user, a.from_name, a.daily_cap, a.warmup,
              a.imap_host, a.imap_user, a.created_at,
              (SELECT COUNT(*) FROM recipients r JOIN campaigns c2 ON c2.id = r.campaign_id
               WHERE c2.account_id = a.id AND r.status = 'sent' AND r.sent_at >= date('now')) AS sent_today
       FROM smtp_accounts a ORDER BY a.id`
    )
    .all() as {
      id: number; label: string; host: string; port: number; secure: number; user: string;
      from_name: string; daily_cap: number; warmup: number; imap_host: string; imap_user: string;
      created_at: string; sent_today: number;
    }[];
  return c.json(
    rows.map((a) => {
      const eff = effectiveCap(a.id);
      return {
        ...a,
        effective_cap: eff, // null = illimité (tient compte du warm-up)
        warmup_cap: warmupCap(a.id),
      };
    })
  );
});

app.post("/api/accounts", async (c) => {
  try {
    const b = (await c.req.json()) as {
      label: string; host: string; port?: number; secure?: boolean;
      user: string; password: string; from_name?: string; daily_cap?: number;
      warmup?: boolean;
      imap_host?: string; imap_port?: number; imap_user?: string; imap_password?: string;
    };
    if (!b.label || !b.host || !b.user || !b.password) {
      return c.json({ error: "label, host, user et password sont obligatoires." }, 400);
    }
    // Cap non renseigné : 500 pour Gmail (limite côté serveur), 0 (illimité) sinon.
    const dailyCap =
      b.daily_cap === undefined || b.daily_cap === null
        ? defaultDailyCap(b.host)
        : Math.max(0, Number(b.daily_cap) || 0);
    const res = db
      .prepare(
        "INSERT INTO smtp_accounts (label, host, port, secure, user, password_enc, from_name, daily_cap, warmup, imap_host, imap_port, imap_user, imap_password_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        b.label.trim(),
        b.host.trim(),
        b.port ?? 465,
        b.secure === false ? 0 : 1,
        b.user.trim(),
        encrypt(b.password),
        b.from_name?.trim() ?? "",
        dailyCap,
        b.warmup ? 1 : 0,
        b.imap_host?.trim() ?? "",
        b.imap_port ?? 993,
        b.imap_user?.trim() || b.user.trim(),
        b.imap_password ? encrypt(b.imap_password) : ""
      );
    return c.json({ id: Number(res.lastInsertRowid) }, 201);
  } catch (err) {
    return c.json({ error: msg(err) }, 400);
  }
});

/** Met à jour la config IMAP / warm-up / cap d'un compte existant. */
app.put("/api/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!db.prepare("SELECT id FROM smtp_accounts WHERE id = ?").get(id)) {
    return c.json({ error: "Compte introuvable." }, 404);
  }
  const b = (await c.req.json()) as {
    daily_cap?: number; warmup?: boolean;
    imap_host?: string | null; imap_port?: number; imap_user?: string; imap_password?: string;
  };
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (b.daily_cap !== undefined) {
    sets.push("daily_cap = ?");
    vals.push(Math.max(0, Number(b.daily_cap) || 0));
  }
  if (b.warmup !== undefined) {
    sets.push("warmup = ?");
    vals.push(b.warmup ? 1 : 0);
  }
  if (b.imap_host !== undefined) {
    sets.push("imap_host = ?");
    vals.push(b.imap_host?.trim() ?? "");
  }
  if (b.imap_port !== undefined) {
    sets.push("imap_port = ?");
    vals.push(b.imap_port ?? 993);
  }
  if (b.imap_user !== undefined) {
    sets.push("imap_user = ?");
    vals.push(b.imap_user.trim());
  }
  if (b.imap_password) {
    sets.push("imap_password_enc = ?");
    vals.push(encrypt(b.imap_password));
  }
  if (sets.length === 0) return c.json({ error: "Rien à mettre à jour." }, 400);
  db.prepare(`UPDATE smtp_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return c.json({ ok: true });
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
      body_format?: "text" | "html";
      recipients?: string; list?: string; csv?: string;
      scheduled_at?: string | null; name?: string; unsubscribe?: boolean;
      followup_days?: number; followup_subject?: string; followup_body?: string;
      attachments?: { filename: string; base64: string }[];
    };
    if (!b.account || !b.subject || !b.body) {
      return c.json({ error: "account, subject et body sont obligatoires." }, 400);
    }
    // Pièces jointes : 10 Mo au total (encodées base64 dans le JSON).
    const attachments = (b.attachments ?? []).filter((a) => a?.filename && a?.base64);
    const totalBytes = attachments.reduce((s, a) => s + Math.floor(a.base64.length * 0.75), 0);
    if (totalBytes > 10 * 1024 * 1024) {
      return c.json({ error: "Pièces jointes trop lourdes (maximum 10 Mo au total)." }, 400);
    }
    const followup = normalizeFollowup(b.followup_days, b.followup_subject, b.followup_body);
    const out = queueCampaign({
      accountLabel: b.account,
      subject: b.subject,
      body: b.body,
      mode: b.mode ?? "personalized",
      bodyFormat: b.body_format === "html" ? "html" : "text",
      scheduledAt: b.scheduled_at || null,
      unsubscribe: b.unsubscribe,
      followup,
      attachments: attachments.length ? attachments : undefined,
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

/** Valide les paramètres de relance auto : days > 0 exige un sujet et un corps. */
function normalizeFollowup(
  days?: number, subject?: string, body?: string
): { days: number; subject: string; body: string } | null {
  const d = Math.floor(Number(days) || 0);
  if (d <= 0) return null;
  if (!subject?.trim() || !body?.trim()) {
    throw new Error("Relance auto : followup_subject et followup_body sont requis avec followup_days.");
  }
  return { days: d, subject, body };
}

// ---------- Envoi test ----------

/** Envoie le mail composé (avec variables d'exemple) à la propre adresse du compte. */
app.post("/api/send-test", async (c) => {
  try {
    const b = (await c.req.json()) as {
      account_id?: number; subject: string; body: string;
      mode?: "common" | "personalized"; body_format?: "text" | "html";
      sample_vars?: Record<string, string>;
    };
    if (!b.account_id || (!b.subject?.trim() && !b.body?.trim())) {
      return c.json({ error: "account_id et au moins un sujet ou corps sont requis." }, 400);
    }
    const account = db
      .prepare("SELECT * FROM smtp_accounts WHERE id = ?")
      .get(b.account_id) as Parameters<typeof sendPreview>[0] | undefined;
    if (!account) return c.json({ error: "Compte introuvable." }, 404);
    await sendPreview(account, b.subject ?? "", b.body ?? "", b.mode ?? "personalized", b.body_format === "html" ? "html" : "text", b.sample_vars ?? {});
    return c.json({ ok: true, message: `Mail test (rendu réel) envoyé à ${account.user}.` });
  } catch (err) {
    return c.json({ error: msg(err) }, 502);
  }
});

// ---------- Aperçu ----------

/** Rendu du mail avec des variables d'exemple, avant envoi. */
app.post("/api/preview", async (c) => {
  const b = (await c.req.json()) as {
    subject: string; body: string; mode?: "common" | "personalized";
    body_format?: "text" | "html"; sample_vars?: Record<string, string>;
  };
  const vars: RecipientVars = { prenom: "Amélie", nom: "Amélie Dufour", email: "exemple@destinataire.fr", ...globalVars(), ...(b.sample_vars ?? {}) };
  const name = vars["nom"] ?? "";
  const email = vars["email"] ?? "";
  const mode = b.mode ?? "personalized";
  const v = mode === "personalized" ? vars : {};
  const subject = renderTemplate(b.subject ?? "", v, name, email);
  const isHtml = b.body_format === "html";
  const body = renderTemplate(b.body ?? "", v, name, email);
  const missing = findMissingVars(`${b.subject ?? ""}\n${b.body ?? ""}`, [{ name, email, vars }]);
  return c.json({
    subject,
    text: isHtml ? htmlToText(body) : body,
    html: isHtml ? body : textToHtml(body),
    missing_vars: mode === "personalized" ? missing : [],
  });
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
    // CSV d'abord ; si rien de valide, tente le format lignes `email ; nom ; cle=valeur`.
    let contacts = parseCsv(b.csv);
    if (contacts.length === 0) contacts = parseRecipientLines(b.csv);
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

// ---------- Suppressions (désinscriptions) ----------

app.get("/api/suppressions", (c) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.account_id, s.email, s.reason, s.created_at, a.label AS account_label
       FROM suppressions s JOIN smtp_accounts a ON a.id = s.account_id
       ORDER BY s.created_at DESC`
    )
    .all();
  return c.json(rows);
});

app.post("/api/suppressions", async (c) => {
  const b = (await c.req.json()) as { account_id?: number; email?: string; reason?: string };
  if (!b.account_id || !b.email?.includes("@")) {
    return c.json({ error: "account_id et un email valide sont obligatoires." }, 400);
  }
  const account = db.prepare("SELECT id FROM smtp_accounts WHERE id = ?").get(b.account_id);
  if (!account) return c.json({ error: "Compte introuvable." }, 404);
  const created = addSuppression(b.account_id, b.email, b.reason ?? "");
  return c.json({ ok: true, created });
});

app.post("/api/suppressions/remove", async (c) => {
  const b = (await c.req.json()) as { account_id?: number; email?: string };
  if (!b.account_id || !b.email) {
    return c.json({ error: "account_id et email sont obligatoires." }, 400);
  }
  const removed = removeSuppression(b.account_id, b.email);
  return c.json({ ok: true, removed });
});

// ---------- Variables globales ----------

/** Variables {signature}, {lien_calendly}... utilisables dans tous les mails. */
app.get("/api/vars", (c) => c.json(globalVars()));

app.put("/api/vars", async (c) => {
  const b = (await c.req.json()) as Record<string, string>;
  const clean: Record<string, string> = {};
  if (typeof b === "object" && b !== null) {
    for (const [k, v] of Object.entries(b)) {
      if (/^[a-zA-Z0-9_]+$/.test(k) && typeof v === "string") clean[k] = v;
    }
  }
  setGlobalVars(clean);
  return c.json({ ok: true, count: Object.keys(clean).length });
});

// ---------- Historique par contact ----------

/** Tous les envois (toutes campagnes, tous comptes) reçus/échoués par un email. */
app.get("/api/contacts/history", (c) => {
  const email = String(c.req.query("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) {
    return c.json({ error: "Paramètre email requis." }, 400);
  }
  const rows = db
    .prepare(
      `SELECT r.campaign_id, c.name AS campaign_name, c.subject, c.status AS campaign_status,
              c.scheduled_at, a.label AS account_label, r.status, r.error, r.sent_at
       FROM recipients r
       JOIN campaigns c ON c.id = r.campaign_id
       JOIN smtp_accounts a ON a.id = c.account_id
       WHERE lower(r.email) = ? ORDER BY COALESCE(r.sent_at, c.scheduled_at) DESC LIMIT 100`
    )
    .all(email);
  const suppressed = db
    .prepare(
      `SELECT s.reason, s.created_at, a.label AS account_label FROM suppressions s
       JOIN smtp_accounts a ON a.id = s.account_id WHERE lower(s.email) = ?`
    )
    .all(email);
  return c.json({ email, history: rows, suppressions: suppressed });
});

// ---------- Réglages ----------

/** Clés lisibles par le dashboard (cooldown, warm-up, rapport, IMAP). */
const SETTINGS_KEYS = ["cooldown_days", "warmup_base", "warmup_step", "report_hour", "imap_poll_minutes", "send_delay_ms"] as const;

app.get("/api/settings", (c) => {
  const out: Record<string, string> = {};
  for (const k of SETTINGS_KEYS) out[k] = getSetting(k, DEFAULTS[k] ?? "");
  return c.json(out);
});

app.put("/api/settings", async (c) => {
  const b = (await c.req.json()) as Record<string, string>;
  for (const [k, v] of Object.entries(b)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(k)) continue;
    if (k === "report_hour" && !/^\d{1,2}:\d{2}$/.test(String(v))) {
      return c.json({ error: `report_hour attendu au format HH:MM, reçu "${v}".` }, 400);
    }
    if (k !== "report_hour" && (Number.isNaN(Number(v)) || Number(v) < 0)) {
      return c.json({ error: `${k} doit être un nombre positif.` }, 400);
    }
    setSetting(k, String(v));
  }
  return c.json({ ok: true });
});

const DEFAULTS: Record<string, string> = {
  cooldown_days: "7",
  warmup_base: "15",
  warmup_step: "15",
  report_hour: "20:00",
  imap_poll_minutes: "5",
  send_delay_ms: "3000",
};

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