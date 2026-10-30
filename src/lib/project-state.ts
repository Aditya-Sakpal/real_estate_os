import type { TransactionSql } from "postgres";
import { withTenant } from "./db/index.ts";
import { sharedProjectItems, type SharedItem } from "./project-life-rules.ts";

/**
 * Small reads about a project's life (`project-life.ts`), kept apart so the
 * billing gate and the queue can ask them without pulling in the publisher.
 */

/** Whether the project a node sits in was retired. */
export async function retiredAt(sql: TransactionSql, orgId: string, nodeId: string): Promise<boolean> {
  const [r] = await sql<{ retired: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM project_states ps
      JOIN scope_nodes p ON p.id = ps.project_id
      JOIN scope_nodes n ON n.id = ${nodeId} AND n.org_id = ${orgId}
      WHERE ps.org_id = ${orgId} AND ps.status = 'RETIRED' AND p.path @> n.path
    ) AS retired`;
  return !!r?.retired;
}

/** The retired projects of a tenant. */
export async function retiredProjects(orgId: string): Promise<Set<string>> {
  try {
    const rows = await withTenant(orgId, (sql) => sql<{ project_id: string }[]>`
      SELECT project_id FROM project_states WHERE org_id = ${orgId} AND status = 'RETIRED'`);
    return new Set(rows.map((r) => r.project_id));
  } catch (e) {
    console.error("projects: retired projects could not be read", e);
    return new Set();
  }
}

/**
 * Today's items for a developer: a mandate firm or channel partner that
 * added one of its projects to its own console before the developer joined.
 * Names and kinds only, through `registrations_shared()`.
 */
export async function sharedQueue(orgId: string): Promise<SharedItem[]> {
  try {
    const { orgType, rows } = await withTenant(orgId, async (sql) => {
      const [org] = await sql<{ type: string }[]>`SELECT type FROM orgs WHERE id = ${orgId}`;
      if (org?.type !== "DEVELOPER") return { orgType: org?.type ?? null, rows: [] };
      const rows = await sql<{ project_id: string; project_name: string; holder_name: string; holder_kind: string }[]>`
        SELECT p.id AS project_id, p.name AS project_name, x.holder_name, x.holder_kind
        FROM registrations_shared(${orgId}) x
        JOIN scope_nodes ph ON ph.id = x.phase_id AND ph.org_id = ${orgId}
        JOIN scope_nodes p ON p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> ph.path`;
      return { orgType: org.type, rows };
    });
    return sharedProjectItems(orgType ?? "", rows.map((r) => ({ projectId: r.project_id, projectName: r.project_name, holder: r.holder_name, kind: r.holder_kind })));
  } catch (e) {
    console.error("projects: shared registrations could not be read", e);
    return [];
  }
}
