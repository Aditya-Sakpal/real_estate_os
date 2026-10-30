import { withTenant, audit } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import {
  canUploadBrandFile,
  isBrandFileRole,
  mergeBrand,
  mergeBrandFiles,
  parseBrandInput,
  emptyBrandKit,
  type BrandFileRole,
  type BrandInput,
  type BrandKit,
} from "./brand-rules.ts";

export type { BrandInput };
import type { ScopeKind } from "./roles.ts";

/**
 * Reading and writing the brand kit.
 *
 * Two rules run through everything here.
 *
 * **A kit is said once and resolved downward.** `resolveBrand()` walks the
 * ancestors with `path @> $target` and lets the deepest node win, which is
 * the same mechanism the Brain uses for facts. Set the logo on the
 * organisation and every project under it has one.
 *
 * **The form is never believed.** A colour, a phone number, a website and a
 * social handle all arrive as strings a page said were valid. Each is
 * normalised or refused before it is written, because these end up printed on
 * advertisements and inside hrefs.
 *
 * Imports are relative because `check:brand` loads this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

export type BrandNode = { id: string; kind: ScopeKind; name: string; path: string };

export type BrandFile = {
  id: string;
  nodeId: string;
  nodeName: string;
  path: string;
  role: BrandFileRole;
  mediaType: string;
  mediaName: string | null;
  mediaBytes: number;
  uploadedAt: string;
};

export type BrandView = {
  node: BrandNode;
  /** This node's own row, which is what an edit screen writes back. */
  own: BrandKit;
  /** Its own files, not the inherited ones. */
  ownFiles: BrandFile[];
  /** Everything in force here, including what it inherits. */
  resolved: BrandKit;
  resolvedFiles: BrandFile[];
  /** The nodes the resolved kit was drawn from, shallowest first. */
  sources: { name: string; path: string }[];
};

export type BrandOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string };

type KitRow = {
  scope_node_id: string;
  path: string;
  node_name: string;
  tagline: string | null;
  colour_primary: string | null;
  colour_accent: string | null;
  typeface_name: string | null;
  typeface_languages: string[];
  logo_min_px: number | null;
  logo_clear_ratio: string | null;
  sales_phone: string | null;
  sales_email: string | null;
  website: string | null;
  privacy_url: string | null;
  office_address: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  youtube_url: string | null;
  disclaimer: string | null;
};

