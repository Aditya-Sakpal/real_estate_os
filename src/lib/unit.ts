import { withTenant, audit } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import { LINKED_REFUSAL, linkedSource, linkedTo } from "./linked.ts";
import { resolveBrain } from "./brain.ts";
import { removeAsset, copyAsset } from "./storage.ts";
import { projectOfNode } from "./storage-place.ts";
import {
  canAddUnitType,
  configLabel,
  isAreaUnit,
  unitHash,
  unitLabel,
  type AreaUnit,
  type PriceBasis,
  type UnitValues,
} from "./unit-rules.ts";
import { canUploadAsset, istDay } from "./asset-rules.ts";
import type { ScopeKind } from "./roles.ts";

/**
 * Reading and writing unit types.
 *
 * Three rules run through everything here, and all three are borrowed rather
 * than invented, because the third time a pattern appears is the point at
 * which not reusing it becomes a decision to maintain two of something.
 *
 * **Identity and numbers are separate.** `unit_types` is which tower and
 * which configuration; `unit_type_versions` is the areas and the price, one
 * row per revision. A price rise in March does not erase what January's
 * advertisement was cleared against.
 *
 * **An approval pins the values, not the row.** Revise the price and the
 * approval stops matching, so nothing built from it can claim to have been
 * approved. Put the old numbers back and it applies again.
 *
 * **A copy lands unapproved.** A 2 BHK approved for Tower A is not thereby
 * approved for Tower B, even when every number is identical, because the
 * approval is a person saying it is right HERE.
 *
 * Imports are relative because `check:units` loads this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

export type UnitNode = { id: string; kind: ScopeKind; name: string; path: string };

export type UnitTypeRow = {
  id: string;
  nodeId: string;
  nodeName: string;
  path: string;
  config: string;
  configLabel: string;
  variant: string | null;
  /** "2 BHK", or "2 BHK Optima" where a tower sells two of them. */
  label: string;
  copiedFrom: string | null;

  /** The newest version, which is the one in force. */
  version: number;
  versionCount: number;
  carpetAreaSqft: number;
  balconyAreaSqft: number | null;
  /** As recorded. Null means it is computed from the signed rate per sq ft. */
  startingPrice: number | null;
  /** A plot's area, or the plot a villa stands on, in sq ft; null for a flat. */
  plotAreaSqft: number | null;
  /** The unit the plot area is shown in. */
  areaUnit: AreaUnit | null;
  /** What the signed rate is applied to, where there is a plot. */
  priceBasis: PriceBasis | null;
  sha256: string;
  createdAt: string;
  createdByName: string | null;

  /** How many pictures point at this configuration. */
  assetCount: number;
};

export type UnitVersionRow = {
  version: number;
  carpetAreaSqft: number;
  balconyAreaSqft: number | null;
  startingPrice: number | null;
  plotAreaSqft: number | null;
  areaUnit: AreaUnit | null;
  priceBasis: PriceBasis | null;
  sha256: string;
  createdAt: string;
  createdByName: string | null;
};

export type UnitApprovalRow = {
  unitTypeId: string;
  sha256: string;
  byName: string | null;
  at: string;
};

export type UnitView = {
  node: UnitNode;
  /** Every configuration at or below this node, deepest last. */
  units: UnitTypeRow[];
  approvals: UnitApprovalRow[];
  /** `price.base_psf` as published here, which computes a price nobody typed. */
  basePsf: number | null;
};

export type UnitOutcome =
  | { ok: true; unitTypeId: string }
  | { ok: false; code: string; message: string };

type DbUnit = {
  id: string;
  scope_node_id: string;
  node_name: string;
  path: string;
  config: string;
  variant: string | null;
  copied_from: string | null;
  version: number;
  version_count: string;
  carpet_area_sqft: string;
  balcony_area_sqft: string | null;
  starting_price: string | null;
  plot_area_sqft: string | null;
  area_unit: string | null;
  price_basis: string | null;
  sha256: string;
  created_at: Date;
  created_by_name: string | null;
  asset_count: string;
};

/** The three plot columns as the rules read them. */
const plotOf = (r: { plot_area_sqft: string | null; area_unit: string | null; price_basis: string | null }) => ({
  plotAreaSqft: num(r.plot_area_sqft),
  areaUnit: isAreaUnit(r.area_unit) ? r.area_unit : null,
  priceBasis: r.price_basis === "PLOT" || r.price_basis === "CARPET" ? (r.price_basis as PriceBasis) : null,
});

const num = (v: string | null): number | null =>
  v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null;

