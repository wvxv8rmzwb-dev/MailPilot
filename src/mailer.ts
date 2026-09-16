import nodemailer from "nodemailer";
import { decrypt } from "./crypto.js";
import { renderTemplate, textToHtml, htmlToText, type RecipientVars } from "./render.js";
import { globalVars } from "./db.js";

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

export type CampaignAttachment = { filename: string; path: string };

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
 *
 * `opts.remaining` : quota restant du compte aujourd'hui (null = illimité).
 * Une fois le quota épuisé, l'envoi s'arrête — les destinataires restants
 * demeurent `pending` et le scheduler replanifie la campagne à demain.
 *
 * `opts.bodyFormat` : "text" (défaut) → le corps est du texte et l'HTML est
 * dérivé ; "html" → le corps EST du HTML et le texte en est dégradé.
 *
 * `opts.attachments` : pièces jointes communes à tous les destinataires.
 * Les variables globales ({signature}...) sont fusionnées sous les vars du contact.
 */
export async function sendToRecipients(
  account: SmtpAccount,
  subjectTpl: string,
  bodyTpl: string,
  mode: "common" | "personalized",
  recipients: SendTarget[],
  delayMs: number,
  onResult: (email: string, ok: boolean, info: { messageId?: string; error?: string }) => void,
  opts: {
    unsubscribe?: boolean;
    bodyFormat?: "text" | "html";
    remaining?: number | null;
    attachments?: CampaignAttachment[];
  } = {}
): Promise<void> {
  const transport = createTransport(account);
  const from = fromHeader(account);
  const headers: Record<string, string> = {};
  if (opts.unsubscribe) {
    headers["List-Unsubscribe"] = `<mailto:${account.user}?subject=Desinscription>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const isHtml = opts.bodyFormat === "html";
  const globals = globalVars();
  const attachments = (opts.attachments ?? []).map((a) => ({
    filename: a.filename,
    path: a.path,
  }));
  let sentCount = 0;

  for (const r of recipients) {
    if (opts.remaining != null && sentCount >= opts.remaining) break;
    const contact = mode === "personalized" ? r.vars : {};
    const vars: RecipientVars = { ...globals, ...contact };
    const subject = renderTemplate(subjectTpl, vars, r.name, r.email);
    const renderedBody = renderTemplate(bodyTpl, vars, r.name, r.email);
    const text = isHtml
      ? htmlToText(renderedBody) + (opts.unsubscribe ? unsubscribeFooter() : "")
      : renderedBody + (opts.unsubscribe ? unsubscribeFooter() : "");
    const html = isHtml
      ? renderedBody + (opts.unsubscribe ? unsubscribeHtmlFooter() : "")
      : textToHtml(text);
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
          html,
          headers,
          attachments,
        });
        onResult(r.email, true, { messageId: info.messageId });
        delivered = true;
        sentCount += 1;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (!isTransientError(lastError)) break;
      }
    }
    if (!delivered) onResult(r.email, false, { error: lastError });
    if (delayMs > 0) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  transport.close();
}

/** Erreurs SMTP/réseau qui méritent un nouvel essai (exporté pour l'auto-retry). */
export function isTransientError(error: string): boolean {
  return /ECONNRESET|ETIMEDOUT|ESOCKET|EAI_AGAIN|ECONNREFUSED|connection|timeout|421|450|451|452|454/i.test(error);
}

function unsubscribeFooter(): string {
  return "\n\n—\nVous recevez ce mail suite à un contact professionnel. Pour ne plus en recevoir, répondez « STOP » à ce mail.";
}

function unsubscribeHtmlFooter(): string {
  return '<p style="margin-top:24px;padding-top:12px;border-top:1px solid #ddd;color:#666;font-size:12px">Vous recevez ce mail suite à un contact professionnel. Pour ne plus en recevoir, répondez « STOP » à ce mail.</p>';
}

/**
 * Envoie le mail composé (sujet + corps, variables d'exemple) à la propre
 * adresse du compte : test réel du rendu avant de lancer une campagne.
 */
export async function sendPreview(
  account: SmtpAccount,
  subject: string,
  body: string,
  mode: "common" | "personalized",
  bodyFormat: "text" | "html",
  sampleVars: Record<string, string> = {}
): Promise<SendResult> {
  const vars: RecipientVars = {
    prenom: "Amélie",
    nom: "Amélie Dufour",
    email: "exemple@destinataire.fr",
    ...globalVars(),
    ...sampleVars,
  };
  const name = vars["nom"] ?? "";
  const email = vars["email"] ?? "";
  const v = mode === "personalized" ? vars : {};
  const subjectR = renderTemplate(subject, v, name, email);
  const isHtml = bodyFormat === "html";
  const bodyR = renderTemplate(body, v, name, email);
  const info = await createTransport(account).sendMail({
    from: fromHeader(account),
    to: account.user,
    subject: subjectR,
    text: isHtml ? htmlToText(bodyR) : bodyR,
    html: isHtml ? bodyR : textToHtml(bodyR),
  });
  return { email: account.user, ok: true, messageId: info.messageId };
}