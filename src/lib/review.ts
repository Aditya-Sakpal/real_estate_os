import { withTenant } from "./db/index.ts";
import type { Authz } from "./rbac-rules.ts";
import { fieldByKey } from "./brain-rules.ts";
import { docKindDef } from "./extract-rules.ts";
import { categoryDef } from "./asset-rules.ts";
import { unitLabel } from "./unit-rules.ts";
import { decideProposal, proposalPlace } from "./extract.ts";
import { approveAsset, assetPlace } from "./asset.ts";
import { approveUnitType, unitPlace } from "./unit.ts";
import { bulkLine, leastSureFirst, pickShown, type ReviewKind, type ReviewTotals } from "./review-rules.ts";

/**
 * One project's "Review and approve": what is waiting for a person's yes on
 * the project and every tower under it. See `review-rules.ts`.
 *
 * Each list holds only what the viewer may act on at that row's own place,
 * and a bulk press runs each row through its own screen's function, so the
 * checks that refuse one row there refuse it here.
 */

export type ReviewValue = {
  id: string;
  place: string;
  field: string;
  value: string;
  source: string;
  page: number;
  confidence: number;
  at: string;
};

export type ReviewPicture = { id: string; nodeId: string; place: string; title: string; category: string; video: boolean };

export type ReviewFlat = { id: string; place: string; label: string; carpet: number; price: number | null };

export type ReviewDraft = { nodeId: string; place: string; version: number };

export type ReviewView = {
  values: ReviewValue[];
  pictures: ReviewPicture[];
  flats: ReviewFlat[];
  drafts: ReviewDraft[];
  /** Places the person may add documents to: the project and its towers. */
  places: { id: string; name: string; kind: string }[];
  totals: ReviewTotals;
};

export async function loadReview(orgId: string, projectId: string, authz: Authz): Promise<ReviewView | null> {
  const got = await withTenant(orgId, async (sql) => {
    const nodes = await sql<{ id: string; name: string; kind: string; path: string }[]>`
      SELECT n.id, n.name, n.kind, n.path::text AS path
      FROM scope_nodes n JOIN scope_nodes p ON p.id = ${projectId} AND p.kind = 'PROJECT'
      WHERE n.org_id = ${orgId} AND n.path <@ p.path AND n.kind IN ('PROJECT', 'PHASE')
      ORDER BY nlevel(n.path), n.name`;
    if (nodes.length === 0) return null;
    const ids = nodes.map((n) => n.id);
    const [values, pictures, flats, drafts] = await Promise.all([
      sql<{ id: string; node_id: string; field_key: string; value: string; page: number; confidence: string; created_at: Date; doc_name: string; doc_kind: string }[]>`
        SELECT bp.id, bp.scope_node_id AS node_id, bp.field_key, bp.value, bp.page, bp.confidence::text, bp.created_at,
               d.name AS doc_name, d.kind AS doc_kind
        FROM brain_proposals bp JOIN brain_documents d ON d.id = bp.document_id
        WHERE bp.org_id = ${orgId} AND bp.state = 'PROPOSED' AND bp.scope_node_id = ANY(${ids})
        ORDER BY bp.created_at LIMIT 400`,
      sql<{ id: string; node_id: string; title: string | null; category: string; media_type: string; media_name: string | null }[]>`
        SELECT a.id, a.scope_node_id AS node_id, a.title, a.category, v.media_type, v.media_name
        FROM assets a
        JOIN LATERAL (SELECT sha256, media_type, media_name FROM asset_versions WHERE asset_id = a.id ORDER BY version DESC LIMIT 1) v ON true
        WHERE a.org_id = ${orgId} AND a.scope_node_id = ANY(${ids})
          AND NOT EXISTS (SELECT 1 FROM asset_approvals ap WHERE ap.asset_id = a.id AND ap.sha256 = v.sha256)
        ORDER BY a.uploaded_at LIMIT 400`,
      sql<{ id: string; node_id: string; config: string; variant: string | null; carpet: string; price: string | null }[]>`
        SELECT t.id, t.scope_node_id AS node_id, t.config, t.variant, v.carpet_area_sqft::text AS carpet, v.starting_price::text AS price
        FROM unit_types t
        JOIN LATERAL (SELECT sha256, carpet_area_sqft, starting_price FROM unit_type_versions WHERE unit_type_id = t.id ORDER BY version DESC LIMIT 1) v ON true
        WHERE t.org_id = ${orgId} AND t.scope_node_id = ANY(${ids})
          AND NOT EXISTS (SELECT 1 FROM unit_type_approvals ap WHERE ap.unit_type_id = t.id AND ap.sha256 = v.sha256)
        ORDER BY t.created_at LIMIT 400`,
      sql<{ node_id: string; version: number }[]>`
        SELECT scope_node_id AS node_id, version FROM brain_versions
        WHERE org_id = ${orgId} AND state = 'DRAFT' AND scope_node_id = ANY(${ids})`,
    ]);
    return { nodes, values, pictures, flats, drafts };
  });
  if (!got) return null;

  const node = new Map(got.nodes.map((n) => [n.id, n]));
  const placeOf = (id: string) => node.get(id)?.name ?? "";
  const may = (perm: string, id: string) => {
    const n = node.get(id);
    return !!n && authz.canAt(perm, n.path);
  };

  const values = leastSureFirst(
    got.values
      .filter((v) => may("brain:edit", v.node_id))
      .map((v) => ({
        id: v.id,
        place: placeOf(v.node_id),
        field: fieldByKey(v.field_key)?.label ?? v.field_key,
        value: v.value,
        source: `${docKindDef(v.doc_kind)?.label ?? v.doc_name}, ${v.doc_name}`,
        page: v.page,
        confidence: Number(v.confidence),
        at: v.created_at.toISOString(),
      })),
  );
  const pictures = got.pictures
    .filter((p) => may("asset:approve", p.node_id))
    .map((p) => ({
      id: p.id,
      nodeId: p.node_id,
      place: placeOf(p.node_id),
      title: p.title || p.media_name || categoryDef(p.category)?.label || "Untitled",
      category: categoryDef(p.category)?.label ?? p.category,
      video: p.media_type.startsWith("video/"),
    }));
  const flats = got.flats
    .filter((f) => may("brain.price:approve", f.node_id))
    .map((f) => ({
      id: f.id,
      place: placeOf(f.node_id),
      label: unitLabel(f),
      carpet: Number(f.carpet),
      price: f.price === null ? null : Number(f.price),
    }));
  const drafts = got.drafts
    .filter((d) => may("brain:read", d.node_id))
    .map((d) => ({ nodeId: d.node_id, place: placeOf(d.node_id), version: d.version }));
  const places = got.nodes.filter((n) => authz.canAt("brain:edit", n.path)).map((n) => ({ id: n.id, name: n.name, kind: n.kind }));

  return {
    values,
    pictures,
    flats,
    drafts,
    places,
    totals: { values: values.length, pictures: pictures.length, flats: flats.length, drafts: drafts.length },
  };
}

