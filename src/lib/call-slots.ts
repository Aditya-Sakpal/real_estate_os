import { withTenant } from "./db/index.ts";
import { parseVisitTime } from "./cadence-rules.ts";
import { slotLabel, slotReply } from "./calling-rules.ts";
import { alternatives, freeSeats, slotOf } from "./slot-rules.ts";
import { hoursOf, projectOf, visitHoursOf } from "./slots.ts";
import { EARLIEST_OPEN, LATEST_START, opensAt } from "./visit-hours-rules.ts";

/** Any half hour some project opens for, so a time outside this one's hours is understood and then offered others. */
const WIDEST = { weekday: { open: EARLIEST_OPEN, last: LATEST_START }, weekend: { open: EARLIEST_OPEN, last: LATEST_START } };

/**
 * The agent's `check_visit_slot` tool: whether the time a buyer just named
 * has a free host at the project, and the nearby free hours when it does
 * not. Asked on the live call, so the agent offers 12 pm instead of agreeing
 * to an 11 am that already has every host taken.
 *
 * Read only. The seat is taken when the call ends and the visit is booked
 * (`bookVisit()`), which is also what settles two buyers racing for the last
 * seat: the one who loses it is offered other hours on WhatsApp.
 */
export async function slotForCall(o: {
  orgId: string;
  callId: string;
  said: string;
  nowIso?: string;
}): Promise<{ free: boolean; say: string } | null> {
  const now = o.nowIso ?? new Date().toISOString();
  return withTenant(o.orgId, async (sql) => {
    // Only a call still on the line may ask; a finished one has nothing to settle.
    // The tower the call is about, which may not be the one the buyer enquired about.
    const [call] = await sql<{ scope_node_id: string }[]>`
      SELECT c.scope_node_id FROM calls c
      WHERE c.org_id = ${o.orgId} AND c.id = ${o.callId} AND c.status IN ('PLACING', 'DIALLING')`;
    if (!call) return null;
    const projectId = await projectOf(sql, o.orgId, call.scope_node_id);
    const open = projectId ? await visitHoursOf(sql, o.orgId, projectId) : null;
    const at = parseVisitTime(o.said.slice(0, 120), now, projectId ? WIDEST : null);
    if (!at) return slotReply({ kind: "unclear" });
    const asked = slotLabel(at.at);
    if (!projectId) return slotReply({ kind: "free", asked });
    const first = slotOf(at.at).day;
    const days = Array.from({ length: 9 }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
    const hourAt = await hoursOf(sql, o.orgId, projectId, days);
    const { day, hour } = slotOf(at.at);
    // A time the gallery is closed is answered like a full one: the nearest hours it is open.
    if (opensAt(open, at.date, at.slot) && freeSeats(hourAt(day, hour)) > 0) return slotReply({ kind: "free", asked });
    const offers = alternatives({ askedIso: at.at, nowIso: now, hourAt, hours: open }).map((a) => slotLabel(a.startsAt));
    return slotReply({ kind: "full", asked, offers });
  });
}
