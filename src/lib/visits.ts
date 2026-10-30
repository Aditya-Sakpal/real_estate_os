import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import { creditVisit } from "./partners.ts";
import { LANGUAGE_LABEL, type Language } from "./call-rules.ts";
import { ist } from "./cadence-rules.ts";
import { readLocation, type SiteLocation } from "./site-rules.ts";
import type { Facts, PathStage } from "./lead-rules.ts";
import type { Lens } from "./mask-rules.ts";
import type { Interest, Objection, Visit, VisitStatus } from "./visit-rules.ts";
import { alternatives, slotOf } from "./slot-rules.ts";
import { holdAlternatives, hostFor, hoursOf, projectOf, releaseSeat, takeSeat, visitHoursOf } from "./slots.ts";
import { galleryFor, readGalleryLabel } from "./visit-hours-rules.ts";

/**
 * Site visits and where the site is: the reads and writes the visits screen,
 * the board and the engine share.
 *
 * A visit is one row per booking. Moving it is a new row and the old one
 * points at it, so a buyer who rebooked twice shows three visits and the
 * no-show that started it stays answerable.
 */

// ---------------------------------------------------------------------------
// Where the site is
// ---------------------------------------------------------------------------

export type LocationView = SiteLocation & { id: string; label: string; nodeId: string; inherited: boolean; from: string };

type GalleryRow = {
  id: string; scope_node_id: string; name: string; label: string; depth: number; created_at: Date;
  address: string | null; latitude: string | null; longitude: string | null; maps_url: string;
};

const viewOf = (r: GalleryRow, nodeId: string): LocationView => ({
  id: r.id,
  label: r.label,
  nodeId: r.scope_node_id,
  inherited: r.scope_node_id !== nodeId,
  from: r.name,
  address: r.address,
  latitude: r.latitude === null ? null : Number(r.latitude),
  longitude: r.longitude === null ? null : Number(r.longitude),
  mapsUrl: r.maps_url,
});

/** Every gallery at a node or above it, deepest first, each the way a screen shows it. */
export async function galleriesAt(orgId: string, nodeId: string): Promise<LocationView[]> {
  const rows = await withTenant(orgId, (sql) => galleryRows(sql, orgId, nodeId));
  return [...rows]
    .sort((a, b) => b.depth - a.depth || a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
    .map((r) => viewOf(r, nodeId));
}

async function galleryRows(sql: TransactionSql, orgId: string, nodeId: string): Promise<GalleryRow[]> {
  return sql<GalleryRow[]>`
    SELECT s.id, s.scope_node_id, n.name, s.label, nlevel(n.path) AS depth, s.created_at,
           s.address, s.latitude::text, s.longitude::text, s.maps_url
    FROM site_locations s
    JOIN scope_nodes n ON n.id = s.scope_node_id
    JOIN scope_nodes t ON t.id = ${nodeId} AND t.org_id = ${orgId}
    WHERE s.org_id = ${orgId} AND n.path @> t.path`;
}

/**
 * The gallery in force at a node: the one a visit names when it is still at
 * or above the node, else the first at the nearest level that has any.
 */
export async function locationAt(orgId: string, nodeId: string, locationId?: string | null): Promise<LocationView | null> {
  const rows = await withTenant(orgId, (sql) => galleryRows(sql, orgId, nodeId));
  const pick = galleryFor(
    rows.map((r) => ({ ...r, createdAt: r.created_at.toISOString() })),
    locationId ?? null,
  );
  return pick ? viewOf(pick, nodeId) : null;
}

export async function saveLocation(opts: {
  orgId: string;
  userId: string;
  nodeId: string;
  link: string;
  address: string;
  /** Which gallery at the node; the first one ("Main gallery") without it. */
  label?: string | null;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const read = readLocation({ link: opts.link, address: opts.address });
  if (!read.ok) return read;
  const named = readGalleryLabel(opts.label);
  if (!named.ok) return named;
  const loc = read.location;
  const saved = await withTenant(opts.orgId, async (sql) => {
    const [node] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.nodeId} AND kind IN ('PROJECT', 'PHASE')`;
    if (!node) return false;
    await sql`
      INSERT INTO site_locations (org_id, scope_node_id, label, address, latitude, longitude, maps_url, updated_by)
      VALUES (${opts.orgId}, ${node.id}, ${named.label}, ${loc.address}, ${loc.latitude}, ${loc.longitude}, ${loc.mapsUrl}, ${opts.userId})
      ON CONFLICT (org_id, scope_node_id, lower(label)) DO UPDATE SET
        address = EXCLUDED.address, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
        maps_url = EXCLUDED.maps_url, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    return true;
  });
  if (!saved) return { ok: false, message: "That project or tower does not exist here." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "site.location_saved", targetType: "scope_node", targetId: opts.nodeId, metadata: { pin: loc.latitude !== null } });
  return { ok: true };
}

