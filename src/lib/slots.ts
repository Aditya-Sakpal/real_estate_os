import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import { ALL_PERMISSIONS } from "./permissions.ts";
import { mergeRoles, type RoleRow } from "./rbac-rules.ts";
import {
  DEFAULT_HOSTS,
  HOLD_MINUTES,
  alternatives,
  capacityAt,
  freeSeats,
  hostsOnShift,
  hostsProblem,
  pickHost,
  readWeek,
  slotOf,
  type HostCandidate,
  type HostHours,
  type HourState,
} from "./slot-rules.ts";
import { hoursFromRow, hoursToRow, readVisitHours, slotHoursOn, type VisitHours } from "./visit-hours-rules.ts";

/**
 * Visit capacity: the reads and writes around `slot-rules.ts`.
 *
 * Every seat is taken by one statement that says how many are left, so two
 * bookings racing for the last one resolve in the database. A seat is only
 * ever taken inside the caller's transaction (`takeSeat()` takes the
 * caller's `sql`), so the visit and its seat land together or not at all.
 */

type Sql = TransactionSql;

/** The project a tower sits in, which is where capacity is counted. */
export async function projectOf(sql: Sql, orgId: string, nodeId: string): Promise<string | null> {
  const [r] = await sql<{ id: string }[]>`
    SELECT p.id FROM scope_nodes p JOIN scope_nodes n ON n.id = ${nodeId} AND n.org_id = ${orgId}
    WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1`;
  return r?.id ?? null;
}

/** Hosts per hour for a project: its own, or the defaults. */
export async function capacityOf(sql: Sql, orgId: string, projectId: string): Promise<{ weekday: number; weekend: number; set: boolean }> {
  const [r] = await sql<{ weekday_hosts: number; weekend_hosts: number }[]>`
    SELECT weekday_hosts, weekend_hosts FROM visit_capacity WHERE org_id = ${orgId} AND project_id = ${projectId}`;
  return r ? { weekday: r.weekday_hosts, weekend: r.weekend_hosts, set: true } : { ...DEFAULT_HOSTS, set: false };
}

/** When a project's gallery takes visits: its own hours, or the default site day. */
export async function visitHoursOf(sql: Sql, orgId: string, projectId: string): Promise<VisitHours> {
  const [r] = await sql<{ weekday_open: number; weekday_last: number; weekend_open: number; weekend_last: number }[]>`
    SELECT weekday_open, weekday_last, weekend_open, weekend_last
    FROM visit_capacity WHERE org_id = ${orgId} AND project_id = ${projectId}`;
  return hoursFromRow(r ?? null);
}

/** A tower's or project's opening hours, through the project it sits in. */
export async function visitHoursAt(sql: Sql, orgId: string, nodeId: string): Promise<VisitHours> {
  const projectId = await projectOf(sql, orgId, nodeId);
  return projectId ? visitHoursOf(sql, orgId, projectId) : hoursFromRow(null);
}

/**
 * The hours the project's hosts keep, for people still active in the
 * organisation. Empty when nobody has hours, which leaves the project's own
 * number in charge.
 */
export async function hostHoursOf(sql: Sql, orgId: string, projectId: string): Promise<HostHours[]> {
  const rows = await sql<{ user_id: string; weekday: number; start_hour: number; end_hour: number }[]>`
    SELECT h.user_id, h.weekday, h.start_hour, h.end_hour
    FROM visit_host_hours h
    JOIN users u ON u.id = h.user_id AND u.erased_at IS NULL
    WHERE h.org_id = ${orgId} AND h.project_id = ${projectId}
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = h.org_id AND m.user_id = h.user_id AND m.status = 'ACTIVE')`;
  return rows.map((r) => ({ userId: r.user_id, weekday: r.weekday, from: r.start_hour, to: r.end_hour }));
}

/** The ledger row for one hour, made the first time anybody asks. */
async function slotRow(sql: Sql, orgId: string, projectId: string, day: string, hour: number): Promise<string> {
  const [cap, hours, open] = await Promise.all([capacityOf(sql, orgId, projectId), hostHoursOf(sql, orgId, projectId), visitHoursOf(sql, orgId, projectId)]);
  await sql`
    INSERT INTO visit_slots (org_id, project_id, day, hour, capacity)
    VALUES (${orgId}, ${projectId}, ${day}, ${hour}, ${capacityAt(day, hour, cap, hours, open)})
    ON CONFLICT (org_id, project_id, day, hour) DO NOTHING`;
  const [r] = await sql<{ id: string }[]>`
    SELECT id FROM visit_slots WHERE org_id = ${orgId} AND project_id = ${projectId} AND day = ${day} AND hour = ${hour}`;
  return r.id;
}

