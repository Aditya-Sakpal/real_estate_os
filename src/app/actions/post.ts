"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { orgRoot } from "@/lib/scope-nodes";
import { requirePermission } from "@/lib/guard";
import { loadBrief } from "@/lib/campaign";
import {
  approveCreative,
  createSchedule,
  loadSchedule,
  rejectCreative,
  removeSchedule,
  saveSchedule,
  setOptIns,
  startSchedule,
  stopSchedule,
  type ScheduleInput,
} from "@/lib/post";
import { parseMinute, REVIEW_LEAD_MINUTES } from "@/lib/post-rules";
import { daysOf, weekFrom } from "@/lib/compose-rules";
import {
  outletsFrom,
  outletsInUse,
  parseRupees,
  pickDated,
  usesAd,
  AD_DAYS_DEFAULT,
} from "@/lib/plan-rules";
import { destinationsFor } from "@/lib/connect";
import {
  SCHEDULE_AD_DESTINATIONS,
  budgetCheck,
  defaultGoal,
  destinationDef,
  goalProblem,
  isAd,
  isAdGoal,
  type Destination,
} from "@/lib/connect-rules";
import { metaGoalFactsAt } from "@/lib/publish";
import { BROADCAST_DESTINATION } from "@/lib/broadcast-rules";
import { senderFor } from "@/lib/wa-numbers";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";
import { withTenant } from "@/lib/db";
import { isNodeId } from "@/lib/scope-rules";

/**
 * The writes behind scheduled posts.
 *
 * Two keys, and the split is deliberate. `campaign:create` writes a schedule,
 * the same key that writes the brief it hangs off. `creative:approve` decides
 * what goes out and stops what should not be running, which is a different
 * job held by a different set of roles: a RERA compliance officer holds no
 * create key at all and must still be able to stop a campaign.
 *
 * Stopping is deliberately a lower bar than starting, per
 * `doc/post-generation.md` section 1.b. A control only the person who started
 * the spend can stop is not a kill switch.
 */

export type PostState = { ok: boolean; message: string } | null;

/**
 * Back to the schedule page. `params` are fixed flags the page knows the
 * words for; a message is signed with `flash()` so the page shows only ours.
 */
function backToBrief(briefId: string, params: Record<string, string> = {}, error?: string): never {
  const q = [new URLSearchParams(params).toString(), error ? flash("error", error) : ""].filter(Boolean).join("&");
  redirect(`/dashboard/campaigns/brief/${briefId}/schedule${q ? `?${q}` : ""}`);
}

/**
 * The cadence as a form posts it.
 *
 * Every value is read through the pure parsers, so a time the browser's own
 * control did not produce, or a day index somebody edited into the markup,
 * resolves to nothing rather than to a number nobody meant. A bad time is a
 * missing time, which `scheduleGaps()` then names.
 */
function readInput(formData: FormData): ScheduleInput {
  const minute = parseMinute(String(formData.get("at") ?? ""));
  const lead = Number(formData.get("leadMinutes") ?? REVIEW_LEAD_MINUTES);
  const runs = Number(formData.get("maxRunsPerDay") ?? 1);
  const adDays = Number(formData.get("adDays") ?? AD_DAYS_DEFAULT);
  // One select per day, "kind_0" for Sunday through "kind_6". A value the
  // catalog does not know is a day off, the same as an empty one.
  const dayKinds = weekFrom(Array.from({ length: 7 }, (_, d) => String(formData.get(`kind_${d}`) ?? "")));
  return {
    name: String(formData.get("name") ?? ""),
    mode: String(formData.get("mode") ?? "REVIEW"),
    repeat: formData.get("repeat") === "DATES" ? "DATES" : "WEEKLY",
    dated: String(formData.get("dated") ?? "[]"),
    daysOfWeek: daysOf(dayKinds),
    dayKinds,
    dayOutlets: Array.from({ length: 7 }, (_, d) => String(formData.get(`outlet_${d}`) ?? "")),
    // -1 rather than 0: zero is midnight, which is a real time, so it cannot
    // also mean "nothing was given". `scheduleGaps()` refuses the negative.
    atMinute: minute ?? -1,
    leadMinutes: Number.isFinite(lead) ? lead : REVIEW_LEAD_MINUTES,
    maxRunsPerDay: Number.isFinite(runs) ? runs : 1,
    startsOn: String(formData.get("startsOn") ?? "").trim() || null,
    endsOn: String(formData.get("endsOn") ?? "").trim() || null,
    // Only when the form showed the choice: a form that did not (the person
    // cannot publish) leaves the schedule's destinations as they were.
    destinations: formData.get("destinationsShown") ? formData.getAll("destination").map(String) : undefined,
    adDailyBudget: parseRupees(String(formData.get("adDailyBudget") ?? "")),
    adDays: Number.isFinite(adDays) ? adDays : null,
    adGoal: formData.get("adGoal") ? String(formData.get("adGoal")) : null,
    broadcastCap: formData.get("broadcastCap") ? Math.trunc(Number(String(formData.get("broadcastCap")).replace(/[,\s]/g, ""))) || null : null,
    // The look of each kind, and a weekday's own, as JSON the server keeps to
    // what the brief can make.
    styles: String(formData.get("styles") ?? "{}"),
    dayStyles: String(formData.get("dayStyles") ?? "[]"),
  };
}

