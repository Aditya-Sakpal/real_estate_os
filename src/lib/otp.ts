import { hkdfSync, randomInt } from "node:crypto";
import { audit, controlDb, withTenant } from "./db/index.ts";
import { META_GRAPH_VERSION } from "./platform.ts";
import {
  OTP_COST_PAISE,
  OTP_DIGITS,
  OTP_TTL_MS,
  SEND_LIMITS,
  TEMPLATE_MISSING,
  authTemplateComponents,
  checkCode,
  codeMessage,
  codeHash,
  phoneHash,
  sendRefusal,
  type OtpPurpose,
} from "./otp-rules.ts";

/**
 * Sending a code and checking it. The rules are `otp-rules.ts`; this writes
 * the challenge, reads the limits from the rows before anything is sent, and
 * is the one door to the message that carries the code.
 *
 * Control plane, like sign-in: the table is not reachable from the app role,
 * because a code is asked for before anybody has a tenant.
 */

// ---------------------------------------------------------------------------
// The message: a WhatsApp authentication template, behind a seam
// ---------------------------------------------------------------------------

export type CodeSender = { send(to: string, code: string): Promise<void> };

/** The approved authentication template, a copy-code button beside the code. */
const TEMPLATE = () => process.env.WHATSAPP_AUTH_TEMPLATE?.trim() || "est_login_code";

/**
 * Sales Desk's own number sends login codes, never a tenant's: a code is
 * ours to vouch for, and a tenant's number may not exist yet when one is
 * needed (a channel partner signing in for the first time).
 */
const realSender: CodeSender = {
  async send(to, code) {
    const token = process.env.WHATSAPP_TOKEN?.trim();
    const numberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    if (!token || !numberId) throw new Error("WhatsApp is not set up for login codes");
    const post = async (message: Record<string, unknown>) => {
      const res = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${numberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: to.replace(/^\+/, ""), ...message }),
      });
      if (res.ok) return null;
      const text = await res.text().catch(() => "");
      let metaCode: number | null = null;
      try {
        metaCode = (JSON.parse(text) as { error?: { code?: number } }).error?.code ?? null;
      } catch {
        // not Meta's JSON
      }
      return { status: res.status, metaCode, text: text.slice(0, 200) };
    };
    const sent = await post({
      type: "template",
      template: { name: TEMPLATE(), language: { code: "en" }, components: authTemplateComponents(code) },
    });
    if (!sent) return;
    // No approved template to send it in (Meta lets no test account create
    // one): the code goes as plain text, which WhatsApp delivers only inside
    // the 24 hours after the person last wrote to this number.
    if (sent.metaCode !== null && TEMPLATE_MISSING.has(sent.metaCode)) {
      const plain = await post({ type: "text", text: { body: codeMessage(code) } });
      if (!plain) return;
      throw new Error(`WhatsApp ${plain.status}: ${plain.text}`);
    }
    throw new Error(`WhatsApp ${sent.status}: ${sent.text}`);
  },
};

/**
 * A development machine with no WhatsApp: the code is written to the
 * server's log instead of sent. Never set in production, and ignored on
 * Vercel and in a production build even if it is.
 */
const echoSender: CodeSender = {
  async send(to, code) {
    console.log(`[otp] code for ...${to.slice(-2)}: ${code}`);
  },
};

/**
 * A development machine where proving a number is in the way: the partner's
 * sign-up takes the number as given, with no code sent or asked for.
 * `OTP_DEV_SKIP=1`, and ignored on Vercel and in a production build even if
 * it is set, the same guard as the log seam above.
 */
export const codesSkipped = (): boolean =>
  process.env.OTP_DEV_SKIP === "1" && !process.env.VERCEL && process.env.NODE_ENV !== "production";

let injected: CodeSender | null = null;

/** For checks: every code goes to `sender` until `restore()`. */
export function useCodeSender(sender: CodeSender): { restore(): void } {
  injected = sender;
  return { restore: () => void (injected = null) };
}

function sender(): CodeSender {
  if (injected) return injected;
  const echo = process.env.OTP_DEV_ECHO === "1" && !process.env.VERCEL && process.env.NODE_ENV !== "production";
  return echo ? echoSender : realSender;
}

function hmacKey(): Buffer {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return Buffer.from(hkdfSync("sha256", secret, "salesdesk", "salesdesk/otp/v1", 32));
}

