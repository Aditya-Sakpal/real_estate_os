import { audit, auditHash, controlDb } from "./db/index.ts";
import { slugify } from "./scope.ts";
import { normalise, panMatchesGstin, validateGstin, validatePan } from "./gstin.ts";
import { isPublicEmailDomain, personalAccountsAllowed } from "./work-account.ts";
import { normalisePhone } from "./calling-rules.ts";
import { startChallenge, verifyChallenge, codesSkipped } from "./otp.ts";
import { phoneHash } from "./otp-rules.ts";
import { attachInvites } from "./mandates.ts";
import { isAgentNo } from "./mandate-rules.ts";

/**
 * Signing up as a mandate firm or a channel partner: control plane, like
 * every org's creation, because the person has no tenant yet.
 *
 * Three rules.
 *
 * 1. **A mandate firm signs up with its company account**, like a developer:
 *    it holds other companies' projects and buyers, and a personal mailbox is
 *    nobody's to switch off when that person leaves. Offers waiting for its
 *    PAN (a developer invited it) become its own the moment it exists.
 * 2. **A channel partner may use any Google account**, because most broker
 *    firms have no company domain, and proves its phone with a code instead.
 *    That phone becomes the firm's own number.
 * 3. **A firm a developer already added is claimed, never duplicated**, and
 *    only with a code sent to a number a developer recorded for that firm.
 *    Claiming it shows the firm its own registrations at every developer, so
 *    typing a PAN proves nothing on its own.
 */

export type FirmKind = "MANDATE_FIRM" | "CHANNEL_PARTNER";

export type FirmValues = {
  legalName: string;
  displayName: string;
  gstin: string | null;
  pan: string;
  reraNo: string;
  reraTill: string | null;
  city: string | null;
  /** E.164. Required for a channel partner. */
  phone: string | null;
};

export type ExistingOrg = {
  orgId: string;
  displayName: string;
  matchedOn: "GSTIN" | "PAN" | "IDP_TENANT" | "EMAIL_DOMAIN";
  /** What kind of company it is, so the screen can say "a developer" rather than leave it to be guessed. */
  type: string;
};

/**
 * A company already here, said the way the form needs it: a PAN or GSTIN
 * that belongs to another company is a problem with that field, so it is
 * named on the field, not only in a banner that reads like a dead end.
 */
function matchRefusal(existing: ExistingOrg): { ok: false; error: string; existing: ExistingOrg; errors?: Record<string, string> } {
  const kind = existing.type === "MANDATE_FIRM" ? "a mandate firm" : existing.type === "CHANNEL_PARTNER" ? "a channel partner" : "a developer";
  // A GSTIN carries its PAN (the form refuses one that does not), so a GSTIN
  // match is the PAN's too.
  if (existing.matchedOn === "GSTIN") {
    const taken = `Registered to ${existing.displayName}. Check the number.`;
    return { ok: false, error: `This PAN and GSTIN are already registered to ${existing.displayName}, ${kind} on Sales Desk.`, existing, errors: { pan: taken, gstin: taken } };
  }
  if (existing.matchedOn === "PAN") {
    return { ok: false, error: `This PAN is already registered to ${existing.displayName}, ${kind} on Sales Desk.`, existing, errors: { pan: `Registered to ${existing.displayName}. Check the number.` } };
  }
  return { ok: false, error: `${existing.displayName} is already on Sales Desk.`, existing };
}

