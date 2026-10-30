"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { requireAnyPermission, requirePermission } from "@/lib/guard";
import { hasPlan } from "@/lib/billing";
import { clearNeedsPerson, moveLead, recordEvent, setAutomation } from "@/lib/leads";
import { moveVisit, onMoved, onVisitAction, processEvent, seatCheck, sendLocation } from "@/lib/lead-engine";
import { freeHours, saveCapacity, saveHostHours } from "@/lib/slots";
import { latestNote, type NoteView } from "@/lib/visit-notes";
import { saveLeadRules, type RulesPart } from "@/lib/lead-settings";
import { approveQuote, cancelToken, draftQuote, recordOfflineToken, recordRefundPaid, sendQuote } from "@/lib/quotes";
import { readCharges, readExtras } from "@/lib/quote-rules";
import { disconnectPayments } from "@/lib/payments";
import { istAt } from "@/lib/cadence-rules";
import { placeCall, saveOrgPolicy, policyAt } from "@/lib/calling";
import { resolveScopeNode } from "@/lib/scope-nodes";
import { saveLocation } from "@/lib/visits";
import { recordDnd } from "@/lib/dnd";
import { setAutoBudget } from "@/lib/ad-budget";
import { captureKeyOk } from "@/lib/capture";
import { isUuid, readWebLead } from "@/lib/capture-rules";
import type { MoveInput, StageKey } from "@/lib/lead-rules";

/**
 * Leads, visits and the automation around them.
 *
 * Every action names a permission and, where it touches one lead or one
 * visit, checks that permission at that lead's tower: a Project Sales
 * Manager on Tower C moves Tower C's cards and nobody else's. The browser's
 * copy of a lead has no authority; a move is planned and validated again on
 * the server against the lead as stored.
 */

export type ActionResult = { ok: boolean; message: string; errors?: Record<string, string> };

const STAGES: StageKey[] = ["new", "contacted", "qualified", "visit_scheduled", "visit_done", "negotiation", "booked", "nurture", "lost"];

async function leadPath(orgId: string, leadId: string): Promise<string | null> {
  if (!isUuid(leadId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    return r?.path ?? null;
  });
}

