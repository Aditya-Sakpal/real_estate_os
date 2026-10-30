import { cookies } from "next/headers";
import { controlDb, audit, auditHash } from "@/lib/db";
import { slugify } from "@/lib/scope";
import { validateGstin, validatePan, panMatchesGstin, normalise } from "@/lib/gstin";
import { isPublicEmailDomain } from "@/lib/work-account";
import { isNodeId } from "@/lib/scope-rules";
import { mandateContexts } from "@/lib/grant-access";

/**
 * Control-plane onboarding: resolving who a signed-in person is, and either
 * creating the org they found or routing them into the one that already
 * exists. Everything here runs on the owner connection by necessity -- a user
 * with no membership has no tenant context for RLS to scope to.
 */

export type OrgState =
  | {
      kind: "MEMBER";
      orgId: string;
      orgName: string;
      role: string;
      /** DEVELOPER works in the console; a mandate firm or a channel partner in its workspace. */
      orgType: string;
      /**
       * Set when the person is working a developer's projects through their
       * firm's live mandate: `orgId` is then the developer's, and nothing of
       * theirs is a membership there.
       */
      via?: { firmOrgId: string; firmName: string };
    }
  | { kind: "PENDING_JOIN"; orgId: string; orgName: string }
  | { kind: "NO_ORG" };

/** Cookie holding the org the viewer last switched to. */
export const ACTIVE_ORG_COOKIE = "salesdesk.org";

/**
 * Cookie holding the kind of company a person said they are signing up as,
 * chosen on the sign-in page before the identity provider. Set for half an
 * hour; it chooses a form, and for a channel partner it lets a personal
 * Google account through to found the firm. It authorises nothing else.
 */
export const SIGNUP_AS_COOKIE = "salesdesk.signup_as";

export { homeFor } from "./mandate-rules.ts";

export type OrgOption = {
  id: string;
  displayName: string;
  legalName: string;
  type: string;
  role: string;
  /** The firm whose mandate reaches this developer, when it is not a membership. */
  via?: string;
};

/**
 * Every org this person can act in. A user is global and memberships are
 * per-org, so holding several is normal: a CP firm's principal who is also on
 * a developer's pre-sales bench has two, and a group with multiple SPVs may
 * run more.
 */
export async function listUserOrgs(userId: string): Promise<OrgOption[]> {
  const rows = await controlDb<
    {
      id: string;
      display_name: string;
      legal_name: string;
      type: string;
      role: string;
    }[]
  >`
    SELECT DISTINCT ON (o.id)
           o.id, o.display_name, o.legal_name, o.type, m.role
    FROM memberships m
    JOIN orgs o ON o.id = m.org_id
    WHERE m.user_id = ${userId}
      AND m.status = 'ACTIVE'
      AND o.status <> 'SUSPENDED'
    ORDER BY o.id, (m.role = 'ORG_ADMIN') DESC
  `;
  const own = rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    legalName: r.legal_name,
    type: r.type,
    role: r.role,
  }));
  // Developers reached through a firm's live mandate, beside the firm itself.
  const through = (await mandateContexts(userId))
    .filter((c) => !own.some((o) => o.id === c.devOrgId))
    .map((c) => ({ id: c.devOrgId, displayName: c.devName, legalName: c.devName, type: "DEVELOPER", role: "MANDATE_FIRM", via: c.firmName }));
  return [...own, ...through].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getUserOrgState(userId: string): Promise<OrgState> {
  // A switch is a preference, never an authorisation: the cookie only chooses
  // among orgs this user already holds a live membership in. An id for an org
  // they were removed from simply falls through to the default below.
  const jar = await cookies();
  const preferred = jar.get(ACTIVE_ORG_COOKIE)?.value;

  // A cookie that is not shaped like a uuid never reaches the query. Postgres
  // raises on a malformed uuid rather than matching nothing, and that error
  // comes back as a 500 on every console page at once, with the cookie that
  // caused it still set. Sign-out is on one of those pages.
  if (preferred && isNodeId(preferred)) {
    const [picked] = await controlDb<
      { org_id: string; display_name: string; role: string; type: string }[]
    >`
      SELECT m.org_id, o.display_name, m.role, o.type
      FROM memberships m
      JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ${userId}
        AND m.org_id = ${preferred}
        AND m.status = 'ACTIVE'
      ORDER BY (m.role = 'ORG_ADMIN') DESC
      LIMIT 1
    `;
    if (picked) {
      return {
        kind: "MEMBER",
        orgId: picked.org_id,
        orgName: picked.display_name,
        role: picked.role,
        orgType: picked.type,
      };
    }
    // A developer this person reaches through their firm's live mandate. The
    // cookie only chooses; the grant is what allows, and it is read again on
    // every request, so a mandate that ended at midnight is closed at 09:10.
    const through = (await mandateContexts(userId)).find((c) => c.devOrgId === preferred);
    if (through) {
      return {
        kind: "MEMBER",
        orgId: through.devOrgId,
        orgName: through.devName,
        role: "MANDATE_FIRM",
        orgType: "DEVELOPER",
        via: { firmOrgId: through.firmOrgId, firmName: through.firmName },
      };
    }
  }

  const [membership] = await controlDb<
    { org_id: string; display_name: string; role: string; type: string }[]
  >`
    SELECT m.org_id, o.display_name, m.role, o.type
    FROM memberships m
    JOIN orgs o ON o.id = m.org_id
    WHERE m.user_id = ${userId} AND m.status = 'ACTIVE'
    ORDER BY (m.role = 'ORG_ADMIN') DESC, m.created_at ASC
    LIMIT 1
  `;
  if (membership) {
    return {
      kind: "MEMBER",
      orgId: membership.org_id,
      orgName: membership.display_name,
      role: membership.role,
      orgType: membership.type,
    };
  }

  const [pending] = await controlDb<{ org_id: string; display_name: string }[]>`
    SELECT r.org_id, o.display_name
    FROM org_join_requests r
    JOIN orgs o ON o.id = r.org_id
    WHERE r.user_id = ${userId} AND r.status = 'PENDING'
    ORDER BY r.created_at DESC
    LIMIT 1
  `;
  if (pending) {
    return { kind: "PENDING_JOIN", orgId: pending.org_id, orgName: pending.display_name };
  }

  return { kind: "NO_ORG" };
}