/**
 * Take one gallery off a project or tower. A visit that named it goes back
 * to the first gallery there; the last gallery of a node is kept, since a
 * confirmation with no directions sends a buyer nowhere.
 */
export async function removeLocation(opts: { orgId: string; userId: string; nodeId: string; locationId: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const gone = await withTenant(opts.orgId, async (sql) => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM site_locations WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.nodeId}`;
    if (!rows.some((r) => r.id === opts.locationId)) return "UNKNOWN" as const;
    if (rows.length < 2) return "LAST" as const;
    await sql`DELETE FROM site_locations WHERE org_id = ${opts.orgId} AND id = ${opts.locationId}`;
    return "OK" as const;
  });
  if (gone === "UNKNOWN") return { ok: false, message: "That gallery is not here." };
  if (gone === "LAST") return { ok: false, message: "Keep at least one gallery here. Change its address instead." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "site.location_removed", targetType: "scope_node", targetId: opts.nodeId, metadata: {} });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Writing visits
// ---------------------------------------------------------------------------

export type Booked =
  /** Seated: the hour had room, and the visit is on. */
  | { kind: "CONFIRMED"; visitId: string; replaced: string[]; hostId: string | null }
  /** The hour was full: the visit waits, and three other hours are held for the buyer. */
  | { kind: "REQUESTED"; visitId: string; replaced: string[]; holds: { holdId: string; startsAt: string }[] }
  /** The hour was full and the caller asked for a refusal: nothing was written. */
  | { kind: "FULL"; alternatives: string[] };

/**
 * Book a visit, taking its seat in the project's ledger in the same
 * transaction. Anything else still on for this lead is moved to it and gives
 * its seat back.
 *
 * A full hour either waits and holds three other hours for the buyer
 * (`ifFull: "OFFER"`, for a visit agreed on a call, where the buyer is
 * offered them on WhatsApp) or is refused with those hours named and nothing
 * written (`"REFUSE"`, for a person booking in the console, who can pick one).
 */
export async function bookVisit(opts: {
  orgId: string;
  leadId: string;
  atIso: string;
  via: "AI_CALL" | "CONSOLE" | "CRM";
  askedFor?: string | null;
  callId?: string | null;
  hostId?: string | null;
  /** Who hosts when nobody placed at the tower is free that hour: the lead's owner. */
  fallbackHostId?: string | null;
  userId?: string | null;
  ifFull?: "OFFER" | "REFUSE";
  /** The gallery the buyer goes to; the one their last visit named, else the first. */
  locationId?: string | null;
  /** For checks: the moment the booking is judged at. */
  nowIso?: string;
}): Promise<Booked | null> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const out = await withTenant(opts.orgId, async (sql): Promise<Booked | null> => {
    const [lead] = await sql<{ id: string; scope_node_id: string }[]>`
      SELECT id, scope_node_id FROM leads WHERE org_id = ${opts.orgId} AND id = ${opts.leadId} FOR UPDATE`;
    if (!lead) return null;
    // The same call reporting twice books one visit.
    if (opts.callId) {
      const [same] = await sql<{ id: string; status: string; host_id: string | null }[]>`
        SELECT id, status, host_id FROM site_visits WHERE org_id = ${opts.orgId} AND call_id = ${opts.callId} LIMIT 1`;
      if (same) {
        return same.status === "REQUESTED"
          ? { kind: "REQUESTED", visitId: same.id, replaced: [], holds: [] }
          : { kind: "CONFIRMED", visitId: same.id, replaced: [], hostId: same.host_id };
      }
    }
    // A visit agreed on a call is at the tower the call was about, which a
    // person may have chosen over the one the buyer enquired about.
    const [onCall] = opts.callId
      ? await sql<{ scope_node_id: string }[]>`
          SELECT c.scope_node_id FROM calls c JOIN scope_nodes n ON n.id = c.scope_node_id
          WHERE c.org_id = ${opts.orgId} AND c.id = ${opts.callId} AND n.kind = 'PHASE'`
      : [];
    const nodeId = onCall?.scope_node_id ?? lead.scope_node_id;
    const projectId = await projectOf(sql, opts.orgId, nodeId);
    const slotId = projectId ? await takeSeat(sql, { orgId: opts.orgId, projectId, atIso: opts.atIso, leadId: lead.id }) : null;
    const seated = !projectId || slotId !== null;
    if (!seated && opts.ifFull === "REFUSE") {
      const hourAt = await hoursOf(sql, opts.orgId, projectId!, weekFrom(opts.atIso));
      const open = await visitHoursOf(sql, opts.orgId, projectId!);
      return { kind: "FULL", alternatives: alternatives({ askedIso: opts.atIso, nowIso, hourAt, hours: open }).map((a) => a.startsAt) };
    }
    const host = seated
      ? opts.hostId ?? (await hostFor(sql, opts.orgId, nodeId, opts.atIso))?.id ?? opts.fallbackHostId ?? null
      : null;
    const [v] = await sql<{ id: string }[]>`
      INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, booked_via, asked_for, host_id, call_id, created_by,
                               status, slot_id, location_id)
      VALUES (${opts.orgId}, ${lead.id}, ${nodeId}, ${new Date(opts.atIso)}, ${opts.via},
              ${opts.askedFor?.slice(0, 200) ?? null}, ${host}, ${opts.callId ?? null}, ${opts.userId ?? null},
              ${seated ? "CONFIRMED" : "REQUESTED"}, ${slotId},
              -- The gallery chosen, or the one the visit this replaces named,
              -- kept only while it is at or above the tower.
              (SELECT s.id FROM site_locations s
                 JOIN scope_nodes ln ON ln.id = s.scope_node_id
                 JOIN scope_nodes vn ON vn.id = ${nodeId}
               WHERE s.org_id = ${opts.orgId} AND ln.path @> vn.path
                 AND s.id = coalesce(${opts.locationId ?? null}::uuid, (
                   SELECT x.location_id FROM site_visits x
                   WHERE x.org_id = ${opts.orgId} AND x.lead_id = ${lead.id}
                     AND x.status IN ('CONFIRMED', 'NO_SHOW', 'REQUESTED')
                   ORDER BY x.scheduled_at DESC LIMIT 1))))
      RETURNING id`;
    const moved = await sql<{ id: string; slot_id: string | null }[]>`
      UPDATE site_visits SET status = 'MOVED', moved_to = ${v.id}, updated_at = now()
      WHERE org_id = ${opts.orgId} AND lead_id = ${lead.id} AND id <> ${v.id} AND status IN ('CONFIRMED', 'NO_SHOW', 'REQUESTED')
      RETURNING id, slot_id`;
    for (const m of moved) await releaseSeat(sql, opts.orgId, m.slot_id);
    if (seated) return { kind: "CONFIRMED", visitId: v.id, replaced: moved.map((m) => m.id), hostId: host };
    const holds = await holdAlternatives(sql, {
      orgId: opts.orgId,
      projectId: projectId!,
      leadId: lead.id,
      visitId: v.id,
      askedIso: opts.atIso,
      nowIso,
    });
    return { kind: "REQUESTED", visitId: v.id, replaced: moved.map((m) => m.id), holds };
  });
  if (out && out.kind !== "FULL" && !out.replaced.length) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.userId ?? null,
      action: out.kind === "REQUESTED" ? "visit.requested" : "visit.booked",
      targetType: "site_visit",
      targetId: out.visitId,
      metadata: { via: opts.via, ...(out.kind === "REQUESTED" ? { offered: out.holds.length } : {}) },
    });
  }
  return out;
}

const weekFrom = (iso: string) => {
  const day = slotOf(iso).day;
  return Array.from({ length: 9 }, (_, i) => new Date(Date.parse(`${day}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
};