async function visitPath(orgId: string, visitId: string): Promise<string | null> {
  if (!isUuid(visitId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM site_visits v JOIN scope_nodes n ON n.id = v.scope_node_id
      WHERE v.org_id = ${orgId} AND v.id = ${visitId}`;
    return r?.path ?? null;
  });
}

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
/** Rupees as typed ("1,50,000"), or NaN, which the rules refuse. An empty box is NaN too. */
const rupeesTyped = (v: FormDataEntryValue | null) => {
  const t = String(v ?? "").replace(/[,\s]/g, "").replace(/^rs\.?/i, "");
  return /^\d{1,10}$/.test(t) ? Number(t) : NaN;
};

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** A card moved on the board. Saved only if the rules agree on the server. */
export async function moveLeadAction(input: { leadId: string; to: string; move: MoveInput }): Promise<ActionResult> {
  const g = await requirePermission("lead:update");
  const path = await leadPath(g.orgId, input.leadId);
  if (!path || !g.authz.canAt("lead:update", path)) return { ok: false, message: "You cannot move this lead." };
  if (!STAGES.includes(input.to as StageKey)) return { ok: false, message: "That is not a stage." };
  const move: MoveInput = {
    facts: Object.fromEntries(
      Object.entries(input.move?.facts ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v).slice(0, 120)]),
    ),
    reason: typeof input.move?.reason === "string" ? input.move.reason.slice(0, 120) : undefined,
    followUp: typeof input.move?.followUp === "string" ? input.move.followUp.slice(0, 10) : undefined,
    note: typeof input.move?.note === "string" ? input.move.note.slice(0, 1000) : undefined,
    seen: STAGES.includes(input.move?.seen as StageKey) ? (input.move.seen as StageKey) : undefined,
  };
  // A visit booked on the board takes a seat at the gallery; a full hour is
  // refused here, with the ones that are free, before the card moves.
  if (input.to === "visit_scheduled" && move.facts.visitDate && move.facts.visitTime && /^\d{4}-\d{2}-\d{2}$/.test(move.facts.visitDate)) {
    const seat = await seatCheck({ orgId: g.orgId, leadId: input.leadId, atIso: istAt(move.facts.visitDate, move.facts.visitTime) });
    if (!seat.ok) return { ok: false, message: "Some details need fixing.", errors: { visitTime: seat.message } };
  }
  const res = await moveLead({
    orgId: g.orgId,
    userId: g.userId,
    leadId: input.leadId,
    to: input.to as StageKey,
    input: move,
    today: todayIst(),
    throughMandate: g.via ? { firm: g.via.firmName } : undefined,
  });
  if (!res.ok) return { ok: false, message: res.message, errors: res.errors };
  // What the new stage starts (a visit booked, a welcome, a follow-up call)
  // runs after the answer, so the card lands at once.
  after(() =>
    onMoved({ orgId: g.orgId, userId: g.userId, leadId: input.leadId, from: res.from, to: res.to, facts: res.facts, followUpOn: res.followUpOn }),
  );
  revalidatePath("/dashboard/leads");
  revalidatePath(`/dashboard/leads/${input.leadId}`);
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// One lead
// ---------------------------------------------------------------------------

export async function callLeadNowAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("lead:call");
  const leadId = String(form.get("leadId") ?? "");
  const path = await leadPath(g.orgId, leadId);
  if (!path || !g.authz.canAt("lead:call", path)) return { ok: false, message: "You cannot call this lead." };
  // A goal is the person's own words, checked by `placeCall` before anything is dialled.
  const withGoal = form.has("goal");
  const goal = String(form.get("goal") ?? "").trim();
  if (withGoal && !goal) return { ok: false, message: "Say what the call should do." };
  // The tower the call is about: the lead's own unless another was chosen,
  // and then only one this person may call about.
  const about = String(form.get("about") ?? "").trim() || null;
  if (about) {
    const tower = await resolveScopeNode(g.orgId, about);
    if (!tower || tower.kind !== "PHASE" || !g.authz.canAt("lead:call", tower.path)) {
      return { ok: false, message: "You cannot call about that tower." };
    }
  }
  const r = await placeCall({ orgId: g.orgId, userId: g.userId, leadId, goal: withGoal ? { key: "custom", text: goal } : null, nodeId: about });
  revalidatePath(`/dashboard/leads/${leadId}`);
  revalidatePath("/dashboard/leads/calls");
  return r.ok ? { ok: true, message: `Calling ${r.leadName} now${withGoal ? ", with your goal" : ""}.` } : { ok: false, message: r.message };
}

export async function sendLocationAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("lead:update");
  const leadId = String(form.get("leadId") ?? "");
  const path = await leadPath(g.orgId, leadId);
  if (!path || !g.authz.canAt("lead:update", path)) return { ok: false, message: "You cannot message this lead." };
  const r = await sendLocation({ orgId: g.orgId, userId: g.userId, leadId });
  revalidatePath(`/dashboard/leads/${leadId}`);
  return r;
}

export async function setLeadAutomationAction(form: FormData): Promise<void> {
  const g = await requirePermission("lead:update");
  const leadId = String(form.get("leadId") ?? "");
  const path = await leadPath(g.orgId, leadId);
  if (!path || !g.authz.canAt("lead:update", path)) return;
  await setAutomation({ orgId: g.orgId, userId: g.userId, leadId, on: form.get("on") === "true" });
  revalidatePath(`/dashboard/leads/${leadId}`);
  revalidatePath("/dashboard/leads");
}

/**
 * What a person knows about the number and the DND register: the buyer said
 * so, the operator's portal showed it, or consent was registered there. A
 * new row each time; the newest stands.
 */
export async function recordDndAction(form: FormData): Promise<void> {
  const g = await requirePermission("lead:update");
  const leadId = String(form.get("leadId") ?? "");
  const status = String(form.get("status") ?? "");
  if (status !== "DND" && status !== "CONSENT_REGISTERED" && status !== "CLEAR") return;
  const path = await leadPath(g.orgId, leadId);
  if (!path || !g.authz.canAt("lead:update", path)) return;
  const phone = await withTenant(g.orgId, async (sql) => {
    const [r] = await sql<{ phone: string }[]>`SELECT phone FROM leads WHERE org_id = ${g.orgId} AND id = ${leadId}`;
    return r?.phone ?? null;
  });
  if (!phone) return;
  await recordDnd({ orgId: g.orgId, phone, status, source: "PERSON", leadId, userId: g.userId });
  revalidatePath(`/dashboard/leads/${leadId}`);
}

export async function clearNeedsAction(form: FormData): Promise<void> {
  const g = await requirePermission("lead:update");
  const leadId = String(form.get("leadId") ?? "");
  const path = await leadPath(g.orgId, leadId);
  if (!path || !g.authz.canAt("lead:update", path)) return;
  await clearNeedsPerson({ orgId: g.orgId, userId: g.userId, leadId });
  revalidatePath(`/dashboard/leads/${leadId}`);
  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

const VISIT_KEY: Record<string, string> = {
  CHECK_IN: "visit:confirm",
  VISITED: "visit:outcome",
  NO_SHOW: "visit:outcome",
  CANCEL: "visit:schedule",
};

export async function visitAction(input: {
  visitId: string;
  action: "CHECK_IN" | "VISITED" | "NO_SHOW" | "CANCEL";
  outcome?: { interest: string; objection: string; next: string; note?: string };
  /** The voice note whose draft this confirms, and the unit types it named. */
  noteId?: string;
  unitIds?: string[];
}): Promise<ActionResult> {
  const key = VISIT_KEY[input.action];
  if (!key) return { ok: false, message: "That is not something a visit can do." };
  const g = await requirePermission(key);
  const path = await visitPath(g.orgId, input.visitId);
  if (!path || !g.authz.canAt(key, path)) return { ok: false, message: "You cannot change this visit." };
  const outcome = input.outcome
    ? {
        interest: String(input.outcome.interest).slice(0, 20),
        objection: String(input.outcome.objection).slice(0, 40),
        next: String(input.outcome.next).slice(0, 80),
        note: input.outcome.note ? String(input.outcome.note).slice(0, 1000) : undefined,
      }
    : undefined;
  const r = await onVisitAction({
    orgId: g.orgId,
    userId: g.userId,
    visitId: input.visitId,
    action: input.action,
    outcome,
    noteId: input.noteId && isUuid(input.noteId) ? input.noteId : undefined,
    unitIds: (input.unitIds ?? []).filter((id) => isUuid(id)).slice(0, 6),
  });
  revalidatePath("/dashboard/visits");
  revalidatePath("/dashboard/leads");
  return r;
}

// ---------------------------------------------------------------------------
// Quotes and the token link
// ---------------------------------------------------------------------------

/** The engine drafts a quote for one flat. */
export async function draftQuoteAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("quote:create");
  const leadId = String(form.get("leadId") ?? "");
  if (!isUuid(leadId)) return { ok: false, message: "That lead no longer exists." };
  const extras = readExtras({
    floorRise: String(form.get("floorRise") ?? ""),
    floorRiseBasis: String(form.get("floorRiseBasis") ?? ""),
    plc: String(form.get("plc") ?? ""),
    plcBasis: String(form.get("plcBasis") ?? ""),
  });
  if (!extras.ok) return { ok: false, message: extras.why };
  const charges = readCharges({
    parking: String(form.get("parking") ?? ""),
    club: String(form.get("club") ?? ""),
    maintenance: String(form.get("maintenance") ?? ""),
    legal: String(form.get("legal") ?? ""),
  });
  if (!charges.ok) return { ok: false, message: charges.why };
  const r = await draftQuote({
    orgId: g.orgId,
    userId: g.userId,
    authz: g.authz,
    leadId,
    unitTypeId: String(form.get("unitTypeId") ?? ""),
    unitNo: String(form.get("unitNo") ?? ""),
    extras: extras.specs,
    charges: charges.lines,
    woman: form.get("woman") === "on",
  });
  revalidatePath(`/dashboard/leads/${leadId}`);
  return r.ok ? { ok: true, message: r.message } : r;
}

/** Approve the draft, or block the flat and send the token link: one button, one step each. */
export async function quoteStepAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("quote:approve");
  const quoteId = String(form.get("quoteId") ?? "");
  const leadId = String(form.get("leadId") ?? "");
  const step = String(form.get("step") ?? "");
  if (!isUuid(quoteId)) return { ok: false, message: "That quote no longer exists." };
  const r =
    step === "approve"
      ? await approveQuote({ orgId: g.orgId, userId: g.userId, authz: g.authz, quoteId })
      : step === "send"
        ? await sendQuote({
            orgId: g.orgId,
            userId: g.userId,
            authz: g.authz,
            quoteId,
            // A link for part of the token, when the form asked for one.
            ...(String(form.get("amount") ?? "").trim() ? { amount: rupeesTyped(form.get("amount")) } : {}),
          })
        : step === "offline"
          ? await recordOfflineToken({
              orgId: g.orgId,
              userId: g.userId,
              authz: g.authz,
              quoteId,
              mode: String(form.get("mode") ?? ""),
              reference: String(form.get("reference") ?? "").slice(0, 40),
              amount: rupeesTyped(form.get("amount")),
              paidOn: String(form.get("paidOn") ?? "").slice(0, 10),
              today: todayIst(),
              part: form.get("part") === "on",
            })
          : step === "cancel"
            ? await cancelToken({
                orgId: g.orgId,
                userId: g.userId,
                authz: g.authz,
                quoteId,
                reason: String(form.get("reason") ?? "").slice(0, 120),
                refund: rupeesTyped(form.get("refund")),
                today: todayIst(),
              })
            : step === "refunded"
              ? await recordRefundPaid({ orgId: g.orgId, userId: g.userId, authz: g.authz, quoteId, reference: String(form.get("reference") ?? "").slice(0, 40) })
              : ({ ok: false, message: "Nothing to do." } as const);
  if (isUuid(leadId)) revalidatePath(`/dashboard/leads/${leadId}`);
  if (step === "offline" || step === "cancel") revalidatePath("/dashboard/leads");
  return r.ok ? { ok: true, message: r.message } : r;
}

export async function disconnectPaymentsAction(): Promise<void> {
  const g = await requirePermission("integration:manage");
  await disconnectPayments({ orgId: g.orgId, userId: g.userId });
  revalidatePath("/dashboard/settings/payments");
}

/** The newest voice note on a visit, for the host's screen while it is read. */
export async function visitNoteAction(input: { visitId: string }): Promise<NoteView | null> {
  const g = await requirePermission("visit:read");
  const path = await visitPath(g.orgId, input.visitId);
  if (!path || !g.authz.canAt("visit:read", path)) return null;
  return latestNote(g.orgId, input.visitId);
}

/** A person moves a visit to another time from the visits screen. */
export async function moveVisitAction(input: { visitId: string; date: string; time: string }): Promise<ActionResult> {
  const g = await requirePermission("visit:schedule");
  const path = await visitPath(g.orgId, input.visitId);
  if (!path || !g.authz.canAt("visit:schedule", path)) return { ok: false, message: "You cannot change this visit." };
  const r = await moveVisit({ orgId: g.orgId, userId: g.userId, visitId: input.visitId, date: String(input.date).slice(0, 10), time: String(input.time).slice(0, 5) });
  revalidatePath("/dashboard/visits");
  revalidatePath("/dashboard/leads");
  return r;
}

/** Free seats per hour on one day at a visit's project, for the move picker. */
export async function visitHoursAction(input: { visitId: string; day: string }): Promise<{ hour: number; free: number }[]> {
  const g = await requirePermission("visit:schedule");
  const path = await visitPath(g.orgId, input.visitId);
  if (!path || !g.authz.canAt("visit:schedule", path) || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return [];
  const node = await withTenant(g.orgId, async (sql) => {
    const [r] = await sql<{ scope_node_id: string }[]>`SELECT scope_node_id FROM site_visits WHERE org_id = ${g.orgId} AND id = ${input.visitId}`;
    return r?.scope_node_id ?? null;
  });
  return node ? freeHours(g.orgId, node, input.day) : [];
}

/** Hosts per hour at a project's gallery, weekdays and the weekend. */
export async function saveCapacityAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("visit:manage");
  const projectId = String(form.get("projectId") ?? "");
  if (!isUuid(projectId)) return { ok: false, message: "Choose the project." };
  const path = await withTenant(g.orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${g.orgId} AND id = ${projectId} AND kind = 'PROJECT'`;
    return r?.path ?? null;
  });
  if (!path || !g.authz.canAt("visit:manage", path)) return { ok: false, message: "You cannot change this project's visits." };
  const r = await saveCapacity({
    orgId: g.orgId,
    userId: g.userId,
    projectId,
    weekday: String(form.get("weekday") ?? ""),
    weekend: String(form.get("weekend") ?? ""),
  });
  revalidatePath("/dashboard/visits");
  return r.ok ? { ok: true, message: "Saved." } : { ok: false, message: r.message };
}

