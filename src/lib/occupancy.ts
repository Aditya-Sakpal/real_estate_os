import { audit, withTenant } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import { ocDateProblem } from "./tax-rules.ts";
import type { Authz } from "./rbac-rules.ts";

/**
 * The day a phase's occupancy certificate was received, on its registration
 * record. A quote reads it: GST on a flat is nil once the certificate is in.
 * Recording it is `rera:manage` at the phase, the key that records the rest
 * of the registration.
 *
 * Imports are relative so the checks can load this straight from source.
 */

/** Each phase's day, where one is recorded. */
export async function occupancyDates(orgId: string, phaseIds: readonly string[]): Promise<Map<string, string>> {
  const ids = phaseIds.filter(isNodeId);
  if (!ids.length) return new Map();
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; day: string }[]>`
    SELECT scope_node_id AS id, oc_received_on::text AS day FROM registration_records
    WHERE org_id = ${orgId} AND scope_node_id = ANY(${ids}::uuid[]) AND oc_received_on IS NOT NULL`);
  return new Map(rows.map((r) => [r.id, r.day]));
}

/** Record, change or clear the day. A phase with no registration record yet gets one, still unregistered. */
export async function recordOccupancy(o: {
  orgId: string;
  userId: string;
  authz: Authz;
  phaseId: string;
  date: string;
  today: string;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  if (!isNodeId(o.phaseId)) return { ok: false, message: "Pick the phase." };
  const [phase] = await withTenant(o.orgId, (sql) => sql<{ path: string; name: string }[]>`
    SELECT path::text AS path, name FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.phaseId} AND kind = 'PHASE'`);
  if (!phase) return { ok: false, message: "That phase does not exist here." };
  if (!o.authz.canAt("rera:manage", phase.path)) return { ok: false, message: "You cannot record this phase's certificate." };
  const bad = ocDateProblem(o.date, o.today);
  if (bad) return { ok: false, message: bad };
  const day = o.date.trim() || null;
  await withTenant(o.orgId, (sql) => sql`
    INSERT INTO registration_records (scope_node_id, org_id, oc_received_on, updated_at)
    VALUES (${o.phaseId}, ${o.orgId}, ${day}, now())
    ON CONFLICT (scope_node_id) DO UPDATE SET oc_received_on = EXCLUDED.oc_received_on, updated_at = now()`);
  await audit({
    orgId: o.orgId, actorUserId: o.userId, action: "rera.occupancy_recorded", targetType: "scope_node", targetId: o.phaseId,
    metadata: { cleared: !day },
  });
  return { ok: true, message: day ? `${phase.name}: occupancy certificate recorded.` : `${phase.name}: occupancy certificate cleared.` };
}
