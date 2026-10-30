import { withTenant, audit } from "./db/index.ts";
import { canPublish } from "./publish-gate.ts";
import { isNodeId } from "./scope-rules.ts";
import { LINKED_REFUSAL, linkedSource, linkedTo } from "./linked.ts";
import {
  asList,
  BRAIN_FIELDS,
  canPublishDraft,
  canSignGroup,
  fieldByKey,
  groupHash,
  groupStates,
  groupsFor,
  inheritedFrom,
  matchesFiling,
  mergeInherited,
  parseValue,
  possessionBeforeCompletion,
  withInherited,
  type FieldGroup,
  type FieldValues,
  type GroupState,
  type InheritedBrain,
  type Signature,
} from "./brain-rules.ts";
import type { ScopeKind } from "./roles.ts";

/**
 * Reading and writing the Project Brain.
 *
 * Two rules run through everything here.
 *
 * **A draft is invisible.** `resolveBrain` filters to PUBLISHED, so no
 * surface that quotes can reach a fact nobody signed. That is not a
 * presentation choice: it is the only reason the signatures mean anything.
 *
 * **Publishing asks two questions.** `canPublishDraft` answers the ones about
 * the facts themselves, and `canPublish` answers whether Section 3 permits
 * advertising this phase at all. Both must pass, and the second one is why
 * this module exists in the same repository as the RERA gate rather than
 * beside a campaign builder.
 *
 * Imports are relative because `check:brain` loads `resolveBrain` straight
 * from source, outside Next, where the `@/` alias does not resolve. What that
 * function refuses to return is the whole guarantee, so it is checked as
 * itself rather than through a reimplementation.
 */

export type BrainVersionState = "DRAFT" | "PUBLISHED" | "SUPERSEDED";

export type BrainVersion = {
  id: string;
  version: number;
  state: BrainVersionState;
  values: FieldValues;
  createdAt: string;
  publishedAt: string | null;
  publishedByName: string | null;
};

/** One row of the version list, without its values. */
export type BrainVersionRow = {
  id: string;
  version: number;
  state: BrainVersionState;
  publishedAt: string | null;
  publishedByName: string | null;
};

export type BrainView = {
  node: {
    id: string;
    name: string;
    kind: ScopeKind;
    path: string;
    projectId: string | null;
    /** An exempt phase: it registers nothing, so it has no RERA facts. */
    exempt: boolean;
  };
  /** Every version, newest first. What the picker lists. */
  versions: BrainVersionRow[];
  draft: BrainVersion | null;
  published: BrainVersion | null;
  /** The version being looked at. The live one unless another was asked for. */
  selected: BrainVersion | null;
  signatures: Signature[];
  groups: GroupState[];
  /** What the nodes above publish, and which node each answer came from. */
  inherited: InheritedBrain;
};

type Sql = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * The published facts of every node strictly above `path`, with each node's
 * name. The `resolveBrain()` query without the node itself: what a draft here
 * would inherit if it set nothing.
 */
async function ancestorsOf(sql: Sql, orgId: string, path: string): Promise<InheritedBrain> {
  const rows = await sql<
    { version_id: string; path: string; name: string; field_key: string; value: string | null }[]
  >`
    SELECT v.id AS version_id, n.path::text AS path, n.name, f.field_key, f.value
    FROM brain_versions v
    JOIN scope_nodes n  ON n.id = v.scope_node_id
    JOIN brain_fields f ON f.brain_version_id = v.id
    WHERE v.org_id = ${orgId}
      AND v.state = 'PUBLISHED'
      AND n.path @> ${path}::ltree
      AND n.path <> ${path}::ltree
  `;
  const layers = new Map<string, { path: string; name: string; values: FieldValues }>();
  for (const r of rows) {
    const layer = layers.get(r.version_id) ?? { path: r.path, name: r.name, values: {} };
    layer.values[r.field_key] = r.value;
    layers.set(r.version_id, layer);
  }
  return inheritedFrom([...layers.values()]);
}

/**
 * What a node inherits from the nodes above it, with where each fact came
 * from. Null for a node that is not in this organisation.
 */
export async function inheritedBrain(
  orgId: string,
  nodeId: string,
): Promise<InheritedBrain | null> {
  if (!isNodeId(nodeId)) return null;
  return withTenant(orgId, async (sql) => {
    const [node] = await sql<{ path: string }[]>`
      SELECT path::text AS path FROM scope_nodes
      WHERE org_id = ${orgId} AND id = ${nodeId.trim()}
    `;
    return node ? ancestorsOf(sql, orgId, node.path) : null;
  });
}

