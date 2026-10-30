import { audit, withTenant } from "./db/index.ts";
import type { Authz } from "./rbac-rules.ts";
import { canPublish } from "./publish-gate.ts";
import { partnerHold } from "./partners.ts";
import { dndGate, recordDnd } from "./dnd.ts";
import { dndCause } from "./dnd-rules.ts";
import { callAllowance, meterQuietly } from "./billing.ts";
import { COST_PAISE, HANDOFF_WEIGHT } from "./billing-rules.ts";
import { CALLING_HOURS, anyHourFor, gateCall } from "./calling-rules.ts";
import { LIVE_CALL_MINUTES, ownHandoffNumber, policyAt, webhookBase, webhookSecret } from "./calling.ts";
import { readDialEvent, ringList, HANGUP_XML } from "./handoff-rules.ts";
import { sellers } from "./handoff.ts";
import { ownPhone } from "./otp.ts";
import { vobiz, vobizConfig } from "./vobiz.ts";
import { callerLineFor, sharedProxyNumber } from "./calling-numbers.ts";
import { PROXY_TIME_LIMIT_S, bridgeAccepted, bridgeAnswerXml, proxyDialXml, proxyMinutes, proxyToken, proxyTokenValid, whisperText } from "./proxy-rules.ts";
import { limitsLifted } from "./plan-purchase-rules.ts";

/**
 * A call a person makes to a buyer through our number.
 *
 * Asked in the order an AI call is, because to the buyer it is the same
 * thing, a call from the developer: the key at the lead's tower, an opt-out,
 * the hours and consent, the RERA gate, a partner's hold on the buyer, the
 * DND register, and then the minutes and the lines, before anything is
 * dialled. The person's
 * own phone must be one a code has confirmed, or the call could ring anybody.
 */

export type ProxyOutcome =
  | { ok: true; proxyCallId: string }
  | { ok: false; code: "GONE" | "NOT_ALLOWED" | "NO_PHONE" | "SAME_PHONE" | "OFF" | "REFUSED" | "BUSY" | "ALLOWANCE" | "NO_NUMBER"; message: string };

/**
 * The number a call answered after it was placed rings the buyer from: the
 * one stored on the row when it was placed, or, for a row older than 0072,
 * the shared number it was placed from.
 */
const rowNumber = (stored: string | null): string | null => stored ?? sharedProxyNumber();

const query = (orgId: string, id: string) => `o=${orgId}&p=${id}&t=${proxyToken(webhookSecret(), orgId, id)}`;

/** Whether a callback address really names this call in this organisation. */
export function proxyIsGenuine(orgId: string | null, id: string | null, token: string | null): boolean {
  if (!orgId || !id || !token) return false;
  if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(id)) return false;
  return proxyTokenValid(webhookSecret(), orgId, id, token);
}

