import { audit, withTenant } from "./db/index.ts";
import { callAllowance, meterQuietly } from "./billing.ts";
import { COST_PAISE, HANDOFF_WEIGHT } from "./billing-rules.ts";
import { factsFor, memoryFor, ownHandoffNumber, policyAt, webhookBase, webhookSecret } from "./calling.ts";
import { FAMILY_RULE, HUMAN_RULE, callNotice, callToken, callVariables, portfolioFacts } from "./calling-rules.ts";
import type { Facts } from "./lead-rules.ts";
import { noteTeamRow, portfolioFor, waitForTower, waitingByAiCall } from "./waiting-callers.ts";
import { findLiveCall, vobiz, vobizConfig } from "./vobiz.ts";
import { canPublish } from "./publish-gate.ts";
import { callMemoryOn, sarvamConfig, sayWordsOn, projectFactsOn } from "./sarvam.ts";
import { randomUUID } from "node:crypto";
import { callingNumberOwner } from "./calling-numbers.ts";
import { salesReady, sellers } from "./handoff.ts";
import { HANGUP_XML, NO_SALES_REPLY, RING_MAX_DEFAULT, busyXml, dialAnswered, dialXml, readDialEvent, withSalesNote } from "./handoff-rules.ts";
import { proxyMinutes } from "./proxy-rules.ts";
import { phoneLead } from "./capture-rules.ts";
import { placeFor, recordEvent, upsertCaptured } from "./leads.ts";
import type { Language } from "./call-rules.ts";
import {
  MISSED_FLAG,
  callInLine,
  firstRing,
  inHours,
  inboundAddress,
  inboundCallToken,
  inboundCallValid,
  inboundNumberValid,
  inboundStartValid,
  answerMode,
  openingLine,
  openingLanguageNote,
  readStart,
  readInbound,
  teamRing,
} from "./inbound-call-rules.ts";

/**
 * A buyer ringing one of the developer's own numbers (`calling_numbers`,
 * 0072). Vobiz asks the number's answer address what to do; the address
 * proves itself by an HMAC of the number, the number names its tenant
 * through the one lookup across tenants (`callingNumberOwner()`), and
 * everything after runs inside that tenant.
 *
 * A known buyer is filed on their lead; a number nobody knows is captured
 * through the ordinary path (`upsertCaptured()`, channel PHONE), so the
 * ownership rules decide it like any enquiry. Then the lead's owner is rung,
 * and failing them the free sales team, over the hand-off's own ring group.
 * Nobody taking it is a missed call on the lead for a person to return.
 * The minutes with a person are metered as a hand-off minute.
 *
 * Relative imports: `check:calling` loads this from source.
 */

const NIL = "00000000-0000-0000-0000-000000000000";
const RETRY_WINDOW_MS = 2 * 60_000;

/** The answer address the operator pastes into Vobiz for a number, or null while calls are not set up. */
export function inboundAddressFor(number: string): string | null {
  const base = webhookBase();
  if (!base || !process.env.AUTH_SECRET) return null;
  return inboundAddress(base, webhookSecret(), number);
}

const callQuery = (orgId: string, id: string) => `o=${orgId}&i=${id}&t=${inboundCallToken(webhookSecret(), orgId, id)}`;

/** Whether a callback address really names this inbound call in this organisation. */
export function inboundIsGenuine(orgId: string | null, id: string | null, token: string | null): boolean {
  if (!orgId || !id) return false;
  return inboundCallValid(webhookSecret(), orgId, id, token);
}

const busyAudio = (language: Language | null) => {
  const base = webhookBase();
  return base && language ? `${base}/calls/busy-${language}.wav` : null;
};

type Known = { id: string; scope_node_id: string; language: Language; owner_phone: string | null };

/** The buyer's own lead at or under the number's place, open ones first. */
async function knownLead(orgId: string, caller: string, numberPath: string | null): Promise<Known | null> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<Known[]>`
      SELECT l.id, l.scope_node_id, l.language,
             CASE WHEN u.phone_verified_at IS NOT NULL AND u.erased_at IS NULL THEN u.phone END AS owner_phone
      FROM leads l
      JOIN scope_nodes n ON n.id = l.scope_node_id
      LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.org_id = ${orgId} AND l.phone = ${caller}
        AND ${numberPath ? sql`n.path <@ ${numberPath}::ltree` : sql`true`}
      ORDER BY (l.stage NOT IN ('lost', 'booked')) DESC, l.last_activity_at DESC
      LIMIT 1`;
    return r ?? null;
  });
}

