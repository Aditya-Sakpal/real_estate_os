import { audit, withTenant } from "./db/index.ts";
import { canPublish } from "./publish-gate.ts";
import { resolveBrain } from "./brain.ts";
import { asList } from "./brain-rules.ts";
import { approvedUnits } from "./unit.ts";
import { priceFor } from "./unit-rules.ts";
import { phoneLead } from "./capture-rules.ts";
import { maskPhone } from "./mask-rules.ts";
import { readWebhook } from "./calling-rules.ts";
import { meterQuietly } from "./billing.ts";
import { COST_PAISE } from "./billing-rules.ts";
import { upsertCaptured } from "./leads.ts";
import type { Authz } from "./rbac-rules.ts";
import { FILED_FLAG, heardLine, towerNamed, WAITING_REASON, type PortfolioTower } from "./inbound-call-rules.ts";
import type { QueueItem } from "./queue.ts";

/**
 * A caller to a number that covers several towers, whom nobody could file.
 *
 * A channel partner's number sits at its root, above every project it sells,
 * and a developer's may sit above several towers. A caller we do not know
 * cannot be put on one of them by the number alone, and the capture never
 * guesses. Such a call used to be answered and then belonged to nobody. Now
 * its enquiry WAITS (`lead_events`, source PHONE, outcome WAITING) with what
 * the call was: the caller, the number rung, who answered and what they
 * asked. The AI receptionist asks which project and files it itself when the
 * caller named exactly one; otherwise it waits on Today for a person, who
 * files it under a tower through the ordinary capture, ownership rules and
 * all, or says it was not a buyer.
 */

/** How many towers a shared number's receptionist is told about. */
export const PORTFOLIO_MAX = 8;
/** How far back a waiting caller is still offered for filing. */
const WAITING_DAYS = 30;

export type WaitingPayload = {
  /** The call's id at Vobiz or Sarvam: the enquiry's own key. */
  call: string;
  /** The calling number rung. */
  number: string;
  phone: string;
  via: "AI" | "TEAM";
  /** The number's place. */
  place: string | null;
  /** The team's inbound row, when people were rung. */
  inbound?: string | null;
  /** The receptionist's call id, its variables and the towers it was told about. */
  aiCall?: string | null;
  app?: { id: string; version: number };
  variables?: Record<string, string>;
  towers?: PortfolioTower[];
  heard?: string | null;
};

/** The towers under a number's place the RERA gate clears today, each with what a call may say about it. */
export async function portfolioFor(orgId: string, path: string): Promise<{
  towers: (PortfolioTower & { location: string | null; units: { label: string; carpetSqft: number; price: number | null }[] })[];
  neverSay: string[];
}> {
  const phases = await withTenant(orgId, (sql) => sql<{ id: string; name: string; project: string | null }[]>`
    SELECT t.id, t.name, p.name AS project
    FROM scope_nodes t
    LEFT JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    WHERE t.org_id = ${orgId} AND t.kind = 'PHASE' AND t.path <@ ${path}::ltree
      AND NOT EXISTS (SELECT 1 FROM project_states ps WHERE ps.org_id = t.org_id AND ps.project_id = p.id AND ps.status = 'RETIRED')
    ORDER BY p.name, t.name LIMIT 24`);
  const towers: Awaited<ReturnType<typeof portfolioFor>>["towers"] = [];
  const neverSay = new Set<string>();
  for (const t of phases) {
    if (towers.length >= PORTFOLIO_MAX) break;
    const gate = await canPublish(orgId, t.id).catch(() => ({ ok: false }));
    if (!gate.ok) continue;
    const [{ units, basePsf }, brain] = await Promise.all([approvedUnits(orgId, t.id), resolveBrain(orgId, t.id).catch(() => null)]);
    const v = brain?.values ?? {};
    for (const l of asList(v["claims.never_say"])) neverSay.add(l);
    // A project with one tower is said as the project alone.
    const alone = phases.filter((x) => x.project === t.project).length === 1;
    towers.push({
      id: t.id,
      project: t.project ?? t.name,
      tower: alone || !t.project ? null : t.name,
      location: v["claims.location"]?.trim() || null,
      units: units
        .map((u) => ({ label: u.label, carpetSqft: u.carpetAreaSqft, price: priceFor(u, basePsf) }))
        .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)),
    });
  }
  return { towers, neverSay: [...neverSay] };
}

