import { randomUUID } from "node:crypto";
import { audit, controlDb, withTenant } from "./db/index.ts";
import { closeSilentCalls, placeCall, policyAt, reconcileCalls } from "./calling.ts";
import { roleAgentOn } from "./sarvam.ts";
import { sendMessage } from "./messaging.ts";
import { applyEngineMove, ownersFor, placeFor, recordEvent, upsertCaptured, markEvent } from "./leads.ts";
import { admissionFacts, blockVisit, bookFromHold, bookVisit, setVisitStatus } from "./visits.ts";
import { leadScoring, qualifyCall, scoreOnCapture } from "./qualify.ts";
import { saysAbroad, type FormAnswers } from "./lead-form-rules.ts";
import { isNriNumber } from "./qualification-rules.ts";
import { placeBridge } from "./proxy.ts";
import { checkInByHand } from "./checkin.ts";
import { confirmNote, expireNotes, processDueNotes } from "./visit-notes.ts";
import { emiValues, lenderAsk } from "./visit-followups.ts";
import { askLenderAfterCall, callSaysLoan } from "./loan-rules.ts";
import { lenderAsked, noteLoanInterest } from "./loans.ts";
import { releaseBlocks, sweepQuotes } from "./quotes.ts";
import { holdAlternatives, hoursOf, projectOf, visitHoursAt, visitHoursOf } from "./slots.ts";
import { closedMessage, opensAt } from "./visit-hours-rules.ts";
import { OFFER_COUNT, admit, alternatives, freeSeats, holdPayload, offerLabel } from "./slot-rules.ts";
import { canPublish } from "./publish-gate.ts";
import { leadForClaim, onBooked, onUnbooked, sweepRegistrations } from "./partners.ts";
import { tokenFor } from "./connect.ts";
import { metaFormLeads, metaLead, metaPageForms } from "./meta.ts";
import { portalEvent, pullPortalAccounts } from "./portal-leads.ts";
import { dailyBudgetPass, syncAccountSpend } from "./ad-budget.ts";
import { dailyLearningPass } from "./learning.ts";
import { checkWhatsApp } from "./wa-numbers.ts";
import { sendDueBroadcasts } from "./broadcast.ts";
import { sendOutcomes } from "./attribution-send.ts";
import {
  CALL_PURPOSES,
  FRESH_LEAD_MS,
  MAX_AUTO_CALLS,
  SYSTEM_FAILING,
  URGENT_PURPOSES,
  afterCall,
  afterCapture,
  afterMove,
  agentFor,
  inCallingHours,
  ist,
  istAt,
  kindOf,
  nextMonthly,
  nextOpening,
  noShowSteps,
  offerSteps,
  postVisitSteps,
  objectionSteps,
  runPlace,
  callEndedAt,
  wasCutOff,
  stillRelevant,
  visitSteps,
  type CallPurpose,
  callTemperature,
  type Purpose,
  type Step,
} from "./cadence-rules.ts";
import {
  readGoogleLead,
  readMetaLead,
  readWebLead,
  readWhatsAppLead,
  type CapturedLead,
  type LeadgenPing,
} from "./capture-rules.ts";
import type { Connectivity, Outcome } from "./call-rules.ts";
import type { CallGoal } from "./calling-rules.ts";
import { isPath, type Facts, type PathStage, type StageKey } from "./lead-rules.ts";
import type { MessagePurpose } from "./message-rules.ts";
import { promisedDetails } from "./details-rules.ts";
import { PROMISED_SALES_CALL, promisedSalesCall } from "./handoff-rules.ts";
import { sendDetails } from "./project-details.ts";

/**
 * The lead engine: what happens to a lead after it arrives, without anybody
 * pressing anything.
 *
 * `cadence-rules.ts` decides; this schedules the decisions as `lead_tasks`
 * and runs them when they fall due. It is called from three places:
 *
 * - a capture route, straight after answering the platform, so a lead
 *   entered at 3:14 pm is being called at 3:14 pm;
 * - Sarvam's webhook, when a call ends;
 * - `npm run lead:run`, the worker, which runs whatever is due, retries what
 *   failed, and closes calls Sarvam never reported back on.
 *
 * Every task is claimed under a lease before it runs, and every paid step
 * asks its gates again at the moment it runs, not when it was scheduled.
 */

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Write steps as tasks. The same step scheduled twice lands on one row. */
export async function schedule(orgId: string, leadId: string, steps: Step[], opts: { cancelPending?: boolean; reason?: string } = {}): Promise<number> {
  if (!steps.length && !opts.cancelPending) return 0;
  return withTenant(orgId, async (sql) => {
    if (opts.cancelPending) {
      await sql`
        UPDATE lead_tasks SET state = 'CANCELLED', result = ${opts.reason ?? "Superseded"}, done_at = now()
        WHERE org_id = ${orgId} AND lead_id = ${leadId} AND state = 'DUE'
          AND dedupe_key <> ALL(${steps.map((s) => s.key)})`;
    }
    let n = 0;
    for (const s of steps) {
      const r = await sql`
        INSERT INTO lead_tasks (org_id, lead_id, visit_id, kind, purpose, due_at, dedupe_key, detail)
        VALUES (${orgId}, ${leadId}, ${s.visitId ?? null}, ${kindOf(s.purpose)}, ${s.purpose}, ${new Date(s.dueAt)},
                ${s.key.slice(0, 200)}, ${sql.json((s.detail ?? {}) as never)})
        ON CONFLICT (org_id, dedupe_key) DO NOTHING`;
      n += r.count;
    }
    return n;
  });
}

// ---------------------------------------------------------------------------
// A lead arrived
// ---------------------------------------------------------------------------

export type Ingested = { ok: true; leadId: string; created: boolean } | { ok: false; message: string };

/**
 * Parse a stored capture event and make a lead of it, then start the
 * cadence and run what is due now. Called by the route after it has
 * answered, and by the worker for any event that did not finish.
 */
export async function processEvent(orgId: string, eventId: string, opts: { nowIso?: string; runNow?: boolean } = {}): Promise<Ingested> {
  const now = opts.nowIso ?? new Date().toISOString();
  const ev = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ id: string; source: string; external_id: string; payload: Record<string, unknown>; processed_at: Date | null; received_at: Date }[]>`
      SELECT id, source, external_id, payload, processed_at, received_at FROM lead_events WHERE org_id = ${orgId} AND id = ${eventId}`;
    return r ?? null;
  });
  if (!ev) return { ok: false, message: "No such event." };
  if (ev.processed_at) return { ok: false, message: "Already handled." };

  let captured: CapturedLead | null = null;
  let accountNodeId: string | null = null;
  if (ev.source === "META_FORM") {
    const p = ev.payload as { ping?: LeadgenPing; accountId?: string; lead?: Record<string, unknown> };
    if (!p.ping || !p.accountId) {
      await markEvent(orgId, eventId, null, "JUNK", "The webhook named no lead.");
      return { ok: false, message: "The webhook named no lead." };
    }
    let lead = p.lead;
    if (!lead) {
      const token = await tokenFor(orgId, p.accountId);
      if (!token.ok) {
        await markEvent(orgId, eventId, null, "FAILED", token.message);
        return { ok: false, message: token.message };
      }
      const got = await metaLead(token.token, p.ping.leadgenId);
      if (!got.ok) {
        await markEvent(orgId, eventId, null, "FAILED", got.message);
        return { ok: false, message: got.message };
      }
      lead = got.value;
    }
    captured = readMetaLead(p.ping, lead);
    accountNodeId = await withTenant(orgId, async (sql) => {
      const [a] = await sql<{ scope_node_id: string }[]>`
        SELECT scope_node_id FROM connection_accounts WHERE org_id = ${orgId} AND id = ${p.accountId!}`;
      return a?.scope_node_id ?? null;
    });
  } else if (ev.source === "GOOGLE_FORM") {
    captured = readGoogleLead(ev.payload);
  } else if (ev.source === "WHATSAPP") {
    captured = readWhatsAppLead(ev.payload);
  } else if (ev.source === "PORTAL") {
    // The tower is the one a person matched to the portal's wording; with
    // none matched the event waits, and nothing is placed on a guess.
    const p = await portalEvent(orgId, eventId, ev.payload);
    if (!p.ok) return { ok: false, message: p.message };
    captured = p.lead;
  } else {
    captured = readWebLead(ev.payload as Record<string, unknown>, ev.received_at.toISOString());
  }
  if (!captured) {
    await markEvent(orgId, eventId, null, "JUNK", "Nothing in it a person could contact.");
    return { ok: false, message: "Nothing in it a person could contact." };
  }
  if (captured.isTest) {
    await markEvent(orgId, eventId, null, "JUNK", "A test submission.");
    return { ok: false, message: "A test submission." };
  }

  const place = await placeFor({ orgId, lineage: captured.lineage, phaseId: captured.phaseId, accountNodeId });
  const up = await upsertCaptured({ orgId, eventId, lead: captured, phaseId: place.phaseId, publishTargetId: place.publishTargetId, nowIso: now });
  if (!up.ok) return { ok: false, message: up.message };
  // A buyer who already booked here (R1) is somebody the sales team knows
  // by name: a person is told, and nothing automatic goes to them.
  if (up.rule !== "R1") await onCaptured(orgId, up.leadId, { merged: up.merged, nowIso: now, runNow: opts.runNow ?? true });
  return { ok: true, leadId: up.leadId, created: up.created };
}

/** How often each Page's forms are read for leads a webhook missed. */
const FORM_SWEEP_MS = 30 * 60_000;
/** How far back the first read of a Page goes; later reads a week. Meta keeps 90 days. */
const FORM_SWEEP_FIRST_DAYS = 30;
const FORM_SWEEP_AGAIN_DAYS = 7;

/**
 * Leads on a connected Page's instant forms that never arrived by webhook:
 * a webhook not yet subscribed, a delivery Meta dropped, a form made in Ads
 * Manager. Each is stored as the webhook would have stored it (one row per
 * leadgen id, so one already here is left alone) and goes through the same
 * capture. Returns the new events, for the caller to work.
 */