const ipHash = (ip: string | null | undefined) => (ip ? phoneHash(`ip:${ip}`) : null);

// ---------------------------------------------------------------------------
// Asking for a code
// ---------------------------------------------------------------------------

export type Started = { ok: true; challengeId: string } | { ok: false; message: string };

export async function startChallenge(opts: {
  purpose: OtpPurpose;
  /** E.164, already normalised. */
  phone: string;
  userId?: string | null;
  orgId?: string | null;
  action?: string | null;
  targetId?: string | null;
  ip?: string | null;
  now?: Date;
  /**
   * False for a sign-in to a number that may not sign in. The row is written
   * and counted exactly as a sent one, so every limit answers the same for a
   * number nobody holds as for one somebody does, but nothing is sent, it
   * costs nothing, and its code is one nobody was told.
   */
  deliver?: boolean;
}): Promise<Started> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const ph = phoneHash(opts.phone);
  const ih = ipHash(opts.ip);
  const hourAgo = new Date(nowMs - 3_600_000);
  const dayStart = new Date(Math.floor((nowMs + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000);

  // A day of history is all any limit reads; older rows answer nothing.
  await controlDb`DELETE FROM otp_challenges WHERE created_at < ${new Date(nowMs - 2 * 86_400_000)}`;

  const [h] = await controlDb<{ last_at: Date | null; hour: number; day: number; ip_hour: number; fails: number; everyone: number }[]>`
    SELECT
      (SELECT max(created_at) FROM otp_challenges WHERE phone_hash = ${ph} AND sent) AS last_at,
      (SELECT count(*)::int FROM otp_challenges WHERE phone_hash = ${ph} AND sent AND created_at >= ${hourAgo}) AS hour,
      (SELECT count(*)::int FROM otp_challenges WHERE phone_hash = ${ph} AND sent AND created_at >= ${dayStart}) AS day,
      (SELECT count(*)::int FROM otp_challenges WHERE ${ih}::text IS NOT NULL AND ip_hash = ${ih} AND created_at >= ${hourAgo}) AS ip_hour,
      (SELECT coalesce(sum(attempts), 0)::int FROM otp_challenges
        WHERE phone_hash = ${ph} AND created_at >= ${dayStart} AND consumed_at IS NULL) AS fails,
      (SELECT count(*)::int FROM otp_challenges WHERE sent AND created_at >= ${dayStart}) AS everyone`;
  const ceiling = Number(process.env.OTP_DAILY_CAP) || SEND_LIMITS.everyonePerDay;
  const refused = sendRefusal(
    {
      lastAt: h.last_at ? h.last_at.getTime() : null,
      hour: h.hour,
      day: h.day,
      ipHour: h.ip_hour,
      failsToday: h.fails,
      everyoneToday: h.everyone,
    },
    nowMs,
    ceiling,
  );
  if (refused) return { ok: false, message: refused.message };

  const code = String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, "0");
  const [row] = await controlDb<{ id: string }[]>`
    INSERT INTO otp_challenges (purpose, phone_hash, code_hash, user_id, org_id, action, target_id, ip_hash,
                                created_at, expires_at)
    VALUES (${opts.purpose}, ${ph}, ${"0".repeat(64)}, ${opts.userId ?? null}, ${opts.orgId ?? null},
            ${opts.action ?? null}, ${opts.targetId ?? null}, ${ih}, ${now}, ${new Date(nowMs + OTP_TTL_MS)})
    RETURNING id`;
  // The hash is keyed by the row's own id, so it is written once the id exists.
  await controlDb`UPDATE otp_challenges SET code_hash = ${codeHash(hmacKey(), row.id, code)} WHERE id = ${row.id}`;

  if (opts.deliver === false) {
    await controlDb`UPDATE otp_challenges SET sent = true WHERE id = ${row.id}`;
    await audit({
      orgId: null,
      actorUserId: null,
      action: "otp.withheld",
      targetType: "otp",
      targetId: row.id,
      metadata: { purpose: opts.purpose, phone: ph },
    });
    return { ok: true, challengeId: row.id };
  }

  try {
    await sender().send(opts.phone, code);
  } catch (e) {
    console.error("otp: send failed", e instanceof Error ? e.message : e);
    return { ok: false, message: "The code could not be sent. Try again in a minute." };
  }
  await controlDb`UPDATE otp_challenges SET sent = true, cost_paise = ${OTP_COST_PAISE} WHERE id = ${row.id}`;
  await audit({
    orgId: opts.orgId ?? null,
    actorUserId: opts.userId ?? null,
    action: "otp.sent",
    targetType: "otp",
    targetId: row.id,
    metadata: { purpose: opts.purpose, phone: ph, unit: "whatsapp_authentication" },
  });
  return { ok: true, challengeId: row.id };
}

