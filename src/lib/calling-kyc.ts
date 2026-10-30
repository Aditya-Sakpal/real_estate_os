import { randomBytes } from "node:crypto";
import { audit, withTenant } from "./db/index.ts";
import { open, seal } from "./vault.ts";
import { vobizSubPurpose } from "./vault-rules.ts";
import { vobiz, vobizConfig } from "./vobiz.ts";
import {
  KYC_CHECKS_PER_DAY,
  kycProblem,
  needsAadhaar,
  readBusinessType,
  readDocResult,
  readKycDocs,
  readKycEmail,
  readKycStatus,
  type BusinessType,
  type KycStatus,
} from "./calling-number-rules.ts";

/**
 * The client's own Vobiz sub-account and its KYC (0121, 0122).
 *
 * Every calling number a client gets sits on a sub-account in its own name,
 * verified once, so a number a buyer reports is the client's, not
 * Sales Desk's (decided 28 October 2026). The client types its PAN and GST
 * or CIN on our own screen and we check each with Vobiz; a person or a
 * proprietor then gives Aadhaar through DigiLocker, which only the
 * government's page may take. Nothing typed is kept: Vobiz holds the
 * documents, we keep where the check stands. The sub-account's token is
 * sealed per tenant and never shown. Until Vobiz says the KYC passed, no
 * number is offered.
 */

export type KycView = {
  status: KycStatus;
  blocked: boolean;
  businessType: BusinessType;
  email: string;
  /** Where each document stands (pan, gst, cin, aadhaar). */
  verifications: Record<string, string>;
  checkedAt: string | null;
  /** Null when a number may be got. */
  problem: string | null;
};

type Row = {
  id: string;
  sub_auth_id: string;
  business_type: BusinessType;
  email: string;
  kyc_status: KycStatus;
  calls_blocked: boolean;
  verifications: Record<string, string>;
  checked_at: Date | null;
  digilocker_request: string | null;
  digilocker_state: string | null;
};

const COLS = "id, sub_auth_id, business_type, email, kyc_status, calls_blocked, verifications, checked_at, digilocker_request, digilocker_state";

/** How often a page load asks Vobiz again while a KYC is under way. */
const RECHECK_MS = 15_000;

async function rowOf(orgId: string): Promise<Row | null> {
  const [r] = await withTenant(orgId, (sql) => sql<Row[]>`
    SELECT ${sql.unsafe(COLS)} FROM vobiz_subaccounts WHERE org_id = ${orgId}`);
  return r ?? null;
}

const view = (r: Row): KycView => ({
  status: r.kyc_status,
  blocked: r.calls_blocked,
  businessType: r.business_type,
  email: r.email,
  verifications: r.verifications ?? {},
  checkedAt: r.checked_at?.toISOString() ?? null,
  problem: kycProblem({ status: r.kyc_status, blocked: r.calls_blocked }),
});

const verifiedNow = (r: Row) => r.kyc_status === "verified" && !r.calls_blocked;

/**
 * Ask Vobiz where the KYC stands and keep it, once verified never asked
 * again. Never throws: Vobiz not answering leaves what we had.
 */
async function refresh(orgId: string, r: Row, userId: string | null): Promise<Row> {
  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.subAccountKyc) return r;
  let read;
  try {
    read = readKycStatus(await driver.subAccountKyc(cfg, r.sub_auth_id));
  } catch (e) {
    console.warn(`calling kyc: status failed: ${e instanceof Error ? e.message : String(e)}`);
    return r;
  }
  const nowVerified = read.status === "verified" && !read.blocked;
  const [next] = await withTenant(orgId, (sql) => sql<Row[]>`
    UPDATE vobiz_subaccounts
    SET kyc_status = ${read.status}, calls_blocked = ${read.blocked}, verifications = ${sql.json(read.verifications)},
        checked_at = now(), verified_at = CASE WHEN ${nowVerified} THEN coalesce(verified_at, now()) ELSE verified_at END
    WHERE org_id = ${orgId} AND id = ${r.id}
    RETURNING ${sql.unsafe(COLS)}`);
  if (nowVerified && r.kyc_status !== "verified") {
    await audit({ orgId, actorUserId: userId, action: "calling.kyc_verified", targetType: "org", targetId: orgId, metadata: { business_type: r.business_type } });
  }
  return next ?? r;
}

/** The KYC as the page shows it, asked of Vobiz again while it is under way. */
export async function kycView(orgId: string, opts: { refresh?: boolean; userId?: string | null } = {}): Promise<KycView | null> {
  let r = await rowOf(orgId);
  if (!r) return null;
  const stale = !r.checked_at || Date.now() - r.checked_at.getTime() > RECHECK_MS;
  if (!verifiedNow(r) && (opts.refresh || stale)) r = await refresh(orgId, r, opts.userId ?? null);
  return view(r);
}

