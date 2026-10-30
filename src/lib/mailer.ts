import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { fromIni } from "@aws-sdk/credential-providers";

/**
 * Outbound email, through Amazon SES.
 *
 * One function, one shape of result, and the provider behind a thin seam so
 * swapping it later is a config change rather than a rewrite. Everything that
 * sends mail goes through `send()`.
 *
 * Credentials come from `AWS_SES_PROFILE` when it is set, and otherwise from
 * the standard AWS chain, so an instance role works in production without a
 * key ever being written into this repository.
 *
 * The profile is read from our OWN variable rather than `AWS_PROFILE`, because
 * a developer machine often already exports that for something else. Node's
 * `--env-file` will not override a variable the environment already carries,
 * so the app would silently reach for someone else's profile and fail with a
 * message that names no profile at all.
 *
 * Sending NEVER throws into the caller. An invite that was written to the
 * database is a real invite whether or not the notification left the building,
 * and failing the whole action because SES was briefly unhappy would lose the
 * membership row for no reason. The result says what happened and the screen
 * reports it.
 */

export type MailResult =
  | { ok: true; messageId: string }
  | { ok: false; code: MailFailure; detail: string };

export type MailFailure =
  | "NOT_CONFIGURED"
  | "RECIPIENT_NOT_VERIFIED"
  | "SENDER_NOT_VERIFIED"
  | "THROTTLED"
  | "SEND_FAILED";

export type Mail = {
  to: string;
  subject: string;
  text: string;
  /** Copied in, and where a reply goes: a channel partner's own people, on mail sent in its name. */
  cc?: string[];
  replyTo?: string[];
};

const REGION = process.env.SES_REGION ?? process.env.AWS_REGION ?? "ap-south-1";

/** The verified identity mail goes out as. */
export function mailFrom(): string | null {
  return process.env.MAIL_FROM?.trim() || null;
}

export function mailerConfigured(): boolean {
  return mailFrom() !== null;
}

let client: SESv2Client | null = null;
function ses(): SESv2Client {
  // Reused across hot reloads in dev, like the database clients.
  const profile = process.env.AWS_SES_PROFILE?.trim();
  client ??= new SESv2Client({
    region: REGION,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });
  return client;
}

let injected: ((mail: Mail) => Promise<MailResult>) | null = null;

/** For checks: every mail goes to `fn` instead of SES until `null` puts SES back. */
export function useMailer(fn: ((mail: Mail) => Promise<MailResult>) | null): void {
  injected = fn;
}

export async function send(mail: Mail): Promise<MailResult> {
  if (injected) return injected(mail);
  const from = mailFrom();
  if (!from) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      detail: "MAIL_FROM is not set, so nothing is sent.",
    };
  }

  try {
    const out = await ses().send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [mail.to], ...(mail.cc?.length ? { CcAddresses: mail.cc } : {}) },
        ...(mail.replyTo?.length ? { ReplyToAddresses: mail.replyTo } : {}),
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: "UTF-8" },
            Body: { Text: { Data: mail.text, Charset: "UTF-8" } },
          },
        },
      }),
    );
    return { ok: true, messageId: out.MessageId ?? "" };
  } catch (e) {
    return { ok: false, ...classify(e, mail.to, from) };
  }
}

/**
 * Turn an SES error into something an admin can act on.
 *
 * The one that matters is the sandbox. Until production access is granted, SES
 * refuses any recipient that has not been verified in advance, and its message
 * ("Email address is not verified") names both addresses without saying which
 * is the problem. An admin reading "could not send" learns nothing; an admin
 * reading "this address has to be verified first" knows exactly what to do.
 */
function classify(
  e: unknown,
  to: string,
  from: string,
): { code: MailFailure; detail: string } {
  const err = e as { name?: string; message?: string };
  const name = err?.name ?? "";
  const message = err?.message ?? String(e);

  if (/not verified/i.test(message)) {
    // SES names the offending address in the message when it can.
    const blamesSender = message.includes(from) && !message.includes(to);
    return blamesSender
      ? {
          code: "SENDER_NOT_VERIFIED",
          detail: `${from} is not a verified sender in SES ${REGION}.`,
        }
      : {
          code: "RECIPIENT_NOT_VERIFIED",
          detail:
            `SES is still in the sandbox, so it will only deliver to verified ` +
            `addresses. Verify ${to}, or request production access.`,
        };
  }

  if (name === "TooManyRequestsException" || /throttl|rate exceeded/i.test(message)) {
    return { code: "THROTTLED", detail: "SES is rate limiting. Try again shortly." };
  }

  return { code: "SEND_FAILED", detail: `${name || "Send failed"}: ${message}`.slice(0, 300) };
}

/** The invite notification. The body is built by `inviteMessage()`. */
export function inviteMail(opts: { to: string; orgName: string; body: string }): Mail {
  return {
    to: opts.to,
    subject: `You have been added to ${opts.orgName} on Sales Desk`,
    text: opts.body,
  };
}