export type BrainNode = { id: string; name: string; kind: ScopeKind; path: string; exempt: boolean };

/**
 * The node a Brain hangs off, and whether it is an exempt phase. Read inside
 * the tenant, so an id from a form naming anything else resolves to nothing.
 */
export async function brainNode(orgId: string, nodeId: string): Promise<BrainNode | null> {
  if (!isNodeId(nodeId)) return null;
  const [row] = await withTenant(orgId, async (sql) =>
    sql<{ id: string; name: string; kind: ScopeKind; path: string; exempt: boolean | null }[]>`
      SELECT n.id, n.name, n.kind, n.path::text AS path,
             (n.kind = 'PHASE' AND r.status = 'EXEMPT') AS exempt
      FROM scope_nodes n
      LEFT JOIN registration_records r ON r.scope_node_id = n.id
      WHERE n.org_id = ${orgId} AND n.id = ${nodeId.trim()}
    `,
  );
  return row ? { ...row, exempt: row.exempt === true } : null;
}

export type BrainOutcome =
  | { ok: true; versionId: string; version: number }
  | { ok: false; code: string; message: string };

/** Same, plus whether this call is what created the draft. */
export type DraftOutcome =
  | { ok: true; versionId: string; version: number; opened: boolean }
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function valuesFor(
  sql: Parameters<Parameters<typeof withTenant>[1]>[0],
  versionIds: readonly string[],
): Promise<Map<string, FieldValues>> {
  const byVersion = new Map<string, FieldValues>();
  if (versionIds.length === 0) return byVersion;

  const rows = await sql<{ brain_version_id: string; field_key: string; value: string | null }[]>`
    SELECT brain_version_id, field_key, value
    FROM brain_fields
    WHERE brain_version_id = ANY(${versionIds as string[]})
  `;
  for (const r of rows) {
    const bag = byVersion.get(r.brain_version_id) ?? {};
    bag[r.field_key] = r.value;
    byVersion.set(r.brain_version_id, bag);
  }
  return byVersion;
}

/**
 * One node's Brain: every version, the one being looked at, and the state of
 * each group in the draft.
 *
 * `wantVersion` picks which version to show. Nothing is published on a new
 * node, so it falls back to the live one, then to the draft: a screen that
 * opens on nothing when there is something to show is a screen that looks
 * broken.
 */