export type SignupContext = {
  email: string;
  emailDomain: string;
  idpTenant: string | null;
};

/** Identity facts we need to dedupe against, straight from the verified sign-in. */
export async function getSignupContext(userId: string): Promise<SignupContext | null> {
  const [row] = await controlDb<
    { email: string; email_domain: string; idp_tenant: string | null }[]
  >`
    SELECT u.email, u.email_domain, i.idp_tenant
    FROM users u
    LEFT JOIN user_identities i ON i.user_id = u.id
    WHERE u.id = ${userId}
    ORDER BY i.created_at DESC
    LIMIT 1
  `;
  if (!row) return null;
  return {
    email: row.email,
    emailDomain: row.email_domain,
    idpTenant: row.idp_tenant,
  };
}

export type MatchReason = "GSTIN" | "PAN" | "IDP_TENANT" | "EMAIL_DOMAIN";

export type OrgMatch = {
  orgId: string;
  displayName: string;
  legalName: string;
  matchedOn: MatchReason;
};

/**
 * Find the org this person almost certainly belongs to, strongest signal
 * first. GSTIN is definitive; a shared corporate IdP tenant or email domain is
 * strong enough to route to a join request, because work-account-only sign-in
 * means those domains are corporate, not public.
 */
export async function findExistingOrg(input: {
  gstin?: string | null;
  pan?: string | null;
  idpTenant?: string | null;
  emailDomain?: string | null;
}): Promise<OrgMatch | null> {
  const probes: { reason: MatchReason; where: ReturnType<typeof controlDb> }[] = [];

  if (input.gstin) {
    probes.push({ reason: "GSTIN", where: controlDb`gstin = ${normalise(input.gstin)}` });
  }
  if (input.pan) {
    probes.push({ reason: "PAN", where: controlDb`pan = ${normalise(input.pan)}` });
  }
  // A consumer domain identifies a person, not a company. Matching on it would
  // route every Gmail signup into whichever org a Gmail user created first.
  if (input.idpTenant && !isPublicEmailDomain(input.idpTenant)) {
    probes.push({ reason: "IDP_TENANT", where: controlDb`idp_tenant = ${input.idpTenant}` });
  }
  if (input.emailDomain && !isPublicEmailDomain(input.emailDomain)) {
    probes.push({
      reason: "EMAIL_DOMAIN",
      where: controlDb`primary_domain = ${input.emailDomain}`,
    });
  }

  for (const probe of probes) {
    const [row] = await controlDb<
      { id: string; display_name: string; legal_name: string }[]
    >`
      SELECT id, display_name, legal_name
      FROM orgs
      WHERE ${probe.where} AND status <> 'SUSPENDED'
        -- A partner firm another tenant typed in has proved nothing about who
        -- it is, so it never stops the real company signing up.
        AND NOT (type = 'CHANNEL_PARTNER' AND status = 'PENDING_VERIFICATION')
      LIMIT 1
    `;
    if (row) {
      return {
        orgId: row.id,
        displayName: row.display_name,
        legalName: row.legal_name,
        matchedOn: probe.reason,
      };
    }
  }
  return null;
}

