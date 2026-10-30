import { audit, controlDb, withTenant } from "./db/index.ts";
import { meterCall } from "./billing.ts";
import { callToken } from "./calling-rules.ts";
import { ownHandoffNumber, webhookBase, webhookSecret } from "./calling.ts";
import type { Language } from "./call-rules.ts";
import { RECORDED } from "./handoff-audio.ts";
import type { AgentKind } from "./call-rules.ts";
import {
  AGENT_VOICE,
  CONNECT_LINE,
  HANGUP_XML,
  RING_MAX_DEFAULT,
  TALK_CAP_MINUTES,
  dialAnswered,
  dialXml,
  handoffAudio,
  longCallDue,
  readDialEvent,
  NO_SALES_REPLY,
  ringList,
  type HandoffReason,
  type Seller,
} from "./handoff-rules.ts";
import { findLiveCall, vobiz, vobizConfig } from "./vobiz.ts";

/**
 * Putting a ready buyer through to the sales team, over Vobiz.
 *
 * 1. The agent calls `connect_sales` (a Sarvam API tool) with this call's
 *    id and token, or the call runs past five minutes (`handOffLongCalls()`,
 *    the worker's `call:watch`); `requestHandoff()` finds the buyer's live
 *    Vobiz call and redirects it to `/api/calls/ring`.
 * 2. `ringXml()` rings every free person on the team at once.
 * 3. `ringEvent()` records who answered, and when they hung up, from Vobiz's
 *    real-time callbacks; `ringResult()` decides what a buyer nobody took
 *    hears, and flags the lead for a person.
 *
 * Every address carries the same HMAC the call's webhook does, checked by the
 * route before any of this runs.
 */

const HELD = ["REQUESTED", "RINGING", "CONNECTED"];

const query = (orgId: string, callId: string) =>
  `o=${orgId}&c=${callId}&t=${callToken(webhookSecret(), orgId, callId)}`;

export type HandoffResult = { ok: true } | { ok: false; message: string };

/** Put the buyer through: the agent asked, or the call ran long. Idempotent: a second ask changes nothing. */
export async function requestHandoff(orgId: string, callId: string, reason: HandoffReason = "ASKED"): Promise<HandoffResult> {
  const ready = await prepareHandoff(orgId, callId, reason);
  return ready.ok ? ready.transfer() : ready;
}

/**
 * Everything before the buyer's call is moved: the call, the switch, a free
 * person to ring, and the live Vobiz call. Nobody free refuses here, so the
 * agent hears the refusal and handles the buyer in its own voice rather than
 * the buyer ringing out into a recorded line. The move itself is `transfer`,
 * which the agent's route runs a few seconds later (`HANDOFF_SPEAK_MS`), so
 * the agent finishes saying it is connecting them before the line moves.
 */