const toRow = (r: DbUnit): UnitTypeRow => ({
  id: r.id,
  nodeId: r.scope_node_id,
  nodeName: r.node_name,
  path: r.path,
  config: r.config,
  configLabel: configLabel(r.config),
  variant: r.variant,
  label: unitLabel({ config: r.config, variant: r.variant }),
  copiedFrom: r.copied_from,
  version: r.version,
  versionCount: Number(r.version_count),
  carpetAreaSqft: Number(r.carpet_area_sqft),
  balconyAreaSqft: num(r.balcony_area_sqft),
  startingPrice: num(r.starting_price),
  ...plotOf(r),
  sha256: r.sha256,
  createdAt: r.created_at.toISOString(),
  createdByName: r.created_by_name,
  assetCount: Number(r.asset_count),
});

/**
 * One row per configuration, carrying its newest version.
 *
 * `DISTINCT ON` with the version descending is how Postgres answers "the
 * latest of each" in one pass, the same read `asset.ts` uses for versions.
 */
const CURRENT = `
  SELECT DISTINCT ON (uv.unit_type_id)
         uv.unit_type_id, uv.version, uv.carpet_area_sqft, uv.balcony_area_sqft,
         uv.starting_price, uv.plot_area_sqft, uv.area_unit, uv.price_basis,
         uv.sha256, uv.created_at, uv.created_by,
         count(*) OVER (PARTITION BY uv.unit_type_id) AS version_count
  FROM unit_type_versions uv
  ORDER BY uv.unit_type_id, uv.version DESC
`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every configuration at or below one node.
 *
 * At a tower that is its own list. At a project it is every tower's, which is
 * what a brief hanging off a project needs: an advertisement for the whole
 * development still quotes a configuration, and the configuration belongs to
 * one of the towers under it.
 *
 * Unit types deliberately do NOT resolve downward the way brand kits and
 * Brain facts do. There is nothing below a phase, and a project-level
 * configuration would price every tower off whichever one was cheapest.
 */
export async function loadUnits(orgId: string, nodeId: string): Promise<UnitView | null> {
  if (!isNodeId(nodeId)) return null;
  // The Brain is read beside this transaction, never inside it: a transaction
  // waiting on a second connection starves the pool, and with every slot held
  // that way the whole server stops answering.
  const [view, brain] = await Promise.all([
    withTenant(orgId, async (sql) => {
      const [node] = await sql<UnitNode[]>`
        SELECT id, kind, name, path::text AS path
        FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}
      `;
      if (!node) return null;

      const rows = await sql<DbUnit[]>`
        SELECT t.id, t.scope_node_id, n.name AS node_name, n.path::text AS path,
               t.config, t.variant, t.copied_from,
               cur.version, cur.version_count, cur.carpet_area_sqft,
               cur.balcony_area_sqft, cur.starting_price, cur.plot_area_sqft, cur.area_unit,
               cur.price_basis, cur.sha256, cur.created_at,
               u.name AS created_by_name,
               (SELECT count(*) FROM assets a WHERE a.unit_type_id = t.id) AS asset_count
        FROM unit_types t
        JOIN scope_nodes n ON n.id = t.scope_node_id
        JOIN (${sql.unsafe(CURRENT)}) cur ON cur.unit_type_id = t.id
        LEFT JOIN users u ON u.id = cur.created_by
        WHERE t.org_id = ${orgId} AND n.path <@ ${node.path}::ltree
        ORDER BY n.path, t.config, t.variant NULLS FIRST
      `;

      const approvals = await sql<
        { unit_type_id: string; sha256: string; by_name: string | null; approved_at: Date }[]
      >`
        SELECT ap.unit_type_id, ap.sha256, u.name AS by_name, ap.approved_at
        FROM unit_type_approvals ap
        JOIN unit_types t ON t.id = ap.unit_type_id
        JOIN scope_nodes n ON n.id = t.scope_node_id
        LEFT JOIN users u ON u.id = ap.approved_by
        WHERE ap.org_id = ${orgId} AND n.path <@ ${node.path}::ltree
        ORDER BY ap.approved_at DESC
      `;

      return { node, rows, approvals };
    }),
    resolveBrain(orgId, nodeId),
  ]);
  if (!view) return null;
  const psf = Number(String(brain?.values["price.base_psf"] ?? "").replace(/[^\d.]/g, ""));
  return {
    node: view.node,
    units: view.rows.map(toRow),
    approvals: view.approvals.map((a) => ({
      unitTypeId: a.unit_type_id,
      sha256: a.sha256,
      byName: a.by_name,
      at: a.approved_at.toISOString(),
    })),
    basePsf: Number.isFinite(psf) && psf > 0 ? psf : null,
  };
}

