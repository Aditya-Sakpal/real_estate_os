/**
 * The rules half of authorization: pure functions, no database, no React.
 *
 * Kept separate from `rbac.ts` so the decisions that matter can be exercised
 * directly by `npm run check:logic` without standing up Postgres. Scope
 * arithmetic and "you cannot grant what you do not hold" are exactly the kind
 * of logic that is cheap to test and expensive to get wrong.
 *
 * Imports here are relative on purpose: the logic checks load these modules
 * straight from source, where the `@/` alias does not resolve.
 */

import { ALL_PERMISSIONS, permissionWords, sanitisePermissions } from "./permissions.ts";
import {
  CUSTOM_ROLE_PREFIX,
  DEVELOPER_ROLES,
  FOUNDING_ROLE,
  scopeDepth,
  type RoleDef,
  type ScopeKind,
} from "./roles.ts";

// ---------------------------------------------------------------------------
// Role definitions: templates merged with what a tenant has changed
// ---------------------------------------------------------------------------

export type RoleSource = "TEMPLATE" | "OVERRIDE" | "CUSTOM";

export type ResolvedRole = {
  key: string;
  label: string;
  description: string;
  minKind: ScopeKind;
  /** Derived: holding `member:invite` IS the power to pass access on. */
  canDelegate: boolean;
  permissions: string[];
  source: RoleSource;
  /** The founding role is fixed. Everything else a tenant may retune. */
  editable: boolean;
  /** A shipped template this tenant has since edited. */
  customised: boolean;
  /** Live memberships holding it. A role in use cannot simply be deleted. */
  memberCount: number;
};

export type RoleRow = {
  key: string;
  label: string;
  description: string;
  min_kind: ScopeKind;
  can_delegate: boolean;
  source: "OVERRIDE" | "CUSTOM";
  permissions: string[];
};

/** One rule, one place: delegation is holding `member:invite`, nothing else. */
export function delegatesFrom(permissions: readonly string[]): boolean {
  return permissions.includes(ALL_PERMISSIONS) || permissions.includes("member:invite");
}

function fromTemplate(t: RoleDef): ResolvedRole {
  return {
    key: t.key,
    label: t.label,
    description: t.description,
    minKind: t.minKind,
    canDelegate: delegatesFrom(t.permissions),
    permissions: [...t.permissions],
    source: "TEMPLATE",
    editable: t.key !== FOUNDING_ROLE,
    customised: false,
    memberCount: 0,
  };
}

function fromRow(row: RoleRow): ResolvedRole {
  const permissions = sanitisePermissions(row.permissions ?? []);
  return {
    key: row.key,
    label: row.label,
    description: row.description,
    minKind: row.min_kind,
    canDelegate: delegatesFrom(permissions),
    permissions,
    source: row.source === "OVERRIDE" ? "OVERRIDE" : "CUSTOM",
    editable: true,
    customised: row.source === "OVERRIDE",
    memberCount: 0,
  };
}

export function mergeRoles(
  rows: RoleRow[],
  counts: Map<string, number> = new Map(),
): ResolvedRole[] {
  const byKey = new Map<string, ResolvedRole>();

  for (const t of DEVELOPER_ROLES) byKey.set(t.key, fromTemplate(t));

  for (const row of rows) {
    // A row keyed to the founding role cannot exist (the database rejects it),
    // so an override can never take its wildcard away. Belt and braces.
    if (row.key === FOUNDING_ROLE) continue;
    byKey.set(row.key, fromRow(row));
  }

  const all = [...byKey.values()];
  for (const r of all) r.memberCount = counts.get(r.key) ?? 0;

  // Shipped roles in catalog order, then whatever the tenant invented.
  const order = new Map(DEVELOPER_ROLES.map((t, i) => [t.key, i]));
  return all.sort((a, b) => {
    const ai = order.get(a.key) ?? 999;
    const bi = order.get(b.key) ?? 999;
    if (ai !== bi) return ai - bi;
    return a.label.localeCompare(b.label);
  });
}