/** Read the sign-up form, normalised, or every problem keyed by field. */
export function readFirmValues(
  kind: FirmKind,
  raw: Record<string, string>,
  today: string,
): { ok: true; values: FirmValues } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const legalName = (raw.legalName ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
  if (!legalName) errors.legalName = "Enter the registered name.";
  const displayName = ((raw.displayName ?? "").trim() || legalName).replace(/\s+/g, " ").slice(0, 120);
  const pan = validatePan(raw.pan ?? "");
  if (!pan.ok) errors.pan = pan.error;
  let gstin: string | null = null;
  if ((raw.gstin ?? "").trim()) {
    const g = validateGstin(raw.gstin);
    if (!g.ok) errors.gstin = g.error;
    else if (pan.ok && !panMatchesGstin(pan.pan, g.gstin)) errors.gstin = "This GSTIN carries a different PAN.";
    else gstin = g.gstin;
  }
  const reraNo = (raw.reraNo ?? "").trim().toUpperCase();
  if (!isAgentNo(reraNo)) errors.reraNo = "Enter the MahaRERA agent number, A and 11 digits.";
  const reraTill = (raw.reraTill ?? "").trim() || null;
  if (reraTill && (!/^\d{4}-\d{2}-\d{2}$/.test(reraTill) || reraTill < today)) errors.reraTill = "That registration has lapsed.";
  const city = (raw.city ?? "").trim().slice(0, 80) || null;
  const phone = (raw.phone ?? "").trim() ? normalisePhone(raw.phone) : null;
  if ((raw.phone ?? "").trim() && !phone) errors.phone = "Use 10 digits, or add the country code.";
  if (kind === "CHANNEL_PARTNER" && !phone && !errors.phone) errors.phone = "Enter the firm's WhatsApp number.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, values: { legalName, displayName, gstin, pan: pan.ok ? pan.pan : "", reraNo, reraTill, city, phone } };
}

/** A live company already here with this GSTIN, PAN, directory or domain. */
async function activeMatch(o: { gstin: string | null; pan: string; emailDomain: string | null; idpTenant: string | null }): Promise<ExistingOrg | null> {
  const probes: [ExistingOrg["matchedOn"], string | null, string][] = [
    ["GSTIN", o.gstin, "gstin"],
    ["PAN", o.pan, "pan"],
    ["IDP_TENANT", o.idpTenant && !isPublicEmailDomain(o.idpTenant) ? o.idpTenant : null, "idp_tenant"],
    ["EMAIL_DOMAIN", o.emailDomain && !isPublicEmailDomain(o.emailDomain) ? o.emailDomain : null, "primary_domain"],
  ];
  for (const [matchedOn, value, column] of probes) {
    if (!value) continue;
    const [row] = await controlDb<{ id: string; display_name: string; type: string }[]>`
      SELECT id, display_name, type FROM orgs
      WHERE ${controlDb(column)} = ${column === "gstin" || column === "pan" ? normalise(value) : value}
        AND status <> 'SUSPENDED'
        AND NOT (type = 'CHANNEL_PARTNER' AND status = 'PENDING_VERIFICATION')
      LIMIT 1`;
    if (row) return { orgId: row.id, displayName: row.display_name, matchedOn, type: row.type };
  }
  return null;
}

async function reserveRootSlug(base: string): Promise<string> {
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}_${n + 1}`;
    const [clash] = await controlDb`SELECT 1 FROM scope_nodes WHERE path = ${candidate}::ltree LIMIT 1`;
    if (!clash) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// A mandate firm
// ---------------------------------------------------------------------------

export type CreateResult = { ok: true; orgId: string; note?: string } | { ok: false; error: string; existing?: ExistingOrg; errors?: Record<string, string> };

export async function createMandateFirm(o: {
  userId: string;
  values: FirmValues;
  emailDomain: string;
  idpTenant: string | null;
  /** Deliberately a second company, from inside another: skip the domain probes. */
  allowAdditional?: boolean;
}): Promise<CreateResult> {
  const v = o.values;
  if (isPublicEmailDomain(o.emailDomain) && !personalAccountsAllowed()) {
    return { ok: false, error: "A mandate firm signs up with its company Google Workspace or Microsoft account." };
  }
  const existing = await activeMatch({
    gstin: v.gstin,
    pan: v.pan,
    emailDomain: o.allowAdditional ? null : o.emailDomain,
    idpTenant: o.allowAdditional ? null : o.idpTenant,
  });
  if (existing) return matchRefusal(existing);
  const slug = await reserveRootSlug(slugify(v.displayName) || "firm");
  try {
    const made = await controlDb.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`
        INSERT INTO orgs (type, legal_name, display_name, gstin, pan, primary_domain, idp_tenant, created_by)
        VALUES ('MANDATE_FIRM', ${v.legalName}, ${v.displayName}, ${v.gstin}, ${v.pan}, ${o.emailDomain},
                ${o.idpTenant && !isPublicEmailDomain(o.idpTenant) ? o.idpTenant : null}, ${o.userId})
        RETURNING id`;
      const [root] = await tx<{ id: string }[]>`
        INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
        VALUES (${org.id}, NULL, 'ORG', ${v.displayName}, ${slug}, ${slug}::ltree) RETURNING id`;
      await tx`
        INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
        VALUES (${o.userId}, ${org.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE', now())`;
      await tx`
        INSERT INTO firm_profiles (org_id, rera_agent_no, rera_valid_till, city, phone)
        VALUES (${org.id}, ${v.reraNo}, ${v.reraTill}, ${v.city}, ${v.phone})`;
      const attached = await attachInvites(tx, org.id, v.pan);
      return { orgId: org.id, attached };
    });
    await audit({
      orgId: made.orgId,
      actorUserId: o.userId,
      action: "org.created",
      targetType: "org",
      targetId: made.orgId,
      metadata: { type: "MANDATE_FIRM", pan_sha256: auditHash(v.pan), gstin_sha256: auditHash(v.gstin), has_gstin: !!v.gstin, offers: made.attached, root_path: slug },
    });
    return { ok: true, orgId: made.orgId, note: made.attached ? `${made.attached} ${made.attached === 1 ? "offer is" : "offers are"} waiting for you.` : undefined };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("orgs_gstin_key")) return { ok: false, error: "That GSTIN is already registered on Sales Desk." };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// A channel partner, with a code to its phone
