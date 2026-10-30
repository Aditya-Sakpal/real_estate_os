/**
 * The two gates that can be decided without touching the database.
 *
 * An invite is a row, not a link. The console is work-account SSO, so the
 * identity provider already proves who someone is; binding an invite to an
 * email address is stronger than binding it to a secret string that anyone
 * holding the link could redeem. There is no token, no redemption route, and
 * nothing to leak in a forwarded message.
 *
 * Kept database-free so `npm run check:logic` can exercise the delegation
 * rule directly. Gate 3, which asks whether this person already exists, lives
 * in `invite.ts` because only the database can answer it.
 */

import { isPublicEmailDomain, domainOf } from "./work-account.ts";
import { missingToGrant, scopeCovers } from "./rbac-rules.ts";
import { permissionWords } from "./permissions.ts";
import { FOUNDING_ROLE, scopeDepth, type ScopeKind } from "./roles.ts";

export type InviteRefusal =
  | "EMAIL_INVALID"
  | "ROLE_TOO_DEEP"
  | "OUTSIDE_YOUR_SCOPE"
  | "ONLY_ADMIN_GRANTS_ADMIN"
  | "NOT_YOURS_TO_GIVE"
  | "ADMIN_NEEDS_WORK_ACCOUNT";

export type GateResult =
  | { ok: true; warning: string | null }
  | { ok: false; code: InviteRefusal; message: string };

const OK: GateResult = { ok: true, warning: null };

