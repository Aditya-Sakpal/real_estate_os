/**
 * Inventory: the flats a tower has, and which are still for sale.
 *
 * `inventory-rules.ts` is the pure half. Reads are scoped by the caller's
 * `inventory:read` subtrees; the import is `inventory:manage` at the tower.
 * Nothing that builds an advertisement imports this file.
 *
 * Imports are relative so the checks can load this straight from source.
 */

import { audit, withTenant } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import {
  availabilityOf,
  configKeyOf,
  planUnits,
  readSheet,
  type Availability,
  type ImportPlan,
  type SheetUnit,
  type StoredUnit,
  type TypeForMatch,
  type UnitStatus,
} from "./inventory-rules.ts";
import { readXlsx, isXlsx } from "./xlsx-read.ts";
import { csvRows } from "./inventory-rules.ts";

export type Tower = { id: string; name: string; path: string };

/** A tower of this organisation, read back inside the tenant; the id from a form is never believed. */
export async function towerOf(orgId: string, nodeId: string): Promise<Tower | null> {
  if (!isNodeId(nodeId)) return null;
  const [t] = await withTenant(orgId, (sql) => sql<Tower[]>`
    SELECT id, name, path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId} AND kind = 'PHASE'`);
  return t ?? null;
}

type UnitRow = {
  id: string;
  wing: string | null;
  unit_no: string;
  floor: number | null;
  config: string | null;
  carpet_sqft: string | null;
  facing: string | null;
  status: UnitStatus;
  source: "CRM" | "IMPORT";
  unit_type_id: string | null;
  status_changed_at: Date;
  updated_at: Date;
  held_until?: Date | null;
};

const toStored = (r: UnitRow): StoredUnit & { statusChangedAt: Date; updatedAt: Date; heldUntil: Date | null } => ({
  id: r.id,
  wing: r.wing,
  unitNo: r.unit_no,
  floor: r.floor,
  config: r.config,
  carpetSqft: r.carpet_sqft === null ? null : Number(r.carpet_sqft),
  facing: r.facing,
  status: r.status,
  source: r.source,
  unitTypeId: r.unit_type_id,
  statusChangedAt: r.status_changed_at,
  updatedAt: r.updated_at,
  heldUntil: r.held_until ?? null,
});

export type UnitView = ReturnType<typeof toStored>;

/**
 * A flat held for a buyer by a quote (`unit_blocks`) reads as BLOCKED until
 * its hold ends, whatever the sheet or the CRM last said: the hold is ours
 * and never written into the row they own.
 */
export async function listUnits(orgId: string, nodeId: string): Promise<UnitView[]> {
  const rows = await withTenant(orgId, (sql) => sql<UnitRow[]>`
    SELECT id, wing, unit_no, floor, config, carpet_sqft, facing, source, unit_type_id, status_changed_at, updated_at,
           CASE WHEN status = 'AVAILABLE' AND held.until IS NOT NULL THEN 'BLOCKED' ELSE status END AS status,
           held.until AS held_until
    FROM units u
    LEFT JOIN LATERAL (SELECT (SELECT max(b.expires_at) FROM unit_blocks b
               WHERE b.org_id = u.org_id AND b.scope_node_id = u.scope_node_id
                 AND b.unit_no = upper(regexp_replace(btrim(u.unit_no), '[[:space:]]+', ' ', 'g'))
                 AND b.state IN ('PENDING_TOKEN', 'TOKEN_PAID') AND b.expires_at > now()) AS until) held ON true
    WHERE u.org_id = ${orgId} AND u.scope_node_id = ${nodeId}
    ORDER BY wing NULLS FIRST, floor NULLS LAST, unit_no`);
  return rows.map(toStored);
}

/** The unit types a tower sells, with the carpet area of the version in force. */
async function typesFor(orgId: string, nodeId: string): Promise<TypeForMatch[]> {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<{ id: string; config: string; carpet: string | null }[]>`
      SELECT t.id, t.config,
             (SELECT v.carpet_area_sqft FROM unit_type_versions v WHERE v.unit_type_id = t.id ORDER BY v.version DESC LIMIT 1) AS carpet
      FROM unit_types t WHERE t.org_id = ${orgId} AND t.scope_node_id = ${nodeId}`;
    return rows.map((r) => ({ id: r.id, config: r.config, carpetSqft: r.carpet === null ? null : Number(r.carpet) }));
  });
}

/** A sheet as uploaded: an Excel workbook or CSV text. */
export function sheetRows(bytes: Buffer): { ok: true; rows: string[][] } | { ok: false; message: string } {
  if (isXlsx(bytes)) return readXlsx(bytes);
  const text = bytes.toString("utf8");
  if (/\u0000/.test(text)) return { ok: false, message: "Upload an Excel workbook (.xlsx) or a CSV file." };
  return { ok: true, rows: csvRows(text) };
}

