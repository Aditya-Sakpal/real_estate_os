import { mayCallEnquired, type ListSource } from "./call-list-rules.ts";
import { isUuid } from "./capture-rules.ts";
import { createHmac, randomUUID } from "node:crypto";
import { audit, auditHash, withTenant } from "./db/index.ts";
import { partnerHold } from "./partners.ts";
import { closeStaleLead, ownershipOf } from "./leads.ts";
import { dndGate, recordDnd } from "./dnd.ts";
import { dndCause } from "./dnd-rules.ts";
import { canPublish } from "./publish-gate.ts";
import { offersOtherProjects, pickProjectsFor, wantOf, type Candidate, type Want } from "./project-match-rules.ts";
import { voiceForCall } from "./agent-voices.ts";
import { voiceApp } from "./voice-apps-rules.ts";
import { resolveBrain } from "./brain.ts";
import { callMemoryOn, projectFactsOn, regionalLanguagesOn, sarvam, sarvamConfig, sayWordsOn } from "./sarvam.ts";
import { asksCallback, buyerFacts, callMemory, type CallReason, type PriorCall } from "./call-memory-rules.ts";
import { ist } from "./cadence-rules.ts";
import { callerLineFor, sharedAiNumber } from "./calling-numbers.ts";
import { callAllowance, meterCall } from "./billing.ts";
import { AGENT_JOB_LABEL, HANDOFF_WEIGHT, agentJobFor } from "./billing-rules.ts";
import {
  CLOSING_RULE,
  DEFAULT_POLICY,
  FACTS_RULE,
  FAMILY_RULE,
  HUMAN_RULE,
  callerRule,
  SCREENER_RULE,
  SILENT_CALL_REASON,
  isSystemFailure,
  carrierOutcome,
  hungUpBy,
  carrierRecordOf,
  openingLanguage,
  stateOfCity,
  callNotice,
  callToken,
  verifyCallToken,
  callVariables,
  enquiryFromForm,
  openingFacts,
  factsFromVariables,
  anyHourFor,
  gateCall,
  goalProblem,
  istDate,
  projectFacts,
  longDay,
  normalisePhone,
  visitMoment,
  readWebhook,
  resolvePolicy,
  tempOf,
  type CallGoal,
  type CallingPolicy,
  type PolicyLayer,
  type RoleContext,
  looksLikeTest,
} from "./calling-rules.ts";
import { vobiz, vobizConfig, type CarrierCall } from "./vobiz.ts";
import {
  goalResult,
  roleAgentFor,
  withoutOwnAgent,
  type AgentKind,
  type CallRecord,
  type Language,
  type NextStep,
  type Outcome,
  type Turn,
} from "./call-rules.ts";
import type { LeadAt, Lens } from "./mask-rules.ts";
import type { Facts, PathStage, StageKey } from "./lead-rules.ts";
import { limitsLifted } from "./plan-purchase-rules.ts";
import { withSalesNote } from "./handoff-rules.ts";

/**
 * Placing real calls: the reads and writes around `calling-rules.ts`.
 *
 * Every read and write goes through `withTenant()`. The one request that
 * arrives without a session, Sarvam's webhook, carries a token binding it to
 * one call in one organisation and is checked before anything is read.
 */

// ---------------------------------------------------------------------------
// The client's policy
// ---------------------------------------------------------------------------

type SettingsRow = {
  consent_required: boolean | null;
  announce_recording: boolean | null;
  recording_line: string | null;
  announce_ai: boolean | null;
  handoff_number: string | null;
  auto_outreach: boolean | null;
  minute_allowance: number | null;
  channel_limit: number | null;
};

const toLayer = (r: SettingsRow): PolicyLayer => ({
  consentRequired: r.consent_required,
  announceRecording: r.announce_recording,
  recordingLine: r.recording_line,
  announceAi: r.announce_ai,
  handoffNumber: r.handoff_number,
  autoOutreach: r.auto_outreach,
  minuteAllowance: r.minute_allowance,
  channelLimit: r.channel_limit,
});

/**
 * The hand-off number a fresh organisation starts with, from the environment.
 * It is a default and nothing more: the first save writes the org's own.
 */
function basePolicy(): CallingPolicy {
  const handoff = normalisePhone(process.env.HANDOFF_DEFAULT_NUMBER ?? "");
  return { ...DEFAULT_POLICY, handoffNumber: handoff };
}

/** The policy in force at a node: the org root, then anything set below it. */
export async function policyAt(orgId: string, nodeId: string | null): Promise<CallingPolicy> {
  return withTenant(orgId, async (sql) => {
    const rows = nodeId
      ? await sql<SettingsRow[]>`
          SELECT s.consent_required, s.announce_recording, s.recording_line,
                 s.announce_ai, s.handoff_number, s.auto_outreach, s.minute_allowance, s.channel_limit
          FROM calling_settings s
          JOIN scope_nodes n ON n.id = s.scope_node_id
          JOIN scope_nodes t ON t.id = ${nodeId} AND t.org_id = ${orgId}
          WHERE s.org_id = ${orgId} AND n.path @> t.path
          ORDER BY nlevel(n.path)`
      : await sql<SettingsRow[]>`
          SELECT s.consent_required, s.announce_recording, s.recording_line,
                 s.announce_ai, s.handoff_number, s.auto_outreach, s.minute_allowance, s.channel_limit
          FROM calling_settings s
          JOIN scope_nodes n ON n.id = s.scope_node_id AND n.kind = 'ORG'
          WHERE s.org_id = ${orgId}`;
    return resolvePolicy(rows.map(toLayer), basePolicy());
  });
}

/**
 * The hand-off number this organisation saved itself, at or above the node,
 * the deepest first. Never the environment's default (`basePolicy()`), which
 * stands in for every organisation that saved none and so belongs to none of
 * them: it is not anybody's sales team.
 */
export async function ownHandoffNumber(orgId: string, nodeId: string | null): Promise<string | null> {
  const rows = await withTenant(orgId, (sql) => nodeId
    ? sql<{ handoff_number: string }[]>`
        SELECT s.handoff_number FROM calling_settings s
        JOIN scope_nodes n ON n.id = s.scope_node_id
        JOIN scope_nodes t ON t.id = ${nodeId} AND t.org_id = ${orgId}
        WHERE s.org_id = ${orgId} AND n.path @> t.path AND s.handoff_number IS NOT NULL
        ORDER BY nlevel(n.path) DESC LIMIT 1`
    : sql<{ handoff_number: string }[]>`
        SELECT s.handoff_number FROM calling_settings s
        JOIN scope_nodes n ON n.id = s.scope_node_id AND n.kind = 'ORG'
        WHERE s.org_id = ${orgId} AND s.handoff_number IS NOT NULL LIMIT 1`);
  return rows[0]?.handoff_number ?? null;
}

/** The automation fields are optional: a form that does not show them keeps what is stored. */
export type PolicyInput = Omit<CallingPolicy, "autoOutreach" | "minuteAllowance" | "channelLimit"> &
  Partial<Pick<CallingPolicy, "autoOutreach" | "minuteAllowance" | "channelLimit">>;

