import { withTenant } from "./db/index.ts";
import type { Authz } from "./rbac-rules.ts";
import type { Lens } from "./mask-rules.ts";
import { loadLead } from "./leads.ts";
import { listCalls } from "./calling.ts";
import { leadVisits } from "./visits.ts";
import { ownPhone } from "./otp.ts";
import { LANGUAGE_LABEL, agentLabel, type CallRecord } from "./call-rules.ts";
import { FIELDS, digits, rupees, stageLabel, type FieldKey } from "./lead-rules.ts";
import { FIELD_WORDS, MIN_CONFIDENCE, QUAL_FIELDS, valueWords } from "./qualification-rules.ts";
import {
  RECENT_MINUTES,
  bridgeState,
  deskOrder,
  inboundState,
  lastTurns,
  ringReason,
  transferState,
  type DeskBuyer,
  type DeskCall,
  type DeskRing,
  type RingKind,
  type RingState,
} from "./call-desk-rules.ts";

/**
 * What the call desk shows: every buyer being put through to the sales team
 * right now, or in the last half hour, at towers this person reads leads on,
 * each with what is known about them. Read on every poll, so a ring that
 * starts is on screen within one.
 */
export type DeskFeed = { rings: DeskRing[]; onTeam: boolean };

type RingRow = {
  kind: RingKind;
  id: string;
  lead_id: string;
  call_key: string | null;
  raw_state: string;
  reason: string | null;
  at: Date;
  ended_at: Date | null;
  rang: string[] | null;
  taken: string | null;
};

const WANTS: FieldKey[] = ["config", "budget", "timeline"];

export async function deskFeed(o: { orgId: string; userId: string; authz: Authz; lens: () => Promise<Lens>; minutes?: number }): Promise<DeskFeed> {
  const scopes = o.authz.scopesFor("lead:read") as string[];
  if (!scopes.length) return { rings: [], onTeam: false };
  const since = new Date(Date.now() - (o.minutes ?? RECENT_MINUTES) * 60_000);

  const [rows, me, team] = await Promise.all([
    withTenant(o.orgId, (sql) => sql<RingRow[]>`
      SELECT * FROM (
        SELECT 'TRANSFER' AS kind, c.id::text AS id, c.lead_id::text AS lead_id, coalesce(c.attempt_id, c.id::text) AS call_key,
               c.handoff_state AS raw_state, c.handoff_reason AS reason, c.handoff_at AS at, c.handoff_ended_at AS ended_at,
               c.handoff_rang AS rang, CASE WHEN c.handoff_state IN ('CONNECTED', 'ENDED') THEN c.handoff_to END AS taken
        FROM calls c
        JOIN leads l ON l.id = c.lead_id
        JOIN scope_nodes n ON n.id = l.scope_node_id
        WHERE c.org_id = ${o.orgId} AND c.handoff_at > ${since} AND c.handoff_state <> 'FAILED'
          AND l.erased_at IS NULL AND n.path <@ ${scopes}::ltree[]
        UNION ALL
        SELECT 'HOT', x.id::text, x.lead_id::text, NULL, x.status, NULL, x.placed_at, x.ended_at,
               ARRAY[x.to_number], CASE WHEN x.status IN ('CONNECTED', 'ENDED') THEN x.to_number END
        FROM proxy_calls x
        JOIN leads l ON l.id = x.lead_id
        JOIN scope_nodes n ON n.id = l.scope_node_id
        WHERE x.org_id = ${o.orgId} AND x.kind = 'BRIDGE' AND x.placed_at > ${since}
          AND l.erased_at IS NULL AND n.path <@ ${scopes}::ltree[]
        UNION ALL
        SELECT 'INBOUND', i.id::text, i.lead_id::text, NULL, i.status, NULL, i.started_at, i.ended_at, i.rang, i.answered_by
        FROM inbound_calls i
        JOIN leads l ON l.id = i.lead_id
        JOIN scope_nodes n ON n.id = l.scope_node_id
        WHERE i.org_id = ${o.orgId} AND i.started_at > ${since} AND i.status <> 'REFUSED'
          AND l.erased_at IS NULL AND n.path <@ ${scopes}::ltree[]
      ) r
      ORDER BY at DESC
      LIMIT 20`),
    ownPhone(o.orgId, o.userId),
    withTenant(o.orgId, (sql) => sql<{ phone: string; name: string }[]>`
      SELECT DISTINCT ON (phone) phone, name FROM sales_team WHERE org_id = ${o.orgId} ORDER BY phone, created_at`),
  ]);

  const onTeam = !!me && team.some((t) => t.phone === me);
  const nameOf = (phone: string | null) => (phone ? team.find((t) => t.phone === phone)?.name ?? "Someone on the team" : null);

  const rings = rows.flatMap((r) => {
    const state: RingState | null =
      r.kind === "TRANSFER" ? transferState(r.raw_state) : r.kind === "HOT" ? bridgeState(r.raw_state) : inboundState(r.raw_state);
    return state ? [{ r, state }] : [];
  });
  if (!rings.length) return { rings: [], onTeam };

  // A buyer on the line is read whole, once however many rings they have;
  // one already finished needs only a name and a place for the list, so the
  // poll stays one query while the desk is quiet.
  const isLive = (s: RingState) => s === "RINGING" || s === "CONNECTED";
  const liveIds = [...new Set(rings.filter(({ state }) => isLive(state)).map(({ r }) => r.lead_id))];
  const pastIds = [...new Set(rings.map(({ r }) => r.lead_id))].filter((id) => !liveIds.includes(id));
  const buyers = new Map<string, DeskBuyer | null>();
  const lens = liveIds.length ? await o.lens() : null;
  await Promise.all([
    ...liveIds.map(async (leadId) => {
      const callKey = rings.find(({ r }) => r.lead_id === leadId && r.call_key)?.r.call_key ?? null;
      buyers.set(leadId, await buyerCard(o.orgId, leadId, callKey, lens!, scopes));
    }),
    pastIds.length
      ? withTenant(o.orgId, (sql) => sql<{ id: string; name: string; place: string }[]>`
          SELECT l.id::text AS id, l.name, CASE WHEN p.name IS NULL THEN n.name ELSE p.name || ' · ' || n.name END AS place
          FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
          LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
          WHERE l.org_id = ${o.orgId} AND l.id = ANY(${pastIds}::uuid[])`).then((rs) => {
          for (const b of rs) buyers.set(b.id, briefBuyer(b));
        })
      : null,
  ]);

  const out: DeskRing[] = rings.flatMap(({ r, state }) => {
    const buyer = buyers.get(r.lead_id);
    if (!buyer) return [];
    return [{
      id: `${r.kind === "TRANSFER" ? "t" : r.kind === "HOT" ? "b" : "i"}:${r.id}`,
      kind: r.kind,
      state,
      reason: ringReason(r.kind, r.reason),
      at: r.at.toISOString(),
      endedAt: r.ended_at?.toISOString() ?? null,
      mine: !!me && (r.rang?.includes(me) || r.taken === me),
      takenBy: nameOf(r.taken),
      buyer,
    }];
  });
  return { rings: out.sort(deskOrder), onTeam };
}

