import { audit, withTenant } from "./db/index.ts";
import { askJson, type AskDriver } from "./generate.ts";
import { entitle, meterQuietly } from "./billing.ts";
import { COST_PAISE } from "./billing-rules.ts";
import { approvedUnits } from "./unit.ts";
import { priceFor } from "./unit-rules.ts";
import {
  DEFAULT_FLOORS,
  boardFacts,
  extractionPrompt,
  extractionSchema,
  mergeQualification,
  qualConfigOf,
  readQualification,
  readWeights,
  routeLead,
  learntAnything,
  scoreLead,
  transcriptText,
  type Qualification,
  type Route,
} from "./qualification-rules.ts";
import type { Facts } from "./lead-rules.ts";
import type { Turn } from "./call-rules.ts";

/**
 * Reading a finished qualifying call: the nine fields with the buyer's own
 * words, the score and the route (`qualification-rules.ts` decides every
 * one of those; this asks the model and writes).
 *
 * One model call per connected call, never retried on an answer that did
 * not hold up (a second read of the same transcript is not new evidence),
 * and asked only after the project's allowance says there is room for it:
 * each read counts `READING_MINUTES` of an AI minute, which is what keeps
 * every plan at its margin floor (`doc/pricing.md`). Without a model, or
 * with the allowance used up, the call is read the way it always was, from
 * the agent's own variables, and nothing here runs.
 */

/** The model that reads a transcript. */
export const QUALIFY_MODEL = process.env.QUALIFY_MODEL || "gpt-5-mini";
/** What one read counts against the project's AI minutes. */
export const READING_MINUTES = 0.15;
/** One read, at worst: about 5,000 tokens in and 2,500 out on `gpt-5-mini`, in paise. */
export const READING_COST_PAISE = 60;
/** A read is given this long before the call is read without it. */
export const READING_TIMEOUT_MS = 45_000;

let injected: AskDriver | null = null;

/** For checks: answer every read with `driver` until `restore()`. */
export function useQualifier(driver: AskDriver | null): { restore(): void } {
  injected = driver;
  return { restore: () => void (injected = null) };
}

const reader = (): AskDriver => injected ?? askJson;

export type LeadSettings = {
  weights: ReturnType<typeof readWeights>;
  floors: { hot: number; warm: number };
  microMarkets: string[];
  competitors: string[];
  nriDesk: string[];
};

export async function leadScoring(orgId: string): Promise<LeadSettings> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ weights: unknown; hot_floor: number; warm_floor: number; micro_markets: string[]; competitors: string[]; nri_desk: string[] }[]>`
      SELECT weights, hot_floor, warm_floor, micro_markets, competitors, nri_desk FROM lead_settings WHERE org_id = ${orgId}`;
    return {
      weights: readWeights(r?.weights),
      floors: r ? { hot: r.hot_floor, warm: r.warm_floor } : { ...DEFAULT_FLOORS },
      microMarkets: r?.micro_markets ?? [],
      competitors: r?.competitors ?? [],
      nriDesk: r?.nri_desk ?? [],
    };
  });
}

/** `learnt` is false when the call told us nothing the score counts: the route is then no verdict. */
export type Reading = { qualification: Qualification; score: number; route: Route; learnt: boolean; facts: Facts };

/**
 * Read one finished call, once. The call's own reading is stored on it, the
 * lead's merged view, score and route on the lead. Null when the call is
 * not one to read, or the read did not happen.
 */