/** The sub-account a new number goes on, only once its KYC passed. */
export async function verifiedSub(orgId: string): Promise<string | null> {
  const r = await rowOf(orgId);
  if (!r) return null;
  const fresh = verifiedNow(r) ? r : await refresh(orgId, r, null);
  return verifiedNow(fresh) ? fresh.sub_auth_id : null;
}

type Got = { ok: true; row: Row } | { ok: false; message: string };

/**
 * The client's sub-account, made the first time (its token sealed before
 * anything else is written). Vobiz fixes a sub-account's legal form when it
 * is made, so a client that chose another before it was verified gets a new
 * one, the old removed.
 */
async function ensureSub(orgId: string, userId: string, businessType: BusinessType, email: string): Promise<Got> {
  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.createSubAccount) return { ok: false, message: "Verifying a business isn't switched on yet." };
  let r = await rowOf(orgId);
  if (r && verifiedNow(r)) return { ok: false, message: "Your business is already verified." };
  if (r && r.business_type !== businessType) {
    await driver.deleteSubAccount?.(cfg, r.sub_auth_id).catch(() => undefined);
    await withTenant(orgId, (sql) => sql`DELETE FROM vobiz_subaccounts WHERE org_id = ${orgId} AND id = ${r!.id}`);
    r = null;
  }
  if (r) {
    if (r.email !== email) {
      await withTenant(orgId, (sql) => sql`UPDATE vobiz_subaccounts SET email = ${email} WHERE org_id = ${orgId} AND id = ${r!.id}`);
    }
    return { ok: true, row: { ...r, email } };
  }
  const [org] = await withTenant(orgId, (sql) => sql<{ display_name: string; legal_name: string | null }[]>`
    SELECT display_name, legal_name FROM orgs WHERE id = ${orgId}`);
  let made: { authId: string; authToken: string };
  try {
    made = await driver.createSubAccount(cfg, { name: org?.legal_name || org?.display_name || "Sales Desk client", email, businessType });
  } catch (e) {
    console.warn(`calling kyc: create failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, message: "We couldn't reach our phone provider. Try again in a minute." };
  }
  try {
    const row = await withTenant(orgId, async (sql) => {
      const [idRow] = await sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
      const sealed = await seal(orgId, vobizSubPurpose(idRow.id), made.authToken, sql);
      if (!sealed) throw new Error("no vault key");
      const [x] = await sql<Row[]>`
        INSERT INTO vobiz_subaccounts (id, org_id, sub_auth_id, secret, key_version, business_type, email, created_by)
        VALUES (${idRow.id}, ${orgId}, ${made.authId}, ${sealed.secret}, ${sealed.keyVersion}, ${businessType}, ${email}, ${userId})
        RETURNING ${sql.unsafe(COLS)}`;
      return x;
    });
    await audit({ orgId, actorUserId: userId, action: "calling.kyc_started", targetType: "org", targetId: orgId, metadata: { business_type: businessType } });
    return { ok: true, row };
  } catch (e) {
    console.warn(`calling kyc: sub-account ${made.authId} made but not saved: ${e instanceof Error ? e.message : String(e)}`);
    await driver.deleteSubAccount?.(cfg, made.authId).catch(() => undefined);
    return { ok: false, message: "We couldn't save your verification. Try again." };
  }
}

/**
 * Count one paid lookup against the day's allowance, before it is made.
 * False when the day's checks are used up.
 */
async function takeCheck(orgId: string, rowId: string, n: number): Promise<boolean> {
  const [r] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    UPDATE vobiz_subaccounts
    SET checks_today = CASE WHEN checks_day = (now() AT TIME ZONE 'Asia/Kolkata')::date THEN checks_today + ${n} ELSE ${n} END,
        checks_day = (now() AT TIME ZONE 'Asia/Kolkata')::date
    WHERE org_id = ${orgId} AND id = ${rowId}
      AND (checks_day IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kolkata')::date OR checks_today + ${n} <= ${KYC_CHECKS_PER_DAY})
    RETURNING id`);
  return !!r;
}

export type VerifyOutcome =
  | { ok: true; message: string; verified: boolean }
  | { ok: true; redirect: string }
  | { ok: false; message: string };

const DOC_WORDS = { pan: "PAN", gst: "GSTIN", cin: "CIN" } as const;

/**
 * Check the business on our own screen. A company's PAN and its GSTIN or
 * CIN go to Vobiz one after the other, the first refusal named; a person,
 * a proprietor or an HUF has its PAN checked and is then sent to DigiLocker
 * for Aadhaar, returning to `digilockerReturn`.
 */