/** Write the organisation's policy, and record who changed what. */
export async function saveOrgPolicy(opts: {
  orgId: string;
  userId: string;
  input: PolicyInput;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { orgId, userId, input } = opts;
  if (input.handoffNumber !== null && !/^\+[1-9]\d{7,14}$/.test(input.handoffNumber)) {
    return { ok: false, message: "Enter the hand-off number with its country code, like +91 98765 43210." };
  }
  // One sentence per mistake: "-5" is not a question of whole numbers.
  const minutes = input.minuteAllowance;
  if (minutes !== undefined) {
    if (Number.isFinite(minutes) && minutes < 0) return { ok: false, message: "Minutes can't be negative." };
    if (!Number.isInteger(minutes)) return { ok: false, message: "Enter the minutes as a whole number, like 1,500." };
    if (minutes > 1_000_000) return { ok: false, message: "Enter at most 10,00,000 minutes." };
  }
  const channels = input.channelLimit;
  if (channels !== undefined) {
    if (Number.isFinite(channels) && channels < 1) return { ok: false, message: "Allow at least 1 call at once." };
    if (!Number.isInteger(channels)) return { ok: false, message: "Enter calls at once as a whole number, like 3." };
    if (channels > 50) return { ok: false, message: "Allow at most 50 calls at once." };
  }
  const before = await policyAt(orgId, null);
  const next: CallingPolicy = {
    ...input,
    autoOutreach: input.autoOutreach ?? before.autoOutreach,
    minuteAllowance: input.minuteAllowance ?? before.minuteAllowance,
    channelLimit: input.channelLimit ?? before.channelLimit,
  };
  await withTenant(orgId, async (sql) => {
    const [root] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`;
    if (!root) throw new Error("This organisation has no root node.");
    await sql`
      INSERT INTO calling_settings
        (org_id, scope_node_id, consent_required, announce_recording, recording_line,
         announce_ai, handoff_number, auto_outreach, minute_allowance, channel_limit, updated_by, updated_at)
      VALUES (${orgId}, ${root.id}, ${next.consentRequired}, ${next.announceRecording},
              ${next.recordingLine}, ${next.announceAi}, ${next.handoffNumber}, ${next.autoOutreach},
              ${next.minuteAllowance}, ${next.channelLimit}, ${userId}, now())
      ON CONFLICT (org_id, scope_node_id) DO UPDATE SET
        consent_required = EXCLUDED.consent_required,
        announce_recording = EXCLUDED.announce_recording,
        recording_line = EXCLUDED.recording_line,
        announce_ai = EXCLUDED.announce_ai,
        handoff_number = EXCLUDED.handoff_number,
        auto_outreach = EXCLUDED.auto_outreach,
        minute_allowance = EXCLUDED.minute_allowance,
        channel_limit = EXCLUDED.channel_limit,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()`;
  });
  // The switches are the evidence that the client chose them, so each change
  // is written with its before and after. The number itself is hashed.
  const changed: Record<string, unknown> = {};
  for (const key of ["consentRequired", "announceRecording", "announceAi", "autoOutreach", "minuteAllowance", "channelLimit"] as const) {
    if (before[key] !== next[key]) changed[key] = { from: before[key], to: next[key] };
  }
  if ((before.recordingLine ?? "") !== (input.recordingLine ?? "")) changed.recordingLine = true;
  if (before.handoffNumber !== input.handoffNumber) {
    changed.handoffNumber = auditHash(input.handoffNumber);
  }
  if (Object.keys(changed).length) {
    await audit({ orgId, actorUserId: userId, action: "calling.settings_changed", targetType: "org", targetId: orgId, metadata: changed });
  }
  return { ok: true };
}

export async function optOutCount(orgId: string): Promise<number> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM call_suppressions WHERE org_id = ${orgId}`;
    return r?.n ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Placing a call
// ---------------------------------------------------------------------------

export type CallRefusal =
  | "OPTED_OUT"
  | "OUTSIDE_HOURS"
  | "NO_CONSENT"
  | "NOT_ADVERTISABLE"
  | "NOT_SWITCHED_ON"
  | "ALLOWANCE"
  | "NO_PLAN"
  | "NOT_IN_PLAN"
  | "BUSY"
  | "GONE"
  | "INVALID"
  | "PARTNER_BUYER"
  | "DND"
  | "NO_NUMBER"
  | "REFUSED";

export type CallOutcome =
  | { ok: true; callId: string; leadName: string }
  | { ok: false; code: CallRefusal; message: string };

export function webhookSecret(): string {
  const root = process.env.AUTH_SECRET;
  if (!root) throw new Error("AUTH_SECRET is not set.");
  return createHmac("sha256", root).update("salesdesk:calls-webhook").digest("hex");
}

/** Whether a webhook address really names this call in this organisation. */
export function webhookIsGenuine(orgId: string, callId: string, token: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(token)) return false;
  return verifyCallToken(webhookSecret(), orgId, callId, token);
}

export function webhookBase(): string | null {
  const base = process.env.CALLS_WEBHOOK_BASE ?? process.env.CONNECT_BASE_URL ?? process.env.AUTH_URL;
  if (!base) return null;
  return base.replace(/\/+$/, "");
}

type NodeInfo = {
  id: string;
  kind: string;
  name: string;
  parent_name: string | null;
  grand_name: string | null;
};

/** Record a lead, and consent when the person entering it has it, then call. */
export async function addLeadAndCall(opts: {
  orgId: string;
  userId: string;
  name: string;
  phone: string;
  phaseId: string;
  source: string;
  language: Language;
  consentWording: string | null;
  /** What the call should do beyond qualifying, as `placeCall()` takes it. */
  goal?: CallGoal | null;
  /** For checks: the moment the call is placed. */
  nowIso?: string;
  /** Dev only: see `placeCall()`. */
  testFacts?: (facts: string) => string;
}): Promise<CallOutcome & { lead?: { id: string; merged: boolean } }> {
  const added = await addLeadByHand(opts);
  if (!added.ok) return added;
  const call = await placeCall({ orgId: opts.orgId, userId: opts.userId, leadId: added.lead.id, goal: opts.goal ?? null, nowIso: opts.nowIso, testFacts: opts.testFacts });
  return { ...call, lead: added.lead };
}

export type AddedByHand =
  | { ok: true; lead: { id: string; merged: boolean } }
  | { ok: false; code: CallRefusal; message: string; lead?: { id: string; merged: boolean } };

/**
 * A lead a person entered, through the capture's own ownership rules, and
 * its consent when they have it. The one write path behind "Call a lead"
 * and a call list's rows.
 */
export async function addLeadByHand(opts: {
  orgId: string;
  userId: string;
  name: string;
  phone: string;
  phaseId: string;
  source: string;
  language: Language;
  consentWording: string | null;
  /** Where the consent was given, for the record. */
  consentSource?: string;
  /** The words on the lead's history: "Added by hand", or the list it came from. */
  addedAs?: string;
  nowIso?: string;
}): Promise<AddedByHand> {
  const phone = normalisePhone(opts.phone);
  if (!phone) return { ok: false, code: "INVALID", message: "That phone number does not look right. Use 10 digits, or add the country code." };
  const name = opts.name.trim().slice(0, 120);
  if (!name) return { ok: false, code: "INVALID", message: "Enter the lead's name." };
  if (!isUuid(opts.phaseId)) return { ok: false, code: "INVALID", message: "Choose the tower they asked about." };

  const nowIso = opts.nowIso ?? new Date().toISOString();
  const added = await withTenant(opts.orgId, async (sql) => {
    const [node] = await sql<{ id: string; project_path: string | null }[]>`
      SELECT n.id, (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = ${opts.orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project_path
      FROM scope_nodes n WHERE n.org_id = ${opts.orgId} AND n.id = ${opts.phaseId} AND n.kind = 'PHASE'`;
    if (!node) return null;
    // The capture's own ownership rules: junk is refused, a buyer who booked
    // here is not called, an open lead inside the lookback is the same lead
    // (its enquiry clock restarts), and one quiet past it is closed and the
    // buyer becomes a new card.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capture:${opts.orgId}:${phone}`}, 0))`;
    const verdict = await ownershipOf(sql, {
      orgId: opts.orgId,
      phone,
      name,
      nodeId: node.id,
      projectPath: node.project_path,
      isTest: false,
      honeypot: false,
      nowIso,
    });
    if (verdict.action === "JUNK") return { kind: "refused" as const, refused: verdict.reason, leadId: null };
    if (verdict.action === "BOOKED") return { kind: "refused" as const, refused: "This buyer has already booked here, so the AI does not call them.", leadId: verdict.leadId };
    let existing: { id: string } | null = null;
    if (verdict.action === "MERGE") {
      existing = { id: verdict.leadId };
      await sql`
        UPDATE leads SET enquired_at = now(), last_activity_at = now(), updated_at = now()
        WHERE org_id = ${opts.orgId} AND id = ${existing.id}`;
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
        VALUES (${opts.orgId}, ${existing.id}, 'CAPTURED', ${`${opts.addedAs ?? "Added by hand"} again`.slice(0, 200)}, ${opts.userId})`;
    } else if (verdict.closeStale) {
      await closeStaleLead(sql, opts.orgId, verdict.closeStale);
    }
    const [lead] = existing ? [existing] : await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, language, created_by)
      VALUES (${opts.orgId}, ${node.id}, ${name}, ${phone}, ${opts.source.trim().slice(0, 60) || "Manual"},
              ${opts.language}, ${opts.userId})
      RETURNING id`;
    if (!existing) {
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
        VALUES (${opts.orgId}, ${lead.id}, 'CAPTURED', ${(opts.addedAs ?? "Added by hand").slice(0, 200)}, ${opts.userId})`;
    }
    if (opts.consentWording?.trim()) {
      await sql`
        INSERT INTO lead_consents (org_id, phone, channels, wording, source, captured_by)
        VALUES (${opts.orgId}, ${phone}, ${["call", "whatsapp"]}, ${opts.consentWording.trim().slice(0, 600)},
                ${opts.consentSource ?? "Console"}, ${opts.userId})`;
    }
    return { kind: "added" as const, id: lead.id, merged: Boolean(existing), rule: verdict.rule };
  });
  if (!added) return { ok: false, code: "INVALID", message: "Choose the tower they asked about." };
  if (added.kind === "refused") {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.userId,
      action: "lead.ownership",
      targetType: added.leadId ? "lead" : "org",
      targetId: added.leadId ?? opts.orgId,
      metadata: { ownership: added.leadId ? "R1" : "R0", channel: "MANUAL" },
    });
    return {
      ok: false,
      code: "INVALID",
      message: added.refused,
      ...(added.leadId ? { lead: { id: added.leadId, merged: true } } : {}),
    };
  }
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: added.merged ? "lead.ownership" : "lead.created",
    targetType: "lead",
    targetId: added.id,
    metadata: { source: opts.source, consent: !!opts.consentWording, ownership: added.rule },
  });
  return { ok: true, lead: { id: added.id, merged: added.merged } };
}

/**
 * How many calls a tower's project may have ringing at once: the plan's
 * channels when it is billed, else the calling settings' own limit. The
 * same number `placeCall()` holds a call to, so a caller filling lines
 * never asks for more than it may get.
 */
export async function callLines(orgId: string, nodeId: string, agent: AgentKind = "goal"): Promise<number> {
  const [policy, plan] = await Promise.all([policyAt(orgId, nodeId), callAllowance({ orgId, nodeId, agent })]);
  return plan.billed && plan.ok ? plan.channels : policy.channelLimit;
}

/**
 * Call one lead now.
 *
 * The order is: the number may be called (opt-out, hours, consent), the
 * tower may be spoken about (the RERA gate), calling is switched on, and only
 * then is anything sent to Sarvam. A refusal at any step places nothing.
 */
/** The enquiry time a cold contact is judged by: long past every enquiry window. */
const NEVER_ENQUIRED = new Date(0).toISOString();

export async function placeCall(opts: {
  orgId: string;
  /** Null when the engine placed it on its cadence. */
  userId: string | null;
  leadId: string;
  nowIso?: string;
  agent?: AgentKind;
  taskId?: string | null;
  /** Which try this is in its run, for the log. */
  attempt?: number;
  /** What a person sent the call to do. It goes to the goal agent, never the qualifier. */
  goal?: CallGoal | null;
  /** The visit a confirmation, rebooking or post-visit call is about. */
  visitId?: string | null;
  /**
   * The tower the call is about, when a person chose one other than the
   * lead's own. Every gate, the minutes and the facts the agent is handed
   * are that tower's.
   */
  nodeId?: string | null;
  /**
   * A test call on a development machine may be told other facts than the
   * signed ones, to try the agent on another price or place. Ignored in
   * production and on Vercel, where a buyer only ever hears signed facts.
   */
  testFacts?: (facts: string) => string;
  /** The name the agent says on this one call, when a person chose one other than the lead's. */
  callName?: string | null;
  /**
   * Other towers a person chose to offer on this call (a call list's), in
   * place of the projects the buyer's wants would pick. Each still needs its
   * RERA gate and signed facts.
   */
  alsoPitch?: readonly string[];
  /**
   * False when this person never enquired (a cold call list): the agent
   * then never says they enquired or filled a form. Every other call
   * answers an enquiry.
   */
  enquired?: boolean;
}): Promise<CallOutcome> {
  const { orgId, userId, leadId } = opts;
  const now = opts.nowIso ?? new Date().toISOString();
  const goal = opts.goal ?? null;
  const agent: AgentKind = goal ? "goal" : opts.agent ?? "qualifier";

  const found = await withTenant(orgId, async (sql) => {
    const [lead] = await sql<
      {
        id: string; name: string; phone: string; source: string; language: Language; enquired_at: Date; scope_node_id: string;
        stage: string; facts: Facts | null; qualification: Record<string, { value: string; confidence: number; detail?: string }> | null;
        form_answers: { question: string; answer: string }[] | null;
      }[]
    >`SELECT id, name, phone, source, language, enquired_at, scope_node_id, stage, facts, qualification, form_answers FROM leads
      WHERE org_id = ${orgId} AND id = ${leadId}`;
    if (!lead) return null;
    const nodeAt = (id: string) => sql<(NodeInfo & { project_path: string | null; path: string })[]>`
      SELECT n.id, n.kind, n.name, p.name AS parent_name, g.name AS grand_name, n.path::text AS path,
             (SELECT a.path::text FROM scope_nodes a
               WHERE a.org_id = ${orgId} AND a.kind = 'PROJECT' AND a.path @> n.path LIMIT 1) AS project_path
      FROM scope_nodes n
      LEFT JOIN scope_nodes p ON p.id = n.parent_id
      LEFT JOIN scope_nodes g ON g.id = p.parent_id
      WHERE n.org_id = ${orgId} AND n.id = ${id}`;
    const [enquired] = await nodeAt(lead.scope_node_id);
    // A tower a person chose is a tower: a call is about one registration.
    const other = opts.nodeId && opts.nodeId !== lead.scope_node_id;
    const [node] = other
      ? isUuid(opts.nodeId!)
        ? (await nodeAt(opts.nodeId!)).filter((n) => n.kind === "PHASE")
        : []
      : [enquired];
    const consents = await sql<{ channels: string[]; captured_at: Date; expires_at: Date | null }[]>`
      SELECT channels, captured_at, expires_at FROM lead_consents
      WHERE org_id = ${orgId} AND phone = ${lead.phone}`;
    const [opt] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM call_suppressions WHERE org_id = ${orgId} AND phone = ${lead.phone}`;
    const [org] = await sql<{ display_name: string }[]>`SELECT display_name FROM orgs WHERE id = ${orgId}`;
    // A person a call list brought in stays what the list said they were on
    // every later call too: the lead engine's call back or second try passes
    // no `enquired`, and on 28 October 2026 such a call told a cold contact
    // "you had made an enquiry".
    const [listRow] = opts.enquired === undefined
      ? await sql<{ enquired: boolean | null; source: ListSource }[]>`
          SELECT r.enquired, l.source FROM call_list_rows r JOIN call_lists l ON l.id = r.list_id
          WHERE r.org_id = ${orgId} AND r.lead_id = ${leadId} ORDER BY r.updated_at DESC LIMIT 1`
      : [];
    // The state the tower is registered in (or its project exempted in),
    // which picks the language a call opens in for a buyer whose name says
    // nothing else (`openingLanguage()`).
    const [where] = node
      ? await sql<{ state_code: string | null }[]>`
          SELECT coalesce(
            (SELECT r.state_code FROM registration_records r WHERE r.org_id = ${orgId} AND r.scope_node_id = ${node.id}),
            (SELECT e.state_code FROM project_exemptions e JOIN scope_nodes p ON p.id = e.scope_node_id
              WHERE e.org_id = ${orgId} AND p.path @> ${node.path}::ltree LIMIT 1)) AS state_code`
      : [];
    return { lead, node, enquired, listRow, consents, optedOut: (opt?.n ?? 0) > 0, developer: org?.display_name ?? "", stateCode: where?.state_code ?? null };
  });
  if (!found || !found.enquired) return { ok: false, code: "GONE", message: "That lead no longer exists." };
  if (!found.node) return { ok: false, code: "INVALID", message: "Pick the tower the call is about." };
  const askedEnquiry = opts.enquired ?? (found.listRow ? mayCallEnquired(found.listRow.enquired, found.listRow.source) : true);
  const { lead, node, enquired } = found;

  const policy = await policyAt(orgId, node.id);
  const verdict = gateCall({
    policy,
    nowIso: now,
    // A cold contact (a call list's) never enquired, so no enquiry window applies.
    enquiredAt: !askedEnquiry ? NEVER_ENQUIRED : lead.enquired_at.toISOString(),
    consents: found.consents.map((c) => ({
      channels: c.channels,
      capturedAt: c.captured_at.toISOString(),
      expiresAt: c.expires_at?.toISOString() ?? null,
    })),
    optedOut: found.optedOut,
    anyHour: anyHourFor(lead.phone, userId !== null),
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  // A qualification call names the tower, so it asks the RERA gate the way
  // an advertisement does. A blocked phase gets no call.
  const gate = await canPublish(orgId, node.id);
  if (!gate.ok) return { ok: false, code: "NOT_ADVERTISABLE", message: gate.message };

  // A partner's buyer is the partner's to bring to site. Until the visit,
  // nobody here dials them unless the tenant chose to allow and log it.
  const hold = await partnerHold(orgId, leadId);
  if (hold.held) return { ok: false, code: "PARTNER_BUYER", message: hold.message };

  // What is missing is a setting of ours; the client is told calling is not set up.
  const cfg = sarvamConfig();
  if (!cfg.ok) {
    console.warn(`calls: not configured, missing ${cfg.missing.join(", ")}`);
    return { ok: false, code: "NOT_SWITCHED_ON", message: "AI calling isn't set up for your account yet." };
  }
  const base = webhookBase();
  if (!base) {
    console.warn("calls: not configured, missing CALLS_WEBHOOK_BASE");
    return { ok: false, code: "NOT_SWITCHED_ON", message: "AI calling isn't set up for your account yet." };
  }

  // The number the buyer sees: the tenant's own, placed at or above the
  // tower, or the shared one while it holds none and is not billed LIVE. A
  // tenant with a number is never handed the shared one or anybody else's.
  const line = await callerLineFor(orgId, node.id, sharedAiNumber());
  if (!line.ok) {
    return { ok: false, code: line.code === "OFF" ? "NOT_SWITCHED_ON" : "NO_NUMBER", message: line.message };
  }
  const dialConfig = { ...cfg.config, fromNumber: line.from, connectionId: line.connectionId ?? cfg.config.connectionId };

  // A goal goes to the goal agent or nowhere: a plain call in its place would
  // be the agent quietly not doing what the person asked. Every other job
  // goes to its own agent, a copy of the qualifier with that job's role, and
  // what it does while that agent is not set up is `withoutOwnAgent()`'s.
  const qualifierApp = { id: cfg.config.appId, version: cfg.config.appVersion };
  const roleAgent = goal ? null : roleAgentFor(agent);
  const roleApp = roleAgent ? cfg.config.roleApps[roleAgent] ?? null : null;
  if (roleAgent && !roleApp && withoutOwnAgent(agent) === "not_placed") {
    return { ok: false, code: "NOT_SWITCHED_ON", message: `The ${AGENT_JOB_LABEL[agentJobFor(agent)]} agent isn't set up yet.` };
  }
  // A tenant with a goal agent of its own (`SARVAM_GOAL_APP_BY_ORG`) has
  // every behaviour rule in that agent's prompt, so its call carries the
  // facts alone and none of the rule text below.
  const tenantGoal = goal ? cfg.config.goalAppsByOrg?.get(orgId) ?? null : null;
  const ownApp = goal ? tenantGoal ?? cfg.config.goalApp : roleApp ?? qualifierApp;
  if (!ownApp) return { ok: false, code: "NOT_SWITCHED_ON", message: "Calls with a goal are not switched on yet." };
  // The voice the client picked for this agent on this project, which is a
  // copy of the agent on Sarvam (`voice-apps-rules.ts`).
  const voice = await voiceForCall(orgId, node.id, agent).catch(() => null);
  const app = voiceApp(cfg.config.voiceApps, ownApp, voice);
  const role = roleApp ? await roleContext({ orgId, agent, lead, visitId: opts.visitId ?? null, nowIso: now }) : null;
  if (roleApp && !role) return { ok: false, code: "GONE", message: "There is no visit for this call to be about." };

  // What the agent may say about the tower: its signed facts, read now, so
  // a price changed this morning is the price on this call.
  const about = await factsFor(orgId, node, found.developer, wantOf({
    facts: lead.facts as { config?: string; budget?: string } | null,
    heard: lead.qualification,
    city: node.kind === "PHASE" ? node.grand_name : node.parent_name,
  }), opts.alsoPitch);
  if (opts.testFacts && process.env.NODE_ENV !== "production" && !process.env.VERCEL) about.facts = opts.testFacts(about.facts);
  // How the agent says the tower's words: the developer's spellings and
  // the region's, the ones its facts use (`pronounce.ts`).
  const sayWords = sayWordsOn()
    ? await import("./pronounce.ts").then((m) => m.wordsForCall({
        orgId, nodePath: node.path, city: node.kind === "PHASE" ? node.grand_name : node.parent_name, facts: about.facts,
        names: [(opts.callName?.trim() || lead.name).split(/\s+/)[0] ?? "", found.developer],
      }))
    : "";
  if (goal) {
    const problem = goalProblem(goal.text, about.neverSay);
    if (problem) return { ok: false, code: "INVALID", message: problem };
  }

  // A call past the enquiry's seven days is promotion, and a number on the
  // DND register takes none without consent registered with the operator.
  // Asked after every gate that costs nothing, because it may look it up.
  const dnd = await dndGate({ orgId, phone: lead.phone, leadId, enquiredAt: !askedEnquiry ? NEVER_ENQUIRED : lead.enquired_at.toISOString(), nowIso: now });
  if (!dnd.ok) return { ok: false, code: "DND", message: dnd.message };

  // Minutes are the cost and channels are the speed, and both are the
  // project's, pooled across its agents. Refused before anything is dialled.
  // A project on a plan takes both from the plan, and its minutes from the
  // allowance and then the top-ups; the agent's job must be on the plan.
  const plan = await callAllowance({ orgId, nodeId: node.id, agent, nowIso: now });
  if (plan.billed && !plan.ok) {
    return { ok: false, code: plan.code === "NOT_IN_PLAN" ? "NOT_IN_PLAN" : plan.code === "NO_PLAN" ? "NO_PLAN" : "ALLOWANCE", message: plan.message };
  }
  const channelLimit = plan.billed && plan.ok ? plan.channels : policy.channelLimit;
  // A channel partner's lines are the whole organisation's, so its calls at
  // once are counted across every project, not once per project.
  const wideLines = plan.billed && plan.ok && plan.wide;
  const linesAre = wideLines ? "on your plan" : "for this project";
  const scopePath = node.project_path;
  const liveSince = new Date(Date.parse(now) - LIVE_CALL_MINUTES * 60_000);
  const month = new Date(monthStart(now));
  const load = await withTenant(orgId, async (sql) => {
    const inProject = scopePath ? sql`n.path <@ ${scopePath}::ltree` : sql`c.scope_node_id = ${node.id}`;
    const [r] = await sql<{ used: number; live: number }[]>`
      SELECT
        ceil(coalesce(sum(ceil(c.duration_s / 60.0)
                          + ceil(coalesce(c.handoff_bill_s, 0) / 60.0) * ${HANDOFF_MINUTE_WEIGHT})
                      FILTER (WHERE c.placed_at >= ${month} AND ${inProject}), 0))::int AS used,
        count(*) FILTER (WHERE c.status IN ('PLACING', 'DIALLING') AND c.placed_at > ${liveSince}
                           AND ${wideLines ? sql`true` : inProject})::int AS live
      FROM calls c JOIN scope_nodes n ON n.id = c.scope_node_id
      WHERE c.org_id = ${orgId}
        AND ${wideLines ? sql`true` : inProject}
        AND c.placed_at >= ${month < liveSince ? month : liveSince}`;
    return r ?? { used: 0, live: 0 };
  });
  if (!plan.billed && !limitsLifted() && load.used >= policy.minuteAllowance) {
    return {
      ok: false,
      code: "ALLOWANCE",
      message: `This project has used its ${policy.minuteAllowance.toLocaleString("en-IN")} AI call minutes for the month.`,
    };
  }
  if (load.live >= channelLimit) {
    return {
      ok: false,
      code: "BUSY",
      message: `All ${channelLimit} calling lines ${linesAre} are busy. Try again in a minute.`,
    };
  }

  // The id is made here so the agent can be handed the call's own token.
  const callId = randomUUID();
  const token = callToken(webhookSecret(), orgId, callId);

  // Nobody to hand the buyer to: every agent is told, in its facts, never to
  // offer the sales manager and to say they will call back instead.
  const { salesReady } = await import("./handoff.ts");
  const ready = await salesReady(orgId, node.id, lead.phone).catch(() => false);

  const variables = callVariables({
    leadName: opts.callName?.trim() || lead.name,
    developer: found.developer,
    project: enquired.parent_name ?? enquired.name,
    tower: enquired.parent_name ? enquired.name : null,
    city: enquired.grand_name,
    source: lead.source,
    notice: callNotice({ developer: found.developer, project: enquired.parent_name ?? enquired.name, place: about.opening?.place, policy }),
    hook: { orgId, callId, token },
    goal: goal ? { text: goal.text.trim(), today: longDay(istDate(now)) } : null,
    role,
    about: { place: about.place, facts: tenantGoal ? about.facts.replace(FACTS_RULE, "").trimEnd() : `${withSalesNote(about.facts, ready)}
${FAMILY_RULE}
${HUMAN_RULE}
${callerRule({ project: enquired.parent_name ?? enquired.name, place: about.opening?.place, price: about.opening?.price })}
${CLOSING_RULE}
${SCREENER_RULE}` },
    ...(sayWordsOn() ? { sayWords } : {}),
    enquiry: enquiryFromForm(lead.form_answers ?? []),
    opening: about.opening,
    enquired: askedEnquiry,
  });

  // What the agent knows before it dials: every call to this buyer so far,
  // who took it and how it ended, what they already told us, where the lead
  // stands, and why this call (a call back they asked for opens by saying
  // so). Read now, so the call after a call knows what that call heard.
  if (callMemoryOn(agent)) {
    Object.assign(variables, await memoryFor(orgId, lead, opts.taskId ?? null, now));
  }

  // The Brain versions the facts came from are kept on the call, so what the
  // agent was told is answerable after the price changes.
  // `placed_at` is the same clock every rule here reads it against (the
  // allowance, the lines in use, "rung in the last day", closing a silent
  // call), not the database's own. Mixed, a run on an injected clock rang a
  // lead twice in a day whenever the two were more than a day apart.
  // Only the qualifier and its voice copies declare the opening's place and
  // price; any other agent refuses a call carrying a variable it does not
  // declare (Sarvam 422, 19 October 2026).
  if (ownApp.id !== qualifierApp.id) {
    delete variables.opening_place;
    delete variables.opening_price;
  }
  const { salesdesk_key: _key, ...stored } = variables;
  // Kept on the row only, never sent: an agent refuses a variable it does not declare.
  stored.sales_ready = ready ? "yes" : "no";
  // A tenant's own goal agent declares it, and reads it for the hand-off.
  if (tenantGoal) variables.sales_ready = stored.sales_ready;
  // Until the agents read the tower's facts, they are not sent, and the call
  // records no Brain versions, because the agent was told none.
  const told = projectFactsOn();
  if (!told) {
    delete variables.call_project;
    delete variables.project_facts;
    delete stored.call_project;
    delete stored.project_facts;
  }
  // The line is taken in the same transaction as the row that holds it,
  // under a lock per project: two workers counting the lines at once both
  // saw one free and both dialled. The count above refuses early and cheaply;
  // this one is the one that decides.
  const lineKey = wideLines ? `calls:${orgId}` : `calls:${orgId}:${scopePath ?? node.id}`;
  const took = await withTenant(orgId, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lineKey}, 0))`;
    const [busy] = await sql<{ live: number }[]>`
      SELECT count(*)::int AS live
      FROM calls c JOIN scope_nodes n ON n.id = c.scope_node_id
      WHERE c.org_id = ${orgId} AND c.status IN ('PLACING', 'DIALLING') AND c.placed_at > ${liveSince}
        AND ${wideLines ? sql`true` : scopePath ? sql`n.path <@ ${scopePath}::ltree` : sql`c.scope_node_id = ${node.id}`}`;
    if ((busy?.live ?? 0) >= channelLimit) return false;
    await sql`
      INSERT INTO calls (id, org_id, lead_id, scope_node_id, agent, app_id, app_version, from_number, to_number,
                         variables, brain_sources, placed_by, task_id, attempt, placed_at, goal, goal_text)
      VALUES (${callId}, ${orgId}, ${lead.id}, ${node.id}, ${agent}, ${app.id}, ${app.version},
              ${line.from}, ${lead.phone}, ${sql.json(stored)}, ${sql.json(told ? about.sources : [])}, ${userId},
              ${opts.taskId ?? null}, ${Math.min(20, Math.max(1, opts.attempt ?? 1))}, ${now},
              ${goal?.key ?? null}, ${goal ? goal.text.trim() : null})`;
    await sql`UPDATE leads SET last_activity_at = now() WHERE org_id = ${orgId} AND id = ${lead.id}`;
    return true;
  });
  if (!took) {
    return {
      ok: false,
      code: "BUSY",
      message: `All ${channelLimit} calling lines ${linesAre} are busy. Try again in a minute.`,
    };
  }

  try {
    const { attemptId } = await sarvam().placeOutbound(dialConfig, {
      toNumber: lead.phone,
      variables,
      // The name the agent will say is the one the language is guessed
      // from: a call to "Aditya Sakpal" on a lead saved as "ADI" opened in
      // Hindi, because "ADI" says nothing (21 October 2026).
      language: openingLanguage(lead.language, opts.callName?.trim() || lead.name,
        regionalLanguagesOn() ? found.stateCode ?? stateOfCity(node.kind === "PHASE" ? node.grand_name : node.parent_name) : null),
      webhookUrl: `${base}/api/calls/webhook?o=${orgId}&c=${callId}&t=${token}`,
      metadata: { call_id: callId },
      ...(app.id !== qualifierApp.id || app.version !== qualifierApp.version ? { app } : {}),
    });
    await withTenant(orgId, (sql) => sql`
      UPDATE calls SET status = 'DIALLING', attempt_id = ${attemptId}
      WHERE org_id = ${orgId} AND id = ${callId}`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await withTenant(orgId, (sql) => sql`
      UPDATE calls SET status = 'REFUSED', failure_reason = ${reason.slice(0, 500)}, ended_at = now()
      WHERE org_id = ${orgId} AND id = ${callId}`);
    await audit({ orgId, actorUserId: userId, action: "call.refused", targetType: "call", targetId: callId, metadata: { basis: verdict.basis, agent, ...(goal ? { goal: goal.key } : {}) } });
    return { ok: false, code: "REFUSED", message: `The call could not be placed. ${reason}` };
  }

  // The goal's words stay on the call row; the audit row records only which kind it was.
  await audit({ orgId, actorUserId: userId, action: "call.placed", targetType: "call", targetId: callId, metadata: { basis: verdict.basis, lead: lead.id, agent, unit: "call_minute", ...(goal ? { goal: goal.key } : {}) } });
  return { ok: true, callId, leadName: lead.name };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Sunday 4 Oct, 3:00 pm", a visit as the buyer would hear it. */
function visitWords(at: Date): string {
  const t = ist(at.toISOString());
  const d = new Date(`${t.date}T00:00:00Z`);
  const h = t.hour % 12 || 12;
  return `${WEEKDAYS[t.dow]} ${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}, ` +
    `${h}:${String(t.minute).padStart(2, "0")} ${t.hour < 12 ? "am" : "pm"}`;
}

/**
 * The call's memory (`callMemory()`): the buyer's calls so far, ours and a
 * person's own, newest first; the lead's stage and what it already holds; a
 * visit still on; and why this call is placed, read off the task that placed
 * it. A call back names the call that asked for it, whose closing words say
 * how long the buyer asked us to wait.
 */
export async function memoryFor(
  orgId: string,
  lead: { id: string; stage: string; facts: Facts | null; phone?: string | null },
  taskId: string | null,
  now: string,
  inbound = false,
): Promise<{ call_context: string; call_history: string }> {
  const read = await withTenant(orgId, async (sql) => {
    // Every call to this buyer, whichever of their enquiries it was about:
    // one buyer across several projects is asked the same questions once.
    const calls = await sql<{
      placed_at: Date; agent: AgentKind; person: string | null; connectivity: string | null; outcome: Outcome | null;
      duration_s: string | null; summary: string | null; goal_note: string | null; goal_text: string | null; handed: boolean;
      other: boolean; about: string | null;
    }[]>`
      SELECT c.placed_at, c.agent, u.name AS person, c.connectivity, c.outcome, c.duration_s,
             c.final_variables->>'call_summary' AS summary, c.final_variables->>'goal_note' AS goal_note,
             c.goal_text, (c.handoff_state = 'CONNECTED' OR c.outcome = 'HANDED_OFF') AS handed,
             c.lead_id <> ${lead.id} AS other,
             (SELECT p.name FROM scope_nodes n JOIN scope_nodes p ON p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
               WHERE n.id = c.scope_node_id LIMIT 1) AS about
      FROM calls c LEFT JOIN users u ON u.id = c.placed_by
      WHERE c.org_id = ${orgId} AND c.status = 'DONE'
        AND (c.lead_id = ${lead.id} OR (${lead.phone ?? null}::text IS NOT NULL AND c.lead_id IN (
              SELECT l.id FROM leads l WHERE l.org_id = ${orgId} AND l.phone = ${lead.phone ?? null} AND l.erased_at IS NULL)))
      ORDER BY c.placed_at DESC LIMIT 10`;
    const own = await sql<{ placed_at: Date; person: string | null; status: string; bill_s: number | null }[]>`
      SELECT p.placed_at, u.name AS person, p.status, p.bill_s
      FROM proxy_calls p LEFT JOIN users u ON u.id = p.caller_id
      WHERE p.org_id = ${orgId} AND p.lead_id = ${lead.id} AND p.kind = 'PERSON' AND p.status IN ('ENDED', 'FAILED')
      ORDER BY p.placed_at DESC LIMIT 5`;
    const [visit] = await sql<{ scheduled_at: Date }[]>`
      SELECT scheduled_at FROM site_visits
      WHERE org_id = ${orgId} AND lead_id = ${lead.id} AND status = 'CONFIRMED' AND scheduled_at > ${new Date(now)}
      ORDER BY scheduled_at LIMIT 1`;
    const [task] = taskId
      ? await sql<{ purpose: string; dedupe_key: string; detail: Record<string, unknown>; visit_at: Date | null }[]>`
          SELECT t.purpose, t.dedupe_key, t.detail, v.scheduled_at AS visit_at
          FROM lead_tasks t LEFT JOIN site_visits v ON v.id = t.visit_id
          WHERE t.org_id = ${orgId} AND t.id = ${taskId}`
      : [];
    // The call that asked for a call back is named in the task's key.
    const askedBy = task?.purpose === "CALLBACK" ? task.dedupe_key.split(":").at(-1) ?? null : null;
    const [asking] = askedBy && isUuid(askedBy)
      ? await sql<{ placed_at: Date; transcript: unknown; final_variables: Record<string, unknown> | null; connectivity: string | null; hung_up_by: string | null }[]>`
          SELECT placed_at, transcript, final_variables, connectivity, hung_up_by FROM calls WHERE org_id = ${orgId} AND id = ${askedBy}`
      : [];
    // What the buyer said they must have, from the calls' merged reading,
    // and what their other enquiries already hold, newest first.
    const [wanted] = await sql<{ wants: string | null }[]>`
      SELECT qualification->'wants'->>'value' AS wants FROM leads WHERE org_id = ${orgId} AND id = ${lead.id}`;
    const others = lead.phone
      ? await sql<{ facts: Facts | null; wants: string | null }[]>`
          SELECT facts, qualification->'wants'->>'value' AS wants FROM leads
          WHERE org_id = ${orgId} AND phone = ${lead.phone} AND id <> ${lead.id} AND erased_at IS NULL
          ORDER BY last_activity_at DESC LIMIT 5`
      : [];
    // What the call list's sheet said about this person, whole: the agent
    // used to hear only the one-line goal read from it.
    const [sheet] = await sql<{ note: string | null }[]>`
      SELECT note FROM call_list_rows
      WHERE org_id = ${orgId} AND lead_id = ${lead.id} AND note IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`;
    return { calls, own, visit, task, asking, wants: wanted?.wants ?? others.find((o) => o.wants)?.wants ?? null, others, sheet: sheet?.note ?? null };
  });

  const first = (n: string | null) => n?.trim().split(/\s+/)[0] ?? null;
  const prior: PriorCall[] = [
    ...read.calls.map((c) => ({
      at: c.placed_at.toISOString(),
      agent: c.agent,
      person: first(c.person),
      answered: c.connectivity === "connected" && !["NO_ANSWER", "HUNG_UP"].includes(c.outcome ?? ""),
      seconds: c.duration_s === null ? null : Number(c.duration_s),
      outcome: c.outcome,
      note: c.goal_note || c.summary,
      goal: c.goal_text,
      handedTo: c.handed ? "the sales team" : null,
      about: c.other ? c.about : null,
    })),
    ...read.own.map((p) => ({
      at: p.placed_at.toISOString(),
      agent: null,
      person: first(p.person),
      answered: p.status === "ENDED" && (p.bill_s ?? 0) > 0,
      seconds: p.bill_s,
      outcome: null,
      note: null,
      goal: null,
      handedTo: null,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  let reason: CallReason = { kind: "other" };
  if (inbound) {
    // The buyer rang us: our newest call to them says whether this is a
    // call back after one they missed.
    const last = prior[0];
    reason = { kind: "rang_us", last: last ? { at: last.at, answered: last.answered } : null };
  } else if (read.task?.purpose === "CALLBACK" && read.asking && read.task.detail?.handoffMissed === true) {
    reason = { kind: "handoff_missed", at: read.asking.placed_at.toISOString() };
  } else if (read.task?.purpose === "CALLBACK" && read.asking && read.task.detail?.dropped === true) {
    // The call went dead mid-conversation: the agent's last line, which
    // nobody answered, is where this one picks up.
    const turns = Array.isArray(read.asking.transcript) ? (read.asking.transcript as { role?: string; en?: string; indic?: string }[]) : [];
    const last = [...turns].reverse().find((t) => t.role === "agent");
    // "The call got cut" only when the carrier says the network ended it; a
    // buyer who hung up is never told the line dropped (28 October 2026).
    reason = { kind: "dropped", at: read.asking.placed_at.toISOString(), asked: last?.en ?? last?.indic ?? null, proven: read.asking.hung_up_by === "NETWORK" };
  } else if (read.task?.purpose === "CALLBACK" && read.asking && read.asking.connectivity === "connected") {
    // Only a call the buyer spoke on can have asked for a call back: a retry
    // of a call that never got through opens as a fresh call.
    // Only the buyer's own words, or a person's note, prove a call back was
    // asked for; the agent's summary is a note and never "as you asked".
    const turns = Array.isArray(read.asking.transcript) ? (read.asking.transcript as { role?: string; en?: string; indic?: string }[]) : [];
    const said = turns.filter((t) => t.role === "user").map((t) => [t.en, t.indic].filter(Boolean).join(" ")).reverse();
    if (typeof read.task.detail?.said === "string") said.unshift(read.task.detail.said.slice(0, 200));
    reason = { kind: "callback", askedAt: read.asking.placed_at.toISOString(), said, proven: said.some((s) => asksCallback(s)) };
  } else if (read.task?.purpose === "VISIT_FOLLOWUP_CALL" && read.task.visit_at) {
    const day = typeof read.task.detail?.day === "number" ? read.task.detail.day : null;
    reason = { kind: "after_visit", visitAt: read.task.visit_at.toISOString(), day };
  } else if (read.task?.purpose === "RETRY_CALL") {
    reason = { kind: "retry", missed: prior.filter((c) => !c.answered).length };
  } else if (read.task?.purpose === "FIRST_CALL") {
    reason = { kind: "first" };
  }

  return callMemory({
    nowIso: now,
    calls: prior,
    stage: lead.stage as StageKey,
    // This enquiry's own facts first, then what the buyer told us about another.
    facts: buyerFacts(lead.facts, read.others.map((o) => o.facts)),
    visit: read.visit ? visitWords(read.visit.scheduled_at) : null,
    wants: read.wants,
    sheet: read.sheet,
    reason,
  });
}

/** The towers a person may call about, "Sath Heights · Tower C", for a call's "about" choice. */
export async function towersToCall(orgId: string, scopes: string[]): Promise<{ id: string; label: string }[]> {
  if (!scopes.length) return [];
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; label: string }[]>`
    SELECT n.id, coalesce(p.name || ' · ', '') || n.name AS label
    FROM scope_nodes n LEFT JOIN scope_nodes p ON p.id = n.parent_id
    WHERE n.org_id = ${orgId} AND n.kind = 'PHASE' AND n.path <@ ANY(${scopes}::ltree[])
    ORDER BY n.path LIMIT 200`);
  return rows;
}

/**
 * The tower a call is about, as the agent says it, and its signed facts:
 * the published Brain (inherited from the project), the approved
 * configurations with their starting prices, and the site's address.
 */
export async function factsFor(
  orgId: string,
  node: NodeInfo,
  developer: string,
  /** What the buyer wants, for the other projects a call may offer. */
  want: Want | null = null,
  /** Towers a person chose to offer beside this one: they replace the ones the buyer's wants would pick. */
  pitch: readonly string[] = [],
): Promise<{ place: string; facts: string; neverSay: string[]; sources: { versionId: string; path: string; version: number }[]; opening: { place: string; price: string } }> {
  const [{ approvedUnits }, { locationAt }, { priceFor }, { asList }] = await Promise.all([
    import("./unit.ts"),
    import("./visits.ts"),
    import("./unit-rules.ts"),
    import("./brain-rules.ts"),
  ]);
  const [brain, units, site, others, pictured, elsewhere, tieUps] = await Promise.all([
    resolveBrain(orgId, node.id),
    node.kind === "PHASE" ? approvedUnits(orgId, node.id) : Promise.resolve({ units: [], basePsf: null }),
    locationAt(orgId, node.id),
    otherTowers(orgId, node, pitch),
    amenitiesPictured(orgId, node.id),
    pitch.length ? pitchedProjects(orgId, node, pitch) : otherProjects(orgId, node, want),
    // The developer's bank tie-ups (Home loans, Banks) win over the Brain's line.
    import("./banks.ts").then(({ tieUpsAt }) => tieUpsAt(orgId, node.id, new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }))).catch(() => [] as string[]),
  ]);
  const v = brain?.values ?? {};
  const money = (raw: string | null | undefined) => {
    const n = Number(String(raw ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const project = node.kind === "PHASE" ? node.parent_name ?? node.name : node.name;
  const tower = node.kind === "PHASE" && node.parent_name ? node.name : null;
  const neverSay = asList(v["claims.never_say"]);
  const homes = units.units
    .map((u) => ({ label: u.label, carpetSqft: u.carpetAreaSqft, price: priceFor(u, units.basePsf) }))
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  return {
    place: tower ? `${project} ${tower}` : project,
    facts: projectFacts({
      developer,
      project,
      tower,
      city: node.kind === "PHASE" ? node.grand_name : node.parent_name,
      location: v["claims.location"] ?? null,
      siteAddress: site?.address ?? null,
      units: homes,
      bookingAmount: money(v["price.booking_amount"]),
      paymentPlan: v["price.payment_plan"] ?? null,
      possession: v["claims.possession_date"] ?? null,
      registrationNo: node.kind === "PHASE" ? v["rera.registration_no"] ?? null : null,
      points: asList(v["claims.talking_points"]),
      amenities: [...asList(v["claims.amenities"]), ...pictured],
      otherTowers: others,
      otherProjects: elsewhere,
      loanBanks: tieUps.length ? tieUps : asList(v["price.loan_banks"]),
      loanRate: money(v["price.loan_rate"]),
      neverSay,
    }),
    neverSay,
    sources: brain?.sources ?? [],
    opening: openingFacts({
      location: v["claims.location"] ?? null,
      city: node.kind === "PHASE" ? node.grand_name : node.parent_name,
      cheapest: homes.find((h) => h.price && h.price > 0)?.price ?? null,
    }),
  };
}

/**
 * The amenities the approved library pictures: the titles of AMENITY assets
 * whose current bytes a brand approver approved, at this node or above it.
 * An approved render of the gym is already what every ad from this project
 * may show, so a call may confirm the gym it shows. Nothing unapproved, and
 * nothing a model wrote.
 */
async function amenitiesPictured(orgId: string, nodeId: string): Promise<string[]> {
  const { approvedAssets } = await import("./asset.ts");
  const assets = await approvedAssets(orgId, nodeId).catch(() => []);
  return assets.filter((a) => a.category === "AMENITY").map((a) => (a.title ?? "").trim()).filter(Boolean);
}

/**
 * The project's other towers a call may name, each with its approved
 * configurations: a tower's siblings, or a project's towers. Only a tower
 * the RERA gate clears today, because naming its homes on a call advertises
 * it; one the gate refuses, or with nothing approved, is left out.
 */
async function otherTowers(orgId: string, node: NodeInfo, pitch: readonly string[] = []): Promise<{ name: string; units: { label: string; carpetSqft: number; price: number | null }[] }[]> {
  if (node.kind !== "PHASE" && node.kind !== "PROJECT") return [];
  const towers = await withTenant(orgId, (sql) => sql<{ id: string; name: string }[]>`
    SELECT t.id, t.name FROM scope_nodes t
    WHERE t.org_id = ${orgId} AND t.kind = 'PHASE' AND t.id <> ${node.id}
      AND t.parent_id = ${node.kind === "PROJECT" ? node.id : sql`(SELECT parent_id FROM scope_nodes WHERE org_id = ${orgId} AND id = ${node.id})`}
      ${pitch.length ? sql`AND t.id = ANY(${pitch as string[]}::uuid[])` : sql``}
    ORDER BY t.name LIMIT 12`);
  if (!towers.length) return [];
  const [{ approvedUnits }, { priceFor }] = await Promise.all([import("./unit.ts"), import("./unit-rules.ts")]);
  const read = await Promise.all(towers.map(async (t) => {
    const gate = await canPublish(orgId, t.id).catch(() => ({ ok: false }));
    if (!gate.ok) return null;
    const { units, basePsf } = await approvedUnits(orgId, t.id);
    const homes = units
      .map((u) => ({ label: u.label, carpetSqft: u.carpetAreaSqft, price: priceFor(u, basePsf) }))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    return homes.length ? { name: t.name, units: homes } : null;
  }));
  return read.filter((t): t is NonNullable<typeof t> => !!t);
}

/**
 * Other projects a call may name when this one does not suit the buyer,
 * only those that closely fit what the buyer wants (`project-match-rules.ts`):
 * in the same city, selling the size asked for, inside the budget, the
 * buyer's own area first, at most three. Each tower the RERA gate clears
 * today counts, with its cheapest approved home of each size and the
 * project's signed location. A mandate firm offers none: it sells one
 * developer's project on mandate.
 */
async function otherProjects(orgId: string, node: NodeInfo, want: Want | null): Promise<{ name: string; location: string | null; units: { label: string; carpetSqft: number; price: number | null }[] }[]> {
  if (node.kind !== "PHASE" && node.kind !== "PROJECT") return [];
  const { found, orgType } = await withTenant(orgId, async (sql) => {
    const [o] = await sql<{ type: string }[]>`SELECT type FROM orgs WHERE id = ${orgId}`;
    const rows = await sql<{ id: string; name: string; city: string | null; entity: string | null }[]>`
      SELECT p.id, p.name, r.name AS city, e.name AS entity FROM scope_nodes p
      LEFT JOIN scope_nodes r ON r.id = p.parent_id
      LEFT JOIN scope_nodes e ON e.id = r.parent_id
      WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT'
        AND p.id <> ${node.kind === "PROJECT" ? node.id : sql`(SELECT parent_id FROM scope_nodes WHERE org_id = ${orgId} AND id = ${node.id})`}
        AND NOT EXISTS (SELECT 1 FROM project_states ps WHERE ps.org_id = p.org_id AND ps.project_id = p.id AND ps.status = 'RETIRED')
      ORDER BY p.name LIMIT 60`;
    return { found: rows, orgType: o?.type ?? null };
  });
  if (!offersOtherProjects(orgType)) return [];
  // The buyer's city, else the city this call's project is in: nothing in another city is offered.
  const here = node.kind === "PHASE" ? node.grand_name : node.parent_name;
  const wanted: Want = { beds: want?.beds ?? [], budgetMax: want?.budgetMax ?? null, area: want?.area ?? null, city: want?.city ?? here ?? null };
  const fold = (x: string | null) => (x ?? "").trim().toLowerCase();
  const sameCity = found.filter((p) => !looksLikeTest(p.name) && !looksLikeTest(p.entity) && (!wanted.city || fold(p.city) === fold(wanted.city))).slice(0, 12);
  if (!sameCity.length) return [];
  const [{ approvedUnits }, { priceFor }, { complianceSummary }] = await Promise.all([import("./unit.ts"), import("./unit-rules.ts"), import("./publish-gate.ts")]);
  // The gate's verdict on every tower at once, not a summary per tower.
  const advertisable = new Set((await complianceSummary(orgId)).phases.filter((p) => p.ok).map((p) => p.phaseId));
  const candidates = await Promise.all(sameCity.map(async (p): Promise<Candidate | null> => {
    const [towers, brain] = await Promise.all([
      withTenant(orgId, (sql) => sql<{ id: string }[]>`
        SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PHASE' AND parent_id = ${p.id} ORDER BY name LIMIT 8`),
      resolveBrain(orgId, p.id).catch(() => null),
    ]);
    // Only a project whose facts were signed and published: a buyer is told
    // about it as plainly as about this one.
    if (!brain?.values || !Object.keys(brain.values).length) return null;
    const cheapest = new Map<string, Candidate["units"][number]>();
    for (const t of towers) {
      if (!advertisable.has(t.id)) continue;
      const { units, basePsf } = await approvedUnits(orgId, t.id);
      for (const u of units) {
        if (looksLikeTest(u.label)) continue;
        const home = { label: u.label, config: u.config, carpetSqft: u.carpetAreaSqft, price: priceFor(u, basePsf) };
        const had = cheapest.get(u.label);
        if (!had || (home.price ?? Infinity) < (had.price ?? Infinity)) cheapest.set(u.label, home);
      }
    }
    const units = [...cheapest.values()].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    return units.length ? { name: p.name, city: p.city, location: brain.values["claims.location"]?.trim() || null, units } : null;
  }));
  return pickProjectsFor(candidates.filter((c): c is Candidate => !!c), wanted).map((c) => ({
    name: c.name,
    location: c.location ?? c.city,
    units: c.units.map(({ label, carpetSqft, price }) => ({ label, carpetSqft, price })),
  }));
}

