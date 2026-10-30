import { audit, withTenant } from "./db/index.ts";

/**
 * The kill switch, for broadcasts: every broadcast still to send on a phase
 * that stopped being advertisable is halted, and nobody on it waiting for
 * their turn gets it. Called from `haltBlocked()`, which the post worker runs
 * every pass and the RERA sweep runs as pass 3, so a lapse stops a broadcast
 * the way it pauses an ad. Kept apart from `broadcast.ts` so the publisher
 * needs nothing of the broadcaster to call it.
 */
export async function haltBroadcasts(orgId: string, blockedPhaseIds: readonly string[]): Promise<number> {
  if (!blockedPhaseIds.length) return 0;
  const halted = await withTenant(orgId, async (sql) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE broadcasts SET status = 'HALTED', halted_reason = 'REGISTRATION', halted_at = now(),
        lease_until = NULL, lease_holder = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND status IN ('APPROVED', 'SENDING') AND phase_id = ANY(${[...blockedPhaseIds]})
      RETURNING id`;
    if (rows.length) {
      await sql`
        UPDATE broadcast_recipients SET status = 'CANCELLED', refusal = 'NOT_ADVERTISABLE', updated_at = now()
        WHERE org_id = ${orgId} AND status = 'WAITING' AND broadcast_id = ANY(${rows.map((r) => r.id)})`;
    }
    return rows;
  });
  for (const b of halted) {
    await audit({ orgId, actorUserId: null, action: "broadcast.halted", targetType: "broadcast", targetId: b.id, metadata: { reason: "REGISTRATION" } });
  }
  return halted.length;
}