export async function loadBrain(
  orgId: string,
  nodeId: string,
  wantVersion?: number,
): Promise<BrainView | null> {
  // An address typed by hand reaches a uuid comparison, and Postgres raises on
  // a malformed one rather than finding nothing. Nothing is the answer.
  if (!isNodeId(nodeId)) return null;
  nodeId = nodeId.trim();

  return withTenant(orgId, async (sql) => {
    const [node] = await sql<
      {
        id: string;
        name: string;
        kind: ScopeKind;
        path: string;
        project_id: string | null;
        exempt: boolean | null;
      }[]
    >`
      SELECT n.id, n.name, n.kind, n.path::text AS path,
             (
               SELECT p.id
               FROM scope_nodes p
               WHERE p.org_id = ${orgId}
                 AND p.kind = 'PROJECT'
                 AND p.path @> n.path
               ORDER BY nlevel(p.path) DESC
               LIMIT 1
             ) AS project_id,
             (n.kind = 'PHASE' AND r.status = 'EXEMPT') AS exempt
      FROM scope_nodes n
      LEFT JOIN registration_records r ON r.scope_node_id = n.id
      WHERE n.org_id = ${orgId} AND n.id = ${nodeId}
    `;
    if (!node) return null;
    const exempt = node.exempt === true;
    const inherited = await ancestorsOf(sql, orgId, node.path);

    const rows = await sql<
      {
        id: string;
        version: number;
        state: BrainVersionState;
        created_at: Date;
        published_at: Date | null;
        published_by_name: string | null;
      }[]
    >`
      SELECT v.id, v.version, v.state, v.created_at, v.published_at,
             u.name AS published_by_name
      FROM brain_versions v
      LEFT JOIN users u ON u.id = v.published_by
      WHERE v.org_id = ${orgId} AND v.scope_node_id = ${nodeId}
      ORDER BY v.version DESC
    `;

    const draftRow = rows.find((v) => v.state === "DRAFT") ?? null;
    const publishedRow = rows.find((v) => v.state === "PUBLISHED") ?? null;
    const selectedRow =
      (wantVersion ? rows.find((v) => v.version === wantVersion) : null) ??
      publishedRow ??
      draftRow;

    // Only the versions actually being rendered, rather than every version
    // ever published: the history can be long and nothing reads the rest.
    const wanted = [draftRow, publishedRow, selectedRow]
      .filter((v): v is (typeof rows)[number] => v !== null)
      .map((v) => v.id);
    const values = await valuesFor(sql, [...new Set(wanted)]);

    const sigRows = draftRow
      ? await sql<
          {
            field_group: FieldGroup;
            group_hash: string;
            signed_by: string;
            signed_at: Date;
            name: string | null;
          }[]
        >`
          SELECT s.field_group, s.group_hash, s.signed_by, s.signed_at, u.name
          FROM brain_signatures s
          LEFT JOIN users u ON u.id = s.signed_by
          WHERE s.org_id = ${orgId} AND s.brain_version_id = ${draftRow.id}
        `
      : [];

    const shape = (row: (typeof rows)[number]): BrainVersion => ({
      id: row.id,
      version: row.version,
      state: row.state,
      values: values.get(row.id) ?? {},
      createdAt: row.created_at.toISOString(),
      publishedAt: row.published_at?.toISOString() ?? null,
      publishedByName: row.published_by_name,
    });

    const draft = draftRow ? shape(draftRow) : null;
    const published = publishedRow ? shape(publishedRow) : null;

    const signatures: Signature[] = sigRows.map((s) => ({
      group: s.field_group,
      groupHash: s.group_hash,
      signedBy: s.signed_by,
      signedByName: s.name,
      signedAt: s.signed_at.toISOString(),
    }));

    return {
      node: {
        id: node.id,
        name: node.name,
        kind: node.kind,
        path: node.path,
        projectId: node.project_id,
        exempt,
      },
      inherited,
      versions: rows.map((v) => ({
        id: v.id,
        version: v.version,
        state: v.state,
        publishedAt: v.published_at?.toISOString() ?? null,
        publishedByName: v.published_by_name,
      })),
      draft,
      published,
      selected: selectedRow ? shape(selectedRow) : null,
      signatures,
      groups: groupStates({
        draft: draft?.values ?? {},
        published: published?.values ?? null,
        signatures,
        nodeKind: node.kind,
        exempt,
      }),
    };
  });
}

export type ResolvedBrain = {
  /** Which published version each fact came from, deepest node winning. */
  sources: { versionId: string; path: string; version: number }[];
  values: FieldValues;
  /** When the facts were read, so a quote can pin it. */
  readAt: string;
};

/**
 * The Brain as every consumer sees it.
 *
 * PUBLISHED only. A draft field is invisible here, and that is the whole
 * guarantee: a price nobody signed cannot reach a quote, a reply or a
 * creative, however it got typed in.
 *
 * Facts inherit down the tree. A price on the project applies to every tower
 * under it until a tower sets its own, which is `path @> $target` with the
 * deepest node winning.
 */