/**
 * The buyer tapped one of the hours offered. The hold is theirs and still
 * live (or its seat is still free), the waiting visit takes that time and
 * the seat, and the other holds are let go. Null when the hold is gone, is
 * somebody else's, or the hour filled after it lapsed.
 */
export async function bookFromHold(o: { orgId: string; holdId: string; phone: string }): Promise<{ visitId: string; leadId: string; atIso: string } | null> {
  const out = await withTenant(o.orgId, async (sql) => {
    const [h] = await sql<{ id: string; slot_id: string; lead_id: string; visit_id: string | null; starts_at: Date; released_at: Date | null; project_id: string }[]>`
      SELECT h.id, h.slot_id, h.lead_id, h.visit_id, h.starts_at, h.released_at, s.project_id
      FROM visit_holds h JOIN leads l ON l.id = h.lead_id JOIN visit_slots s ON s.id = h.slot_id
      WHERE h.org_id = ${o.orgId} AND h.id = ${o.holdId} AND l.phone = ${o.phone}
      FOR UPDATE OF h`;
    if (!h || h.released_at) return null;
    const [visit] = h.visit_id
      ? await sql<{ id: string; status: string }[]>`
          SELECT id, status FROM site_visits WHERE org_id = ${o.orgId} AND id = ${h.visit_id} FOR UPDATE`
      : [];
    // An offer for a visit waiting on a time, or a re-offer that names none.
    if (h.visit_id && (!visit || visit.status !== "REQUESTED")) return null;
    const atIso = h.starts_at.toISOString();
    // The hold's own seat, or any seat left in that hour once it lapsed.
    const slotId = await takeSeat(sql, { orgId: o.orgId, projectId: h.project_id, atIso, leadId: h.lead_id });
    if (!slotId) return null;
    const [lead] = await sql<{ scope_node_id: string; owner_id: string | null }[]>`SELECT scope_node_id, owner_id FROM leads WHERE id = ${h.lead_id}`;
    const host = (await hostFor(sql, o.orgId, lead.scope_node_id, atIso))?.id ?? lead.owner_id;
    if (visit) {
      await sql`
        UPDATE site_visits SET status = 'CONFIRMED', scheduled_at = ${h.starts_at}, slot_id = ${slotId},
               host_id = coalesce(host_id, ${host}), updated_at = now()
        WHERE org_id = ${o.orgId} AND id = ${visit.id}`;
      return { visitId: visit.id, leadId: h.lead_id, atIso };
    }
    const [v] = await sql<{ id: string }[]>`
      INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, booked_via, host_id, status, slot_id)
      VALUES (${o.orgId}, ${h.lead_id}, ${lead.scope_node_id}, ${h.starts_at}, 'WHATSAPP', ${host}, 'CONFIRMED', ${slotId})
      RETURNING id`;
    const moved = await sql<{ id: string; slot_id: string | null }[]>`
      UPDATE site_visits SET status = 'MOVED', moved_to = ${v.id}, updated_at = now()
      WHERE org_id = ${o.orgId} AND lead_id = ${h.lead_id} AND id <> ${v.id} AND status IN ('CONFIRMED', 'NO_SHOW', 'REQUESTED')
      RETURNING id, slot_id`;
    for (const m of moved) await releaseSeat(sql, o.orgId, m.slot_id);
    return { visitId: v.id, leadId: h.lead_id, atIso };
  });
  if (out) await audit({ orgId: o.orgId, actorUserId: null, action: "visit.booked", targetType: "site_visit", targetId: out.visitId, metadata: { via: "WHATSAPP_OFFER" } });
  return out;
}