// ---------------------------------------------------------------------------
// Scope arithmetic
// ---------------------------------------------------------------------------

/**
 * ltree containment, in JavaScript. `billbay.pune` covers `billbay.pune.trees`
 * and itself, but never `billbay.punekar`, which is why the dot matters.
 */
export function scopeCovers(grantPath: string, targetPath: string): boolean {
  return targetPath === grantPath || targetPath.startsWith(grantPath + ".");
}

/** Drops any path already covered by a shallower one in the same list. */
export function minimalScopes(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const p of sorted) {
    if (!kept.some((k) => scopeCovers(k, p))) kept.push(p);
  }
  return kept.sort();
}

// ---------------------------------------------------------------------------
// What one person may do, and where
// ---------------------------------------------------------------------------

export type Grant = {
  role: string;
  roleLabel: string;
  scopeNodeId: string;
  scopePath: string;
  scopeKind: ScopeKind;
  scopeName: string;
  permissions: ReadonlySet<string>;
};

export type Authz = {
  grants: Grant[];
  /** Union across every grant. Answers "ever", not "here". */
  permissions: ReadonlySet<string>;
  /** Holds the wildcard, i.e. the founding admin role. */
  isAdmin: boolean;
  roleKeys: string[];
  can: (permission: string) => boolean;
  canAt: (permission: string, scopePath: string) => boolean;
  /** ltree prefixes to filter a query by: `path <@ ANY($1)`. */
  scopesFor: (permission: string) => string[];
  /** Everything held AT one node, pooled across the grants that cover it. */
  heldAt: (scopePath: string) => ReadonlySet<string>;
  /**
   * A phone session only: whether a fresh code for this one action would
   * open it here. Absent for every other session, where `canAt` is the answer.
   */
  stepUpAt?: (permission: string, scopePath?: string) => boolean;
};

/**
 * The permissions one person holds at a node: every grant whose subtree
 * covers it, pooled. A Sales Head for Pune and a Closing Manager on Tower C
 * holds both sets on Tower C and only the first on Tower D.
 */
export function heldAtPath(grants: readonly Grant[], scopePath: string): ReadonlySet<string> {
  const held = new Set<string>();
  for (const g of grants) {
    if (!scopeCovers(g.scopePath, scopePath)) continue;
    for (const p of g.permissions) held.add(p);
  }
  return held;
}

/**
 * What a role can do that the person handing it out cannot, at that node.
 *
 * Empty means they may give it. This is the whole delegation rule: you pass
 * on only what you hold, where you hold it. Holding a permission over Pune
 * says nothing about Bengaluru, which is why the set is taken at the node and
 * not across the whole organisation.
 *
 * The founding role's wildcard is only ever satisfied by the wildcard. No
 * list of keys adds up to `*`, because `*` also means every key added in a
 * later release.
 */
export function missingToGrant(held: ReadonlySet<string>, rolePermissions: readonly string[]): string[] {
  if (held.has(ALL_PERMISSIONS)) return [];
  if (rolePermissions.includes(ALL_PERMISSIONS)) return [ALL_PERMISSIONS];
  return [...new Set(rolePermissions)].filter((p) => !held.has(p));
}

/** The organisation's own node: the first label of any path in it. */
export function rootOf(scopePath: string): string {
  const dot = scopePath.indexOf(".");
  return dot < 0 ? scopePath : scopePath.slice(0, dot);
}

export function buildAuthz(grants: Grant[]): Authz {
  const union = new Set<string>();
  for (const g of grants) for (const p of g.permissions) union.add(p);

  const isAdmin = union.has(ALL_PERMISSIONS);

  const holds = (g: Grant, permission: string) =>
    g.permissions.has(ALL_PERMISSIONS) || g.permissions.has(permission);

  return {
    grants,
    permissions: union,
    isAdmin,
    roleKeys: [...new Set(grants.map((g) => g.role))],
    can: (permission) => isAdmin || union.has(permission),
    canAt: (permission, scopePath) =>
      grants.some((g) => holds(g, permission) && scopeCovers(g.scopePath, scopePath)),
    scopesFor: (permission) =>
      minimalScopes(grants.filter((g) => holds(g, permission)).map((g) => g.scopePath)),
    heldAt: (scopePath) => heldAtPath(grants, scopePath),
  };
}