export async function prepareHandoff(
  orgId: string,
  callId: string,
  reason: HandoffReason = "ASKED",
): Promise<{ ok: true; transfer: () => Promise<HandoffResult> } | { ok: false; message: string; noOne?: boolean }> {
  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ to_number: string; from_number: string; status: string; handoff_state: string | null; direction: string;
      scope_node_id: string; lead_id: string }[]>`
      SELECT to_number, from_number, status, handoff_state, direction, scope_node_id, lead_id FROM calls WHERE org_id = ${orgId} AND id = ${callId}`;
    return r ?? null;
  });
  if (!row) return { ok: false, message: "No such call." };
  if (HELD.includes(row.handoff_state ?? "")) return { ok: true, transfer: async () => ({ ok: true }) };

  const cfg = vobizConfig();
  const base = webhookBase();
  if (!cfg || !base) return { ok: false, message: "Putting buyers through is not switched on." };

  const fail = async (message: string): Promise<{ ok: false; message: string }> => {
    await withTenant(orgId, (sql) => sql`
      UPDATE calls SET handoff_state = 'FAILED', handoff_at = coalesce(handoff_at, now())
      WHERE org_id = ${orgId} AND id = ${callId}`);
    return { ok: false, message };
  };

  // Nobody to ring: the buyer stays with the agent, and a person is asked to
  // call them back. Asked first, before the live call is looked up, so the
  // agent hears it at once.
  if (!(await whoToRing(orgId, callId, row)).length) {
    await withTenant(orgId, (sql) => sql`
      UPDATE leads SET needs_person = 'Asked for the sales team on the call and nobody was free. Call now',
             last_activity_at = now()
      WHERE org_id = ${orgId} AND id = ${row.lead_id}`);
    const out = await fail(NO_SALES_REPLY);
    return { ...out, noOne: true };
  }

  let live;
  try {
    live = await findLiveCall(cfg, row.to_number, row.from_number, row.direction === "IN");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!live) return fail("The call is no longer live.");

  await withTenant(orgId, (sql) => sql`
    UPDATE calls SET handoff_state = 'REQUESTED', handoff_at = now(), vobiz_call_uuid = ${live.uuid},
           handoff_reason = ${reason}
    WHERE org_id = ${orgId} AND id = ${callId}`);
  const uuid = live.uuid;
  return {
    ok: true,
    async transfer() {
      try {
        await vobiz().transfer(cfg, uuid, `${base}/api/calls/ring?${query(orgId, callId)}`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      await audit({ orgId, actorUserId: null, action: "call.handoff_requested", targetType: "call", targetId: callId, metadata: { reason } });
      return { ok: true };
    },
  };
}

/** Each on-duty person, and whether they are already taking or being rung for a buyer. */
/** The sales team, each with whether they are free now. `callId` is the call asking, which never makes anybody busy. */
export async function sellers(orgId: string, callId: string): Promise<Seller[]> {
  const rows = await withTenant(orgId, (sql) => sql<
    { phone: string; on_duty: boolean; busy: boolean; last_took: Date | null }[]
  >`
    SELECT t.phone, bool_or(t.on_duty) AS on_duty,
      EXISTS (
        SELECT 1 FROM calls c
        WHERE c.org_id = t.org_id AND c.id <> ${callId}
          AND ((c.handoff_state = 'CONNECTED' AND c.handoff_to = t.phone
                AND c.handoff_at > now() - make_interval(mins => ${TALK_CAP_MINUTES}))
            OR (c.handoff_state IN ('REQUESTED', 'RINGING') AND t.phone = ANY(c.handoff_rang)
                AND c.handoff_at > now() - interval '2 minutes'))
      ) OR EXISTS (
        -- Rung for, or talking to, a hot buyer put straight through.
        SELECT 1 FROM proxy_calls x
        WHERE x.org_id = t.org_id AND x.kind = 'BRIDGE' AND x.to_number = t.phone
          AND x.status IN ('RINGING', 'CONNECTED') AND x.placed_at > now() - make_interval(mins => ${TALK_CAP_MINUTES})
      ) OR EXISTS (
        -- Talking to, or being rung for, a buyer who called the developer's own number.
        SELECT 1 FROM inbound_calls i
        WHERE i.org_id = t.org_id
          AND ((i.status = 'CONNECTED' AND i.answered_by = t.phone
                AND i.started_at > now() - make_interval(mins => ${TALK_CAP_MINUTES}))
            OR (i.status = 'RINGING' AND t.phone = ANY(i.rang) AND i.started_at > now() - interval '2 minutes'))
      ) AS busy,
      (SELECT max(c.handoff_at) FROM calls c WHERE c.org_id = t.org_id AND c.handoff_to = t.phone) AS last_took
    FROM sales_team t
    WHERE t.org_id = ${orgId}
    GROUP BY t.org_id, t.phone`);
  return rows.map((r) => ({ phone: r.phone, onDuty: r.on_duty, busy: r.busy, lastTookAt: r.last_took?.toISOString() ?? null }));
}

type RingRow = {
  lead_id: string; scope_node_id: string; from_number: string; to_number: string; language: Language;
  handoff_reason: HandoffReason | null; agent: AgentKind;
};

async function ringRow(orgId: string, callId: string): Promise<RingRow | null> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<RingRow[]>`
      SELECT c.lead_id, c.scope_node_id, c.from_number, c.to_number, l.language, c.handoff_reason, c.agent
      FROM calls c JOIN leads l ON l.id = c.lead_id
      WHERE c.org_id = ${orgId} AND c.id = ${callId}`;
    return r ?? null;
  });
}

/** A hand-off line in the call's agent's voice and the lead's language, or null for Vobiz's English voice. */
const lineAudio = (kind: "busy" | "connect", row: RingRow) => {
  const base = webhookBase();
  const file = handoffAudio(kind, row.language, AGENT_VOICE[row.agent] ?? "shubh", RECORDED);
  return base && file ? `${base}/calls/${file}` : null;
};

/**
 * Nobody could take the buyer: the agent rings them straight back to carry on
 * (a call back due now, `handoffMissed`, that opens by saying the sales
 * manager could not pick up), and the lead is flagged for a person. The
 * buyer's live line cannot be handed back to the agent once Vobiz moved it,
 * so the call back is the agent picking the conversation up again, in its
 * own voice, instead of a recorded line in another one.
 */