export async function resolveBrain(
  orgId: string,
  nodeId: string,
): Promise<ResolvedBrain | null> {
  if (!isNodeId(nodeId)) return null;
  // A channel partner's linked project or tower says what the developer signed.
  const source = await linkedSource(orgId, nodeId.trim());
  if (source) return resolveBrain(source.orgId, source.nodeId);
  return withTenant(orgId, async (sql) => {
    const [node] = await sql<{ path: string }[]>`
      SELECT path::text AS path FROM scope_nodes
      WHERE org_id = ${orgId} AND id = ${nodeId.trim()}
    `;
    if (!node) return null;

    const rows = await sql<
      {
        version_id: string;
        version: number;
        path: string;
        field_key: string;
        value: string | null;
      }[]
    >`
      SELECT v.id AS version_id, v.version, n.path::text AS path,
             f.field_key, f.value
      FROM brain_versions v
      JOIN scope_nodes n   ON n.id = v.scope_node_id
      JOIN brain_fields f  ON f.brain_version_id = v.id
      WHERE v.org_id = ${orgId}
        AND v.state = 'PUBLISHED'
        AND n.path @> ${node.path}::ltree
      ORDER BY nlevel(n.path)
    `;

    const layers = new Map<string, { path: string; version: number; values: FieldValues }>();
    for (const r of rows) {
      const layer = layers.get(r.version_id) ?? {
        path: r.path,
        version: r.version,
        values: {} as FieldValues,
      };
      layer.values[r.field_key] = r.value;
      layers.set(r.version_id, layer);
    }

    return {
      sources: [...layers].map(([versionId, l]) => ({
        versionId,
        path: l.path,
        version: l.version,
      })),
      values: mergeInherited([...layers.values()]),
      readAt: new Date().toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Open a draft, or return the one already open.
 *
 * A new draft starts as a copy of the live version rather than empty. The
 * alternative asks somebody to retype nine facts to change one, and retyping
 * is how a digit goes missing.
 */
export async function openDraft(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
}): Promise<DraftOutcome> {
  // A channel partner's linked project or tower is the developer's to say.
  const linked = await linkedTo(opts.orgId, opts.nodeId);
  if (linked) return { ok: false, code: "LINKED", message: LINKED_REFUSAL(linked.developer) };
  const result = await withTenant(opts.orgId, async (sql) => {
    const [node] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.nodeId}
    `;
    if (!node) {
      return { ok: false as const, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
    }

    const [existing] = await sql<{ id: string; version: number }[]>`
      SELECT id, version FROM brain_versions
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.nodeId} AND state = 'DRAFT'
    `;
    if (existing) {
      return { ok: true as const, versionId: existing.id, version: existing.version, opened: false };
    }

    const [top] = await sql<{ next: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS next FROM brain_versions
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.nodeId}
    `;

    const [created] = await sql<{ id: string }[]>`
      INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
      VALUES (${opts.orgId}, ${opts.nodeId}, ${top.next}, 'DRAFT', ${opts.actorUserId})
      RETURNING id
    `;

    // Carry the live values forward, so a draft starts from what is true,
    // and where each came from with it: a price read off page 2 of the price
    // list is still from page 2 in the next version.
    await sql`
      INSERT INTO brain_fields (brain_version_id, org_id, field_key, value, updated_by,
        source_asset, source_page, source_bbox, extractor, model_version, confidence)
      SELECT ${created.id}, ${opts.orgId}, f.field_key, f.value, ${opts.actorUserId},
        f.source_asset, f.source_page, f.source_bbox, f.extractor, f.model_version, f.confidence
      FROM brain_fields f
      JOIN brain_versions v ON v.id = f.brain_version_id
      WHERE v.org_id = ${opts.orgId} AND v.scope_node_id = ${opts.nodeId}
        AND v.state = 'PUBLISHED'
    `;

    // A phase's registration number is already on the record the gate reads,
    // so a draft starts from the filing rather than from somebody retyping
    // it. The carry-forward above wins, because a published value is what
    // was signed. Nothing here for a project: it holds no registration. Nor
    // for an exempt phase: a number left on its record from before the
    // exemption is not one it may print.
    await sql`
      INSERT INTO brain_fields (brain_version_id, org_id, field_key, value, updated_by)
      SELECT ${created.id}, ${opts.orgId}, 'rera.registration_no',
             r.registration_no, ${opts.actorUserId}
      FROM registration_records r
      JOIN scope_nodes n ON n.id = r.scope_node_id AND n.kind = 'PHASE'
      WHERE r.org_id = ${opts.orgId} AND r.scope_node_id = ${opts.nodeId}
        AND r.registration_no IS NOT NULL
        AND r.status <> 'EXEMPT'
      ON CONFLICT (brain_version_id, field_key) DO NOTHING
    `;

    return { ok: true as const, versionId: created.id, version: top.next, opened: true };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not open a draft.",
  }));

  if (result.ok && result.opened) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "brain.draft_opened",
      targetType: "scope_node",
      targetId: opts.nodeId,
      metadata: { version: result.version },
    });
  }
  return result;
}

/**
 * Save one group's fields into the draft.
 *
 * Saved per group because that is the unit a person signs. Writing all nine
 * fields on every save would invalidate three signatures to change one price.
 */