/**
 * The other projects a person chose to offer on a call (a call list's
 * towers outside this one's project): each with its signed location and the
 * cheapest approved home of each size in the chosen towers the RERA gate
 * clears today. Only a project with published facts. Never another city's
 * filter or the buyer's wants: the person chose them.
 */
async function pitchedProjects(orgId: string, node: NodeInfo, pitch: readonly string[]): Promise<{ name: string; location: string | null; units: { label: string; carpetSqft: number; price: number | null }[] }[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ tower: string; project_id: string; project: string }[]>`
    SELECT t.id AS tower, p.id AS project_id, p.name AS project
    FROM scope_nodes t JOIN scope_nodes p ON p.id = t.parent_id AND p.kind = 'PROJECT'
    WHERE t.org_id = ${orgId} AND t.kind = 'PHASE' AND t.id = ANY(${pitch as string[]}::uuid[])
      AND p.id <> COALESCE((SELECT parent_id FROM scope_nodes WHERE org_id = ${orgId} AND id = ${node.id}), ${node.id})`);
  if (!rows.length) return [];
  const [{ approvedUnits }, { priceFor }] = await Promise.all([import("./unit.ts"), import("./unit-rules.ts")]);
  const byProject = new Map<string, { name: string; towers: string[] }>();
  for (const r of rows) byProject.set(r.project_id, { name: r.project, towers: [...(byProject.get(r.project_id)?.towers ?? []), r.tower] });
  const out = await Promise.all([...byProject.values()].map(async (p) => {
    // Read at a chosen tower, which inherits the project's facts and adds its own.
    const brain = await resolveBrain(orgId, p.towers[0]).catch(() => null);
    if (!brain?.values || !Object.keys(brain.values).length) return null;
    const cheapest = new Map<string, { label: string; carpetSqft: number; price: number | null }>();
    for (const t of p.towers) {
      if (!(await canPublish(orgId, t).catch(() => ({ ok: false }))).ok) continue;
      const { units, basePsf } = await approvedUnits(orgId, t);
      for (const u of units) {
        if (looksLikeTest(u.label)) continue;
        const home = { label: u.label, carpetSqft: u.carpetAreaSqft, price: priceFor(u, basePsf) };
        const had = cheapest.get(u.label);
        if (!had || (home.price ?? Infinity) < (had.price ?? Infinity)) cheapest.set(u.label, home);
      }
    }
    const units = [...cheapest.values()].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    return units.length ? { name: p.name, location: brain.values["claims.location"]?.trim() || null, units } : null;
  }));
  return out.filter((p): p is NonNullable<typeof p> => !!p).slice(0, 5);
}