async function backToAgent(orgId: string, callId: string, leadId: string): Promise<void> {
  await nobodyTook(orgId, callId, leadId);
  const { schedule } = await import("./lead-engine.ts");
  await schedule(orgId, leadId, [{
    purpose: "CALLBACK",
    dueAt: new Date().toISOString(),
    key: `${leadId}:CALLBACK:handoff:${callId}`,
    detail: { handoffMissed: true },
  }]);
}

/** Ring the buyer back now: the call back `backToAgent()` scheduled. Run after the answer. */
export async function callBackNow(orgId: string): Promise<void> {
  const { runLeadTasks } = await import("./lead-engine.ts");
  await runLeadTasks({ orgId, max: 2, purposes: ["CALLBACK"] });
}

/** Nobody could take the buyer: say so on the call, and on the lead for a person. */
async function nobodyTook(orgId: string, callId: string, leadId: string): Promise<void> {
  await withTenant(orgId, async (sql) => {
    await sql`
      UPDATE calls SET handoff_state = 'NO_ANSWER',
             outcome = CASE WHEN outcome = 'HANDED_OFF' THEN 'CALLBACK' ELSE outcome END
      WHERE org_id = ${orgId} AND id = ${callId}`;
    await sql`
      UPDATE leads SET needs_person = 'Asked for the sales team on the call and nobody picked up. Call now',
             last_activity_at = now()
      WHERE org_id = ${orgId} AND id = ${leadId}`;
  });
  await audit({ orgId, actorUserId: null, action: "call.handoff_unanswered", targetType: "call", targetId: callId, metadata: {} });
}

/** Who would be rung for this call right now. Empty means nobody can take the buyer. */
async function whoToRing(orgId: string, callId: string, c: { scope_node_id: string; to_number: string }): Promise<string[]> {
  const [team, own] = await Promise.all([sellers(orgId, callId), ownHandoffNumber(orgId, c.scope_node_id)]);
  const max = Number(process.env.HANDOFF_RING_MAX) || RING_MAX_DEFAULT;
  // Never ring the buyer's own phone: a seller testing their own number, or
  // a sales person who is also a lead, would be rung while on this very call.
  // Only the organisation's own hand-off number stands in for its team, never
  // the environment's default, which would ring a stranger's phone for it.
  const others = team.filter((s) => s.phone !== c.to_number);
  const fallback = own === c.to_number ? null : own;
  return ringList(others, fallback, max);
}

/**
 * Whether a hand-off on a call from `caller` would ring anybody right now: a
 * free person on the sales team, or a hand-off number the organisation saved
 * itself (never the environment's default), neither of them the caller's own
 * phone. Asked when the call starts, so an agent with nobody to
 * put the buyer through to never offers to (24 October 2026: Harbour View's
 * receptionist offered the sales manager twice to a team of nobody).
 */
export async function salesReady(orgId: string, scopeNodeId: string | null, caller: string | null): Promise<boolean> {
  if (!vobizConfig() || !webhookBase()) return false;
  const [team, own] = await Promise.all([sellers(orgId, "00000000-0000-0000-0000-000000000000"), ownHandoffNumber(orgId, scopeNodeId)]);
  const others = team.filter((s) => s.phone !== caller);
  const fallback = own === caller ? null : own;
  return ringList(others, fallback, 1).length > 0;
}

/** The instructions Vobiz runs once the buyer's call is redirected. */
export async function ringXml(orgId: string, callId: string): Promise<string> {
  const row = await ringRow(orgId, callId);
  const base = webhookBase();
  if (!row || !base) return HANGUP_XML;
  const numbers = await whoToRing(orgId, callId, row);
  if (!numbers.length) {
    await backToAgent(orgId, callId, row.lead_id);
    return HANGUP_XML;
  }
  await withTenant(orgId, (sql) => sql`
    UPDATE calls SET handoff_state = 'RINGING', handoff_rang = ${numbers}
    WHERE org_id = ${orgId} AND id = ${callId}`);
  const q = query(orgId, callId);
  return dialXml({
    numbers,
    callerId: row.from_number,
    eventsUrl: `${base}/api/calls/ring/events?${q}`,
    resultUrl: `${base}/api/calls/ring/result?${q}`,
    // The agent tells a buyer it is connecting them; a long call's switch
    // comes from the clock, so the buyer is told here instead.
    play: row.handoff_reason === "LONG_CALL" ? lineAudio("connect", row) : null,
    say: row.handoff_reason === "LONG_CALL" ? CONNECT_LINE : null,
  });
}

