/**
 * A live sheet: the developer's availability sheet, published, read every
 * few minutes and written through the sheet import's own rules.
 *
 * No CRM publishes a developer's flats through its public API, so the sheet
 * the developer already keeps is the source. A tower or a whole project
 * stores a published link (`availability_feeds`); the CRM worker reads every
 * due one. The read is raced against a deadline and capped in size, and a
 * sheet whose bytes did not change writes nothing. A flat the CRM wrote is
 * never overwritten by a sheet.
 *
 * Setting it is `inventory:manage` at the tower or project. Reading costs
 * nothing but a request to the sheet's host.
 *
 * Imports are relative so the checks can load this straight from source.
 */

import { createHash } from "node:crypto";
import { audit, controlDb, withTenant } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import type { Authz } from "./rbac-rules.ts";
import {
  FEED_LEASE_MS,
  FEED_MAX_BYTES,
  FEED_TIMEOUT_MS,
  csvRows,
  feedDue,
  feedUrl,
  readSheet,
  splitByTower,
  type SheetUnit,
} from "./inventory-rules.ts";
import { applyUnits } from "./inventory.ts";

export type FeedView = {
  id: string;
  nodeId: string;
  /** The tower's or project's name the link is set on. */
  on: string;
  kind: "PHASE" | "PROJECT";
  url: string;
  lastFetchedAt: Date | null;
  lastChangedAt: Date | null;
  lastError: string | null;
  lastResult: { added: number; changed: number; same: number; crm: number; refused: number } | null;
};

type Place = { id: string; name: string; kind: "PHASE" | "PROJECT"; path: string };

async function placeOf(orgId: string, nodeId: string): Promise<Place | null> {
  if (!isNodeId(nodeId)) return null;
  const [n] = await withTenant(orgId, (sql) => sql<Place[]>`
    SELECT id, name, kind, path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId} AND kind IN ('PHASE', 'PROJECT')`);
  return n ?? null;
}

/** The live sheet a tower reads: its own, or its project's. */
export async function feedFor(orgId: string, towerId: string): Promise<FeedView | null> {
  if (!isNodeId(towerId)) return null;
  const [f] = await withTenant(orgId, (sql) => sql<{
    id: string; node_id: string; on_name: string; kind: "PHASE" | "PROJECT"; url: string; last_fetched_at: Date | null; last_changed_at: Date | null;
    last_error: string | null; last_result: FeedView["lastResult"];
  }[]>`
    SELECT f.id, f.scope_node_id AS node_id, n.name AS on_name, n.kind, f.url, f.last_fetched_at, f.last_changed_at, f.last_error, f.last_result
    FROM availability_feeds f JOIN scope_nodes n ON n.id = f.scope_node_id
    JOIN scope_nodes t ON t.org_id = f.org_id AND t.id = ${towerId}
    WHERE f.org_id = ${orgId} AND (f.scope_node_id = t.id OR (n.kind = 'PROJECT' AND n.path @> t.path))
    ORDER BY (f.scope_node_id = t.id) DESC LIMIT 1`);
  if (!f) return null;
  return {
    id: f.id, nodeId: f.node_id, on: f.on_name, kind: f.kind, url: f.url, lastFetchedAt: f.last_fetched_at, lastChangedAt: f.last_changed_at,
    lastError: f.last_error, lastResult: f.last_result,
  };
}

/**
 * Set, change or remove the live sheet on a tower or a project. An empty link
 * removes it. Set on a project from a tower's screen (`fromTower`), the
 * tower's own sheet goes: the person chose the project's sheet for it, and a
 * tower's own sheet would otherwise go on winning.
 */
export async function saveFeed(o: { orgId: string; userId: string; authz: Authz; nodeId: string; url: string; fromTower?: string }):
  Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const place = await placeOf(o.orgId, o.nodeId);
  if (!place || !o.authz.canAt("inventory:manage", place.path)) return { ok: false, message: "You cannot change this sheet." };
  if (!o.url.trim()) {
    const r = await withTenant(o.orgId, (sql) => sql`DELETE FROM availability_feeds WHERE org_id = ${o.orgId} AND scope_node_id = ${place.id}`);
    if (r.count) await audit({ orgId: o.orgId, actorUserId: o.userId, action: "inventory.feed_removed", targetType: "scope_node", targetId: place.id });
    return { ok: true, message: `${place.name} no longer reads a live sheet.` };
  }
  const u = feedUrl(o.url);
  if (!u.ok) return { ok: false, message: u.why };
  await withTenant(o.orgId, (sql) => sql`
    INSERT INTO availability_feeds (org_id, scope_node_id, url, created_by)
    VALUES (${o.orgId}, ${place.id}, ${u.url}, ${o.userId})
    ON CONFLICT (org_id, scope_node_id) DO UPDATE
      SET url = EXCLUDED.url, last_hash = NULL, last_fetched_at = NULL, last_changed_at = NULL, last_result = NULL, last_error = NULL, updated_at = now()`);
  const tower = place.kind === "PROJECT" && o.fromTower ? await placeOf(o.orgId, o.fromTower) : null;
  if (tower?.kind === "PHASE" && tower.path.startsWith(`${place.path}.`) && o.authz.canAt("inventory:manage", tower.path)) {
    const r = await withTenant(o.orgId, (sql) => sql`DELETE FROM availability_feeds WHERE org_id = ${o.orgId} AND scope_node_id = ${tower.id}`);
    if (r.count) await audit({ orgId: o.orgId, actorUserId: o.userId, action: "inventory.feed_removed", targetType: "scope_node", targetId: tower.id });
  }
  // The host is enough to answer "which sheet"; the link itself can carry a key.
  await audit({
    orgId: o.orgId, actorUserId: o.userId, action: "inventory.feed_set", targetType: "scope_node", targetId: place.id,
    metadata: { host: new URL(u.url).hostname, kind: place.kind },
  });
  return { ok: true, message: `${place.name} reads the sheet every few minutes from now.` };
}

