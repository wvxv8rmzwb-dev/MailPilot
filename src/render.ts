/** Rendu des variables {cle} + parsing CSV de contacts. Aucune dépendance. */

export type RecipientVars = Record<string, string>;

/** {prenom} = vars.prenom, sinon premier mot de name, sinon "". */
export function resolveVar(key: string, vars: RecipientVars, name: string, email: string): string {
  if (key === "email") return email;
  if (key in vars) return vars[key] ?? "";
  if (key === "prenom") {
    const fromName = name.trim().split(/\s+/)[0];
    return fromName && fromName !== email ? fromName : "";
  }
  if (key === "nom") return name;
  return "";
}

export function renderTemplate(tpl: string, vars: RecipientVars, name = "", email = ""): string {
  return tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) =>
    escapeReplacement(resolveVar(key, vars, name, email))
  );
}

function escapeReplacement(s: string): string {
  return s.replace(/\$/g, "$$");
}

/** Clés {x} présentes dans le texte. */
export function extractVarKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    const k = m[1];
    if (k) keys.add(k);
  }
  return [...keys];
}

/**
 * Clés {x} utilisées dans le texte mais absentes des vars de TOUS les
 * destinataires (prenom/nom/email exclus : toujours résolus automatiquement).
 */
export function findMissingVars(
  text: string,
  recipients: { name: string; email: string; vars: RecipientVars }[]
): string[] {
  const auto = new Set(["prenom", "nom", "email"]);
  return extractVarKeys(text).filter(
    (k) => !auto.has(k) && !recipients.some((r) => r.vars[k] !== undefined)
  );
}

/** Convertit un corps texte en HTML simple (échappé, sauts de ligne, liens). */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const withLinks = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1">$1</a>'
  );
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${withLinks}</div>`;
}

export type ParsedContact = { email: string; name: string; vars: Record<string, string> };

/**
 * Parse un CSV de contacts (une ligne = un contact, séparateur ',' ou ';').
 * 1re ligne d'en-tête optionnelle : `email,nom,prenom,entreprise,...`
 * Sans en-tête : colonne 1 = email, colonne 2 = nom, reste = v1, v2...
 */
export function parseCsv(raw: string): ParsedContact[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  let headers: string[] | null = null;
  const first = splitLine(lines[0] ?? "");
  if (!first.some((c) => c.includes("@"))) {
    headers = first.map((h) => h.trim().toLowerCase());
    lines.shift();
  }

  const out: ParsedContact[] = [];
  for (const line of lines) {
    const cells = splitLine(line);
    const email = (headers ? valueAt(headers, cells, 0) : cells[0] ?? "").trim();
    if (!email.includes("@")) continue;
    const name = headers ? valueAt(headers, cells, 1) : cells[1] ?? "";
    const vars: Record<string, string> = {};
    if (headers) {
      headers.forEach((h, i) => {
        if (i >= 2) vars[h] = valueAt(headers, cells, i);
      });
      if (!("email" in vars)) vars.email = email;
      if (!("nom" in vars)) vars.nom = name;
    } else {
      cells.slice(2).forEach((v, i) => { vars[`v${i + 1}`] = v.trim(); });
    }
    out.push({ email, name: name.trim(), vars });
  }
  return out;
}

function splitLine(line: string): string[] {
  const sep = line.includes(";") ? ";" : ",";
  return line.split(sep).map((c) => c.trim());
}

function valueAt(headers: string[], cells: string[], i: number): string {
  const h = headers[i];
  return (h !== undefined ? cells[i] : "") ?? "";
}

/** Parse les lignes saisies à la main : `email ; nom ; cle=valeur ; cle=valeur`. */
export function parseRecipientLines(raw: string): ParsedContact[] {
  const out: ParsedContact[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = splitLine(trimmed);
    const email = parts[0] ?? "";
    if (!email.includes("@")) continue;
    const name = parts[1] ?? "";
    const vars: Record<string, string> = { email, nom: name };
    let defaultIdx = 0;
    for (const part of parts.slice(2)) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq > 0) {
        vars[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      } else {
        vars[`v${++defaultIdx}`] = part;
      }
    }
    out.push({ email, name, vars });
  }
  return out;
}