export async function sweepMetaForms(orgId: string, now = new Date()): Promise<{ pages: number; eventIds: string[]; failed: number }> {
  const pages = await withTenant(orgId, (sql) => sql<{ id: string; external_id: string; swept_at: Date | null }[]>`
    SELECT a.id, a.external_id, w.swept_at
    FROM connection_accounts a JOIN connections c ON c.id = a.connection_id
    LEFT JOIN meta_form_sweeps w ON w.account_id = a.id
    WHERE a.org_id = ${orgId} AND a.kind = 'FACEBOOK_PAGE' AND a.active AND c.status = 'CONNECTED'`);
  const eventIds: string[] = [];
  let read = 0;
  let failed = 0;
  for (const page of pages) {
    if (page.swept_at && now.getTime() - page.swept_at.getTime() < FORM_SWEEP_MS) continue;
    const cred = await tokenFor(orgId, page.id);
    if (!cred.ok) {
      failed += 1;
      continue;
    }
    const forms = await metaPageForms(cred.token, page.external_id);
    if (!forms.ok) {
      failed += 1;
      continue;
    }
    const back = page.swept_at ? FORM_SWEEP_AGAIN_DAYS : FORM_SWEEP_FIRST_DAYS;
    const since = Math.floor((now.getTime() - back * 86_400_000) / 1000);
    for (const form of forms.value) {
      const leads = await metaFormLeads(cred.token, form.id, since);
      if (!leads.ok) {
        failed += 1;
        continue;
      }
      for (const lead of leads.value) {
        const id = typeof lead.id === "string" ? lead.id : null;
        if (!id) continue;
        const created = typeof lead.created_time === "string" ? Date.parse(lead.created_time) : NaN;
        const ping: LeadgenPing = {
          leadgenId: id,
          pageId: page.external_id,
          formId: form.id,
          adId: typeof lead.ad_id === "string" ? lead.ad_id : null,
          adgroupId: typeof lead.adset_id === "string" ? lead.adset_id : null,
          createdTime: Number.isFinite(created) ? Math.floor(created / 1000) : null,
        };
        const ev = await recordEvent({ orgId, source: "META_FORM", externalId: id, payload: { ping, accountId: page.id, lead, swept: true } });
        if (ev.fresh) eventIds.push(ev.id);
      }
    }
    read += 1;
    await withTenant(orgId, (sql) => sql`
      INSERT INTO meta_form_sweeps (account_id, org_id, swept_at) VALUES (${page.id}, ${orgId}, ${now})
      ON CONFLICT (account_id) DO UPDATE SET swept_at = EXCLUDED.swept_at`);
  }
  if (eventIds.length) {
    await audit({ orgId, actorUserId: null, action: "lead.forms_swept", targetType: "org", targetId: orgId, metadata: { pages: read, found: eventIds.length } });
  }
  return { pages: read, eventIds, failed };
}

