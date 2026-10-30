import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import { storage } from "./storage.ts";
import { deleteRefusal, NO_BLOCKERS, refusedTable, type DeleteBlockers, type DeleteKind } from "./node-delete-rules.ts";

/**
 * Deleting a project or a tower made by mistake. See `node-delete-rules.ts`
 * for what keeps one; the database's own foreign keys refuse the rest, and
 * a refusal is named in words rather than shown as an error.
 */

type Sql = TransactionSql;

/** What under this node keeps it, counted in one read. */
export async function deleteBlockers(sql: Sql, orgId: string, nodeId: string): Promise<DeleteBlockers> {
  const [r] = await sql<Record<keyof DeleteBlockers, number>[]>`
    WITH me AS (SELECT path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}),
         ids AS (SELECT n.id FROM scope_nodes n, me WHERE n.org_id = ${orgId} AND n.path <@ me.path)
    SELECT
      (SELECT count(*) FROM leads WHERE org_id = ${orgId} AND scope_node_id IN (SELECT id FROM ids))::int AS leads,
      (SELECT count(*) FROM calls WHERE org_id = ${orgId} AND scope_node_id IN (SELECT id FROM ids))::int AS calls,
      (SELECT count(*) FROM site_visits WHERE org_id = ${orgId} AND scope_node_id IN (SELECT id FROM ids))::int AS visits,
      (SELECT count(*) FROM quotes WHERE org_id = ${orgId} AND scope_node_id IN (SELECT id FROM ids))::int AS quotes,
      (SELECT count(*) FROM publish_targets WHERE org_id = ${orgId}
         AND (scope_node_id IN (SELECT id FROM ids) OR phase_id IN (SELECT id FROM ids)))::int AS published,
      (SELECT count(*) FROM broadcasts WHERE org_id = ${orgId}
         AND (scope_node_id IN (SELECT id FROM ids) OR phase_id IN (SELECT id FROM ids)))::int AS broadcasts,
      (SELECT count(*) FROM subscriptions WHERE org_id = ${orgId} AND project_id IN (SELECT id FROM ids))::int AS plans,
      ((SELECT count(*) FROM calling_numbers WHERE org_id = ${orgId} AND scope_node_id IN (SELECT id FROM ids))
        + (SELECT count(*) FROM whatsapp_numbers WHERE org_id = ${orgId} AND scope_node_id IN (SELECT id FROM ids)))::int AS numbers,
      (SELECT count(*) FROM grants WHERE org_id = ${orgId} AND scope_node_id IN (SELECT id FROM ids)
         AND role <> 'MANDATE_FIRM')::int AS partners,
      (SELECT count(*) FROM mandate_projects WHERE org_id = ${orgId} AND scope_node_id IN (SELECT id FROM ids))::int AS mandates,
      ((SELECT count(*) FROM outside_registrations WHERE org_id = ${orgId} AND project_id IN (SELECT id FROM ids))
        + (SELECT count(*) FROM outside_bookings WHERE org_id = ${orgId} AND project_id IN (SELECT id FROM ids)))::int AS outside`;
  return r ?? NO_BLOCKERS;
}

export type DeleteResult = { ok: true; name: string; parentId: string | null } | { ok: false; message: string };

/**
 * Delete one project or tower and everything it holds that is not kept.
 * A project's files are removed from the store after the rows are gone;
 * anything left behind is the orphan sweep's.
 */
export async function deleteNode(o: { orgId: string; userId: string; nodeId: string; kind: DeleteKind }): Promise<DeleteResult> {
  let done: DeleteResult;
  try {
    done = await withTenant(o.orgId, async (sql) => {
      const [n] = await sql<{ id: string; name: string; parent_id: string | null }[]>`
        SELECT id, name, parent_id FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.nodeId} AND kind = ${o.kind}`;
      if (!n) return { ok: false as const, message: o.kind === "PROJECT" ? "That project does not exist here." : "That phase does not exist here." };
      const linked = await sql`SELECT 1 FROM linked_nodes WHERE org_id = ${o.orgId} AND scope_node_id = ${n.id} LIMIT 1`.catch(() => []);
      if (linked.length) return { ok: false as const, message: "This comes from a developer's project. Take it off from Developers instead." };
      const why = deleteRefusal(o.kind, await deleteBlockers(sql, o.orgId, n.id));
      if (why) return { ok: false as const, message: why };
      await sql`DELETE FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${n.id}`;
      return { ok: true as const, name: n.name, parentId: n.parent_id };
    });
  } catch (e) {
    const err = e as { code?: string; table_name?: string };
    if (err.code === "23503" || err.code === "23001") return { ok: false, message: `It still has ${refusedTable(err.table_name)}, and those stay on record.` };
    if (err.code === "P0001" || err.code === "23514" || err.code === "42501") return { ok: false, message: "It holds records that are kept, so it cannot be deleted. Retire it instead." };
    throw e;
  }
  if (!done.ok) return done;
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: o.kind === "PROJECT" ? "project.deleted" : "phase.deleted",
    targetType: "scope_node",
    targetId: o.nodeId,
    metadata: {},
  });
  return done;
}

/** A deleted project's files, removed from the store. Never fails the delete. */
export async function removeProjectFiles(orgId: string, projectId: string): Promise<number> {
  const d = storage();
  if (!d.list) return 0;
  const objects = await d.list(`org/${orgId}/project/${projectId}/`).catch(() => []);
  let removed = 0;
  for (const obj of objects) {
    await d.remove(obj.key).then(() => removed++, () => undefined);
  }
  return removed;
}