const toKit = (r: KitRow): BrandKit => ({
  tagline: r.tagline,
  colourPrimary: r.colour_primary,
  colourAccent: r.colour_accent,
  typefaceName: r.typeface_name,
  typefaceLanguages: r.typeface_languages ?? [],
  // numeric comes back as a string, and a ratio that reads "0.50" in one
  // place and 0.5 in another is two values as far as a diff is concerned.
  logoClearRatio: r.logo_clear_ratio === null ? null : Number(r.logo_clear_ratio),
  logoMinPx: r.logo_min_px,
  salesPhone: r.sales_phone,
  salesEmail: r.sales_email,
  website: r.website,
  privacyUrl: r.privacy_url,
  officeAddress: r.office_address,
  instagramUrl: r.instagram_url,
  facebookUrl: r.facebook_url,
  youtubeUrl: r.youtube_url,
  disclaimer: r.disclaimer,
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One node's kit, its own files, and everything it inherits.
 *
 * Null for a malformed id and for a node in another tenant. The caller cannot
 * tell those apart, which is correct.
 */
export async function loadBrand(orgId: string, nodeId: string): Promise<BrandView | null> {
  if (!isNodeId(nodeId)) return null;

  return withTenant(orgId, async (sql) => {
    const [node] = await sql<BrandNode[]>`
      SELECT id, kind, name, path::text AS path
      FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}
    `;
    if (!node) return null;

    // The ancestor chain, shallowest first. `@>` is the ltree containment
    // operator and the GiST index answers it.
    const kits = await sql<KitRow[]>`
      SELECT k.scope_node_id, n.path::text AS path, n.name AS node_name,
             k.tagline, k.colour_primary, k.colour_accent,
             k.typeface_name, k.typeface_languages, k.logo_min_px, k.logo_clear_ratio,
             k.sales_phone, k.sales_email, k.website, k.privacy_url, k.office_address,
             k.instagram_url, k.facebook_url, k.youtube_url, k.disclaimer
      FROM brand_kits k
      JOIN scope_nodes n ON n.id = k.scope_node_id
      WHERE k.org_id = ${orgId} AND n.path @> ${node.path}::ltree
      ORDER BY nlevel(n.path)
    `;

    const files = await sql<
      {
        id: string;
        scope_node_id: string;
        node_name: string;
        path: string;
        role: BrandFileRole;
        media_type: string;
        media_name: string | null;
        media_bytes: number;
        uploaded_at: Date;
      }[]
    >`
      SELECT f.id, f.scope_node_id, n.name AS node_name, n.path::text AS path,
             f.role, f.media_type, f.media_name,
             octet_length(f.media) AS media_bytes, f.uploaded_at
      FROM brand_files f
      JOIN scope_nodes n ON n.id = f.scope_node_id
      WHERE f.org_id = ${orgId} AND n.path @> ${node.path}::ltree
      ORDER BY nlevel(n.path)
    `;

    const asFile = (r: (typeof files)[number]): BrandFile => ({
      id: r.id,
      nodeId: r.scope_node_id,
      nodeName: r.node_name,
      path: r.path,
      role: r.role,
      mediaType: r.media_type,
      mediaName: r.media_name,
      mediaBytes: Number(r.media_bytes),
      uploadedAt: r.uploaded_at.toISOString(),
    });

    const all = files.map(asFile);
    const ownKit = kits.find((k) => k.scope_node_id === node.id);

    return {
      node,
      own: ownKit ? toKit(ownKit) : emptyBrandKit(),
      ownFiles: all.filter((f) => f.nodeId === node.id),
      resolved: mergeBrand(kits.map((k) => ({ path: k.path, kit: toKit(k) }))),
      resolvedFiles: mergeBrandFiles(all),
      sources: kits.map((k) => ({ name: k.node_name, path: k.path })),
    };
  });
}

/**
 * What is in force at one node, for whatever is building a creative.
 *
 * The consumer-facing read. It carries no notion of which node set what,
 * because nothing downstream should branch on that.
 */
export async function resolveBrand(
  orgId: string,
  nodeId: string,
): Promise<{ kit: BrandKit; files: BrandFile[] } | null> {
  const view = await loadBrand(orgId, nodeId);
  return view ? { kit: view.resolved, files: view.resolvedFiles } : null;
}

/** One file's bytes, for the route that serves it. */
export async function readBrandFile(
  orgId: string,
  fileId: string,
): Promise<{ bytes: Buffer; type: string; name: string | null } | null> {
  if (!isNodeId(fileId)) return null;
  const [row] = await withTenant(orgId, async (sql) => {
    return sql<{ media: Buffer; media_type: string; media_name: string | null }[]>`
      SELECT media, media_type, media_name FROM brand_files
      WHERE org_id = ${orgId} AND id = ${fileId} LIMIT 1
    `;
  });
  return row ? { bytes: row.media, type: row.media_type, name: row.media_name } : null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write one node's kit.
 *
 * Every value is normalised before it lands: a colour to six hex digits, a
 * phone number to E.164, a handle to a full URL. A value that cannot be
 * normalised is refused, by name, and nothing is written at all.
 * `parseBrandInput()` carries the reason: this is an upsert of the whole
 * row, so a typo stored as nothing erased the working phone number beside it
 * and the screen still said "Saved".
 */
export async function saveBrandKit(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
  input: BrandInput;
}): Promise<BrandOutcome> {
  if (!isNodeId(opts.nodeId)) {
    return { ok: false, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
  }

  const parsed = parseBrandInput(opts.input);
  if (!parsed.ok) {
    return { ok: false, code: "INVALID", message: parsed.problems.join(" ") };
  }
  const k = parsed.kit;
  const values = {
    tagline: k.tagline,
    colour_primary: k.colourPrimary,
    colour_accent: k.colourAccent,
    typeface_name: k.typefaceName,
    typeface_languages: k.typefaceLanguages,
    logo_min_px: k.logoMinPx,
    logo_clear_ratio: k.logoClearRatio,
    sales_phone: k.salesPhone,
    sales_email: k.salesEmail,
    website: k.website,
    privacy_url: k.privacyUrl,
    office_address: k.officeAddress,
    instagram_url: k.instagramUrl,
    facebook_url: k.facebookUrl,
    youtube_url: k.youtubeUrl,
    disclaimer: k.disclaimer,
  };

  const result = await withTenant(opts.orgId, async (sql) => {
    const [node] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.nodeId}
    `;
    if (!node) {
      return { ok: false as const, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
    }

    await sql`
      INSERT INTO brand_kits (
        scope_node_id, org_id, tagline, colour_primary, colour_accent,
        typeface_name, typeface_languages, logo_min_px, logo_clear_ratio,
        sales_phone, sales_email, website, privacy_url, office_address,
        instagram_url, facebook_url, youtube_url, disclaimer, updated_by
      ) VALUES (
        ${opts.nodeId}, ${opts.orgId}, ${values.tagline}, ${values.colour_primary},
        ${values.colour_accent}, ${values.typeface_name}, ${values.typeface_languages},
        ${values.logo_min_px}, ${values.logo_clear_ratio}, ${values.sales_phone},
        ${values.sales_email}, ${values.website}, ${values.privacy_url}, ${values.office_address},
        ${values.instagram_url}, ${values.facebook_url}, ${values.youtube_url},
        ${values.disclaimer}, ${opts.actorUserId}
      )
      ON CONFLICT (scope_node_id) DO UPDATE SET
        tagline = EXCLUDED.tagline,
        colour_primary = EXCLUDED.colour_primary,
        colour_accent = EXCLUDED.colour_accent,
        typeface_name = EXCLUDED.typeface_name,
        typeface_languages = EXCLUDED.typeface_languages,
        logo_min_px = EXCLUDED.logo_min_px,
        logo_clear_ratio = EXCLUDED.logo_clear_ratio,
        sales_phone = EXCLUDED.sales_phone,
        sales_email = EXCLUDED.sales_email,
        website = EXCLUDED.website,
        privacy_url = EXCLUDED.privacy_url,
        office_address = EXCLUDED.office_address,
        instagram_url = EXCLUDED.instagram_url,
        facebook_url = EXCLUDED.facebook_url,
        youtube_url = EXCLUDED.youtube_url,
        disclaimer = EXCLUDED.disclaimer,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `;
    return { ok: true as const };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not save the brand kit.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "brand.kit_saved",
      targetType: "scope_node",
      targetId: opts.nodeId,
      // No tagline, no address and no contact details: audit_log carries no
      // free text somebody typed, and a CHECK refuses an "@" in target_id for
      // the same reason.
      metadata: { fields: Object.values(values).filter((v) => v !== null && v !== "").length },
    });
  }
  return result;
}

/**
 * Put a file in one of the four roles.
 *
 * An upsert, not an insert. Two horizontal logos on one node is two answers
 * to which mark is ours, so replacing is what uploading means here.
 */
export async function putBrandFile(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
  role: string;
  media: { bytes: Buffer; type: string; name: string | null } | null;
}): Promise<BrandOutcome> {
  const verdict = canUploadBrandFile({
    role: opts.role,
    mediaType: opts.media?.type ?? null,
    mediaBytes: opts.media?.bytes.byteLength ?? 0,
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
  if (!isNodeId(opts.nodeId)) {
    return { ok: false, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
  }

  const media = opts.media!;
  const result = await withTenant(opts.orgId, async (sql) => {
    const [node] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.nodeId}
    `;
    if (!node) {
      return { ok: false as const, code: "NODE_UNKNOWN", message: "That is not a place in this organisation." };
    }

    await sql`
      INSERT INTO brand_files (org_id, scope_node_id, role, media, media_type, media_name, uploaded_by)
      VALUES (${opts.orgId}, ${opts.nodeId}, ${opts.role}, ${media.bytes},
              ${media.type}, ${media.name}, ${opts.actorUserId})
      ON CONFLICT (scope_node_id, role) DO UPDATE SET
        media = EXCLUDED.media,
        media_type = EXCLUDED.media_type,
        media_name = EXCLUDED.media_name,
        uploaded_by = EXCLUDED.uploaded_by,
        uploaded_at = now()
    `;
    return { ok: true as const };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not store that file.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "brand.file_uploaded",
      targetType: "scope_node",
      targetId: opts.nodeId,
      metadata: { role: opts.role, mediaType: media.type, bytes: media.bytes.byteLength },
    });
  }
  return result;
}

export async function removeBrandFile(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
  role: string;
}): Promise<BrandOutcome> {
  if (!isBrandFileRole(opts.role) || !isNodeId(opts.nodeId)) {
    return { ok: false, code: "UNKNOWN", message: "That is not part of a brand kit." };
  }

  const [row] = await withTenant(opts.orgId, async (sql) => {
    return sql<{ id: string }[]>`
      DELETE FROM brand_files
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.nodeId} AND role = ${opts.role}
      RETURNING id
    `;
  }).catch(() => []);

  if (!row) return { ok: false, code: "GONE", message: "That file is already gone." };

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "brand.file_removed",
    targetType: "scope_node",
    targetId: opts.nodeId,
    metadata: { role: opts.role },
  });
  return { ok: true };
}