export type ImportPreview =
  | { ok: true; plan: ImportPlan; refused: { line: number; reason: string }[]; unmatched: number }
  | { ok: false; message: string };

/** What an import would do, without doing it. The screen shows this before anything is written. */
export async function previewImport(orgId: string, nodeId: string, rows: readonly (readonly string[])[]): Promise<ImportPreview> {
  const read = readSheet(rows);
  if (!read.ok) return read;
  const [stored, types] = await Promise.all([listUnits(orgId, nodeId), typesFor(orgId, nodeId)]);
  const plan = planUnits(read.units, stored, types);
  const unmatched = [...plan.add, ...plan.change].filter((u) => !u.unitTypeId).length;
  return { ok: true, plan, refused: read.refused, unmatched };
}

/**
 * Write the sheet. The plan is made again here against what is stored now,
 * so a preview from a stale tab cannot overwrite a newer change.
 */
export async function importUnits(input: {
  orgId: string;
  userId: string;
  nodeId: string;
  rows: readonly (readonly string[])[];
}): Promise<
  | { ok: true; added: number; changed: number; same: number; crm: number; refused: number; refusedLines: { line: number; reason: string }[] }
  | { ok: false; message: string }
> {
  const tower = await towerOf(input.orgId, input.nodeId);
  if (!tower) return { ok: false, message: "That tower does not exist here." };
  const preview = await previewImport(input.orgId, tower.id, input.rows);
  if (!preview.ok) return preview;
  const { plan } = preview;
  await writePlan(input.orgId, tower.id, plan, "IMPORT", input.userId);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "inventory.imported",
    targetType: "scope_node",
    targetId: tower.id,
    metadata: { added: plan.add.length, changed: plan.change.length, same: plan.same, crm: plan.crm, refused: preview.refused.length },
  });
  return {
    ok: true,
    added: plan.add.length,
    changed: plan.change.length,
    same: plan.same,
    crm: plan.crm,
    refused: preview.refused.length,
    refusedLines: preview.refused,
  };
}

/**
 * Write a plan. A sheet (the import, or a live sheet) updates only a flat a
 * sheet wrote, so a flat the CRM wrote since the plan was made is left to
 * the CRM; the CRM updates any flat, and the flat is the CRM's from then on.
 * A flat's status changing stamps when it changed.
 */
async function writePlan(orgId: string, towerId: string, plan: ImportPlan, writer: "IMPORT" | "CRM", userId: string | null): Promise<void> {
  await withTenant(orgId, async (sql) => {
    for (const u of plan.add) {
      await sql`
        INSERT INTO units (org_id, scope_node_id, wing, unit_no, floor, config, carpet_sqft, facing, status, unit_type_id, source, updated_by)
        VALUES (${orgId}, ${towerId}, ${u.wing}, ${u.unitNo}, ${u.floor}, ${u.config}, ${u.carpetSqft}, ${u.facing},
                ${u.status}, ${u.unitTypeId}, ${writer}, ${userId})
        ON CONFLICT (org_id, scope_node_id, coalesce(wing, ''), unit_no) DO NOTHING`;
    }
    for (const u of plan.change) {
      await sql`
        UPDATE units SET floor = ${u.floor}, config = ${u.config}, carpet_sqft = ${u.carpetSqft}, facing = ${u.facing},
               status = ${u.status}, unit_type_id = ${u.unitTypeId}, source = ${writer}, updated_by = ${userId}, updated_at = now(),
               status_changed_at = CASE WHEN status <> ${u.status} THEN now() ELSE status_changed_at END
        WHERE org_id = ${orgId} AND id = ${u.id} ${writer === "IMPORT" ? sql`AND source = 'IMPORT'` : sql``}`;
    }
  });
}

/**
 * Flats from a machine rather than a person: a live sheet or a CRM. The plan
 * is made against what is stored now and written by the same rules as the
 * import. Counts only; nothing here names a flat.
 */
export async function applyUnits(orgId: string, towerId: string, units: readonly SheetUnit[], writer: "IMPORT" | "CRM"): Promise<{ added: number; changed: number; same: number; crm: number }> {
  const [stored, types, raw] = await Promise.all([
    listUnits(orgId, towerId),
    typesFor(orgId, towerId),
    withTenant(orgId, (sql) => sql<{ id: string; status: UnitStatus }[]>`SELECT id, status FROM units WHERE org_id = ${orgId} AND scope_node_id = ${towerId}`),
  ]);
  // A flat held by a quote reads BLOCKED on screen; the plan compares the row as stored, whatever it holds.
  const rowStatus = new Map(raw.map((r) => [r.id, r.status]));
  const asStored = stored.map((u) => ({ ...u, status: rowStatus.get(u.id) ?? u.status }));
  const plan = planUnits(units, asStored, types, writer);
  if (plan.add.length || plan.change.length) await writePlan(orgId, towerId, plan, writer, null);
  return { added: plan.add.length, changed: plan.change.length, same: plan.same, crm: plan.crm };
}