export async function saveGroup(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
  group: FieldGroup;
  input: Record<string, unknown>;
}): Promise<BrainOutcome> {
  const parsed: { key: string; value: string | null }[] = [];
  for (const def of BRAIN_FIELDS.filter((f) => f.group === opts.group)) {
    const result = parseValue(def.key, opts.input[def.key]);
    if (!result.ok) {
      return { ok: false, code: "VALUE_INVALID", message: result.message };
    }
    parsed.push({ key: def.key, value: result.value });
  }

  const opened = await openDraft(opts);
  if (!opened.ok) return opened;

  const result = await withTenant(opts.orgId, async (sql) => {
    for (const f of parsed) {
      await sql`
        INSERT INTO brain_fields (brain_version_id, org_id, field_key, value, updated_by, updated_at)
        VALUES (${opened.versionId}, ${opts.orgId}, ${f.key}, ${f.value}, ${opts.actorUserId}, now())
        ON CONFLICT (brain_version_id, field_key) DO UPDATE
          SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now(),
              -- A value somebody changed is no longer the one the page said.
              source_asset  = CASE WHEN brain_fields.value IS NOT DISTINCT FROM EXCLUDED.value THEN brain_fields.source_asset END,
              source_page   = CASE WHEN brain_fields.value IS NOT DISTINCT FROM EXCLUDED.value THEN brain_fields.source_page END,
              source_bbox   = CASE WHEN brain_fields.value IS NOT DISTINCT FROM EXCLUDED.value THEN brain_fields.source_bbox END,
              extractor     = CASE WHEN brain_fields.value IS NOT DISTINCT FROM EXCLUDED.value THEN brain_fields.extractor END,
              model_version = CASE WHEN brain_fields.value IS NOT DISTINCT FROM EXCLUDED.value THEN brain_fields.model_version END,
              confidence    = CASE WHEN brain_fields.value IS NOT DISTINCT FROM EXCLUDED.value THEN brain_fields.confidence END
      `;
    }
    // A value read from a document and changed here was decided by the
    // person who changed it: corrected, or emptied and so rejected. A line
    // taken out of a list was rejected. What they left alone stays
    // unreviewed, because saving a form is not looking at a page.
    for (const f of parsed) {
      const def = fieldByKey(f.key);
      const open = await sql<{ id: string; value: string }[]>`
        SELECT id, value FROM brain_proposals
        WHERE brain_version_id = ${opened.versionId} AND field_key = ${f.key} AND state = 'PROPOSED' AND in_draft`;
      for (const p of open) {
        if (def?.type === "LIST") {
          const kept = asList(f.value).some((l) => l.toLowerCase() === p.value.toLowerCase());
          if (kept) continue;
          await sql`UPDATE brain_proposals SET state = 'REJECTED', decided_by = ${opts.actorUserId}, decided_at = now() WHERE id = ${p.id}`;
        } else if (f.value !== p.value) {
          await sql`
            UPDATE brain_proposals
            SET state = ${f.value === null ? "REJECTED" : "CORRECTED"}, corrected_value = ${f.value},
                decided_by = ${opts.actorUserId}, decided_at = now()
            WHERE id = ${p.id}`;
        }
      }
    }
    return { ok: true as const, versionId: opened.versionId, version: opened.version };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not save those facts.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "brain.draft_edited",
      targetType: "scope_node",
      targetId: opts.nodeId,
      // The keys that were touched, never the values: a price belongs in the
      // version, and an audit row outlives it.
      metadata: {
        version: opened.version,
        group: opts.group,
        fields: parsed.map((f) => f.key),
      },
    });
  }
  return result;
}

/**
 * Sign one group.
 *
 * The signature pins the hash of what was on screen. An edit afterwards moves
 * the hash, the signature stops matching, and the group has to be signed
 * again: a signature is a statement about values, not about a version number.
 */
