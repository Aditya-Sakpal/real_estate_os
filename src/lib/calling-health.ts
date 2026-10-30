import { withTenant } from "./db/index.ts";
import { pickupFell } from "./calling-rules.ts";
import { showPhone } from "./call-rules.ts";

/**
 * Calling numbers buyers have stopped picking up, for Today. A number whose
 * pickup rate over the last seven days fell 40 per cent or more against the
 * four weeks before (`pickupFell()`) is usually being shown as spam on
 * buyers' phones, and every call from it is wasted until it is replaced.
 *
 * Read from the AI calls placed from each number, ours not the buyer's
 * failures: a call that failed on our side is left out, as is one refused
 * before it dialled.
 */
export type PickupAlert = { id: string; title: string; why: string };

export async function pickupAlerts(orgId: string, nowIso = new Date().toISOString()): Promise<PickupAlert[]> {
  const now = Date.parse(nowIso);
  const week = new Date(now - 7 * 86_400_000);
  const from = new Date(now - 35 * 86_400_000);
  const rows = await withTenant(orgId, (sql) => sql<{ from_number: string; recent: number; recent_up: number; before: number; before_up: number }[]>`
    SELECT from_number,
           count(*) FILTER (WHERE placed_at >= ${week})::int AS recent,
           count(*) FILTER (WHERE placed_at >= ${week} AND connectivity = 'connected' AND outcome IS DISTINCT FROM 'NO_ANSWER')::int AS recent_up,
           count(*) FILTER (WHERE placed_at < ${week})::int AS before,
           count(*) FILTER (WHERE placed_at < ${week} AND connectivity = 'connected' AND outcome IS DISTINCT FROM 'NO_ANSWER')::int AS before_up
    FROM calls
    WHERE org_id = ${orgId} AND direction = 'OUT' AND from_number IS NOT NULL
      AND status = 'DONE' AND NOT system_failure AND placed_at >= ${from}
    GROUP BY from_number`);
  const out: PickupAlert[] = [];
  for (const r of rows) {
    const fell = pickupFell({ dialled: r.recent, picked: r.recent_up }, { dialled: r.before, picked: r.before_up });
    if (!fell) continue;
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    out.push({
      id: `pickup-fell-${r.from_number}`,
      title: `Fewer buyers are picking up calls from ${showPhone(r.from_number)}`,
      why: `It may be marked as spam. ${pct(fell.recentRate)} picked up this week, against ${pct(fell.beforeRate)} before.`,
    });
  }
  return out;
}

/** The same, never failing the page that asked: Today without this item is better than no Today. */
export async function pickupAlertsFor(orgId: string): Promise<PickupAlert[]> {
  return pickupAlerts(orgId).catch((e) => {
    console.warn("calling: pickup rates could not be read,", (e as Error).message);
    return [];
  });
}

/**
 * An organisation whose AI is calling with nobody to put a buyer through to:
 * no one on duty on its sales team and no hand-off number of its own. Its
 * agents never offer the sales manager then (`NO_SALES_NOTE`), and tell the
 * buyer the sales manager will call back, so Today asks for the team.
 */
export async function handoffAlert(orgId: string, nowIso = new Date().toISOString()): Promise<PickupAlert | null> {
  const since = new Date(Date.parse(nowIso) - 14 * 86_400_000);
  const [r] = await withTenant(orgId, (sql) => sql<{ calls: number; team: number; own: number }[]>`
    SELECT
      (SELECT count(*)::int FROM calls WHERE org_id = ${orgId} AND placed_at >= ${since} AND status <> 'REFUSED') AS calls,
      (SELECT count(*)::int FROM sales_team WHERE org_id = ${orgId} AND on_duty) AS team,
      (SELECT count(*)::int FROM calling_settings WHERE org_id = ${orgId} AND handoff_number IS NOT NULL) AS own`);
  if (!r || r.calls === 0 || r.team > 0 || r.own > 0) return null;
  return {
    id: "handoff-nobody",
    title: "Nobody can take a buyer the AI hands over",
    why: "The AI tells buyers the sales manager will call them back, instead of putting them through. Add your sales team so it can connect them.",
  };
}

/** The same, never failing the page that asked. */
export async function handoffAlertFor(orgId: string): Promise<PickupAlert | null> {
  return handoffAlert(orgId).catch((e) => {
    console.warn("calling: the sales team could not be read,", (e as Error).message);
    return null;
  });
}
