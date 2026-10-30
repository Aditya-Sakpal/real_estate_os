import type { TransactionSql } from "postgres";
import { withTenant } from "./db/index.ts";
import { ALL_PERMISSIONS } from "./permissions.ts";
import { mergeRoles, type RoleRow } from "./rbac-rules.ts";
import { ownerCandidates } from "./leads.ts";
import { hostFor } from "./slots.ts";
import {
  KEEPS,
  NOTHING_MOVED,
  departedLine,
  holdsAt,
  keepsFirm,
  leftBehind,
  movedAnything,
  orphanTitle,
  spread,
  type HeldGrant,
  type Reassigned,
} from "./departure-rules.ts";
import type { QueueItem } from "./queue.ts";

/**
 * A departing member's work moves on: the reads and writes around
 * `departure-rules.ts`.
 *
 * Called inside the transaction that ended or narrowed a membership (the
 * team page's Remove and Change role, and every SCIM path through
 * `syncPerson()`), after the change, so the person's remaining grants are
 * the ones that decide and the move commits or rolls back with it. That
 * includes the last-admin trigger: a removal it refuses moves nothing.
 *
 * Their open leads go to the least loaded member holding `lead:update` at
 * the lead's tower, a visit still to come to a host on the floor that hour
 * (else the lead's owner), and a partner firm they looked after to somebody
 * holding `partner:empanel` wherever the firm is empanelled. What nobody can
 * take is left with nobody, and Today says so. The audit row is written in
 * the same transaction, with counts only.
 */

type Sql = TransactionSql;

/** The person's live memberships in this organisation, as paths and what each role holds. */
async function grantsOf(sql: Sql, orgId: string, userId: string, roles: Map<string, { permissions: readonly string[] }>): Promise<HeldGrant[]> {
  const rows = await sql<{ role: string; path: string }[]>`
    SELECT m.role, s.path::text AS path
    FROM memberships m JOIN scope_nodes s ON s.id = m.scope_node_id
    WHERE m.org_id = ${orgId} AND m.user_id = ${userId} AND m.status = 'ACTIVE'`;
  return rows.flatMap((r) => {
    const role = roles.get(r.role);
    return role ? [{ path: r.path, permissions: role.permissions }] : [];
  });
}

export async function reassignDeparted(
  sql: Sql,
  o: { orgId: string; userId: string; name: string; actorUserId: string | null },
): Promise<Reassigned> {
  const { orgId, userId } = o;
  const roleRows = await sql<RoleRow[]>`
    SELECT key, label, description, min_kind, can_delegate, source, permissions FROM org_roles WHERE org_id = ${orgId}`;
  const roles = new Map(mergeRoles(roleRows).map((r) => [r.key, r]));
  const held = await grantsOf(sql, orgId, userId, roles);
  const out: Reassigned = { ...NOTHING_MOVED };
  const line = departedLine(o.name);

  // ---- leads -------------------------------------------------------------
  const owned = await sql<{ id: string; node_id: string; path: string }[]>`
    SELECT l.id, l.scope_node_id AS node_id, n.path::text AS path
    FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${orgId} AND l.owner_id = ${userId}
      AND l.stage NOT IN ('booked', 'lost') AND l.erased_at IS NULL
    ORDER BY l.last_activity_at DESC`;
  const leads = leftBehind(held, owned, KEEPS.lead);
  const newOwner = new Map<string, { id: string; name: string } | null>();
  const byNode = new Map<string, typeof leads>();
  for (const l of leads) byNode.set(l.node_id, [...(byNode.get(l.node_id) ?? []), l]);
  for (const [nodeId, list] of byNode) {
    const pool = (await ownerCandidates(sql, orgId, nodeId)).filter((c) => c.person.id !== userId);
    const names = new Map(pool.map((c) => [c.person.id, c.person.name]));
    const picks = spread(pool.map((c) => ({ id: c.person.id, name: c.person.name, admin: c.admin, load: c.open })), list.length);
    list.forEach((l, i) => {
      const id = picks[i];
      newOwner.set(l.id, id ? { id, name: names.get(id) ?? "" } : null);
    });
  }
  for (const l of leads) {
    const to = newOwner.get(l.id) ?? null;
    // The board names the owner in the facts as well as the column.
    await sql`
      UPDATE leads SET owner_id = ${to?.id ?? null},
             facts = CASE WHEN ${to !== null} AND facts ? 'owner' THEN jsonb_set(facts, '{owner}', to_jsonb(${to?.name ?? ""}::text)) ELSE facts END,
             updated_at = now()
      WHERE org_id = ${orgId} AND id = ${l.id} AND owner_id = ${userId}`;
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id, detail)
      VALUES (${orgId}, ${l.id}, 'ASSIGNED', ${line}, ${o.actorUserId},
              ${sql.json({ departed: userId, departed_name: o.name.slice(0, 120), to: to?.id ?? null } as never)})`;
    if (to) out.leads++;
    else out.leadsUnowned++;
  }

  // ---- visits still to come ------------------------------------------------
  const hosting = await sql<{ id: string; node_id: string; path: string; at: Date; lead_id: string; owner_id: string | null }[]>`
    SELECT v.id, v.scope_node_id AS node_id, n.path::text AS path, v.scheduled_at AS at, v.lead_id, l.owner_id
    FROM site_visits v
    JOIN scope_nodes n ON n.id = v.scope_node_id
    JOIN leads l ON l.id = v.lead_id
    WHERE v.org_id = ${orgId} AND v.host_id = ${userId}
      AND v.status IN ('REQUESTED', 'CONFIRMED') AND v.scheduled_at > now()
    ORDER BY v.scheduled_at`;
  for (const v of leftBehind(held, hosting, KEEPS.visit)) {
    const host = await hostFor(sql, orgId, v.node_id, v.at.toISOString());
    // Nobody on the floor: the lead's owner, who is still on the team by now.
    const to = host?.id ?? (v.owner_id && v.owner_id !== userId ? v.owner_id : null);
    const toName = host?.name ?? (to ? await nameOf(sql, to) : null);
    await sql`UPDATE site_visits SET host_id = ${to}, updated_at = now() WHERE org_id = ${orgId} AND id = ${v.id} AND host_id = ${userId}`;
    if (to && toName) {
      await sql`
        UPDATE leads SET facts = jsonb_set(facts, '{visitHost}', to_jsonb(${toName}::text)), updated_at = now()
        WHERE org_id = ${orgId} AND id = ${v.lead_id} AND facts->>'visitHost' = ${o.name}`;
    }
    if (to) out.visits++;
    else out.visitsUnhosted++;
  }

  // ---- partner firms on the developer's own desk ---------------------------
  const firms = await sql<{ id: string; paths: string[] }[]>`
    SELECT f.id,
           coalesce(array_agg(n.path::text) FILTER (WHERE n.id IS NOT NULL), '{}') AS paths
    FROM partner_firms f
    LEFT JOIN grants g ON g.org_id = f.org_id AND g.grantee_org_id = f.cp_org_id AND g.role = 'CHANNEL_PARTNER'
                      AND g.status <> 'ENDED' AND g.mandate_id IS NULL
    LEFT JOIN scope_nodes n ON n.id = g.scope_node_id
    WHERE f.org_id = ${orgId} AND f.rm_id = ${userId} AND f.mandate_id IS NULL
    GROUP BY f.id`;
  if (firms.length) {
    const [root] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG'`;
    const rootPath = root?.path ?? "";
    const lost = firms.filter((f) => !keepsFirm(held, f.paths, rootPath));
    if (lost.length) {
      const people = await firmManagers(sql, orgId, roles, userId);
      for (const f of lost) {
        const paths = f.paths.length ? f.paths : [rootPath];
        const able = people.filter((p) => paths.every((path) => holdsAt(p.grants, KEEPS.firm, path)));
        const [pick] = spread(able, 1);
        const chosen = able.find((p) => p.id === pick);
        if (chosen) chosen.load++;
        await sql`UPDATE partner_firms SET rm_id = ${pick ?? null}, updated_at = now() WHERE org_id = ${orgId} AND id = ${f.id} AND rm_id = ${userId}`;
        if (pick) out.firms++;
        else out.firmsUnmanaged++;
      }
    }
  }

  if (movedAnything(out)) {
    await sql`
      INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (${orgId}, ${o.actorUserId}, 'member.work_reassigned', 'user', ${userId},
              ${sql.json({ ...out } as never)})`;
  }
  return out;
}

