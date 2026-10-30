/**
 * Where a membership lands.
 *
 * A membership is always held AT a node, so an invite has to name one. These
 * are the parts of that choice a database cannot help with: which nodes an
 * inviter can reach, which roles are worth offering across them, and what a
 * person meant when they typed "Tower C" into a spreadsheet cell.
 *
 * Kept database-free so `npm run check:logic` exercises them directly. The
 * read that turns an id from a form into a node lives in `scope-nodes.ts`,
 * because only the database can say whether that id belongs to this tenant.
 *
 * Imports are relative for the same reason they are in `rbac-rules.ts`: the
 * logic checks load these modules straight from source, where `@/` does not
 * resolve.
 */

import { missingToGrant, roleFitsScope, scopeCovers } from "./rbac-rules.ts";
import { slugify } from "./scope.ts";
import type { ScopeKind } from "./roles.ts";

export type ScopeNode = {
  id: string;
  kind: ScopeKind;
  name: string;
  path: string;
};

/** How far below the root a node sits. `billbay.spv.pune` is 2. */
export function depthOf(path: string): number {
  return path.split(".").length - 1;
}

/** The last label of a path, which is the node's own slug. */
export function labelOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

/**
 * A node id arrives as text from a form, and text goes straight into a uuid
 * comparison. Postgres raises on a malformed one rather than returning no
 * rows, so the shape is checked before the query and a crafted id is a
 * refusal rather than a stack trace.
 */
export function isNodeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/**
 * The nodes an inviter may actually land somebody at: the subtrees where they
 * hold `member:invite`, and everything beneath them.
 *
 * This is presentation. The server refuses a node outside this set whether or
 * not the picker ever offered it, which is the half `checkGrant` does.
 */
export function nodesWithin<T extends { path: string }>(
  nodes: readonly T[],
  scopes: readonly string[],
): T[] {
  return nodes.filter((n) => scopes.some((s) => scopeCovers(s, n.path)));
}

/**
 * Roles worth offering at all.
 *
 * A role no node in reach is deep enough to carry cannot be granted anywhere,
 * so listing it is a refusal waiting to happen. Site Team stays hidden until
 * a phase exists, and appears the day one does.
 */
export function rolesGrantableIn<R extends { minKind: ScopeKind }>(
  roles: readonly R[],
  nodes: readonly { kind: ScopeKind }[],
): R[] {
  return roles.filter((r) => nodes.some((n) => roleFitsScope(r, n.kind)));
}

/**
 * The nodes one role may be given at. What the picker narrows to: deep
 * enough to carry it, and, when the role says where its giver may hand it
 * out (`at`, from `reachFor`), only there.
 */
export function nodesForRole<T extends { kind: ScopeKind; id?: string }>(
  nodes: readonly T[],
  role: { minKind: ScopeKind; at?: readonly string[] },
): T[] {
  return nodes.filter(
    (n) => roleFitsScope(role, n.kind) && (!role.at || (n.id !== undefined && role.at.includes(n.id))),
  );
}

/**
 * Every role this person may hand out, each with the nodes they may hand it
 * out at: deep enough to carry it, and where they hold everything it does.
 * A role with nowhere to go is left off, so the picker never offers a
 * refusal.
 *
 * Presentation, like `nodesWithin`. The server asks the same question per
 * invite in `checkGrant`, whatever the picker offered.
 */
export function reachFor<
  R extends { minKind: ScopeKind; permissions: readonly string[] },
  N extends { id: string; kind: ScopeKind; path: string },
>(roles: readonly R[], nodes: readonly N[], heldAt: (path: string) => ReadonlySet<string>): (R & { at: string[] })[] {
  const memo = new Map<string, ReadonlySet<string>>();
  const held = (path: string) => {
    let h = memo.get(path);
    if (!h) memo.set(path, (h = heldAt(path)));
    return h;
  };
  return roles
    .map((r) => ({
      ...r,
      at: nodes
        .filter((n) => roleFitsScope(r, n.kind) && missingToGrant(held(n.path), r.permissions).length === 0)
        .map((n) => n.id),
    }))
    .filter((r) => r.at.length > 0);
}

/** Tree order: a parent immediately above its children, siblings by name. */
export function treeOrder<T extends { path: string }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every node a spreadsheet cell could mean.
 *
 * Three passes, narrowest first. A full ltree path is exact and wins outright.
 * Then the node's own slug, so "Tower C", "tower_c" and "TOWER-C" are one
 * answer. Then its display name, which is what catches a node renamed after
 * its slug was fixed.
 *
 * More than one hit is returned as more than one on purpose. Two phases both
 * called "Phase 1" under different projects is the ordinary case, and picking
 * whichever sorted first would put somebody on the wrong tower.
 */
export function nodesNamed(raw: string, nodes: readonly ScopeNode[]): ScopeNode[] {
  const v = raw.trim();
  if (!v) return [];
  const lower = v.toLowerCase();

  const byPath = nodes.filter((n) => n.path.toLowerCase() === lower);
  if (byPath.length) return byPath;

  const slug = slugify(v);
  const byLabel = nodes.filter((n) => labelOf(n.path) === slug);
  if (byLabel.length) return byLabel;

  return nodes.filter((n) => n.name.toLowerCase() === lower);
}

/** A node's kind as a word in a sentence, rather than as a constant. */
export function kindWord(kind: ScopeKind): string {
  return kind === "ORG" ? "organisation" : kind.toLowerCase();
}

/**
 * Why a role and a node do not go together, in the words of the two things
 * the person actually picked. "Site Team is a phase-level role, and Mumbai is
 * a region" tells them what to change; "ROLE_TOO_DEEP" does not.
 */
export function depthRefusal(
  role: { label: string; minKind: ScopeKind },
  node: { name: string; kind: ScopeKind },
): string {
  return `${role.label} is a ${kindWord(role.minKind)}-level role, and ${node.name} is ${article(kindWord(node.kind))}.`;
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

export { roleFitsScope, scopeCovers };