export async function qualifyCall(orgId: string, callId: string, opts: { nowIso?: string; junk?: boolean } = {}): Promise<Reading | null> {
  const row = await withTenant(orgId, async (sql) => {
    const [c] = await sql<{
      lead_id: string; scope_node_id: string; connectivity: string | null; transcript: Turn[] | null; qualification: Qualification | null;
      phone: string; lead_q: Qualification; placed_at: Date; partner: boolean; replies: number; visit_booked: boolean;
    }[]>`
      SELECT c.lead_id, c.scope_node_id, c.connectivity, c.transcript, c.qualification, l.phone, l.qualification AS lead_q, c.placed_at,
             (c.final_variables->>'site_visit_status' = 'booked'
              OR EXISTS (SELECT 1 FROM site_visits v WHERE v.org_id = c.org_id AND v.lead_id = c.lead_id
                           AND v.status IN ('REQUESTED', 'CONFIRMED') AND v.scheduled_at > now())) AS visit_booked,
             EXISTS (SELECT 1 FROM client_registrations r
                      WHERE r.org_id = c.org_id AND r.lead_id = c.lead_id AND r.verdict = 'REGISTERED'
                        AND r.status = 'ACTIVE' AND r.valid_until > now()) AS partner,
             (SELECT count(*)::int FROM messages m WHERE m.org_id = c.org_id AND m.lead_id = c.lead_id AND m.direction = 'IN' AND m.created_at >= l.enquired_at) AS replies
      FROM calls c JOIN leads l ON l.id = c.lead_id
      WHERE c.org_id = ${orgId} AND c.id = ${callId}`;
    return c ?? null;
  });
  if (!row || row.connectivity !== "connected") return null;
  const { forModel, buyer } = transcriptText(row.transcript ?? []);
  if (!buyer.trim()) return null;
  const settings = await leadScoring(orgId);

  let heard = row.qualification;
  if (!heard) {
    // Refused before spending: the read counts against the project's minutes.
    const room = await entitle({ orgId, nodeId: row.scope_node_id, needs: [{ unit: "MINUTE", qty: READING_MINUTES }], nowIso: opts.nowIso });
    if (!room.ok) {
      console.warn(`qualify: call ${callId} not read, ${room.code}`);
      return null;
    }
    const answer = await reader()({
      model: QUALIFY_MODEL,
      system: extractionPrompt({ microMarkets: settings.microMarkets, competitors: settings.competitors }),
      parts: [{ text: forModel }],
      schema: extractionSchema(),
      name: "qualification",
      timeoutMs: READING_TIMEOUT_MS,
      effort: "low",
    });
    if (!answer.ok) {
      console.warn(`qualify: call ${callId} not read, ${answer.code}: ${answer.message}`);
      return null;
    }
    heard = readQualification(answer.value, { transcript: buyer, microMarkets: settings.microMarkets, competitors: settings.competitors });
    await withTenant(orgId, (sql) => sql`UPDATE calls SET qualification = ${sql.json(heard as never)} WHERE org_id = ${orgId} AND id = ${callId}`);
    await meterQuietly({
      orgId,
      nodeId: row.scope_node_id,
      kind: "CALL_MINUTE",
      qty: READING_MINUTES,
      costPaise: READING_COST_PAISE,
      billable: true,
      source: { kind: "call", id: `${callId}:reading` },
      atIso: row.placed_at.toISOString(),
    });
  }

  const merged = mergeQualification(row.lead_q ?? {}, heard);
  const score = scoreLead(merged, settings.weights, { ...(await sellingAt(orgId, row.scope_node_id)), replies: row.replies });
  const route = routeLead({ junk: !!opts.junk, partnerClaim: row.partner, phone: row.phone, score, q: merged, floors: settings.floors, visitBooked: row.visit_booked });
  // A reading that learnt nothing judges nobody: the lead keeps no hot, warm
  // or cold of its own until a call says something (a junk, partner or NRI
  // route still stands).
  const learnt = learntAnything(merged) || row.visit_booked;
  const stored = learnt || !["HOT", "WARM", "COLD"].includes(route) ? route : null;
  await withTenant(orgId, (sql) => sql`
    UPDATE leads SET qualification = ${sql.json(merged as never)}, score = ${score}, route = ${stored}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${row.lead_id}`);
  await audit({
    orgId,
    actorUserId: null,
    action: "lead.qualified",
    targetType: "lead",
    targetId: row.lead_id,
    metadata: { call: callId, score, route, fields: Object.keys(heard).length, unit: "call_minute" },
  });
  return { qualification: merged, score, route, learnt, facts: boardFacts(merged) };
}

/** What the tower sells, for the score: the cheapest approved price and the configurations. */
async function sellingAt(orgId: string, nodeId: string): Promise<{ cheapest: number | null; offered: string[] }> {
  const { units, basePsf } = await approvedUnits(orgId, nodeId).catch(() => ({ units: [], basePsf: null }));
  const prices = units.map((u) => priceFor(u, basePsf)).filter((p): p is number => typeof p === "number" && p > 0);
  const offered = [...new Set(units.map((u) => configKey(u.config)))].filter((x): x is string => !!x);
  return { cheapest: prices.length ? Math.min(...prices) : null, offered };
}

/** A unit type's configuration key (`2BHK`, `2_5BHK`) in the qualification's words (`2_BHK`, `2_5_BHK`). */
export function configKey(config: string): string | null {
  return qualConfigOf(config);
}

/**
 * A lead whose form answered our questions: its score from those answers,
 * before any call. The route waits for the call, which is what decides it.
 */
export async function scoreOnCapture(orgId: string, leadId: string): Promise<void> {
  const settings = await leadScoring(orgId);
  const l = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ qualification: Qualification; scope_node_id: string }[]>`
      SELECT qualification, scope_node_id FROM leads WHERE org_id = ${orgId} AND id = ${leadId}`;
    return r ?? null;
  });
  if (!l || !Object.keys(l.qualification ?? {}).length) return;
  const score = scoreLead(l.qualification, settings.weights, await sellingAt(orgId, l.scope_node_id));
  await withTenant(orgId, (sql) => sql`UPDATE leads SET score = ${score}, updated_at = now() WHERE org_id = ${orgId} AND id = ${leadId} AND score IS NULL`);
}

/**
 * A buyer wrote on WhatsApp: engagement counts for them, so the score is
 * worked out again from what is already known. No model is asked.
 */
export async function rescoreOnReply(orgId: string, leadId: string): Promise<void> {
  const settings = await leadScoring(orgId);
  const l = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ qualification: Qualification; phone: string; scope_node_id: string; route: Route | null; replies: number }[]>`
      SELECT l.qualification, l.phone, l.scope_node_id, l.route,
             (SELECT count(*)::int FROM messages m WHERE m.org_id = l.org_id AND m.lead_id = l.id AND m.direction = 'IN'
                AND m.created_at >= l.enquired_at) AS replies
      FROM leads l WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    return r ?? null;
  });
  if (!l || !l.route || l.route === "JUNK" || l.route === "CP" || l.route === "NRI") return;
  const score = scoreLead(l.qualification ?? {}, settings.weights, { ...(await sellingAt(orgId, l.scope_node_id)), replies: l.replies });
  const route = routeLead({ junk: false, partnerClaim: false, phone: l.phone, score, q: l.qualification ?? {}, floors: settings.floors });
  await withTenant(orgId, (sql) => sql`UPDATE leads SET score = ${score}, route = ${route}, updated_at = now() WHERE org_id = ${orgId} AND id = ${leadId}`);
}

export { COST_PAISE };