/** Vobiz's real-time report on the ringing phones. */
export async function ringEvent(orgId: string, callId: string, params: Record<string, string>): Promise<void> {
  const e = readDialEvent(params);
  if (e.kind === "answered") {
    await withTenant(orgId, (sql) => sql`
      UPDATE calls SET handoff_state = 'CONNECTED', handoff_to = coalesce(${e.to}, handoff_to)
      WHERE org_id = ${orgId} AND id = ${callId} AND handoff_state IN ('REQUESTED', 'RINGING', 'CONNECTED')`);
  } else if (e.kind === "ended") {
    // Only the leg that took the buyer ends the conversation; a phone that
    // rang out or was busy reports a hang-up too.
    const ended = await withTenant(orgId, (sql) => sql`
      UPDATE calls SET handoff_state = 'ENDED', handoff_ended_at = now(), handoff_bill_s = ${e.billS}
      WHERE org_id = ${orgId} AND id = ${callId} AND handoff_state = 'CONNECTED'
        AND (${e.to}::text IS NULL OR handoff_to = ${e.to})`);
    // The minutes with a sales person, now that Vobiz has billed them.
    if (ended.count) await meterCall(orgId, callId);
  }
}

/**
 * Vobiz's final word on the ring: nothing more to do, or hand the buyer back
 * to the agent (`backToAgent()`). A buyer who hung up while it rang is not
 * rung back; a person is still asked to call.
 */
export async function ringResult(orgId: string, callId: string, params: Record<string, string>): Promise<string> {
  if (dialAnswered(params)) return HANGUP_XML;
  const row = await ringRow(orgId, callId);
  if (!row) return HANGUP_XML;
  if ((params.CallStatus ?? "").toLowerCase() === "completed") await nobodyTook(orgId, callId, row.lead_id);
  else await backToAgent(orgId, callId, row.lead_id);
  return HANGUP_XML;
}

export type WatchReport = { withAi: number; seenLive: number; handedOver: number; nobodyFree: number; failed: number };

/**
 * One look at every call still with the AI: note when it went live, and hand
 * over any that has run past `LONG_CALL_SECONDS` to whoever on the team is
 * free. A call with nobody free stays with the AI, and is looked at again on
 * the next pass: a good conversation cut to "nobody is available" is worse
 * than a long one. No paid call: Vobiz's live list is free to read.
 */
export async function handOffLongCalls(now = new Date()): Promise<WatchReport> {
  const report: WatchReport = { withAi: 0, seenLive: 0, handedOver: 0, nobodyFree: 0, failed: 0 };
  const cfg = vobizConfig();
  if (!cfg || !webhookBase()) return report;

  // Enumerating tenants is the platform job's control-plane act, as in the
  // lead worker. Every call is read inside its own tenant.
  const orgs = await controlDb<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED' ORDER BY created_at`;
  type Row = { id: string; scope_node_id: string; from_number: string; to_number: string; status: string;
    handoff_state: string | null; live_since: Date | null };
  const withAi: { orgId: string; call: Row }[] = [];
  for (const org of orgs) {
    const rows = await withTenant(org.id, (sql) => sql<Row[]>`
      SELECT id, scope_node_id, from_number, to_number, status, handoff_state, live_since FROM calls
      WHERE org_id = ${org.id} AND status = 'DIALLING' AND handoff_state IS NULL
        AND placed_at > ${new Date(now.getTime() - 30 * 60_000)}`);
    for (const call of rows) withAi.push({ orgId: org.id, call });
  }
  report.withAi = withAi.length;
  if (!withAi.length) return report;

  let live;
  try {
    live = await vobiz().liveCalls(cfg);
  } catch {
    report.failed += 1;
    return report;
  }

  for (const { orgId, call } of withAi) {
    const onLine = live.some((l) => l.status === "in-progress" && l.to === call.to_number
      && (l.from === call.from_number || l.from === null));
    if (!onLine) continue;
    report.seenLive += 1;
    let since = call.live_since?.toISOString() ?? null;
    if (!since) {
      since = now.toISOString();
      await withTenant(orgId, (sql) => sql`
        UPDATE calls SET live_since = ${now} WHERE org_id = ${orgId} AND id = ${call.id} AND live_since IS NULL`);
    }
    if (!longCallDue({ status: call.status, handoffState: call.handoff_state, liveSince: since, now: now.toISOString() })) continue;
    if (!(await whoToRing(orgId, call.id, call)).length) {
      report.nobodyFree += 1;
      continue;
    }
    const r = await requestHandoff(orgId, call.id, "LONG_CALL");
    if (r.ok) report.handedOver += 1;
    else report.failed += 1;
  }
  return report;
}