export type VisitRowState = { id: string; leadId: string; status: string; scheduledAt: string; scopeNodeId: string };

export async function loadVisit(orgId: string, visitId: string): Promise<VisitRowState | null> {
  if (!/^[0-9a-f-]{36}$/i.test(visitId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ id: string; lead_id: string; status: string; scheduled_at: Date; scope_node_id: string }[]>`
      SELECT id, lead_id, status, scheduled_at, scope_node_id FROM site_visits WHERE org_id = ${orgId} AND id = ${visitId}`;
    return r ? { id: r.id, leadId: r.lead_id, status: r.status, scheduledAt: r.scheduled_at.toISOString(), scopeNodeId: r.scope_node_id } : null;
  });
}

/** Move a visit from one state to another, only from the states that allow it. */
export async function setVisitStatus(opts: {
  orgId: string;
  visitId: string;
  to: "ON_SITE" | "VISITED" | "NO_SHOW" | "LAPSED" | "CANCELLED";
  from: string[];
  outcome?: { interest: string; objection: string; next: string; note?: string } | null;
  userId?: string | null;
}): Promise<boolean> {
  const n = await withTenant(opts.orgId, async (sql) => {
    const rows = await sql<{ slot_id: string | null }[]>`
      UPDATE site_visits SET
        status = ${opts.to},
        arrived_at = CASE WHEN ${opts.to} = 'ON_SITE' THEN coalesce(arrived_at, now()) ELSE arrived_at END,
        completed_at = CASE WHEN ${opts.to} = 'VISITED' THEN now() ELSE completed_at END,
        outcome = CASE WHEN ${opts.to} = 'VISITED' THEN ${opts.outcome ? sql.json(opts.outcome as never) : null} ELSE outcome END,
        updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.visitId} AND status = ANY(${opts.from})
      RETURNING slot_id`;
    // A visit called off gives its seat back for somebody else.
    if (opts.to === "CANCELLED") for (const r of rows) await releaseSeat(sql, opts.orgId, r.slot_id);
    return rows;
  });
  if (n.count) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId ?? null, action: `visit.${opts.to.toLowerCase()}`, targetType: "site_visit", targetId: opts.visitId });
    // A buyer a partner registered, now on site: the partner's claim runs on.
    if (opts.to === "ON_SITE" || opts.to === "VISITED") await creditVisit(opts.orgId, opts.visitId);
  }
  return n.count > 0;
}