/**
 * Where a schedule publishes is a publishing decision, so it needs the
 * publish key on top of the one that writes the schedule. Without it the
 * choice is simply not taken from the form.
 */
function withinPublish(input: ScheduleInput, canPublish: boolean): ScheduleInput {
  return canPublish ? input : { ...input, destinations: undefined };
}

type Authz = Awaited<ReturnType<typeof requirePermission>>["authz"];

/**
 * Sending automatically approves and publishes every clean post on the
 * person's behalf, so it takes both of those keys at the schedule's own node.
 * Without this, somebody who may only write schedules could skip the people
 * who approve them. Turning it on also takes a tick saying they read the
 * warning; saving a schedule that already sends automatically does not ask
 * again.
 */
function autoRefusal(
  input: ScheduleInput,
  formData: FormData,
  authz: Authz,
  at: { path: string; mode: string | null },
): PostState {
  if (input.mode !== "AUTO") return null;
  if (!authz.canAt("creative:approve", at.path) || !authz.canAt("campaign:publish", at.path)) {
    return {
      ok: false,
      message: "Sending automatically needs somebody who can approve and publish posts here.",
    };
  }
  if (at.mode !== "AUTO" && formData.get("autoConfirmed") !== "1") {
    return { ok: false, message: "Tick the box to confirm posts may go out without approval." };
  }
  return null;
}

/**
 * A plan with an ad in it spends the developer's money, so saving one is a
 * budget decision: it takes the budget key and the publish key at the
 * schedule's node, an ad account for each place the ads run (Meta, Google
 * Demand Gen, or both), and a daily budget each account's own limit allows.
 * A Meta ad's goal is asked of what the project has (a Page, a privacy link
 * for a lead form, a WhatsApp number for chats). The ad accounts are added
 * as destinations here, never taken from the form. A plan with no ad drops
 * them.
 */
async function withAds(
  orgId: string,
  input: ScheduleInput,
  authz: Authz,
  path: string,
  formData: FormData,
): Promise<{ ok: true; input: ScheduleInput } | { ok: false; message: string }> {
  const organic = (input.destinations ?? []).filter((d) => !isAd(d as Destination));
  const inUse = outletsInUse({
    repeat: input.repeat === "DATES" ? "DATES" : "WEEKLY",
    dayKinds: input.dayKinds ?? [],
    dayOutlets: outletsFrom(input.dayOutlets ?? []),
    dated: pickDated(input.dated),
  });
  if (!inUse.some(usesAd)) {
    return { ok: true, input: { ...input, destinations: input.destinations ? organic : undefined } };
  }
  if (!authz.canAt("campaign.budget:manage", path) || !authz.canAt("campaign:publish", path)) {
    return { ok: false, message: "Ads need somebody who can set ad budgets and publish here." };
  }
  // Where the ads run. A form that does not offer the choice means Meta, as
  // every schedule did before Google ran ads from one.
  const asked = formData.get("adPlacesShown")
    ? formData.getAll("adPlace").map(String).filter((d): d is Destination => SCHEDULE_AD_DESTINATIONS.includes(d as Destination))
    : (["META_AD"] as Destination[]);
  if (!asked.length) return { ok: false, message: "Choose where the ads run." };
  if (!input.adDailyBudget) return { ok: false, message: "Set a daily budget for the ads." };
  const resolved = await destinationsFor(orgId, path);
  let rupees = input.adDailyBudget;
  for (const d of asked) {
    const r = resolved.get(d);
    if (!r || !r.ok) return { ok: false, message: r && !r.ok ? r.reason : `${destinationDef(d).label}s need an ad account connected for this project.` };
    const budget = budgetCheck({
      raw: String(input.adDailyBudget),
      cap: r.to.account.dailyCap,
      currency: typeof r.to.account.detail.currency === "string" ? r.to.account.detail.currency : null,
    });
    if (!budget.ok) return { ok: false, message: `${destinationDef(d).label}: ${budget.reason}` };
    rupees = budget.rupees;
  }
  let adGoal = input.adGoal ?? null;
  if (asked.includes("META_AD")) {
    const facts = await metaGoalFactsAt(orgId, path);
    const goal = isAdGoal(adGoal) ? adGoal : defaultGoal(facts);
    const why = goalProblem(goal, facts);
    if (why) return { ok: false, message: why };
    adGoal = goal;
  }
  return {
    ok: true,
    input: { ...input, adDailyBudget: rupees, adGoal, destinations: [...organic, ...asked] },
  };
}