/** `waiting`: no tower could be told, and the enquiry waits for one (`waiting-callers.ts`). */
type Captured = { lead: Known | null; created: boolean; junk: boolean; waiting: string | null };

/** A number nobody knows: the ordinary capture, with the ownership rules asked. */
async function capture(orgId: string, o: { caller: string; uuid: string; numberId: string; numberNode: string | null; nowIso: string; via: "AI" | "TEAM" }): Promise<Captured> {
  const lead = phoneLead({ from: o.caller, callUuid: o.uuid });
  if (!lead) return { lead: null, created: false, junk: false, waiting: null };
  const ev = await recordEvent({ orgId, source: "PHONE", externalId: lead.externalId, payload: { call: o.uuid, number: o.numberId } });
  const place = await placeFor({ orgId, lineage: {}, phaseId: null, accountNodeId: o.numberNode });
  const up = await upsertCaptured({ orgId, eventId: ev.id, lead, phaseId: place.phaseId, publishTargetId: null, nowIso: o.nowIso });
  if (!up.ok) {
    if (up.reason === "JUNK") return { lead: null, created: false, junk: true, waiting: null };
    if (up.reason === "DONE_ALREADY") {
      const [done] = await withTenant(orgId, (sql) => sql<{ lead_id: string | null }[]>`
        SELECT lead_id FROM lead_events WHERE org_id = ${orgId} AND id = ${ev.id}`);
      if (done?.lead_id) return { lead: await leadById(orgId, done.lead_id), created: false, junk: false, waiting: null };
    }
    // No tower could be told: the call is still answered, and the enquiry
    // waits, with the call, for the receptionist or a person to say which.
    if (up.reason === "NO_PLACE") {
      await waitForTower(orgId, ev.id, { call: o.uuid, number: o.numberId, phone: o.caller, via: o.via, place: o.numberNode });
      return { lead: null, created: false, junk: false, waiting: ev.id };
    }
    return { lead: null, created: false, junk: false, waiting: null };
  }
  return { lead: await leadById(orgId, up.leadId), created: up.created, junk: false, waiting: null };
}

async function leadById(orgId: string, id: string): Promise<Known | null> {
  const [r] = await withTenant(orgId, (sql) => sql<Known[]>`
    SELECT l.id, l.scope_node_id, l.language,
           CASE WHEN u.phone_verified_at IS NOT NULL AND u.erased_at IS NULL THEN u.phone END AS owner_phone
    FROM leads l LEFT JOIN users u ON u.id = l.owner_id
    WHERE l.org_id = ${orgId} AND l.id = ${id}`);
  return r ?? null;
}

/**
 * Vobiz asks the number's answer address what to do with a buyer ringing
 * it. Anything that does not prove itself, or names a number nobody holds,
 * is hung up on and changes nothing.
 */