/**
 * What a job's own agent is told about this lead, read when the call is
 * placed. Null when the call has nothing to be about (a confirmation for a
 * visit that no longer exists), and the call is not placed.
 */
async function roleContext(o: {
  orgId: string;
  agent: AgentKind;
  lead: { id: string; stage: string; facts: Facts | null };
  visitId: string | null;
  nowIso: string;
}): Promise<RoleContext | null> {
  const today = longDay(istDate(o.nowIso));
  const facts = o.lead.facts ?? {};
  const known = { budget: facts.budget ?? null, config: facts.config ?? null };
  const role = roleAgentFor(o.agent);
  if (role === "reengager") {
    const [last] = await withTenant(o.orgId, (sql) => sql<{ placed_at: Date; summary: string | null }[]>`
      SELECT placed_at, final_variables->>'call_summary' AS summary FROM calls
      WHERE org_id = ${o.orgId} AND lead_id = ${o.lead.id} AND connectivity = 'connected'
      ORDER BY placed_at DESC LIMIT 1`);
    return {
      job: "reengage",
      reason: o.visitId ? "after_visit" : o.lead.stage === "nurture" ? "follow_up" : "warm",
      today,
      lastCallOn: last ? longDay(istDate(last.placed_at.toISOString())) : null,
      lastSummary: last?.summary ?? null,
      ...known,
    };
  }
  // A visit: the one the task names, or the lead's latest in the state the job is about.
  const states = o.agent === "post_visit" ? ["VISITED"] : o.agent === "recovery" ? ["NO_SHOW"] : ["CONFIRMED"];
  const [visit] = await withTenant(o.orgId, (sql) => sql<{ scheduled_at: Date; host: string | null }[]>`
    SELECT v.scheduled_at, u.name AS host FROM site_visits v LEFT JOIN users u ON u.id = v.host_id
    WHERE v.org_id = ${o.orgId} AND v.lead_id = ${o.lead.id} AND v.status = ANY(${states})
      AND ${o.visitId && isUuid(o.visitId) ? sql`v.id = ${o.visitId}` : sql`true`}
    ORDER BY v.scheduled_at DESC LIMIT 1`);
  if (!visit) return null;
  const at = visit.scheduled_at.toISOString();
  if (role === "post_visit") return { job: "post_visit", today, visitOn: longDay(istDate(at)), host: visit.host, ...known };
  return { job: "confirm", reason: o.agent === "recovery" ? "rebook" : "confirm", visitAt: visitMoment(at), today };
}