/** Start the cadence for a lead that just arrived or enquired again. */
export async function onCaptured(orgId: string, leadId: string, opts: { merged: boolean; nowIso?: string; runNow?: boolean }): Promise<void> {
  const now = opts.nowIso ?? new Date().toISOString();
  const lead = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ scope_node_id: string; phone: string; last_call: Date | null; form_answers: FormAnswers["answers"] | null }[]>`
      SELECT l.scope_node_id, l.phone, l.form_answers,
             (SELECT max(placed_at) FROM calls c WHERE c.lead_id = l.id AND c.placed_by IS NULL) AS last_call
      FROM leads l WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    return r ?? null;
  });
  if (!lead) return;
  const abroad = saysAbroad(lead.form_answers ?? []);
  if (isNriNumber(lead.phone) || abroad) {
    // Our calling hours are India's, and the buyer's may not be: the NRI
    // desk calls them at a time that suits them. With no desk, the person
    // who would own any lead at the tower takes it, so it is never left
    // with nobody (two were, in October 2026).
    const owner = await nriDeskOwner(orgId, lead.scope_node_id);
    const fallback = owner ? null : (await ownersFor(orgId, lead.scope_node_id))[0]?.id ?? null;
    const why = abroad && !isNriNumber(lead.phone)
      ? "Buyer lives outside India. Call at a time that suits them"
      : "Buyer calling from outside India. Call at a time that suits them";
    await withTenant(orgId, (sql) => sql`
      UPDATE leads SET route = 'NRI', owner_id = coalesce(${owner}, owner_id, ${fallback}),
             needs_person = ${why}, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${leadId}`);
    return;
  }
  // What the form said counts toward the score before anybody calls.
  if (lead.form_answers?.length) await scoreOnCapture(orgId, leadId);
  const policy = await policyAt(orgId, lead.scope_node_id);
  const steps = afterCapture({
    leadId,
    nowIso: now,
    autoOutreach: policy.autoOutreach,
    merged: opts.merged,
    lastCallAt: lead.last_call?.toISOString() ?? null,
  });
  await schedule(orgId, leadId, steps);
  if (opts.runNow !== false) await runLeadTasks({ orgId, leadId, nowIso: now, max: 3 });
}

// ---------------------------------------------------------------------------
// A call ended
// ---------------------------------------------------------------------------

/** A stored transcript's turns, in order, as role and words. */
function turnsOf(transcript: unknown): { role: string; text: string }[] {
  if (!Array.isArray(transcript)) return [];
  return transcript.map((t) => {
    const r = (t && typeof t === "object" ? t : {}) as { role?: unknown; en?: unknown; indic?: unknown };
    return { role: String(r.role ?? ""), text: [r.en, r.indic].filter((x): x is string => typeof x === "string").join(" ") };
  });
}

/** The lines of a stored transcript, newest first, for reading a call-back time. */
function linesSaid(transcript: unknown): string[] {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .map((t) => (t && typeof t === "object" ? (t as { en?: unknown; indic?: unknown }) : {}))
    .map((t) => [t.en, t.indic].filter((x): x is string => typeof x === "string" && !!x.trim()).join(" "))
    .filter(Boolean)
    .reverse();
}

/**
 * What the agent heard decides the rest. Idempotent: Sarvam may deliver the
 * same result twice, and the dedupe keys, the visit's call id and the
 * forward-only move make the second delivery change nothing.
 */
export async function onCallEnded(orgId: string, callId: string, opts: { nowIso?: string; runNow?: boolean } = {}): Promise<void> {
  const now = opts.nowIso ?? new Date().toISOString();
  const row = await withTenant(orgId, async (sql) => {
    const [c] = await sql<
      {
        lead_id: string; status: string; connectivity: Connectivity | null; outcome: Outcome | null; attempt: number;
        agent: string; final_variables: Record<string, unknown> | null; purpose: string | null;
        stage: StageKey; path_stage: PathStage; facts: Facts; scope_node_id: string; automation: string;
        auto_calls: number; missed_sent: boolean; superseded: boolean; system_failure: boolean; system_failures_today: number; hung_up_by: string | null;
        visit_id: string | null; visit_at: Date | null; sent: Record<string, unknown> | null;
        task_detail: Record<string, unknown> | null;
        placed_at: Date; duration_s: string | null; interaction_id: string | null; transcript: unknown;
      }[]
    >`
      SELECT c.lead_id, c.status, c.connectivity, c.outcome, c.attempt, c.agent, c.final_variables, t.purpose,
             c.placed_at, c.duration_s, c.interaction_id, c.transcript,
             l.stage, l.path_stage, l.facts, l.scope_node_id, l.automation,
             t.visit_id, v.scheduled_at AS visit_at, c.variables AS sent, t.detail AS task_detail,
             EXISTS (SELECT 1 FROM calls x WHERE x.lead_id = c.lead_id AND x.placed_at > c.placed_at AND x.status <> 'REFUSED') AS superseded,
             (SELECT count(*)::int FROM calls x WHERE x.lead_id = c.lead_id AND x.placed_by IS NULL AND x.direction = 'OUT' AND x.status <> 'REFUSED'
                AND NOT x.system_failure) AS auto_calls,
             EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = c.lead_id AND m.purpose = 'MISSED_CALL' AND m.status <> 'REFUSED') AS missed_sent,
             c.system_failure, c.hung_up_by,
             -- Calls that failed on our side today (IST), up to this one: a retry's own count.
             (SELECT count(*)::int FROM calls x WHERE x.lead_id = c.lead_id AND x.system_failure AND x.placed_at <= c.placed_at
                AND (x.placed_at AT TIME ZONE 'Asia/Kolkata')::date = (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date) AS system_failures_today
      FROM calls c JOIN leads l ON l.id = c.lead_id
      LEFT JOIN lead_tasks t ON t.id = c.task_id
      LEFT JOIN site_visits v ON v.id = t.visit_id
      WHERE c.org_id = ${orgId} AND c.id = ${callId}`;
    return c ?? null;
  });
  if (!row || row.status !== "DONE") return;

  const owners = await ownersFor(orgId, row.scope_node_id);
  // A call a person sent with a goal is one call, not the first of a run: if
  // nobody answers, the engine does not redial it as a qualifying call.
  const purpose: CallPurpose = (CALL_PURPOSES as string[]).includes(row.purpose ?? "")
    ? (row.purpose as CallPurpose)
    : row.agent === "goal" || row.agent === "receptionist"
      ? "CALLBACK"
      : row.agent === "reminder"
        ? "CONFIRM_CALL"
        : row.agent === "recovery"
          ? "RECOVERY_CALL"
          : row.agent === "reengage"
            ? "REENGAGE_CALL"
            : row.agent === "post_visit"
              ? "POST_VISIT_CALL"
              : row.attempt > 1
                ? "RETRY_CALL"
                : "FIRST_CALL";
  // What a job's own agent is handed says it ran on that agent; a no-show
  // call placed on the qualifier carries none of it.
  const sent = row.sent ?? {};
  const onOwnAgent = ["call_reason", "visit_date", "followup_reason"].some((k) => typeof sent[k] === "string");
  // A qualifying call a buyer spoke on is read for the nine fields, the
  // score and the route (`qualify.ts`). A call that closed the lead, or one
  // a later call overtook, is not worth the read.
  const closing = ["OPTED_OUT", "NOT_INTERESTED", "WRONG_NUMBER", "BROKER"].includes(row.outcome ?? "");
  // A bad line said nothing worth reading, and its score would judge the lead off it.
  const reads = row.connectivity === "connected" && !closing && row.outcome !== "BAD_LINE" && !row.superseded && ["qualifier", "reengage", "goal", "receptionist"].includes(row.agent);
  const reading = reads ? await qualifyCall(orgId, callId, { nowIso: now }).catch((e) => {
    console.warn("qualify: the call could not be read,", (e as Error).message);
    return null;
  }) : null;
  const factsBefore: Facts = { ...(row.facts ?? {}) };
  for (const [k, v] of Object.entries(reading?.facts ?? {}) as [keyof Facts, string][]) if (v && !factsBefore[k]) factsBefore[k] = v;
  const d = afterCall({
    leadId: row.lead_id,
    callId,
    nowIso: now,
    purpose,
    attempt: row.attempt,
    place: runPlace(row.attempt, row.task_detail),
    autoCalls: row.auto_calls,
    connectivity: row.connectivity ?? "failed",
    outcome: row.outcome ?? "FAILED",
    vars: row.final_variables,
    stage: row.stage,
    pathStage: row.path_stage,
    facts: factsBefore,
    owners: owners.map((o) => o.name),
    // A buyer who rang us and hung up is not sent "we tried to call you".
    missedMessageSent: row.missed_sent || row.agent === "receptionist",
    route: reading?.route ?? null,
    learnt: reading ? reading.learnt : undefined,
    marketingConsent: reading ? await marketingConsent(orgId, row.lead_id) : false,
    visitId: row.visit_id,
    visitAt: row.visit_at?.toISOString() ?? null,
    onOwnAgent,
    visitHours: await withTenant(orgId, (sql) => visitHoursAt(sql, orgId, row.scope_node_id)),
    endedIso: callEndedAt({
      placedIso: row.placed_at.toISOString(),
      durationS: row.duration_s === null ? null : Number(row.duration_s),
      interactionId: row.interaction_id,
      nowIso: now,
    }),
    said: linesSaid(row.transcript),
    promisedDetails: row.connectivity === "connected" && !closing && promisedDetails(turnsOf(row.transcript)),
    // A buyer who hung up after hearing us out is not a dropped line: rung
    // again two hours later as "carrying on", Roshan and Abhijit got the same
    // pitch twice (28 October 2026). The carrier says who ended it.
    dropped: row.connectivity === "connected" && row.hung_up_by !== "BUYER"
      && wasCutOff(turnsOf(row.transcript), row.outcome, row.agent === "receptionist"),
    afterDrop: row.task_detail?.dropped === true,
    systemFailure: row.system_failure,
    systemFailuresToday: row.system_failures_today,
  });

  // A call placed with nobody to hand off to told the buyer the sales manager
  // would call back: somebody has to, so the lead says so.
  if (!d.needsPerson && sent.sales_ready === "no" && row.connectivity === "connected" && !closing
      && promisedSalesCall(turnsOf(row.transcript))) d.needsPerson = PROMISED_SALES_CALL;

  // The verdict the engine acted on is the call's own, for the call log.
  if (d.temperature) {
    await withTenant(orgId, (sql) => sql`
      UPDATE calls SET temperature = ${d.temperature} WHERE org_id = ${orgId} AND id = ${callId}`);
  }

  // A result that arrives after a later call was placed (a webhook that came
  // late, or calls settled together hours afterwards) still records what the
  // buyer said, but it no longer decides what happens next: the later call
  // does. Without this, calls settled in a batch walked the lead through
  // Nurture and scheduled retries for a call already overtaken.
  if (row.superseded && d.move && !isPath(d.move.to)) d.move = null;
  // A visit the buyer called off on the call. Its reminders and recovery steps
  // are skipped when they come due, because each asks whether it is still on.
  if (d.endVisit && !row.superseded) {
    await setVisitStatus({
      orgId,
      visitId: d.endVisit.visitId,
      to: d.endVisit.as,
      from: d.endVisit.as === "CANCELLED" ? ["CONFIRMED"] : ["NO_SHOW"],
    });
  }
  // A buyer calling from outside India is the NRI desk's.
  const nriOwner = reading?.route === "NRI" ? await nriDeskOwner(orgId, row.scope_node_id) : null;
  const ownerId = nriOwner ?? (d.move?.facts.owner ? owners.find((o) => o.name === d.move!.facts.owner)?.id ?? null : null);
  if (d.move) {
    await applyEngineMove({
      orgId,
      leadId: row.lead_id,
      move: d.move,
      temperature: d.temperature,
      needsPerson: d.needsPerson ?? undefined,
      ownerId,
    });
  } else if (d.needsPerson || d.temperature) {
    await withTenant(orgId, (sql) => sql`
      UPDATE leads SET needs_person = coalesce(${d.needsPerson}, needs_person),
             temperature = coalesce(${d.temperature}, temperature), last_activity_at = now(), updated_at = now()
      WHERE org_id = ${orgId} AND id = ${row.lead_id}`);
  }

  // A buyer who said they will take a home loan has one to follow: the loan
  // executive sees it on the lead from now on.
  const needsLoan = !row.superseded && callSaysLoan(reading?.qualification);
  if (needsLoan) {
    await noteLoanInterest({ orgId, leadId: row.lead_id, source: "CALL" }).catch((e) =>
      console.warn("loans: interest not recorded,", (e as Error).message));
  }

  // Automation paused means a person has the lead: record what the call
  // learned, schedule nothing.
  if (row.automation !== "ON") return;

  const steps = row.superseded ? [] : [...d.steps];
  // A hot or warm buyer who needs a loan is asked on WhatsApp whether one of
  // the developer's lenders may call, half an hour after the call. Their
  // number goes to a lender only on a yes.
  if (needsLoan && askLenderAfterCall({
    q: reading?.qualification,
    route: reading?.route,
    stage: d.move?.to ?? row.stage,
    asked: await lenderAsked(orgId, row.lead_id),
  })) {
    steps.push({ purpose: "LENDER_ASK", dueAt: new Date(Date.parse(now) + 30 * 60_000).toISOString(), key: `${row.lead_id}:LENDER_ASK` });
  }
  if (d.visit) {
    const booked = await bookVisit({
      orgId,
      leadId: row.lead_id,
      atIso: d.visit.at,
      via: "AI_CALL",
      askedFor: d.visit.askedFor,
      callId,
      fallbackHostId: ownerId,
      ifFull: "OFFER",
      nowIso: now,
    });
    if (booked?.kind === "CONFIRMED") {
      steps.push(...visitSteps({ leadId: row.lead_id, visitId: booked.visitId, atIso: d.visit.at, nowIso: now, confirmCall: roleAgentOn("confirmer") }));
    } else if (booked?.kind === "REQUESTED") {
      steps.push(...offerSteps({ leadId: row.lead_id, visitId: booked.visitId, nowIso: now }));
    }
  }
  await schedule(orgId, row.lead_id, steps, { cancelPending: row.superseded ? false : d.cancelPending, reason: "Closed by the call" });
  // The latest call wins: a buyer reached on the phone has said what they
  // want now, so a call back an earlier call asked for is called off (one
  // this call asked for is the one that stands).
  if (row.connectivity === "connected" && !row.superseded) {
    const keep = steps.filter((s) => s.purpose === "CALLBACK").map((s) => s.key.slice(0, 200));
    await withTenant(orgId, (sql) => sql`
      UPDATE lead_tasks SET state = 'CANCELLED', result = 'Replaced by a later call', done_at = now()
      WHERE org_id = ${orgId} AND lead_id = ${row.lead_id} AND state = 'DUE' AND purpose = 'CALLBACK'
        AND dedupe_key <> ALL(${keep})`);
  }
  if (opts.runNow !== false) await runLeadTasks({ orgId, leadId: row.lead_id, nowIso: now, max: 3 });
}

// ---------------------------------------------------------------------------
// A person moved the card, or recorded a visit
// ---------------------------------------------------------------------------

/**
 * Keep the visits and the cadence in step with a move on the board. A move
 * to Visit scheduled books the visit it names; a move to Visit done records
 * it as made; a move back off either cancels it. Then whatever the new stage
 * starts (a booking welcome, a nurture call on the follow-up date) is
 * scheduled.
 */
export async function onMoved(opts: {
  orgId: string;
  userId: string;
  leadId: string;
  from: StageKey;
  to: StageKey;
  facts: Facts;
  followUpOn: string | null;
  nowIso?: string;
}): Promise<void> {
  const { orgId, leadId } = opts;
  const now = opts.nowIso ?? new Date().toISOString();
  const steps: Step[] = [];
  const open = await withTenant(orgId, (sql) => sql<{ id: string; status: string; scheduled_at: Date }[]>`
    SELECT id, status, scheduled_at FROM site_visits
    WHERE org_id = ${orgId} AND lead_id = ${leadId} AND status IN ('CONFIRMED', 'ON_SITE')
    ORDER BY scheduled_at DESC`);

  if (opts.to === "visit_scheduled" && opts.facts.visitDate && opts.facts.visitTime) {
    const at = istAt(opts.facts.visitDate, opts.facts.visitTime);
    const same = open.find((v) => v.status === "CONFIRMED" && v.scheduled_at.toISOString() === at);
    if (!same && Date.parse(at) > Date.parse(now)) {
      const hostId = opts.facts.visitHost
        ? (await ownersFor(orgId, null)).find((p) => p.name === opts.facts.visitHost)?.id ?? null
        : null;
      const booked = await bookVisit({ orgId, leadId, atIso: at, via: "CONSOLE", hostId, userId: opts.userId, ifFull: "OFFER", nowIso: now });
      if (booked?.kind === "CONFIRMED") {
        steps.push(...visitSteps({ leadId, visitId: booked.visitId, atIso: at, nowIso: now, confirmCall: roleAgentOn("confirmer") }));
      } else if (booked?.kind === "REQUESTED") {
        steps.push(...offerSteps({ leadId, visitId: booked.visitId, nowIso: now }));
      }
    }
  } else if (opts.to === "visit_done" && open.length) {
    const v = open[0];
    const made = await setVisitStatus({
      orgId,
      visitId: v.id,
      to: "VISITED",
      from: ["CONFIRMED", "ON_SITE"],
      outcome: { interest: opts.facts.interest ?? "Warm", objection: opts.facts.objection ?? "None", next: "Nothing planned" },
      userId: opts.userId,
    });
    if (made) steps.push(...postVisitSteps({ leadId, visitId: v.id, nowIso: now, followUpCall: roleAgentOn("post_visit"), followUps: roleAgentOn("reengager") }));
  }
  const backOff =
    (opts.from === "visit_scheduled" || opts.from === "visit_done") &&
    ["new", "contacted", "qualified", "nurture", "lost"].includes(opts.to);
  if (backOff) {
    for (const v of open) await setVisitStatus({ orgId, visitId: v.id, to: "CANCELLED", from: ["CONFIRMED", "ON_SITE"], userId: opts.userId });
  }

  // A partner's buyer booking writes what the partner is owed; undoing the
  // booking cancels it.
  if (opts.to === "booked") await onBooked({ orgId, userId: opts.userId, leadId, nowIso: now });
  else if (opts.from === "booked") {
    await onUnbooked({ orgId, userId: opts.userId, leadId });
    await releaseBlocks(orgId, leadId, "The booking was cancelled");
  }

  const after = afterMove({ leadId, to: opts.to, from: opts.from, followUpOn: opts.followUpOn, nowIso: now });
  steps.push(...after.steps);
  await schedule(orgId, leadId, steps, { cancelPending: after.cancelPending, reason: "The lead moved" });
  await runLeadTasks({ orgId, leadId, nowIso: now, max: 3 });
}

/**
 * The relationship manager books a partner's buyer onto the site. The claim
 * names a project and the visit a tower, so the lead the claim is worked
 * through is made here if nothing has enquired yet; then the visit is booked
 * the way the board books one, confirmation and reminders included.
 */
export async function bookPartnerVisit(opts: {
  orgId: string;
  userId: string;
  registrationId: string;
  phaseId: string;
  date: string;
  time: string;
  nowIso?: string;
}): Promise<{ ok: boolean; message: string; leadId?: string }> {
  const now = opts.nowIso ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date) || !/^\d{2}:\d{2}$/.test(opts.time)) {
    return { ok: false, message: "Choose a day and a half-hour slot." };
  }
  const openHours = await withTenant(opts.orgId, (sql) => visitHoursAt(sql, opts.orgId, opts.phaseId));
  if (!opensAt(openHours, opts.date, opts.time)) return { ok: false, message: closedMessage(openHours, opts.date) };
  const at = istAt(opts.date, opts.time);
  if (Date.parse(at) <= Date.parse(now)) return { ok: false, message: "That time has passed." };
  const lead = await leadForClaim({ orgId: opts.orgId, userId: opts.userId, registrationId: opts.registrationId, phaseId: opts.phaseId });
  if (!lead.ok) return lead;
  const booked = await bookVisit({ orgId: opts.orgId, leadId: lead.leadId, atIso: at, via: "CONSOLE", userId: opts.userId, ifFull: "REFUSE", nowIso: now });
  if (!booked) return { ok: false, message: "That lead no longer exists." };
  if (booked.kind !== "CONFIRMED") {
    return { ok: false, message: fullMessage(booked.kind === "FULL" ? booked.alternatives : []) };
  }
  await applyEngineMove({
    orgId: opts.orgId,
    leadId: lead.leadId,
    move: { to: "visit_scheduled", facts: { visitDate: opts.date, visitTime: opts.time }, why: "Visit booked for a partner's buyer" },
  });
  await schedule(opts.orgId, lead.leadId, visitSteps({ leadId: lead.leadId, visitId: booked.visitId, atIso: at, nowIso: now, confirmCall: roleAgentOn("confirmer") }));
  await runLeadTasks({ orgId: opts.orgId, leadId: lead.leadId, nowIso: now, max: 3 });
  return { ok: true, message: "Visit booked. The buyer gets the confirmation and directions.", leadId: lead.leadId };
}

/**
 * A visit a person typed in the developer's CRM, booked the way the board
 * books one: a seat in the project's ledger in the same transaction, then
 * the confirmation and reminders, or three other hours when that one is
 * full. Like every task, they run only while the lead's agent is on.
 */
export async function bookCrmVisit(o: { orgId: string; leadId: string; atIso: string; nowIso?: string }): Promise<{ visitId: string; kind: "CONFIRMED" | "REQUESTED" } | null> {
  const now = o.nowIso ?? new Date().toISOString();
  const booked = await bookVisit({ orgId: o.orgId, leadId: o.leadId, atIso: o.atIso, via: "CRM", ifFull: "OFFER", nowIso: now });
  if (!booked || booked.kind === "FULL") return null;
  const steps =
    booked.kind === "CONFIRMED"
      ? visitSteps({ leadId: o.leadId, visitId: booked.visitId, atIso: o.atIso, nowIso: now, confirmCall: roleAgentOn("confirmer") })
      : offerSteps({ leadId: o.leadId, visitId: booked.visitId, nowIso: now });
  await schedule(o.orgId, o.leadId, steps);
  await runLeadTasks({ orgId: o.orgId, leadId: o.leadId, nowIso: now, max: 3 });
  return { visitId: booked.visitId, kind: booked.kind };
}

/** The site team recorded something about a visit. */
export async function onVisitAction(opts: {
  orgId: string;
  userId: string;
  visitId: string;
  action: "CHECK_IN" | "VISITED" | "NO_SHOW" | "CANCEL";
  outcome?: { interest: string; objection: string; next: string; note?: string };
  /** The voice note the host confirmed, and the approved unit types it named. */
  noteId?: string;
  unitIds?: string[];
  nowIso?: string;
}): Promise<{ ok: boolean; message: string }> {
  const { orgId, visitId } = opts;
  const now = opts.nowIso ?? new Date().toISOString();
  const v = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ id: string; lead_id: string; status: string; scheduled_at: Date; host: string | null }[]>`
      SELECT v.id, v.lead_id, v.status, v.scheduled_at, coalesce(u.name, u.email::text) AS host
      FROM site_visits v LEFT JOIN users u ON u.id = v.host_id
      WHERE v.org_id = ${orgId} AND v.id = ${visitId}`;
    return r ?? null;
  });
  if (!v) return { ok: false, message: "That visit no longer exists." };

  if (opts.action === "CHECK_IN") {
    // By hand, for a buyer with no pass to show: recorded as such.
    const ok = await checkInByHand({ orgId, userId: opts.userId, visitId });
    return ok ? { ok: true, message: "Checked in." } : { ok: false, message: "This visit cannot be checked in now." };
  }
  if (opts.action === "CANCEL") {
    // Its reminders and recovery steps are skipped when they come due,
    // because each asks whether the visit is still on.
    const ok = await setVisitStatus({ orgId, visitId, to: "CANCELLED", from: ["CONFIRMED", "NO_SHOW", "REQUESTED"], userId: opts.userId });
    if (ok && v.scheduled_at.getTime() > Date.parse(now)) {
      await schedule(orgId, v.lead_id, [{ purpose: "VISIT_CANCELLED", dueAt: now, key: `${visitId}:VISIT_CANCELLED`, visitId }]);
      await runLeadTasks({ orgId, leadId: v.lead_id, nowIso: now, max: 2 });
    }
    return ok ? { ok: true, message: "Visit cancelled. The buyer is told on WhatsApp." } : { ok: false, message: "This visit cannot be cancelled now." };
  }
  if (opts.action === "NO_SHOW") {
    const ok = await setVisitStatus({ orgId, visitId, to: "NO_SHOW", from: ["CONFIRMED"], userId: opts.userId });
    if (ok) {
      await schedule(orgId, v.lead_id, noShowSteps({ leadId: v.lead_id, visitId, atIso: v.scheduled_at.toISOString(), nowIso: now }));
      await runLeadTasks({ orgId, leadId: v.lead_id, nowIso: now, max: 3 });
    }
    return ok ? { ok: true, message: "Marked as a no-show. The recovery messages and call are scheduled." } : { ok: false, message: "Only a confirmed visit can be marked a no-show." };
  }

  const outcome = opts.outcome ?? { interest: "Warm", objection: "None", next: "Nothing planned" };
  const ok = await setVisitStatus({ orgId, visitId, to: "VISITED", from: ["CONFIRMED", "ON_SITE", "NO_SHOW"], outcome, userId: opts.userId });
  if (!ok) return { ok: false, message: "This visit has already been recorded." };
  const at = ist(v.scheduled_at.toISOString());
  const today = ist(now).date;
  await applyEngineMove({
    orgId,
    leadId: v.lead_id,
    move: {
      to: "visit_done",
      facts: {
        visitDate: at.date <= today ? at.date : today,
        visitTime: at.time,
        ...(v.host ? { visitHost: v.host } : {}),
        interest: outcome.interest,
        objection: outcome.objection,
      },
      why: "Visit recorded by the site team",
    },
    temperature: outcome.interest === "Hot" ? "HOT" : outcome.interest === "Cold" ? "COLD" : "WARM",
    needsPerson: outcome.next && outcome.next !== "Nothing planned" ? `After the visit: ${outcome.next.toLowerCase()}` : null,
  });
  if (opts.noteId) await confirmNote({ orgId, userId: opts.userId, visitId, noteId: opts.noteId });
  await schedule(orgId, v.lead_id, [
    ...postVisitSteps({ leadId: v.lead_id, visitId, nowIso: now, followUpCall: roleAgentOn("post_visit"), followUps: roleAgentOn("reengager") }),
    ...objectionSteps({ leadId: v.lead_id, visitId, objection: outcome.objection, unitIds: opts.unitIds ?? [], nowIso: now }),
  ]);
  await runLeadTasks({ orgId, leadId: v.lead_id, nowIso: now, max: 3 });
  return { ok: true, message: "Visit recorded." };
}

// ---------------------------------------------------------------------------
// Running what is due
// ---------------------------------------------------------------------------

type TaskRow = {
  id: string;
  dedupe_key: string;
  lead_id: string;
  visit_id: string | null;
  kind: "CALL" | "MESSAGE" | "CHECK";
  purpose: Purpose;
  due_at: Date;
  attempts: number;
  detail: Record<string, unknown>;
};

/** The most monthly messages one lead gets, per kind. */
export const MAX_MONTHLY = { NURTURE: 6, BOOKED_CHECKIN: 12 } as const;

/** A task that has been claimed this many times and still not finished is a crash loop. */
export const MAX_TASK_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;

async function claim(orgId: string, nowIso: string, max: number, leadId: string | null, purposes: readonly Purpose[] | null = null): Promise<TaskRow[]> {
  const lease = randomUUID();
  return withTenant(orgId, (sql) => sql<TaskRow[]>`
    UPDATE lead_tasks t SET state = 'WORKING', lease_id = ${lease},
           lease_until = ${new Date(Date.now() + LEASE_MS)}, attempts = t.attempts + 1
    WHERE t.id IN (
      SELECT t2.id FROM lead_tasks t2 JOIN leads l ON l.id = t2.lead_id
      WHERE t2.org_id = ${orgId} AND t2.due_at <= ${new Date(nowIso)} AND l.automation = 'ON'
        AND (t2.state = 'DUE' OR (t2.state = 'WORKING' AND t2.lease_until < now()))
        AND ${leadId ? sql`t2.lead_id = ${leadId}` : sql`true`}
        AND ${purposes ? sql`t2.purpose = ANY(${purposes as string[]})` : sql`true`}
      -- claimPriority() in cadence-rules.ts: a fresh lead's first call, then
      -- call backs, visit steps and hot leads, then the rest; oldest due first.
      ORDER BY CASE
                 WHEN t2.purpose IN ('FIRST_CALL', 'ACK') AND l.enquired_at > ${new Date(Date.parse(nowIso) - FRESH_LEAD_MS)} THEN 0
                 WHEN t2.purpose = ANY(${[...URGENT_PURPOSES] as string[]}) THEN 1
                 WHEN t2.kind = 'CALL' AND l.temperature = 'HOT' THEN 1
                 ELSE 2
               END,
               t2.due_at
      LIMIT ${max}
      FOR UPDATE OF t2 SKIP LOCKED)
    RETURNING t.id, t.dedupe_key, t.lead_id, t.visit_id, t.kind, t.purpose, t.due_at, t.attempts, t.detail`);
}

type Finish =
  | { state: "DONE" | "SKIPPED" | "FAILED"; result: string }
  | { state: "DUE"; dueAt: string; result: string; refund: boolean };

async function finish(orgId: string, id: string, f: Finish): Promise<void> {
  await withTenant(orgId, (sql) =>
    f.state === "DUE"
      ? sql`
          UPDATE lead_tasks SET state = 'DUE', due_at = ${new Date(f.dueAt)}, lease_id = NULL, lease_until = NULL,
                 result = ${f.result.slice(0, 300)},
                 attempts = CASE WHEN ${f.refund} THEN greatest(attempts - 1, 0) ELSE attempts END
          WHERE org_id = ${orgId} AND id = ${id}`
      : sql`
          UPDATE lead_tasks SET state = ${f.state}, result = ${f.result.slice(0, 300)}, lease_id = NULL,
                 lease_until = NULL, done_at = now()
          WHERE org_id = ${orgId} AND id = ${id}`,
  );
}

async function flag(orgId: string, leadId: string, why: string): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    UPDATE leads SET needs_person = ${why.slice(0, 200)}, updated_at = now() WHERE org_id = ${orgId} AND id = ${leadId}`);
}