export async function answerInbound(o: { number: string | null; token: string | null; params: Record<string, string>; nowIso?: string }): Promise<string> {
  const number = o.number ?? "";
  if (!inboundNumberValid(webhookSecret(), number, o.token)) return HANGUP_XML;
  const call = readInbound(o.params);
  if (!call) return HANGUP_XML;
  // The address names one number; a call to another is not this number's.
  if (call.to && call.to !== number) return HANGUP_XML;
  const base = webhookBase();
  if (!base) return HANGUP_XML;
  const owner = await callingNumberOwner(number);
  if (!owner) return HANGUP_XML;
  const { orgId, numberId } = owner;
  const now = o.nowIso ?? new Date().toISOString();
  const hours = inHours(now);

  // Vobiz asks again when an answer is slow: one row per call, and the same answer.
  const [seen] = await withTenant(orgId, (sql) => sql<{ id: string; status: string; rang: string[]; started_at: Date }[]>`
    SELECT id, status, rang, started_at FROM inbound_calls WHERE org_id = ${orgId} AND vobiz_call_uuid = ${call.uuid}`);
  if (seen) {
    if (seen.status === "RINGING" && seen.rang.length && Date.now() - seen.started_at.getTime() < RETRY_WINDOW_MS) {
      const q = callQuery(orgId, seen.id);
      return dialXml({ numbers: seen.rang, callerId: number, eventsUrl: `${base}/api/calls/inbound?${q}&ev=events`, resultUrl: `${base}/api/calls/inbound?${q}&ev=result` });
    }
    return HANGUP_XML;
  }

  const [placed] = await withTenant(orgId, (sql) => sql<{ node_id: string | null; path: string | null }[]>`
    SELECT n.id AS node_id, n.path::text AS path
    FROM calling_numbers c LEFT JOIN scope_nodes n ON n.id = c.scope_node_id AND c.active
    WHERE c.org_id = ${orgId} AND c.id = ${numberId}`);
  const numberNode = placed?.node_id ?? null;

  let lead: Known | null = null;
  let created = false;
  let junk = false;
  let waiting: string | null = null;
  if (call.from) {
    lead = await knownLead(orgId, call.from, placed?.path ?? null);
    if (!lead) ({ lead, created, junk, waiting } = await capture(orgId, { caller: call.from, uuid: call.uuid, numberId, numberNode, nowIso: now, via: "TEAM" }));
  }
  const node = lead?.scope_node_id ?? numberNode;

  // Decide who is rung, or why nobody is. Refused before anybody is dialled.
  let refusal: string | null = junk ? "The number is one the ownership rules turn away" : null;
  if (!refusal && node) {
    const plan = await callAllowance({ orgId, nodeId: node, agent: "qualifier", nowIso: now });
    if (plan.billed && !plan.ok) refusal = plan.message.slice(0, 200);
  }
  const [team, own] = await Promise.all([sellers(orgId, NIL), ownHandoffNumber(orgId, node)]);
  const max = Number(process.env.HANDOFF_RING_MAX) || RING_MAX_DEFAULT;
  const ring = refusal
    ? { stage: null, numbers: [] as string[] }
    : firstRing({ ownerPhone: lead?.owner_phone ?? null, team, fallback: own, inHours: hours, caller: call.from, max });
  const status = refusal ? "REFUSED" : ring.stage ? "RINGING" : "MISSED";

  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO inbound_calls (org_id, calling_number_id, from_number, lead_id, scope_node_id, vobiz_call_uuid, stage,
                                 status, in_hours, rang, note, started_at, ended_at)
      VALUES (${orgId}, ${numberId}, ${call.from}, ${lead?.id ?? null}, ${node}, ${call.uuid}, ${ring.stage},
              ${status}, ${hours}, ${ring.numbers}, ${refusal}, ${now}, ${status === "RINGING" ? null : now})
      ON CONFLICT (org_id, vobiz_call_uuid) DO NOTHING
      RETURNING id`;
    if (!r) return null;
    if (lead) {
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
        VALUES (${orgId}, ${lead.id}, 'CALL_IN', ${callInLine({ status, captured: created })},
                ${sql.json({ inbound_call: r.id, in_hours: hours } as never)})`;
      await sql`
        UPDATE leads SET last_activity_at = now(),
               needs_person = CASE WHEN ${status === "MISSED" || (status === "REFUSED" && !junk)} THEN ${MISSED_FLAG} ELSE needs_person END,
               updated_at = now()
        WHERE org_id = ${orgId} AND id = ${lead.id}`;
    }
    return r;
  });
  if (!row) return HANGUP_XML;
  // A caller nobody could file is filed later from this row's record.
  if (waiting) await noteTeamRow(orgId, waiting, row.id);

  await audit({
    orgId,
    actorUserId: null,
    action: "lead.call_in",
    targetType: lead ? "lead" : "inbound_call",
    targetId: lead?.id ?? row.id,
    metadata: { inbound_call: row.id, status, captured: created, in_hours: hours, unit: "handoff_minute" },
  });

  if (status !== "RINGING") return status === "MISSED" && hours ? busyXml(busyAudio(lead?.language ?? null)) : HANGUP_XML;
  const q = callQuery(orgId, row.id);
  return dialXml({ numbers: ring.numbers, callerId: number, eventsUrl: `${base}/api/calls/inbound?${q}&ev=events`, resultUrl: `${base}/api/calls/inbound?${q}&ev=result` });
}

type Row = { id: string; lead_id: string | null; scope_node_id: string | null; stage: "OWNER" | "TEAM" | null; status: string; in_hours: boolean; rang: string[]; from_number: string | null; number: string; started_at: Date; language: Language | null };