/** The enquiry a caller made waits for a tower, carrying what the call was. */
export async function waitForTower(orgId: string, eventId: string, payload: WaitingPayload): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    UPDATE lead_events SET outcome = 'WAITING', error = ${WAITING_REASON}, processed_at = NULL,
           payload = payload || ${sql.json(payload as never)}
    WHERE org_id = ${orgId} AND id = ${eventId} AND source = 'PHONE'`);
}

/** Add to a waiting caller's record (the team's row, what was heard). */
async function noteOnWaiting(orgId: string, eventId: string, extra: Partial<WaitingPayload>): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    UPDATE lead_events SET payload = payload || ${sql.json(extra as never)}
    WHERE org_id = ${orgId} AND id = ${eventId} AND source = 'PHONE' AND outcome = 'WAITING'`);
}

export async function noteTeamRow(orgId: string, eventId: string, inboundId: string): Promise<void> {
  await noteOnWaiting(orgId, eventId, { inbound: inboundId });
}

type Waiting = { id: string; payload: WaitingPayload; received_at: Date };

/** The waiting caller a receptionist call belongs to, while it waits. */
export async function waitingByAiCall(orgId: string, callId: string): Promise<Waiting | null> {
  const [r] = await withTenant(orgId, (sql) => sql<Waiting[]>`
    SELECT id, payload, received_at FROM lead_events
    WHERE org_id = ${orgId} AND source = 'PHONE' AND outcome = 'WAITING' AND processed_at IS NULL
      AND payload->>'aiCall' = ${callId}`);
  return r ?? null;
}

/**
 * The receptionist's call-end webhook for a caller it could not file at the
 * start. The call's length is metered on the number's place either way. When
 * the caller named one project (and one tower of it), the enquiry is
 * captured there and the call becomes its lead's inbound call, so the
 * ordinary result follows; true means the caller now has a `calls` row.
 * Otherwise what they asked is kept for the person who files them.
 */
export async function settleWaitingReceptionist(orgId: string, callId: string, body: unknown): Promise<boolean> {
  const w = await waitingByAiCall(orgId, callId);
  if (!w) return false;
  const p = w.payload;
  const read = readWebhook(body, "receptionist");
  const said = read.transcript.map((t) => t.en).join(" ");
  const summary = typeof read.finalVariables?.call_summary === "string" ? read.finalVariables.call_summary : null;
  const at = w.received_at.toISOString();
  const phaseId = towerNamed(`${said} ${summary ?? ""}`, p.towers ?? []);
  const lead = phoneLead({ from: p.phone, callUuid: p.call });
  if (phaseId && lead) {
    const up = await upsertCaptured({ orgId, eventId: w.id, lead, phaseId, publishTargetId: null, nowIso: at });
    if (up.ok) {
      const { salesdesk_key: _key, ...stored } = p.variables ?? {};
      await withTenant(orgId, async (sql) => {
        await sql`
          INSERT INTO calls (id, org_id, lead_id, scope_node_id, agent, direction, app_id, app_version, from_number, to_number,
                             variables, brain_sources, placed_by, attempt, placed_at, status)
          SELECT ${callId}, ${orgId}, ${up.leadId}, ${phaseId}, 'receptionist', 'IN', ${p.app?.id ?? "receptionist"}, ${p.app?.version ?? 1},
                 n.number, ${p.phone}, ${sql.json(stored)}, ${sql.json([])}, NULL, 1, ${at}, 'DIALLING'
          FROM calling_numbers n WHERE n.org_id = ${orgId} AND n.id = ${p.number}
          ON CONFLICT (id) DO NOTHING`;
        // Put through to the team before it was filed: that ring is the lead's too.
        const heldId = p.inbound ?? null;
        if (heldId) {
          await sql`UPDATE inbound_calls SET lead_id = ${up.leadId}, scope_node_id = ${phaseId} WHERE org_id = ${orgId} AND id = ${heldId} AND lead_id IS NULL`;
        }
        await sql`
          INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
          VALUES (${orgId}, ${up.leadId}, 'CALL_IN', ${"Called our number. The AI answered and found the project"},
                  ${sql.json({ call: callId } as never)})`;
      });
      await audit({ orgId, actorUserId: null, action: "lead.caller_filed", targetType: "lead", targetId: up.leadId, metadata: { by: "ai", call: callId } });
      return true;
    }
  }
  const minutes = read.durationS && read.durationS > 0 ? Math.ceil(read.durationS / 60) : 0;
  if (minutes) {
    await meterQuietly({ orgId, nodeId: p.place, kind: "CALL_MINUTE", qty: minutes, costPaise: minutes * COST_PAISE.CALL_MINUTE, billable: true, source: { kind: "call", id: callId }, atIso: at });
  }
  await noteOnWaiting(orgId, w.id, { heard: heardLine(summary) });
  return false;
}

