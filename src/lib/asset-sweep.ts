import { randomUUID } from "node:crypto";
import { controlDb, withTenantReadOnly, audit } from "./db/index.ts";
import { storage, type StorageDriver } from "./storage.ts";
import { baseOfDerived } from "./media-variant-rules.ts";
import {
  KEY_COLUMNS,
  OWNER_KEY,
  databaseId,
  ownerMarker,
  ownerProblem,
  ownerWords,
  readOwner,
  refusalFor,
  sortObjects,
  tenantPrefix,
  type KeyColumn,
  type Refusal,
} from "./sweep-rules.ts";

/**
 * The orphan sweep: objects in the file store that no row points at.
 * `sweep-rules.ts` holds every decision; this reads and deletes.
 *
 * Dry run unless `apply` is set. Tenants are listed on the owner's
 * connection, as `rera-sweep.ts` does, because a platform job has no org to
 * pin; every read of a tenant's rows then runs inside that tenant, so RLS
 * holds on the work itself.
 */

export type TenantSweep = {
  orgId: string;
  objects: number;
  bytes: number;
  referencedKeys: number;
  orphans: number;
  orphanBytes: number;
  young: number;
  unknown: Record<string, number>;
  refused: Refusal | null;
  deleted: number;
  deletedBytes: number;
  failed: number;
};

export type AssetSweepReport =
  | {
      ok: true;
      runId: string;
      apply: boolean;
      store: string;
      tenants: TenantSweep[];
      /** `org/<id>/` folders whose org no longer exists. Reported, never deleted. */
      strangers: { orgId: string; objects: number; bytes: number }[];
    }
  | { ok: false; code: "CANNOT_LIST" | "NO_IDENTITY" | "UNCLAIMED" | "UNREADABLE" | "OTHER_DATABASE"; message: string };

/** This database, as the store's marker names it. */
export async function currentDatabaseId(): Promise<string | null> {
  try {
    const [r] = await controlDb<{ id: string; db: string }[]>`
      SELECT system_identifier::text AS id, current_database() AS db FROM pg_control_system()`;
    return r ? databaseId(r.id, r.db) : null;
  } catch {
    return null;
  }
}

async function markerText(d: StorageDriver): Promise<string | null> {
  const b = await d.read(OWNER_KEY);
  return b ? b.toString("utf8") : null;
}

/**
 * Name this database as the store's owner. Refused when another already is:
 * handing a store from one database to another is a decision, made by
 * deleting the marker by hand, never by running a command twice.
 */
export async function claimStore(
  now = new Date(),
): Promise<{ ok: true; database: string; already: boolean } | { ok: false; message: string }> {
  const id = await currentDatabaseId();
  if (!id) return { ok: false, message: "Could not read which database this is." };
  const d = storage();
  const owner = readOwner(await markerText(d));
  if (owner === "UNREADABLE") return { ok: false, message: ownerWords("UNREADABLE") };
  if (owner !== "UNCLAIMED") {
    return owner.database === id
      ? { ok: true, database: id, already: true }
      : { ok: false, message: ownerWords("OTHER_DATABASE") };
  }
  await d.put(OWNER_KEY, Buffer.from(ownerMarker(id, now)), "application/json");
  return { ok: true, database: id, already: false };
}

/** The registered tables that exist in this database. A table not yet migrated holds nothing. */
export async function presentColumns(): Promise<KeyColumn[]> {
  const tables = [...new Set(KEY_COLUMNS.map((c) => c.table))];
  const rows = await controlDb<{ t: string }[]>`
    SELECT t FROM unnest(${tables}::text[]) AS t WHERE to_regclass('public.' || t) IS NOT NULL`;
  const present = new Set(rows.map((r) => r.t));
  return KEY_COLUMNS.filter((c) => present.has(c.table));
}

/**
 * Every key a tenant's rows point at, read inside that tenant.
 *
 * A JSON column is searched at every depth, so a key is found wherever a
 * later feature puts it in the document. A column the registry names that
 * does not exist is an error rather than an empty answer, because an empty
 * answer is the one that deletes.
 */