/** The goal a call back's asking call had not finished, if it had one (its id ends the task's key). */
async function unfinishedGoal(orgId: string, key: string): Promise<CallGoal | null> {
  const id = key.split(":").at(-1) ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [c] = await withTenant(orgId, (sql) => sql<{ goal: string | null; goal_text: string | null; status: string | null }[]>`
    SELECT goal, goal_text, final_variables->>'goal_status' AS status FROM calls WHERE org_id = ${orgId} AND id = ${id}`);
  if (!c?.goal || !c.goal_text || (c.status ?? "").trim().toLowerCase() === "done") return null;
  return { key: c.goal as CallGoal["key"], text: c.goal_text };
}

async function runTask(orgId: string, t: TaskRow, nowIso: string): Promise<Finish> {
  if (t.attempts > MAX_TASK_ATTEMPTS) return { state: "FAILED", result: "Tried too many times" };
  const ctx = await withTenant(orgId, async (sql) => {
    const [l] = await sql<{ stage: StageKey; visit_status: string | null; visit_at: Date | null; temperature: string | null; auto_calls: number }[]>`
      SELECT l.stage, v.status AS visit_status, v.scheduled_at AS visit_at, l.temperature,
             (SELECT count(*)::int FROM calls c WHERE c.lead_id = l.id AND c.placed_by IS NULL AND c.status <> 'REFUSED'
                AND NOT c.system_failure) AS auto_calls
      FROM leads l LEFT JOIN site_visits v ON v.id = ${t.visit_id}
      WHERE l.org_id = ${orgId} AND l.id = ${t.lead_id}`;
    return l ?? null;
  });
  if (!ctx) return { state: "SKIPPED", result: "The lead no longer exists" };
  const why = stillRelevant(t.purpose, { stage: ctx.stage, visitStatus: ctx.visit_status });
  if (why) return { state: "SKIPPED", result: why };

  if (t.kind === "CALL") {
    if (!inCallingHours(nowIso)) return { state: "DUE", dueAt: nextOpening(nowIso), result: "Waiting for calling hours", refund: true };
    const purpose = t.purpose as CallPurpose;
    const attempt = typeof t.detail.attempt === "number" ? t.detail.attempt : 1;
    // A call about a visit that is not placed leaves its job to WhatsApp:
    // the day-before confirmation becomes the reminder it replaced, and the
    // post-visit call is left to the follow-up message already due. Nothing
    // here is a reason to ask a person to ring the buyer themselves.
    const byWhatsApp = async (why: string): Promise<Finish> => {
      if (purpose === "CONFIRM_CALL" && attempt < 2 && t.visit_id) {
        await schedule(orgId, t.lead_id, [
          { purpose: "VISIT_REMINDER_DAY", dueAt: nowIso, key: `${t.visit_id}:VISIT_REMINDER_DAY`, visitId: t.visit_id },
        ]);
        return { state: "SKIPPED", result: `${why} The WhatsApp reminder goes instead.` };
      }
      return { state: "SKIPPED", result: why };
    };
    if (purpose === "BRIDGE") {
      const b = await placeBridge({ orgId, leadId: t.lead_id, afterCallId: typeof t.detail.callId === "string" ? t.detail.callId : null, nowIso });
      if (b.ok) return { state: "DONE", result: "A sales person is being rung for the buyer" };
      await flag(orgId, t.lead_id, "Hot lead, promised a call from sales. Call now");
      return { state: "SKIPPED", result: b.message };
    }
    const aboutVisit = purpose === "CONFIRM_CALL" || purpose === "POST_VISIT_CALL" || purpose === "VISIT_FOLLOWUP_CALL";
    if (ctx.auto_calls >= MAX_AUTO_CALLS) {
      const why = `Already called ${MAX_AUTO_CALLS} times`;
      return aboutVisit ? byWhatsApp(why) : { state: "SKIPPED", result: why };
    }
    // A call back carries on what the call that asked for it was doing: a
    // goal it had not finished goes back to the goal agent with the same words.
    const goal = purpose === "CALLBACK" ? await unfinishedGoal(orgId, t.dedupe_key) : null;
    const r = await placeCall({ orgId, userId: null, leadId: t.lead_id, nowIso, agent: agentFor(purpose), taskId: t.id, attempt, visitId: t.visit_id, goal });
    if (r.ok) return { state: "DONE", result: "Called" };
    if (aboutVisit && !["BUSY", "OUTSIDE_HOURS", "REFUSED"].includes(r.code)) return byWhatsApp(r.message);
    switch (r.code) {
      case "OUTSIDE_HOURS":
        return { state: "DUE", dueAt: nextOpening(nowIso), result: r.message, refund: true };
      case "BUSY":
        return { state: "DUE", dueAt: new Date(Date.parse(nowIso) + 3 * 60_000).toISOString(), result: r.message, refund: true };
      case "NOT_SWITCHED_ON":
        if (purpose === "FIRST_CALL") await flag(orgId, t.lead_id, "Call this lead yourself: the AI caller is not switched on");
        return { state: "SKIPPED", result: r.message };
      case "NO_NUMBER":
        if (purpose === "FIRST_CALL") await flag(orgId, t.lead_id, "Call this lead yourself: no calling number is set up for this project");
        return { state: "SKIPPED", result: r.message };
      case "ALLOWANCE":
        await flag(orgId, t.lead_id, "Call this lead yourself: this month's AI call minutes are used up");
        return { state: "SKIPPED", result: r.message };
      case "NO_PLAN":
        if (purpose === "FIRST_CALL") await flag(orgId, t.lead_id, "Call this lead yourself: this project has no plan yet");
        return { state: "SKIPPED", result: r.message };
      case "REFUSED":
        if (t.attempts < 3) {
          return { state: "DUE", dueAt: new Date(Date.parse(nowIso) + 10 * 60_000).toISOString(), result: r.message, refund: false };
        }
        // Refused at the door three times: the lead is not left quietly in
        // New with nobody calling it. A visit's call has its WhatsApp instead.
        if (!aboutVisit) await flag(orgId, t.lead_id, SYSTEM_FAILING);
        return aboutVisit ? byWhatsApp(r.message) : { state: "FAILED", result: r.message };
      default:
        return { state: "SKIPPED", result: r.message };
    }
  }

  if (t.kind === "MESSAGE") {
    const purpose = t.purpose as MessagePurpose;
    const slots =
      purpose === "SLOT_OFFER" || purpose === "VISIT_REOFFER" || purpose === "REVISIT_OFFER" ? await offerSlots(orgId, t, nowIso) : undefined;
    let extra: Parameters<typeof sendMessage>[0]["extra"];
    let buttonPayloads: string[] | undefined;
    if (purpose === "VISIT_EMI") {
      const e = await emiValues(orgId, t.lead_id, Array.isArray(t.detail.units) ? (t.detail.units as string[]) : []);
      if (!e.ok) {
        await flag(orgId, t.lead_id, e.why);
        return { state: "SKIPPED", result: e.why };
      }
      extra = e.values;
    }
    if (purpose === "LENDER_ASK") {
      const a = await lenderAsk(orgId, t.lead_id, t.visit_id);
      if ("none" in a) {
        if (a.none) await flag(orgId, t.lead_id, a.none);
        return { state: "SKIPPED", result: a.none || "Already asked about this lender" };
      }
      extra = { lender: a.lender };
      buttonPayloads = a.payloads;
    }
    // The details the call promised: their own sender, which picks the template
    // or, inside the buyer's 24 hours, the pictures and the details themselves.
    const r = purpose === "PROJECT_DETAILS"
      ? await sendDetails({ orgId, leadId: t.lead_id, nowIso, taskId: t.id })
      : await sendMessage({
      slots,
      extra,
      buttonPayloads,
      orgId,
      leadId: t.lead_id,
      purpose,
      nowIso,
      taskId: t.id,
      visitId: t.visit_id,
      nextStep: typeof t.detail.nextStep === "string" ? t.detail.nextStep : null,
    });
    if (r.ok) {
      if (purpose === "NURTURE" || purpose === "BOOKED_CHECKIN") {
        // A drip that never ends is a marketing bill that never ends: six
        // nudges, then a person decides; a year of check-ins after a booking.
        const [{ n }] = await withTenant(orgId, (sql) => sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM messages
          WHERE org_id = ${orgId} AND lead_id = ${t.lead_id} AND purpose = ${purpose} AND status NOT IN ('REFUSED', 'FAILED')`);
        if (n < MAX_MONTHLY[purpose]) await schedule(orgId, t.lead_id, [nextMonthly(purpose, t.lead_id, nowIso)]);
      }
      return { state: "DONE", result: "Sent" };
    }
    if (r.code === "OUTSIDE_HOURS") return { state: "DUE", dueAt: nextOpening(nowIso), result: r.message, refund: true };
    // Four promotions in thirty days already (broadcasts count too): the
    // nudge waits a week rather than ending the drip.
    if (r.code === "CAP_30D") {
      return { state: "DUE", dueAt: new Date(Date.parse(nowIso) + 7 * 86_400_000).toISOString(), result: r.message, refund: true };
    }
    // The number reached its daily WhatsApp limit: the message waits for
    // the window, and waiting is not an attempt.
    if (r.code === "PACED" && r.retryAt) return { state: "DUE", dueAt: r.retryAt, result: r.message, refund: true };
    // Meta throttled it: tried again with backoff, counted at most once an
    // hour, and given up a day after the first throttle.
    if (r.code === "THROTTLED") {
      return r.retryAt
        ? { state: "DUE", dueAt: r.retryAt, result: r.message, refund: !r.counted }
        : { state: "FAILED", result: r.message };
    }
    if (r.code === "NO_TIMES" && purpose === "SLOT_OFFER") await flag(orgId, t.lead_id, "The hour they asked for was full and no other is free this week. Call them");
    if (r.code === "NO_TIMES" && purpose === "REVISIT_OFFER") await flag(orgId, t.lead_id, "They want to come back with family and no time is free this week. Call them");
    // A follow-up that may not go on WhatsApp (no consent, a stopped tower,
    // no approved template) is handed to a person rather than dropped.
    const instead: Partial<Record<MessagePurpose, string>> = {
      SLOT_OFFER: "The hour they asked for was full. Call them to fix another time",
      VISIT_EMI: "Price held them back. Send the payment plan yourself",
      LENDER_ASK: "Buyer needs a home loan. Ask them yourself before sharing their number",
      REVISIT_OFFER: "They want to come back with family. Call them to fix a visit",
    };
    if (r.code !== "FAILED" && r.code !== "NO_TIMES" && instead[purpose]) {
      await flag(orgId, t.lead_id, instead[purpose]!);
    }
    if (r.code === "FAILED" && t.attempts < 3) {
      return { state: "DUE", dueAt: new Date(Date.parse(nowIso) + 15 * 60_000).toISOString(), result: r.message, refund: false };
    }
    return { state: r.code === "FAILED" ? "FAILED" : "SKIPPED", result: r.message };
  }

  // Checks.
  if (!t.visit_id || !ctx.visit_at) return { state: "SKIPPED", result: "No visit to check" };
  if (t.purpose === "ADMIT_CHECK") {
    const facts = await admissionFacts(orgId, t.visit_id);
    if (!facts || facts.status !== "CONFIRMED") return { state: "SKIPPED", result: "The visit is no longer on" };
    const verdict = admit({
      seated: facts.seated,
      advertisable: (await canPublish(orgId, facts.nodeId)).ok,
      optedOut: facts.optedOut,
      claimDisputed: false,
    });
    if (verdict.ok) return { state: "DONE", result: "May go ahead" };
    await blockVisit({ orgId, visitId: t.visit_id, reason: verdict.reason });
    return { state: "DONE", result: `Stopped: ${verdict.reason}` };
  }
  if (t.purpose === "OFFER_CHECK") {
    if (ctx.visit_status !== "REQUESTED") return { state: "SKIPPED", result: "A time was picked" };
    await flag(orgId, t.lead_id, "No time picked from the three offered. Call to fix the visit");
    return { state: "DONE", result: "Nobody picked a time: a person is asked" };
  }
  if (t.purpose === "NO_SHOW_CHECK") {
    const missed = await setVisitStatus({ orgId, visitId: t.visit_id, to: "NO_SHOW", from: ["CONFIRMED"] });
    if (!missed) return { state: "SKIPPED", result: "The visit was recorded" };
    if (ctx.temperature === "HOT") await flag(orgId, t.lead_id, "Hot buyer missed the visit. Call them yourself");
    await schedule(orgId, t.lead_id, noShowSteps({ leadId: t.lead_id, visitId: t.visit_id, atIso: ctx.visit_at.toISOString(), nowIso }));
    return { state: "DONE", result: "Nobody checked in: recovery started" };
  }
  if (t.purpose === "LAPSE_CHECK") {
    const lapsed = await setVisitStatus({ orgId, visitId: t.visit_id, to: "LAPSED", from: ["NO_SHOW"] });
    if (!lapsed) return { state: "SKIPPED", result: "The visit was recovered" };
    const today = ist(nowIso).date;
    const follow = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    if (ctx.stage === "visit_scheduled") {
      await applyEngineMove({
        orgId,
        leadId: t.lead_id,
        move: { to: "nurture", facts: {}, exitReason: "No-show", followUpOn: follow, why: "Missed the visit and did not rebook" },
      });
      const next = afterMove({ leadId: t.lead_id, to: "nurture", from: "visit_scheduled", followUpOn: follow, nowIso });
      await schedule(orgId, t.lead_id, next.steps);
    }
    return { state: "DONE", result: "Lapsed after 72 hours" };
  }
  return { state: "SKIPPED", result: "Nothing to do" };
}

/**
 * The three times an offer names, each with the payload its button sends
 * back. A slot offer uses the holds made when the visit was asked for, made
 * again if they lapsed before the message went; a re-offer holds three near
 * eleven the next morning.
 */
async function offerSlots(orgId: string, t: TaskRow, nowIso: string): Promise<{ label: string; payload: string }[]> {
  return withTenant(orgId, async (sql) => {
    const [lead] = await sql<{ scope_node_id: string }[]>`SELECT scope_node_id FROM leads WHERE org_id = ${orgId} AND id = ${t.lead_id}`;
    if (!lead) return [];
    const projectId = await projectOf(sql, orgId, lead.scope_node_id);
    if (!projectId) return [];
    let holds: { holdId: string; startsAt: string }[] = [];
    if (t.visit_id) {
      holds = (await sql<{ id: string; starts_at: Date }[]>`
        SELECT id, starts_at FROM visit_holds
        WHERE org_id = ${orgId} AND visit_id = ${t.visit_id} AND released_at IS NULL AND expires_at > now()
        ORDER BY starts_at`).map((h) => ({ holdId: h.id, startsAt: h.starts_at.toISOString() }));
    }
    if (holds.length < OFFER_COUNT) {
      const [v] = t.visit_id
        ? await sql<{ scheduled_at: Date }[]>`SELECT scheduled_at FROM site_visits WHERE org_id = ${orgId} AND id = ${t.visit_id}`
        : [];
      const asked = v ? v.scheduled_at.toISOString() : istAt(ist(new Date(Date.parse(nowIso) + 86_400_000).toISOString()).date, "11:00");
      holds = await holdAlternatives(sql, { orgId, projectId, leadId: t.lead_id, visitId: t.visit_id, askedIso: asked, nowIso });
    }
    return holds.map((h) => ({ label: offerLabel(h.startsAt), payload: holdPayload(h.holdId) }));
  });
}

/** A full hour, said with the ones that are free. */
function fullMessage(open: string[]): string {
  return open.length
    ? `That hour is full. Free: ${open.map(offerLabel).join("; ")}.`
    : "That hour is full, and no other is free this week.";
}

/**
 * The buyer tapped one of the times offered. The visit it was offered for
 * (or a new one, for a re-offer) takes that time and its seat, the lead
 * moves to Visit scheduled with it, and the confirmation and reminders
 * follow as for any visit. False when the time is no longer theirs.
 */
export async function onSlotChosen(o: { orgId: string; holdId: string; phone: string; nowIso?: string }): Promise<boolean> {
  const now = o.nowIso ?? new Date().toISOString();
  const booked = await bookFromHold({ orgId: o.orgId, holdId: o.holdId, phone: o.phone });
  if (!booked) return false;
  const at = ist(booked.atIso);
  await applyEngineMove({
    orgId: o.orgId,
    leadId: booked.leadId,
    move: { to: "visit_scheduled", facts: { visitDate: at.date, visitTime: at.time }, why: "Picked a time on WhatsApp" },
    needsPerson: null,
  });
  await schedule(o.orgId, booked.leadId, visitSteps({ leadId: booked.leadId, visitId: booked.visitId, atIso: booked.atIso, nowIso: now, confirmCall: roleAgentOn("confirmer") }));
  await runLeadTasks({ orgId: o.orgId, leadId: booked.leadId, nowIso: now, max: 4 });
  return true;
}

/**
 * A person moves a visit from the visits screen: a new visit at the new
 * time takes its seat, the old one gives its seat back and points at it,
 * its reminders skip, and the new one's are scheduled. A full hour is
 * refused with the ones that are free.
 */
export async function moveVisit(o: { orgId: string; userId: string; visitId: string; date: string; time: string; nowIso?: string }): Promise<{ ok: boolean; message: string }> {
  const now = o.nowIso ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date) || !/^\d{2}:\d{2}$/.test(o.time)) {
    return { ok: false, message: "Choose a day and a half-hour slot." };
  }
  const at = istAt(o.date, o.time);
  if (Date.parse(at) <= Date.parse(now)) return { ok: false, message: "That time has passed." };
  const v = await withTenant(o.orgId, async (sql) => {
    const [r] = await sql<{ lead_id: string; status: string; host_id: string | null; scope_node_id: string }[]>`
      SELECT lead_id, status, host_id, scope_node_id FROM site_visits WHERE org_id = ${o.orgId} AND id = ${o.visitId}`;
    return r ? { ...r, open: await visitHoursAt(sql, o.orgId, r.scope_node_id) } : null;
  });
  if (!v) return { ok: false, message: "That visit no longer exists." };
  if (!opensAt(v.open, o.date, o.time)) return { ok: false, message: closedMessage(v.open, o.date) };
  if (!["CONFIRMED", "REQUESTED", "NO_SHOW"].includes(v.status)) return { ok: false, message: "This visit cannot be moved now." };
  const booked = await bookVisit({ orgId: o.orgId, leadId: v.lead_id, atIso: at, via: "CONSOLE", userId: o.userId, fallbackHostId: v.host_id, ifFull: "REFUSE", nowIso: now });
  if (!booked) return { ok: false, message: "That lead no longer exists." };
  if (booked.kind !== "CONFIRMED") return { ok: false, message: fullMessage(booked.kind === "FULL" ? booked.alternatives : []) };
  await applyEngineMove({
    orgId: o.orgId,
    leadId: v.lead_id,
    move: { to: "visit_scheduled", facts: { visitDate: o.date, visitTime: o.time }, why: "Visit moved" },
  });
  await schedule(o.orgId, v.lead_id, visitSteps({ leadId: v.lead_id, visitId: booked.visitId, atIso: at, nowIso: now, confirmCall: roleAgentOn("confirmer") }));
  await runLeadTasks({ orgId: o.orgId, leadId: v.lead_id, nowIso: now, max: 4 });
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "visit.moved", targetType: "site_visit", targetId: o.visitId, metadata: { to: booked.visitId } });
  return { ok: true, message: "Visit moved. The buyer gets the new time on WhatsApp." };
}

/** Whether an hour has a free seat for this lead, and the free ones if not, before a person books it. */
export async function seatCheck(o: { orgId: string; leadId: string; atIso: string; nowIso?: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const now = o.nowIso ?? new Date().toISOString();
  return withTenant(o.orgId, async (sql) => {
    const [lead] = await sql<{ scope_node_id: string }[]>`SELECT scope_node_id FROM leads WHERE org_id = ${o.orgId} AND id = ${o.leadId}`;
    if (!lead) return { ok: true as const };
    const projectId = await projectOf(sql, o.orgId, lead.scope_node_id);
    if (!projectId) return { ok: true as const };
    const days = Array.from({ length: 9 }, (_, i) => new Date(Date.parse(`${ist(o.atIso).date}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
    const hourAt = await hoursOf(sql, o.orgId, projectId, days);
    const open = await visitHoursOf(sql, o.orgId, projectId);
    const { day, hour } = { day: ist(o.atIso).date, hour: ist(o.atIso).hour };
    if (freeSeats(hourAt(day, hour)) > 0) return { ok: true as const };
    return { ok: false as const, message: fullMessage(alternatives({ askedIso: o.atIso, nowIso: now, hourAt, hours: open }).map((a) => a.startsAt)) };
  });
}

/** Whether the buyer agreed to WhatsApp from the developer, so a nudge may go. */
async function marketingConsent(orgId: string, leadId: string): Promise<boolean> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM lead_consents c JOIN leads l ON l.phone = c.phone AND l.org_id = c.org_id
        WHERE l.org_id = ${orgId} AND l.id = ${leadId} AND 'whatsapp' = ANY(c.channels)
          AND (c.expires_at IS NULL OR c.expires_at > now())) AS ok`;
    return !!r?.ok;
  });
}

/**
 * Who takes a buyer calling from outside India: the least loaded of the
 * people the organisation named as its NRI desk who can still work a lead
 * at the tower, else nobody in particular.
 */
async function nriDeskOwner(orgId: string, nodeId: string): Promise<string | null> {
  const s = await leadScoring(orgId);
  if (!s.nriDesk.length) return null;
  const people = await ownersFor(orgId, nodeId);
  return people.find((p) => s.nriDesk.includes(p.id))?.id ?? null;
}

/** Run what is due, for one lead or the whole tenant. */
export async function runLeadTasks(opts: { orgId: string; leadId?: string; nowIso?: string; max?: number; purposes?: readonly Purpose[] }): Promise<{ ran: number; done: number; skipped: number; deferred: number; failed: number }> {
  const now = opts.nowIso ?? new Date().toISOString();
  const out = { ran: 0, done: 0, skipped: 0, deferred: 0, failed: 0 };
  let budget = opts.max ?? 25;
  // A task can schedule another that is due at once (a call that ended
  // straight away, a check that starts a recovery), so claim again until
  // nothing is due or the budget is spent.
  while (budget > 0) {
    const tasks = await claim(opts.orgId, now, Math.min(budget, 10), opts.leadId ?? null, opts.purposes ?? null);
    if (!tasks.length) break;
    for (const t of tasks) {
      budget -= 1;
      let f: Finish;
      try {
        f = await runTask(opts.orgId, t, now);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        f = t.attempts < 3
          ? { state: "DUE", dueAt: new Date(Date.parse(now) + 10 * 60_000).toISOString(), result: message, refund: false }
          : { state: "FAILED", result: message };
      }
      await finish(opts.orgId, t.id, f);
      out.ran += 1;
      if (f.state === "DONE") out.done += 1;
      else if (f.state === "SKIPPED") out.skipped += 1;
      else if (f.state === "DUE") out.deferred += 1;
      else out.failed += 1;
    }
  }
  return out;
}

/**
 * Call backs a buyer asked for, on the minute. The lead worker passes every
 * three minutes, which makes "call me in five minutes" eight; the call
 * watcher looks every 15 seconds and runs only these, so a buyer is rung
 * within seconds of the time they named. The lead worker still runs them
 * too; the lease makes the two safe together.
 */
export async function runDueCallbacks(nowIso = new Date().toISOString()): Promise<number> {
  // Enumerating tenants is the platform job's control-plane act; every task
  // is read and run inside its own tenant.
  const orgs = await controlDb<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED' ORDER BY created_at`;
  let ran = 0;
  for (const org of orgs) {
    const r = await runLeadTasks({ orgId: org.id, nowIso, max: 10, purposes: ["CALLBACK"] });
    ran += r.ran;
  }
  return ran;
}

