import nodemailer from "nodemailer";
import { decrypt } from "./crypto.js";
import { renderTemplate, textToHtml, type RecipientVars } from "./render.js";

export type SmtpAccount = {
  id: number;
  label: string;
  host: string;
  port: number;
  secure: number;
  user: string;
  password_enc: string;
  from_name: string;
};

export function createTransport(account: SmtpAccount) {
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure === 1,
    auth: { user: account.user, pass: decrypt(account.password_enc) },
  });
}

export type SendTarget = { email: string; name: string; vars: RecipientVars };

export type SendResult = { email: string; ok: true; messageId: string };

/** Envoie le mail de test d'un compte à sa propre adresse. */
export async function sendTest(account: SmtpAccount): Promise<SendResult> {
  const transport = createTransport(account);
  const from = fromHeader(account);
  const info = await transport.sendMail({
    from,
    to: account.user,
    subject: "MailPilot : ton compte SMTP fonctionne",
    text: "Bravo, ce compte envoyeur est bien configuré. Pilou peut livrer tes mails.",
  });
  transport.close();
  return { email: account.user, ok: true, messageId: info.messageId };
}

export function fromHeader(
  account: SmtpAccount
): string | { name: string; address: string } {
  return account.from_name
    ? { name: account.from_name, address: account.user }
    : account.user;
}

/**
 * Envoi séquentiel avec délai inter-mails (anti-spam), un mail par destinataire
 * (jamais de liste visible). Retourne les mises à jour à appliquer.
 */
export async function sendToRecipients(
  account: SmtpAccount,
  subjectTpl: string,
  bodyTpl: string,
  mode: "common" | "personalized",
  recipients: SendTarget[],
  delayMs: number,
  onResult: (email: string, ok: boolean, info: { messageId?: string; error?: string }) => void,
  opts: { unsubscribe?: boolean } = {}
): Promise<void> {
  const transport = createTransport(account);
  const from = fromHeader(account);
  const headers: Record<string, string> = {};
  if (opts.unsubscribe) {
    headers["List-Unsubscribe"] = `<mailto:${account.user}?subject=Desinscription>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  for (const r of recipients) {
    const vars = mode === "personalized" ? r.vars : {};
    const subject = renderTemplate(subjectTpl, vars, r.name, r.email);
    const text = renderTemplate(bodyTpl, vars, r.name, r.email) + (opts.unsubscribe ? unsubscribeFooter() : "");
    // Erreurs temporaires : 2 tentatives supplémentaires (backoff 5 s puis 15 s).
    const delays = [0, 5000, 15000];
    let lastError = "";
    let delivered = false;
    for (const wait of delays) {
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      try {
        const info = await transport.sendMail({
          from,
          to: r.email,
          subject,
          text,
          html: textToHtml(text),
          headers,
        });
        onResult(r.email, true, { messageId: info.messageId });
        delivered = true;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (!isTransient(lastError)) break;
      }
    }
    if (!delivered) onResult(r.email, false, { error: lastError });
    if (delayMs > 0) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  transport.close();
}

/** Erreurs SMTP/réseau qui méritent un nouvel essai. */
function isTransient(error: string): boolean {
  return /ECONNRESET|ETIMEDOUT|ESOCKET|EAI_AGAIN|ECONNREFUSED|connection|timeout|421|450|451/i.test(error);
}

function unsubscribeFooter(): string {
  return "\n\n—\nVous recevez ce mail suite à un contact professionnel. Pour ne plus en recevoir, répondez « STOP » à ce mail.";
}