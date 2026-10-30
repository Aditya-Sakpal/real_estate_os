import { createHmac } from "node:crypto";
import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import type { Authz } from "./rbac-rules.ts";
import { creditVisit, liveClaim } from "./partners.ts";
import { locationAt } from "./visits.ts";
import { publicBase } from "./capture.ts";
import { ist } from "./cadence-rules.ts";
import {
  attributionOf,
  judgeScan,
  passPayload,
  passSig,
  passValid,
  readPayload,
  type CheckinFlag,
} from "./checkin-rules.ts";

/**
 * Checking a buyer in: the pass their confirmation carries, the site team's
 * scan, and the check-in by hand. The reads and writes around
 * `checkin-rules.ts`.
 */

function secret(): string {
  const root = process.env.AUTH_SECRET;
  if (!root) throw new Error("AUTH_SECRET is not set.");
  return createHmac("sha256", root).update("salesdesk:visit-pass").digest("hex");
}

/** The link a buyer's confirmation carries: a page with their pass, public, bound to the visit by its proof. */
export function passLink(orgId: string, visitId: string): string | null {
  const base = publicBase();
  return base ? `${base}/v/${orgId}/${visitId}?t=${passSig(secret(), orgId, visitId)}` : null;
}

export type Pass = {
  payload: string;
  status: string;
  at: string;
  place: string;
  developer: string;
  directions: string | null;
};

/** The pass page's content, only for a proof that matches. Nothing on it names the buyer beyond what they already know. */
export async function passFor(orgId: string, visitId: string, sig: string): Promise<Pass | null> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(visitId) || !/^[0-9a-f]{16}$/i.test(sig)) return null;
  if (!passValid(secret(), orgId, visitId, sig)) return null;
  const v = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ status: string; scheduled_at: Date; scope_node_id: string; location_id: string | null; tower: string; project: string | null; developer: string }[]>`
      SELECT v.status, v.scheduled_at, v.scope_node_id, v.location_id, n.name AS tower, p.name AS project, o.display_name AS developer
      FROM site_visits v JOIN scope_nodes n ON n.id = v.scope_node_id
      LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
      JOIN orgs o ON o.id = v.org_id
      WHERE v.org_id = ${orgId} AND v.id = ${visitId}`;
    return r ?? null;
  });
  if (!v) return null;
  // The gallery this visit is at.
  const loc = await locationAt(orgId, v.scope_node_id, v.location_id);
  return {
    payload: passPayload(visitId, sig.toLowerCase()),
    status: v.status,
    at: v.scheduled_at.toISOString(),
    place: v.project ? `${v.project} ${v.tower}` : v.tower,
    developer: v.developer,
    directions: loc?.mapsUrl ?? null,
  };
}

/** Where the buyer came from, read inside the check-in's transaction and frozen with it. */
async function attributionIn(sql: TransactionSql, orgId: string, visitId: string): Promise<Record<string, unknown> | null> {
  const [l] = await sql<{ channel: string; source: string; lineage: Record<string, unknown>; publish_target_id: string | null; phone: string; scope_node_id: string }[]>`
    SELECT l.channel, l.source, l.lineage, l.publish_target_id, l.phone, v.scope_node_id
    FROM site_visits v JOIN leads l ON l.id = v.lead_id
    WHERE v.org_id = ${orgId} AND v.id = ${visitId}`;
  if (!l) return null;
  const claim = await liveClaim(sql, orgId, l.phone, l.scope_node_id);
  return attributionOf({
    channel: l.channel,
    source: l.source,
    lineage: l.lineage,
    publishTargetId: l.publish_target_id,
    claim: claim ? { id: claim.id, firm: claim.firm } : null,
  });
}

export type ScanResult =
  | { ok: true; visitId: string; buyer: string; at: string; flags: CheckinFlag[] }
  | { ok: false; code: string; message: string };

/**
 * A scan from the site team's phone, now or from its offline queue. The
 * pass's proof, the scanner's key at the visit's tower, the visit's window
 * and the site's distance are all judged here, whatever the phone thought.
 */