/**
 * The admission gate said no: the visit is barred with the reason, its seat
 * goes back, and its reminders are skipped when they come due because each
 * asks whether the visit is still on.
 */
export async function blockVisit(o: { orgId: string; visitId: string; reason: string }): Promise<boolean> {
  const blocked = await withTenant(o.orgId, async (sql) => {
    const [r] = await sql<{ slot_id: string | null; lead_id: string }[]>`
      UPDATE site_visits SET status = 'BLOCKED', blocked_reason = ${o.reason.slice(0, 200)}, updated_at = now()
      WHERE org_id = ${o.orgId} AND id = ${o.visitId} AND status IN ('CONFIRMED', 'REQUESTED')
      RETURNING slot_id, lead_id`;
    if (!r) return false;
    await releaseSeat(sql, o.orgId, r.slot_id);
    await sql`
      UPDATE leads SET needs_person = ${`Visit stopped: ${o.reason}`.slice(0, 200)}, updated_at = now()
      WHERE org_id = ${o.orgId} AND id = ${r.lead_id}`;
    return true;
  });
  if (blocked) await audit({ orgId: o.orgId, actorUserId: null, action: "visit.blocked", targetType: "site_visit", targetId: o.visitId });
  return blocked;
}

/** What the admission gate reads about one visit. */
export async function admissionFacts(orgId: string, visitId: string): Promise<{ status: string; nodeId: string; seated: boolean; optedOut: boolean } | null> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ status: string; scope_node_id: string; slot_id: string | null; opted_out: boolean }[]>`
      SELECT v.status, v.scope_node_id, v.slot_id,
             EXISTS (SELECT 1 FROM call_suppressions s WHERE s.org_id = v.org_id AND s.phone = l.phone) AS opted_out
      FROM site_visits v JOIN leads l ON l.id = v.lead_id
      WHERE v.org_id = ${orgId} AND v.id = ${visitId}`;
    return r ? { status: r.status, nodeId: r.scope_node_id, seated: r.slot_id !== null, optedOut: r.opted_out } : null;
  });
}

