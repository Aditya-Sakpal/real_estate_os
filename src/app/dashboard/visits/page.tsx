import { redirect } from "next/navigation";
import { lensFor } from "@/lib/mask";
import { getViewer } from "@/lib/console";
import { withTenant } from "@/lib/db";
import { addDays, showTime } from "@/lib/lead-rules";
import { PURPOSE_LABEL, ist, kindOf, type Purpose } from "@/lib/cadence-rules";
import { dayWord } from "@/lib/visit-rules";
import { WEEK } from "@/lib/visit-sample";
import { hasVisits, listVisits } from "@/lib/visits";
import { VisitDay, type LadderStep } from "./VisitDay";

/**
 * The site visits of one week, one day at a time.
 *
 * Real visits come from `site_visits`, filtered to where the viewer holds
 * `visit:read`, together with what the engine did for each one (the
 * confirmation, the reminders, the road back after a no-show) read from
 * `lead_tasks`, so the unfolded visit shows what actually went out rather
 * than what the clock says should have.
 *
 * Until the first visit exists the sheet is empty on the tenant's own towers:
 * a client's console holds only its own data.
 *
 * "Today" and "now" are fixed here, in Asia/Kolkata. A visit at 11:00 is on
 * site at 11:20 by the gallery's clock, not by whatever timezone the browser
 * happens to be in.
 */
export default async function VisitsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("visit:read")) redirect("/dashboard");

  const orgId = viewer.state.org.id;
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const fromDate = addDays(today, WEEK[0]);
  const toDate = addDays(today, WEEK[WEEK.length - 1]);
  const scopes = viewer.authz.scopesFor("visit:read");
  // Every buyer's number as the policy lets this person see it.
  const lens = await lensFor(orgId, viewer.authz);

  // None of the three needs another's answer.
  const [any, visits, ladder] = await Promise.all([
    hasVisits(orgId),
    listVisits(orgId, fromDate, toDate, scopes, lens),
    loadLadder(orgId, fromDate, toDate, scopes, today),
  ]);

  // With real visits the projects offered are the ones this viewer has
  // visits at, so a tower nobody here can see never appears as a choice.
  const own = viewer.state.places
    .filter((p) => p.kind === "PHASE")
    .map((p) => (p.under ? `${p.under} · ${p.name}` : p.name));
  const places = any
    ? [...new Set(visits.map((v) => v.place))]
    : own;

  return (
    <VisitDay
      today={today}
      nowIso={now.toISOString()}
      places={places}
      real={visits}
      ladder={ladder}
      can={{
        checkIn: viewer.authz.can("visit:confirm"),
        outcome: viewer.authz.can("visit:outcome"),
        schedule: viewer.authz.can("visit:schedule"),
        partners: viewer.authz.can("partner:read"),
      }}
    />
  );
}

/**
 * What the engine did, or will do, for each visit in the week: every task
 * hung on a visit, in the order it falls due, worded for the gallery.
 *
 * The engine's own check that a visit happened is left out; what it decides
 * shows as the visit's state. A step that was skipped or called off stays on
 * screen, because "why did the buyer get no directions" is the question this
 * column exists to answer.
 */
async function loadLadder(
  orgId: string,
  fromDate: string,
  toDate: string,
  scopes: string[],
  today: string,
): Promise<Record<string, LadderStep[]>> {
  const from = new Date(Date.parse(`${fromDate}T00:00:00Z`) - 330 * 60_000);
  const to = new Date(Date.parse(`${toDate}T00:00:00Z`) + 86_400_000 - 330 * 60_000);
  const rows = await withTenant(orgId, (sql) => sql<
    { visit_id: string; purpose: string; state: string; due_at: Date; done_at: Date | null; scheduled_at: Date }[]
  >`
    SELECT t.visit_id, t.purpose, t.state, t.due_at, t.done_at, v.scheduled_at
    FROM lead_tasks t
    JOIN site_visits v ON v.id = t.visit_id
    JOIN scope_nodes n ON n.id = v.scope_node_id
    WHERE t.org_id = ${orgId} AND v.org_id = ${orgId}
      AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
      AND n.path <@ ANY(${scopes}::ltree[])
    ORDER BY t.due_at`);

  const whenOf = (d: Date) => {
    const at = ist(d.toISOString());
    const word = dayWord(at.date, today);
    const day = word === "Today" || word === "Tomorrow" || word === "Yesterday" ? word.toLowerCase() : word;
    return `${day}, ${showTime(at.time)}`;
  };

  const out: Record<string, LadderStep[]> = {};
  for (const r of rows) {
    const before = r.due_at.getTime() <= r.scheduled_at.getTime();
    let step: LadderStep | null = null;

    if (r.purpose === "NO_SHOW_CHECK") continue;
    if (r.purpose === "LAPSE_CHECK") {
      if (r.state === "DONE") step = { label: "Lapsed, nobody replied", when: whenOf(r.done_at ?? r.due_at), state: "missed", before };
      else if (r.state === "DUE" || r.state === "WORKING") step = { label: "Lapses if nobody replies", when: whenOf(r.due_at), state: "due", before };
    } else {
      const label = PURPOSE_LABEL[r.purpose as Purpose];
      if (!label) continue;
      const call = kindOf(r.purpose as Purpose) === "CALL";
      step =
        r.state === "DONE"
          ? { label, when: whenOf(r.done_at ?? r.due_at), state: "done", before }
          : r.state === "DUE" || r.state === "WORKING"
            ? { label, when: whenOf(r.due_at), state: "due", before }
            : r.state === "FAILED"
              ? { label, when: call ? "The call did not go through" : "Could not be sent", state: "missed", before }
              : r.state === "CANCELLED"
                ? { label, when: "Called off", state: "off", before }
                : { label, when: call ? "Not placed" : "Not sent", state: "off", before };
    }
    if (step) (out[r.visit_id] ??= []).push(step);
  }
  return out;
}