/**
 * Accept, or approve, every row the screen showed, one at a time through its
 * own function. The rows are read again here, so an id that was never on the
 * screen, or that somebody decided meanwhile, does nothing.
 */
export async function approveShown(opts: {
  orgId: string;
  userId: string;
  projectId: string;
  authz: Authz;
  kind: ReviewKind;
  ids: readonly unknown[];
}): Promise<{ done: number; message: string }> {
  const view = await loadReview(opts.orgId, opts.projectId, opts.authz);
  if (!view) return { done: 0, message: "That project is not here." };
  const listed =
    opts.kind === "VALUES" ? view.values.map((v) => v.id) : opts.kind === "PICTURES" ? view.pictures.map((p) => p.id) : view.flats.map((f) => f.id);
  const ids = pickShown(opts.ids, new Set(listed));

  let done = 0;
  const refused = { count: 0, first: null as string | null };
  const refuse = (m: string) => {
    refused.count += 1;
    refused.first ??= m;
  };
  for (const id of ids) {
    if (opts.kind === "VALUES") {
      const place = await proposalPlace(opts.orgId, id);
      if (!place || !opts.authz.canAt("brain:edit", place.path)) {
        refuse("You cannot change the facts there.");
        continue;
      }
      const r = await decideProposal({ orgId: opts.orgId, userId: opts.userId, proposalId: id, decision: { kind: "accept" } });
      if (r.ok) done += 1;
      else refuse(r.message);
    } else if (opts.kind === "PICTURES") {
      const place = await assetPlace(opts.orgId, id);
      if (!place || !opts.authz.canAt("asset:approve", place.path)) {
        refuse("You cannot approve pictures there.");
        continue;
      }
      const r = await approveAsset({ orgId: opts.orgId, actorUserId: opts.userId, assetId: id });
      if (r.ok) done += 1;
      else refuse(r.message);
    } else {
      const place = await unitPlace(opts.orgId, id);
      if (!place || !opts.authz.canAt("brain.price:approve", place.path)) {
        refuse("You cannot approve prices there.");
        continue;
      }
      const r = await approveUnitType({ orgId: opts.orgId, actorUserId: opts.userId, unitTypeId: id });
      if (r.ok) done += 1;
      else refuse(r.message);
    }
  }
  return { done, message: bulkLine(opts.kind, done, refused) };
}