/**
 * Only the configurations a creative may actually quote.
 *
 * The consumer read, and the one that makes "no approval, no price" true.
 * A configuration whose current numbers carry no approval never comes back
 * from here, exactly as `approvedAssets()` withholds unapproved bytes.
 */
export async function approvedUnits(
  orgId: string,
  nodeId: string,
): Promise<{ units: UnitTypeRow[]; basePsf: number | null }> {
  // A channel partner's linked tower quotes what the developer approved.
  const source = await linkedSource(orgId, nodeId);
  if (source) return approvedUnits(source.orgId, source.nodeId);
  const view = await loadUnits(orgId, nodeId);
  if (!view) return { units: [], basePsf: null };
  const approved = new Set(view.approvals.map((a) => `${a.unitTypeId}:${a.sha256}`));
  return {
    units: view.units.filter((u) => approved.has(`${u.id}:${u.sha256}`)),
    basePsf: view.basePsf,
  };
}

/** Every version of one configuration, newest first. */
export async function listUnitVersions(
  orgId: string,
  unitTypeId: string,
): Promise<UnitVersionRow[]> {
  if (!isNodeId(unitTypeId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<
      {
        version: number;
        carpet_area_sqft: string;
        balcony_area_sqft: string | null;
        starting_price: string | null;
        plot_area_sqft: string | null;
        area_unit: string | null;
        price_basis: string | null;
        sha256: string;
        created_at: Date;
        created_by_name: string | null;
      }[]
    >`
      SELECT uv.version, uv.carpet_area_sqft, uv.balcony_area_sqft, uv.starting_price,
             uv.plot_area_sqft, uv.area_unit, uv.price_basis, uv.sha256, uv.created_at, u.name AS created_by_name
      FROM unit_type_versions uv
      LEFT JOIN users u ON u.id = uv.created_by
      WHERE uv.org_id = ${orgId} AND uv.unit_type_id = ${unitTypeId}
      ORDER BY uv.version DESC
    `;
  });
  return rows.map((r) => ({
    version: r.version,
    carpetAreaSqft: Number(r.carpet_area_sqft),
    balconyAreaSqft: num(r.balcony_area_sqft),
    startingPrice: num(r.starting_price),
    ...plotOf(r),
    sha256: r.sha256,
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
  }));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function nodeOf(orgId: string, nodeId: string): Promise<UnitNode | null> {
  if (!isNodeId(nodeId)) return null;
  return withTenant(orgId, async (sql) => {
    const [n] = await sql<UnitNode[]>`
      SELECT id, kind, name, path::text AS path
      FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}
    `;
    return n ?? null;
  });
}

const NOWHERE = {
  ok: false as const,
  code: "NODE_UNKNOWN",
  message: "That is not a place in this organisation.",
};

/**
 * Where one configuration is recorded, for the permission check an action
 * makes before touching it. A configuration id from a form can name any
 * tower in the organisation, and holding a key on one is not holding it on
 * the next.
 */
export async function unitPlace(
  orgId: string,
  unitTypeId: string,
): Promise<{ nodeId: string; path: string } | null> {
  if (!isNodeId(unitTypeId)) return null;
  const [row] = await withTenant(orgId, async (sql) => {
    return sql<{ node_id: string; path: string }[]>`
      SELECT n.id AS node_id, n.path::text AS path
      FROM unit_types t JOIN scope_nodes n ON n.id = t.scope_node_id
      WHERE t.org_id = ${orgId} AND t.id = ${unitTypeId}
      LIMIT 1
    `;
  });
  return row ? { nodeId: row.node_id, path: row.path } : null;
}

/**
 * The values a version stores and its hash covers.
 *
 * A plot has no carpet area, so its carpet column carries the plot area:
 * every reader that prices or measures by area then reads the area sold.
 * The plot columns are written only where there is a plot, so a flat's
 * values, and its hash, are exactly what they were before plots existed.
 */
function valuesOf(
  config: string,
  variant: string | null,
  o: {
    carpetAreaSqft: number | null;
    balconyAreaSqft: number | null;
    startingPrice: number | null;
    plotAreaSqft?: number | null;
    areaUnit?: AreaUnit | null;
    priceBasis?: PriceBasis | null;
  },
): UnitValues {
  const plot = o.plotAreaSqft && o.plotAreaSqft > 0 ? o.plotAreaSqft : null;
  return {
    config,
    variant,
    carpetAreaSqft: config === "PLOT" && plot ? plot : o.carpetAreaSqft!,
    balconyAreaSqft: o.balconyAreaSqft,
    startingPrice: o.startingPrice,
    ...(plot
      ? {
          plotAreaSqft: plot,
          areaUnit: o.areaUnit ?? "SQFT",
          priceBasis: config === "PLOT" ? ("PLOT" as const) : (o.priceBasis ?? "CARPET"),
        }
      : {}),
  };
}

/**
 * Record a configuration, with version 1 of its numbers.
 *
 * The configuration and the variant are set here and never edited. Changing
 * a 2 BHK into a 3 BHK is not a correction, it is a different product, and
 * an edit path for it would mean an approval outliving the thing it was
 * about. Remove it and add the right one.
 */
export async function addUnitType(opts: {
  orgId: string;
  actorUserId: string;
  nodeId: string;
  config: string;
  variant: string | null;
  carpetAreaSqft: number | null;
  balconyAreaSqft: number | null;
  startingPrice: number | null;
  /** Square feet, converted from the unit typed. A plot's area, or a villa's plot. */
  plotAreaSqft?: number | null;
  areaUnit?: AreaUnit | null;
  priceBasis?: PriceBasis | null;
}): Promise<UnitOutcome> {
  // A channel partner's linked project or tower is the developer's to say.
  const linked = await linkedTo(opts.orgId, opts.nodeId);
  if (linked) return { ok: false, code: "LINKED", message: LINKED_REFUSAL(linked.developer) };
  const node = await nodeOf(opts.orgId, opts.nodeId);
  if (!node) return NOWHERE;

  const verdict = canAddUnitType({
    config: opts.config,
    variant: opts.variant,
    nodeKind: node.kind,
    carpetAreaSqft: opts.carpetAreaSqft,
    balconyAreaSqft: opts.balconyAreaSqft,
    startingPrice: opts.startingPrice,
    plotAreaSqft: opts.plotAreaSqft ?? null,
    areaUnit: opts.areaUnit ?? null,
    priceBasis: opts.priceBasis ?? null,
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  const values = valuesOf(opts.config, opts.variant?.trim() || null, opts);

  const id = crypto.randomUUID();
  const result = await withTenant(opts.orgId, async (sql) => {
    await sql`
      INSERT INTO unit_types (id, org_id, scope_node_id, config, variant, created_by)
      VALUES (${id}, ${opts.orgId}, ${opts.nodeId}, ${values.config},
              ${values.variant}, ${opts.actorUserId})
    `;
    await sql`
      INSERT INTO unit_type_versions
        (org_id, unit_type_id, version, carpet_area_sqft, balcony_area_sqft,
         starting_price, plot_area_sqft, area_unit, price_basis, sha256, created_by)
      VALUES (${opts.orgId}, ${id}, 1, ${values.carpetAreaSqft}, ${values.balconyAreaSqft},
              ${values.startingPrice}, ${values.plotAreaSqft ?? null}, ${values.areaUnit ?? null},
              ${values.priceBasis ?? null}, ${unitHash(values)}, ${opts.actorUserId})
    `;
    return { ok: true as const, unitTypeId: id };
  }).catch((e: { code?: string }) =>
    // The unique index is the only refusal worth naming, and it is the one a
    // person will actually hit: adding the 2 BHK twice.
    e?.code === "23505"
      ? {
          ok: false as const,
          code: "DUPLICATE",
          message: `${node.name} already has a ${unitLabel(values)}.`,
        }
      : { ok: false as const, code: "WRITE_FAILED", message: "Could not record that configuration." },
  );

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "unit.added",
      targetType: "scope_node",
      targetId: opts.nodeId,
      // No variant name: `audit_log` carries no free text somebody typed.
      metadata: { unitTypeId: id, config: values.config },
    });
  }
  return result;
}