/**
 * A minute the buyer spends with a sales person after a hand-off counts as a
 * quarter of an AI minute against the project's allowance. It costs us Rs 0.90
 * (both Vobiz legs) against Rs 4.35 for an AI minute; counting it keeps every
 * plan's margin at or above the floor (doc/pricing.md).
 */
export const HANDOFF_MINUTE_WEIGHT = HANDOFF_WEIGHT;

/** A call that has said nothing for this long is treated as over. */
export const LIVE_CALL_MINUTES = 15;

// ---------------------------------------------------------------------------
// The sales team a buyer is handed to
// ---------------------------------------------------------------------------

export type SalesPerson = { id: string; name: string; phone: string; onDuty: boolean };

export async function listTeam(orgId: string): Promise<SalesPerson[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; name: string; phone: string; on_duty: boolean }[]>`
    SELECT id, name, phone, on_duty FROM sales_team WHERE org_id = ${orgId} ORDER BY created_at`);
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, onDuty: r.on_duty }));
}

type TeamResult = { ok: true } | { ok: false; message: string };

export async function addTeamMember(o: { orgId: string; userId: string; name: string; phone: string }): Promise<TeamResult> {
  const name = o.name.trim().slice(0, 120);
  const phone = normalisePhone(o.phone);
  if (!name) return { ok: false, message: "Enter their name." };
  if (!phone) return { ok: false, message: "That number does not look right. Use 10 digits, or add the country code." };
  const added = await withTenant(o.orgId, async (sql) => {
    const [root] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${o.orgId} AND kind = 'ORG' LIMIT 1`;
    if (!root) return false;
    const r = await sql`
      INSERT INTO sales_team (org_id, scope_node_id, name, phone, created_by)
      VALUES (${o.orgId}, ${root.id}, ${name}, ${phone}, ${o.userId})
      ON CONFLICT (org_id, scope_node_id, phone) DO NOTHING`;
    return r.count > 0;
  });
  if (!added) return { ok: false, message: "That number is already on the team." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "calling.team_added", targetType: "org", targetId: o.orgId, metadata: { phone: auditHash(phone) } });
  return { ok: true };
}

export async function setOnDuty(o: { orgId: string; userId: string; id: string; onDuty: boolean }): Promise<TeamResult> {
  if (!isUuid(o.id)) return { ok: false, message: "That person is not on the team." };
  const r = await withTenant(o.orgId, (sql) => sql`
    UPDATE sales_team SET on_duty = ${o.onDuty}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${o.id}`);
  if (!r.count) return { ok: false, message: "That person is not on the team." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "calling.team_duty", targetType: "org", targetId: o.orgId, metadata: { member: o.id, onDuty: o.onDuty } });
  return { ok: true };
}

export async function removeTeamMember(o: { orgId: string; userId: string; id: string }): Promise<TeamResult> {
  if (!isUuid(o.id)) return { ok: false, message: "That person is not on the team." };
  const r = await withTenant(o.orgId, (sql) => sql`DELETE FROM sales_team WHERE org_id = ${o.orgId} AND id = ${o.id}`);
  if (!r.count) return { ok: false, message: "That person is not on the team." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "calling.team_removed", targetType: "org", targetId: o.orgId, metadata: { member: o.id } });
  return { ok: true };
}

/** The first instant of this IST calendar month. */
export function monthStart(nowIso: string): string {
  const ist = new Date(Date.parse(nowIso) + 330 * 60_000).toISOString().slice(0, 7);
  return new Date(Date.parse(`${ist}-01T00:00:00Z`) - 330 * 60_000).toISOString();
}

/** Minutes each project has used this month, for the settings screen. */
export async function minutesUsed(orgId: string, nowIso = new Date().toISOString()): Promise<{ projectId: string; name: string; used: number }[]> {
  const month = new Date(monthStart(nowIso));
  const rows = await withTenant(orgId, (sql) => sql<{ project_id: string; name: string; used: number }[]>`
    SELECT p.id AS project_id, p.name,
           ceil(coalesce(sum(ceil(c.duration_s / 60.0)
                             + ceil(coalesce(c.handoff_bill_s, 0) / 60.0) * ${HANDOFF_MINUTE_WEIGHT}), 0))::int AS used
    FROM scope_nodes p
    LEFT JOIN scope_nodes n ON n.org_id = p.org_id AND n.path <@ p.path
    LEFT JOIN calls c ON c.scope_node_id = n.id AND c.placed_at >= ${month}
    WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT'
    GROUP BY p.id, p.name
    ORDER BY p.name`);
  return rows.map((r) => ({ projectId: r.project_id, name: r.name, used: r.used }));
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

/**
 * What Sarvam posts when the call ends. Idempotent: a redelivery overwrites
 * the same row with the same values. An opt-out the agent heard is written
 * to the suppression list here, in the same transaction as the call.
 */
export async function ingestWebhook(orgId: string, callId: string, body: unknown): Promise<boolean> {
  const attempt = typeof (body as { attempt_id?: unknown })?.attempt_id === "string"
    ? (body as { attempt_id: string }).attempt_id
    : null;
  const stored = await withTenant(orgId, async (sql) => {
    const [row] = await sql<{ id: string; lead_id: string; to_number: string; from_number: string; placed_at: Date; attempt_id: string | null; handoff_state: string | null; agent: AgentKind }[]>`
      SELECT id, lead_id, to_number, from_number, placed_at, attempt_id, handoff_state, agent FROM calls WHERE org_id = ${orgId} AND id = ${callId}`;
    if (!row) return null;
    // A payload naming a different attempt is somebody else's call.
    if (row.attempt_id && attempt && row.attempt_id !== attempt) return null;
    // Read as the job the call was placed for: a visit confirmation says what
    // happened to the visit before anything else. A "failed" Sarvam gives no
    // cause for is asked of the carrier, which usually says the phone rang
    // unanswered or was declined: the buyer's, not ours.
    let r = readWebhook(body, row.agent);
    // The carrier's own record: what a call that did not connect ran into,
    // and who ended one that did. "The call got cut" is said to a buyer only
    // when this names the network.
    let hungUp: { by: "BUYER" | "AGENT" | "NETWORK" | null; cause: string | null } = { by: null, cause: null };
    if (!r.failureReason && (r.connectivity === "busy" || r.connectivity === "no_answer" || isSystemFailure(r.connectivity, r.failureReason))) {
      const said = await carrierSays(row.from_number, row.to_number, row.placed_at.toISOString());
      if (said) r = readWebhook({ ...(body as Record<string, unknown>), status: said.connectivity, failure_reason: said.reason }, row.agent);
    } else if (r.connectivity === "connected") {
      const rec = await carrierRecord(row.from_number, row.to_number, row.placed_at.toISOString());
      if (rec) hungUp = { by: hungUpBy(rec.source, "OUT"), cause: rec.cause?.slice(0, 80) ?? null };
    }
    // Sales Desk put the buyer through itself, so it knows better than the
    // agent's reading of its own transcript. A ring nobody answered corrects
    // this to a call-back when its result arrives.
    const handedOver = ["REQUESTED", "RINGING", "CONNECTED", "ENDED"].includes(row.handoff_state ?? "");
    const outcome = handedOver && r.outcome !== "OPTED_OUT" && r.connectivity === "connected" ? "HANDED_OFF" : r.outcome;
    await sql`
      UPDATE calls SET
        status = 'DONE',
        attempt_id = COALESCE(attempt_id, ${attempt}),
        connectivity = ${r.connectivity},
        outcome = ${outcome},
        duration_s = ${r.durationS},
        interaction_id = ${r.interactionId},
        failure_reason = ${r.failureReason},
        system_failure = ${isSystemFailure(r.connectivity, r.failureReason)},
        hung_up_by = ${hungUp.by},
        hangup_cause = ${hungUp.cause},
        final_variables = ${r.finalVariables ? sql.json(r.finalVariables as never) : null},
        transcript = ${sql.json(r.transcript as never)},
        payload = ${sql.json(body as never)},
        ended_at = now()
      WHERE org_id = ${orgId} AND id = ${callId}`;
    if (r.optedOut) {
      await sql`
        INSERT INTO call_suppressions (org_id, phone, reason, call_id)
        VALUES (${orgId}, ${row.to_number}, 'SAID_ON_CALL', ${callId})
        ON CONFLICT (org_id, phone) DO NOTHING`;
    }
    // A refusal whose cause names the register is remembered, so the number
    // is not dialled again past its enquiry's seven days. Once per call.
    const [seen] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM dnd_checks WHERE org_id = ${orgId} AND call_id = ${callId}`;
    const dnd = r.connectivity !== "connected" && !seen?.n && (dndCause(r.failureReason) || dndCause(hangupCause(body)));
    return { phone: row.to_number, leadId: row.lead_id, dnd };
  });
  if (stored?.dnd) {
    await recordDnd({ orgId, phone: stored.phone, status: "DND", source: "OPERATOR", leadId: stored.leadId, callId });
  }
  // The minutes, once their length is known. Idempotent, so a redelivery counts once.
  if (stored) await meterCall(orgId, callId);
  return !!stored;
}