// ---------------------------------------------------------------------------

/** A firm a developer added and nobody has claimed, and the numbers developers recorded for it. */
async function unclaimed(pan: string): Promise<{ orgId: string; phones: string[] } | null> {
  const [org] = await controlDb<{ id: string }[]>`
    SELECT id FROM orgs WHERE pan = ${pan} AND type = 'CHANNEL_PARTNER' AND status = 'PENDING_VERIFICATION'
    ORDER BY created_at LIMIT 1`;
  if (!org) return null;
  const phones = await controlDb<{ phone: string }[]>`
    SELECT principal_phone AS phone FROM partner_firms WHERE cp_org_id = ${org.id} AND principal_phone IS NOT NULL
    UNION
    SELECT phone FROM partner_agents WHERE cp_org_id = ${org.id} AND status <> 'REMOVED'`;
  return { orgId: org.id, phones: phones.map((p) => p.phone) };
}

export type PartnerPlan =
  | { ok: true; claimOrgId: string | null }
  | { ok: false; error: string; existing?: ExistingOrg; errors?: Record<string, string> };

/** Whether this sign-up creates a firm or claims one, and whether its number may prove it. */
async function planPartner(o: { values: FirmValues; emailDomain: string; idpTenant: string | null; allowAdditional?: boolean }): Promise<PartnerPlan> {
  const v = o.values;
  const existing = await activeMatch({
    gstin: v.gstin,
    pan: v.pan,
    emailDomain: o.allowAdditional ? null : o.emailDomain,
    idpTenant: o.allowAdditional ? null : o.idpTenant,
  });
  if (existing) return matchRefusal(existing);
  const claim = await unclaimed(v.pan);
  if (!claim) return { ok: true, claimOrgId: null };
  if (!claim.phones.length) {
    return {
      ok: false,
      error: "A developer has already added your firm. Ask them to record your firm's number with it, then sign up again.",
      errors: { phone: "No number is on record for this firm yet." },
    };
  }
  if (!claim.phones.includes(v.phone!)) {
    return {
      ok: false,
      error: "A developer has already added your firm. Use the number they have on record for it.",
      errors: { phone: "Use the number a developer has for your firm." },
    };
  }
  return { ok: true, claimOrgId: claim.orgId };
}

export async function startPartnerSignup(o: {
  userId: string;
  values: FirmValues;
  emailDomain: string;
  idpTenant: string | null;
  allowAdditional?: boolean;
  ip?: string | null;
}): Promise<{ ok: true; challengeId: string; claiming: boolean; skipped?: boolean } | { ok: false; error: string; existing?: ExistingOrg; errors?: Record<string, string> }> {
  const plan = await planPartner(o);
  if (!plan.ok) return plan;
  // Development only: no code is sent, and the finish takes the number as given.
  if (codesSkipped()) return { ok: true, challengeId: "", claiming: !!plan.claimOrgId, skipped: true };
  const started = await startChallenge({ purpose: "VERIFY_PHONE", phone: o.values.phone!, userId: o.userId, ip: o.ip ?? null });
  if (!started.ok) return { ok: false, error: started.message };
  return { ok: true, challengeId: started.challengeId, claiming: !!plan.claimOrgId };
}