/**
 * New numbers behind an existing configuration.
 *
 * A version, not an overwrite. The old one stays with its approval attached,
 * so what January's creative was cleared against is still readable, and the
 * new one arrives unapproved because the approval pins values rather than a
 * row. Revising back to an earlier set of numbers produces the same hash and
 * therefore lands already approved.
 */
export async function reviseUnitType(opts: {
  orgId: string;
  actorUserId: string;
  unitTypeId: string;
  carpetAreaSqft: number | null;
  balconyAreaSqft: number | null;
  startingPrice: number | null;
  /** Square feet, converted from the unit typed. A plot's area, or a villa's plot. */
  plotAreaSqft?: number | null;
  areaUnit?: AreaUnit | null;
  priceBasis?: PriceBasis | null;
}): Promise<UnitOutcome> {
  if (!isNodeId(opts.unitTypeId)) {
    return { ok: false, code: "UNIT_UNKNOWN", message: "That configuration is not in this organisation." };
  }
  const existing = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<
      { id: string; config: string; variant: string | null; kind: ScopeKind; node_id: string; next: number }[]
    >`
      SELECT t.id, t.config, t.variant, n.kind, n.id AS node_id,
             COALESCE(MAX(uv.version), 0) + 1 AS next
      FROM unit_types t
      JOIN scope_nodes n ON n.id = t.scope_node_id
      LEFT JOIN unit_type_versions uv ON uv.unit_type_id = t.id
      WHERE t.org_id = ${opts.orgId} AND t.id = ${opts.unitTypeId}
      GROUP BY t.id, t.config, t.variant, n.kind, n.id
    `;
    return row ?? null;
  });
  if (!existing) {
    return { ok: false, code: "UNIT_UNKNOWN", message: "That configuration is not in this organisation." };
  }

  const verdict = canAddUnitType({
    config: existing.config,
    variant: existing.variant,
    nodeKind: existing.kind,
    carpetAreaSqft: opts.carpetAreaSqft,
    balconyAreaSqft: opts.balconyAreaSqft,
    startingPrice: opts.startingPrice,
    plotAreaSqft: opts.plotAreaSqft ?? null,
    areaUnit: opts.areaUnit ?? null,
    priceBasis: opts.priceBasis ?? null,
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  const values = valuesOf(existing.config, existing.variant, opts);
  const hash = unitHash(values);

  const written = await withTenant(opts.orgId, async (sql) => {
    // Rewriting the same numbers is not a revision. It would mint a version
    // nobody changed anything in, and the history is what makes "what was
    // this cleared against" answerable.
    const [current] = await sql<{ sha256: string }[]>`
      SELECT sha256 FROM unit_type_versions
      WHERE org_id = ${opts.orgId} AND unit_type_id = ${opts.unitTypeId}
      ORDER BY version DESC LIMIT 1
    `;
    if (current?.sha256 === hash) return "UNCHANGED" as const;
    await sql`
      INSERT INTO unit_type_versions
        (org_id, unit_type_id, version, carpet_area_sqft, balcony_area_sqft,
         starting_price, plot_area_sqft, area_unit, price_basis, sha256, created_by)
      VALUES (${opts.orgId}, ${opts.unitTypeId}, ${existing.next}, ${values.carpetAreaSqft},
              ${values.balconyAreaSqft}, ${values.startingPrice}, ${values.plotAreaSqft ?? null},
              ${values.areaUnit ?? null}, ${values.priceBasis ?? null}, ${hash}, ${opts.actorUserId})
    `;
    return "WRITTEN" as const;
  }).catch(() => null);

  if (written === null) {
    return { ok: false, code: "WRITE_FAILED", message: "Could not record those numbers." };
  }
  if (written === "UNCHANGED") {
    return { ok: false, code: "UNCHANGED", message: "Those are the numbers already recorded." };
  }

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "unit.revised",
    targetType: "scope_node",
    targetId: existing.node_id,
    metadata: { unitTypeId: opts.unitTypeId, version: existing.next, sha256: hash },
  });
  return { ok: true, unitTypeId: opts.unitTypeId };
}