/**
 * Take the seat for a visit starting at `atIso`, in one statement: a seat
 * is taken only while the hour's taken seats and other buyers' live holds
 * are fewer than its capacity. A hold this lead has on the hour is used up
 * rather than counted against it. Returns the slot, or null when full.
 */
export async function takeSeat(sql: Sql, o: { orgId: string; projectId: string; atIso: string; leadId: string }): Promise<string | null> {
  const { day, hour } = slotOf(o.atIso);
  const slotId = await slotRow(sql, o.orgId, o.projectId, day, hour);
  const [taken] = await sql<{ id: string }[]>`
    UPDATE visit_slots s SET taken = s.taken + 1
    WHERE s.org_id = ${o.orgId} AND s.id = ${slotId}
      AND s.taken + (SELECT count(*) FROM visit_holds h
                      WHERE h.slot_id = s.id AND h.released_at IS NULL AND h.expires_at > now()
                        AND h.lead_id <> ${o.leadId}) < s.capacity
    RETURNING s.id`;
  if (!taken) return null;
  // The seat this lead was holding is the seat it just took.
  await sql`
    UPDATE visit_holds SET released_at = now()
    WHERE org_id = ${o.orgId} AND lead_id = ${o.leadId} AND released_at IS NULL`;
  return taken.id;
}

/** Give a seat back: a visit moved, cancelled, barred or recorded as missed. */
export async function releaseSeat(sql: Sql, orgId: string, slotId: string | null): Promise<void> {
  if (!slotId) return;
  await sql`UPDATE visit_slots SET taken = greatest(taken - 1, 0) WHERE org_id = ${orgId} AND id = ${slotId}`;
}

/** Every hour's state for a project over some days, for the picker and the offer. */
export async function hoursOf(sql: Sql, orgId: string, projectId: string, days: string[]): Promise<(day: string, hour: number) => HourState> {
  const [cap, hours, open] = await Promise.all([capacityOf(sql, orgId, projectId), hostHoursOf(sql, orgId, projectId), visitHoursOf(sql, orgId, projectId)]);
  const rows = await sql<{ day: string; hour: number; capacity: number; taken: number; held: number }[]>`
    SELECT s.day::text AS day, s.hour, s.capacity, s.taken,
           (SELECT count(*)::int FROM visit_holds h WHERE h.slot_id = s.id AND h.released_at IS NULL AND h.expires_at > now()) AS held
    FROM visit_slots s
    WHERE s.org_id = ${orgId} AND s.project_id = ${projectId} AND s.day = ANY(${days}::date[])`;
  const map = new Map(rows.map((r) => [`${r.day}:${r.hour}`, r]));
  // An hour the gallery is closed takes nobody, whatever an older ledger row says.
  return (day, hour) => {
    if (!slotHoursOn(open, day).includes(hour)) return { day, hour, capacity: 0, taken: 0, held: 0 };
    return map.get(`${day}:${hour}`) ?? { day, hour, capacity: capacityAt(day, hour, cap, hours, open), taken: 0, held: 0 };
  };
}