async function inboundRow(orgId: string, id: string): Promise<Row | null> {
  const [r] = await withTenant(orgId, (sql) => sql<Row[]>`
    SELECT x.id, x.lead_id, x.scope_node_id, x.stage, x.status, x.in_hours, x.rang, x.from_number, c.number, x.started_at, l.language
    FROM inbound_calls x JOIN calling_numbers c ON c.id = x.calling_number_id
    LEFT JOIN leads l ON l.id = x.lead_id
    WHERE x.org_id = ${orgId} AND x.id = ${id}`);
  return r ?? null;
}

/** Nobody took the buyer: a missed call on the lead, for a person to return. */
async function missed(orgId: string, r: Row): Promise<string> {
  await withTenant(orgId, async (sql) => {
    const done = await sql`
      UPDATE inbound_calls SET status = 'MISSED', ended_at = now()
      WHERE org_id = ${orgId} AND id = ${r.id} AND status = 'RINGING'`;
    if (done.count && r.lead_id) {
      await sql`
        UPDATE leads SET needs_person = ${MISSED_FLAG}, last_activity_at = now(), updated_at = now()
        WHERE org_id = ${orgId} AND id = ${r.lead_id}`;
    }
  });
  await audit({ orgId, actorUserId: null, action: "lead.call_in_missed", targetType: "inbound_call", targetId: r.id, metadata: { in_hours: r.in_hours } });
  return r.in_hours ? busyXml(busyAudio(r.language)) : HANGUP_XML;
}

/**
 * Vobiz's final word on a ring. Taken: nothing more. The owner not
 * answering: the free team, never the owner again. Nobody: a missed call.
 */
export async function inboundResult(orgId: string, id: string, params: Record<string, string>): Promise<string> {
  if (dialAnswered(params)) return HANGUP_XML;
  const r = await inboundRow(orgId, id);
  if (!r || r.status !== "RINGING") return HANGUP_XML;
  const base = webhookBase();
  if (r.stage === "OWNER" && base) {
    const [team, own] = await Promise.all([sellers(orgId, NIL), ownHandoffNumber(orgId, r.scope_node_id)]);
    const max = Number(process.env.HANDOFF_RING_MAX) || RING_MAX_DEFAULT;
    const next = teamRing({ team, fallback: own, inHours: r.in_hours, caller: r.from_number, max, skip: r.rang[0] ?? null });
    if (next.stage) {
      const moved = await withTenant(orgId, (sql) => sql`
        UPDATE inbound_calls SET stage = 'TEAM', rang = ${[...r.rang, ...next.numbers].slice(0, 10)}
        WHERE org_id = ${orgId} AND id = ${id} AND status = 'RINGING' AND stage = 'OWNER'`);
      if (moved.count) {
        const q = callQuery(orgId, id);
        return dialXml({ numbers: next.numbers, callerId: r.number, eventsUrl: `${base}/api/calls/inbound?${q}&ev=events`, resultUrl: `${base}/api/calls/inbound?${q}&ev=result` });
      }
    }
  }
  return missed(orgId, r);
}

/** Vobiz's real-time report on the rung phones: who took the buyer, and what the talk billed. */
export async function inboundEvent(orgId: string, id: string, params: Record<string, string>): Promise<void> {
  const e = readDialEvent(params);
  if (e.kind === "answered") {
    await withTenant(orgId, (sql) => sql`
      UPDATE inbound_calls SET status = 'CONNECTED', answered_by = coalesce(${e.to}, answered_by)
      WHERE org_id = ${orgId} AND id = ${id} AND status IN ('RINGING', 'CONNECTED')`);
    return;
  }
  if (e.kind !== "ended") return;
  // Only the leg that took the buyer ends the talk; a phone that lost the race reports a hang-up too.
  const [ended] = await withTenant(orgId, (sql) => sql<{ scope_node_id: string | null; started_at: Date }[]>`
    UPDATE inbound_calls SET status = 'ENDED', bill_s = ${e.billS}, ended_at = now()
    WHERE org_id = ${orgId} AND id = ${id} AND status = 'CONNECTED'
      AND (${e.to}::text IS NULL OR answered_by IS NULL OR answered_by = ${e.to})
    RETURNING scope_node_id, started_at`);
  if (!ended || e.billS <= 0) return;
  const { minutes, counted } = proxyMinutes(e.billS, HANDOFF_WEIGHT);
  await meterQuietly({
    orgId,
    nodeId: ended.scope_node_id,
    kind: "HANDOFF_MINUTE",
    qty: counted,
    costPaise: minutes * COST_PAISE.HANDOFF_MINUTE,
    billable: true,
    source: { kind: "call", id: `inbound:${id}` },
    atIso: ended.started_at.toISOString(),
  });
}