/**
 * Approve the numbers that are there now.
 *
 * The hash is read from the row rather than taken from the caller, so an
 * approval can never be recorded against numbers the approver did not see.
 */
export async function approveUnitType(opts: {
  orgId: string;
  actorUserId: string;
  unitTypeId: string;
}): Promise<UnitOutcome> {
  if (!isNodeId(opts.unitTypeId)) {
    return { ok: false, code: "UNIT_UNKNOWN", message: "That configuration is not in this organisation." };
  }
  const result = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string; sha256: string; scope_node_id: string }[]>`
      SELECT t.id, uv.sha256, t.scope_node_id
      FROM unit_types t
      JOIN unit_type_versions uv ON uv.unit_type_id = t.id
      WHERE t.org_id = ${opts.orgId} AND t.id = ${opts.unitTypeId}
      ORDER BY uv.version DESC
      LIMIT 1
    `;
    if (!row) {
      return {
        ok: false as const,
        code: "UNIT_UNKNOWN",
        message: "That configuration is not in this organisation.",
      };
    }
    await sql`
      INSERT INTO unit_type_approvals (org_id, unit_type_id, sha256, approved_by)
      VALUES (${opts.orgId}, ${opts.unitTypeId}, ${row.sha256}, ${opts.actorUserId})
      ON CONFLICT (unit_type_id, sha256, approved_by) DO NOTHING
    `;
    return { ok: true as const, unitTypeId: row.id, sha256: row.sha256, nodeId: row.scope_node_id };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not record that approval.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "unit.approved",
      targetType: "scope_node",
      targetId: result.nodeId,
      metadata: { unitTypeId: result.unitTypeId, sha256: result.sha256 },
    });
  }
  return result;
}