// ---------------------------------------------------------------------------
// The worker's pass
// ---------------------------------------------------------------------------

export type LeadWorkReport = {
  orgsScanned: number;
  events: number;
  silentCalls: number;
  /** Partner registrations that ran out and handed their buyer back. */
  released: number;
  tasks: { ran: number; done: number; skipped: number; deferred: number; failed: number };
  /** Ads whose figures were read, and budget moves made. */
  budget: { ads: number; shifts: number };
  /** Outcomes told to Meta and Google, and the ones left waiting or refused. */
  outcomes: { sent: number; waiting: number; notSent: number; failed: number };
  /** Developers' WhatsApp accounts read back, and the ones found broken. */
  whatsapp: { checked: number; broken: number };
  /** WhatsApp broadcasts worked this pass, and what became of their messages. */
  broadcasts: { scheduled: number; worked: number; sent: number; refused: number; failed: number; halted: number };
  /** Hosts' voice notes transcribed and read. */
  notes: number;
  /** Housing.com accounts asked for their leads, the leads they gave, and accounts found broken. */
  portals: { asked: number; leads: number; broken: number };
};

/**
 * One bounded pass over every tenant: finish capture events that did not
 * finish, close calls nobody reported back on, and run the tasks that are
 * due. Safe to run twice at once; every task is claimed under a lease.
 */
