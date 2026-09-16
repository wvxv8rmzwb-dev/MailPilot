/**
 * Tests des nouvelles fonctions DB (warm-up, cooldown, variables globales,
 * pièces jointes) sur une base de test isolée — jamais la vraie data/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// db.ts lit data/ depuis son propre chemin ; pour les tests on le redirige
// vers un dossier temporaire AVANT l'import (db est un singleton module).
process.env.MAILPILOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mailpilot-test-"));

const {
  db,
  setGlobalVars,
  globalVars,
  warmupCap,
  effectiveCap,
  recentlyContactedEmails,
  createCampaign,
  defaultDailyCap,
  setSetting,
  sentToday,
} = await import("./db.js");

const accountId = Number(
  db.prepare("INSERT INTO smtp_accounts (label, host, user, password_enc) VALUES ('T', 'smtp.test.fr', 't@t.fr', 'x')").run().lastInsertRowid
);

// ---------- Variables globales ----------

test("setGlobalVars/globalVars : aller-retour + clés non-string ignorées", () => {
  setGlobalVars({ signature: "Amélie\nOF Lyon", lien_calendly: "https://cal.com/x" });
  const vars = globalVars();
  assert.equal(vars["signature"], "Amélie\nOF Lyon");
  assert.equal(vars["lien_calendly"], "https://cal.com/x");
  setGlobalVars({ ok: "oui", bad: 42 as unknown as string });
  const after = globalVars();
  assert.equal(after["ok"], "oui");
  assert.equal(after["bad"], undefined);
  assert.equal(after["signature"], undefined); // remplace tout
});

test("globalVars : settings corrompus → objet vide, pas de crash", async () => {
  db.prepare("UPDATE settings SET value = '{pas du json' WHERE key = 'global_vars'").run();
  assert.deepEqual(globalVars(), {});
  setGlobalVars({ signature: "retour" });
  assert.equal(globalVars()["signature"], "retour");
});

// ---------- Warm-up ----------

test("warmupCap : null sans warm-up, plafond progressif avec", async () => {
  assert.equal(warmupCap(accountId), null); // warmup = 0
  db.prepare("UPDATE smtp_accounts SET warmup = 1, created_at = ? WHERE id = ?").run(
    new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 19).replace("T", " "),
    accountId
  );
  setSetting("warmup_base", "15");
  setSetting("warmup_step", "15");
  // créé il y a 3 jours → jour 4 : 15 + 3×15 = 60
  assert.equal(warmupCap(accountId), 60);
  setSetting("warmup_step", "0"); // base + 3×0 = 15
  assert.equal(warmupCap(accountId), 15);
});

test("effectiveCap : le plus strict entre daily_cap et warm-up", async () => {
  setSetting("warmup_step", "15"); // jour 4 → 60
  db.prepare("UPDATE smtp_accounts SET daily_cap = 500 WHERE id = ?").run(accountId);
  assert.equal(effectiveCap(accountId), 60); // warm-up plus strict
  db.prepare("UPDATE smtp_accounts SET daily_cap = 30 WHERE id = ?").run(accountId);
  assert.equal(effectiveCap(accountId), 30); // daily_cap plus strict
  db.prepare("UPDATE smtp_accounts SET warmup = 0, daily_cap = 500 WHERE id = ?").run(accountId);
  assert.equal(effectiveCap(accountId), 500);
  db.prepare("UPDATE smtp_accounts SET daily_cap = 0 WHERE id = ?").run(accountId);
  assert.equal(effectiveCap(accountId), null); // illimité sans warm-up
});

// ---------- Cooldown ----------

test("recentlyContactedEmails : emails servis dans la fenêtre N jours", async () => {
  const other = Number(
    db.prepare("INSERT INTO smtp_accounts (label, host, user, password_enc) VALUES ('T2', 'smtp2.test.fr', 't2@t.fr', 'x')").run().lastInsertRowid
  );
  // Campagne "il y a 3 jours" sur le compte 1
  const c1 = createCampaign({
    name: "c1", accountId, subject: "s", body: "b", mode: "personalized",
    scheduledAt: "2026-09-16 08:00:00",
    recipients: [{ email: "recent@test.fr", vars: {} }],
  });
  db.prepare(
    "UPDATE campaigns SET scheduled_at = datetime('now', '-3 days') WHERE id = ?"
  ).run(c1.id);
  db.prepare(
    "UPDATE recipients SET status = 'sent', sent_at = datetime('now', '-3 days') WHERE campaign_id = ?"
  ).run(c1.id);
  // Campagne il y a 30 jours sur le même compte
  const c2 = createCampaign({
    name: "c2", accountId, subject: "s", body: "b", mode: "personalized",
    scheduledAt: "2026-09-16 08:00:00",
    recipients: [{ email: "ancien@test.fr", vars: {} }],
  });
  db.prepare("UPDATE recipients SET status = 'sent', sent_at = datetime('now', '-30 days') WHERE campaign_id = ?").run(c2.id);
  // Envoyé par l'AUTRE compte il y a 3 jours (ne doit pas compter pour le compte 1)
  const c3 = createCampaign({
    name: "c3", accountId: other, subject: "s", body: "b", mode: "personalized",
    scheduledAt: "2026-09-16 08:00:00",
    recipients: [{ email: "autrecompte@test.fr", vars: {} }],
  });
  db.prepare("UPDATE recipients SET status = 'sent', sent_at = datetime('now', '-1 days') WHERE campaign_id = ?").run(c3.id);

  const recent = recentlyContactedEmails(accountId, 7);
  assert.equal(recent.has("recent@test.fr"), true);
  assert.equal(recent.has("ancien@test.fr"), false);
  assert.equal(recent.has("autrecompte@test.fr"), false);
});

// ---------- Pièces jointes ----------

test("createCampaign : pièces jointes écrites sur disque + référencées", async () => {
  const { attachmentsDir } = await import("./db.js");
  const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
  const camp = createCampaign({
    name: "pj", accountId, subject: "s", body: "b", mode: "common",
    scheduledAt: null,
    attachments: [{ filename: "offre.pdf", base64: pdf }],
    recipients: [{ email: "x@test.fr", vars: {} }],
  });
  const row = db.prepare("SELECT attachments_json FROM campaigns WHERE id = ?").get(camp.id) as { attachments_json: string | null };
  const list = JSON.parse(row.attachments_json ?? "[]") as { filename: string; path: string }[];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.filename, "offre.pdf");
  assert.equal(fs.readFileSync(list[0]?.path ?? "").toString(), Buffer.from(pdf, "base64").toString());
  assert.equal(path.dirname(list[0]?.path ?? ""), path.join(attachmentsDir, String(camp.id)));
});

test("createCampaign : nom de pièce jointe dangereux neutralisé ou refusé", async () => {
  const { attachmentsDir } = await import("./db.js");
  // Séparateurs supprimés : le nom ne peut pas sortir du dossier de la campagne.
  try {
    const camp = createCampaign({
      name: "bad", accountId, subject: "s", body: "b", mode: "common", scheduledAt: null,
      attachments: [{ filename: "..\\..\\evil.exe", base64: Buffer.from("x").toString("base64") }],
      recipients: [{ email: "y@test.fr", vars: {} }],
    });
    const row = db.prepare("SELECT attachments_json FROM campaigns WHERE id = ?").get(camp.id) as { attachments_json: string | null };
    const list = JSON.parse(row.attachments_json ?? "[]") as { filename: string; path: string }[];
    const p = path.resolve(list[0]?.path ?? "");
    assert.equal(p.startsWith(path.resolve(attachmentsDir)), true, "la PJ reste dans data/attachments");
    assert.equal(list[0]?.filename.includes("\\"), false);
  } catch (err) {
    // accepté aussi : refuse si l'implémentation choisit de lever
    assert.match(String(err), /invalide/);
  }
  // Un nom uniquement fait de points est neutralisé (jamais de traversée)
  const dots = createCampaign({
    name: "dots", accountId, subject: "s", body: "b", mode: "common", scheduledAt: null,
    attachments: [{ filename: "..", base64: Buffer.from("x").toString("base64") }],
    recipients: [{ email: "z@test.fr", vars: {} }],
  });
  const rowDots = db.prepare("SELECT attachments_json FROM campaigns WHERE id = ?").get(dots.id) as { attachments_json: string | null };
  const listDots = JSON.parse(rowDots.attachments_json ?? "[]") as { filename: string; path: string }[];
  assert.equal(
    path.resolve(listDots[0]?.path ?? "").startsWith(path.resolve(attachmentsDir)),
    true,
    "la PJ reste dans data/attachments"
  );
});

// ---------- Divers ----------

test("defaultDailyCap : Gmail 500, autres 0", () => {
  assert.equal(defaultDailyCap("smtp.gmail.com"), 500);
  assert.equal(defaultDailyCap("imap.googlemail.com"), 500);
  assert.equal(defaultDailyCap("ssl0.ovh.net"), 0);
});

test("sentToday compte les envois du jour (UTC)", () => {
  const n = sentToday(accountId);
  const camp = createCampaign({
    name: "auj", accountId, subject: "s", body: "b", mode: "common", scheduledAt: null,
    recipients: [{ email: "today@test.fr", vars: {} }, { email: "today2@test.fr", vars: {} }],
  });
  db.prepare(
    "UPDATE recipients SET status = 'sent', sent_at = datetime('now') WHERE campaign_id = ?"
  ).run(camp.id);
  assert.equal(sentToday(accountId), n + 2);
});