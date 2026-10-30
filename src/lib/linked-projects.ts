import { audit, withTenant } from "./db/index.ts";
import { childPath } from "./scope.ts";
import { entitySlug } from "./entity-rules.ts";
import { auditProject, insertProject } from "./project-insert.ts";
import { gateFor } from "./plan-purchase.ts";
import { gateRefusal } from "./plan-purchase-rules.ts";
import { forgetLinks, linksOf } from "./linked.ts";

/**
 * A channel partner adds a developer's project it is empanelled on to its
 * own console (`linked.ts` says what that means for every read). The
 * partner's own developer entity, city, project and towers are made, named
 * as the developer names them, and each is linked to the developer's node.
 * Asked first: the empanelment is live today, and the partner's plan has a
 * project's room for it. Adding it twice opens the first.
 */

const ID = /^[0-9a-f-]{36}$/i;

export type LinkOutcome = { ok: true; projectId: string; added: boolean } | { ok: false; message: string };

/** The developer's project, its city, its promoter and its towers, read in the developer's tenant. */
async function developerSide(devOrgId: string, devProjectId: string) {
  return withTenant(devOrgId, async (sql) => {
    const [p] = await sql<{ id: string; name: string; city: string | null; entity_id: string | null; entity: string | null; pan: string | null; reg: string | null; reg_kind: string | null; address: string | null }[]>`
      SELECT p.id, p.name, r.name AS city, e.id AS entity_id, e.name AS entity, d.pan, d.registration_no AS reg,
             d.registration_kind AS reg_kind, d.registered_address AS address
      FROM scope_nodes p
      LEFT JOIN scope_nodes r ON r.id = p.parent_id AND r.kind = 'REGION'
      LEFT JOIN scope_nodes e ON e.id = r.parent_id AND e.kind = 'ENTITY'
      LEFT JOIN entity_details d ON d.scope_node_id = e.id
      WHERE p.org_id = ${devOrgId} AND p.id = ${devProjectId} AND p.kind = 'PROJECT'`;
    if (!p) return null;
    const towers = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM scope_nodes WHERE org_id = ${devOrgId} AND parent_id = ${p.id} AND kind = 'PHASE' ORDER BY name`;
    return { ...p, towers };
  });
}

/** The empanelment on this project is live today, as the partner itself can see it. */
async function liveOn(cpOrgId: string, devOrgId: string, devProjectId: string): Promise<boolean> {
  const [g] = await withTenant(cpOrgId, (sql) => sql<{ one: number }[]>`
    SELECT 1 AS one FROM grants
    WHERE org_id = ${devOrgId} AND grantee_org_id = ${cpOrgId} AND scope_node_id = ${devProjectId}
      AND role = 'CHANNEL_PARTNER' AND status = 'ACTIVE' AND now() >= valid_from AND now() < valid_to`);
  return !!g;
}

/** The partner's towers for the developer's: any tower the developer has added since is made and linked. Returns how many were added. */
async function linkTowers(cpOrgId: string, userId: string | null, devOrgId: string, devProjectId: string, ownProjectId: string, towers: { id: string; name: string }[]): Promise<number> {
  const made = await withTenant(cpOrgId, async (sql) => {
    const [project] = await sql<{ id: string; path: string; name: string }[]>`
      SELECT id, path::text AS path, name FROM scope_nodes WHERE org_id = ${cpOrgId} AND id = ${ownProjectId} AND kind = 'PROJECT'`;
    if (!project) return [];
    const have = new Set((await sql<{ source_node_id: string }[]>`
      SELECT source_node_id FROM linked_nodes WHERE org_id = ${cpOrgId} AND source_org_id = ${devOrgId}`).map((r) => r.source_node_id));
    const out: { id: string; path: string; name: string }[] = [];
    for (const t of towers) {
      if (have.has(t.id)) continue;
      const siblings = await sql<{ slug: string; name: string }[]>`
        SELECT slug, name FROM scope_nodes WHERE org_id = ${cpOrgId} AND parent_id = ${project.id}`;
      // A tower of the same name already here is the one it stands for.
      const same = await sql<{ id: string; path: string }[]>`
        SELECT id, path::text AS path FROM scope_nodes
        WHERE org_id = ${cpOrgId} AND parent_id = ${project.id} AND kind = 'PHASE' AND lower(name) = lower(${t.name})
          AND NOT EXISTS (SELECT 1 FROM linked_nodes l WHERE l.org_id = ${cpOrgId} AND l.scope_node_id = scope_nodes.id)`;
      let node = same[0];
      if (!node) {
        const slug = entitySlug(t.name, new Set(siblings.map((s) => s.slug)));
        const path = childPath(project.path, slug);
        [node] = await sql<{ id: string; path: string }[]>`
          INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
          VALUES (${cpOrgId}, ${project.id}, 'PHASE', ${t.name}, ${slug}, ${path}::ltree)
          RETURNING id, path::text AS path`;
        // Blocked on its own record, as every tower starts; the gate reads the developer's through the link.
        await sql`INSERT INTO registration_records (scope_node_id, org_id, status) VALUES (${node.id}, ${cpOrgId}, 'BLOCKED')`;
      }
      await sql`
        INSERT INTO linked_nodes (org_id, scope_node_id, source_org_id, source_node_id, source_project_id, created_by)
        VALUES (${cpOrgId}, ${node.id}, ${devOrgId}, ${t.id}, ${devProjectId}, ${userId})
        ON CONFLICT DO NOTHING`;
      out.push({ id: node.id, path: node.path, name: t.name });
    }
    return out;
  });
  for (const m of made) {
    await audit({ orgId: cpOrgId, actorUserId: userId, action: "scope_node.linked", targetType: "scope_node", targetId: m.id, metadata: { kind: "PHASE", path: m.path, developer: devOrgId } });
  }
  if (made.length) forgetLinks(cpOrgId);
  return made.length;
}

/** The partner adds a developer's project it is empanelled on to its own console. */
export async function addDeveloperProject(o: { cpOrgId: string; userId: string; devOrgId: string; devProjectId: string }): Promise<LinkOutcome> {
  if (!ID.test(o.devOrgId) || !ID.test(o.devProjectId)) return { ok: false, message: "Choose a project you are empanelled on." };
  if (!(await liveOn(o.cpOrgId, o.devOrgId, o.devProjectId))) return { ok: false, message: "Your empanelment on this project is not live today." };

  const dev = await developerSide(o.devOrgId, o.devProjectId);
  if (!dev) return { ok: false, message: "The developer no longer has this project." };

  // Added before: open it, and bring in any tower added since.
  const [already] = await withTenant(o.cpOrgId, (sql) => sql<{ scope_node_id: string }[]>`
    SELECT scope_node_id FROM linked_nodes WHERE org_id = ${o.cpOrgId} AND source_org_id = ${o.devOrgId} AND source_node_id = ${o.devProjectId}`);
  if (already) {
    await linkTowers(o.cpOrgId, o.userId, o.devOrgId, o.devProjectId, already.scope_node_id, dev.towers);
    return { ok: true, projectId: already.scope_node_id, added: false };
  }

  const refusal = gateRefusal(await gateFor(o.cpOrgId, "CHANNEL_PARTNER"));
  if (refusal) return { ok: false, message: refusal };
  if (!dev.entity || !dev.pan || !dev.city) return { ok: false, message: "The developer's records for this project are not complete yet. Ask them to finish setting it up." };

  // The developer, as the partner files it: found by its PAN, else added under
  // the promoter's own name, which is what the registration is matched against.
  const [mine] = await withTenant(o.cpOrgId, (sql) => sql<{ id: string }[]>`
    SELECT d.scope_node_id AS id FROM entity_details d WHERE d.org_id = ${o.cpOrgId} AND d.pan = ${dev.pan}`);
  let entityId = mine?.id ?? null;
  if (!entityId) {
    // The developer's own identity, as it filed it: already checked when the developer entered it.
    const made = await withTenant(o.cpOrgId, async (sql) => {
      const [root] = await sql<{ id: string; path: string }[]>`
        SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${o.cpOrgId} AND kind = 'ORG' LIMIT 1`;
      if (!root) return null;
      const siblings = await sql<{ slug: string; name: string }[]>`
        SELECT slug, name FROM scope_nodes WHERE org_id = ${o.cpOrgId} AND parent_id = ${root.id}`;
      if (siblings.some((s) => s.name.toLowerCase() === dev.entity!.toLowerCase())) return { clash: true as const };
      const slug = entitySlug(dev.entity!, new Set(siblings.map((s) => s.slug)));
      const path = childPath(root.path, slug);
      const [node] = await sql<{ id: string }[]>`
        INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
        VALUES (${o.cpOrgId}, ${root.id}, 'ENTITY', ${dev.entity}, ${slug}, ${path}::ltree) RETURNING id`;
      await sql`
        INSERT INTO entity_details (scope_node_id, org_id, pan, registration_no, registration_kind, registered_address)
        VALUES (${node.id}, ${o.cpOrgId}, ${dev.pan}, ${dev.reg}, ${dev.reg_kind}, ${dev.address})`;
      return { id: node.id, path };
    });
    if (!made) return { ok: false, message: "Your console has no root to add the developer under." };
    if ("clash" in made) return { ok: false, message: `You already have a developer called ${dev.entity} with another PAN. Check it in Settings, Developers' legal details.` };
    entityId = made.id;
    await audit({ orgId: o.cpOrgId, actorUserId: o.userId, action: "scope_node.created", targetType: "scope_node", targetId: made.id, metadata: { kind: "ENTITY", path: made.path, name: dev.entity, linked: o.devOrgId } });
  }

  const inserted = await withTenant(o.cpOrgId, async (sql) => {
    const r = await insertProject(sql, o.cpOrgId, { entityId: entityId!, city: dev.city!, name: dev.name }, { renameOnClash: true });
    if (!r.ok) return r;
    await sql`
      INSERT INTO linked_nodes (org_id, scope_node_id, source_org_id, source_node_id, source_project_id, created_by)
      VALUES (${o.cpOrgId}, ${r.id}, ${o.devOrgId}, ${o.devProjectId}, ${o.devProjectId}, ${o.userId})`;
    // Its leads are this developer's project's, for registering them with it.
    await sql`
      INSERT INTO partner_project_links (org_id, scope_node_id, dev_org_id, dev_project_id, updated_by)
      VALUES (${o.cpOrgId}, ${r.id}, ${o.devOrgId}, ${o.devProjectId}, ${o.userId})
      ON CONFLICT (org_id, scope_node_id) DO UPDATE SET dev_org_id = EXCLUDED.dev_org_id, dev_project_id = EXCLUDED.dev_project_id,
        updated_by = EXCLUDED.updated_by, updated_at = now()`;
    return r;
  });
  if (!inserted.ok) return { ok: false, message: inserted.message };
  forgetLinks(o.cpOrgId);
  await auditProject(o.cpOrgId, o.userId, inserted, { linked: o.devOrgId });
  await linkTowers(o.cpOrgId, o.userId, o.devOrgId, o.devProjectId, inserted.id, dev.towers);
  return { ok: true, projectId: inserted.id, added: true };
}

/** Each developer project the partner has added, by the developer's project id: the partner's own project for it. */
export async function addedProjects(cpOrgId: string): Promise<Map<string, string>> {
  const l = await linksOf(cpOrgId);
  return new Map(l.rows.filter((r) => r.kind === "PROJECT").map((r) => [`${r.sourceOrgId}:${r.sourceNodeId}`, r.nodeId]));
}

/**
 * Towers a developer added after the partner added the project, made and
 * linked. Run when the partner opens Developers, so a new tower is there to
 * advertise without anybody asking. Never throws.
 */
export async function refreshLinkedTowers(cpOrgId: string, userId: string | null): Promise<void> {
  try {
    const l = await linksOf(cpOrgId);
    for (const p of l.rows.filter((r) => r.kind === "PROJECT" && l.live.has(`${r.sourceOrgId}:${r.sourceNodeId}`))) {
      const dev = await developerSide(p.sourceOrgId, p.sourceNodeId);
      if (dev) await linkTowers(cpOrgId, userId, p.sourceOrgId, p.sourceNodeId, p.nodeId, dev.towers);
    }
  } catch (e) {
    console.error("linked projects: towers could not be refreshed", e);
  }
}