/**
 * A schedule that broadcasts every approved post on WhatsApp decides the
 * spend once, here, so it takes the budget key and the publish key at the
 * schedule's node, a connected WhatsApp number for it, and a limit a post.
 * Taking the broadcast out needs neither key.
 */
async function withBroadcast(
  orgId: string,
  input: ScheduleInput,
  authz: Authz,
  at: { path: string; nodeId: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(input.destinations ?? []).includes(BROADCAST_DESTINATION)) return { ok: true };
  if (!authz.canAt("campaign.budget:manage", at.path) || !authz.canAt("campaign:publish", at.path)) {
    return { ok: false, message: "A WhatsApp broadcast needs somebody who can set budgets and publish here." };
  }
  const sender = await senderFor(orgId, at.nodeId);
  if (!sender.ok) return { ok: false, message: "Connect a WhatsApp number for this project first." };
  return { ok: true };
}

export async function createScheduleAction(
  _previous: PostState,
  formData: FormData,
): Promise<PostState> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  const briefId = String(formData.get("briefId") ?? "");
  const view = await loadBrief(orgId, briefId);
  if (!view || !authz.canAt("campaign:create", view.node.path)) {
    return { ok: false, message: "That campaign is not in this organisation." };
  }
  const path = view.node.path;
  const read = withinPublish(readInput(formData), authz.canAt("campaign:publish", path));
  const refused = autoRefusal(read, formData, authz, { path, mode: null });
  if (refused) return refused;
  const ads = await withAds(orgId, read, authz, path, formData);
  if (!ads.ok) return ads;
  const bc = await withBroadcast(orgId, ads.input, authz, { path, nodeId: view.node.id });
  if (!bc.ok) return bc;

  const result = await createSchedule({
    orgId,
    actorUserId: userId,
    briefId,
    input: ads.input,
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/dashboard/campaigns/brief/${briefId}/schedule`);
  // Off the form once it is saved: a form that stays open, holding what was
  // just saved, makes a second press a second schedule.
  backToBrief(briefId, { created: "1" });
}

export async function saveScheduleAction(
  _previous: PostState,
  formData: FormData,
): Promise<PostState> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  const scheduleId = String(formData.get("scheduleId") ?? "");
  // The schedule's own node, never the brief id the form carried: that is
  // where the keys have to hold.
  const current = await loadSchedule(orgId, scheduleId);
  if (!current || !authz.canAt("campaign:create", current.path)) {
    return { ok: false, message: "That schedule is not in this organisation." };
  }
  const read = withinPublish(readInput(formData), authz.canAt("campaign:publish", current.path));
  // Keeping AUTO on is checked like turning it on, minus the tick. Turning
  // it off is the safe direction and needs only the key that writes it; so
  // is taking the ads out of a plan.
  const refused = autoRefusal(read, formData, authz, { path: current.path, mode: current.mode });
  if (refused) return refused;
  const ads = await withAds(orgId, read, authz, current.path, formData);
  if (!ads.ok) return ads;
  const bc = await withBroadcast(orgId, ads.input, authz, { path: current.path, nodeId: current.nodeId });
  if (!bc.ok) return bc;

  const result = await saveSchedule({
    orgId,
    actorUserId: userId,
    scheduleId,
    input: ads.input,
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/dashboard/campaigns/brief/${current.briefId}/schedule`);
  backToBrief(current.briefId, { saved: "1" });
}