/**
 * Deliberately loose. The identity provider is the real validator.
 *
 * One strictness it does add: nothing starting with `=`, `+`, `-` or `@`. The
 * address is stored and may be exported to a spreadsheet one day, where a
 * leading one of those is read as a formula. No real mailbox starts that way.
 */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  if (v.length < 6 || v.length > 254) return false;
  if (/\s/.test(v)) return false;
  if (/^[=+\-@]/.test(v)) return false;
  const at = v.indexOf("@");
  if (at < 1 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Gate 1: may you grant this
// ---------------------------------------------------------------------------

/**
 * The delegation rule, in four parts.
 *
 *   holder       you hold `member:invite` somewhere (checked by the guard
 *                before this runs)
 *   depth        the role is valid at the kind of node you are granting at
 *   containment  the target node sits at or below a node you hold it at
 *   subset       you hold every permission in the role, AT that node
 *
 * The fourth replaced rank ("only an admin grants admin"), which it contains:
 * the founding role carries the wildcard, and only the wildcard satisfies it.
 * What rank never caught is a regional head handing out phone numbers they
 * cannot see themselves.
 */
export function checkGrant(opts: {
  /** Paths where the inviter holds `member:invite`. */
  inviterScopes: readonly string[];
  /** Everything the inviter holds at the target node. */
  inviterHeld: ReadonlySet<string>;
  role: { key: string; label?: string; minKind: ScopeKind; permissions: readonly string[] };
  target: { path: string; kind: ScopeKind; name?: string };
}): GateResult {
  const { inviterScopes, inviterHeld, role, target } = opts;

  if (scopeDepth(role.minKind) > scopeDepth(target.kind)) {
    return {
      ok: false,
      code: "ROLE_TOO_DEEP",
      message: `That role belongs to a ${role.minKind.toLowerCase()}, and you are inviting at the ${target.kind.toLowerCase()} level.`,
    };
  }

  if (!inviterScopes.some((p) => scopeCovers(p, target.path))) {
    return {
      ok: false,
      code: "OUTSIDE_YOUR_SCOPE",
      message: "You can only add people within your own part of the organisation.",
    };
  }

  return subsetRefusal(inviterHeld, role, target) ?? OK;
}

/**
 * The subset half on its own, for every other place a role is handed out:
 * approving a join request, changing somebody's role, an import row.
 */
export function subsetRefusal(
  held: ReadonlySet<string>,
  role: { key: string; label?: string; permissions: readonly string[] },
  target: { kind: ScopeKind; name?: string },
): Extract<GateResult, { ok: false }> | null {
  const missing = missingToGrant(held, role.permissions);
  if (missing.length === 0) return null;

  if (missing.includes("*")) {
    return {
      ok: false,
      code: "ONLY_ADMIN_GRANTS_ADMIN",
      message: "Only an org admin can make someone else an org admin.",
    };
  }

  const where = target.kind === "ORG" || !target.name ? "" : ` on ${target.name}`;
  return {
    ok: false,
    code: "NOT_YOURS_TO_GIVE",
    message: `${role.label ?? "That role"} includes access you do not have${where}: ${permissionWords(missing)}.`,
  };
}

// ---------------------------------------------------------------------------
// Gate 2: what kind of address is this
// ---------------------------------------------------------------------------

export type AddressClass = "OWN_DOMAIN" | "PUBLIC_PROVIDER" | "FOREIGN_DOMAIN";

export function classifyAddress(
  email: string,
  orgPrimaryDomain: string | null,
): { class: AddressClass; domain: string } {
  const domain = domainOf(email);
  if (isPublicEmailDomain(domain)) return { class: "PUBLIC_PROVIDER", domain };

  const own = orgPrimaryDomain?.toLowerCase() ?? null;
  if (own && (domain === own || domain.endsWith("." + own))) {
    return { class: "OWN_DOMAIN", domain };
  }
  return { class: "FOREIGN_DOMAIN", domain };
}

/**
 * The identity bar moves to tenant creation.
 *
 * Work-account verification exists to stop junk tenants, to supply the dedupe
 * key, and to be the enterprise-legal signal. None of that applies to someone
 * an admin has already vouched for, so a personal address holding an invite
 * may sign in, while the same address holding none cannot found an org.
 *
 * The exception is the founding role. An admin invites, approves, and
 * eventually approves payouts, and there is no IT department to disable a
 * personal mailbox when that person leaves.
 */
export function checkAddress(opts: {
  email: string;
  orgPrimaryDomain: string | null;
  role: { key: string };
  /** A personal mailbox may hold the founding role (development only). */
  personalAdmin?: boolean;
}): GateResult {
  const { email, orgPrimaryDomain, role } = opts;

  if (!looksLikeEmail(email)) {
    return {
      ok: false,
      code: "EMAIL_INVALID",
      message: "That does not look like an email address.",
    };
  }

  const { class: kind, domain } = classifyAddress(email, orgPrimaryDomain);

  if (kind === "PUBLIC_PROVIDER") {
    if (role.key === FOUNDING_ROLE && !opts.personalAdmin) {
      return {
        ok: false,
        code: "ADMIN_NEEDS_WORK_ACCOUNT",
        message:
          "An org admin needs a company account. A personal mailbox cannot be disabled by your IT team when they leave.",
      };
    }
    return {
      ok: true,
      warning: `${domain} is a personal email provider. They will be able to sign in because you invited them, but you cannot revoke the mailbox itself.`,
    };
  }

  if (kind === "FOREIGN_DOMAIN") {
    return {
      ok: true,
      warning: `${domain} is not your company domain. If this is one person, a membership is right. If it is an agency or a call centre, empanel the company instead, so the contract carries an end date.`,
    };
  }

  return OK;
}

/**
 * The message an admin sends. It carries no secret, because there is nothing
 * to redeem: only that exact address at that exact provider can ever claim the
 * invite, so a forwarded message grants nobody anything.
 */
export function inviteMessage(opts: {
  orgName: string;
  roleLabel: string;
  /** The node, when it is not the organisation itself. */
  place?: string | null;
  inviterName: string | null;
  signInUrl: string;
}): string {
  const who = opts.inviterName ? `${opts.inviterName} has` : "You have been";
  const verb = opts.inviterName ? "added you to" : "added to";
  // A scoped role is most of the message. Somebody told they are Site Team
  // needs to know which tower before they know whether to turn up.
  const at = opts.place ? ` on ${opts.place}` : "";
  return [
    `${who} ${verb} ${opts.orgName} on Sales Desk as ${opts.roleLabel}${at}.`,
    "",
    `Sign in here: ${opts.signInUrl}`,
    "",
    "Use this same email address. There is no code to enter.",
  ].join("\n");
}
