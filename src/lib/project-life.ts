import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import { pausePublication } from "./publish.ts";
import { haltBroadcasts } from "./broadcast-halt.ts";
import { readTerms } from "./billing-rules.ts";
import { readPlanKey } from "./plan-purchase-rules.ts";
export { retiredAt, retiredProjects } from "./project-state.ts";
import { planEndsOn, reactivateRefusal, readProjectStatus, type ProjectStatus, type RetirePlan } from "./project-life-rules.ts";

/**
 * Retiring a sold-out project, and bringing one back.
 *
 * Retired is a status, not a deletion: every lead, visit, booking, post and
 * invoice stays readable. What stops is everything that would spend or
 * reach a buyer on the project's behalf: its schedules, its running ads,
 * the calls and messages waiting for its buyers (a booked buyer's visit and
 * booking messages still go), and its plan, at the end of the IST month.
 * A channel partner's retired project frees its slot on the firm's plan.
 */

type Sql = TransactionSql;

/** A project's status: RETIRED, or ACTIVE when nobody retired it. */
export async function projectStatusOf(sql: Sql, orgId: string, projectId: string): Promise<ProjectStatus> {
  const [r] = await sql<{ status: string }[]>`
    SELECT status FROM project_states WHERE org_id = ${orgId} AND project_id = ${projectId}`;
  return readProjectStatus(r?.status);
}

/** The plan the project runs on today, for the confirmation: its own, the firm's, or none. */
export async function retirePlanOf(sql: Sql, orgId: string, projectId: string, nowIso = new Date().toISOString()): Promise<RetirePlan> {
  const today = new Date(Date.parse(nowIso) + 330 * 60_000).toISOString().slice(0, 10);
  const rows = await sql<{ scope: string }[]>`
    SELECT scope FROM subscriptions
    WHERE org_id = ${orgId} AND ((scope = 'PROJECT' AND project_id = ${projectId}) OR scope = 'ORG')
      AND starts_on <= ${today}::date AND (ends_on IS NULL OR ends_on > ${today}::date)`;
  if (rows.some((r) => r.scope === "PROJECT")) return "PROJECT";
  if (rows.some((r) => r.scope === "ORG")) return "FIRM";
  return "NONE";
}

export type RetireReport ={ schedules: number; tasks: number; adsPaused: number; adsNotPaused: number; queuedCancelled: number; broadcasts: number; planEndsOn: string | null };