// ---------------------------------------------------------------------------
// The screen, its two actions, and Today
// ---------------------------------------------------------------------------

export type WaitingCaller = {
  id: string;
  at: string;
  caller: string;
  number: string;
  via: "AI" | "TEAM";
  answered: boolean;
  heard: string | null;
  towers: { id: string; label: string }[];
};

type Row = { id: string; payload: WaitingPayload; received_at: Date; place_path: string | null; root_path: string; number: string | null; status: string | null };

async function waitingRows(orgId: string, id?: string): Promise<Row[]> {
  return withTenant(orgId, (sql) => sql<Row[]>`
    SELECT e.id, e.payload, e.received_at, n.path::text AS place_path,
           (SELECT r.path::text FROM scope_nodes r WHERE r.org_id = e.org_id AND r.kind = 'ORG' LIMIT 1) AS root_path,
           c.number, x.status
    FROM lead_events e
    LEFT JOIN scope_nodes n ON n.org_id = e.org_id AND n.id::text = e.payload->>'place'
    LEFT JOIN calling_numbers c ON c.org_id = e.org_id AND c.id::text = e.payload->>'number'
    LEFT JOIN inbound_calls x ON x.org_id = e.org_id AND x.id::text = e.payload->>'inbound'
    WHERE e.org_id = ${orgId} AND e.source = 'PHONE' AND e.outcome = 'WAITING' AND e.processed_at IS NULL
      AND e.payload ? 'phone'
      AND e.received_at > now() - ${`${WAITING_DAYS} days`}::interval
      AND ${id ? sql`e.id = ${id}` : sql`true`}
    ORDER BY e.received_at DESC LIMIT 100`);
}

const answeredBy = (r: Row) => r.payload.via === "AI" || r.status === "ENDED" || r.status === "CONNECTED";

/** The callers waiting for a tower that this person may file, each with the towers they may be filed under. */
export async function listWaitingCallers(orgId: string, authz: Authz): Promise<WaitingCaller[]> {
  const rows = (await waitingRows(orgId)).filter((r) => authz.canAt("lead:create", r.place_path ?? r.root_path));
  if (!rows.length) return [];
  const phases = await withTenant(orgId, (sql) => sql<{ id: string; name: string; path: string; project: string | null }[]>`
    SELECT t.id, t.name, t.path::text AS path, p.name AS project
    FROM scope_nodes t
    LEFT JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    WHERE t.org_id = ${orgId} AND t.kind = 'PHASE'
      AND NOT EXISTS (SELECT 1 FROM project_states ps WHERE ps.org_id = t.org_id AND ps.project_id = p.id AND ps.status = 'RETIRED')
    ORDER BY p.name, t.name`);
  return rows.map((r) => {
    const place = r.place_path ?? r.root_path;
    return {
      id: r.id,
      at: r.received_at.toISOString(),
      caller: maskPhone(r.payload.phone),
      number: r.number ?? "",
      via: r.payload.via,
      answered: answeredBy(r),
      heard: r.payload.heard ?? null,
      towers: phases
        .filter((t) => (t.path === place || t.path.startsWith(`${place}.`)) && authz.canAt("lead:create", t.path))
        .map((t) => ({ id: t.id, label: t.project ? `${t.project} · ${t.name}` : t.name })),
    };
  });
}

export type FileOutcome = { ok: true; leadId: string | null } | { ok: false; message: string };