async function buyerCard(
  orgId: string,
  leadId: string,
  callKey: string | null,
  lens: Lens,
  scopes: string[],
): Promise<DeskBuyer | null> {
  const [lead, calls, visits] = await Promise.all([
    loadLead(orgId, leadId),
    listCalls(orgId, { lens, scopes }, 20, leadId),
    leadVisits(orgId, leadId),
  ]);
  if (!lead || lead.erasedAt) return null;

  // The AI call the buyer came from; for a bridge or a call in, the latest
  // call of the last half hour, which is usually the one that made them hot.
  const recent = Date.now() - RECENT_MINUTES * 60_000;
  const current = (callKey ? calls.find((c) => c.id === callKey) : null)
    ?? calls.find((c) => Date.parse(c.startedAt) > recent && c.connectivity === "connected")
    ?? null;
  const before = calls.filter((c) => c !== current && c.connectivity === "connected" && (!current || c.startedAt < current.startedAt));

  const nowMs = Date.now();
  const visit = visits
    .filter((v) => Date.parse(v.at) > nowMs && (v.status === "confirmed" || v.status === "requested"))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];

  return {
    leadId: lead.id,
    name: lead.name,
    phone: calls[0]?.phone.text ?? "",
    place: lead.place,
    language: LANGUAGE_LABEL[lead.language] ?? lead.language,
    stage: stageLabel(lead.stage),
    temperature: lead.temperature,
    source: lead.source,
    enquiredAt: lead.enquiredAt,
    owner: lead.owner,
    wants: WANTS.flatMap((k) => {
      const v = lead.facts[k]?.trim();
      return v ? [factWords(k, v)] : [];
    }),
    heard: QUAL_FIELDS.flatMap((f) => {
      const h = lead.qualification[f];
      return h && h.detail !== "form" && h.confidence >= MIN_CONFIDENCE
        ? [{ label: FIELD_WORDS[f], value: valueWords(f, h), quote: h.span ?? null }]
        : [];
    }),
    form: lead.formAnswers,
    thisCall: current ? deskCall(current) : null,
    earlier: { count: before.length, last: before[0] ? deskCall(before[0]) : null },
    visit: visit ? { at: visit.at, host: visit.host } : null,
    needsPerson: lead.needsPerson,
  };
}

/** A buyer whose ring is over: what the list of the last half hour shows. */
function briefBuyer(b: { id: string; name: string; place: string }): DeskBuyer {
  return {
    leadId: b.id, name: b.name, phone: "", place: b.place, language: "", stage: "", temperature: null, source: "",
    enquiredAt: "", owner: null, wants: [], heard: [], form: [], thisCall: null, earlier: { count: 0, last: null },
    visit: null, needsPerson: null,
  };
}

function deskCall(c: CallRecord): DeskCall {
  return {
    at: c.startedAt,
    agent: agentLabel(c.agent),
    summary: c.summary,
    goal: c.goal?.text ?? null,
    facts: c.facts.flatMap((f) => (f.value ? [{ label: f.label, value: f.value }] : [])),
    lastTurns: lastTurns(c.transcript),
    durationS: c.duration,
  };
}

function factWords(k: FieldKey, v: string): string {
  if (FIELDS[k].kind === "money") {
    const n = Number(digits(v));
    return n > 0 ? rupees(n) : v;
  }
  return v;
}
