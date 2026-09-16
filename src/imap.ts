/**
 * Surveillance IMAP d'une boîte : réponses « STOP » (désinscriptions) et
 * bounces durs → suppressions automatiques. Polling périodique par le daemon.
 * Jamais de suppression sur un bounce doux (4.x.x) : il peut se résoudre seul.
 */
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { db, addSuppression } from "./db.js";
import { decrypt } from "./crypto.js";

type ImapAccount = {
  id: number;
  label: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_password_enc: string;
  user: string;
};

const STOP_RE = /\b(stop|non merci|desinscript|désinscript|unsubscribe|remove me|ne plus recevoir)\b/i;
const BOUNCE_FROM_RE = /mailer-daemon|postmaster|mail delivery|no-?reply|bounce/i;
const BOUNCE_SUBJECT_RE = /undeliver|delivery (status|failure|report)|failure notice|returned mail/i;
const HARD_BOUNCE_RE = /\b5\.(\d{1,3}\.){2}\d{1,3}\b|user unknown|no such (user|address|recipient|mailbox)|unknown user|recipient rejected|address does not exist/i;
const SOFT_BOUNCE_RE = /\b4\.(\d{1,3}\.){2}\d{1,3}\b|temporar|try (again|later)|deferred|mailbox (is )?full|quota exceeded/i;

/** Adresse email extraite d'une valeur d'en-tête (peut être « Nom <mail@x> » ou une liste). */
function firstEmail(value: unknown): string {
  const s = typeof value === "string" ? value : "";
  const m = s.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  return m?.[0]?.toLowerCase() ?? "";
}

/** Destinataires d'origine d'un bounce (X-Failed-Recipients, corps du rapport). */
function bounceTargets(mail: ParsedMail): string[] {
  const out = new Set<string>();
  const failed = mail.headers?.get("x-failed-recipients");
  if (typeof failed === "string") {
    for (const m of failed.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      if (m[0]) out.add(m[0].toLowerCase());
    }
  }
  const body = `${mail.subject ?? ""}\n${mail.text ?? ""}`;
  // L'email du destinataire en échec, en position claire dans le rapport de livraison.
  const m = body.match(/(?:to|à|destinataire|address|recipient)[^@\n]{0,80}([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i);
  if (m?.[1]) out.add(m[1].toLowerCase());
  return [...out];
}

async function pollOne(account: ImapAccount): Promise<void> {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port || 993,
    secure: true,
    auth: { user: account.imap_user, pass: decrypt(account.imap_password_enc) },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Non lus uniquement : les notifications système et réponses récentes.
      const found = await client.search({ seen: false }, { uid: true });
      const uids = Array.isArray(found)
        ? (found as unknown[]).filter((u): u is number => typeof u === "number")
        : [];
      if (uids.length > 0) {
        for await (const msg of client.fetch(uids, { envelope: true, source: true }, { uid: true })) {
          if (!msg.source) continue;
          try {
            analyze(account, await simpleParser(msg.source));
          } finally {
            // Vu dans tous les cas : une suppression ratée sera rattrapable à la main,
            // et on ne retraite pas en boucle un mail sans action.
            await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true });
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.log(`IMAP "${account.label}" : ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Traite un message : réponse STOP ou bounce dur → suppression du compte. */
function analyze(account: ImapAccount, mail: ParsedMail): void {
  const from = firstEmail(mail.from?.value?.[0]?.address);
  const body = `${mail.subject ?? ""}\n${(mail.text ?? "").slice(0, 2000)}`;

  // 1) Réponse d'un destinataire (pas une notification système) : détecte le STOP.
  if (from && !BOUNCE_FROM_RE.test(from) && STOP_RE.test(body)) {
    addSuppression(account.id, from, "réponse STOP (auto IMAP)");
    console.log(`IMAP "${account.label}" : ${from} → suppression (réponse STOP).`);
    return;
  }

  // 2) Rapport d'échec de livraison : bounce dur uniquement.
  const isBounce = BOUNCE_SUBJECT_RE.test(mail.subject ?? "") || BOUNCE_FROM_RE.test(from);
  if (!isBounce) return;
  if (SOFT_BOUNCE_RE.test(body) && !HARD_BOUNCE_RE.test(body)) return; // doux : se résout souvent seul
  if (!HARD_BOUNCE_RE.test(body)) return;
  for (const target of bounceTargets(mail)) {
    addSuppression(account.id, target, "bounce dur (auto IMAP)");
    console.log(`IMAP "${account.label}" : ${target} → suppression (bounce dur).`);
  }
}

/**
 * Poll les boîtes IMAP configurées. Appelé par le scheduler
 * (au plus toutes les imap_poll_minutes, défaut 5 min).
 */
export async function pollImapAccounts(): Promise<void> {
  const accounts = db
    .prepare(
      `SELECT id, label, imap_host, imap_port, imap_user, imap_password_enc, user
       FROM smtp_accounts WHERE imap_host != '' AND imap_password_enc != ''`
    )
    .all() as ImapAccount[];
  await Promise.all(accounts.map((a) => pollOne(a)));
}