export type FetchFeed = (url: string, init: RequestInit) => Promise<Response>;
let injected: FetchFeed | null = null;
/** For the checks. An injected fetch beats the network. */
export function useFeedFetch(f: FetchFeed | null): void {
  injected = f;
}

/** The sheet's bytes, raced against a deadline and capped in size. */
async function fetchSheet(url: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; why: string }> {
  const f = injected ?? ((u: string, i: RequestInit) => fetch(u, i));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, FEED_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        // Redirects are followed by hand, each hop asked the same question as the link itself.
        let at = url;
        let r: Response | null = null;
        for (let hop = 0; hop <= 3; hop++) {
          r = await f(at, { redirect: "manual", signal: controller.signal, headers: { accept: "text/csv, text/plain;q=0.9, */*;q=0.1" } });
          const next = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
          if (!next) break;
          const checked = feedUrl(new URL(next, at).toString());
          if (!checked.ok || hop === 3) return { ok: false as const, why: "The sheet's link sends it somewhere it cannot be read from." };
          at = checked.url;
        }
        if (!r) return { ok: false as const, why: "The sheet did not answer." };
        if (!r.ok) return { ok: false as const, why: r.status === 404 ? "The sheet's link no longer opens." : `The sheet's host answered ${r.status}.` };
        const size = Number(r.headers.get("content-length") ?? 0);
        if (size > FEED_MAX_BYTES) return { ok: false as const, why: "The sheet is too large to read." };
        const reader = r.body?.getReader();
        if (!reader) return { ok: true as const, bytes: Buffer.alloc(0) };
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > FEED_MAX_BYTES) {
            controller.abort();
            return { ok: false as const, why: "The sheet is too large to read." };
          }
          chunks.push(Buffer.from(value));
        }
        return { ok: true as const, bytes: Buffer.concat(chunks) };
      })(),
      deadline,
    ]);
  } catch {
    return { ok: false, why: "The sheet did not answer in time." };
  } finally {
    clearTimeout(timer);
  }
}

type FeedRow = { id: string; scope_node_id: string; url: string; last_hash: string | null; kind: "PHASE" | "PROJECT"; path: string };