export async function placeProxyCall(opts: {
  orgId: string;
  userId: string;
  authz: Authz;
  leadId: string;
  nowIso?: string;
}): Promise<ProxyOutcome> {
  const { orgId, userId, authz, leadId } = opts;
  const now = opts.nowIso ?? new Date().toISOString();
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return { ok: false, code: "GONE", message: "That lead no longer exists." };

  const found = await withTenant(orgId, async (sql) => {
    const [lead] = await sql<{ id: string; phone: string; enquired_at: Date; scope_node_id: string; path: string; project_path: string | null }[]>`
      SELECT l.id, l.phone, l.enquired_at, l.scope_node_id, n.path::text AS path,
             (SELECT a.path::text FROM scope_nodes a
               WHERE a.org_id = ${orgId} AND a.kind = 'PROJECT' AND a.path @> n.path LIMIT 1) AS project_path
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    if (!lead) return null;
    const consents = await sql<{ channels: string[]; captured_at: Date; expires_at: Date | null }[]>`
      SELECT channels, captured_at, expires_at FROM lead_consents WHERE org_id = ${orgId} AND phone = ${lead.phone}`;
    const [opt] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM call_suppressions WHERE org_id = ${orgId} AND phone = ${lead.phone}`;
    return { lead, consents, optedOut: (opt?.n ?? 0) > 0 };
  });
  if (!found) return { ok: false, code: "GONE", message: "That lead no longer exists." };
  const { lead } = found;
  if (!authz.canAt("lead:call", lead.path)) {
    return { ok: false, code: "NOT_ALLOWED", message: "Your role cannot call buyers on this tower." };
  }

  const mine = await ownPhone(orgId, userId);
  if (!mine) return { ok: false, code: "NO_PHONE", message: "Add your phone first. We ring it, then connect the buyer." };
  if (mine === lead.phone) return { ok: false, code: "SAME_PHONE", message: "That is the buyer's own number." };

  const policy = await policyAt(orgId, lead.scope_node_id);
  const verdict = gateCall({
    policy,
    nowIso: now,
    enquiredAt: lead.enquired_at.toISOString(),
    consents: found.consents.map((c) => ({
      channels: c.channels,
      capturedAt: c.captured_at.toISOString(),
      expiresAt: c.expires_at?.toISOString() ?? null,
    })),
    optedOut: found.optedOut,
    anyHour: anyHourFor(lead.phone, true),
  });
  if (!verdict.ok) return { ok: false, code: "REFUSED", message: verdict.message };

  const gate = await canPublish(orgId, lead.scope_node_id);
  if (!gate.ok) return { ok: false, code: "REFUSED", message: gate.message };
  const hold = await partnerHold(orgId, leadId);
  if (hold.held) return { ok: false, code: "REFUSED", message: hold.message };
  const dnd = await dndGate({ orgId, phone: lead.phone, leadId, enquiredAt: lead.enquired_at.toISOString(), nowIso: now });
  if (!dnd.ok) return { ok: false, code: "REFUSED", message: dnd.message };

  const cfg = vobizConfig();
  const base = webhookBase();
  if (!cfg || !base) {
    return { ok: false, code: "OFF", message: "Calling through our number is not set up for your account yet." };
  }
  // The buyer sees the tenant's own number, never the shared one once it has one.
  const line = await callerLineFor(orgId, lead.scope_node_id, sharedProxyNumber());
  if (!line.ok) {
    return line.code === "OFF"
      ? { ok: false, code: "OFF", message: "Calling through our number is not set up for your account yet." }
      : { ok: false, code: "NO_NUMBER", message: line.message };
  }
  const from = line.from;

  // A person's call carries no agent's job, and every plan carries the
  // qualifier, so asking as the qualifier asks only about minutes and lines.
  const plan = await callAllowance({ orgId, nodeId: lead.scope_node_id, agent: "qualifier", nowIso: now });
  if (plan.billed && !plan.ok) return { ok: false, code: "ALLOWANCE", message: plan.message };
  const lines = plan.billed && plan.ok ? plan.channels : policy.channelLimit;
  // A channel partner's plan holds its lines for the whole organisation.
  const wideLines = plan.billed && plan.ok && plan.wide;

  // The project's lines are shared with its AI calls, and so are its minutes.
  const liveSince = new Date(Date.parse(now) - LIVE_CALL_MINUTES * 60_000);
  const month = new Date(`${new Date(Date.parse(now) + 19_800_000).toISOString().slice(0, 7)}-01T00:00:00+05:30`);
  const load = await withTenant(orgId, async (sql) => {
    const within = lead.project_path ? sql`n.path <@ ${lead.project_path}::ltree` : sql`n.id = ${lead.scope_node_id}`;
    const linesWithin = wideLines ? sql`true` : within;
    const [r] = await sql<{ live: number; used: number }[]>`
      SELECT
        (SELECT count(*)::int FROM calls c JOIN scope_nodes n ON n.id = c.scope_node_id
          WHERE c.org_id = ${orgId} AND ${linesWithin}
            AND c.status IN ('PLACING', 'DIALLING') AND c.placed_at > ${liveSince})
      + (SELECT count(*)::int FROM proxy_calls x JOIN scope_nodes n ON n.id = x.scope_node_id
          WHERE x.org_id = ${orgId} AND ${linesWithin}
            AND x.status IN ('RINGING', 'CONNECTED') AND x.placed_at > ${new Date(Date.parse(now) - PROXY_TIME_LIMIT_S * 1000)}) AS live,
        (SELECT ceil(coalesce(sum(ceil(c.duration_s / 60.0) + ceil(coalesce(c.handoff_bill_s, 0) / 60.0) * ${HANDOFF_WEIGHT}), 0))::int
           FROM calls c JOIN scope_nodes n ON n.id = c.scope_node_id
          WHERE c.org_id = ${orgId} AND ${within} AND c.placed_at >= ${month})
      + (SELECT ceil(coalesce(sum(ceil(coalesce(x.bill_s, 0) / 60.0) * ${HANDOFF_WEIGHT}), 0))::int
           FROM proxy_calls x JOIN scope_nodes n ON n.id = x.scope_node_id
          WHERE x.org_id = ${orgId} AND ${within} AND x.placed_at >= ${month}) AS used`;
    return r;
  });
  if (!plan.billed && !limitsLifted() && load.used >= policy.minuteAllowance) {
    return { ok: false, code: "ALLOWANCE", message: `This project has used its ${policy.minuteAllowance.toLocaleString("en-IN")} call minutes for the month.` };
  }
  if (load.live >= lines) {
    return { ok: false, code: "BUSY", message: `All ${lines} calling lines ${wideLines ? "on your plan" : "for this project"} are busy. Try again in a minute.` };
  }

  const [row] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO proxy_calls (org_id, lead_id, scope_node_id, caller_id, placed_at, from_number)
    VALUES (${orgId}, ${lead.id}, ${lead.scope_node_id}, ${userId}, ${now}, ${from})
    RETURNING id`);
  const q = query(orgId, row.id);
  try {
    const { uuid } = await vobiz().makeCall(cfg, {
      from,
      to: mine,
      answerUrl: `${base}/api/calls/proxy?${q}&ev=answer`,
      hangupUrl: `${base}/api/calls/proxy?${q}&ev=hangup`,
      timeLimit: PROXY_TIME_LIMIT_S,
    });
    await withTenant(orgId, (sql) => sql`UPDATE proxy_calls SET vobiz_call_uuid = ${uuid} WHERE org_id = ${orgId} AND id = ${row.id}`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await withTenant(orgId, (sql) => sql`
      UPDATE proxy_calls SET status = 'FAILED', failure = ${reason.slice(0, 300)}, ended_at = now()
      WHERE org_id = ${orgId} AND id = ${row.id}`);
    return { ok: false, code: "REFUSED", message: "The call could not be placed. Try again in a minute." };
  }

  await audit({
    orgId,
    actorUserId: userId,
    action: "lead.call_proxied",
    targetType: "lead",
    targetId: lead.id,
    metadata: { proxy_call: row.id, unit: "handoff_minute" },
  });
  return { ok: true, proxyCallId: row.id };
}

/** The person picked up: ring the buyer, as us. Anything else hangs up. */
export async function proxyAnswerXml(orgId: string, id: string): Promise<string> {
  const base = webhookBase();
  if (!base) return HANGUP_XML;
  const answered = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ phone: string; from_number: string | null }[]>`
      UPDATE proxy_calls x SET status = 'CONNECTED'
      FROM leads l
      WHERE x.org_id = ${orgId} AND x.id = ${id} AND x.status = 'RINGING' AND l.id = x.lead_id
      RETURNING l.phone, x.from_number`;
    return r ?? null;
  });
  const from = answered ? rowNumber(answered.from_number) : null;
  if (!answered || !from) return HANGUP_XML;
  const buyer = answered.phone;
  return proxyDialXml({ buyer, callerId: from, eventsUrl: `${base}/api/calls/proxy?${query(orgId, id)}&ev=events` });
}

/** Vobiz's reports on the buyer's leg: when it ends, what it billed. */
export async function proxyEvent(orgId: string, id: string, params: Record<string, string>): Promise<void> {
  const e = readDialEvent(params);
  if (e.kind !== "ended") return;
  const [ended] = await withTenant(orgId, (sql) => sql<{ scope_node_id: string; placed_at: Date; lead_id: string; phone: string }[]>`
    UPDATE proxy_calls x SET status = 'ENDED', bill_s = ${e.billS}, ended_at = now()
    FROM leads l
    WHERE x.org_id = ${orgId} AND x.id = ${id} AND x.status IN ('RINGING', 'CONNECTED') AND l.id = x.lead_id
    RETURNING x.scope_node_id, x.placed_at, x.lead_id, l.phone`);
  // The buyer's leg refused for the register is remembered, as an AI call's is.
  if (ended && e.billS <= 0 && dndCause(params.DialBLegHangupCause)) {
    await recordDnd({ orgId, phone: ended.phone, status: "DND", source: "OPERATOR", leadId: ended.lead_id });
  }
  if (!ended || e.billS <= 0) return;
  const { minutes, counted } = proxyMinutes(e.billS, HANDOFF_WEIGHT);
  // Metered as the hand-off minute it costs the same as. The source is a
  // call of ours, named so it can never collide with an AI call's row.
  await meterQuietly({
    orgId,
    nodeId: ended.scope_node_id,
    kind: "HANDOFF_MINUTE",
    qty: counted,
    costPaise: minutes * COST_PAISE.HANDOFF_MINUTE,
    billable: true,
    source: { kind: "call", id: `proxy:${id}` },
    atIso: ended.placed_at.toISOString(),
  });
}

/** The person's own leg ended. A call they never picked up is a failed one. */
export async function proxyHangup(orgId: string, id: string): Promise<void> {
  await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ kind: string; lead_id: string; accepted: boolean }[]>`
      UPDATE proxy_calls
      SET status = CASE WHEN status = 'RINGING' THEN 'FAILED' ELSE 'ENDED' END,
          failure = CASE WHEN status = 'RINGING' THEN
                      CASE WHEN kind = 'BRIDGE' THEN 'Nobody took the buyer.' ELSE 'Your phone was not picked up.' END
                    ELSE failure END,
          ended_at = coalesce(ended_at, now())
      WHERE org_id = ${orgId} AND id = ${id} AND status IN ('RINGING', 'CONNECTED')
      RETURNING kind, lead_id, accepted_at IS NOT NULL AS accepted`;
    // A hot buyer nobody took is a person's to call, now.
    if (r?.kind === "BRIDGE" && !r.accepted) {
      await sql`
        UPDATE leads SET needs_person = 'Hot lead, nobody took the call. Call them now', updated_at = now()
        WHERE org_id = ${orgId} AND id = ${r.lead_id}`;
    }
  });
}

/** Calls people made about one lead, newest first, for its page. */
export async function leadProxyCalls(orgId: string, leadId: string): Promise<
  { id: string; caller: string | null; status: string; billS: number | null; placedAt: string }[]
> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; caller: string | null; status: string; bill_s: number | null; placed_at: Date }[]>`
    SELECT x.id, coalesce(u.name, u.email::text) AS caller, x.status, x.bill_s, x.placed_at
    FROM proxy_calls x LEFT JOIN users u ON u.id = x.caller_id
    WHERE x.org_id = ${orgId} AND x.lead_id = ${leadId}
    ORDER BY x.placed_at DESC LIMIT 50`);
  return rows.map((r) => ({ id: r.id, caller: r.caller, status: r.status, billS: r.bill_s, placedAt: r.placed_at.toISOString() }));
}

// ---------------------------------------------------------------------------
// A hot buyer, put straight through (lead engine gaps, slice 4)
// ---------------------------------------------------------------------------

export type BridgeOutcome =
  | { ok: true; bridgeId: string }
  | { ok: false; code: "GONE" | "REFUSED" | "OFF" | "NOBODY" | "BUSY" | "ALLOWANCE" | "NO_NUMBER"; message: string };

/**
 * A hot buyer the agent did not put through on the call: the free sales
 * person who has waited longest is rung from our number, hears who is
 * waiting, and pressing 1 dials the buyer, as us. Asked in the AI call's
 * order first, because to the buyer it is a call from the developer.
 */
export async function placeBridge(o: { orgId: string; leadId: string; afterCallId: string | null; nowIso?: string }): Promise<BridgeOutcome> {
  const { orgId, leadId } = o;
  const now = o.nowIso ?? new Date().toISOString();
  const found = await withTenant(orgId, async (sql) => {
    const [lead] = await sql<{ id: string; phone: string; enquired_at: Date; scope_node_id: string }[]>`
      SELECT id, phone, enquired_at, scope_node_id FROM leads WHERE org_id = ${orgId} AND id = ${leadId}`;
    if (!lead) return null;
    const consents = await sql<{ channels: string[]; captured_at: Date; expires_at: Date | null }[]>`
      SELECT channels, captured_at, expires_at FROM lead_consents WHERE org_id = ${orgId} AND phone = ${lead.phone}`;
    const [opt] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM call_suppressions WHERE org_id = ${orgId} AND phone = ${lead.phone}`;
    return { lead, consents, optedOut: (opt?.n ?? 0) > 0 };
  });
  if (!found) return { ok: false, code: "GONE", message: "That lead no longer exists." };
  const { lead } = found;
  const policy = await policyAt(orgId, lead.scope_node_id);
  const verdict = gateCall({
    policy,
    nowIso: now,
    enquiredAt: lead.enquired_at.toISOString(),
    consents: found.consents.map((c) => ({ channels: c.channels, capturedAt: c.captured_at.toISOString(), expiresAt: c.expires_at?.toISOString() ?? null })),
    optedOut: found.optedOut,
    anyHour: anyHourFor(lead.phone, false),
  });
  if (!verdict.ok) return { ok: false, code: "REFUSED", message: verdict.message };
  const gate = await canPublish(orgId, lead.scope_node_id);
  if (!gate.ok) return { ok: false, code: "REFUSED", message: gate.message };
  const hold = await partnerHold(orgId, leadId);
  if (hold.held) return { ok: false, code: "REFUSED", message: hold.message };
  const dnd = await dndGate({ orgId, phone: lead.phone, leadId, enquiredAt: lead.enquired_at.toISOString(), nowIso: now });
  if (!dnd.ok) return { ok: false, code: "REFUSED", message: dnd.message };

  const cfg = vobizConfig();
  const base = webhookBase();
  if (!cfg || !base) return { ok: false, code: "OFF", message: "Calling through our number is not set up for your account yet." };
  const line = await callerLineFor(orgId, lead.scope_node_id, sharedProxyNumber());
  if (!line.ok) {
    return line.code === "OFF"
      ? { ok: false, code: "OFF", message: "Calling through our number is not set up for your account yet." }
      : { ok: false, code: "NO_NUMBER", message: line.message };
  }
  const from = line.from;

  const team = await sellers(orgId, o.afterCallId ?? "00000000-0000-0000-0000-000000000000");
  // The organisation's own hand-off number only, never the environment's default.
  const [rung] = ringList(team, await ownHandoffNumber(orgId, lead.scope_node_id), 1);
  if (!rung) return { ok: false, code: "NOBODY", message: "Nobody on the sales team is free." };

  const plan = await callAllowance({ orgId, nodeId: lead.scope_node_id, agent: "qualifier", nowIso: now });
  if (plan.billed && !plan.ok) return { ok: false, code: "ALLOWANCE", message: plan.message };

  const [row] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO proxy_calls (org_id, lead_id, scope_node_id, caller_id, placed_at, kind, to_number, after_call_id, from_number)
    VALUES (${orgId}, ${lead.id}, ${lead.scope_node_id}, NULL, ${now}, 'BRIDGE', ${rung}, ${o.afterCallId}, ${from})
    RETURNING id`);
  const q = query(orgId, row.id);
  try {
    const { uuid } = await vobiz().makeCall(cfg, {
      from,
      to: rung,
      answerUrl: `${base}/api/calls/proxy?${q}&ev=bridge`,
      hangupUrl: `${base}/api/calls/proxy?${q}&ev=hangup`,
      timeLimit: PROXY_TIME_LIMIT_S,
    });
    await withTenant(orgId, (sql) => sql`UPDATE proxy_calls SET vobiz_call_uuid = ${uuid} WHERE org_id = ${orgId} AND id = ${row.id}`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await withTenant(orgId, (sql) => sql`
      UPDATE proxy_calls SET status = 'FAILED', failure = ${reason.slice(0, 300)}, ended_at = now()
      WHERE org_id = ${orgId} AND id = ${row.id}`);
    return { ok: false, code: "REFUSED", message: "The call could not be placed." };
  }
  await audit({ orgId, actorUserId: null, action: "lead.bridged", targetType: "lead", targetId: lead.id, metadata: { proxy_call: row.id, unit: "handoff_minute" } });
  return { ok: true, bridgeId: row.id };
}

/** The sales person picked up: the summary, and one key to take the buyer. */
export async function bridgeAnswer(orgId: string, id: string): Promise<string> {
  const base = webhookBase();
  if (!base) return HANGUP_XML;
  const r = await withTenant(orgId, async (sql) => {
    const [x] = await sql<{ name: string; facts: Record<string, string>; tower: string; project: string | null }[]>`
      SELECT l.name, l.facts, n.name AS tower, p.name AS project
      FROM proxy_calls x JOIN leads l ON l.id = x.lead_id JOIN scope_nodes n ON n.id = x.scope_node_id
      LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
      WHERE x.org_id = ${orgId} AND x.id = ${id} AND x.kind = 'BRIDGE' AND x.status = 'RINGING'`;
    return x ?? null;
  });
  if (!r) return HANGUP_XML;
  const whisper = whisperText({
    name: r.name,
    config: r.facts?.config ?? null,
    budget: r.facts?.budget ?? null,
    tower: r.project ? `${r.project} ${r.tower}` : r.tower,
  });
  return bridgeAnswerXml({ whisper, acceptUrl: `${base}/api/calls/proxy?${query(orgId, id)}&ev=accept` });
}

/**
 * The sales person pressed a key. Only 1 takes the buyer, and only while the
 * buyer may still be called: the opt-out and the hours are asked again at
 * this moment, because a minute has passed since the bridge was placed.
 */
export async function bridgeAccept(orgId: string, id: string, params: Record<string, string>, nowIso?: string): Promise<string> {
  const base = webhookBase();
  if (!base || !bridgeAccepted(params)) return HANGUP_XML;
  const now = nowIso ?? new Date().toISOString();
  const buyer = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ phone: string; from_number: string | null; opted_out: boolean }[]>`
      UPDATE proxy_calls x SET status = 'CONNECTED', accepted_at = now()
      FROM leads l
      WHERE x.org_id = ${orgId} AND x.id = ${id} AND x.kind = 'BRIDGE' AND x.status = 'RINGING' AND l.id = x.lead_id
      RETURNING l.phone, x.from_number, EXISTS (SELECT 1 FROM call_suppressions s WHERE s.org_id = x.org_id AND s.phone = l.phone) AS opted_out`;
    return r ?? null;
  });
  const from = buyer ? rowNumber(buyer.from_number) : null;
  if (!buyer || !from) return HANGUP_XML;
  const hour = new Date(Date.parse(now) + 330 * 60_000).getUTCHours();
  if (buyer.opted_out || ((hour < CALLING_HOURS.from || hour >= CALLING_HOURS.to) && !anyHourFor(buyer.phone, false))) return HANGUP_XML;
  return proxyDialXml({ buyer: buyer.phone, callerId: from, eventsUrl: `${base}/api/calls/proxy?${query(orgId, id)}&ev=events` });
}