export async function signGroup(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
  group: FieldGroup;
  /** The hash the signer was shown, so a change mid-review is caught. */
  expectedHash: string;
}): Promise<BrainOutcome> {
  const result = await withTenant(opts.orgId, async (sql) => {
    const [draft] = await sql<{ id: string; version: number }[]>`
      SELECT id, version FROM brain_versions
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.nodeId} AND state = 'DRAFT'
    `;
    if (!draft) {
      return { ok: false as const, code: "NO_DRAFT", message: "There is no draft to sign." };
    }

    const rows = await sql<{ field_key: string; value: string | null }[]>`
      SELECT field_key, value FROM brain_fields WHERE brain_version_id = ${draft.id}
    `;
    const values: FieldValues = {};
    for (const r of rows) values[r.field_key] = r.value;

    const [node] = await sql<
      { kind: ScopeKind; path: string; status: string | null; registration_no: string | null }[]
    >`
      SELECT n.kind, n.path::text AS path, r.status, r.registration_no
      FROM scope_nodes n
      LEFT JOIN registration_records r ON r.scope_node_id = n.id
      WHERE n.org_id = ${opts.orgId} AND n.id = ${opts.nodeId}
    `;
    if (!node) {
      return { ok: false as const, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
    }
    const exempt = node.kind === "PHASE" && node.status === "EXEMPT";
    if (!groupsFor(node.kind, exempt).some((g) => g.key === opts.group)) {
      return {
        ok: false as const,
        code: "GROUP_NOT_HERE",
        message: exempt
          ? "This phase is exempt, so it has no RERA facts to sign."
          : "That section does not belong on this Brain.",
      };
    }
    const inherited = await ancestorsOf(sql, opts.orgId, node.path);

    // A value read from a document is not signed until somebody has looked
    // at it beside its page. Signing it unread would make the signature
    // attest to what the reader thought the page said.
    const unreviewed = await unreviewedFields(sql, draft.id);
    const here = unreviewed.filter((k) => fieldByKey(k)?.group === opts.group);
    if (here.length) {
      return { ok: false as const, code: "UNREVIEWED", message: unreviewedMessage(here) };
    }

    // Nothing to sign yet. The screen should never offer it, but a rule that
    // holds only while the markup is arranged a particular way is not a rule.
    const signable = canSignGroup(opts.group, values, inherited.values);
    if (!signable.ok) {
      return { ok: false as const, code: signable.code, message: signable.message };
    }

    // The checks publishing makes on these facts, made here too. A signature
    // on a registration number nobody filed, or on a possession date the
    // filing does not support, looked exactly like a good one until somebody
    // pressed Publish, and the person who signed it had long gone.
    if (opts.group === "RERA") {
      const filing = matchesFiling({
        draft: values,
        filed: node.registration_no,
        nodeKind: node.kind,
        exempt,
      });
      if (!filing.ok) return { ok: false as const, code: filing.code, message: filing.message };
    }
    if (opts.group === "RERA" || opts.group === "CLAIMS") {
      const possession = possessionBeforeCompletion(withInherited(inherited.values, values), {
        nodeKind: node.kind,
        exempt,
      });
      if (!possession.ok) {
        return { ok: false as const, code: possession.code, message: possession.message };
      }
    }

    const hash = groupHash(opts.group, values);
    // Somebody edited the group between it being rendered and the click. The
    // signer has to see what they are signing, so this is a refusal rather
    // than a signature against values nobody read.
    if (opts.expectedHash && opts.expectedHash !== hash) {
      return {
        ok: false as const,
        code: "CHANGED_UNDER_YOU",
        message: "These facts changed while you were reading them. Look again before signing.",
      };
    }

    // Append, never replace. Signing the same values twice is the same
    // statement, so it collapses; signing different values after an edit adds
    // a row beside the old one, and the old one stays attached to the values
    // it actually attested to.
    await sql`
      INSERT INTO brain_signatures (brain_version_id, org_id, field_group, group_hash, signed_by)
      VALUES (${draft.id}, ${opts.orgId}, ${opts.group}, ${hash}, ${opts.actorUserId})
      ON CONFLICT (brain_version_id, field_group, group_hash) DO NOTHING
    `;

    return { ok: true as const, versionId: draft.id, version: draft.version, hash };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not record that signature.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "brain.signed",
      targetType: "scope_node",
      targetId: opts.nodeId,
      metadata: { version: result.version, group: opts.group, group_hash: result.hash },
    });
  }
  return result;
}

/** Fields of a draft holding a value read from a document that nobody has checked. */
async function unreviewedFields(sql: Sql, versionId: string): Promise<string[]> {
  const rows = await sql<{ field_key: string }[]>`
    SELECT DISTINCT field_key FROM brain_proposals
    WHERE brain_version_id = ${versionId} AND state = 'PROPOSED' AND in_draft`;
  return rows.map((r) => r.field_key);
}

function unreviewedMessage(keys: readonly string[]): string {
  const labels = keys.map((k) => fieldByKey(k)?.label ?? k);
  return `${labels.join(", ")} ${labels.length === 1 ? "was" : "were"} read from a document and ${
    labels.length === 1 ? "has" : "have"
  } not been checked yet. Check ${labels.length === 1 ? "it" : "them"} under Documents first.`;
}