export async function finishPartnerSignup(o: {
  userId: string;
  values: FirmValues;
  emailDomain: string;
  idpTenant: string | null;
  allowAdditional?: boolean;
  challengeId: string;
  code: string;
}): Promise<CreateResult> {
  const v = o.values;
  const plan = await planPartner(o);
  if (!plan.ok) return plan;
  // The skip is decided here, never by the caller: off anywhere but a development machine.
  if (!codesSkipped()) {
    const verified = await verifyChallenge({ challengeId: o.challengeId, phone: v.phone!, code: o.code, purpose: "VERIFY_PHONE", userId: o.userId });
    if (!verified.ok) return { ok: false, error: verified.message, errors: { code: verified.message } };
  }

  const orgId = await controlDb.begin(async (tx) => {
    let id: string;
    if (plan.claimOrgId) {
      const [org] = await tx<{ id: string }[]>`
        UPDATE orgs SET status = 'ACTIVE', legal_name = ${v.legalName}, display_name = ${v.displayName}, gstin = ${v.gstin},
                        created_by = coalesce(created_by, ${o.userId})
        WHERE id = ${plan.claimOrgId} AND type = 'CHANNEL_PARTNER' AND status = 'PENDING_VERIFICATION'
        RETURNING id`;
      if (!org) throw new Error("CLAIMED_MEANWHILE");
      id = org.id;
      const [root] = await tx<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${id} AND kind = 'ORG' ORDER BY created_at LIMIT 1`;
      await tx`
        INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
        VALUES (${o.userId}, ${id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE', now())
        ON CONFLICT (user_id, scope_node_id, role) WHERE status <> 'REVOKED' DO NOTHING`;
    } else {
      const slug = await reserveRootSlug(`cp_${slugify(v.displayName) || "partner"}`);
      const [org] = await tx<{ id: string }[]>`
        INSERT INTO orgs (type, legal_name, display_name, gstin, pan, primary_domain, idp_tenant, created_by)
        VALUES ('CHANNEL_PARTNER', ${v.legalName}, ${v.displayName}, ${v.gstin}, ${v.pan},
                ${isPublicEmailDomain(o.emailDomain) ? null : o.emailDomain},
                ${o.idpTenant && !isPublicEmailDomain(o.idpTenant) ? o.idpTenant : null}, ${o.userId})
        RETURNING id`;
      id = org.id;
      const [root] = await tx<{ id: string }[]>`
        INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
        VALUES (${id}, NULL, 'ORG', ${v.displayName}, ${slug}, ${slug}::ltree) RETURNING id`;
      await tx`
        INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
        VALUES (${o.userId}, ${id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE', now())`;
    }
    await tx`
      INSERT INTO firm_profiles (org_id, rera_agent_no, rera_valid_till, city, phone)
      VALUES (${id}, ${v.reraNo}, ${v.reraTill}, ${v.city}, ${v.phone})
      ON CONFLICT (org_id) DO UPDATE SET rera_agent_no = EXCLUDED.rera_agent_no, rera_valid_till = EXCLUDED.rera_valid_till,
        city = EXCLUDED.city, phone = EXCLUDED.phone, updated_at = now()`;
    // The proved number becomes this person's own, unless it is already somebody's.
    await tx`
      UPDATE users SET phone = ${v.phone}, phone_verified_at = now()
      WHERE id = ${o.userId} AND phone IS NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.phone = ${v.phone} AND u.id <> ${o.userId})`;
    return id;
  }).catch((e) => {
    if (e instanceof Error && e.message === "CLAIMED_MEANWHILE") return null;
    if (e instanceof Error && e.message.includes("orgs_gstin_key")) return "GSTIN";
    throw e;
  });
  if (orgId === null) return { ok: false, error: "Somebody from your firm claimed it a moment ago. Ask them to add you." };
  if (orgId === "GSTIN") return { ok: false, error: "That GSTIN is already registered on Sales Desk.", errors: { gstin: "Already registered." } };
  await audit({
    orgId,
    actorUserId: o.userId,
    action: plan.claimOrgId ? "org.claimed" : "org.created",
    targetType: "org",
    targetId: orgId,
    metadata: { type: "CHANNEL_PARTNER", pan_sha256: auditHash(v.pan), gstin_sha256: auditHash(v.gstin), phone: phoneHash(v.phone!) },
  });
  return { ok: true, orgId };
}
