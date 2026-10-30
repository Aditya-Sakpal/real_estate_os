import { withTenant } from "./db/index.ts";

/**
 * A channel partner working a developer's project from its own console.
 *
 * The partner's own PROJECT and PHASE nodes carry its leads, briefs, posts,
 * ads and calls, on its own plan. What may be said about the building is the
 * developer's: each linked node (`linked_nodes`) reads the developer's
 * signed facts, approved prices and pictures and registration through the
 * link, in the developer's own tenant, and only while the developer's
 * empanelment of the partner for that project is live. The partner never
 * holds a copy, so nothing it holds can disagree with the developer, and the
 * day the empanelment ends its towers stop being advertisable.
 *
 * The readers that follow a link: `complianceSummary()`, `resolveBrain()`,
 * `approvedUnits()`, `approvedAssets()` and `loadReadiness()`. The writers
 * that refuse one: a Brain draft, a configuration, a registration, a tower.
 */

/** The developer's node a partner's node stands for, while the empanelment holds. */
export type LinkedSource = { orgId: string; nodeId: string; projectId: string; developer: string };

/** A partner's linked node, as read in its own tenant. */
export type LinkRow = { nodeId: string; path: string; kind: string; sourceOrgId: string; sourceNodeId: string; sourceProjectId: string };

const TTL_MS = 30_000;
/** An organisation with no links is asked again sooner, so a project added on another server is seen within seconds. */
const EMPTY_TTL_MS = 5_000;
const rowsCache = new Map<string, { at: number; rows: LinkRow[]; live: Set<string>; names: Map<string, string> }>();

/** Forget what was read about an organisation's links, after it changes them. */
export function forgetLinks(orgId: string): void {
  rowsCache.delete(orgId);
}

/**
 * Every link an organisation holds, which of them are live today, and each
 * developer's name. One read of three small tables, kept half a minute: the
 * readers ask on every page, and an organisation with no links answers from
 * an empty list.
 */
export async function linksOf(orgId: string): Promise<{ rows: LinkRow[]; live: Set<string>; names: Map<string, string> }> {
  const hit = rowsCache.get(orgId);
  if (hit && Date.now() - hit.at < (hit.rows.length ? TTL_MS : EMPTY_TTL_MS)) return hit;
  const got = await withTenant(orgId, async (sql) => {
    const rows = await sql<{ node_id: string; path: string; kind: string; source_org_id: string; source_node_id: string; source_project_id: string }[]>`
      SELECT l.scope_node_id AS node_id, n.path::text AS path, n.kind, l.source_org_id, l.source_node_id, l.source_project_id
      FROM linked_nodes l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId}`;
    if (!rows.length) return { rows: [], live: [], names: [] };
    // The grantee sees its own grants only while they are live (RLS), so
    // whatever this returns is an empanelment in force right now.
    const live = await sql<{ org_id: string; scope_node_id: string }[]>`
      SELECT org_id, scope_node_id FROM grants
      WHERE grantee_org_id = ${orgId} AND role = 'CHANNEL_PARTNER' AND status = 'ACTIVE'
        AND now() >= valid_from AND now() < valid_to`;
    const names = await sql<{ org_id: string; developer: string }[]>`SELECT org_id, developer FROM partner_developers_for_firm()`;
    return { rows, live, names };
  });
  const out = {
    at: Date.now(),
    rows: got.rows.map((r) => ({
      nodeId: r.node_id,
      path: r.path,
      kind: r.kind,
      sourceOrgId: r.source_org_id,
      sourceNodeId: r.source_node_id,
      sourceProjectId: r.source_project_id,
    })),
    live: new Set(got.live.map((g) => `${g.org_id}:${g.scope_node_id}`)),
    names: new Map(got.names.map((n) => [n.org_id, n.developer])),
  };
  rowsCache.set(orgId, out);
  return out;
}

const isLive = (l: { live: Set<string> }, r: LinkRow) => l.live.has(`${r.sourceOrgId}:${r.sourceProjectId}`);

/** The link a node stands under: itself, or the nearest linked node above it. */
function nearest(rows: LinkRow[], path: string): LinkRow | null {
  return rows
    .filter((r) => r.path === path || path.startsWith(`${r.path}.`))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

/**
 * The developer's node a partner's node reads through, or null when it is
 * not linked or the empanelment is not live. A node below a linked tower
 * (none today) reads through its tower.
 */
export async function linkedSource(orgId: string, nodeId: string): Promise<LinkedSource | null> {
  const l = await linksOf(orgId);
  if (!l.rows.length) return null;
  const own = l.rows.find((r) => r.nodeId === nodeId);
  let row = own ?? null;
  if (!row) {
    const [n] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
      SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}`);
    row = n ? nearest(l.rows, n.path) : null;
  }
  if (!row || !isLive(l, row)) return null;
  return { orgId: row.sourceOrgId, nodeId: row.sourceNodeId, projectId: row.sourceProjectId, developer: l.names.get(row.sourceOrgId) ?? "the developer" };
}

/** Whether a node is the developer's to change: linked, live or not. A lapsed link is still not the partner's to fill in. */
export async function linkedTo(orgId: string, nodeId: string): Promise<{ developer: string } | null> {
  const l = await linksOf(orgId);
  if (!l.rows.length) return null;
  const own = l.rows.find((r) => r.nodeId === nodeId);
  let row = own ?? null;
  if (!row) {
    const [n] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
      SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}`);
    row = n ? nearest(l.rows, n.path) : null;
  }
  return row ? { developer: l.names.get(row.sourceOrgId) ?? "the developer" } : null;
}

/** Every live linked tower, with the developer's tower it reads, grouped by developer. */
export async function linkedPhases(orgId: string): Promise<Map<string, { phaseId: string; sourcePhaseId: string }[]>> {
  const l = await linksOf(orgId);
  const out = new Map<string, { phaseId: string; sourcePhaseId: string }[]>();
  for (const r of l.rows) {
    if (r.kind !== "PHASE" || !isLive(l, r)) continue;
    const list = out.get(r.sourceOrgId) ?? [];
    list.push({ phaseId: r.nodeId, sourcePhaseId: r.sourceNodeId });
    out.set(r.sourceOrgId, list);
  }
  return out;
}

/** The partner's node for a developer's node, when one is linked: how a developer's asset is placed in the partner's tree. */
export async function ownNodeFor(orgId: string, sourceOrgId: string, sourceNodeId: string): Promise<{ id: string; path: string } | null> {
  const l = await linksOf(orgId);
  const r = l.rows.find((x) => x.sourceOrgId === sourceOrgId && x.sourceNodeId === sourceNodeId);
  return r ? { id: r.nodeId, path: r.path } : null;
}

export const LINKED_REFUSAL = (developer: string) =>
  `This comes from ${developer}'s own records. Only ${developer} can change it.`;