/** An authz with nothing in it, for a viewer with no live membership. */
export const NO_ACCESS: Authz = buildAuthz([]);

// ---------------------------------------------------------------------------
// Writing a role
// ---------------------------------------------------------------------------

export type RoleInput = {
  label: string;
  description: string;
  minKind: ScopeKind;
  canDelegate: boolean;
  permissions: string[];
};

export type RoleInputResult =
  | { ok: true; value: RoleInput }
  | { ok: false; error: string };

const KINDS: ScopeKind[] = ["ORG", "ENTITY", "REGION", "PROJECT", "PHASE"];

/**
 * `granter` is what the editor holds at the organisation's root. A role's
 * definition applies wherever it is held, so holding a permission over one
 * region is not enough to add it to a role somebody holds company-wide.
 *
 * Two halves. You cannot add what you do not hold, and you cannot rewrite a
 * role that already carries something you do not hold (`was`, its current
 * permissions), because narrowing the role above you is as much a grab as
 * widening your own.
 */
export function validateRoleInput(
  raw: {
    label?: unknown;
    description?: unknown;
    minKind?: unknown;
    permissions?: unknown;
  },
  granter: ReadonlySet<string>,
  was: readonly string[] = [],
): RoleInputResult {
  const label = String(raw.label ?? "").trim().replace(/\s+/g, " ");
  if (label.length < 2) return { ok: false, error: "Give the role a name." };
  if (label.length > 60) return { ok: false, error: "Keep the name under 60 characters." };

  const description = String(raw.description ?? "").trim().slice(0, 200);

  const minKind = String(raw.minKind ?? "ORG") as ScopeKind;
  if (!KINDS.includes(minKind)) return { ok: false, error: "Pick a level for the role." };

  const requested = Array.isArray(raw.permissions) ? raw.permissions.map((p) => String(p)) : [];
  const permissions = sanitisePermissions(requested);

  const above = missingToGrant(granter, was);
  if (above.length) {
    return {
      ok: false,
      error: `This role includes access you do not have: ${permissionWords(above)}.`,
    };
  }

  const overreach = missingToGrant(granter, permissions);
  if (overreach.length) {
    return {
      ok: false,
      error: `You cannot give access you do not have yourself: ${permissionWords(overreach)}.`,
    };
  }

  // Not read from the form. Delegation is not a separate switch an admin can
  // set out of step with the permission that actually grants it.
  const canDelegate = delegatesFrom(permissions);

  return { ok: true, value: { label, description, minKind, canDelegate, permissions } };
}

/**
 * A stable key for an invented role, derived from its name so the audit log
 * and the memberships table stay readable. Collisions take a numeric suffix
 * rather than a random one, because `C_REGIONAL_HEAD_2` reads as what it is.
 */
export function customRoleKey(label: string, taken: ReadonlySet<string>): string {
  // A name that already starts with the prefix ("C_QA2", "c qa2") is not
  // given it twice: C_C_QA2 reads as a typo in every audit row that names it.
  // Stripped after normalising, so "C Suite" and "C_Suite" both land on
  // C_SUITE, the key either would have had anyway.
  const base =
    label
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(new RegExp(`^(${CUSTOM_ROLE_PREFIX})+`), "")
      .slice(0, 40) || "ROLE";

  let key = CUSTOM_ROLE_PREFIX + base;
  let n = 2;
  while (taken.has(key)) {
    key = `${CUSTOM_ROLE_PREFIX}${base}_${n}`;
    n += 1;
  }
  return key;
}

/** True where the role may be granted at a node of this kind. */
export function roleFitsScope(role: { minKind: ScopeKind }, kind: ScopeKind): boolean {
  return scopeDepth(role.minKind) <= scopeDepth(kind);
}