export async function verifyBusiness(input: {
  orgId: string;
  userId: string;
  businessType: unknown;
  email: unknown;
  pan: unknown;
  gstin?: unknown;
  cin?: unknown;
  digilockerReturn: string;
}): Promise<VerifyOutcome> {
  const businessType = readBusinessType(input.businessType);
  if (!businessType) return { ok: false, message: "Choose how your business is registered." };
  const email = readKycEmail(input.email);
  if (!email) return { ok: false, message: "Enter an email for the verification." };
  const docs = readKycDocs(businessType, { pan: input.pan, gstin: input.gstin, cin: input.cin });
  if (!docs.ok) return docs;
  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.verifyDoc) return { ok: false, message: "Verifying a business isn't switched on yet." };

  const got = await ensureSub(input.orgId, input.userId, businessType, email);
  if (!got.ok) return got;
  const row = got.row;
  const aadhaar = needsAadhaar(businessType);
  if (!(await takeCheck(input.orgId, row.id, aadhaar ? 1 : docs.docs.gstin && docs.docs.cin ? 3 : 2))) {
    return { ok: false, message: "That's enough tries for today. Check the details and try again tomorrow." };
  }

  const check = async (doc: Parameters<NonNullable<typeof driver.verifyDoc>>[2]) => {
    try {
      return readDocResult(await driver.verifyDoc!(cfg, row.sub_auth_id, doc));
    } catch (e) {
      console.warn(`calling kyc: ${doc.kind} check failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const pan = await check({ kind: "pan", pan: docs.docs.pan });
  if (!pan) return { ok: false, message: "We couldn't reach our phone provider. Try again in a minute." };
  if (pan.status === "failed") return { ok: false, message: "That PAN could not be verified. Check it and try again." };

  if (aadhaar) {
    if (!driver.digilockerStart) return { ok: false, message: "Verifying a business isn't switched on yet." };
    const state = randomBytes(24).toString("hex");
    try {
      const d = await driver.digilockerStart(cfg, row.sub_auth_id, `${input.digilockerReturn}?state=${state}`, state);
      await withTenant(input.orgId, (sql) => sql`
        UPDATE vobiz_subaccounts SET digilocker_request = ${d.requestId}, digilocker_state = ${state}
        WHERE org_id = ${input.orgId} AND id = ${row.id}`);
      return { ok: true, redirect: d.url };
    } catch (e) {
      console.warn(`calling kyc: DigiLocker start failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, message: "We couldn't open DigiLocker. Try again in a minute." };
    }
  }

  // A company: its GSTIN, or its CIN under the name its PAN is registered to.
  const second = docs.docs.gstin
    ? await check({ kind: "gst", gstin: docs.docs.gstin })
    : await check({ kind: "cin", companyName: pan.name ?? "", cin: docs.docs.cin! });
  const which = docs.docs.gstin ? DOC_WORDS.gst : DOC_WORDS.cin;
  if (!second) return { ok: false, message: "We couldn't reach our phone provider. Try again in a minute." };
  if (second.status === "failed") return { ok: false, message: `That ${which} could not be verified. Check it and try again.` };
  const after = await refresh(input.orgId, row, input.userId);
  return verifiedNow(after)
    ? { ok: true, verified: true, message: "Your business is verified. You can get a number now." }
    : { ok: true, verified: false, message: "Your details are being checked. Numbers open as soon as it passes." };
}

/** Back from DigiLocker: finish the Aadhaar check the state names. */
export async function finishDigilocker(input: { orgId: string; userId: string; state: string }): Promise<{ ok: boolean; message: string }> {
  const r = await rowOf(input.orgId);
  if (!r || !r.digilocker_request || !r.digilocker_state || r.digilocker_state !== input.state) {
    return { ok: false, message: "That DigiLocker return is not one we started. Verify again." };
  }
  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.digilockerFinish) return { ok: false, message: "Verifying a business isn't switched on yet." };
  let result;
  try {
    result = readDocResult(await driver.digilockerFinish(cfg, r.sub_auth_id, r.digilocker_request));
  } catch (e) {
    console.warn(`calling kyc: DigiLocker finish failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, message: "We couldn't reach our phone provider. Try again in a minute." };
  }
  await withTenant(input.orgId, (sql) => sql`
    UPDATE vobiz_subaccounts SET digilocker_request = NULL, digilocker_state = NULL WHERE org_id = ${input.orgId} AND id = ${r.id}`);
  if (result.status === "failed") return { ok: false, message: "Aadhaar could not be verified through DigiLocker. Try again." };
  const after = await refresh(input.orgId, r, input.userId);
  return verifiedNow(after)
    ? { ok: true, message: "Your business is verified. You can get a number now." }
    : { ok: true, message: "Your details are being checked. Numbers open as soon as it passes." };
}

/**
 * The sub-account's own credentials, for the operator who adds its Sarvam
 * connection by hand (Sarvam publishes no API for it yet). Never on a
 * screen, never in an email.
 */
export async function subCredentials(orgId: string): Promise<{ authId: string; authToken: string } | null> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ id: string; sub_auth_id: string; secret: Buffer }[]>`
      SELECT id, sub_auth_id, secret FROM vobiz_subaccounts WHERE org_id = ${orgId}`;
    if (!r) return null;
    const token = await open(orgId, vobizSubPurpose(r.id), r.secret, sql);
    return token ? { authId: r.sub_auth_id, authToken: token } : null;
  });
}