/** Read one live sheet and write what changed. Counts only. */
async function runFeed(orgId: string, f: FeedRow, now: Date): Promise<"UNCHANGED" | "CHANGED" | "FAILED"> {
  const got = await fetchSheet(f.url);
  if (!got.ok) {
    await withTenant(orgId, (sql) => sql`
      UPDATE availability_feeds SET last_fetched_at = ${now}, last_error = ${got.why}, claimed_until = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${f.id}`);
    return "FAILED";
  }
  const hash = createHash("sha256").update(got.bytes).digest("hex");
  if (hash === f.last_hash) {
    await withTenant(orgId, (sql) => sql`
      UPDATE availability_feeds SET last_fetched_at = ${now}, last_error = NULL, claimed_until = NULL WHERE org_id = ${orgId} AND id = ${f.id}`);
    return "UNCHANGED";
  }
  const text = got.bytes.toString("utf8");
  const read = /\u0000/.test(text) ? { ok: false as const, message: "The link does not give a CSV sheet." } : readSheet(csvRows(text));
  if (!read.ok) {
    await withTenant(orgId, (sql) => sql`
      UPDATE availability_feeds SET last_fetched_at = ${now}, last_error = ${read.message.slice(0, 300)}, claimed_until = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${f.id}`);
    return "FAILED";
  }
  // One tower's sheet, or a project's split by the tower each row names.
  let groups: Map<string, SheetUnit[]>;
  let refused = read.refused.length;
  if (f.kind === "PHASE") {
    groups = new Map([[f.scope_node_id, read.units]]);
  } else {
    const towers = await withTenant(orgId, (sql) => sql<{ id: string; name: string; own: boolean }[]>`
      SELECT n.id, n.name,
             EXISTS (SELECT 1 FROM availability_feeds o WHERE o.org_id = n.org_id AND o.scope_node_id = n.id) AS own
      FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.kind = 'PHASE' AND n.path <@ ${f.path}::ltree`);
    const split = splitByTower(read.units, towers);
    // A tower with a sheet of its own reads that one (`feedFor()`), so the project's rows for it are left out.
    for (const t of towers) if (t.own) split.byTower.delete(t.id);
    groups = split.byTower;
    refused += split.refused.length;
  }
  const total = { added: 0, changed: 0, same: 0, crm: 0, refused };
  for (const [towerId, units] of groups) {
    const r = await applyUnits(orgId, towerId, units, "IMPORT");
    total.added += r.added;
    total.changed += r.changed;
    total.same += r.same;
    total.crm += r.crm;
  }
  await withTenant(orgId, (sql) => sql`
    UPDATE availability_feeds SET last_hash = ${hash}, last_fetched_at = ${now}, last_changed_at = ${now}, last_error = NULL,
           last_result = ${sql.json(total as never)}, claimed_until = NULL, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${f.id}`);
  if (total.added || total.changed) {
    await audit({ orgId, actorUserId: null, action: "inventory.feed_read", targetType: "scope_node", targetId: f.scope_node_id, metadata: total });
  }
  return "CHANGED";
}

export type FeedReport = { orgId: string; read: number; changed: number; failed: number };

/** One organisation's due live sheets, each claimed under a lease so two workers never read one twice. */
export async function runOrgFeeds(orgId: string, now = new Date()): Promise<FeedReport> {
  const report: FeedReport = { orgId, read: 0, changed: 0, failed: 0 };
  const rows = await withTenant(orgId, (sql) => sql<(FeedRow & { last_fetched_at: Date | null })[]>`
    SELECT f.id, f.scope_node_id, f.url, f.last_hash, f.last_fetched_at, n.kind, n.path::text AS path
    FROM availability_feeds f JOIN scope_nodes n ON n.id = f.scope_node_id
    WHERE f.org_id = ${orgId} AND (f.claimed_until IS NULL OR f.claimed_until < ${now})
    ORDER BY f.last_fetched_at NULLS FIRST LIMIT 20`);
  for (const f of rows) {
    if (!feedDue(f.last_fetched_at, now)) continue;
    const [claimed] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
      UPDATE availability_feeds SET claimed_until = ${new Date(now.getTime() + FEED_LEASE_MS)}
      WHERE org_id = ${orgId} AND id = ${f.id} AND (claimed_until IS NULL OR claimed_until < ${now}) RETURNING id`);
    if (!claimed) continue;
    report.read++;
    const out = await runFeed(orgId, f, now).catch(async (e) => {
      await withTenant(orgId, (sql) => sql`
        UPDATE availability_feeds SET last_error = ${String((e as Error).message ?? e).slice(0, 300)}, claimed_until = NULL
        WHERE org_id = ${orgId} AND id = ${f.id}`);
      return "FAILED" as const;
    });
    if (out === "CHANGED") report.changed++;
    if (out === "FAILED") report.failed++;
  }
  return report;
}

/**
 * Every organisation with a live sheet, one pass each. The list of ids is
 * the one read across tenants, on the owner's connection the way the CRM
 * worker lists its tenants; every row after it is read inside its tenant.
 */
export async function runAvailabilityFeeds(opts: { orgIds?: string[]; now?: Date } = {}): Promise<FeedReport[]> {
  const rows = await controlDb<{ org_id: string }[]>`
    SELECT DISTINCT org_id FROM availability_feeds
      ${opts.orgIds ? controlDb`WHERE org_id = ANY(${opts.orgIds})` : controlDb``}`;
  const out: FeedReport[] = [];
  for (const r of rows) {
    try {
      out.push(await runOrgFeeds(r.org_id, opts.now ?? new Date()));
    } catch {
      out.push({ orgId: r.org_id, read: 0, changed: 0, failed: 1 });
    }
  }
  return out;
}

/** The project a tower sits in, for offering one sheet for the whole project. */
export async function projectOfTower(orgId: string, towerId: string): Promise<{ id: string; name: string; path: string } | null> {
  if (!isNodeId(towerId)) return null;
  const [p] = await withTenant(orgId, (sql) => sql<{ id: string; name: string; path: string }[]>`
    SELECT p.id, p.name, p.path::text AS path FROM scope_nodes t JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    WHERE t.org_id = ${orgId} AND t.id = ${towerId} LIMIT 1`);
  return p ?? null;
}