export async function runLeadWork(opts: { nowIso?: string; orgIds?: string[]; max?: number; skipBudget?: boolean } = {}): Promise<LeadWorkReport> {
  const now = opts.nowIso ?? new Date().toISOString();
  // Enumerating tenants is a platform job's control-plane act, as in the
  // post worker and the sweep. Everything done per tenant runs inside it.
  const orgs = await controlDb<{ id: string }[]>`
    SELECT id FROM orgs WHERE status <> 'SUSPENDED'
      ${opts.orgIds ? controlDb`AND id = ANY(${opts.orgIds})` : controlDb``}
    ORDER BY created_at`;
  const report: LeadWorkReport = {
    orgsScanned: orgs.length,
    events: 0,
    silentCalls: 0,
    released: 0,
    tasks: { ran: 0, done: 0, skipped: 0, deferred: 0, failed: 0 },
    budget: { ads: 0, shifts: 0 },
    outcomes: { sent: 0, waiting: 0, notSent: 0, failed: 0 },
    whatsapp: { checked: 0, broken: 0 },
    broadcasts: { scheduled: 0, worked: 0, sent: 0, refused: 0, failed: 0, halted: 0 },
    notes: 0,
    portals: { asked: 0, leads: 0, broken: 0 },
  };
  for (const org of orgs) {
    // A portal account we ask (Housing.com), every ten minutes; what it gave
    // goes through capture at once rather than on the next pass.
    const pulled = await pullPortalAccounts(org.id, now).catch((e) => {
      console.error("lead worker: portal accounts could not be asked", e);
      return null;
    });
    if (pulled) {
      report.portals.asked += pulled.asked;
      report.portals.leads += pulled.leads;
      report.portals.broken += pulled.broken;
      for (const id of pulled.eventIds) {
        await processEvent(org.id, id, { nowIso: now, runNow: false });
        report.events += 1;
      }
    }
    // Leads on a Page's forms that no webhook brought.
    const swept = await sweepMetaForms(org.id, new Date(now)).catch((e) => {
      console.error("lead worker: Page forms could not be read", e);
      return null;
    });
    for (const id of swept?.eventIds ?? []) {
      await processEvent(org.id, id, { nowIso: now, runNow: false });
      report.events += 1;
    }
    // What every connected ad account spent, ours or made in Ads Manager.
    await syncAccountSpend(org.id, new Date(now)).catch((e) => console.error("lead worker: ad spend could not be read", e));
    const pending = await withTenant(org.id, (sql) => sql<{ id: string }[]>`
      SELECT id FROM lead_events
      WHERE org_id = ${org.id} AND processed_at IS NULL AND attempts < 5
        AND outcome IS DISTINCT FROM 'WAITING'
        AND received_at < ${new Date(Date.parse(now) - 60_000)}
      ORDER BY received_at LIMIT 50`);
    for (const e of pending) {
      await processEvent(org.id, e.id, { nowIso: now, runNow: false });
      report.events += 1;
    }
    report.silentCalls += await settleCalls(org.id, new Date(now), { runNow: false });
    // Calls the end-of-call pass could not read are read here.
    await readUnreadCalls(org.id, now).catch((e) => console.error("lead worker: calls could not be read", e));
    // Voice notes the upload could not transcribe where it ran, and notes
    // whose lead closed a year ago.
    report.notes += await processDueNotes(org.id, { nowIso: now });
    await expireNotes(org.id);
    // Token links that ran out, were never made, or sit on a stopped tower.
    await sweepQuotes(org.id, now);
    // A partner's claim that ran out hands its buyer back.
    report.released += await sweepRegistrations(org.id);
    const r = await runLeadTasks({ orgId: org.id, nowIso: now, max: opts.max ?? 50 });
    for (const k of Object.keys(r) as (keyof typeof r)[]) report.tasks[k] += r[k];
    // Yesterday's figures are final by the morning, so the daily read and
    // any budget move happen once, after six.
    if (ist(now).hour >= 6 && !opts.skipBudget) {
      const b = await dailyBudgetPass(org.id, new Date(now));
      report.budget.ads += b.ads;
      report.budget.shifts += b.shifts;
      // With the day's figures in, what has worked is worked out again.
      await dailyLearningPass(org.id, new Date(now)).catch(() => false);
    }
    // What became of leads, told to the platforms that bought them. Never
    // gated on the RERA gate: this reports spend already made.
    const o = await sendOutcomes(org.id, { nowIso: now });
    for (const k of Object.keys(o) as (keyof typeof o)[]) report.outcomes[k] += o[k];
    // Each connected WhatsApp account read back once a day, beside its
    // webhooks: a token that stopped working, a number's quality and limit,
    // and what Meta decided about each template.
    const w = await checkWhatsApp(org.id, { now: new Date(now) });
    report.whatsapp.checked += w.checked;
    report.whatsapp.broken += w.broken;
    // Approved broadcasts, in leased batches inside the number's daily limit.
    const bc = await sendDueBroadcasts({ orgId: org.id, now: new Date(now) });
    report.broadcasts.scheduled += bc.scheduled;
    report.broadcasts.worked += bc.broadcasts;
    report.broadcasts.sent += bc.sent;
    report.broadcasts.refused += bc.refused;
    report.broadcasts.failed += bc.failed;
    report.broadcasts.halted += bc.halted;
  }
  return report;
}