export async function retireProject(o: { orgId: string; userId: string; projectId: string; nowIso?: string }): Promise<{ ok: true; report: RetireReport } | { ok: false; message: string }> {
  const nowIso = o.nowIso ?? new Date().toISOString();
  const ends = planEndsOn(nowIso);
  const done = await withTenant(o.orgId, async (sql) => {
    const [p] = await sql<{ id: string; path: string }[]>`
      SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.projectId} AND kind = 'PROJECT'`;
    if (!p) return { ok: false as const, message: "That project does not exist here." };
    if ((await projectStatusOf(sql, o.orgId, p.id)) === "RETIRED") return { ok: false as const, message: "This project is already retired." };

    await sql`
      INSERT INTO project_states (org_id, project_id, status, retired_at, retired_by, updated_by)
      VALUES (${o.orgId}, ${p.id}, 'RETIRED', now(), ${o.userId}, ${o.userId})
      ON CONFLICT (org_id, project_id) DO UPDATE SET status = 'RETIRED', retired_at = now(),
        retired_by = EXCLUDED.retired_by, updated_by = EXCLUDED.updated_by, updated_at = now()`;

    // Every schedule on a brief at the project or a tower of it, and what it had not yet written.
    const schedules = await sql<{ id: string }[]>`
      UPDATE post_schedules s
      SET active = false, stopped_reason = 'Project retired', stopped_by = ${o.userId}, stopped_at = now(), updated_at = now()
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE s.org_id = ${o.orgId} AND s.active AND b.id = s.brief_id AND b.org_id = ${o.orgId} AND n.path <@ ${p.path}::ltree
      RETURNING s.id`;
    if (schedules.length) {
      await sql`
        UPDATE post_runs SET state = 'REFUSED', refusal_code = 'SCHEDULE_STOPPED', finished_at = now()
        WHERE org_id = ${o.orgId} AND state = 'PENDING' AND schedule_id = ANY(${schedules.map((s) => s.id)})`;
    }

    // Calls and messages waiting for its buyers. A booked buyer keeps the
    // messages about their visit and their booking.
    const tasks = await sql<{ id: string }[]>`
      UPDATE lead_tasks t SET state = 'CANCELLED', result = 'Project retired', done_at = now()
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE t.org_id = ${o.orgId} AND t.lead_id = l.id AND l.org_id = ${o.orgId}
        AND t.state = 'DUE' AND t.kind IN ('CALL', 'MESSAGE')
        AND n.path <@ ${p.path}::ltree
        AND NOT (l.stage = 'booked' AND t.kind = 'MESSAGE')
      RETURNING t.id`;

    // Its plan, at the end of this month. Price and terms are untouched.
    const ended = await sql<{ id: string }[]>`
      UPDATE subscriptions SET ends_on = ${ends}
      WHERE org_id = ${o.orgId} AND project_id = ${p.id} AND scope = 'PROJECT'
        AND starts_on < ${ends}::date AND (ends_on IS NULL OR ends_on > ${ends}::date)
      RETURNING id`;

    const spending = await sql<{ id: string }[]>`
      SELECT t.id FROM publish_targets t JOIN scope_nodes n ON n.id = t.phase_id
      WHERE t.org_id = ${o.orgId} AND t.state = 'ACTIVE' AND n.path <@ ${p.path}::ltree`;
    const queued = await sql<{ id: string }[]>`
      UPDATE publish_targets t
      SET state = 'CANCELLED', error_code = 'PROJECT_RETIRED', error = 'The project was retired before this went out.', updated_at = now()
      FROM scope_nodes n
      WHERE t.org_id = ${o.orgId} AND n.id = t.phase_id AND n.path <@ ${p.path}::ltree
        AND (t.state = 'QUEUED' OR (t.state = 'WORKING' AND t.lease_until <= now()))
      RETURNING t.id`;
    const phases = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${o.orgId} AND kind = 'PHASE' AND path <@ ${p.path}::ltree`;
    return {
      ok: true as const,
      schedules: schedules.length,
      tasks: tasks.length,
      planEnded: ended.length > 0,
      spending: spending.map((r) => r.id),
      queued: queued.length,
      phases: phases.map((r) => r.id),
    };
  });
  if (!done.ok) return done;

  // Running ads, through the same pause a person presses on Published.
  let adsPaused = 0;
  let adsNotPaused = 0;
  for (const id of done.spending) {
    const r = await pausePublication({ orgId: o.orgId, userId: o.userId, targetId: id }).catch(() => ({ ok: false as const }));
    if (r.ok) adsPaused += 1;
    else adsNotPaused += 1;
  }
  const broadcasts = await haltBroadcasts(o.orgId, done.phases);

  const report: RetireReport = {
    schedules: done.schedules,
    tasks: done.tasks,
    adsPaused,
    adsNotPaused,
    queuedCancelled: done.queued,
    broadcasts,
    planEndsOn: done.planEnded ? ends : null,
  };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "project.retired", targetType: "scope_node", targetId: o.projectId, metadata: report });
  return { ok: true, report };
}

/**
 * Bring a retired project back. Only the status moves: schedules stay
 * stopped and ads paused until a person starts them, and in production the
 * project runs nothing paid until it has a plan again.
 */
export async function reactivateProject(o: { orgId: string; userId: string; projectId: string; nowIso?: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const today = new Date(Date.parse(o.nowIso ?? new Date().toISOString()) + 330 * 60_000).toISOString().slice(0, 10);
  const out = await withTenant(o.orgId, async (sql) => {
    const [p] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.projectId} AND kind = 'PROJECT'`;
    if (!p) return "This project does not exist here.";
    const status = await projectStatusOf(sql, o.orgId, p.id);
    // A channel partner's firm plan covers so many projects at once.
    const [firm] = await sql<{ plan: string; terms: unknown }[]>`
      SELECT plan, terms FROM subscriptions
      WHERE org_id = ${o.orgId} AND scope = 'ORG' AND starts_on <= ${today}::date AND (ends_on IS NULL OR ends_on > ${today}::date)
      LIMIT 1`;
    const key = firm ? readPlanKey(firm.plan) : null;
    const firmCap = firm && key ? readTerms(key, firm.terms, "ORG").projects : null;
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM scope_nodes s
      WHERE s.org_id = ${o.orgId} AND s.kind = 'PROJECT'
        AND NOT EXISTS (SELECT 1 FROM project_states ps WHERE ps.org_id = s.org_id AND ps.project_id = s.id AND ps.status = 'RETIRED')`;
    const refusal = reactivateRefusal({ status, firmCap, activeProjects: n });
    if (refusal) return refusal;
    await sql`
      UPDATE project_states SET status = 'ACTIVE', retired_at = NULL, updated_by = ${o.userId}, updated_at = now()
      WHERE org_id = ${o.orgId} AND project_id = ${p.id}`;
    return null;
  });
  if (out) return { ok: false, message: out };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "project.reactivated", targetType: "scope_node", targetId: o.projectId, metadata: {} });
  return { ok: true };
}