const nextDays = (from: string, n: number) =>
  Array.from({ length: n + 1 }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

/**
 * Hold three other hours for a buyer whose hour was full, each for ten
 * minutes, and say which. Nothing is held when nothing is free in the week.
 */
export async function holdAlternatives(
  sql: Sql,
  o: { orgId: string; projectId: string; leadId: string; visitId: string | null; askedIso: string; nowIso: string },
): Promise<{ holdId: string; startsAt: string }[]> {
  const hourAt = await hoursOf(sql, o.orgId, o.projectId, nextDays(slotOf(o.askedIso).day, 8));
  const open = await visitHoursOf(sql, o.orgId, o.projectId);
  const picks = alternatives({ askedIso: o.askedIso, nowIso: o.nowIso, hourAt, hours: open });
  const out: { holdId: string; startsAt: string }[] = [];
  for (const p of picks) {
    const slotId = await slotRow(sql, o.orgId, o.projectId, p.day, p.hour);
    // Held only while a seat is still free, asked in the statement itself.
    const [h] = await sql<{ id: string }[]>`
      INSERT INTO visit_holds (org_id, slot_id, lead_id, visit_id, starts_at, expires_at)
      SELECT ${o.orgId}, s.id, ${o.leadId}, ${o.visitId}, ${p.startsAt}, now() + ${`${HOLD_MINUTES} minutes`}::interval
      FROM visit_slots s
      WHERE s.id = ${slotId}
        AND s.taken + (SELECT count(*) FROM visit_holds x WHERE x.slot_id = s.id AND x.released_at IS NULL AND x.expires_at > now()) < s.capacity
      RETURNING id`;
    if (h) out.push({ holdId: h.id, startsAt: p.startsAt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Who hosts
// ---------------------------------------------------------------------------

/**
 * The least-loaded host at a tower for the hour a visit starts in: an active
 * member holding `visit:outcome` at the tower or above it, free that hour,
 * the ones placed at the project or the tower first. Null when nobody is.
 */
export async function hostFor(sql: Sql, orgId: string, nodeId: string, atIso: string): Promise<{ id: string; name: string } | null> {
  const { day, hour } = slotOf(atIso);
  const projectId = await projectOf(sql, orgId, nodeId);
  const hours = projectId ? await hostHoursOf(sql, orgId, projectId) : [];
  // Where hosts keep hours, the ones on the floor that hour are the pool.
  const onShift = hours.length ? new Set(hostsOnShift(hours, day, hour)) : null;
  const [roles, members] = await Promise.all([
    sql<RoleRow[]>`SELECT key, label, description, min_kind, can_delegate, source, permissions FROM org_roles WHERE org_id = ${orgId}`,
    sql<{ user_id: string; name: string | null; email: string; role: string; kind: string; same_hour: number; same_day: number }[]>`
      SELECT m.user_id, u.name, u.email::text AS email, m.role, s.kind,
             (SELECT count(*)::int FROM site_visits v
               WHERE v.org_id = ${orgId} AND v.host_id = m.user_id AND v.status IN ('CONFIRMED', 'ON_SITE')
                 AND (v.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date
                 AND extract(hour FROM v.scheduled_at AT TIME ZONE 'Asia/Kolkata') = ${hour}) AS same_hour,
             (SELECT count(*)::int FROM site_visits v
               WHERE v.org_id = ${orgId} AND v.host_id = m.user_id AND v.status IN ('CONFIRMED', 'ON_SITE', 'VISITED')
                 AND (v.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date) AS same_day
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      JOIN scope_nodes s ON s.id = m.scope_node_id
      WHERE m.org_id = ${orgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL
        AND s.path @> (SELECT path FROM scope_nodes WHERE id = ${nodeId} AND org_id = ${orgId})`,
  ]);
  const byKey = new Map(mergeRoles(roles).map((r) => [r.key, r]));
  const seen = new Map<string, HostCandidate>();
  for (const m of members) {
    const role = byKey.get(m.role);
    if (!role) continue;
    const all = role.permissions.includes(ALL_PERMISSIONS);
    // A host with hours was chosen for holding `visit:confirm`; without
    // hours, whoever may record a visit hosts.
    const hosts = onShift ? ["visit:confirm", "visit:outcome"] : ["visit:outcome"];
    if (!all && !hosts.some((p) => role.permissions.includes(p))) continue;
    const wide = m.kind === "ORG" || m.kind === "ENTITY" || m.kind === "REGION";
    const prev = seen.get(m.user_id);
    const c: HostCandidate = {
      id: m.user_id,
      name: m.name?.trim() || m.email.split("@")[0],
      wide,
      sameHour: m.same_hour,
      sameDay: m.same_day,
      ...(onShift ? { onShift: onShift.has(m.user_id) } : {}),
    };
    if (!prev || (prev.wide && !wide)) seen.set(m.user_id, c);
  }
  const host = pickHost([...seen.values()]);
  return host ? { id: host.id, name: host.name } : null;
}

// ---------------------------------------------------------------------------
// The visits screen's capacity card
// ---------------------------------------------------------------------------

export type ProjectCapacity = { projectId: string; name: string; weekday: number; weekend: number; set: boolean };

/** Hosts per hour for the projects the viewer may manage visits at. */
export async function listCapacity(orgId: string, scopes: string[]): Promise<ProjectCapacity[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; name: string; weekday_hosts: number | null; weekend_hosts: number | null }[]>`
    SELECT p.id, p.name, c.weekday_hosts, c.weekend_hosts
    FROM scope_nodes p
    LEFT JOIN visit_capacity c ON c.org_id = p.org_id AND c.project_id = p.id
    WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path <@ ANY(${scopes}::ltree[])
    ORDER BY p.name`);
  return rows.map((r) => ({
    projectId: r.id,
    name: r.name,
    weekday: r.weekday_hosts ?? DEFAULT_HOSTS.weekday,
    weekend: r.weekend_hosts ?? DEFAULT_HOSTS.weekend,
    set: r.weekday_hosts !== null,
  }));
}

/**
 * Save a project's hosts per hour. Hours already in the ledger from today on
 * take the new capacity; a seat already taken is never taken away, so an hour
 * cut below its bookings just takes no more.
 */
export async function saveCapacity(o: { orgId: string; userId: string; projectId: string; weekday: string; weekend: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const problem = hostsProblem(o.weekday) ?? hostsProblem(o.weekend);
  if (problem) return { ok: false, message: problem };
  const weekday = Number(o.weekday.trim());
  const weekend = Number(o.weekend.trim());
  const saved = await withTenant(o.orgId, async (sql) => {
    const [p] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.projectId} AND kind = 'PROJECT'`;
    if (!p) return false;
    await sql`
      INSERT INTO visit_capacity (org_id, project_id, weekday_hosts, weekend_hosts, updated_by)
      VALUES (${o.orgId}, ${p.id}, ${weekday}, ${weekend}, ${o.userId})
      ON CONFLICT (org_id, project_id) DO UPDATE SET weekday_hosts = EXCLUDED.weekday_hosts,
        weekend_hosts = EXCLUDED.weekend_hosts, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await refreshLedger(sql, o.orgId, p.id);
    return true;
  });
  if (!saved) return { ok: false, message: "That project does not exist here." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "visit.capacity_saved", targetType: "scope_node", targetId: o.projectId, metadata: { weekday, weekend } });
  return { ok: true };
}

/** Free seats per hour on one day at a project, for the move picker. */
export async function freeHours(orgId: string, nodeId: string, day: string): Promise<{ hour: number; free: number }[]> {
  return withTenant(orgId, async (sql) => {
    const projectId = await projectOf(sql, orgId, nodeId);
    if (!projectId) return [];
    const hourAt = await hoursOf(sql, orgId, projectId, [day]);
    const open = await visitHoursOf(sql, orgId, projectId);
    return slotHoursOn(open, day).map((hour) => ({ hour, free: freeSeats(hourAt(day, hour)) }));
  });
}

/** One project's hosts per hour and opening hours, for its page. */
export async function projectCapacity(orgId: string, projectId: string): Promise<{ weekday: number; weekend: number; set: boolean; hours: VisitHours }> {
  return withTenant(orgId, async (sql) => {
    const [cap, hours] = await Promise.all([capacityOf(sql, orgId, projectId), visitHoursOf(sql, orgId, projectId)]);
    return { ...cap, hours };
  });
}

/**
 * Save when a project's gallery takes visits. The ledger from today on
 * takes the capacity the new hours give; a seat already taken is never
 * taken away, so a visit booked into an hour now closed stands.
 */
export async function saveVisitHours(o: {
  orgId: string;
  userId: string;
  projectId: string;
  raw: { weekdayOpen: string; weekdayLast: string; weekendOpen: string; weekendLast: string };
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const read = readVisitHours(o.raw);
  if (!read.ok) return read;
  const row = hoursToRow(read.hours);
  const saved = await withTenant(o.orgId, async (sql) => {
    const [p] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.projectId} AND kind = 'PROJECT'`;
    if (!p) return false;
    await sql`
      INSERT INTO visit_capacity (org_id, project_id, weekday_hosts, weekend_hosts,
                                  weekday_open, weekday_last, weekend_open, weekend_last, updated_by)
      VALUES (${o.orgId}, ${p.id}, ${DEFAULT_HOSTS.weekday}, ${DEFAULT_HOSTS.weekend},
              ${row.weekday_open}, ${row.weekday_last}, ${row.weekend_open}, ${row.weekend_last}, ${o.userId})
      ON CONFLICT (org_id, project_id) DO UPDATE SET
        weekday_open = EXCLUDED.weekday_open, weekday_last = EXCLUDED.weekday_last,
        weekend_open = EXCLUDED.weekend_open, weekend_last = EXCLUDED.weekend_last,
        updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await refreshLedger(sql, o.orgId, p.id);
    return true;
  });
  if (!saved) return { ok: false, message: "That project does not exist here." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "visit.hours_saved", targetType: "scope_node", targetId: o.projectId, metadata: row });
  return { ok: true };
}

/**
 * Give the ledger's hours from today on the capacity they have now: one a
 * host on the floor where the project keeps hours, else the project's own
 * number. A seat already taken is never taken away; an hour cut below its
 * bookings simply takes no more.
 */
async function refreshLedger(sql: Sql, orgId: string, projectId: string): Promise<void> {
  const [cap, hours, open] = await Promise.all([capacityOf(sql, orgId, projectId), hostHoursOf(sql, orgId, projectId), visitHoursOf(sql, orgId, projectId)]);
  const rows = await sql<{ id: string; day: string; hour: number }[]>`
    SELECT id, day::text AS day, hour FROM visit_slots
    WHERE org_id = ${orgId} AND project_id = ${projectId} AND day >= (now() AT TIME ZONE 'Asia/Kolkata')::date`;
  for (const r of rows) {
    await sql`UPDATE visit_slots SET capacity = ${capacityAt(r.day, r.hour, cap, hours, open)} WHERE org_id = ${orgId} AND id = ${r.id}`;
  }
}

// ---------------------------------------------------------------------------
// Hosts and their hours, on the project's page
// ---------------------------------------------------------------------------

export type GalleryHost = { id: string; name: string; hours: { weekday: number; from: number; to: number }[] };

/**
 * The people who may host at a project (an active member holding
 * `visit:confirm` at the project or above it), each with the hours they
 * keep there. The ones with hours first, then by name.
 */
export async function listHosts(orgId: string, projectId: string): Promise<GalleryHost[]> {
  return withTenant(orgId, async (sql) => {
    const [roles, members, hours] = await Promise.all([
      sql<RoleRow[]>`SELECT key, label, description, min_kind, can_delegate, source, permissions FROM org_roles WHERE org_id = ${orgId}`,
      sql<{ user_id: string; name: string | null; email: string | null; role: string }[]>`
        SELECT m.user_id, u.name, u.email::text AS email, m.role
        FROM memberships m
        JOIN users u ON u.id = m.user_id
        JOIN scope_nodes s ON s.id = m.scope_node_id
        WHERE m.org_id = ${orgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL
          AND s.path @> (SELECT path FROM scope_nodes WHERE id = ${projectId} AND org_id = ${orgId} AND kind = 'PROJECT')`,
      hostHoursOf(sql, orgId, projectId),
    ]);
    const byKey = new Map(mergeRoles(roles).map((r) => [r.key, r]));
    const out = new Map<string, GalleryHost>();
    for (const m of members) {
      const role = byKey.get(m.role);
      if (!role) continue;
      if (!role.permissions.includes(ALL_PERMISSIONS) && !role.permissions.includes("visit:confirm")) continue;
      if (out.has(m.user_id)) continue;
      out.set(m.user_id, {
        id: m.user_id,
        name: m.name?.trim() || (m.email ?? "").split("@")[0] || "Host",
        hours: hours.filter((h) => h.userId === m.user_id).map((h) => ({ weekday: h.weekday, from: h.from, to: h.to })),
      });
    }
    return [...out.values()].sort((a, b) => Number(b.hours.length > 0) - Number(a.hours.length > 0) || a.name.localeCompare(b.name));
  });
}

/**
 * Save one host's week at a project: the rows typed replace the week they
 * had, a day left empty is a day off, and the ledger from today on takes
 * the capacity the new hours give. The host must be somebody who may host
 * there.
 */
export async function saveHostHours(o: {
  orgId: string;
  userId: string;
  projectId: string;
  hostId: string;
  week: Partial<Record<number, { from: string; to: string }>>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const open = await withTenant(o.orgId, (sql) => visitHoursOf(sql, o.orgId, o.projectId));
  const read = readWeek(o.hostId, o.week, open);
  if (!read.ok) return read;
  const hosts = await listHosts(o.orgId, o.projectId);
  if (!hosts.some((h) => h.id === o.hostId)) return { ok: false, message: "Choose somebody who checks buyers in at this project." };
  await withTenant(o.orgId, async (sql) => {
    await sql`DELETE FROM visit_host_hours WHERE org_id = ${o.orgId} AND project_id = ${o.projectId} AND user_id = ${o.hostId}`;
    for (const r of read.rows) {
      await sql`
        INSERT INTO visit_host_hours (org_id, project_id, user_id, weekday, start_hour, end_hour, updated_by)
        VALUES (${o.orgId}, ${o.projectId}, ${o.hostId}, ${r.weekday}, ${r.from}, ${r.to}, ${o.userId})`;
    }
    await refreshLedger(sql, o.orgId, o.projectId);
  });
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "visit.host_hours_saved",
    targetType: "scope_node",
    targetId: o.projectId,
    metadata: { host: o.hostId, days: read.rows.length },
  });
  return { ok: true };
}