// ---------------------------------------------------------------------------
// A person pressed a button on a lead
// ---------------------------------------------------------------------------

/** Send the site's location now, on a person's say-so. */
/**
 * Calls still "Calling now" settled: first asked of Sarvam's own log
 * (`reconcileCalls()`), and only then closed as silent after thirty minutes.
 * Each settled call runs what its end starts, as a webhook's would. Returns
 * how many were settled.
 */
export async function settleCalls(orgId: string, now = new Date(), opts: { runNow?: boolean } = {}): Promise<number> {
  const found = await reconcileCalls(orgId, now);
  const silent = await closeSilentCalls(orgId, now);
  for (const id of [...found, ...silent]) await onCallEnded(orgId, id, { nowIso: now.toISOString(), runNow: opts.runNow ?? false });
  return found.length + silent.length;
}

const settledAt = new Map<string, number>();

/**
 * `settleCalls()` from a page, at most every fifteen seconds per organisation.
 * The worker does it every pass; a development machine usually runs no worker,
 * and the call log is where a stuck call is noticed. The log refreshes itself
 * every ten seconds while a call is live, so with the webhook's tunnel down a
 * finished call read "Calling now" for up to a minute at once a minute. A pass
 * with nothing stuck is one query; Sarvam is asked only about a stuck call.
 */