export async function checkInByScan(o: {
  orgId: string;
  userId: string;
  authz: Authz;
  payload: string;
  scannedAt: string;
  position: { lat: number; lng: number; accuracy: number } | null;
  receivedAt?: string;
}): Promise<ScanResult> {
  const pass = readPayload(o.payload);
  if (!pass || !passValid(secret(), o.orgId, pass.visitId, pass.sig)) {
    return { ok: false, code: "NOT_A_PASS", message: "This is not a pass for a visit here." };
  }
  const receivedAt = o.receivedAt ?? new Date().toISOString();
  const v = await withTenant(o.orgId, async (sql) => {
    const [r] = await sql<{ status: string; scheduled_at: Date; scope_node_id: string; location_id: string | null; path: string; buyer: string }[]>`
      SELECT v.status, v.scheduled_at, v.scope_node_id, v.location_id, n.path::text AS path, l.name AS buyer
      FROM site_visits v JOIN scope_nodes n ON n.id = v.scope_node_id JOIN leads l ON l.id = v.lead_id
      WHERE v.org_id = ${o.orgId} AND v.id = ${pass.visitId}`;
    return r ?? null;
  });
  if (!v) return { ok: false, code: "NOT_A_PASS", message: "This is not a pass for a visit here." };
  if (!o.authz.canAt("visit:confirm", v.path)) return { ok: false, code: "NOT_ALLOWED", message: "You cannot check in visits at this tower." };
  // The fence is the pin of the gallery this visit is at.
  const pin = await locationAt(o.orgId, v.scope_node_id, v.location_id);
  const verdict = judgeScan({
    status: v.status,
    scheduledAt: v.scheduled_at.toISOString(),
    scannedAt: o.scannedAt,
    receivedAt,
    position: o.position,
    pin: pin && pin.latitude !== null && pin.longitude !== null ? { lat: pin.latitude, lng: pin.longitude } : null,
  });
  if (!verdict.ok) {
    if (verdict.code !== "ALREADY") {
      await audit({ orgId: o.orgId, actorUserId: o.userId, action: "visit.checkin_refused", targetType: "site_visit", targetId: pass.visitId, metadata: { code: verdict.code } });
    }
    return { ok: false, code: verdict.code, message: verdict.message };
  }
  const done = await withTenant(o.orgId, async (sql) => {
    const attribution = await attributionIn(sql, o.orgId, pass.visitId);
    const r = await sql`
      UPDATE site_visits SET status = 'ON_SITE', arrived_at = ${new Date(o.scannedAt)}, checkin_method = 'QR',
             checkin_by = ${o.userId}, checkin_lat = ${o.position?.lat ?? null}, checkin_lng = ${o.position?.lng ?? null},
             checkin_accuracy_m = ${o.position ? Math.round(o.position.accuracy) : null}, checkin_distance_m = ${verdict.distance},
             checkin_flags = ${verdict.flags}, checkin_synced_at = now(),
             attribution = coalesce(attribution, ${attribution ? sql.json(attribution as never) : null}), updated_at = now()
      WHERE org_id = ${o.orgId} AND id = ${pass.visitId} AND status IN ('CONFIRMED', 'NO_SHOW')`;
    return r.count > 0;
  });
  if (!done) return { ok: false, code: "ALREADY", message: "Already checked in." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "visit.on_site", targetType: "site_visit", targetId: pass.visitId, metadata: { method: "QR", flags: verdict.flags } });
  await creditVisit(o.orgId, pass.visitId);
  return { ok: true, visitId: pass.visitId, buyer: v.buyer, at: v.scheduled_at.toISOString(), flags: verdict.flags };
}

/**
 * The check-in button on the visits screen, for a buyer with no pass to
 * show. Recorded as by hand, so it is never mistaken for a scanned one, and
 * attribution freezes the same way.
 */
export async function checkInByHand(o: { orgId: string; userId: string; visitId: string }): Promise<boolean> {
  const done = await withTenant(o.orgId, async (sql) => {
    const attribution = await attributionIn(sql, o.orgId, o.visitId);
    const r = await sql`
      UPDATE site_visits SET status = 'ON_SITE', arrived_at = coalesce(arrived_at, now()), checkin_method = 'MANUAL',
             checkin_by = ${o.userId}, checkin_synced_at = now(),
             attribution = coalesce(attribution, ${attribution ? sql.json(attribution as never) : null}), updated_at = now()
      WHERE org_id = ${o.orgId} AND id = ${o.visitId} AND status IN ('CONFIRMED', 'NO_SHOW')`;
    return r.count > 0;
  });
  if (done) {
    await audit({ orgId: o.orgId, actorUserId: o.userId, action: "visit.on_site", targetType: "site_visit", targetId: o.visitId, metadata: { method: "MANUAL" } });
    await creditVisit(o.orgId, o.visitId);
  }
  return done;
}

export type TodayPass = { visitId: string; buyer: string; time: string; place: string; status: string };

/**
 * Today's visits at the towers the viewer may check in at, so the scan page
 * can say whose pass it read even with no signal. Names and times only.
 */
export async function todaysPasses(orgId: string, scopes: string[], nowIso = new Date().toISOString()): Promise<TodayPass[]> {
  const day = ist(nowIso).date;
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - 330 * 60_000);
  const to = new Date(from.getTime() + 86_400_000);
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; name: string; scheduled_at: Date; tower: string; project: string | null; status: string }[]>`
    SELECT v.id, l.name, v.scheduled_at, n.name AS tower, p.name AS project, v.status
    FROM site_visits v JOIN leads l ON l.id = v.lead_id JOIN scope_nodes n ON n.id = v.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
    WHERE v.org_id = ${orgId} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
      AND v.status IN ('CONFIRMED', 'ON_SITE', 'NO_SHOW') AND n.path <@ ANY(${scopes}::ltree[])
    ORDER BY v.scheduled_at`);
  return rows.map((r) => ({
    visitId: r.id,
    buyer: r.name,
    time: ist(r.scheduled_at.toISOString()).time,
    place: r.project ? `${r.project} ${r.tower}` : r.tower,
    status: r.status,
  }));
}
