import { withTenant, audit } from "./db/index.ts";
import { childPath, isValidLabel } from "./scope.ts";
import { entitySlug, validateEntity } from "./entity-rules.ts";
import { isNodeId } from "./scope-rules.ts";

/**
 * Legal entities: the first node anyone adds beneath the org root.
 *
 * Nearly every Indian residential project registers under its own SPV, and
 * under RERA the promoter of record is that legal person rather than the
 * parent brand. So a project cannot hang directly off the org: it hangs off
 * the entity that will appear on the filing.
 *
 * This is tenant-scoped work, so it goes through `withTenant()`. Org creation
 * is the only place a scope node is written on the control connection, and
 * that is because no tenant context exists yet at signup.
 */

export type Entity = {
  id: string;
  name: string;
  slug: string;
  path: string;
  createdAt: string;
  /** Nodes hanging beneath it: regions, and the projects under them. */
  childCount: number;
  projectCount: number;
  pan: string | null;
  registrationNo: string | null;
  registrationKind: string | null;
  /** Read so the editor can show it: a form without it saved the address as blank. */
  registeredAddress: string | null;
};

export type EntityOutcome =
  | { ok: true; id: string; name: string; path: string }
  | { ok: false; code: string; message: string };

type Sql = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Which field a duplicate is about, asked before writing so the refusal can
 * name it. One sentence for all three ("that name, PAN or registration
 * number") left a person to guess which of the three to change.
 */
async function identityClash(
  sql: Sql,
  orgId: string,
  pan: string,
  registrationNo: string | null,
  exceptId: string | null,
): Promise<string | null> {
  const [byPan] = await sql<{ name: string }[]>`
    SELECT n.name FROM entity_details d JOIN scope_nodes n ON n.id = d.scope_node_id
    WHERE d.org_id = ${orgId} AND d.pan = ${pan}
      ${exceptId ? sql`AND d.scope_node_id <> ${exceptId}` : sql``}
    LIMIT 1
  `;
  if (byPan) return `PAN ${pan} already belongs to ${byPan.name}.`;
  if (registrationNo) {
    const [byNo] = await sql<{ name: string; kind: string | null }[]>`
      SELECT n.name, d.registration_kind AS kind
      FROM entity_details d JOIN scope_nodes n ON n.id = d.scope_node_id
      WHERE d.org_id = ${orgId} AND d.registration_no = ${registrationNo}
        ${exceptId ? sql`AND d.scope_node_id <> ${exceptId}` : sql``}
      LIMIT 1
    `;
    if (byNo) return `${byNo.kind ?? "That CIN or LLPIN"} ${registrationNo} already belongs to ${byNo.name}.`;
  }
  return null;
}

/** A unique violation that still got past the lookups (a race), named by the index it hit. */
function duplicateMessage(e: { code?: string; constraint_name?: string }): string {
  switch (e.constraint_name) {
    case "entity_details_org_pan":
      return "Another entity here already has that PAN.";
    case "entity_details_org_registration":
      return "Another entity here already has that CIN or LLPIN.";
    case "scope_nodes_sibling_slug":
    case "scope_nodes_path_key":
      return "An entity with that name already exists here.";
    default:
      return "An entity with that name, PAN or registration number already exists here.";
  }
}

export async function listEntities(orgId: string): Promise<Entity[]> {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<
      {
        id: string;
        name: string;
        slug: string;
        path: string;
        created_at: Date;
        kids: number;
        projects: number;
        pan: string | null;
        registration_no: string | null;
        registration_kind: string | null;
        registered_address: string | null;
      }[]
    >`
      SELECT e.id, e.name, e.slug, e.path::text AS path, e.created_at,
             (SELECT count(*)::int FROM scope_nodes c
               WHERE c.org_id = ${orgId} AND c.path <@ e.path AND c.id <> e.id) AS kids,
             (SELECT count(*)::int FROM scope_nodes c
               WHERE c.org_id = ${orgId} AND c.path <@ e.path AND c.kind = 'PROJECT') AS projects,
             d.pan, d.registration_no, d.registration_kind, d.registered_address
      FROM scope_nodes e
      LEFT JOIN entity_details d ON d.scope_node_id = e.id
      WHERE e.org_id = ${orgId} AND e.kind = 'ENTITY'
      ORDER BY e.name
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      path: r.path,
      createdAt: r.created_at.toISOString(),
      childCount: r.kids,
      projectCount: r.projects,
      pan: r.pan,
      registrationNo: r.registration_no,
      registrationKind: r.registration_kind,
      registeredAddress: r.registered_address,
    }));
  });
}

export async function createEntity(opts: {
  orgId: string;
  actorUserId: string;
  legalName: string;
  pan: string;
  registrationNo: string;
  registeredAddress: string;
}): Promise<EntityOutcome> {
  const parsed = validateEntity(opts);
  if (!parsed.ok) return parsed;
  const { legalName, pan, registration, registeredAddress } = parsed;

  const result = await withTenant(opts.orgId, async (sql) => {
    const [root] = await sql<{ id: string; path: string }[]>`
      SELECT id, path::text AS path
      FROM scope_nodes WHERE org_id = ${opts.orgId} AND kind = 'ORG' LIMIT 1
    `;
    if (!root) {
      return { ok: false as const, code: "NO_ROOT", message: "This organisation has no root node." };
    }

    const siblings = await sql<{ slug: string; name: string }[]>`
      SELECT slug, name FROM scope_nodes
      WHERE org_id = ${opts.orgId} AND parent_id = ${root.id}
    `;

    // Two entities with the same legal name is almost always a double submit,
    // not a real second SPV, and the RERA promoter check would not be able to
    // tell them apart either.
    if (siblings.some((s) => s.name.toLowerCase() === legalName.toLowerCase())) {
      return {
        ok: false as const,
        code: "DUPLICATE_NAME",
        message: `${legalName} is already an entity here.`,
      };
    }
    const clash = await identityClash(sql, opts.orgId, pan, registration?.no ?? null, null);
    if (clash) return { ok: false as const, code: "DUPLICATE_IDENTITY", message: clash };

    const slug = entitySlug(legalName, new Set(siblings.map((s) => s.slug)));
    const path = childPath(root.path, slug);
    if (!isValidLabel(slug)) {
      return { ok: false as const, code: "BAD_SLUG", message: "That name cannot become a path." };
    }

    const [node] = await sql<{ id: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${opts.orgId}, ${root.id}, 'ENTITY', ${legalName}, ${slug}, ${path}::ltree)
      RETURNING id
    `;

    await sql`
      INSERT INTO entity_details (scope_node_id, org_id, pan, registration_no,
                                  registration_kind, registered_address)
      VALUES (${node.id}, ${opts.orgId}, ${pan}, ${registration?.no ?? null},
              ${registration?.kind ?? null}, ${registeredAddress})
    `;

    return { ok: true as const, id: node.id, name: legalName, path };
  }).catch((e: { code?: string; constraint_name?: string }) =>
    // The sibling-slug and global-path indexes are the real arbiters. Losing a
    // race to them is a duplicate, not a crash, and the index names the field.
    e?.code === "23505"
      ? { ok: false as const, code: "DUPLICATE", message: duplicateMessage(e) }
      : { ok: false as const, code: "WRITE_FAILED", message: "Could not create that entity." },
  );

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "scope_node.created",
      targetType: "scope_node",
      targetId: result.id,
      // No PAN or registration number here. Audit rows outlive erasure
      // requests, and the entity's own row already holds those values.
      metadata: { kind: "ENTITY", path: result.path, name: result.name },
    });
  }

  return result;
}

