import { withTenant, audit } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import { linkedSource } from "./linked.ts";
import { approvedUnits } from "./unit.ts";
import {
  asLines,
  briefFitsNode,
  canAddReference,
  canMarkReady,
  isObjective,
  isReferenceKind,
  pickFrom,
  textOrNull,
  FORMATS,
  LANGUAGES,
  type Brief,
  type BriefStatus,
  type Objective,
  type ReferenceKind,
} from "./campaign-rules.ts";
import type { ScopeKind } from "./roles.ts";

/**
 * Reading and writing campaign briefs.
 *
 * Two rules run through everything here.
 *
 * **A brief hangs off a PROJECT or a PHASE, and nothing else.** A brief for
 * the organisation is a brief for nothing in particular: the generator has to
 * resolve a Brain and a registration from the node, and only those two kinds
 * carry one. `briefFitsNode()` decides, and the node is read back inside the
 * tenant before it is asked.
 *
 * **The form is never believed.** A node id, an objective, a language and a
 * format all arrive as strings a page said were valid. Each is checked
 * against the catalog in `campaign-rules.ts` or against the tenant's own
 * tree before it is written.
 *
 * Imports are relative because `check:campaign` loads this straight from
 * source, outside Next, where the `@/` alias does not resolve.
 */

export type BriefNode = { id: string; kind: ScopeKind; name: string; path: string };

export type BriefRow = Brief & {
  id: string;
  nodeId: string;
  updatedAt: string;
  updatedByName: string | null;
};

export type BriefView = { node: BriefNode; brief: BriefRow };

export type BriefOutcome =
  | { ok: true; briefId: string }
  | { ok: false; code: string; message: string };

type DbRow = {
  id: string;
  scope_node_id: string;
  name: string;
  status: BriefStatus;
  objective: string | null;
  audience: string | null;
  micro_markets: string[];
  languages: string[];
  formats: string[];
  unit_type_ids: string[];
  cta: string | null;
  hook: string | null;
  offers: string | null;
  updated_at: Date;
  updated_by_name: string | null;
};

