/**
 * Signing in with a phone and a code: the rules, with no database and no
 * network. Covered by `check:logic`.
 *
 * A phone session is a channel partner's person on a phone at a site. A
 * code on WhatsApp proves the phone, and nothing more: no identity provider
 * vouched for them, no company domain, no second factor. So a phone session
 * holds less than the same person signed in any other way. It holds the
 * in-session tier (the leads it may read, registering buyers, visits,
 * availability, its own payouts, the posts to share) and never the wildcard,
 * whatever role the person has in the firm. Two keys go further, and each
 * needs a fresh code bound to that one action on that one thing, used once.
 * Everything else is dropped, so a phone never reaches admin.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { ALL_PERMISSIONS } from "./permissions.ts";
import { buildAuthz, scopeCovers, type Authz, type Grant } from "./rbac-rules.ts";

/** How a session was started. Carried on the token, read on every request. */
export type SignInMethod = "oauth" | "sso" | "phone";

export const readMethod = (raw: unknown): SignInMethod => (raw === "phone" || raw === "sso" ? raw : "oauth");

/** Phone sign-in is for channel partners' people only (decision 8). */
export const PHONE_ORG_TYPES: readonly string[] = ["CHANNEL_PARTNER"];

/**
 * The most a phone session may do. Leads read, buyers registered with a
 * developer, visits seen and booked, what is left to sell, the firm's own
 * payouts, and the approved posts and pictures to share.
 */
export const PHONE_TIER: readonly string[] = [
  "lead:read",
  "visit:read",
  "visit:schedule",
  "inventory:read",
  "unit:read",
  "project:read",
  "partner:read",
  "partner:register",
  "payout:read",
  "campaign:read",
  "asset:read",
  "brand:read",
];

/** Keys a phone session reaches only with a fresh code for that one action. */
export const STEP_UP_KEYS: readonly string[] = ["lead.phone:unmask", "lead:export"];

/**
 * The people the partner bot makes (`CP_OWNER` for the principal,
 * `CP_AGENT` for everyone else) hold no role a console knows. What each
 * holds on a phone, before the tier trims it: the principal sees the firm's
 * money and may export, an agent neither.
 */
export const PHONE_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  CP_OWNER: [...PHONE_TIER, ...STEP_UP_KEYS],
  CP_AGENT: [...PHONE_TIER.filter((p) => p !== "payout:read"), "lead.phone:unmask"],
};

/** A phone session's grant is named apart from the role it came from. */
export const PHONE_ROLE_PREFIX = "phone:";

/** One live membership, and what its role holds (null when the role is not one the console knows). */
export type PhoneMembership = Omit<Grant, "permissions"> & { rolePermissions: ReadonlySet<string> | null };

/**
 * A phone session's grants: every membership cut to the tier, and apart,
 * what each membership would reach with a code. The wildcard becomes the
 * tier (and the step-up keys behind a code), never itself.
 */
export function phoneGrants(ms: readonly PhoneMembership[]): { grants: Grant[]; stepUp: Grant[] } {
  const grants: Grant[] = [];
  const stepUp: Grant[] = [];
  for (const m of ms) {
    const { rolePermissions, ...rest } = m;
    // Never the role itself: a tenant's masking policy that opens numbers to
    // a role, and every check that asks whether somebody is the founding
    // admin, must not read a phone session as that role.
    const place = { ...rest, role: `${PHONE_ROLE_PREFIX}${m.role}` };
    const base: ReadonlySet<string> = rolePermissions ?? new Set(PHONE_ROLE_PERMISSIONS[m.role] ?? []);
    const all = base.has(ALL_PERMISSIONS);
    const tier = new Set(PHONE_TIER.filter((p) => all || base.has(p)));
    const up = new Set(STEP_UP_KEYS.filter((p) => all || base.has(p)));
    if (tier.size) grants.push({ ...place, permissions: tier });
    if (up.size) stepUp.push({ ...place, permissions: up });
  }
  return { grants, stepUp };
}

/** The grants for one action after its code came back: the session's, plus that one key where a membership reaches it. */
export function withStepUp(grants: readonly Grant[], stepUp: readonly Grant[], permission: string): Grant[] {
  if (!STEP_UP_KEYS.includes(permission)) return [...grants];
  const extra = stepUp
    .filter((g) => g.permissions.has(permission))
    .map((g) => ({ ...g, permissions: new Set([permission]) }));
  return [...grants, ...extra];
}

/** Whether a membership would reach `permission` at `path` with a code. */
export function stepUpCovers(stepUp: readonly Grant[], permission: string, path?: string): boolean {
  return stepUp.some((g) => g.permissions.has(permission) && (path === undefined || scopeCovers(g.scopePath, path)));
}

/** A phone session's authz: the tier, and a way to ask what a code would open. */
export function phoneAuthz(ms: readonly PhoneMembership[]): { authz: Authz; stepUp: Grant[] } {
  const { grants, stepUp } = phoneGrants(ms);
  const authz = buildAuthz(grants);
  return { authz: { ...authz, stepUpAt: (p, path) => stepUpCovers(stepUp, p, path) }, stepUp };
}

/**
 * Whether a phone session may work in this org at all. Only a channel
 * partner's own console; never a developer's, and never through a mandate.
 */
export function phoneMayUse(orgType: string, via: unknown): boolean {
  return PHONE_ORG_TYPES.includes(orgType) && !via;
}

/** A person's row as sign-in reads it, one per membership. */
export type PhoneCandidate = {
  userId: string;
  erased: boolean;
  phoneVerified: boolean;
  membershipStatus: string;
  orgId: string;
  orgType: string;
  orgStatus: string;
};

/**
 * The firm a proved phone signs into, or null. A live membership in a
 * channel partner that is not suspended (a firm a developer added and nobody
 * has claimed yet is PENDING_VERIFICATION, and its people work all the same),
 * on a row whose number was proved and whose owner was not erased.
 */
export function phoneSignInOrg(rows: readonly PhoneCandidate[]): { userId: string; orgId: string } | null {
  const ok = rows.find(
    (r) =>
      !r.erased &&
      // A live membership on a proved number, or a firm's invite by phone,
      // which the code about to be sent is what proves.
      ((r.phoneVerified && r.membershipStatus === "ACTIVE") || r.membershipStatus === "INVITED") &&
      PHONE_ORG_TYPES.includes(r.orgType) &&
      (r.orgStatus === "ACTIVE" || r.orgStatus === "PENDING_VERIFICATION"),
  );
  return ok ? { userId: ok.userId, orgId: ok.orgId } : null;
}

/**
 * The one answer to "send me a code", whether or not the number may sign
 * in. A different answer for an unknown number would tell anybody typing
 * numbers which ones belong to a partner's people.
 */
export const SIGN_IN_SENT = "If this number can sign in, a code is on its way on WhatsApp.";

/** The one answer to a code that did not sign anybody in. */
export const SIGN_IN_REFUSED = "That code is not right. Check it, or ask for a new one.";

/** Every answer to "send me a code" takes at least this long, so a real send does not stand out by its time. */
export const SIGN_IN_FLOOR_MS = 1_200;

/** The action a step-up code is bound to, as stored on the challenge. */
export function stepUpAction(permission: string): string | null {
  return STEP_UP_KEYS.includes(permission) ? `step_up:${permission}` : null;
}

/** What a step-up asks for, in the person's words. */
export function stepUpWords(permission: string): string {
  return permission === "lead:export" ? "download these leads" : "see this whole number";
}