export async function referencedKeys(orgId: string, columns: readonly KeyColumn[]): Promise<Set<string>> {
  const prefix = tenantPrefix(orgId);
  return withTenantReadOnly(
    orgId,
    async (tx) => {
      const keys = new Set<string>();
      for (const c of columns) {
        const rows = c.json
          ? await tx<{ k: string }[]>`
              SELECT DISTINCT v #>> '{}' AS k
              FROM ${tx(c.table)} t, jsonb_path_query(t.${tx(c.column)}, 'strict $.**') v
              WHERE t.org_id = ${orgId} AND jsonb_typeof(v) = 'string' AND starts_with(v #>> '{}', ${prefix})`
          : await tx<{ k: string }[]>`
              SELECT DISTINCT ${tx(c.column)} AS k FROM ${tx(c.table)}
              WHERE org_id = ${orgId} AND starts_with(${tx(c.column)}, ${prefix})`;
        for (const r of rows) keys.add(r.k);
      }
      return keys;
    },
    120_000,
  );
}

export async function sweepAssets(
  opts: { apply?: boolean; now?: Date; orgIds?: string[] } = {},
): Promise<AssetSweepReport> {
  const now = opts.now ?? new Date();
  const apply = opts.apply === true;
  const d = storage();
  if (!d.list || !d.folders) {
    return { ok: false, code: "CANNOT_LIST", message: "This file store cannot list its objects, so nothing can be swept." };
  }

  const id = await currentDatabaseId();
  if (!id) return { ok: false, code: "NO_IDENTITY", message: "Could not read which database this is, so nothing was swept." };
  const problem = ownerProblem(await markerText(d), id);
  if (problem) return { ok: false, code: problem, message: ownerWords(problem) };

  const columns = await presentColumns();
  const orgs = await controlDb<{ id: string }[]>`
    SELECT id FROM orgs
    ${opts.orgIds ? controlDb`WHERE id = ANY(${opts.orgIds})` : controlDb``}
    ORDER BY created_at`;

  const runId = randomUUID();
  const tenants: TenantSweep[] = [];
  for (const org of orgs) {
    const objects = await d.list(tenantPrefix(org.id));
    const referenced = await referencedKeys(org.id, columns);
    const sorted = sortObjects({ orgId: org.id, objects, referenced, now });
    const refused = refusalFor({ objects: objects.length, referencedKeys: referenced.size, orphans: sorted.orphans.length });
    const t: TenantSweep = {
      orgId: org.id,
      objects: objects.length,
      bytes: sorted.bytes,
      referencedKeys: referenced.size,
      orphans: sorted.orphans.length,
      orphanBytes: sorted.orphans.reduce((s, o) => s + o.bytes, 0),
      young: sorted.young,
      unknown: sorted.unknown,
      refused,
      deleted: 0,
      deletedBytes: 0,
      failed: 0,
    };

    if (apply && !refused && sorted.orphans.length > 0) {
      // Read the rows again just before deleting. A row written since the
      // first read keeps its object, whatever the listing said.
      const again = await referencedKeys(org.id, columns);
      for (const o of sorted.orphans) {
        if (again.has(o.key) || again.has(baseOfDerived(o.key) ?? "")) continue;
        try {
          await d.remove(o.key);
          t.deleted++;
          t.deletedBytes += o.bytes;
        } catch {
          t.failed++;
        }
      }
    }

    // One row per tenant for a run that could have changed something. Counts
    // and bytes only: a key names a tenant's file, and the audit log holds
    // no identifier of anything a person uploaded.
    if (apply && (t.deleted > 0 || t.failed > 0 || t.refused)) {
      await audit({
        orgId: org.id,
        actorUserId: null,
        action: "storage.swept",
        targetType: "file_store",
        metadata: {
          run: runId,
          objects: t.objects,
          bytes: t.bytes,
          orphans: t.orphans,
          orphan_bytes: t.orphanBytes,
          deleted: t.deleted,
          deleted_bytes: t.deletedBytes,
          failed: t.failed,
          young: t.young,
          refused: t.refused,
        },
      });
    }
    tenants.push(t);
  }

  // Folders for orgs that no longer exist. Nothing in this database can say
  // what they were, so they are counted and left for a person.
  const strangers: { orgId: string; objects: number; bytes: number }[] = [];
  if (!opts.orgIds) {
    const known = await controlDb<{ id: string }[]>`SELECT id::text AS id FROM orgs`;
    const ids = new Set(known.map((r) => r.id));
    for (const folder of await d.folders("org/")) {
      const orgId = folder.slice("org/".length, -1);
      if (ids.has(orgId)) continue;
      const objects = await d.list(folder);
      strangers.push({ orgId, objects: objects.length, bytes: objects.reduce((s, o) => s + o.bytes, 0) });
    }
  }

  return { ok: true, runId, apply, store: d.name, tenants, strangers };
}