/**
 * What the carrier recorded for one of our calls, when Vobiz holds it and its
 * cause is the buyer's phone. Asked twice, three seconds apart, because the
 * carrier's record can land just after Sarvam's result. Never throws.
 */
async function carrierSays(from: string, to: string, placedIso: string): Promise<ReturnType<typeof carrierOutcome>> {
  const rec = await carrierRecord(from, to, placedIso);
  return rec ? carrierOutcome(rec.cause, rec.ringSeconds) : null;
}

/** The carrier's record of one of our calls, asked twice three seconds apart. Never throws. */
async function carrierRecord(from: string, to: string, placedIso: string): Promise<CarrierCall | null> {
  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.recentCalls) return null;
  for (let i = 0; i < 2; i++) {
    try {
      const rec = carrierRecordOf(await driver.recentCalls(cfg, 60), { from, to, placedIso });
      if (rec) return rec;
    } catch {
      return null;
    }
    if (i === 0) await new Promise((res) => setTimeout(res, 3_000));
  }
  return null;
}

/** A hang-up cause Sarvam passes on from the carrier, where it names one. */
function hangupCause(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const k of ["hangup_cause", "hangupCause", "call_end_reason"]) if (typeof b[k] === "string") return b[k] as string;
  return null;
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

type CallRow = {
  id: string;
  attempt_id: string | null;
  lead_id: string;
  lead_name: string;
  to_number: string;
  from_number: string;
  place: string;
  agent: AgentKind;
  attempt: number;
  app_version: number;
  status: string;
  connectivity: string | null;
  outcome: string | null;
  duration_s: string | null;
  failure_reason: string | null;
  final_variables: Record<string, unknown> | null;
  transcript: Turn[] | null;
  language: Language;
  placed_at: Date;
  interaction_id: string | null;
  next_purpose: string | null;
  next_at: Date | null;
  visit_at: Date | null;
  goal_text: string | null;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Real calls, newest first, in the shape the call log draws, as one viewer
 * may see them: only towers under `scopes` (where they hold `lead:read`),
 * and every number, including any inside the transcript and the summary,
 * through their `lens`.
 */
export async function listCalls(
  orgId: string,
  view: { lens: Lens; scopes: readonly string[] },
  limit = 1000,
  leadId: string | null = null,
  /**
   * Leave each call's turns out: the call log lists a thousand calls and a
   * person opens a few, so the transcript is asked for when one is opened
   * (`callTranscript()`) rather than shipped with every row.
   */
  opts: { transcripts?: boolean } = {},
): Promise<CallRecord[]> {
  if (view.scopes.length === 0) return [];
  const withTurns = opts.transcripts ?? true;
  const rows = await withTenant(orgId, (sql) => sql<(CallRow & { path: string; path_stage: PathStage; temperature: "HOT" | "WARM" | "COLD" | null; visit_booked: boolean })[]>`
    SELECT c.id, c.attempt_id, c.lead_id, l.name AS lead_name, c.to_number, c.from_number,
           n.path::text AS path, l.path_stage,
           CASE WHEN p.name IS NULL THEN n.name ELSE p.name || ' · ' || n.name END AS place,
           c.agent, c.attempt, c.app_version, c.status, c.connectivity, c.outcome, c.duration_s::text,
           c.failure_reason, c.final_variables, ${withTurns ? sql`c.transcript` : sql`NULL::jsonb AS transcript`}, l.language, c.placed_at, c.interaction_id,
           nt.purpose AS next_purpose, nt.due_at AS next_at, v.scheduled_at AS visit_at, c.goal_text, c.temperature,
           EXISTS (SELECT 1 FROM site_visits sb WHERE sb.call_id = c.id) AS visit_booked
    FROM calls c
    JOIN leads l ON l.id = c.lead_id
    JOIN scope_nodes n ON n.id = c.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = n.parent_id
    -- What the engine does next about this lead, if this was its latest call.
    LEFT JOIN LATERAL (
      SELECT t.purpose, t.due_at FROM lead_tasks t
      WHERE t.lead_id = c.lead_id AND t.kind = 'CALL' AND t.state = 'DUE'
        AND NOT EXISTS (SELECT 1 FROM calls c2 WHERE c2.lead_id = c.lead_id AND c2.placed_at > c.placed_at)
      ORDER BY t.due_at LIMIT 1
    ) nt ON true
    LEFT JOIN LATERAL (
      SELECT s.scheduled_at FROM site_visits s
      WHERE s.call_id = c.id AND s.status = 'CONFIRMED' LIMIT 1
    ) v ON true
    WHERE c.org_id = ${orgId} AND ${leadId ? sql`c.lead_id = ${leadId}` : sql`true`}
      AND n.path <@ ${view.scopes as string[]}::ltree[]
    ORDER BY c.placed_at DESC
    LIMIT ${limit}`);

  const now = Date.now();
  const { lens } = view;
  return rows.map((r) => {
    const at: LeadAt = { path: r.path, stage: r.path_stage };
    const words = (s: string | null) => lens.text(s, at);
    const vars = r.final_variables;
    const open = r.status === "PLACING" || r.status === "DIALLING";
    // A call is live only while it could still be ringing. Past the window
    // the silent-call sweep would close, it is a call nobody reported on,
    // whether or not the sweep has run yet.
    const live = open && now - r.placed_at.getTime() < SILENT_CALL_MINUTES * 60_000;
    const connectivity = (r.connectivity ?? "failed") as CallRecord["connectivity"];
    const outcome = (
      live ? "CALLING" : open ? "NO_REPORT" : r.status === "REFUSED" ? "NOT_PLACED" : r.outcome ?? "FAILED"
    ) as Outcome;
    const next: NextStep =
      live
        ? { kind: "none" }
        : outcome === "OPTED_OUT"
          ? { kind: "never" }
          : r.visit_at
            ? { kind: "visit", at: r.visit_at.toISOString() }
            : r.next_at && r.next_purpose === "RETRY_CALL"
              ? { kind: "retry", at: r.next_at.toISOString(), done: false }
              : r.next_at && ["CALLBACK", "REENGAGE_CALL", "CONFIRM_CALL", "POST_VISIT_CALL", "VISIT_FOLLOWUP_CALL"].includes(r.next_purpose ?? "")
                ? { kind: "callback", at: r.next_at.toISOString(), done: false }
                : outcome === "HANDED_OFF"
                  ? { kind: "sales", who: "the sales team" }
                  : { kind: "none" };
    const summary = str(vars?.call_summary) ?? (r.status === "REFUSED" ? r.failure_reason : null);
    return {
      id: r.attempt_id ?? r.id,
      leadId: r.lead_id,
      leadName: r.lead_name,
      phone: lens.phone(r.to_number, at),
      place: r.place,
      agent: r.agent,
      agentVersion: r.app_version,
      from: r.from_number,
      startedAt: r.placed_at.toISOString(),
      connectivity,
      duration: r.duration_s === null ? null : Number(r.duration_s),
      attempt: r.attempt,
      maxAttempts: r.agent === "qualifier" ? 3 : 1,
      language: r.language,
      outcome,
      next,
      recordingUrl: r.interaction_id ? `/api/calls/${r.id}/recording` : null,
      summary: words(summary),
      keyPoints: [],
      facts: (vars ? factsFromVariables(vars) : []).map((f) => ({ ...f, value: words(f.value) })),
      transcript: (r.transcript ?? []).map((t) =>
        t.role === "event" ? { ...t, en: words(t.en) ?? "" } : { ...t, en: words(t.en) ?? "", indic: words(t.indic) },
      ),
      // Our score's verdict once the call was read; the agent's only before.
      temp: r.temperature ?? tempOf(vars),
      visitBooked: r.visit_booked,
      live,
      goal: r.goal_text ? goalResult(r.goal_text, vars) : null,
      ...(withTurns ? {} : { transcriptLater: true as const }),
    } satisfies CallRecord;
  });
}

/**
 * One call's turns, for the call log when a person opens it: read inside the
 * viewer's own scope and through the same lens, so a buyer's number spoken
 * in a turn is masked exactly as the list would have masked it.
 */
export async function callTranscript(
  orgId: string,
  view: { lens: Lens; scopes: readonly string[] },
  callId: string,
): Promise<Turn[] | null> {
  if (view.scopes.length === 0 || !callId || callId.length > 80) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{ transcript: Turn[] | null; path: string; path_stage: PathStage }[]>`
    SELECT c.transcript, n.path::text AS path, l.path_stage
    FROM calls c
    JOIN leads l ON l.id = c.lead_id
    JOIN scope_nodes n ON n.id = c.scope_node_id
    WHERE c.org_id = ${orgId}
      AND (c.attempt_id = ${callId} OR c.id::text = ${callId})
      AND n.path <@ ${view.scopes as string[]}::ltree[]
    LIMIT 1`);
  if (!r) return null;
  const at: LeadAt = { path: r.path, stage: r.path_stage };
  const words = (s: string | null) => view.lens.text(s, at);
  return (r.transcript ?? []).map((t) =>
    t.role === "event" ? { ...t, en: words(t.en) ?? "" } : { ...t, en: words(t.en) ?? "", indic: words(t.indic) },
  );
}