/** The CRM says a buyer booked this flat: it is BOOKED, and the CRM's. False when no one flat of that number is in the tower. */
export async function markBooked(orgId: string, towerId: string, unitNo: string): Promise<boolean> {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM units WHERE org_id = ${orgId} AND scope_node_id = ${towerId}
        AND upper(regexp_replace(btrim(unit_no), '[[:space:]]+', ' ', 'g')) = ${unitNo}`;
    // Two wings with one number: which flat is not ours to guess.
    if (rows.length !== 1) return false;
    if (rows[0].status === "BOOKED") return true;
    await sql`UPDATE units SET status = 'BOOKED', source = 'CRM', updated_by = NULL, updated_at = now(), status_changed_at = now()
              WHERE org_id = ${orgId} AND id = ${rows[0].id}`;
    return true;
  });
}

/** Availability by configuration for one tower. */
export async function availability(orgId: string, nodeId: string): Promise<Availability[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ config: string | null; status: UnitStatus }[]>`
    SELECT config, CASE WHEN status = 'AVAILABLE' AND (SELECT max(b.expires_at) FROM unit_blocks b
               WHERE b.org_id = u.org_id AND b.scope_node_id = u.scope_node_id
                 AND b.unit_no = upper(regexp_replace(btrim(u.unit_no), '[[:space:]]+', ' ', 'g'))
                 AND b.state IN ('PENDING_TOKEN', 'TOKEN_PAID') AND b.expires_at > now()) IS NOT NULL THEN 'BLOCKED' ELSE status END AS status
    FROM units u WHERE u.org_id = ${orgId} AND u.scope_node_id = ${nodeId}`);
  return availabilityOf(rows);
}

/**
 * What a lead's page shows: how many flats of the configuration the buyer
 * asked for are still available in their tower, and when that was last true.
 * Null when the tower has no inventory recorded.
 */
export async function availabilityForLead(orgId: string, nodeId: string, leadConfig: string | null | undefined): Promise<{
  config: string | null;
  label: string | null;
  available: number;
  total: number;
  asOf: Date;
  all: Availability[];
} | null> {
  const rows = await withTenant(orgId, (sql) => sql<{ config: string | null; status: UnitStatus; updated_at: Date }[]>`
    SELECT config, CASE WHEN status = 'AVAILABLE' AND (SELECT max(b.expires_at) FROM unit_blocks b
               WHERE b.org_id = u.org_id AND b.scope_node_id = u.scope_node_id
                 AND b.unit_no = upper(regexp_replace(btrim(u.unit_no), '[[:space:]]+', ' ', 'g'))
                 AND b.state IN ('PENDING_TOKEN', 'TOKEN_PAID') AND b.expires_at > now()) IS NOT NULL THEN 'BLOCKED' ELSE status END AS status, updated_at
    FROM units u WHERE u.org_id = ${orgId} AND u.scope_node_id = ${nodeId}`);
  if (!rows.length) return null;
  const key = configKeyOf(leadConfig);
  const all = availabilityOf(rows);
  const mine = key ? all.find((a) => a.config === key) : undefined;
  const asOf = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), rows[0].updated_at);
  return {
    config: key,
    label: mine?.label ?? null,
    available: mine?.available ?? 0,
    total: mine ? mine.available + mine.blocked + mine.booked : 0,
    asOf,
    all,
  };
}

/** The towers a person may read availability for, by their `inventory:read` subtrees. */
export async function readableTowers(orgId: string, scopes: string[]): Promise<(Tower & { project: string | null; flats: number; updatedAt: Date | null })[]> {
  if (!scopes.length) return [];
  return withTenant(orgId, (sql) => sql<(Tower & { project: string | null; flats: number; updatedAt: Date | null })[]>`
    SELECT n.id, n.name, n.path::text AS path,
           (SELECT p.name FROM scope_nodes p WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project,
           (SELECT count(*)::int FROM units u WHERE u.org_id = ${orgId} AND u.scope_node_id = n.id) AS flats,
           (SELECT max(u.updated_at) FROM units u WHERE u.org_id = ${orgId} AND u.scope_node_id = n.id) AS "updatedAt"
    FROM scope_nodes n
    WHERE n.org_id = ${orgId} AND n.kind = 'PHASE' AND n.path <@ ANY(${scopes}::ltree[])
    ORDER BY project NULLS LAST, n.name`);
}