/**
 * A person files a waiting caller under a tower: the ordinary capture, so the
 * ownership rules decide whether it is a new lead or one that exists. No AI
 * call follows; the lead asks a person to call them back, unless somebody on
 * the team already spoke to them.
 */
export async function fileWaitingCaller(o: { orgId: string; userId: string; authz: Authz; eventId: string; phaseId: string }): Promise<FileOutcome> {
  const [r] = await waitingRows(o.orgId, o.eventId);
  if (!r) return { ok: false, message: "This caller is already filed, or is no longer waiting." };
  const place = r.place_path ?? r.root_path;
  const [phase] = await withTenant(o.orgId, (sql) => sql<{ id: string; path: string }[]>`
    SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.phaseId} AND kind = 'PHASE'`);
  if (!phase || !(phase.path === place || phase.path.startsWith(`${place}.`))) return { ok: false, message: "Choose a tower from the list." };
  if (!o.authz.canAt("lead:create", phase.path)) return { ok: false, message: "Your role cannot add leads to that tower." };
  const lead = phoneLead({ from: r.payload.phone, callUuid: r.payload.call });
  if (!lead) return { ok: false, message: "This caller's number cannot be read." };
  const up = await upsertCaptured({ orgId: o.orgId, eventId: r.id, lead, phaseId: phase.id, publishTargetId: null });
  if (!up.ok) {
    if (up.reason === "JUNK") return { ok: true, leadId: null };
    return { ok: false, message: up.message };
  }
  // Somebody on the team talked to them, first or after the AI put them through.
  const spoke = r.status === "ENDED" || r.status === "CONNECTED";
  await withTenant(o.orgId, async (sql) => {
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
      VALUES (${o.orgId}, ${up.leadId}, 'CALL_IN', ${r.payload.heard ? `Called our number: ${r.payload.heard}` : "Called our number"},
              ${sql.json({ event: r.id, filed_by: o.userId } as never)})`;
    if (r.payload.inbound) {
      await sql`UPDATE inbound_calls SET lead_id = ${up.leadId}, scope_node_id = ${phase.id} WHERE org_id = ${o.orgId} AND id = ${r.payload.inbound} AND lead_id IS NULL`;
    }
    if (!spoke) {
      await sql`UPDATE leads SET needs_person = ${FILED_FLAG}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${up.leadId}`;
    }
  });
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "lead.caller_filed", targetType: "lead", targetId: up.leadId, metadata: { by: "person", created: up.created } });
  return { ok: true, leadId: up.leadId };
}

/** Not a buyer: the enquiry is closed as junk and leaves the list. */
export async function dismissWaitingCaller(o: { orgId: string; userId: string; authz: Authz; eventId: string }): Promise<FileOutcome> {
  const [r] = await waitingRows(o.orgId, o.eventId);
  if (!r) return { ok: false, message: "This caller is already filed, or is no longer waiting." };
  if (!o.authz.canAt("lead:create", r.place_path ?? r.root_path)) return { ok: false, message: "Your role cannot file callers here." };
  await withTenant(o.orgId, (sql) => sql`
    UPDATE lead_events SET outcome = 'JUNK', processed_at = now(), error = 'Not a buyer, said a person'
    WHERE org_id = ${o.orgId} AND id = ${r.id} AND outcome = 'WAITING'`);
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "lead.caller_dismissed", targetType: "lead_event", targetId: r.id, metadata: { via: r.payload.via } });
  return { ok: true, leadId: null };
}

/** Today: callers to the organisation's numbers nobody has filed under a project. Never fatal. */
export async function waitingCallerQueue(orgId: string): Promise<QueueItem[]> {
  try {
    const rows = await waitingRows(orgId);
    if (!rows.length) return [];
    const n = rows.length;
    return [
      {
        id: "callers-waiting",
        severity: "warn",
        title: `${n} ${n === 1 ? "caller" : "callers"} to your number not filed under a project`,
        why: "Choose the project each one called about, and they become leads.",
        action: n === 1 ? "File the caller" : "File them",
        href: "/dashboard/leads/callers",
        tag: null,
        resolvers: ["lead:create"],
      },
    ];
  } catch (e) {
    console.error("callers: Today's item could not be read", e);
    return [];
  }
}
