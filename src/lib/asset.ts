import { withTenant, audit } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import { linkedSource, ownNodeFor } from "./linked.ts";
import { putAsset, removeAsset, assetUrl, copyAsset, readAsset } from "./storage.ts";
import { projectOfNode } from "./storage-place.ts";
import { checkUpLockup } from "./rera-up.ts";
import {
  canUploadAsset,
  categoryDef,
  isAssetCategory,
  istDay,
  resolveLibrary,
  type AssetCategory,
} from "./asset-rules.ts";
import { unitLabel } from "./unit-rules.ts";
import type { ScopeKind } from "./roles.ts";

/**
 * Reading and writing the Approved Asset Library.
 *
 * Three rules run through everything here.
 *
 * **The bytes are not in the row.** `storage_key` names an object in a
 * private bucket, and a reader who has passed the permission check is handed
 * a link that expires in five minutes. What is stored is never a URL: a URL
 * that works in a browser works for anybody holding it, forever, unaudited.
 *
 * **An approval pins the hash, not the asset.** Replace the file and the
 * approval stops matching, so nothing built from it can claim to have been
 * approved. The same mechanism the Brain's signatures use.
 *
 * **A library is a union down the tree, not an override.** The project's site
 * plan and the tower's floor plan are both in force at the tower.
 *
 * Imports are relative because `check:assets` loads this straight from
 * source, outside Next, where the `@/` alias does not resolve.
 */

export type AssetNode = { id: string; kind: ScopeKind; name: string; path: string };

export type AssetRow = {
  id: string;
  nodeId: string;
  nodeName: string;
  path: string;
  category: AssetCategory;
  title: string | null;
  isRender: boolean;
  capturedOn: string | null;
  copiedFrom: string | null;

  /** Which configuration this depicts. Null means the whole tower. */
  unitTypeId: string | null;
  unitLabel: string | null;
  room: string | null;

  /** The newest version, which is the one in force. */
  version: number;
  versionCount: number;
  mediaType: string;
  mediaName: string | null;
  mediaBytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedByName: string | null;
  /** The developer whose approved bytes these are, on a channel partner's linked project. */
  sourceOrgId?: string;
};

export type AssetVersionRow = {
  version: number;
  mediaType: string;
  mediaName: string | null;
  mediaBytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedByName: string | null;
};

export type ApprovalRow = {
  assetId: string;
  sha256: string;
  byName: string | null;
  at: string;
};

export type LibraryView = {
  node: AssetNode;

  /** Filed on this node. */
  own: AssetRow[];

  /** Everything in force here, its own plus what travels down. */
  resolved: AssetRow[];
  approvals: ApprovalRow[];
};

export type AssetOutcome =
  | { ok: true; assetId: string }
  | { ok: false; code: string; message: string };

type DbAsset = {
  id: string;
  scope_node_id: string;
  node_name: string;
  path: string;
  category: AssetCategory;
  title: string | null;
  is_render: boolean;
  captured_on: Date | null;
  copied_from: string | null;
  unit_type_id: string | null;
  unit_config: string | null;
  unit_variant: string | null;
  room: string | null;
  version: number;
  version_count: number;
  media_type: string;
  media_name: string | null;
  media_bytes: string;
  sha256: string;
  uploaded_at: Date;
  uploaded_by_name: string | null;
};

const toRow = (r: DbAsset): AssetRow => ({
  id: r.id,
  nodeId: r.scope_node_id,
  nodeName: r.node_name,
  path: r.path,
  category: r.category,
  title: r.title,
  isRender: r.is_render,
  capturedOn: r.captured_on ? r.captured_on.toISOString().slice(0, 10) : null,
  copiedFrom: r.copied_from,
  unitTypeId: r.unit_type_id,
  unitLabel: r.unit_config
    ? unitLabel({ config: r.unit_config, variant: r.unit_variant })
    : null,
  room: r.room,
  version: r.version,
  versionCount: Number(r.version_count),
  mediaType: r.media_type,
  mediaName: r.media_name,
  mediaBytes: Number(r.media_bytes),
  sha256: r.sha256,
  uploadedAt: r.uploaded_at.toISOString(),
  uploadedByName: r.uploaded_by_name,
});