const toRow = (r: DbRow): BriefRow => ({
  id: r.id,
  nodeId: r.scope_node_id,
  name: r.name,
  status: r.status,
  objective: isObjective(r.objective) ? (r.objective as Objective) : null,
  audience: r.audience,
  microMarkets: r.micro_markets ?? [],
  languages: r.languages ?? [],
  formats: r.formats ?? [],
  unitTypeIds: r.unit_type_ids ?? [],
  cta: r.cta,
  hook: r.hook,
  offers: r.offers,
  updatedAt: r.updated_at.toISOString(),
  updatedByName: r.updated_by_name,
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every brief on one node, newest first. */
export async function listBriefs(orgId: string, nodeId: string): Promise<BriefRow[]> {
  if (!isNodeId(nodeId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<DbRow[]>`
      SELECT b.id, b.scope_node_id, b.name, b.status, b.objective, b.audience,
             b.micro_markets, b.languages, b.formats, b.unit_type_ids,
             b.cta, b.hook,
             b.offers, b.updated_at, u.name AS updated_by_name
      FROM campaign_briefs b
      LEFT JOIN users u ON u.id = b.updated_by
      WHERE b.org_id = ${orgId} AND b.scope_node_id = ${nodeId}
      ORDER BY b.updated_at DESC
    `;
  });
  return rows.map(toRow);
}

/**
 * One brief and the node it belongs to.
 *
 * Null for a malformed id, a brief in another tenant, and a brief that has
 * been removed. The caller cannot tell those apart, which is correct.
 */
export async function loadBrief(orgId: string, briefId: string): Promise<BriefView | null> {
  if (!isNodeId(briefId)) return null;

  const result = await withTenant(orgId, async (sql) => {
    const [row] = await sql<(DbRow & { kind: ScopeKind; node_name: string; path: string })[]>`
      SELECT b.id, b.scope_node_id, b.name, b.status, b.objective, b.audience,
             b.micro_markets, b.languages, b.formats, b.unit_type_ids,
             b.cta, b.hook,
             b.offers, b.updated_at, u.name AS updated_by_name,
             n.kind, n.name AS node_name, n.path::text AS path
      FROM campaign_briefs b
      JOIN scope_nodes n ON n.id = b.scope_node_id
      LEFT JOIN users u ON u.id = b.updated_by
      WHERE b.org_id = ${orgId} AND b.id = ${briefId}
      LIMIT 1
    `;
    return row ?? null;
  });

  if (!result) return null;
  return {
    node: {
      id: result.scope_node_id,
      kind: result.kind,
      name: result.node_name,
      path: result.path,
    },
    brief: toRow(result),
  };
}

/** How many briefs each node carries, and how many of those are ready. */
export async function briefCounts(
  orgId: string,
  nodeIds: readonly string[],
): Promise<Map<string, { total: number; ready: number }>> {
  const clean = nodeIds.filter(isNodeId);
  const out = new Map<string, { total: number; ready: number }>();
  if (!clean.length) return out;

  const rows = await withTenant(orgId, async (sql) => {
    return sql<{ scope_node_id: string; total: number; ready: number }[]>`
      SELECT scope_node_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE status = 'READY')::int AS ready
      FROM campaign_briefs
      WHERE org_id = ${orgId} AND scope_node_id = ANY(${clean as string[]})
      GROUP BY scope_node_id
    `;
  });
  for (const r of rows) out.set(r.scope_node_id, { total: r.total, ready: r.ready });
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Start a brief on a node.
 *
 * The node is read back inside the tenant, so an id naming another
 * organisation's tower resolves to nothing rather than to a brief written
 * across the boundary.
 */
export async function createBrief(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
  name: string;
}): Promise<BriefOutcome> {
  const name = textOrNull(opts.name);
  if (!name) {
    return { ok: false, code: "NAME_REQUIRED", message: "Give the campaign a name." };
  }
  if (!isNodeId(opts.nodeId)) {
    return { ok: false, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
  }

  const result = await withTenant(opts.orgId, async (sql) => {
    const [node] = await sql<{ id: string; kind: ScopeKind; name: string }[]>`
      SELECT id, kind, name FROM scope_nodes
      WHERE org_id = ${opts.orgId} AND id = ${opts.nodeId}
    `;
    if (!node) {
      return { ok: false as const, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
    }
    if (!briefFitsNode(node.kind)) {
      return {
        ok: false as const,
        code: "NODE_KIND",
        message: "A campaign runs for a project or a phase, so a brief belongs to one of those.",
      };
    }

    const [created] = await sql<{ id: string }[]>`
      INSERT INTO campaign_briefs (org_id, scope_node_id, name, created_by, updated_by)
      VALUES (${opts.orgId}, ${opts.nodeId}, ${name}, ${opts.actorUserId}, ${opts.actorUserId})
      RETURNING id
    `;
    return { ok: true as const, briefId: created.id };
  }).catch((e: { code?: string }) =>
    e?.code === "23505"
      ? {
          ok: false as const,
          code: "NAME_TAKEN",
          message: `There is already a campaign called ${name} here.`,
        }
      : { ok: false as const, code: "WRITE_FAILED", message: "Could not start that brief." },
  );

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "campaign.brief_created",
      targetType: "campaign_brief",
      targetId: result.briefId,
      metadata: { nodeId: opts.nodeId, name },
    });
  }
  return result;
}

/**
 * Write the whole brief.
 *
 * Saved whole rather than per section because nothing here is signed: there
 * is no hash to invalidate and no approver to drag back, so the unit of work
 * is the form the person is looking at.
 */
export async function saveBrief(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  input: {
    name: string;
    objective: string | null;
    audience: string | null;
    microMarkets: string | null;
    languages: string[];
    formats: string[];
    unitTypeIds: string[];
    cta: string | null;
    hook: string | null;
    offers: string | null;
  };
}): Promise<BriefOutcome> {
  const name = textOrNull(opts.input.name);
  if (!name) {
    return { ok: false, code: "NAME_REQUIRED", message: "Give the campaign a name." };
  }
  if (!isNodeId(opts.briefId)) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That brief is not in this organisation." };
  }

  const objective = isObjective(opts.input.objective) ? opts.input.objective : null;
  const languages = pickFrom(LANGUAGES, opts.input.languages);
  const formats = pickFrom(FORMATS, opts.input.formats);
  const microMarkets = asLines(opts.input.microMarkets);
  // Shape first, so a malformed one never reaches a uuid comparison. Postgres
  // raises on a bad uuid rather than returning no rows, which is the reason
  // `isNodeId()` exists at all.
  const unitIds = opts.input.unitTypeIds.filter(isNodeId);
  // On a channel partner's project added from a developer, the configurations
  // are the developer's, read through the link: the ids kept are the ones
  // that read returns for this brief's node, and no others.
  const [briefNode] = await withTenant(opts.orgId, (sql) => sql<{ scope_node_id: string }[]>`
    SELECT scope_node_id FROM campaign_briefs WHERE org_id = ${opts.orgId} AND id = ${opts.briefId}`);
  const throughLink = briefNode && (await linkedSource(opts.orgId, briefNode.scope_node_id))
    ? new Set((await approvedUnits(opts.orgId, briefNode.scope_node_id)).units.map((u) => u.id))
    : null;
  const linkedIds = throughLink ? unitIds.filter((id) => throughLink.has(id)) : null;

  const result = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      UPDATE campaign_briefs SET
        name          = ${name},
        objective     = ${objective},
        audience      = ${textOrNull(opts.input.audience)},
        micro_markets = ${microMarkets},
        languages     = ${languages},
        formats       = ${formats},
        -- Never the list the form posted. An array cannot carry a foreign
        -- key, so containment is asked here instead: keep only the ids that
        -- resolve to a configuration on this brief's own node or a tower
        -- under it. An id naming another tenant's 2 BHK is invisible to RLS
        -- and an id naming another project's is filtered by the path, so a
        -- stale tab and a hand-written form both end up writing nothing.
        unit_type_ids = ${linkedIds
          ? sql`${linkedIds}::uuid[]`
          : sql`ARRAY(
          SELECT t.id
          FROM unit_types t
          JOIN scope_nodes tn ON tn.id = t.scope_node_id
          JOIN scope_nodes bn ON bn.id = campaign_briefs.scope_node_id
          WHERE t.org_id = ${opts.orgId}
            AND t.id = ANY(${unitIds}::uuid[])
            AND tn.path <@ bn.path
        )`},
        cta           = ${textOrNull(opts.input.cta)},
        hook          = ${textOrNull(opts.input.hook)},
        offers        = ${textOrNull(opts.input.offers)},
        updated_by    = ${opts.actorUserId},
        updated_at    = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.briefId}
      RETURNING id
    `;
    return row
      ? { ok: true as const, briefId: row.id }
      : { ok: false as const, code: "BRIEF_UNKNOWN", message: "That brief is not in this organisation." };
  }).catch((e: { code?: string }) =>
    e?.code === "23505"
      ? {
          ok: false as const,
          code: "NAME_TAKEN",
          message: `There is already a campaign called ${name} here.`,
        }
      : { ok: false as const, code: "WRITE_FAILED", message: "Could not save that brief." },
  );

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "campaign.brief_saved",
      targetType: "campaign_brief",
      targetId: opts.briefId,
      metadata: { objective, languages: languages.length, formats: formats.length },
    });
  }
  return result;
}

/**
 * Change only the hook.
 *
 * The studio offers each approved talking point as a one-press replacement
 * when the hook is what blocked the copy. Sending the person to the whole
 * brief form for one field was the screen asking them to work out which of
 * twelve fields it meant.
 *
 * The hook stays free text on purpose, so nothing here checks it against the
 * Brain: the gate does that on what the model writes, which is the only check
 * that counts.
 */
export async function setBriefHook(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  hook: string;
}): Promise<BriefOutcome> {
  if (!isNodeId(opts.briefId)) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That brief is not in this organisation." };
  }
  const hook = textOrNull(opts.hook);
  const done = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      UPDATE campaign_briefs
      SET hook = ${hook}, updated_by = ${opts.actorUserId}, updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.briefId}
      RETURNING id`;
    return row ?? null;
  });
  if (!done) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That brief is not in this organisation." };
  }
  // The hook is words somebody chose, so it stays out of the audit row.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "campaign.brief_saved",
    targetType: "campaign_brief",
    targetId: opts.briefId,
    metadata: { field: "hook" },
  });
  return { ok: true, briefId: opts.briefId };
}