// ---------------------------------------------------------------------------
// Reading visits, in the shape the visits screen draws
// ---------------------------------------------------------------------------

const STATUS_OF: Record<string, VisitStatus> = {
  REQUESTED: "requested",
  BLOCKED: "blocked",
  CONFIRMED: "confirmed",
  ON_SITE: "on_site",
  VISITED: "visited",
  NO_SHOW: "no_show",
  LAPSED: "lapsed",
  MOVED: "moved",
  CANCELLED: "cancelled",
};

/**
 * Visits from `fromDate` to `toDate` (IST civil dates, inclusive), with each
 * buyer's number as the viewer's `lens` lets them see it.
 */
export async function listVisits(
  orgId: string,
  fromDate: string,
  toDate: string,
  scopes: string[] | null,
  lens: Lens,
): Promise<Visit[]> {
  const from = new Date(Date.parse(`${fromDate}T00:00:00Z`) - 330 * 60_000);
  const to = new Date(Date.parse(`${toDate}T00:00:00Z`) + 86_400_000 - 330 * 60_000);
  const rows = await withTenant(orgId, (sql) => sql<
    {
      id: string; lead_name: string; phone: string; scheduled_at: Date; status: string; booked_via: string;
      created_at: Date; arrived_at: Date | null; outcome: Record<string, string> | null; asked_for: string | null;
      blocked_reason: string | null;
      project: string | null; tower: string; facts: Facts; language: Language; temperature: "HOT" | "WARM" | "COLD" | null;
      source: string; host: string | null; moved_at: Date | null; visit_no: number;
      lead_id: string; path: string; path_stage: PathStage;
      cp_firm: string | null; cp_agent: string | null; cp_until: Date | null;
    }[]
  >`
    SELECT v.id, v.lead_id, n.path::text AS path, l.path_stage, l.name AS lead_name, l.phone, v.scheduled_at, v.status, v.booked_via, v.created_at, v.arrived_at,
           v.outcome, v.asked_for, v.blocked_reason, p.name AS project, n.name AS tower, l.facts, l.language, l.temperature, l.source,
           coalesce(u.name, u.email::text) AS host, m.scheduled_at AS moved_at,
           (SELECT count(*)::int FROM site_visits x
             WHERE x.lead_id = v.lead_id AND x.created_at <= v.created_at AND (x.status <> 'MOVED' OR x.id = v.id)) AS visit_no,
           cp.firm AS cp_firm, cp.agent AS cp_agent, cp.until AS cp_until
    FROM site_visits v
    JOIN leads l ON l.id = v.lead_id
    JOIN scope_nodes n ON n.id = v.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
    LEFT JOIN users u ON u.id = v.host_id
    LEFT JOIN site_visits m ON m.id = v.moved_to
    -- The partner whose claim the buyer is on, named as the desk names the firm.
    LEFT JOIN LATERAL (
      SELECT (SELECT f.name FROM partner_firms f
               WHERE f.org_id = r.org_id AND f.cp_org_id = r.cp_org_id
               ORDER BY (f.mandate_id IS NOT DISTINCT FROM g.mandate_id) DESC, f.created_at LIMIT 1) AS firm,
             r.agent_name AS agent, r.valid_until AS until
      FROM client_registrations r LEFT JOIN grants g ON g.id = r.grant_id
      WHERE r.org_id = v.org_id AND r.lead_id = v.lead_id AND r.verdict = 'REGISTERED'
      ORDER BY r.created_at DESC LIMIT 1
    ) cp ON true
    WHERE v.org_id = ${orgId} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
      AND ${scopes ? sql`n.path <@ ANY(${scopes}::ltree[])` : sql`true`}
    ORDER BY v.scheduled_at`);

  return rows.map((r) => {
    const at = ist(r.scheduled_at.toISOString());
    const f = r.facts ?? {};
    const outcome = r.outcome
      ? {
          interest: (r.outcome.interest ?? "Warm") as Interest,
          objection: (r.outcome.objection ?? "None") as Objection,
          next: r.outcome.next ?? "Nothing planned",
          shown: [],
          note: r.outcome.note,
        }
      : undefined;
    const project = r.project ?? r.tower;
    return {
      id: r.id,
      buyer: r.lead_name,
      leadId: r.lead_id,
      phone: lens.phone(r.phone, { path: r.path, stage: r.path_stage }),
      date: at.date,
      time: at.time,
      project,
      place: r.project ? `${r.project} · ${r.tower}` : r.tower,
      config: f.config ?? "Not known",
      budget: f.budget ?? "Not known",
      lang: LANGUAGE_LABEL[r.language] ?? r.language,
      temp: r.temperature ?? "WARM",
      party: 1,
      decider: true,
      visitNo: Math.max(1, r.visit_no),
      source: r.source,
      cp: r.cp_firm
        ? {
            firm: r.cp_firm,
            agent: r.cp_agent ?? "Partner",
            tagDaysLeft: r.cp_until ? Math.max(0, Math.ceil((r.cp_until.getTime() - Date.now()) / 86_400_000)) : 0,
          }
        : null,
      bookedVia: r.booked_via === "AI_CALL" ? "the AI call" : r.booked_via === "WHATSAPP" ? "WhatsApp" : r.booked_via === "CRM" ? "the CRM" : "the console",
      bookedOn: ist(r.created_at.toISOString()).date,
      host: r.host ?? f.visitHost ?? null,
      status: STATUS_OF[r.status] ?? "confirmed",
      arrivedAt: r.arrived_at ? ist(r.arrived_at.toISOString()).time : undefined,
      outcome,
      movedTo: r.moved_at ? { date: ist(r.moved_at.toISOString()).date, time: ist(r.moved_at.toISOString()).time } : undefined,
      toShow: f.config ? [f.config] : [],
      ask: r.asked_for ?? undefined,
      blockedWhy: r.blocked_reason ?? undefined,
    } satisfies Visit;
  });
}