/**
 * One row per asset, carrying its newest version.
 *
 * `DISTINCT ON` with the version descending is how Postgres answers "the
 * latest of each" in one pass; a correlated subquery per asset would be a
 * query per tile.
 */

const CURRENT = `
  SELECT DISTINCT ON (av.asset_id)
         av.asset_id, av.version, av.storage_key, av.media_type, av.media_name,
         av.media_bytes, av.sha256, av.uploaded_at, av.uploaded_by,
         count(*) OVER (PARTITION BY av.asset_id) AS version_count
  FROM asset_versions av
  ORDER BY av.asset_id, av.version DESC
`;

// ---------------------------------------------------------------------------
// Reading

// ---------------------------------------------------------------------------

/**
 * The library in force at one node.
 *
 * The ancestor chain is read with `@>`, and `resolveLibrary()` decides what
 * actually travels: a site plan reaches every tower, a RERA lockup reaches
 * nothing below the phase it belongs to.
 */

export async function loadLibrary(orgId: string, nodeId: string): Promise<LibraryView | null> {
  if (!isNodeId(nodeId)) return null;
  return withTenant(orgId, async (sql) => {
    const [node] = await sql<AssetNode[]>`
      SELECT id, kind, name, path::text AS path
      FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}
    `;
    if (!node) return null;
    const rows = await sql<DbAsset[]>`
      SELECT a.id, a.scope_node_id, n.name AS node_name, n.path::text AS path,
             a.category, a.title, a.is_render, a.captured_on, a.copied_from,
             a.unit_type_id, t.config AS unit_config, t.variant AS unit_variant, a.room,
             cur.version, cur.version_count, cur.media_type, cur.media_name,
             cur.media_bytes, cur.sha256, cur.uploaded_at,
             u.name AS uploaded_by_name
      FROM assets a
      JOIN scope_nodes n ON n.id = a.scope_node_id
      LEFT JOIN unit_types t ON t.id = a.unit_type_id
      JOIN (${sql.unsafe(CURRENT)}) cur ON cur.asset_id = a.id
      LEFT JOIN users u ON u.id = cur.uploaded_by
      WHERE a.org_id = ${orgId} AND n.path @> ${node.path}::ltree
      ORDER BY cur.uploaded_at DESC
    `;
    const all = rows.map(toRow);
    const approvals = await sql<
      { asset_id: string; sha256: string; by_name: string | null; approved_at: Date }[]
    >`
      SELECT ap.asset_id, ap.sha256, u.name AS by_name, ap.approved_at
      FROM asset_approvals ap
      JOIN assets a ON a.id = ap.asset_id
      JOIN scope_nodes n ON n.id = a.scope_node_id
      LEFT JOIN users u ON u.id = ap.approved_by
      WHERE ap.org_id = ${orgId} AND n.path @> ${node.path}::ltree
      ORDER BY ap.approved_at DESC
    `;
    return {
      node,
      own: all.filter((a) => a.nodeId === node.id),
      resolved: resolveLibrary(all, node.path),
      approvals: approvals.map((a) => ({
        assetId: a.asset_id,
        sha256: a.sha256,
        byName: a.by_name,
        at: a.approved_at.toISOString(),
      })),
    };
  });
}

/**
 * A link to one asset's bytes, good for five minutes.
 *
 * The row is read through `withTenant()` first, so an asset id from another
 * organisation resolves to nothing and no link is ever signed for it.
 */

export async function assetLink(
  orgId: string,
  assetId: string,
  version?: number,
): Promise<{ url: string; type: string; key: string } | null> {
  if (!isNodeId(assetId)) return null;
  const [row] = await withTenant(orgId, async (sql) => {
    // Newest unless a version is named, so an old one can still be looked at
    // without becoming the one a creative is built from.
    return version
      ? sql<{ storage_key: string; media_type: string }[]>`
          SELECT storage_key, media_type FROM asset_versions
          WHERE org_id = ${orgId} AND asset_id = ${assetId} AND version = ${version}
          LIMIT 1
        `
      : sql<{ storage_key: string; media_type: string }[]>`
          SELECT storage_key, media_type FROM asset_versions
          WHERE org_id = ${orgId} AND asset_id = ${assetId}
          ORDER BY version DESC LIMIT 1
        `;
  });
  if (!row) return null;
  const signed = await assetUrl(row.storage_key, row.media_type);
  return signed.ok ? { url: signed.url, type: row.media_type, key: row.storage_key } : null;
}

