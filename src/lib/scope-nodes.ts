import { withTenant } from "@/lib/db";
import { isNodeId, treeOrder, type ScopeNode } from "@/lib/scope-rules";
import type { ScopeKind } from "@/lib/roles";

/**
 * Reading the scope tree.
 *
 * Every read here goes through `withTenant()`, so RLS is the outer wall: a
 * node id belonging to another organisation returns no rows before the
 * `org_id` in the statement ever gets to disagree with it. Both are written
 * anyway, because the one that is load-bearing should not be the one that is
 * implicit.
 *
 * This is the half of "never trust a node id from the form" that needs a
 * database. `checkGrant()` does the other half: whether the actor holds
 * `member:invite` at or above whatever this returns.
 */

export type { ScopeNode };

/** Every node in this tenant's tree, parents above their children. */
export async function listScopeNodes(orgId: string): Promise<ScopeNode[]> {
  const rows = await withTenant(orgId, async (sql) => {
    return sql<{ id: string; kind: ScopeKind; name: string; path: string }[]>`
      SELECT id, kind, name, path::text AS path
      FROM scope_nodes
      WHERE org_id = ${orgId}
      ORDER BY path
    `;
  });
  return treeOrder(rows);
}

/**
 * Turn an id from a form into a node, or into nothing.
 *
 * Nothing is the answer for a malformed id, an id naming a node in another
 * tenant, and an id naming a node that has since been deleted. The caller
 * cannot tell those three apart, which is correct: a crafted request learns
 * whether a uuid exists somewhere in the platform only if we tell it.
 */
export async function resolveScopeNode(
  orgId: string,
  nodeId: string,
): Promise<ScopeNode | null> {
  if (!isNodeId(nodeId)) return null;

  const [node] = await withTenant(orgId, async (sql) => {
    return sql<{ id: string; kind: ScopeKind; name: string; path: string }[]>`
      SELECT id, kind, name, path::text AS path
      FROM scope_nodes
      WHERE org_id = ${orgId} AND id = ${nodeId.trim()}
      LIMIT 1
    `;
  });
  return node ?? null;
}

/** The root, which is where an invite lands when it names no node. */
export async function orgRoot(orgId: string): Promise<ScopeNode | null> {
  const [node] = await withTenant(orgId, async (sql) => {
    return sql<{ id: string; kind: ScopeKind; name: string; path: string }[]>`
      SELECT id, kind, name, path::text AS path
      FROM scope_nodes
      WHERE org_id = ${orgId} AND kind = 'ORG'
      LIMIT 1
    `;
  });
  return node ?? null;
}

/**
 * The node an invite is asking for, whichever way it was named.
 *
 * An empty id is not a crafted request, it is a form with no picker on it or
 * a spreadsheet row that named no place, and the root is the right answer for
 * both. An id that is present and wrong is a refusal.
 */
export async function targetNode(
  orgId: string,
  nodeId: string | null | undefined,
): Promise<ScopeNode | null> {
  const wanted = (nodeId ?? "").trim();
  return wanted ? resolveScopeNode(orgId, wanted) : orgRoot(orgId);
}