export async function stopScheduleAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("creative:approve");
  const briefId = String(formData.get("briefId") ?? "");

  const result = await stopSchedule({
    orgId,
    actorUserId: userId,
    scheduleId: String(formData.get("scheduleId") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  });
  revalidatePath(`/dashboard/campaigns/brief/${briefId}/schedule`);
  if (!result.ok) backToBrief(briefId, {}, result.message ?? "Could not stop that.");
  backToBrief(briefId, { stopped: "1" });
}

export async function startScheduleAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("creative:approve");
  const briefId = String(formData.get("briefId") ?? "");

  const result = await startSchedule({
    orgId,
    actorUserId: userId,
    scheduleId: String(formData.get("scheduleId") ?? ""),
  });
  revalidatePath(`/dashboard/campaigns/brief/${briefId}/schedule`);
  if (!result.ok) backToBrief(briefId, {}, result.message ?? "Could not start that.");
  backToBrief(briefId, { started: "1" });
}

export async function removeScheduleAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("campaign:create");
  const briefId = String(formData.get("briefId") ?? "");

  const result = await removeSchedule({
    orgId,
    actorUserId: userId,
    scheduleId: String(formData.get("scheduleId") ?? ""),
  });
  revalidatePath(`/dashboard/campaigns/brief/${briefId}/schedule`);
  if (!result.ok) backToBrief(briefId, {}, result.message ?? "Could not remove that.");
  backToBrief(briefId, { removed: "1" });
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

function backToQueue(params: Record<string, string> = {}, error?: string): never {
  const q = [new URLSearchParams(params).toString(), error ? flash("error", error) : ""].filter(Boolean).join("&");
  redirect(`/dashboard/campaigns/queue${q ? `?${q}` : ""}`);
}

/**
 * Deciding a post is `creative:approve` AT the node its schedule advertises,
 * not anywhere: a Tower A approver must not clear Tower C's posts by id.
 */
async function mayDecide(orgId: string, authz: { canAt: (perm: string, path: string) => boolean }, creativeId: string) {
  if (!isNodeId(creativeId)) return false;
  const [row] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
    SELECT n.path::text AS path
    FROM post_creatives c
    JOIN post_runs r ON r.id = c.run_id
    JOIN post_schedules s ON s.id = r.schedule_id
    JOIN scope_nodes n ON n.id = s.scope_node_id
    WHERE c.org_id = ${orgId} AND c.id = ${creativeId}`);
  return !!row && authz.canAt("creative:approve", row.path);
}

export async function approveCreativeAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("creative:approve");
  const creativeId = String(formData.get("creativeId") ?? "");
  if (!(await mayDecide(orgId, authz, creativeId))) backToQueue({}, "You cannot approve posts for this project.");
  const result = await approveCreative({
    orgId,
    actorUserId: userId,
    creativeId,
  });
  revalidatePath("/dashboard/campaigns/queue");
  if (!result.ok) backToQueue({}, result.message);
  backToQueue({ approved: "1" });
}

/**
 * Send a post back. It carries a note somebody typed, so a refusal is
 * returned beside the form rather than redirected, which would clear it.
 */
export async function rejectCreativeAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("creative:approve");
  const creativeId = String(formData.get("creativeId") ?? "");
  if (!(await mayDecide(orgId, authz, creativeId))) return { ok: false, message: "You cannot send back posts for this project." };
  const result = await rejectCreative({
    orgId,
    actorUserId: userId,
    creativeId,
    note: String(formData.get("note") ?? ""),
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath("/dashboard/campaigns/queue");
  backToQueue({ rejected: "1" });
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

/**
 * The whole opt-in list at once.
 *
 * A set of tick boxes posts what it rendered, so the write replaces rather
 * than merges: a partial write would leave the stored set disagreeing with
 * what was on the screen, and the disagreement would only show up as a
 * festival post nobody asked for.
 */
export async function setOccasionsAction(
  _previous: PostState,
  formData: FormData,
): Promise<PostState> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  // The festivals are the whole organisation's, so the key is asked at its root.
  const root = await orgRoot(orgId);
  if (!root || !authz.canAt("campaign:create", root.path)) {
    return { ok: false, message: "Only somebody who makes campaigns for the whole organisation can change this." };
  }
  await setOptIns({
    orgId,
    actorUserId: userId,
    keys: formData.getAll("occasions").map(String),
  });
  revalidatePath("/dashboard/campaigns/occasions");
  return { ok: true, message: "Saved." };
}