/**
 * Where one asset is filed, for the permission check an action makes before
 * touching it. Holding `asset:manage` on one tower is not holding it on the
 * next, and an asset id from a form can name either.
 */
export async function assetPlace(
  orgId: string,
  assetId: string,
): Promise<{ nodeId: string; path: string } | null> {
  if (!isNodeId(assetId)) return null;
  const [row] = await withTenant(orgId, async (sql) => {
    return sql<{ node_id: string; path: string }[]>`
      SELECT n.id AS node_id, n.path::text AS path
      FROM assets a JOIN scope_nodes n ON n.id = a.scope_node_id
      WHERE a.org_id = ${orgId} AND a.id = ${assetId}
      LIMIT 1
    `;
  });
  return row ? { nodeId: row.node_id, path: row.path } : null;
}

/** Every version of one asset, newest first. */
export async function listVersions(
  orgId: string,
  assetId: string,
): Promise<AssetVersionRow[]> {
  if (!isNodeId(assetId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<
      {
        version: number;
        media_type: string;
        media_name: string | null;
        media_bytes: string;
        sha256: string;
        uploaded_at: Date;
        uploaded_by_name: string | null;
      }[]
    >`
      SELECT av.version, av.media_type, av.media_name, av.media_bytes, av.sha256,
             av.uploaded_at, u.name AS uploaded_by_name
      FROM asset_versions av
      LEFT JOIN users u ON u.id = av.uploaded_by
      WHERE av.org_id = ${orgId} AND av.asset_id = ${assetId}
      ORDER BY av.version DESC
    `;
  });
  return rows.map((r) => ({
    version: r.version,
    mediaType: r.media_type,
    mediaName: r.media_name,
    mediaBytes: Number(r.media_bytes),
    sha256: r.sha256,
    uploadedAt: r.uploaded_at.toISOString(),
    uploadedByName: r.uploaded_by_name,
  }));
}

/**
 * Only what a creative may actually be built from.
 *
 * The consumer read, and the one that makes "no approval, no render" true:
 * an asset whose current bytes carry no approval never comes back from here.
 */

export async function approvedAssets(orgId: string, nodeId: string): Promise<AssetRow[]> {
  const view = await loadLibrary(orgId, nodeId);
  const approved = new Set(view?.approvals.map((a) => `${a.assetId}:${a.sha256}`) ?? []);
  const own = view ? view.resolved.filter((a) => approved.has(`${a.id}:${a.sha256}`)) : [];
  // A channel partner's linked project or tower is built from what the
  // developer approved, each picture placed on the partner's own node for it
  // and carrying whose bytes they are, beside anything the partner approved.
  const source = await linkedSource(orgId, nodeId);
  if (!source) return own;
  const theirs = await approvedAssets(source.orgId, source.nodeId);
  const placed = await Promise.all(theirs.map(async (a): Promise<AssetRow | null> => {
    const mine = (await ownNodeFor(orgId, source.orgId, a.nodeId)) ?? (await ownNodeFor(orgId, source.orgId, source.projectId));
    return mine ? { ...a, nodeId: mine.id, path: mine.path, sourceOrgId: source.orgId } : null;
  }));
  return [...placed.filter((a): a is AssetRow => a !== null), ...own];
}

/**
 * The stored key of each asset's approved bytes, read in the tenant that
 * holds them: the partner's own, or the developer's for one it reads
 * through a link. Every reader that fetches a picture asks here.
 */
export async function assetKeys(
  orgId: string,
  assets: readonly Pick<AssetRow, "id" | "sha256" | "sourceOrgId">[],
): Promise<{ asset_id: string; sha256: string; version: number; storage_key: string }[]> {
  const byOrg = new Map<string, string[]>();
  for (const a of assets) {
    const o = a.sourceOrgId ?? orgId;
    byOrg.set(o, [...(byOrg.get(o) ?? []), a.id]);
  }
  const out = await Promise.all([...byOrg].map(([o, ids]) =>
    withTenant(o, (sql) => sql<{ asset_id: string; sha256: string; version: number; storage_key: string }[]>`
      SELECT asset_id, sha256, version, storage_key FROM asset_versions
      WHERE org_id = ${o} AND asset_id = ANY(${ids}::uuid[])`)));
  return out.flat();
}