/**
 * Move a brief between DRAFT and READY.
 *
 * Marking it ready asks `canMarkReady()` first, because "ready" is a claim
 * that the job is fully specified and a required field nobody filled in
 * contradicts it. Going back to DRAFT asks nothing: a campaign returning for
 * a rewrite is the ordinary case, and a state you cannot leave is a trap.
 */
export async function setBriefStatus(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  status: BriefStatus;
}): Promise<BriefOutcome> {
  const view = await loadBrief(opts.orgId, opts.briefId);
  if (!view) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That brief is not in this organisation." };
  }

  if (opts.status === "READY") {
    const verdict = canMarkReady(view.brief);
    if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
  }

  const result = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      UPDATE campaign_briefs
      SET status = ${opts.status}, updated_by = ${opts.actorUserId}, updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.briefId}
      RETURNING id
    `;
    return row
      ? { ok: true as const, briefId: row.id }
      : { ok: false as const, code: "BRIEF_UNKNOWN", message: "That brief is not in this organisation." };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not change that brief.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: opts.status === "READY" ? "campaign.brief_ready" : "campaign.brief_reopened",
      targetType: "campaign_brief",
      targetId: opts.briefId,
      metadata: { node: view.node.path },
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export type ReferenceRow = {
  id: string;
  kind: ReferenceKind;
  note: string | null;
  mediaType: string;
  mediaName: string | null;
  mediaBytes: number;
  createdAt: string;
};

/**
 * The references on a brief, without their bytes.
 *
 * The media column is never selected here. Twelve references would otherwise
 * pull three hundred megabytes through the connection to render twelve
 * thumbnails, and the page only needs to know what kind of file each is.
 * `octet_length` reads the stored size without reading the bytes.
 */
export async function listReferences(
  orgId: string,
  briefId: string,
): Promise<ReferenceRow[]> {
  if (!isNodeId(briefId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<
      {
        id: string;
        kind: ReferenceKind;
        note: string | null;
        media_type: string;
        media_name: string | null;
        media_bytes: number;
        created_at: Date;
      }[]
    >`
      SELECT id, kind, note, media_type, media_name,
             octet_length(media) AS media_bytes, created_at
      FROM campaign_references
      WHERE org_id = ${orgId} AND brief_id = ${briefId}
      ORDER BY created_at
    `;
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    note: r.note,
    mediaType: r.media_type,
    mediaName: r.media_name,
    mediaBytes: Number(r.media_bytes),
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * One reference's bytes, for the route that serves it, with the path of the
 * node its brief belongs to.
 *
 * Read through `withTenant()` like everything else, so a reference id from
 * another organisation returns nothing rather than a file. The brief in the
 * address has to be the one the reference is filed under, and the path comes
 * back so the route can ask whether the viewer may read campaigns THERE:
 * `campaign:read` held on Tower A is not a key to Tower B's references.
 */
export async function readReferenceMedia(
  orgId: string,
  briefId: string,
  referenceId: string,
): Promise<{ bytes: Buffer; type: string; name: string | null; path: string } | null> {
  if (!isNodeId(referenceId) || !isNodeId(briefId)) return null;
  const [row] = await withTenant(orgId, async (sql) => {
    return sql<{ media: Buffer; media_type: string; media_name: string | null; path: string }[]>`
      SELECT r.media, r.media_type, r.media_name, n.path::text AS path
      FROM campaign_references r
      JOIN campaign_briefs b ON b.id = r.brief_id
      JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE r.org_id = ${orgId} AND r.id = ${referenceId} AND r.brief_id = ${briefId}
      LIMIT 1
    `;
  });
  return row ? { bytes: row.media, type: row.media_type, name: row.media_name, path: row.path } : null;
}

export type ReferenceOutcome =
  | { ok: true; referenceId: string }
  | { ok: false; code: string; message: string };

/**
 * File a reference against a brief.
 *
 * The brief is read back inside the tenant first, so a brief id from another
 * organisation cannot be given a file. A reference IS its media: there is no
 * link and no note-only reference, because a reference to a page nothing can
 * read is not a reference.
 */
export async function addReference(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  kind: string;
  note: string | null;
  media: { bytes: Buffer; type: string; name: string | null } | null;
}): Promise<ReferenceOutcome> {
  if (!isReferenceKind(opts.kind)) {
    return { ok: false, code: "KIND_UNKNOWN", message: "That is not a kind of reference." };
  }

  const verdict = canAddReference({
    mediaType: opts.media?.type ?? null,
    mediaBytes: opts.media?.bytes.byteLength ?? 0,
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  const note = textOrNull(opts.note);
  const media = opts.media!;

  const result = await withTenant(opts.orgId, async (sql) => {
    const [brief] = await sql<{ id: string }[]>`
      SELECT id FROM campaign_briefs WHERE org_id = ${opts.orgId} AND id = ${opts.briefId}
    `;
    if (!brief) {
      return { ok: false as const, code: "BRIEF_UNKNOWN", message: "That brief is not in this organisation." };
    }

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO campaign_references
        (org_id, brief_id, kind, note, media, media_type, media_name, created_by)
      VALUES (
        ${opts.orgId}, ${opts.briefId}, ${opts.kind}, ${note},
        ${media.bytes}, ${media.type}, ${media.name}, ${opts.actorUserId}
      )
      RETURNING id
    `;
    return { ok: true as const, referenceId: row.id };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not file that reference.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "campaign.reference_added",
      targetType: "campaign_brief",
      targetId: opts.briefId,
      // No note and no file name in the metadata: a reference can name a
      // person or a competitor, and audit_log is the one table that must
      // carry no free text somebody typed.
      metadata: { kind: opts.kind, mediaType: media.type, bytes: media.bytes.byteLength },
    });
  }
  return result;
}

export async function removeReference(opts: {
  orgId: string;
  actorUserId: string;
  referenceId: string;
  /** The brief it must belong to, when the caller checked access on that brief. */
  briefId?: string;
}): Promise<{ ok: boolean; briefId: string | null }> {
  if (!isNodeId(opts.referenceId)) return { ok: false, briefId: null };
  if (opts.briefId !== undefined && !isNodeId(opts.briefId)) return { ok: false, briefId: null };

  const [row] = await withTenant(opts.orgId, async (sql) => {
    return sql<{ brief_id: string }[]>`
      DELETE FROM campaign_references
      WHERE org_id = ${opts.orgId} AND id = ${opts.referenceId}
        ${opts.briefId !== undefined ? sql`AND brief_id = ${opts.briefId}` : sql``}
      RETURNING brief_id
    `;
  }).catch(() => []);

  if (row) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "campaign.reference_removed",
      targetType: "campaign_brief",
      targetId: row.brief_id,
    });
  }
  return { ok: !!row, briefId: row?.brief_id ?? null };
}
