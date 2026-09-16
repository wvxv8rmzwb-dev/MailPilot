import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderTemplate,
  textToHtml,
  htmlToText,
  parseCsv,
  parseRecipientLines,
  findMissingVars,
} from "./render.js";

// ---------- renderTemplate ----------

test("renderTemplate remplace les variables simples", () => {
  const out = renderTemplate("Bonjour {prenom} de {entreprise}", { prenom: "Amélie", entreprise: "OF Lyon" }, "Amélie Fournier", "amelie@of.fr");
  assert.equal(out, "Bonjour Amélie de OF Lyon");
});

test("renderTemplate : {prenom} tombe sur le 1er mot de name", () => {
  assert.equal(renderTemplate("Salut {prenom}", {}, "Karim Benali", "k@x.fr"), "Salut Karim");
});

test("renderTemplate : {email} et {nom} sont automatiques", () => {
  const out = renderTemplate("{email} — {nom}", {}, "Karim Benali", "k@x.fr");
  assert.equal(out, "k@x.fr — Karim Benali");
});

test("renderTemplate : la var explicite gagne sur le fallback nom", () => {
  assert.equal(renderTemplate("{nom}", { nom: "Société Dupont" }, "Karim", "k@x.fr"), "Société Dupont");
});

test("renderTemplate : clé inconnue → chaîne vide", () => {
  assert.equal(renderTemplate("Hi {inconnu}!", {}, "A B", "a@x.fr"), "Hi !");
});

test("renderTemplate : les $ d'une valeur ne cassent pas le remplacement", () => {
  // "$&" dans String.replace insérerait le match entier si non échappé.
  assert.equal(renderTemplate("{x}", { x: "$& {prenom}" }, "A B", "a@x.fr"), "$& {prenom}");
});

test("renderTemplate : corps vide → vide", () => {
  assert.equal(renderTemplate("", { prenom: "A" }, "A B", "a@x.fr"), "");
});

// ---------- textToHtml ----------

test("textToHtml échappe le HTML dangereux", () => {
  const html = textToHtml("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("textToHtml transforme une URL en lien", () => {
  const html = textToHtml("Voir https://exemple.fr/page et voilà");
  assert.ok(html.includes('<a href="https://exemple.fr/page">https://exemple.fr/page</a>'));
});

test("textToHtml n'échappe pas deux fois les liens", () => {
  const html = textToHtml("https://exemple.fr/a<b");
  assert.ok(html.includes("&lt;b"));
});

// ---------- htmlToText ----------

test("htmlToText dégrade un HTML simple en texte lisible", () => {
  const text = htmlToText("<p>Bonjour Amélie,</p><p>Une question ?</p>");
  assert.equal(text, "Bonjour Amélie,\nUne question ?");
});

test("htmlToText transforme <br> et <li> en retours/puces", () => {
  const text = htmlToText("Ligne 1<br>Ligne 2<ul><li>un</li><li>deux</li></ul>");
  assert.ok(text.includes("Ligne 1\nLigne 2"));
  assert.ok(text.includes("• un"));
});

test("htmlToText retire style/script/commentaires et décode les entités", () => {
  const text = htmlToText(
    "<style>p{color:red}</style><!-- note --><p>A &amp; B &lt;ok&gt; &quot;cité&quot; &#39;apostrophe&#39;</p>"
  );
  assert.ok(!text.includes("color"));
  assert.ok(!text.includes("note"));
  assert.ok(text.includes("A & B <ok> \"cité\" 'apostrophe'"));
});

test("htmlToText compacte les blancs en excès", () => {
  const text = htmlToText("<div>A</div>\n\n\n<div>B</div>");
  assert.equal(text, "A\n\nB");
});

// ---------- parseCsv ----------

test("parseCsv détecte l'en-tête et les colonnes nommées", () => {
  const rows = parseCsv("email,nom,prenom,entreprise\na@x.fr,Amélie Fournier,Amélie,OF Lyon");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.email, "a@x.fr");
  assert.equal(rows[0]?.name, "Amélie Fournier");
  assert.equal(rows[0]?.vars["entreprise"], "OF Lyon");
  assert.equal(rows[0]?.vars["prenom"], "Amélie");
});

test("parseCsv marche avec le séparateur point-virgule", () => {
  const rows = parseCsv("b@x.fr;Bob Martin;ville=Lyon");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "Bob Martin");
  assert.equal(rows[0]?.vars["v1"], "ville=Lyon");
});

test("parseCsv sans en-tête : colonnes 1-2 puis v1, v2…", () => {
  const rows = parseCsv("a@x.fr,Amélie,Fournier,OF");
  assert.equal(rows[0]?.name, "Amélie");
  assert.equal(rows[0]?.vars["v1"], "Fournier");
  assert.equal(rows[0]?.vars["v2"], "OF");
});

test("parseCsv ignore les lignes sans @", () => {
  const rows = parseCsv("pas-un-email,A B\na@x.fr,A B");
  assert.equal(rows.length, 1);
});

test("parseCsv : CSV vide → tableau vide", () => {
  assert.deepEqual(parseCsv("   \n  "), []);
});

// ---------- parseRecipientLines ----------

test("parseRecipientLines : format email ; nom ; cle=valeur", () => {
  const rows = parseRecipientLines("a@x.fr ; Amélie Fournier ; entreprise=OF Lyon ; role=DG");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.email, "a@x.fr");
  assert.equal(rows[0]?.name, "Amélie Fournier");
  assert.equal(rows[0]?.vars["entreprise"], "OF Lyon");
  assert.equal(rows[0]?.vars["role"], "DG");
  assert.equal(rows[0]?.vars["email"], "a@x.fr");
});

test("parseRecipientLines ignore les lignes invalides et vides", () => {
  const rows = parseRecipientLines("\nsans-arobase ; X\n\nb@x.fr ; Bob\n");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.email, "b@x.fr");
});

test("parseRecipientLines : valeur contenant un =", () => {
  const rows = parseRecipientLines("a@x.fr ; A ; lien=https://x.fr?a=1");
  assert.equal(rows[0]?.vars["lien"], "https://x.fr?a=1");
});

// ---------- findMissingVars ----------

test("findMissingVars signale les clés absentes de tous les contacts", () => {
  const missing = findMissingVars("Bonjour {prenom}, {entreprise} vous intéresse ?", [
    { name: "Amélie", email: "a@x.fr", vars: { prenom: "Amélie" } },
  ]);
  assert.deepEqual(missing, ["entreprise"]);
});

test("findMissingVars ignore prenom/nom/email (auto-résolus)", () => {
  const missing = findMissingVars("{prenom} {nom} {email} {entreprise}", [
    { name: "Amélie", email: "a@x.fr", vars: {} },
  ]);
  assert.deepEqual(missing, ["entreprise"]);
});

test("findMissingVars : clé présente chez au moins un contact → pas de warning", () => {
  const missing = findMissingVars("Bonjour {prenom} de {entreprise}", [
    { name: "Amélie", email: "a@x.fr", vars: { entreprise: "OF Lyon" } },
    { name: "Bob", email: "b@x.fr", vars: {} },
  ]);
  assert.deepEqual(missing, []);
});