/** Root ltree labels are globally unique, so a second "godrej" needs a suffix. */
async function reserveRootSlug(base: string): Promise<string> {
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}_${n + 1}`;
    const [clash] = await controlDb`
      SELECT 1 FROM scope_nodes WHERE path = ${candidate}::ltree LIMIT 1
    `;
    if (!clash) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

export type CreateOrgInput = {
  userId: string;
  legalName: string;
  displayName: string;
  gstin: string | null;
  pan: string;
  emailDomain: string;
  idpTenant: string;
  /**
   * Set when the person deliberately chose "create a new organisation" while
   * already inside one. GSTIN and PAN still dedupe -- those are legal identity
   * and must stay unique -- but the domain and IdP-tenant probes are skipped,
   * because those exist to catch someone who meant to JOIN, which is not what
   * this is.
   */
  allowAdditional?: boolean;
};

export type CreateOrgResult =
  | { ok: true; orgId: string; rootNodeId: string }
  | { ok: false; error: string; existing?: OrgMatch };

export async function createDeveloperOrg(
  input: CreateOrgInput,
): Promise<CreateOrgResult> {
  // --- validate identifiers -------------------------------------------------
  let gstin: string | null = null;
  let pan: string;

  if (input.gstin) {
    const g = validateGstin(input.gstin);
    if (!g.ok) return { ok: false, error: g.error };
    gstin = g.gstin;
    pan = g.pan;

    const p = validatePan(input.pan);
    if (!p.ok) return { ok: false, error: p.error };
    if (!panMatchesGstin(p.pan, g.gstin)) {
      return {
        ok: false,
        error: "PAN does not match the PAN embedded in that GSTIN.",
      };
    }
  } else {
    const p = validatePan(input.pan);
    if (!p.ok) return { ok: false, error: p.error };
    pan = p.pan;
  }

  // --- dedupe, now that GSTIN/PAN are known --------------------------------
  const existing = await findExistingOrg({
    gstin,
    pan,
    idpTenant: input.allowAdditional ? null : input.idpTenant,
    emailDomain: input.allowAdditional ? null : input.emailDomain,
  });
  if (existing) {
    return {
      ok: false,
      error: `${existing.displayName} is already on Sales Desk.`,
      existing,
    };
  }

  const rootSlug = await reserveRootSlug(slugify(input.displayName || input.legalName));

  // Never persist a consumer domain as the org's identity -- it would make
  // "gmail.com" this org's primary_domain and capture later Gmail signups.
  // Only reachable with AUTH_ALLOW_PERSONAL_ACCOUNTS on; null in production.
  const publicDomain = isPublicEmailDomain(input.emailDomain);
  const primaryDomain = publicDomain ? null : input.emailDomain;
  const idpTenant = publicDomain || isPublicEmailDomain(input.idpTenant)
    ? null
    : input.idpTenant;

  // --- create org + root scope node + founding admin, atomically -----------
  try {
    const result = await controlDb.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`
        INSERT INTO orgs (type, legal_name, display_name, gstin, pan,
                          primary_domain, idp_tenant, created_by)
        VALUES ('DEVELOPER', ${input.legalName}, ${input.displayName}, ${gstin},
                ${pan}, ${primaryDomain}, ${idpTenant}, ${input.userId})
        RETURNING id
      `;

      const [root] = await tx<{ id: string }[]>`
        INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
        VALUES (${org.id}, NULL, 'ORG', ${input.displayName}, ${rootSlug},
                ${rootSlug}::ltree)
        RETURNING id
      `;

      await tx`
        INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
        VALUES (${input.userId}, ${org.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE', now())
      `;

      return { orgId: org.id, rootNodeId: root.id };
    });

    await audit({
      orgId: result.orgId,
      actorUserId: input.userId,
      action: "org.created",
      targetType: "org",
      targetId: result.orgId,
      metadata: {
        type: "DEVELOPER",
        legal_name: input.legalName,
        // Hashed, not stored. A sole proprietor's GSTIN embeds their personal
        // PAN, and this row outlives any erasure request. The org's own record
        // holds the real values and can be deleted; the log only needs to be
        // able to say whether a later claim matches this one.
        gstin_sha256: auditHash(gstin),
        pan_sha256: auditHash(pan),
        has_gstin: gstin !== null,
        primary_domain: primaryDomain,
        idp_tenant: idpTenant,
        root_path: rootSlug,
      },
    });

    return { ok: true, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("orgs_gstin_key")) {
      return { ok: false, error: "That GSTIN is already registered on Sales Desk." };
    }
    return { ok: false, error: "Could not create the organisation. Please try again." };
  }
}

export async function requestToJoin(
  userId: string,
  match: OrgMatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await controlDb`
      INSERT INTO org_join_requests (org_id, user_id, matched_on)
      VALUES (${match.orgId}, ${userId}, ${match.matchedOn})
      ON CONFLICT DO NOTHING
    `;
    await audit({
      orgId: match.orgId,
      actorUserId: userId,
      action: "org.join_requested",
      targetType: "org",
      targetId: match.orgId,
      metadata: { matched_on: match.matchedOn },
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not raise the join request." };
  }
}