// ---------------------------------------------------------------------------
// Checking one
// ---------------------------------------------------------------------------

export type Verified = { ok: true } | { ok: false; message: string };

/**
 * One try. The row is locked for the length of the check, so two tries at
 * once cannot both be counted as the fifth, and a right code is used once.
 * The purpose, the person and (for a step-up) the action must all be the
 * ones the code was sent for.
 */
export async function verifyChallenge(opts: {
  challengeId: string;
  phone: string;
  code: string;
  purpose: OtpPurpose;
  userId?: string | null;
  action?: string | null;
  targetId?: string | null;
  now?: Date;
}): Promise<Verified> {
  const nowMs = (opts.now ?? new Date()).getTime();
  const unknown: Verified = { ok: false, message: "That code is not right. Ask for a new one." };
  if (!/^[0-9a-f-]{36}$/i.test(opts.challengeId)) return unknown;

  return controlDb.begin(async (tx) => {
    const [c] = await tx<{
      id: string; code_hash: string; phone_hash: string; expires_at: Date; attempts: number; consumed_at: Date | null;
      purpose: OtpPurpose; user_id: string | null; action: string | null; target_id: string | null;
    }[]>`
      SELECT id, code_hash, phone_hash, expires_at, attempts, consumed_at, purpose, user_id, action, target_id
      FROM otp_challenges WHERE id = ${opts.challengeId} AND sent FOR UPDATE`;
    if (!c || c.purpose !== opts.purpose) return unknown;
    if ((opts.userId ?? null) !== c.user_id) return unknown;
    if ((opts.action ?? null) !== c.action || (opts.targetId ?? null) !== c.target_id) return unknown;

    const checked = checkCode(
      {
        id: c.id,
        codeHash: c.code_hash,
        phoneHash: c.phone_hash,
        expiresAt: c.expires_at.getTime(),
        attempts: c.attempts,
        consumedAt: c.consumed_at ? c.consumed_at.getTime() : null,
      },
      opts.phone,
      opts.code,
      hmacKey(),
      nowMs,
    );
    if (!checked.ok) {
      if (checked.spent) await tx`UPDATE otp_challenges SET attempts = least(attempts + 1, 5) WHERE id = ${c.id}`;
      return { ok: false, message: checked.message };
    }
    await tx`UPDATE otp_challenges SET consumed_at = now() WHERE id = ${c.id}`;
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// A person's own number
// ---------------------------------------------------------------------------

/**
 * Keep a number as the person's own once a code sent to it has come back.
 * One number, one person: `users.phone` is unique, so a number already on
 * somebody else's account is refused rather than moved.
 */
export async function confirmOwnPhone(opts: {
  userId: string;
  orgId: string;
  challengeId: string;
  phone: string;
  code: string;
}): Promise<Verified> {
  const v = await verifyChallenge({
    challengeId: opts.challengeId,
    phone: opts.phone,
    code: opts.code,
    purpose: "VERIFY_PHONE",
    userId: opts.userId,
  });
  if (!v.ok) return v;
  try {
    // Their own row, read and written inside their tenant like any other.
    await withTenant(opts.orgId, (sql) =>
      sql`UPDATE users SET phone = ${opts.phone}, phone_verified_at = now() WHERE id = ${opts.userId}`);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, message: "That number is already on another account." };
    throw e;
  }
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "user.phone_verified",
    targetType: "user",
    targetId: opts.userId,
    metadata: { phone: phoneHash(opts.phone) },
  });
  return { ok: true };
}

/** The person's own number, if they have confirmed one. */
export async function ownPhone(orgId: string, userId: string): Promise<string | null> {
  const [u] = await withTenant(orgId, (sql) => sql<{ phone: string | null }[]>`
    SELECT phone FROM users WHERE id = ${userId} AND phone_verified_at IS NOT NULL`);
  return u?.phone ?? null;
}
