import type { TransactionSql } from "postgres";
import { audit } from "./db/index.ts";
import { childPath, slugify } from "./scope.ts";
import { entitySlug } from "./entity-rules.ts";
import { validateCity, validateProjectName } from "./project-rules.ts";

/**
 * Writing one PROJECT node, and the REGION under it, inside the caller's
 * transaction. `createProject()` uses it from the form, and a plan bought in
 * Checkout uses it when the payment settles, so a project is never written
 * two ways.
 *
 * Relative imports on purpose: the billing checks load this under plain
 * Node, which knows no `@/` alias.
 */

export type NewProject = { entityId: string; city: string; name: string };

export type Inserted = {
  ok: true;
  id: string;
  name: string;
  path: string;
  city: string;
  entityName: string;
  regionCreated: boolean;
  regionPath: string;
};

export type InsertOutcome = Inserted | { ok: false; code: string; message: string };

/** The form's three fields, read and checked before anything is written. */
export function readNewProject(raw: { entityId?: unknown; city?: unknown; name?: unknown }): { ok: true; project: NewProject } | { ok: false; code: string; message: string } {
  const city = validateCity(typeof raw.city === "string" ? raw.city : "");
  if (!city.ok) return city;
  const name = validateProjectName(typeof raw.name === "string" ? raw.name : "");
  if (!name.ok) return name;
  const entityId = typeof raw.entityId === "string" ? raw.entityId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) return { ok: false, code: "ENTITY_UNKNOWN", message: "Pick the legal entity this project registers under." };
  return { ok: true, project: { entityId, city: city.name, name: name.name } };
}

/**
 * Whether the project could be written now: the entity is this tenant's and
 * no project of that name sits in that city under it. Asked before a plan
 * is paid for, so nobody pays for a project that will be refused.
 */
export async function projectProblem(sql: TransactionSql, orgId: string, p: NewProject): Promise<{ code: string; message: string } | null> {
  const [entity] = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM scope_nodes WHERE org_id = ${orgId} AND id = ${p.entityId} AND kind = 'ENTITY' LIMIT 1`;
  if (!entity) return { code: "ENTITY_UNKNOWN", message: "Pick the legal entity this project registers under." };
  const [dupe] = await sql`
    SELECT 1 FROM scope_nodes pr
    JOIN scope_nodes r ON r.id = pr.parent_id AND r.kind = 'REGION' AND r.parent_id = ${entity.id} AND r.slug = ${slugify(p.city)}
    WHERE pr.org_id = ${orgId} AND pr.kind = 'PROJECT' AND lower(pr.name) = lower(${p.name})
    LIMIT 1`;
  if (dupe) return { code: "DUPLICATE_NAME", message: `${entity.name} already has a project called ${p.name} in ${p.city}.` };
  return null;
}

/**
 * Write the project. With `renameOnClash` a name taken since the check gets
 * " (2)" and so on, because the plan for it is already paid and refusing
 * now would leave a paid plan with nowhere to go.
 */
export async function insertProject(sql: TransactionSql, orgId: string, p: NewProject, opts: { renameOnClash?: boolean } = {}): Promise<InsertOutcome> {
  const [entity] = await sql<{ id: string; path: string; name: string }[]>`
    SELECT id, path::text AS path, name FROM scope_nodes
    WHERE org_id = ${orgId} AND id = ${p.entityId} AND kind = 'ENTITY' LIMIT 1`;
  if (!entity) return { ok: false, code: "ENTITY_UNKNOWN", message: "Pick the legal entity this project registers under." };

  const citySlug = slugify(p.city);
  const [existingRegion] = await sql<{ id: string; path: string }[]>`
    SELECT id, path::text AS path FROM scope_nodes
    WHERE org_id = ${orgId} AND parent_id = ${entity.id} AND kind = 'REGION' AND slug = ${citySlug}
    LIMIT 1`;
  let region = existingRegion;
  let regionCreated = false;
  if (!region) {
    const [made] = await sql<{ id: string; path: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${orgId}, ${entity.id}, 'REGION', ${p.city}, ${citySlug}, ${childPath(entity.path, citySlug)}::ltree)
      RETURNING id, path::text AS path`;
    region = made;
    regionCreated = true;
  }

  const siblings = await sql<{ slug: string; name: string }[]>`
    SELECT slug, name FROM scope_nodes WHERE org_id = ${orgId} AND parent_id = ${region.id}`;
  const taken = new Set(siblings.map((s) => s.name.toLowerCase()));
  let name = p.name;
  if (taken.has(name.toLowerCase())) {
    if (!opts.renameOnClash) {
      return { ok: false, code: "DUPLICATE_NAME", message: `${entity.name} already has a project called ${p.name} in ${p.city}.` };
    }
    let n = 2;
    while (taken.has(`${p.name} (${n})`.toLowerCase())) n++;
    name = `${p.name} (${n})`;
  }
  const slug = entitySlug(name, new Set(siblings.map((s) => s.slug)));
  const path = childPath(region.path, slug);
  const [node] = await sql<{ id: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${orgId}, ${region.id}, 'PROJECT', ${name}, ${slug}, ${path}::ltree)
    RETURNING id`;
  return { ok: true, id: node.id, name, path, city: p.city, entityName: entity.name, regionCreated, regionPath: region.path };
}

/** The audit rows a new project carries: its region's when one was made, then its own. */
export async function auditProject(orgId: string, actorUserId: string | null, r: Inserted, extra: Record<string, unknown> = {}): Promise<void> {
  if (r.regionCreated) {
    await audit({
      orgId,
      actorUserId,
      action: "scope_node.created",
      targetType: "scope_node",
      targetId: r.regionPath,
      metadata: { kind: "REGION", path: r.regionPath, name: r.city },
    });
  }
  await audit({
    orgId,
    actorUserId,
    action: "scope_node.created",
    targetType: "scope_node",
    targetId: r.id,
    metadata: { kind: "PROJECT", path: r.path, name: r.name, entity: r.entityName, city: r.city, ...extra },
  });
}