/**
 * Edit an entity's legal identity.
 *
 * The slug and the path do NOT change. A path is the address every ancestor
 * and descendant query is written against, and every membership scoped below
 * this node depends on it; renaming an entity changes what it is called, not
 * where it lives. That rule is already written into `scope.ts`.
 *
 * The legal name genuinely can change, and it matters when it does: it is the
 * promoter of record, so a rename can turn a verified registration into a
 * mismatch. Recorded in the audit log with both values for exactly that
 * reason.
 */
export async function updateEntity(opts: {
  orgId: string;
  actorUserId: string;
  entityId: string;
  legalName: string;
  pan: string;
  registrationNo: string;
  registeredAddress: string;
}): Promise<EntityOutcome> {
  const parsed = validateEntity(opts);
  if (!parsed.ok) return parsed;
  const { legalName, pan, registration, registeredAddress } = parsed;
  // Postgres raises on a malformed uuid rather than finding nothing.
  if (!isNodeId(opts.entityId)) {
    return { ok: false, code: "ENTITY_UNKNOWN", message: "That entity does not exist." };
  }

  const result = await withTenant(opts.orgId, async (sql) => {
    const [current] = await sql<{ id: string; name: string; path: string }[]>`
      SELECT id, name, path::text AS path FROM scope_nodes
      WHERE org_id = ${opts.orgId} AND id = ${opts.entityId} AND kind = 'ENTITY'
    `;
    if (!current) {
      return { ok: false as const, code: "ENTITY_UNKNOWN", message: "That entity does not exist." };
    }

    const clash = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes
      WHERE org_id = ${opts.orgId} AND kind = 'ENTITY' AND id <> ${opts.entityId}
        AND lower(name) = ${legalName.toLowerCase()}
    `;
    if (clash.length) {
      return {
        ok: false as const,
        code: "DUPLICATE_NAME",
        message: `${legalName} is already another entity here.`,
      };
    }
    const taken = await identityClash(sql, opts.orgId, pan, registration?.no ?? null, opts.entityId);
    if (taken) return { ok: false as const, code: "DUPLICATE_IDENTITY", message: taken };

    await sql`
      UPDATE scope_nodes SET name = ${legalName}
      WHERE org_id = ${opts.orgId} AND id = ${opts.entityId}
    `;
    await sql`
      INSERT INTO entity_details (scope_node_id, org_id, pan, registration_no,
                                  registration_kind, registered_address, updated_at)
      VALUES (${opts.entityId}, ${opts.orgId}, ${pan}, ${registration?.no ?? null},
              ${registration?.kind ?? null}, ${registeredAddress}, now())
      ON CONFLICT (scope_node_id) DO UPDATE
        SET pan = EXCLUDED.pan,
            registration_no = EXCLUDED.registration_no,
            registration_kind = EXCLUDED.registration_kind,
            registered_address = EXCLUDED.registered_address,
            updated_at = now()
    `;

    return {
      ok: true as const,
      id: opts.entityId,
      name: legalName,
      path: current.path,
      previousName: current.name,
    };
  }).catch((e: { code?: string; constraint_name?: string }) =>
    e?.code === "23505"
      ? { ok: false as const, code: "DUPLICATE", message: duplicateMessage(e) }
      : { ok: false as const, code: "WRITE_FAILED", message: "Could not save that entity." },
  );

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "scope_node.updated",
      targetType: "scope_node",
      targetId: result.id,
      metadata: {
        kind: "ENTITY",
        path: result.path,
        // Both names, because a rename can break a promoter match that was
        // verified against the old one.
        name_from: result.previousName,
        name_to: result.name,
        renamed: result.previousName !== result.name,
      },
    });
  }
  return result;
}