// ---------------------------------------------------------------------------
// Writing

// ---------------------------------------------------------------------------

/**
 * Put a file in the library.
 *
 * The bytes go to the bucket first and the row second. That order is
 * deliberate: a row pointing at an object that was never written is a broken
 * asset in every screen that lists it, while an object with no row is an
 * orphan nobody can see, which a sweep can collect later.
 */

export async function addAsset(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
  category: string;
  title: string | null;
  isRender: boolean;
  capturedOn: string | null;
  media: { bytes: Buffer; type: string; name: string | null } | null;
}): Promise<AssetOutcome> {
  if (!isNodeId(opts.nodeId)) {
    return { ok: false, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
  }
  if (!isAssetCategory(opts.category)) {
    return { ok: false, code: "CATEGORY", message: "That is not a kind of asset." };
  }
  const node = await withTenant(opts.orgId, async (sql) => {
    const [n] = await sql<AssetNode[]>`
      SELECT id, kind, name, path::text AS path
      FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.nodeId}
    `;
    return n ?? null;
  });
  if (!node) {
    return { ok: false, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
  }
  const verdict = canUploadAsset({
    category: opts.category,
    nodeKind: node.kind,
    mediaType: opts.media?.type ?? null,
    mediaBytes: opts.media?.bytes.byteLength ?? 0,
    capturedOn: opts.capturedOn,
    today: istDay(new Date()),
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
  const media = opts.media!;
  // A photograph by nature is never a render, whatever the caller said. The
  // screen offers no choice for one, so an absent tick meant nothing, and
  // reading it as "render" put the artist's impression line on real photos.
  const isRender = categoryDef(opts.category)?.photographic ? false : opts.isRender;
  const id = crypto.randomUUID();
  const stored = await putAsset({
    orgId: opts.orgId,
    project: await projectOfNode(opts.orgId, opts.nodeId),
    kind: "asset",
    id,
    bytes: media.bytes,
    contentType: media.type,
  });
  if (!stored.ok) return { ok: false, code: stored.code, message: stored.message };
  const result = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO assets (
        id, org_id, scope_node_id, category, title, is_render,
        captured_on, uploaded_by
      ) VALUES (
        ${id}, ${opts.orgId}, ${opts.nodeId}, ${opts.category},
        ${opts.title?.trim() || null}, ${isRender},
        ${opts.capturedOn || null}, ${opts.actorUserId}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO asset_versions
        (org_id, asset_id, version, storage_key, media_type, media_name, media_bytes, sha256, uploaded_by)
      VALUES (${opts.orgId}, ${id}, 1, ${stored.key}, ${media.type}, ${media.name},
              ${stored.bytes}, ${stored.sha256}, ${opts.actorUserId})
    `;
    return { ok: true as const, assetId: row.id };
  }).catch(() => ({ ok: false as const, code: "WRITE_FAILED", message: "Could not file that asset." }));
  if (!result.ok) {
    // The row did not land, so the object is an orphan. Take it back out
    // rather than leaving a byte nobody can reach and nobody will delete.
    await removeAsset(stored.key);
    return result;
  }
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "asset.added",
    targetType: "scope_node",
    targetId: opts.nodeId,
    // No title and no file name: audit_log carries no free text somebody
    // typed, and a title can name a person or a competitor.
    metadata: { category: opts.category, mediaType: media.type, bytes: stored.bytes },
  });
  return result;
}

/**
 * Approve the bytes that are there now.
 *
 * The hash is read from the row rather than taken from the caller, so an
 * approval can never be recorded against bytes the approver did not see.
 */

export async function approveAsset(opts: {
  orgId: string;
  actorUserId: string;
  assetId: string;
}): Promise<AssetOutcome> {
  if (!isNodeId(opts.assetId)) {
    return { ok: false, code: "ASSET_UNKNOWN", message: "That asset is not in this organisation." };
  }
  // A lockup's QR is what a buyer scans beside the registration number, so
  // where its authority publishes what a QR opens (Uttar Pradesh), the QR is
  // read and checked against the phase's record before anybody approves it.
  const [lockup] = await withTenant(opts.orgId, async (sql) =>
    sql<{ node_id: string; storage_key: string }[]>`
      SELECT a.scope_node_id AS node_id, av.storage_key
      FROM assets a JOIN asset_versions av ON av.asset_id = a.id
      WHERE a.org_id = ${opts.orgId} AND a.id = ${opts.assetId} AND a.category = 'RERA_LOCKUP'
      ORDER BY av.version DESC LIMIT 1`,
  );
  if (lockup) {
    const bytes = await readAsset(lockup.storage_key);
    const qr = bytes ? await checkUpLockup({ orgId: opts.orgId, phaseId: lockup.node_id, bytes }) : null;
    if (qr && !qr.ok) return { ok: false, code: "LOCKUP_NOT_THIS_REGISTRATION", message: qr.message };
  }
  const result = await withTenant(opts.orgId, async (sql) => {
    // The hash comes from the newest version rather than from the caller, so
    // an approval can never be recorded against bytes the approver did not
    // see. Uploading a new version therefore leaves the old approval behind.
    const [asset] = await sql<{ id: string; sha256: string; scope_node_id: string }[]>`
      SELECT a.id, av.sha256, a.scope_node_id
      FROM assets a
      JOIN asset_versions av ON av.asset_id = a.id
      WHERE a.org_id = ${opts.orgId} AND a.id = ${opts.assetId}
      ORDER BY av.version DESC
      LIMIT 1
    `;
    if (!asset) {
      return { ok: false as const, code: "ASSET_UNKNOWN", message: "That asset is not in this organisation." };
    }
    await sql`
      INSERT INTO asset_approvals (org_id, asset_id, sha256, approved_by)
      VALUES (${opts.orgId}, ${opts.assetId}, ${asset.sha256}, ${opts.actorUserId})
      ON CONFLICT (asset_id, sha256, approved_by) DO NOTHING
    `;
    return { ok: true as const, assetId: asset.id, sha256: asset.sha256, nodeId: asset.scope_node_id };
  }).catch(() => ({ ok: false as const, code: "WRITE_FAILED", message: "Could not record that approval." }));
  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "asset.approved",
      targetType: "scope_node",
      targetId: result.nodeId,
      // The hash is the point of the record: it says which bytes.
      metadata: { assetId: result.assetId, sha256: result.sha256 },
    });
  }
  return result;
}

/** Take an asset out of the library, and its object with it. */
export async function removeAssetRow(opts: {
  orgId: string;
  actorUserId: string;
  assetId: string;
}): Promise<{ ok: boolean; nodeId: string | null }> {
  if (!isNodeId(opts.assetId)) return { ok: false, nodeId: null };
  const result = await withTenant(opts.orgId, async (sql) => {
    // Read the keys before the row goes: the versions cascade away with it,
    // and an object nobody can name is an orphan nobody will collect.
    const keys = await sql<{ storage_key: string }[]>`
      SELECT storage_key FROM asset_versions
      WHERE org_id = ${opts.orgId} AND asset_id = ${opts.assetId}
    `;
    const [asset] = await sql<{ scope_node_id: string }[]>`
      DELETE FROM assets WHERE org_id = ${opts.orgId} AND id = ${opts.assetId}
      RETURNING scope_node_id
    `;
    return asset ? { keys: keys.map((k) => k.storage_key), nodeId: asset.scope_node_id } : null;
  }).catch(() => null);
  if (!result) return { ok: false, nodeId: null };
  const row = { scope_node_id: result.nodeId };
  for (const key of result.keys) await removeAsset(key);
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "asset.removed",
    targetType: "scope_node",
    targetId: row.scope_node_id,
    metadata: { assetId: opts.assetId },
  });
  return { ok: true, nodeId: row.scope_node_id };
}

/**
 * Rename one asset.
 *
 * Titles are set after the fact rather than during upload, because uploading
 * is a batch and naming is not. The bytes and the hash are untouched, so an
 * approval survives a rename: what was approved is the image, not the label.
 */

export async function renameAsset(opts: {
  orgId: string;
  actorUserId: string;
  assetId: string;
  title: string | null;
}): Promise<{ ok: boolean; nodeId: string | null }> {
  if (!isNodeId(opts.assetId)) return { ok: false, nodeId: null };
  const [row] = await withTenant(opts.orgId, async (sql) => {
    return sql<{ scope_node_id: string }[]>`
      UPDATE assets SET title = ${opts.title?.trim() || null}
      WHERE org_id = ${opts.orgId} AND id = ${opts.assetId}
      RETURNING scope_node_id
    `;
  }).catch(() => []);
  return { ok: !!row, nodeId: row?.scope_node_id ?? null };
}

/**
 * Put new bytes behind an existing asset.
 *
 * A version, not an overwrite. The old one stays with its approval attached,
 * so "what did the approver actually see" is still answerable, and the new
 * one arrives unapproved because an approval pins a hash rather than an
 * asset. Rolling back makes the original approval apply again, exactly as
 * putting a Brain group's values back restores its signature.
 */

export async function replaceAsset(opts: {
  orgId: string;
  actorUserId: string;
  assetId: string;
  media: { bytes: Buffer; type: string; name: string | null } | null;
}): Promise<AssetOutcome> {
  if (!isNodeId(opts.assetId)) {
    return { ok: false, code: "ASSET_UNKNOWN", message: "That asset is not in this organisation." };
  }
  const existing = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string; category: string; kind: ScopeKind; next: number; node_id: string }[]>`
      SELECT a.id, a.category, n.kind, a.scope_node_id AS node_id,
             COALESCE(MAX(av.version), 0) + 1 AS next
      FROM assets a
      JOIN scope_nodes n ON n.id = a.scope_node_id
      LEFT JOIN asset_versions av ON av.asset_id = a.id
      WHERE a.org_id = ${opts.orgId} AND a.id = ${opts.assetId}
      GROUP BY a.id, a.category, n.kind, a.scope_node_id
    `;
    return row ?? null;
  });
  if (!existing) {
    return { ok: false, code: "ASSET_UNKNOWN", message: "That asset is not in this organisation." };
  }
  const verdict = canUploadAsset({
    category: existing.category,
    nodeKind: existing.kind,
    mediaType: opts.media?.type ?? null,
    mediaBytes: opts.media?.bytes.byteLength ?? 0,
    // The date was given when the asset was filed; a new version of the same
    // photograph is not a new day.
    capturedOn: "1970-01-01",
    today: istDay(new Date()),
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
  const media = opts.media!;
  const stored = await putAsset({
    orgId: opts.orgId,
    project: await projectOfNode(opts.orgId, existing.node_id),
    kind: "asset",
    id: crypto.randomUUID(),
    bytes: media.bytes,
    contentType: media.type,
  });
  if (!stored.ok) return { ok: false, code: stored.code, message: stored.message };
  const result = await withTenant(opts.orgId, async (sql) => {
    await sql`
      INSERT INTO asset_versions
        (org_id, asset_id, version, storage_key, media_type, media_name, media_bytes, sha256, uploaded_by)
      VALUES (${opts.orgId}, ${opts.assetId}, ${existing.next}, ${stored.key},
              ${media.type}, ${media.name}, ${stored.bytes}, ${stored.sha256}, ${opts.actorUserId})
    `;
    return { ok: true as const, assetId: opts.assetId };
  }).catch(() => ({ ok: false as const, code: "WRITE_FAILED", message: "Could not store that version." }));
  if (!result.ok) {
    await removeAsset(stored.key);
    return result;
  }
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "asset.version_added",
    targetType: "asset",
    targetId: opts.assetId,
    metadata: { version: existing.next, mediaType: media.type, bytes: stored.bytes },
  });
  return result;
}

export type CopyOutcome =
  | { ok: true; copied: number }
  | { ok: false; code: string; message: string };

/**
 * Copy assets to another node.
 *
 * The point of the library: a clubhouse render shot once should not be
 * uploaded again for the next tower. The bytes are duplicated server side, so
 * nothing travels through this process.
 *
 * **Approvals do not come with it.** A render approved for one project is not
 * thereby approved for another project's clubhouse, and an approval that
 * survived a copy would make "every pixel traces to a named human who
 * approved it here" false the first time anybody copied anything. The copy
 * lands unapproved and `copied_from` records where it came from, so the
 * lineage is answerable without the permission travelling.
 *
 * Only the newest version is copied. The history belongs to the original:
 * what the other tower needs is the image, not the argument about it.
 */

export async function copyAssetsTo(opts: {
  orgId: string;
  actorUserId: string;
  assetIds: readonly string[];
  toNodeId: string;
  /**
   * Whether the person may read what sits at a path. An asset they may not
   * see is treated as one that does not exist, so a copy cannot be used to
   * lift another tower's library into their own. Checks run as the owner
   * and pass nothing.
   */
  mayTakeFrom?: (path: string) => boolean;
}): Promise<CopyOutcome> {
  if (!isNodeId(opts.toNodeId)) {
    return { ok: false, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
  }
  const ids = opts.assetIds.filter(isNodeId);
  if (!ids.length) {
    return { ok: false, code: "NOTHING_CHOSEN", message: "Choose at least one asset to copy." };
  }
  const plan = await withTenant(opts.orgId, async (sql) => {
    const [node] = await sql<AssetNode[]>`
      SELECT id, kind, name, path::text AS path
      FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.toNodeId}
    `;
    if (!node) return null;
    const rows = await sql<
      {
        id: string;
        category: string;
        title: string | null;
        is_render: boolean;
        captured_on: Date | null;
        scope_node_id: string;
        path: string;
        storage_key: string;
        media_type: string;
        media_name: string | null;
        media_bytes: string;
        sha256: string;
      }[]
    >`
      SELECT DISTINCT ON (a.id)
             a.id, a.category, a.title, a.is_render, a.captured_on, a.scope_node_id,
             n.path::text AS path,
             av.storage_key, av.media_type, av.media_name, av.media_bytes, av.sha256
      FROM assets a
      JOIN scope_nodes n ON n.id = a.scope_node_id
      JOIN asset_versions av ON av.asset_id = a.id
      WHERE a.org_id = ${opts.orgId} AND a.id = ANY(${ids as string[]})
      ORDER BY a.id, av.version DESC
    `;
    return { node, rows };
  });
  if (!plan) {
    return { ok: false, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
  }
  const may = opts.mayTakeFrom ?? (() => true);
  const found = plan.rows.filter((r) => may(r.path));
  if (!found.length) {
    return { ok: false, code: "NOTHING_FOUND", message: "None of those assets are in this organisation." };
  }
  // Copying onto the node it already sits on would make a duplicate nobody
  // asked for, and the screen offers the other nodes for that reason.
  const elsewhere = found.filter((r) => r.scope_node_id !== plan.node.id);
  if (!elsewhere.length) {
    return { ok: false, code: "SAME_NODE", message: "Those are already filed here." };
  }
  // Refused before a byte moves, because the level rule is about what a
  // category means rather than about the file: a site plan is one per
  // project, and a copy of one onto a tower is still the wrong building.
  const today = istDay(new Date());
  for (const row of elsewhere) {
    const verdict = canUploadAsset({
      category: row.category,
      nodeKind: plan.node.kind,
      mediaType: row.media_type,
      mediaBytes: Number(row.media_bytes),
      // The date came with the original; a copy is not a new day.
      capturedOn: row.captured_on ? row.captured_on.toISOString().slice(0, 10) : "1970-01-01",
      today,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        code: verdict.code,
        message: `${row.title ?? "That asset"} cannot go on ${plan.node.name}. ${verdict.message}`,
      };
    }
  }
  let copied = 0;
  const targetProject = await projectOfNode(opts.orgId, plan.node.id);
  for (const row of elsewhere) {
    const id = crypto.randomUUID();
    const dup = await copyAsset({
      fromKey: row.storage_key,
      orgId: opts.orgId,
      project: targetProject,
      kind: "asset",
      id,
    });
    if (!dup.ok) return { ok: false, code: dup.code, message: dup.message };
    const written = await withTenant(opts.orgId, async (sql) => {
      await sql`
        INSERT INTO assets (id, org_id, scope_node_id, category, title, is_render,
                            captured_on, copied_from, uploaded_by)
        VALUES (${id}, ${opts.orgId}, ${plan.node.id}, ${row.category}, ${row.title},
                ${row.is_render}, ${row.captured_on}, ${row.id}, ${opts.actorUserId})
      `;
      await sql`
        INSERT INTO asset_versions
          (org_id, asset_id, version, storage_key, media_type, media_name, media_bytes, sha256, uploaded_by)
        VALUES (${opts.orgId}, ${id}, 1, ${dup.key}, ${row.media_type}, ${row.media_name},
                ${row.media_bytes}, ${row.sha256}, ${opts.actorUserId})
      `;
      return true;
    }).catch(() => false);
    if (!written) {
      await removeAsset(dup.key);
      return { ok: false, code: "WRITE_FAILED", message: "Could not file that copy." };
    }
    copied += 1;
  }
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "asset.copied",
    targetType: "scope_node",
    targetId: plan.node.id,
    metadata: { copied, from: elsewhere.map((r) => r.scope_node_id) },
  });
  return { ok: true, copied };
}

export type LibraryNodeSummary = {
  id: string;
  name: string;
  city: string | null;
  assets: number;
  approved: number;
  phases: {
    id: string;
    name: string;
    assets: number;
    approved: number;
    /** What the tower sells. Configurations hang off a phase and nowhere else. */
    units: number;
    unitsApproved: number;
  }[];
};

/**
 * Every project and phase, with what each one holds.
 *
 * Counts what is filed ON each node rather than what resolves at it, because
 * this answers "what do we have" rather than "what may I build here". A site
 * plan counted at all nine towers as well as at the project would make the
 * total meaningless.
 */
export async function libraryOverview(orgId: string): Promise<LibraryNodeSummary[]> {
  const rows = await withTenant(orgId, async (sql) => {
    return sql<
      {
        id: string;
        name: string;
        kind: ScopeKind;
        path: string;
        parent_id: string | null;
        assets: number;
        approved: number;
        units: number;
        units_approved: number;
      }[]
    >`
      SELECT n.id, n.name, n.kind, n.path::text AS path, n.parent_id,
             count(a.id)::int AS assets,
             count(a.id) FILTER (WHERE ok.asset_id IS NOT NULL)::int AS approved,
             -- Scalar subqueries rather than a join: joining a second
             -- one-to-many onto the assets join multiplies both counts, and
             -- the resulting numbers look plausible enough to ship.
             (SELECT count(*)::int FROM unit_types t
               WHERE t.org_id = ${orgId} AND t.scope_node_id = n.id) AS units,
             (SELECT count(*)::int FROM unit_types t
               WHERE t.org_id = ${orgId} AND t.scope_node_id = n.id
                 AND EXISTS (
                   SELECT 1 FROM unit_type_approvals ap
                   JOIN unit_type_versions uv
                     ON uv.unit_type_id = ap.unit_type_id AND uv.sha256 = ap.sha256
                   WHERE ap.unit_type_id = t.id
                     AND uv.version = (SELECT max(v2.version) FROM unit_type_versions v2
                                        WHERE v2.unit_type_id = t.id)
                 )) AS units_approved
      FROM scope_nodes n
      LEFT JOIN assets a ON a.scope_node_id = n.id AND a.org_id = ${orgId}
      LEFT JOIN LATERAL (
        SELECT ap.asset_id
        FROM asset_approvals ap
        JOIN asset_versions av
          ON av.asset_id = ap.asset_id AND av.sha256 = ap.sha256
        WHERE ap.asset_id = a.id
          AND av.version = (SELECT max(v2.version) FROM asset_versions v2 WHERE v2.asset_id = a.id)
        LIMIT 1
      ) ok ON true
      WHERE n.org_id = ${orgId} AND n.kind IN ('PROJECT', 'PHASE')
      GROUP BY n.id, n.name, n.kind, n.path, n.parent_id
      ORDER BY n.path
    `;
  });

  const projects = rows.filter((r) => r.kind === "PROJECT");
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    city: null,
    assets: p.assets,
    approved: p.approved,
    phases: rows
      .filter((r) => r.kind === "PHASE" && r.parent_id === p.id)
      .map((ph) => ({
        id: ph.id,
        name: ph.name,
        assets: ph.assets,
        approved: ph.approved,
        units: ph.units,
        unitsApproved: ph.units_approved,
      })),
  }));
}