/**
 * Take a configuration out.
 *
 * Refused while pictures point at it, and the message says how many. The
 * foreign key is RESTRICT for the same reason: nulling them would silently
 * turn "the 2 BHK bedroom" into "some bedroom in this tower", which is the
 * confusion this table exists to end. Untag the pictures first, deliberately.
 */
export async function removeUnitType(opts: {
  orgId: string;
  actorUserId: string;
  unitTypeId: string;
}): Promise<{ ok: boolean; nodeId: string | null; message?: string }> {
  if (!isNodeId(opts.unitTypeId)) return { ok: false, nodeId: null };

  const result = await withTenant(opts.orgId, async (sql) => {
    const [used] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM assets
      WHERE org_id = ${opts.orgId} AND unit_type_id = ${opts.unitTypeId}
    `;
    const held = Number(used?.n ?? 0);
    if (held > 0) return { held };
    const [row] = await sql<{ scope_node_id: string }[]>`
      DELETE FROM unit_types WHERE org_id = ${opts.orgId} AND id = ${opts.unitTypeId}
      RETURNING scope_node_id
    `;
    return row ? { nodeId: row.scope_node_id } : null;
  }).catch(() => null);

  if (!result) return { ok: false, nodeId: null };
  if ("held" in result) {
    return {
      ok: false,
      nodeId: null,
      message:
        result.held === 1
          ? "One picture is filed under this configuration. Untag it first."
          : `${result.held} pictures are filed under this configuration. Untag them first.`,
    };
  }

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "unit.removed",
    targetType: "scope_node",
    targetId: result.nodeId,
    metadata: { unitTypeId: opts.unitTypeId },
  });
  return { ok: true, nodeId: result.nodeId };
}

/**
 * Point a picture at a configuration, and say which room it is.
 *
 * Both are set after the upload rather than during it, for the reason titles
 * are: uploading is a batch and tagging is not. The bytes and the hash are
 * untouched, so an approval survives it. What was approved is the image.
 */
export async function tagAsset(opts: {
  orgId: string;
  actorUserId: string;
  assetId: string;
  unitTypeId: string | null;
  room: string | null;
}): Promise<{ ok: boolean; nodeId: string | null; message?: string }> {
  if (!isNodeId(opts.assetId)) return { ok: false, nodeId: null };
  if (opts.unitTypeId !== null && !isNodeId(opts.unitTypeId)) return { ok: false, nodeId: null };

  const result = await withTenant(opts.orgId, async (sql) => {
    // A configuration belongs to one tower, so a picture may only carry one
    // that sits on its own node. An id from a form naming another tower's
    // 2 BHK is the same class of bug as an invite naming another tenant's
    // node, and it is refused the same way: read it back, in this tenant,
    // against this asset's node.
    if (opts.unitTypeId) {
      const [fits] = await sql<{ id: string }[]>`
        SELECT t.id FROM unit_types t
        JOIN assets a ON a.scope_node_id = t.scope_node_id
        WHERE t.org_id = ${opts.orgId} AND t.id = ${opts.unitTypeId} AND a.id = ${opts.assetId}
      `;
      if (!fits) return "WRONG_TOWER" as const;
    }
    const [row] = await sql<{ scope_node_id: string }[]>`
      UPDATE assets SET unit_type_id = ${opts.unitTypeId}, room = ${opts.room}
      WHERE org_id = ${opts.orgId} AND id = ${opts.assetId}
      RETURNING scope_node_id
    `;
    return row ?? null;
  }).catch(() => null);

  if (result === "WRONG_TOWER") {
    return {
      ok: false,
      nodeId: null,
      message: "That configuration belongs to a different tower.",
    };
  }
  if (!result) return { ok: false, nodeId: null };
  return { ok: true, nodeId: result.scope_node_id };
}

// ---------------------------------------------------------------------------
// Copying to another tower
// ---------------------------------------------------------------------------

export type UnitCopyOutcome =
  | { ok: true; copied: number; skipped: string[]; assets: number }
  | { ok: false; code: string; message: string };

/**
 * Copy configurations, and optionally their pictures, to another tower.
 *
 * The ordinary case this exists for: Tower B sells the same 1 BHK and 2 BHK
 * at the same prices, off the same plans, and nobody should retype any of it.
 *
 * **Approvals do not travel**, for either the configuration or the pictures.
 * A price approved for Tower A is not approved for Tower B even when the
 * number is identical, because an approval is a named person saying it is
 * right HERE. `copied_from` records the lineage so it stays answerable
 * without the permission moving with it.
 *
 * Only the newest version is copied. The history belongs to the original:
 * what Tower B needs is the price, not the argument about it.
 *
 * A configuration the target already has is SKIPPED rather than refusing the
 * whole batch. Choosing four and being told no because one of them is already
 * there is a screen that makes the person work out which, and the unique
 * index would refuse it anyway.
 */
export async function copyUnitTypesTo(opts: {
  orgId: string;
  actorUserId: string;
  unitTypeIds: readonly string[];
  toNodeId: string;
  withAssets: boolean;
  /**
   * Whether the person may read what sits at a path. A configuration they
   * may not see is treated as one that does not exist. Checks run as the
   * owner and pass nothing.
   */
  mayTakeFrom?: (path: string) => boolean;
}): Promise<UnitCopyOutcome> {
  const node = await nodeOf(opts.orgId, opts.toNodeId);
  if (!node) return NOWHERE;
  if (node.kind !== "PHASE") {
    return {
      ok: false,
      code: "WRONG_LEVEL",
      message: "A configuration belongs to one tower, so it can only be copied to a phase.",
    };
  }
  const ids = opts.unitTypeIds.filter(isNodeId);
  if (!ids.length) {
    return { ok: false, code: "NOTHING_CHOSEN", message: "Choose at least one configuration to copy." };
  }

  const plan = await withTenant(opts.orgId, async (sql) => {
    const rows = await sql<
      {
        id: string;
        scope_node_id: string;
        path: string;
        config: string;
        variant: string | null;
        carpet_area_sqft: string;
        balcony_area_sqft: string | null;
        starting_price: string | null;
        plot_area_sqft: string | null;
        area_unit: string | null;
        price_basis: string | null;
        sha256: string;
      }[]
    >`
      SELECT DISTINCT ON (t.id)
             t.id, t.scope_node_id, n.path::text AS path, t.config, t.variant,
             uv.carpet_area_sqft, uv.balcony_area_sqft, uv.starting_price,
             uv.plot_area_sqft, uv.area_unit, uv.price_basis, uv.sha256
      FROM unit_types t
      JOIN scope_nodes n ON n.id = t.scope_node_id
      JOIN unit_type_versions uv ON uv.unit_type_id = t.id
      WHERE t.org_id = ${opts.orgId} AND t.id = ANY(${ids as string[]})
      ORDER BY t.id, uv.version DESC
    `;
    const taken = await sql<{ config: string; variant: string | null }[]>`
      SELECT config, variant FROM unit_types
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${node.id}
    `;
    return { rows, taken };
  });

  const may = opts.mayTakeFrom ?? (() => true);
  const found = plan.rows.filter((r) => may(r.path));
  if (!found.length) {
    return {
      ok: false,
      code: "NOTHING_FOUND",
      message: "None of those configurations are in this organisation.",
    };
  }

  const already = new Set(
    plan.taken.map((t) => `${t.config}\n${(t.variant ?? "").trim()}`),
  );
  const elsewhere = found.filter((r) => r.scope_node_id !== node.id);
  if (!elsewhere.length) {
    return { ok: false, code: "SAME_NODE", message: "Those are already recorded here." };
  }

  const skipped: string[] = [];
  const doable = elsewhere.filter((r) => {
    const key = `${r.config}\n${(r.variant ?? "").trim()}`;
    if (already.has(key)) {
      skipped.push(unitLabel({ config: r.config, variant: r.variant }));
      return false;
    }
    return true;
  });
  if (!doable.length) {
    return {
      ok: false,
      code: "ALL_PRESENT",
      message: `${node.name} already has ${skipped.join(", ")}.`,
    };
  }

  let copied = 0;
  let assetsCopied = 0;
  for (const row of doable) {
    const newId = crypto.randomUUID();
    const values: UnitValues = {
      config: row.config,
      variant: row.variant,
      carpetAreaSqft: Number(row.carpet_area_sqft),
      balconyAreaSqft: num(row.balcony_area_sqft),
      startingPrice: num(row.starting_price),
    };
    const plot = plotOf(row);
    const written = await withTenant(opts.orgId, async (sql) => {
      await sql`
        INSERT INTO unit_types (id, org_id, scope_node_id, config, variant, copied_from, created_by)
        VALUES (${newId}, ${opts.orgId}, ${node.id}, ${values.config}, ${values.variant},
                ${row.id}, ${opts.actorUserId})
      `;
      await sql`
        INSERT INTO unit_type_versions
          (org_id, unit_type_id, version, carpet_area_sqft, balcony_area_sqft,
           starting_price, plot_area_sqft, area_unit, price_basis, sha256, created_by)
        VALUES (${opts.orgId}, ${newId}, 1, ${values.carpetAreaSqft}, ${values.balconyAreaSqft},
                ${values.startingPrice}, ${plot.plotAreaSqft}, ${plot.areaUnit}, ${plot.priceBasis},
                ${row.sha256}, ${opts.actorUserId})
      `;
      return true;
    }).catch(() => false);
    if (!written) {
      return { ok: false, code: "WRITE_FAILED", message: "Could not record that copy." };
    }
    copied += 1;

    if (opts.withAssets) {
      const moved = await copyUnitAssets({
        orgId: opts.orgId,
        actorUserId: opts.actorUserId,
        fromUnitTypeId: row.id,
        toUnitTypeId: newId,
        toNode: node,
      });
      if (!moved.ok) return moved;
      assetsCopied += moved.copied;
    }
  }

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "unit.copied",
    targetType: "scope_node",
    targetId: node.id,
    metadata: { copied, skipped: skipped.length, assets: assetsCopied },
  });
  return { ok: true, copied, skipped, assets: assetsCopied };
}

/**
 * The pictures filed under one configuration, duplicated onto another.
 *
 * Every copy gets its own object. Two rows never share a key, because then
 * deleting either one takes the other's bytes and ref-counting that is a bug
 * waiting to be written. S3 copies server side, so this costs a request
 * rather than a download and an upload.
 */
async function copyUnitAssets(opts: {
  orgId: string;
  actorUserId: string;
  fromUnitTypeId: string;
  toUnitTypeId: string;
  toNode: UnitNode;
}): Promise<{ ok: true; copied: number } | { ok: false; code: string; message: string }> {
  const rows = await withTenant(opts.orgId, async (sql) => {
    return sql<
      {
        id: string;
        category: string;
        title: string | null;
        room: string | null;
        is_render: boolean;
        captured_on: Date | null;
        storage_key: string;
        media_type: string;
        media_name: string | null;
        media_bytes: string;
        sha256: string;
      }[]
    >`
      SELECT DISTINCT ON (a.id)
             a.id, a.category, a.title, a.room, a.is_render, a.captured_on,
             av.storage_key, av.media_type, av.media_name, av.media_bytes, av.sha256
      FROM assets a
      JOIN asset_versions av ON av.asset_id = a.id
      WHERE a.org_id = ${opts.orgId} AND a.unit_type_id = ${opts.fromUnitTypeId}
      ORDER BY a.id, av.version DESC
    `;
  });

  let copied = 0;
  for (const row of rows) {
    // The level rule still applies. A floor plan is per tower and the target
    // is a tower, so this passes today; it is asked anyway, because the rule
    // is about what a category means rather than about this call site.
    const verdict = canUploadAsset({
      category: row.category,
      nodeKind: opts.toNode.kind,
      mediaType: row.media_type,
      mediaBytes: Number(row.media_bytes),
      capturedOn: row.captured_on ? row.captured_on.toISOString().slice(0, 10) : "1970-01-01",
      today: istDay(new Date()),
    });
    if (!verdict.ok) continue;

    const id = crypto.randomUUID();
    const dup = await copyAsset({ fromKey: row.storage_key, orgId: opts.orgId, project: await projectOfNode(opts.orgId, opts.toNode.id), kind: "asset", id });
    if (!dup.ok) return { ok: false, code: dup.code, message: dup.message };

    const written = await withTenant(opts.orgId, async (sql) => {
      await sql`
        INSERT INTO assets (id, org_id, scope_node_id, category, title, is_render,
                            captured_on, copied_from, unit_type_id, room, uploaded_by)
        VALUES (${id}, ${opts.orgId}, ${opts.toNode.id}, ${row.category}, ${row.title},
                ${row.is_render}, ${row.captured_on}, ${row.id}, ${opts.toUnitTypeId},
                ${row.room}, ${opts.actorUserId})
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
      return { ok: false, code: "WRITE_FAILED", message: "Could not file one of the copied pictures." };
    }
    copied += 1;
  }
  return { ok: true, copied };
}
