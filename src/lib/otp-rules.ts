/**
 * One-time codes: the rules, with no database and no network.
 *
 * A code proves somebody holds a phone right now. It is used three ways:
 * verifying a person's own number once (so a call through our number rings
 * the right phone), signing a channel partner in, and stepping up a phone
 * session for one sensitive action. The rules are the same for all three.
 *
 * Six digits, five minutes, five tries, one use. Stored only as an HMAC keyed
 * by the challenge's own id, so a leaked table is a list of hashes that each
 * open one five-minute window, and the phone is stored only as a hash too.
 *
 * Every limit is a count of rows already written, read before a code is sent:
 * sending costs money (a WhatsApp authentication message) and a limiter that
 * is asked after the send limits nothing. Relative imports: `check:logic`
 * loads this from source.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type OtpPurpose = "VERIFY_PHONE" | "SIGN_IN" | "STEP_UP";

export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 5 * 60_000;
/** Wrong codes one challenge takes before it is dead. */
export const MAX_ATTEMPTS = 5;
/** Our cost of one WhatsApp authentication message in India, in paise, rounded up. */
export const OTP_COST_PAISE = 12;

export const SEND_LIMITS = {
  /** Seconds between two codes to one number. */
  gapSeconds: 60,
  perHour: 5,
  perDay: 10,
  /** Codes one address may ask for in an hour, across numbers. */
  perIpHour: 20,
  /** Wrong codes a number may collect in a day before it is locked until midnight. */
  failsPerDay: 10,
  /** Every code we send in a day, all tenants: the ceiling on what abuse can cost. */
  everyonePerDay: 2_000,
} as const;

/** What has already been sent, counted from the rows. */
export type SendHistory = {
  /** Epoch ms of the last code to this number, or null. */
  lastAt: number | null;
  hour: number;
  day: number;
  ipHour: number;
  failsToday: number;
  everyoneToday: number;
};

export type Refusal = { code: string; message: string };

/** Why a code may not be sent now, or null when it may. The order is the cheapest answer first. */
export function sendRefusal(h: SendHistory, nowMs: number, ceiling: number = SEND_LIMITS.everyonePerDay): Refusal | null {
  if (h.failsToday >= SEND_LIMITS.failsPerDay) {
    return { code: "LOCKED", message: "Too many wrong codes for this number today. Try again tomorrow." };
  }
  if (h.lastAt !== null && nowMs - h.lastAt < SEND_LIMITS.gapSeconds * 1000) {
    return { code: "TOO_SOON", message: "A code was just sent. Wait a minute before asking for another." };
  }
  if (h.hour >= SEND_LIMITS.perHour || h.day >= SEND_LIMITS.perDay) {
    return { code: "TOO_MANY", message: "Too many codes for this number. Try again later." };
  }
  if (h.ipHour >= SEND_LIMITS.perIpHour) {
    return { code: "TOO_MANY", message: "Too many codes asked for from here. Try again later." };
  }
  if (h.everyoneToday >= ceiling) {
    return { code: "PAUSED", message: "Codes cannot be sent right now. Try again in a while." };
  }
  return null;
}

/** A code as a person types it: six digits, spaces forgiven. */
export function readCode(raw: unknown): string | null {
  const v = String(raw ?? "").replace(/\s/g, "");
  return new RegExp(`^\\d{${OTP_DIGITS}}$`).test(v) ? v : null;
}

/** The hash a code is stored as, keyed by the challenge it belongs to. */
export function codeHash(key: Buffer, challengeId: string, code: string): string {
  return createHmac("sha256", key).update(`${challengeId}:${code}`).digest("hex");
}

/** How a phone is found again without being stored. */
export function phoneHash(e164: string): string {
  return createHash("sha256").update(e164.trim()).digest("hex");
}

export type Challenge = {
  id: string;
  codeHash: string;
  phoneHash: string;
  expiresAt: number;
  attempts: number;
  consumedAt: number | null;
};

export type Checked =
  | { ok: true }
  | { ok: false; code: "USED" | "EXPIRED" | "LOCKED" | "WRONG_PHONE" | "WRONG"; message: string; spent: boolean };

/**
 * One try at one challenge. `spent` says whether the try counts against the
 * challenge's attempts: a wrong code does; a code sent to a dead challenge
 * does not need to, because nothing can open it any more.
 */
export function checkCode(c: Challenge, phone: string, code: string, key: Buffer, nowMs: number): Checked {
  if (c.consumedAt !== null) return { ok: false, code: "USED", message: "That code was already used. Ask for a new one.", spent: false };
  if (nowMs > c.expiresAt) return { ok: false, code: "EXPIRED", message: "That code has expired. Ask for a new one.", spent: false };
  if (c.attempts >= MAX_ATTEMPTS) {
    return { ok: false, code: "LOCKED", message: "Too many wrong codes. Ask for a new one.", spent: false };
  }
  if (phoneHash(phone) !== c.phoneHash) {
    return { ok: false, code: "WRONG_PHONE", message: "That code was sent to a different number.", spent: true };
  }
  const want = Buffer.from(c.codeHash, "hex");
  const got = Buffer.from(codeHash(key, c.id, code), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    const left = MAX_ATTEMPTS - c.attempts - 1;
    return {
      ok: false,
      code: "WRONG",
      message: left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Ask for a new one.",
      spent: true,
    };
  }
  return { ok: true };
}

/** The two components Meta's authentication template takes: the code in the body and on the copy button. */
export function authTemplateComponents(code: string) {
  return [
    { type: "body", parameters: [{ type: "text", text: code }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
  ];
}

/**
 * Meta's answers when the template is not there to send: it does not
 * exist, or not in this language, or it is paused or disabled.
 */
export const TEMPLATE_MISSING: ReadonlySet<number> = new Set([132000, 132001, 132015, 132016]);

/** A code as plain text, for when no approved template can carry it. */
export function codeMessage(code: string): string {
  return `Your Sales Desk code is ${code}. It expires in 5 minutes. Do not share it with anyone.`;
}
