"use server";

import { headers } from "next/headers";
import { requirePermission } from "@/lib/guard";
import { normalisePhone } from "@/lib/calling-rules";
import { readCode } from "@/lib/otp-rules";
import { confirmOwnPhone, startChallenge } from "@/lib/otp";
import { placeProxyCall } from "@/lib/proxy";
import { maskPhone } from "@/lib/mask-rules";

/**
 * A person's own number, confirmed by a code, and a call to a buyer that
 * rings it first. Each answers in place: the dialog says what happened
 * next to the button that caused it.
 */

export type PhoneStep =
  | { ok: true; step: "CODE_SENT"; challengeId: string; phone: string; message: string }
  | { ok: true; step: "CONFIRMED"; masked: string; message: string }
  | { ok: false; message: string };

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/** Send a code to the number a person says is theirs. */
export async function sendPhoneCodeAction(raw: string): Promise<PhoneStep> {
  const { userId, orgId } = await requirePermission("lead:call");
  const phone = normalisePhone(String(raw ?? ""));
  if (!phone) return { ok: false, message: "That number does not look right. Use 10 digits, or add the country code." };
  const started = await startChallenge({ purpose: "VERIFY_PHONE", phone, userId, orgId, ip: await clientIp() });
  if (!started.ok) return { ok: false, message: started.message };
  return { ok: true, step: "CODE_SENT", challengeId: started.challengeId, phone, message: `Code sent on WhatsApp to ${maskPhone(phone)}.` };
}

/** The code came back: the number is theirs. */
export async function confirmPhoneAction(challengeId: string, phone: string, raw: string): Promise<PhoneStep> {
  const { userId, orgId } = await requirePermission("lead:call");
  const code = readCode(raw);
  if (!code) return { ok: false, message: "The code is six digits." };
  const e164 = normalisePhone(String(phone ?? ""));
  if (!e164) return { ok: false, message: "Ask for a new code." };
  const done = await confirmOwnPhone({ userId, orgId, challengeId: String(challengeId ?? ""), phone: e164, code });
  if (!done.ok) return { ok: false, message: done.message };
  return { ok: true, step: "CONFIRMED", masked: maskPhone(e164), message: "Your number is confirmed." };
}

/** Ring the person's own phone, then put them through to the buyer. */
export async function proxyCallAction(leadId: string): Promise<{ ok: boolean; message: string; needsPhone?: boolean }> {
  const { userId, orgId, authz } = await requirePermission("lead:call");
  const r = await placeProxyCall({ orgId, userId, authz, leadId: String(leadId ?? "") });
  if (r.ok) return { ok: true, message: "Ringing your phone now. Pick up to be put through." };
  return { ok: false, message: r.message, needsPhone: r.code === "NO_PHONE" };
}