/**
 * Calls Sarvam never reported back on. A webhook can be lost, and a lead
 * whose call never "ended" would never be followed up, so after a while the
 * call is closed as not connected and the cadence carries on. A result that
 * arrives later still lands: the webhook overwrites the row.
 */
/** How long a placed call may go unreported before it is treated as silent. */
export const SILENT_CALL_MINUTES = 30;

export async function closeSilentCalls(orgId: string, now = new Date()): Promise<string[]> {
  const before = new Date(now.getTime() - SILENT_CALL_MINUTES * 60_000);
  const rows = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    UPDATE calls SET status = 'DONE', connectivity = 'failed', outcome = 'FAILED',
                     failure_reason = ${SILENT_CALL_REASON}, system_failure = true, ended_at = now()
    WHERE org_id = ${orgId} AND status IN ('PLACING', 'DIALLING') AND placed_at < ${before}
    RETURNING id`);
  return rows.map((r) => r.id);
}

/**
 * Calls whose result never came, asked of Sarvam's own log. The webhook is the
 * way a result arrives; a tunnel that is down (any development machine whose
 * ngrok has stopped) or a delivery Sarvam gave up on left five real calls
 * "Calling now" for thirteen hours, and counted them as five dialled and none
 * picked up. A finished call found here is fed through `ingestWebhook()` as if
 * it had arrived, so the call log, the lead and the engine read it the same
 * way. Returns the calls it settled; the caller runs what they start.
 *
 * Only calls placed more than two minutes ago and less than three days ago
 * are asked about, per agent, in one window. A call Sarvam has not finished
 * is left for the next pass, and one it never reports on is closed by
 * `closeSilentCalls()` as before.
 */
export async function reconcileCalls(orgId: string, now = new Date()): Promise<string[]> {
  const cfg = sarvamConfig();
  const driver = sarvam();
  if (!cfg.ok || !driver.listAttempts) return [];
  const stuck = await withTenant(orgId, (sql) => sql<{ id: string; attempt_id: string; app_id: string; placed_at: Date }[]>`
    SELECT id, attempt_id, app_id, placed_at FROM calls
    WHERE org_id = ${orgId} AND status IN ('PLACING', 'DIALLING') AND (attempt_id IS NOT NULL OR direction = 'IN')
      AND placed_at < ${new Date(now.getTime() - 2 * 60_000)}
      AND placed_at > ${new Date(now.getTime() - 3 * 86_400_000)}
    ORDER BY placed_at
    LIMIT 50`);
  if (!stuck.length) return [];

  const settled: string[] = [];
  type Stuck = (typeof stuck)[number];
  const byApp = new Map<string, Stuck[]>();
  for (const c of stuck) byApp.set(c.app_id, [...(byApp.get(c.app_id) ?? []), c]);
  for (const [appId, calls] of byApp) {
    const from = new Date(Math.min(...calls.map((c) => c.placed_at.getTime())) - 10 * 60_000);
    let attempts: Awaited<ReturnType<NonNullable<typeof driver.listAttempts>>>;
    try {
      attempts = await driver.listAttempts(cfg.config, appId, from, now);
    } catch (e) {
      console.warn("calls: Sarvam's log could not be read,", (e as Error).message);
      continue;
    }
    for (const c of calls) {
      const a = attempts.find((x) => x.attemptId === c.attempt_id || x.variables.salesdesk_call === c.id);
      if (!a?.connectivity) continue;
      let transcript: { role: string; content: string }[] = [];
      if (a.interactionId && a.connectivity === "connected" && driver.getTranscript) {
        try {
          transcript = await driver.getTranscript(cfg.config, appId, a.interactionId);
        } catch {
          // The result stands without its words; the recording is still there.
        }
      }
      // The call's own key proves nothing once the call is over, and is not kept.
      const { salesdesk_key: _key, ...vars } = a.variables;
      const landed = await ingestWebhook(orgId, c.id, {
        attempt_id: c.attempt_id ?? a.attemptId,
        status: a.connectivity,
        duration: a.durationS,
        interaction_id: a.interactionId,
        failure_reason: a.failureReason,
        final_agent_variables: vars,
        interaction_transcript: transcript.map((t) => ({ role: t.role === "assistant" ? "agent" : "user", en_text: t.content })),
      });
      if (landed) settled.push(c.id);
    }
  }
  return settled;
}

export type CallAudio = { bytes: Uint8Array; type: string; placedAt: Date };

/**
 * Recordings fetched in the last few minutes, held in this process's memory
 * only. An audio element asks for the file, then again for a window of it on
 * every seek, and each ask used to go to Sarvam twice (the address, then the
 * file). Never written to disk or a cache anybody else reads: it is a
 * buyer's voice. Keyed by the tenant and the call, so one tenant's key can
 * never name another's recording.
 */
const RECORDING_TTL_MS = 10 * 60_000;
const RECORDING_CACHE_BYTES = 80 * 1024 * 1024;
const recordings = new Map<string, { audio: CallAudio; at: number }>();
const fetching = new Map<string, Promise<CallAudio | null>>();

function keepRecording(key: string, audio: CallAudio) {
  const now = Date.now();
  for (const [k, v] of recordings) if (now - v.at > RECORDING_TTL_MS) recordings.delete(k);
  recordings.set(key, { audio, at: now });
  let total = 0;
  for (const v of recordings.values()) total += v.audio.bytes.byteLength;
  // Oldest first: a Map iterates in insertion order.
  for (const [k, v] of recordings) {
    if (total <= RECORDING_CACHE_BYTES) break;
    recordings.delete(k);
    total -= v.audio.bytes.byteLength;
  }
}

/** The recording of one of this tenant's calls, fetched through Sarvam once. */
export async function callRecording(orgId: string, callId: string): Promise<CallAudio | null> {
  if (!isUuid(callId)) return null;
  const key = `${orgId}:${callId}`;
  const held = recordings.get(key);
  if (held && Date.now() - held.at <= RECORDING_TTL_MS) return held.audio;
  // Two asks at once (the first play and its range) share one fetch.
  const inFlight = fetching.get(key);
  if (inFlight) return inFlight;
  const job = (async () => {
    const row = await withTenant(orgId, async (sql) => {
      // Never an erased buyer's: their words are gone, and so is their voice.
      const [r] = await sql<{ interaction_id: string | null; app_id: string; placed_at: Date }[]>`
        SELECT c.interaction_id, c.app_id, c.placed_at FROM calls c JOIN leads l ON l.id = c.lead_id
        WHERE c.org_id = ${orgId} AND c.id = ${callId} AND l.erased_at IS NULL`;
      return r ?? null;
    });
    if (!row?.interaction_id) return null;
    const cfg = sarvamConfig();
    if (!cfg.ok) return null;
    // Asked twice: a dropped download or a 5xx is usually gone a second later.
    // A 404 (null) is an answer, and is not asked again.
    const read = async (): Promise<CallAudio | null> => {
      const res = await sarvam().getRecording(cfg.config, row.interaction_id!, row.app_id);
      if (!res) return null;
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        type: res.headers.get("content-type") ?? "audio/mpeg",
        placedAt: row.placed_at,
      };
    };
    const audio = await read().catch(() => read());
    if (!audio) return null;
    if (audio.bytes.byteLength) keepRecording(key, audio);
    return audio.bytes.byteLength ? audio : null;
  })().finally(() => fetching.delete(key));
  fetching.set(key, job);
  return job;
}
