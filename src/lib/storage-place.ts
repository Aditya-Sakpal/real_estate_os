import type { TransactionSql } from "postgres";
import { withTenant } from "./db/index.ts";

/**
 * The project a file's folder is named after: the node itself when it is a
 * PROJECT, the PROJECT above it when it is a tower, and null for the
 * organisation, an entity or a region, whose files live under `shared`.
 * See `assetKey()`.
 */
export async function projectFor(sql: TransactionSql, orgId: string, nodeId: string | null | undefined): Promise<string | null> {
  if (!nodeId) return null;
  const [r] = await sql<{ id: string }[]>`
    SELECT p.id FROM scope_nodes n
    JOIN scope_nodes p ON p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
    WHERE n.org_id = ${orgId} AND n.id = ${nodeId}
    LIMIT 1`;
  return r?.id ?? null;
}

/** The same, on a connection of its own. */
export function projectOfNode(orgId: string, nodeId: string | null | undefined): Promise<string | null> {
  if (!nodeId) return Promise.resolve(null);
  return withTenant(orgId, (sql) => projectFor(sql, orgId, nodeId));
}