async function nameOf(sql: Sql, userId: string): Promise<string | null> {
  const [u] = await sql<{ name: string | null; email: string | null }[]>`SELECT name, email::text AS email FROM users WHERE id = ${userId}`;
  return u ? u.name?.trim() || u.email?.split("@")[0] || null : null;
}

/** Everybody who could look after a partner firm, with what they hold and how many firms they already have. */
async function firmManagers(sql: Sql, orgId: string, roles: Map<string, { permissions: readonly string[] }>, leaving: string) {
  const rows = await sql<{ user_id: string; name: string | null; email: string | null; role: string; path: string; firms: number }[]>`
    SELECT m.user_id, u.name, u.email::text AS email, m.role, s.path::text AS path,
           (SELECT count(*)::int FROM partner_firms f WHERE f.org_id = ${orgId} AND f.rm_id = m.user_id) AS firms
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    JOIN scope_nodes s ON s.id = m.scope_node_id
    WHERE m.org_id = ${orgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL AND m.user_id <> ${leaving}`;
  const people = new Map<string, { id: string; name: string; admin: boolean; load: number; grants: HeldGrant[] }>();
  for (const r of rows) {
    const role = roles.get(r.role);
    if (!role) continue;
    const p = people.get(r.user_id) ?? {
      id: r.user_id,
      name: r.name?.trim() || r.email?.split("@")[0] || "",
      admin: false,
      load: r.firms,
      grants: [],
    };
    p.grants.push({ path: r.path, permissions: role.permissions });
    if (role.permissions.includes(ALL_PERMISSIONS)) p.admin = true;
    people.set(r.user_id, p);
  }
  return [...people.values()];
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

/**
 * Leads a departed owner left with nobody, one item per person who left.
 * Counted from the history line the move wrote, so a lead somebody has
 * since picked up drops out of the count.
 */
export async function departureQueue(orgId: string): Promise<QueueItem[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ departed: string; name: string; n: number }[]>`
    SELECT a.detail->>'departed' AS departed, max(a.detail->>'departed_name') AS name, count(*)::int AS n
    FROM leads l
    JOIN LATERAL (
      SELECT x.detail FROM lead_activity x
      WHERE x.org_id = l.org_id AND x.lead_id = l.id AND x.kind = 'ASSIGNED'
      ORDER BY x.at DESC LIMIT 1
    ) a ON true
    WHERE l.org_id = ${orgId} AND l.owner_id IS NULL AND l.erased_at IS NULL
      AND l.stage NOT IN ('booked', 'lost') AND a.detail ? 'departed'
    GROUP BY 1
    ORDER BY 3 DESC`);
  return rows.map((r) => ({
    id: `departed-${r.departed}`,
    severity: "warn" as const,
    title: orphanTitle(r.n, r.name ?? ""),
    why: "Nobody on the team is following them up. Give each one an owner from the pipeline.",
    action: "Open the pipeline",
    href: "/dashboard/leads",
    tag: null,
    resolvers: ["lead:update"],
  }));
}