/** Whether any real visit exists, so the screen knows to stop showing samples. */
export async function hasVisits(orgId: string): Promise<boolean> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ any: boolean }[]>`SELECT EXISTS (SELECT 1 FROM site_visits WHERE org_id = ${orgId}) AS any`;
    return !!r?.any;
  });
}

/** Every visit one lead has had, newest first, for the lead's own page. */
export async function leadVisits(orgId: string, leadId: string): Promise<{ id: string; at: string; status: VisitStatus; host: string | null; bookedVia: string; outcome: Record<string, string> | null }[]> {
  const rows = await withTenant(orgId, (sql) => sql<
    { id: string; scheduled_at: Date; status: string; host: string | null; booked_via: string; outcome: Record<string, string> | null }[]
  >`
    SELECT v.id, v.scheduled_at, v.status, coalesce(u.name, u.email::text) AS host, v.booked_via, v.outcome
    FROM site_visits v LEFT JOIN users u ON u.id = v.host_id
    WHERE v.org_id = ${orgId} AND v.lead_id = ${leadId}
    ORDER BY v.scheduled_at DESC`);
  return rows.map((r) => ({
    id: r.id,
    at: r.scheduled_at.toISOString(),
    status: STATUS_OF[r.status] ?? "confirmed",
    host: r.host,
    bookedVia: r.booked_via === "AI_CALL" ? "the AI call" : r.booked_via === "WHATSAPP" ? "WhatsApp" : r.booked_via === "CRM" ? "the CRM" : "the console",
    outcome: r.outcome,
  }));
}