// ---------------------------------------------------------------------------
// The AI receptionist
// ---------------------------------------------------------------------------

export type ReceptionistStart = {
  /** The variables the receptionist reads, ours included. */
  variables: Record<string, string>;
  /** Our row for the call, when there is one to file it on. */
  callId: string | null;
};

const NO_TENANT_VARS: Record<string, string> = {
  answer_mode: "general",
  user_name: "",
  property_viewed: "",
  call_project: "",
  project_facts: "",
  caller_known: "no",
  sales_ready: "no",
};

/**
 * Sarvam asks at the start of every call to a number bound to the
 * receptionist: who is ringing, and what may the agent say. The number rung
 * names the tenant through the one lookup across tenants; the caller is
 * found on their lead or captured as a new one, by the ownership rules,
 * exactly as a call the team takes is. The call becomes a `calls` row,
 * inbound, so its result, its minutes, the reading of it and a hand-off to a
 * person all go the way an outbound call's do. Nothing is refused here that
 * would leave a buyer to silence: when the tower may not be advertised or
 * the minutes are used up, the agent is told to put them through to a person.
 */
export async function startReceptionist(o: { token: string | null; body: unknown; query: { n?: string | null }; nowIso?: string }): Promise<ReceptionistStart | null> {
  if (!inboundStartValid(webhookSecret(), o.token)) return null;
  // What Sarvam sends is not documented; its shape is logged, every digit hidden.
  if (process.env.RECEPTIONIST_LOG_START === "on") console.info("[receptionist start]", JSON.stringify({ body: o.body, query: o.query }).replace(/\d/g, "#"));
  const now = o.nowIso ?? new Date().toISOString();
  const req = readStart(o.body, o.query);
  const general = { variables: NO_TENANT_VARS, callId: null };
  if (!req.called) return general;
  const owner = await callingNumberOwner(req.called);
  if (!owner) return general;
  const { orgId, numberId } = owner;

  const [placed] = await withTenant(orgId, (sql) => sql<{ node_id: string | null; path: string | null; developer: string }[]>`
    SELECT n.id AS node_id, n.path::text AS path, o.display_name AS developer
    FROM calling_numbers c JOIN orgs o ON o.id = c.org_id
    LEFT JOIN scope_nodes n ON n.id = c.scope_node_id AND c.active
    WHERE c.org_id = ${orgId} AND c.id = ${numberId}`);
  const numberNode = placed?.node_id ?? null;
  const developer = placed?.developer ?? "";

  let lead: Known | null = null;
  let created = false;
  let junk = false;
  let waiting: string | null = null;
  if (req.caller) {
    lead = await knownLead(orgId, req.caller, placed?.path ?? null);
    if (!lead) ({ lead, created, junk, waiting } = await capture(orgId, { caller: req.caller, uuid: req.sid ?? `sarvam:${now}`, numberId, numberNode, nowIso: now, via: "AI" }));
  }
  // A number over several towers and a caller nobody knows: the receptionist
  // is told every tower it may speak about and asks which one.
  if (waiting && numberNode && placed?.path) return askWhichProject({ orgId, numberId, numberNode, path: placed.path, developer, called: req.called, caller: req.caller, eventId: waiting, nowIso: now });
  const nodeId = lead?.scope_node_id ?? numberNode;
  const [node] = nodeId
    ? await withTenant(orgId, (sql) => sql<{ id: string; kind: string; name: string; parent_name: string | null; grand_name: string | null; path: string }[]>`
        SELECT n.id, n.kind, n.name, p.name AS parent_name, g.name AS grand_name, n.path::text AS path
        FROM scope_nodes n LEFT JOIN scope_nodes p ON p.id = n.parent_id LEFT JOIN scope_nodes g ON g.id = p.parent_id
        WHERE n.org_id = ${orgId} AND n.id = ${nodeId}`)
    : [];

  // The same two refusals an outbound call asks, turned into a hand-off.
  const gate = node && node.kind === "PHASE" ? await canPublish(orgId, node.id) : { ok: !!node };
  const plan = node ? await callAllowance({ orgId, nodeId: node.id, agent: "receptionist", nowIso: now }) : { billed: false as const };
  const mode = answerMode({ tenant: true, advertisable: gate.ok && !junk, minutesLeft: !plan.billed || plan.ok });

  const policy = await policyAt(orgId, node?.id ?? null);
  const about = node && mode === "talk" && projectFactsOn() ? await factsFor(orgId, node, developer) : null;
  const sayWords = about && sayWordsOn()
    ? await import("./pronounce.ts").then((m) => m.wordsForCall({ orgId, nodePath: node!.path, city: node!.kind === "PHASE" ? node!.grand_name : node!.parent_name, facts: about.facts }))
    : "";
  const callId = lead && node ? randomUUID() : null;
  const project = node ? (node.kind === "PHASE" ? node.parent_name ?? node.name : node.name) : "";
  const tower = node?.kind === "PHASE" && node.parent_name ? node.name : null;
  const ready = await salesReady(orgId, node?.id ?? null, req.caller);
  const base = callVariables({
    leadName: created ? "" : lead ? await leadName(orgId, lead.id) : "",
    developer,
    project,
    tower,
    city: node?.kind === "PHASE" ? node.grand_name : node?.parent_name ?? null,
    source: "a call to our number",
    notice: callNotice({ developer, project: project || null, policy }),
    hook: { orgId, callId: callId ?? NIL, token: callId ? callToken(webhookSecret(), orgId, callId) : "" },
    about: { place: about ? about.place : tower ? `${project} ${tower}` : project, facts: about?.facts ? `${withSalesNote(about.facts, ready)}
${FAMILY_RULE}
${HUMAN_RULE}` : withSalesNote("", ready) },
    ...(sayWordsOn() ? { sayWords } : {}),
  });
  const variables: Record<string, string> = {
    ...base,
    answer_mode: mode,
    caller_known: lead && !created ? "yes" : "no",
    sales_ready: ready ? "yes" : "no",
  };
  // The receptionist declares no opening place or price (see placeCall()).
  delete variables.opening_place;
  delete variables.opening_price;
  // A buyer we already know is answered with every call before this one, so
  // a missed call they ring back about is picked up where it stood.
  // Its first line is written for the caller: a buyer who missed our call is
  // thanked for calling back and told what we rang about, before they speak.
  if (callMemoryOn("receptionist")) {
    let last: { answered: boolean; outcome: string | null } | null = null;
    let config: string | null = null;
    if (lead && !created) {
      const [l] = await withTenant(orgId, (sql) => sql<{ id: string; stage: string; facts: Facts | null; phone: string | null }[]>`
        SELECT id, stage, facts, phone FROM leads WHERE org_id = ${orgId} AND id = ${lead!.id}`);
      if (l) {
        Object.assign(variables, await memoryFor(orgId, l, null, now, true));
        config = l.facts?.config ?? null;
        const [c] = await withTenant(orgId, (sql) => sql<{ connectivity: string | null; outcome: string | null }[]>`
          SELECT c.connectivity, c.outcome FROM calls c
          WHERE c.org_id = ${orgId} AND c.status = 'DONE'
            AND (c.lead_id = ${l.id} OR (${l.phone}::text IS NOT NULL AND c.lead_id IN (
                  SELECT x.id FROM leads x WHERE x.org_id = ${orgId} AND x.phone = ${l.phone} AND x.erased_at IS NULL)))
          ORDER BY c.placed_at DESC LIMIT 1`);
        if (c) last = { answered: c.connectivity === "connected" && !["NO_ANSWER", "HUNG_UP"].includes(c.outcome ?? ""), outcome: c.outcome };
      }
    }
    variables.opening_line = openingLine({
      language: lead?.language ?? "hi",
      name: lead && !created ? variables.user_name ?? "" : "",
      developer,
      project,
      last,
      known: !!lead && !created,
      config,
    });
    const note = openingLanguageNote(lead?.language ?? "hi");
    if (note) variables.call_context = variables.call_context ? `${note}

${variables.call_context}` : note;
  }

  if (callId && lead && node) {
    const cfg = sarvamConfig();
    const app = cfg.ok ? cfg.config.receptionistApp ?? { id: cfg.config.appId, version: cfg.config.appVersion } : { id: "receptionist", version: 1 };
    const { salesdesk_key: _key, ...stored } = variables;
    await withTenant(orgId, async (sql) => {
      await sql`
        INSERT INTO calls (id, org_id, lead_id, scope_node_id, agent, direction, app_id, app_version, from_number, to_number,
                           variables, brain_sources, placed_by, attempt, placed_at, status)
        VALUES (${callId}, ${orgId}, ${lead!.id}, ${node.id}, 'receptionist', 'IN', ${app.id}, ${app.version}, ${req.called}, ${req.caller},
                ${sql.json(stored)}, ${sql.json(about ? about.sources : [])}, NULL, 1, ${now}, 'DIALLING')`;
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
        VALUES (${orgId}, ${lead!.id}, 'CALL_IN', ${created ? "Called our number for the first time. The AI answered" : "Called our number. The AI answered"},
                ${sql.json({ call: callId, mode } as never)})`;
      await sql`UPDATE leads SET last_activity_at = now(), updated_at = now() WHERE org_id = ${orgId} AND id = ${lead!.id}`;
    });
  }
  await audit({
    orgId,
    actorUserId: null,
    action: "lead.call_in",
    targetType: lead ? "lead" : "calling_number",
    targetId: lead?.id ?? numberId,
    metadata: { answered: "ai", mode, captured: created, call: callId, unit: "call_minute" },
  });
  return { variables, callId };
}

async function leadName(orgId: string, id: string): Promise<string> {
  const [r] = await withTenant(orgId, (sql) => sql<{ name: string | null }[]>`SELECT name FROM leads WHERE org_id = ${orgId} AND id = ${id}`);
  return r?.name ?? "";
}

/**
 * The receptionist on a number that covers several towers, for a caller it
 * cannot file: its facts are each tower the RERA gate clears under the
 * number's place, it asks which one, and the call gets an id of its own so
 * its end can file the caller (`settleWaitingReceptionist()`). With no tower
 * it may speak about, or no minutes left, it puts the caller through.
 */
async function askWhichProject(o: {
  orgId: string;
  numberId: string;
  numberNode: string;
  path: string;
  developer: string;
  called: string;
  caller: string | null;
  eventId: string;
  nowIso: string;
}): Promise<ReceptionistStart> {
  const [plan, portfolio] = await Promise.all([
    callAllowance({ orgId: o.orgId, nodeId: o.numberNode, agent: "receptionist", nowIso: o.nowIso }),
    portfolioFor(o.orgId, o.path),
  ]);
  const mode = answerMode({ tenant: true, advertisable: portfolio.towers.length > 0, minutesLeft: !plan.billed || plan.ok });
  const policy = await policyAt(o.orgId, o.numberNode);
  const facts = mode === "talk" && projectFactsOn() ? portfolioFacts({ seller: o.developer, towers: portfolio.towers, neverSay: portfolio.neverSay }) : "";
  const callId = randomUUID();
  const ready = await salesReady(o.orgId, o.numberNode, o.caller);
  const base = callVariables({
    leadName: "",
    developer: o.developer,
    project: "",
    tower: null,
    city: null,
    source: "a call to our number",
    notice: callNotice({ developer: o.developer, project: null, policy }),
    hook: { orgId: o.orgId, callId, token: callToken(webhookSecret(), o.orgId, callId) },
    about: { place: "", facts: facts ? `${withSalesNote(facts, ready)}
${FAMILY_RULE}
${HUMAN_RULE}` : withSalesNote("", ready) },
  });
  const variables: Record<string, string> = {
    ...base,
    answer_mode: mode,
    caller_known: "no",
    sales_ready: ready ? "yes" : "no",
  };
  // The receptionist declares no opening place or price (see placeCall()).
  delete variables.opening_place;
  delete variables.opening_price;
  const cfg = sarvamConfig();
  const app = cfg.ok ? cfg.config.receptionistApp ?? { id: cfg.config.appId, version: cfg.config.appVersion } : { id: "receptionist", version: 1 };
  const { salesdesk_key: _key, ...stored } = variables;
  await withTenant(o.orgId, (sql) => sql`
    UPDATE lead_events SET payload = payload || ${sql.json({
      aiCall: callId,
      app,
      variables: stored,
      towers: portfolio.towers.map((t) => ({ id: t.id, project: t.project, tower: t.tower })),
    } as never)}
    WHERE org_id = ${o.orgId} AND id = ${o.eventId}`);
  await audit({
    orgId: o.orgId,
    actorUserId: null,
    action: "lead.call_in",
    targetType: "calling_number",
    targetId: o.numberId,
    metadata: { answered: "ai", mode, captured: false, waiting: true, towers: portfolio.towers.length, call: callId, unit: "call_minute" },
  });
  return { variables, callId };
}

// ---------------------------------------------------------------------------
// A person for a caller the receptionist has not filed yet
// ---------------------------------------------------------------------------

export type WaitingHandoff = { ok: true; transfer: () => Promise<{ ok: true } | { ok: false; message: string }> } | { ok: false; message: string; noOne?: boolean };

/**
 * The receptionist's `connect_sales` for a caller it could not file at the
 * start, so the call has no lead and no `calls` row. The buyer's live line
 * goes onto the inbound rail, which needs no lead: a row in `inbound_calls`
 * rings the free team (`ev=ring`), and who answered, the minutes and a ring
 * nobody took go the way a call to the number does. The caller stays on
 * Callers to file, now showing the team's row. Null when the call is not a
 * waiting caller's, so the ordinary hand-off answers.
 */
export async function prepareWaitingHandoff(orgId: string, callId: string, nowIso = new Date().toISOString()): Promise<WaitingHandoff | null> {
  const w = await waitingByAiCall(orgId, callId);
  if (!w) return null;
  const p = w.payload;
  const heldId = p.inbound ?? null;
  if (heldId) {
    const [held] = await withTenant(orgId, (sql) => sql<{ status: string }[]>`
      SELECT status FROM inbound_calls WHERE org_id = ${orgId} AND id = ${heldId}`);
    if (held && (held.status === "RINGING" || held.status === "CONNECTED")) return { ok: true, transfer: async () => ({ ok: true }) };
  }
  const cfg = vobizConfig();
  const base = webhookBase();
  if (!cfg || !base) return { ok: false, message: "Putting buyers through is not switched on." };
  const [num] = await withTenant(orgId, (sql) => sql<{ number: string }[]>`
    SELECT number FROM calling_numbers WHERE org_id = ${orgId} AND id = ${p.number}`);
  if (!num) return { ok: false, message: "No such call." };

  let live;
  try {
    live = await findLiveCall(cfg, p.phone, num.number, true);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (!live) return { ok: false, message: "The call is no longer live." };

  const hours = inHours(nowIso);
  const [team, own] = await Promise.all([sellers(orgId, NIL), ownHandoffNumber(orgId, p.place)]);
  const max = Number(process.env.HANDOFF_RING_MAX) || RING_MAX_DEFAULT;
  const ring = teamRing({ team, fallback: own, inHours: hours, caller: p.phone, max, skip: null });
  if (!ring.stage) return { ok: false, noOne: true, message: NO_SALES_REPLY };

  const [row] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO inbound_calls (org_id, calling_number_id, from_number, lead_id, scope_node_id, vobiz_call_uuid, stage,
                               status, in_hours, rang, note, started_at)
    VALUES (${orgId}, ${p.number}, ${p.phone}, NULL, ${p.place}, ${live.uuid}, 'TEAM',
            'RINGING', ${hours}, ${ring.numbers}, 'Asked the AI for a person before saying which project', ${nowIso})
    ON CONFLICT (org_id, vobiz_call_uuid) DO NOTHING
    RETURNING id`);
  if (!row) return { ok: true, transfer: async () => ({ ok: true }) };
  await noteTeamRow(orgId, w.id, row.id);
  const uuid = live.uuid;
  return {
    ok: true,
    async transfer() {
      try {
        await vobiz().transfer(cfg, uuid, `${base}/api/calls/inbound?${callQuery(orgId, row.id)}&ev=ring`);
      } catch (e) {
        await withTenant(orgId, (sql) => sql`
          UPDATE inbound_calls SET status = 'MISSED', note = 'The line could not be moved to the team', ended_at = now()
          WHERE org_id = ${orgId} AND id = ${row.id} AND status = 'RINGING'`);
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      await audit({
        orgId,
        actorUserId: null,
        action: "lead.call_in",
        targetType: "inbound_call",
        targetId: row.id,
        metadata: { inbound_call: row.id, status: "RINGING", answered: "team_after_ai", in_hours: hours, unit: "handoff_minute" },
      });
      return { ok: true };
    },
  };
}

/** What Vobiz runs once a waiting caller's line is moved: ring the team chosen for it. */
export async function inboundRingXml(orgId: string, id: string): Promise<string> {
  const r = await inboundRow(orgId, id);
  const base = webhookBase();
  if (!r || !base || r.status !== "RINGING" || !r.rang.length) return HANGUP_XML;
  const q = callQuery(orgId, r.id);
  return dialXml({ numbers: r.rang, callerId: r.number, eventsUrl: `${base}/api/calls/inbound?${q}&ev=events`, resultUrl: `${base}/api/calls/inbound?${q}&ev=result` });
}
