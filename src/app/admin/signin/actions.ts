"use server";

import { send } from "@/lib/mailer";
import { adminBase, isOperator, linkToken } from "@/lib/operator";

export type SignInState = { sent: boolean; error?: string };

/** One email an address a minute, per server instance. */
const lastSent = new Map<string, number>();

/**
 * Emails a sign-in link to an operator. Every address gets the same answer,
 * so the form says nothing about who may sign in.
 */
export async function requestLink(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { sent: false, error: "Enter an email address." };
  const base = adminBase();
  if (!base) return { sent: false, error: "Sign-in is not set up on this server." };

  if (isOperator(email)) {
    const last = lastSent.get(email) ?? 0;
    if (Date.now() - last > 60_000) {
      lastSent.set(email, Date.now());
      const link = `${base}/auth?t=${encodeURIComponent(linkToken(email))}`;
      const out = await send({
        to: email,
        subject: "Sign in to Sales Desk admin",
        text: `Open this link to sign in to Sales Desk admin. It works for 15 minutes.\n\n${link}\n\nIf you did not ask for this, ignore this email.`,
      });
      if (!out.ok) console.error(`admin sign-in: email not sent (${out.code})`);
    }
  }
  return { sent: true };
}