/** One host's working hours at a project's gallery, per weekday. */
export async function saveHostHoursAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("visit:manage");
  const projectId = String(form.get("projectId") ?? "");
  const hostId = String(form.get("hostId") ?? "");
  if (!isUuid(projectId)) return { ok: false, message: "Choose the project." };
  if (!isUuid(hostId)) return { ok: false, message: "Choose the host." };
  const path = await withTenant(g.orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${g.orgId} AND id = ${projectId} AND kind = 'PROJECT'`;
    return r?.path ?? null;
  });
  if (!path || !g.authz.canAt("visit:manage", path)) return { ok: false, message: "You cannot change this project's visits." };
  const week: Record<number, { from: string; to: string }> = {};
  for (let d = 0; d < 7; d++) week[d] = { from: String(form.get(`from-${d}`) ?? ""), to: String(form.get(`to-${d}`) ?? "") };
  const r = await saveHostHours({ orgId: g.orgId, userId: g.userId, projectId, hostId, week });
  revalidatePath(`/dashboard/projects/${projectId}`);
  revalidatePath("/dashboard/visits");
  return r.ok ? { ok: true, message: "Saved." } : { ok: false, message: r.message };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const RULE_PARTS: RulesPart[] = ["ownership", "scoring", "places", "nri"];

/** One part of the lead rules, from its card on Settings, Lead rules. */
export async function saveLeadRulesAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("org:manage");
  const part = String(form.get("part") ?? "") as RulesPart;
  if (!RULE_PARTS.includes(part)) return { ok: false, message: "Nothing to save." };
  const weights: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("w_")) weights[k.slice(2)] = String(v);
  const r = await saveLeadRules({
    orgId: g.orgId,
    userId: g.userId,
    part,
    input: {
      lookback: String(form.get("lookback") ?? ""),
      weights,
      hot: String(form.get("hot") ?? ""),
      warm: String(form.get("warm") ?? ""),
      microMarkets: String(form.get("microMarkets") ?? ""),
      competitors: String(form.get("competitors") ?? ""),
      nriDesk: form.getAll("nriDesk").map(String),
    },
  });
  revalidatePath("/dashboard/settings/leads");
  return r.ok ? { ok: true, message: "Saved." } : r;
}

export async function saveSiteLocationAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requireAnyPermission(["project:create", "brand:manage"]);
  const nodeId = String(form.get("nodeId") ?? "");
  if (!isUuid(nodeId)) return { ok: false, message: "Choose the project." };
  const r = await saveLocation({
    orgId: g.orgId,
    userId: g.userId,
    nodeId,
    link: String(form.get("link") ?? ""),
    address: String(form.get("address") ?? ""),
    // The gallery being changed; the first one when the form names none.
    label: String(form.get("label") ?? "") || null,
  });
  revalidatePath("/dashboard/projects", "layout");
  return r.ok ? { ok: true, message: "Saved." } : { ok: false, message: r.message };
}

export async function saveAutomationAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("org:manage");
  const current = await policyAt(g.orgId, null);
  // Once plans are sold the minutes and calls at once are each plan's, and
  // the form does not carry them: what is stored is kept as it was.
  const planned = await hasPlan(g.orgId);
  const rawMinutes = planned ? String(current.minuteAllowance) : String(form.get("minuteAllowance") ?? "").replace(/[,\s]/g, "");
  const rawChannels = planned ? String(current.channelLimit) : String(form.get("channelLimit") ?? "").trim();
  // A blank box is not zero: read as a number it would stop every call.
  if (!rawMinutes) return { ok: false, message: "Enter the AI call minutes, like 1,500." };
  if (!rawChannels) return { ok: false, message: "Enter how many calls may run at once, like 3." };
  const minutes = Number(rawMinutes);
  const channels = Number(rawChannels);
  const r = await saveOrgPolicy({
    orgId: g.orgId,
    userId: g.userId,
    input: {
      ...current,
      autoOutreach: form.get("autoOutreach") === "on" || form.get("autoOutreach") === "true",
      minuteAllowance: minutes,
      channelLimit: channels,
    },
  });
  revalidatePath("/dashboard/settings/calling");
  return r.ok ? { ok: true, message: "Saved." } : r;
}

export async function setAutoBudgetAction(form: FormData): Promise<void> {
  const g = await requirePermission("campaign.budget:manage");
  const accountId = String(form.get("accountId") ?? "");
  if (!isUuid(accountId)) return;
  await setAutoBudget({ orgId: g.orgId, userId: g.userId, accountId, on: form.get("on") === "true" });
  revalidatePath("/dashboard/settings/connections", "layout");
  revalidatePath("/dashboard/campaigns/live");
}

// ---------------------------------------------------------------------------
// The public enquiry page
// ---------------------------------------------------------------------------

/**
 * A buyer filled in our enquiry page. No session: the page's address
 * carries a key bound to the organisation and the tower, checked again here
 * because a form can be posted from anywhere.
 */
export async function submitEnquiryAction(form: FormData): Promise<void> {
  const orgId = String(form.get("o") ?? "");
  const phaseId = String(form.get("phase") ?? "");
  const key = String(form.get("k") ?? "");
  const back = `/enquire/${phaseId}?o=${orgId}&k=${key}`;
  if (!isUuid(orgId) || !isUuid(phaseId) || !captureKeyOk(orgId, phaseId, key)) redirect("/");
  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !["o", "k"].includes(k)) fields[k] = v;
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "est_ref", "gclid", "fbclid"]) {
    const v = form.get(k);
    if (typeof v === "string" && v) fields[k] = v;
  }
  const lead = readWebLead(fields, new Date().toISOString());
  if (!lead?.phone) {
    // Back to the form with the tracking and the name kept, so a buyer who
    // mistyped the number is still tied to the ad that brought them.
    const keep = new URLSearchParams();
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "est_ref", "gclid", "fbclid", "name"]) {
      if (fields[k]) keep.set(k, fields[k].slice(0, 200));
    }
    redirect(`${back}&error=phone${keep.size ? `&${keep.toString()}` : ""}`);
  }
  const ev = await recordEvent({ orgId, source: "WEBSITE", externalId: lead.externalId, payload: { ...fields, phase: phaseId } });
  if (ev.fresh) after(() => processEvent(orgId, ev.id).then(() => undefined));
  redirect(`${back}&done=1`);
}