export async function settleCallsSoon(orgId: string): Promise<void> {
  const last = settledAt.get(orgId) ?? 0;
  if (Date.now() - last < 15_000) return;
  settledAt.set(orgId, Date.now());
  try {
    await settleCalls(orgId);
  } catch (e) {
    console.warn("calls: settling failed,", (e as Error).message);
  }
}

export async function sendLocation(opts: { orgId: string; userId: string; leadId: string }): Promise<{ ok: boolean; message: string }> {
  const r = await sendMessage({ orgId: opts.orgId, leadId: opts.leadId, purpose: "SITE_LOCATION", userId: opts.userId });
  if (r.ok) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "lead.location_sent", targetType: "lead", targetId: opts.leadId });
    return { ok: true, message: "Location sent on WhatsApp." };
  }
  return { ok: false, message: r.message };
}

/** Answered calls that close the lead, or say nothing, are not worth a read. */
const UNREAD_SKIP = ["OPTED_OUT", "NOT_INTERESTED", "WRONG_NUMBER", "BROKER", "BAD_LINE", "NO_ANSWER"];

/**
 * Calls the end-of-call pass could not read: the reader was down, or the
 * function ran out of time (on 10 October 2026 every call the hosted webhook
 * ended went unread). Each is read now with our own score, and its hot, warm
 * or cold is written on the call, and on the lead while it is the lead's
 * latest call. What the call already scheduled stands. The last three days,
 * twenty a pass; each read is refused before it is paid for, as ever.
 */
export async function readUnreadCalls(orgId: string, nowIso: string): Promise<number> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; lead_id: string; final_variables: Record<string, unknown> | null; latest: boolean }[]>`
    SELECT c.id, c.lead_id, c.final_variables,
           NOT EXISTS (SELECT 1 FROM calls x WHERE x.lead_id = c.lead_id AND x.placed_at > c.placed_at AND x.status <> 'REFUSED') AS latest
    FROM calls c
    WHERE c.org_id = ${orgId} AND c.connectivity = 'connected' AND c.qualification IS NULL
      AND c.agent IN ('qualifier', 'reengage', 'goal', 'receptionist')
      AND c.outcome IS NOT NULL AND c.outcome <> ALL(${UNREAD_SKIP}::text[])
      AND c.placed_at > ${new Date(Date.parse(nowIso) - 3 * 86_400_000)}
      AND c.placed_at < ${new Date(Date.parse(nowIso) - 5 * 60_000)}
    ORDER BY c.placed_at DESC
    LIMIT 20`);
  let read = 0;
  for (const r of rows) {
    const reading = await qualifyCall(orgId, r.id, { nowIso }).catch(() => null);
    if (!reading) continue;
    read += 1;
    // A call that told us nothing judges nobody (`learnt`).
    const temperature = reading.learnt ? callTemperature(reading.route, r.final_variables) : null;
    if (!temperature) continue;
    await withTenant(orgId, async (sql) => {
      await sql`UPDATE calls SET temperature = ${temperature} WHERE org_id = ${orgId} AND id = ${r.id}`;
      if (r.latest) {
        await sql`UPDATE leads SET temperature = ${temperature}, updated_at = now() WHERE org_id = ${orgId} AND id = ${r.lead_id}`;
      }
    });
  }
  return read;
}
