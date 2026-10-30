import { withTenant } from "./db/index.ts";
import { auditProject, insertProject, readNewProject, type InsertOutcome } from "./project-insert.ts";

/**
 * Projects, and the region that carries them.
 *
 * The tree is ORG ▸ ENTITY ▸ REGION ▸ PROJECT ▸ PHASE, but a developer thinks
 * in cities rather than in "region nodes". So the form asks for an entity, a
 * city and a project name, and the region is created or reused underneath
 * without anyone having to learn it exists. Two projects in Pune share one
 * `pune` node rather than each growing their own.
 *
 * Nothing here touches RERA. Registration attaches to a PHASE, because under
 * the explanation to Section 3 each phase is a standalone registration, and a
 * project with no phases has nothing to register yet.
 */

export type Project = {
  id: string;
  name: string;
  path: string;
  city: string;
  entityId: string;
  entityName: string;
  createdAt: string;
  phaseCount: number;
};

export type ProjectOutcome =
  | { ok: true; id: string; name: string; path: string }
  | { ok: false; code: string; message: string };

export async function listProjects(orgId: string): Promise<Project[]> {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<
      {
        id: string;
        name: string;
        path: string;
        city: string;
        entity_id: string;
        entity_name: string;
        created_at: Date;
        phases: number;
      }[]
    >`
      SELECT p.id, p.name, p.path::text AS path,
             region.name AS city,
             entity.id   AS entity_id,
             entity.name AS entity_name,
             p.created_at,
             (SELECT count(*)::int FROM scope_nodes ph
               WHERE ph.org_id = ${orgId} AND ph.parent_id = p.id
                 AND ph.kind = 'PHASE') AS phases
      FROM scope_nodes p
      JOIN scope_nodes region ON region.id = p.parent_id
      JOIN scope_nodes entity ON entity.id = region.parent_id
      WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT'
      ORDER BY entity.name, region.name, p.name
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      city: r.city,
      entityId: r.entity_id,
      entityName: r.entity_name,
      createdAt: r.created_at.toISOString(),
      phaseCount: r.phases,
    }));
  });
}

export async function createProject(opts: {
  orgId: string;
  actorUserId: string;
  entityId: string;
  city: string;
  name: string;
}): Promise<ProjectOutcome> {
  const read = readNewProject(opts);
  if (!read.ok) return read;
  const result = await withTenant(opts.orgId, (sql) => insertProject(sql, opts.orgId, read.project)).catch(
    (e: { code?: string }): InsertOutcome =>
      e?.code === "23505"
        ? { ok: false, code: "DUPLICATE", message: "That project already exists." }
        : { ok: false, code: "WRITE_FAILED", message: "Could not create that project." },
  );
  if (!result.ok) return result;
  await auditProject(opts.orgId, opts.actorUserId, result);
  return { ok: true, id: result.id, name: result.name, path: result.path };
}