/**
 * Make the draft live.
 *
 * Two gates, and the second is the one Section 3 cares about. The phase must
 * be advertisable before its facts become the ones every creative is built
 * from, because a published Brain on a blocked phase is a set of approved
 * claims with nothing lawful to say them in.
 */
export async function publishBrain(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
}): Promise<BrainOutcome> {
  // A channel partner's linked project or tower is the developer's to say.
  const linked = await linkedTo(opts.orgId, opts.nodeId);
  if (linked) return { ok: false, code: "LINKED", message: LINKED_REFUSAL(linked.developer) };
  const view = await loadBrain(opts.orgId, opts.nodeId);
  if (!view) {
    return { ok: false, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
  }
  if (!view.draft) {
    return { ok: false, code: "NO_DRAFT", message: "There is no draft to publish." };
  }
  const unreviewed = await withTenant(opts.orgId, (sql) => unreviewedFields(sql, view.draft!.id));
  if (unreviewed.length) {
    return { ok: false, code: "UNREVIEWED", message: unreviewedMessage(unreviewed) };
  }

  const verdict = canPublishDraft({
    draft: view.draft.values,
    published: view.published?.values ?? null,
    signatures: view.signatures,
    nodeKind: view.node.kind,
    exempt: view.node.exempt,
    // What the tower's advertisements carry is its own draft over what the
    // project publishes, so that is what the possession rule measures.
    inherited: view.inherited.values,
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  // The RERA gate. Asked of the phase itself, and of nothing else: a Brain
  // authored on the project inherits down to phases that each answer for
  // their own registration, so the gate belongs where the registration is.
  if (view.node.kind === "PHASE") {
    const gate = await canPublish(opts.orgId, opts.nodeId);
    if (!gate.ok) {
      return { ok: false, code: gate.code, message: gate.message };
    }

    // Two different questions, and the gate only answers the first. A phase
    // may be advertisable and still carry a Brain naming somebody else's
    // registration, which prints a false number on lawful advertising. The
    // signature does not catch it: whoever signs the RERA facts is reading
    // the form, not the record.
    const filing = matchesFiling({
      draft: view.draft.values,
      filed: gate.registrationNo,
      nodeKind: view.node.kind,
      exempt: view.node.exempt,
    });
    if (!filing.ok) {
      return { ok: false, code: filing.code, message: filing.message };
    }
  }

  const result = await withTenant(opts.orgId, async (sql) => {
    await sql`
      UPDATE brain_versions SET state = 'SUPERSEDED', superseded_at = now()
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.nodeId} AND state = 'PUBLISHED'
    `;
    await sql`
      UPDATE brain_versions
      SET state = 'PUBLISHED', published_by = ${opts.actorUserId}, published_at = now()
      WHERE id = ${view.draft!.id}
    `;
    return { ok: true as const, versionId: view.draft!.id, version: view.draft!.version };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not publish that version.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "brain.published",
      targetType: "scope_node",
      targetId: opts.nodeId,
      metadata: {
        version: result.version,
        changed: verdict.changed,
        signed_groups: view.signatures.map((s) => s.group),
      },
    });
  }
  return result;
}

/**
 * Which nodes have a Brain, and at what version.
 *
 * One query for a whole screen, so a project page can say "version 2 live" or
 * "nothing published yet" per tower without asking per row. A link that does
 * not say whether the thing behind it has been done is a link people stop
 * clicking.
 */
export type BrainSummary = { published: number | null; draft: number | null };

export async function brainSummaries(
  orgId: string,
  nodeIds: readonly string[],
): Promise<Map<string, BrainSummary>> {
  const byNode = new Map<string, BrainSummary>();
  if (nodeIds.length === 0) return byNode;

  const rows = await withTenant(orgId, async (sql) => {
    return sql<{ scope_node_id: string; version: number; state: BrainVersionState }[]>`
      SELECT scope_node_id, version, state
      FROM brain_versions
      WHERE org_id = ${orgId}
        AND scope_node_id = ANY(${nodeIds as string[]})
        AND state <> 'SUPERSEDED'
    `;
  });

  for (const r of rows) {
    const current = byNode.get(r.scope_node_id) ?? { published: null, draft: null };
    if (r.state === "PUBLISHED") current.published = r.version;
    else current.draft = r.version;
    byNode.set(r.scope_node_id, current);
  }
  return byNode;
}
