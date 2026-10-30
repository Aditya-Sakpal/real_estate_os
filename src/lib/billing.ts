import { randomUUID } from "node:crypto";
import { retiredAt } from "./project-state.ts";
import { RETIRED_MESSAGE } from "./project-life-rules.ts";
import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import {
  AGENT_JOB_LABEL,
  ALLOWANCE_UNITS,
  CAROUSEL_SLIDES,
  COST_PAISE,
  HANDOFF_WEIGHT,
  KIND_UNIT,
  NO_PLAN_MESSAGE,
  PLANS,
  WALLET_UNITS,
  agentJobFor,
  decide,
  drawFrom,
  isAllowanceUnit,
  isPlanKey,
  isPooled,
  isWalletUnit,
  istDate,
  level,
  monthOf,
  passThroughPaise,
  proratedAllowance,
  readBillingDetails,
  readTerms,
  split,
  usdToPaise,
  usedUpMessage,
  type AgentJob,
  type AllowanceUnit,
  type Lot,
  type Need,
  type PlanKey,
  type PlanTerms,
  type SubscriptionRow,
  type Unit,
  type UsageKind,
  type WalletUnit,
} from "./billing-rules.ts";
import { purchasingOpen } from "./razorpay.ts";
import { limitsLifted } from "./plan-purchase-rules.ts";
import { capRefusal } from "./project-cap-rules.ts";
import { RENEWAL_GRACE_DAYS, UNPAID, overdueMessage, renewalAlerts, type RenewalStatus } from "./plan-renewal-rules.ts";
import { autoAlerts, type ChargeStatus } from "./auto-topup-rules.ts";
import { rupees, skuByKey } from "./billing-rules.ts";

/**
 * Billing: what a project was sold, what it used, and whether the next paid
 * call may run. The reads and writes around `billing-rules.ts`.
 *
 * Three rules hold everywhere here.
 *
 * 1. **Refuse before spending.** `entitle()` is asked before the vendor is
 *    called, in the order the caller already follows, and answers from the
 *    allowance first, then the top-ups. A refusal costs a query.
 * 2. **Meter the outcome, idempotent on its source.** `meter()` writes one
 *    row per billable outcome, keyed on the row that produced it, so a
 *    webhook delivered twice or a sweep run twice counts once. A post that
 *    did not pass writes a cost-only row: never billable, still ours to see.
 * 3. **An organisation with no plan sold is metered and never refused on
 *    account of billing.** That is every tenant until a plan is assigned,
 *    and it keeps today's behaviour, and today's caps, until then.
 *
 * Every read and write goes through `withTenant()`.
 */

export type Mode = "SHADOW" | "LIVE";

/** A project's plan, or (projectId null) a channel partner's plan for the whole firm. */
type Sub = SubscriptionRow & { projectId: string | null };

type SubRow = {
  id: string;
  project_id: string | null;
  project: string | null;
  plan: string;
  status: "PILOT" | "ACTIVE";
  cycle: "MONTHLY" | "ANNUAL";
  starts_on: string;
  ends_on: string | null;
  terms: unknown;
  extra_channels: number;
  extra_agents: string[];
  extra_numbers: number;
  setup_paise: string | number;
  payment_id: string | null;
  scope?: string | null;
};

const toSub = (r: SubRow): Sub => {
  const plan: PlanKey = isPlanKey(r.plan) ? r.plan : "LAUNCH";
  return {
    id: r.id,
    projectId: r.project_id,
    project: r.project ?? "All your projects",
    plan,
    status: r.status,
    cycle: r.cycle,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    terms: readTerms(plan, r.terms, r.scope === "ORG" ? "ORG" : undefined),
    extraChannels: r.extra_channels,
    extraAgents: r.extra_agents.filter((a): a is AgentJob => a in AGENT_JOB_LABEL),
    extraNumbers: r.extra_numbers,
    setupPaise: Number(r.setup_paise),
    prepaid: !!r.payment_id,
  };
};

const covers = (s: { startsOn: string; endsOn: string | null }, day: string) => s.startsOn <= day && (!s.endsOn || day < s.endsOn);

/** Every plan an organisation holds for any day of a month, as a month's plan invoice reads them. */
export async function subsForPeriod(sql: TransactionSql, orgId: string, period: string): Promise<SubscriptionRow[]> {
  const rows = await sql<SubRow[]>`
    SELECT s.id, s.project_id, n.name AS project, s.plan, s.status, s.cycle, s.starts_on::text AS starts_on,
           s.ends_on::text AS ends_on, s.terms, s.extra_channels, s.extra_agents, s.extra_numbers, s.setup_paise, s.payment_id, s.scope
    FROM subscriptions s LEFT JOIN scope_nodes n ON n.id = s.project_id
    WHERE s.org_id = ${orgId} AND s.starts_on < (${period}::date + interval '1 month')
      AND (s.ends_on IS NULL OR s.ends_on > ${period}::date)
    ORDER BY n.name, s.starts_on`;
  return rows.map(toSub);
}

/**
 * A LIVE organisation's month that is still unpaid past its grace stops the
 * plan's paid work, the way a used-up allowance does, with the month named.
 */
async function overdueRefusal(sql: TransactionSql, orgId: string, nowIso: string): Promise<string | null> {
  const today = new Date(Date.parse(nowIso) + 330 * 60_000).toISOString().slice(0, 10);
  const [r] = await sql<{ period: string }[]>`
    SELECT period::text AS period FROM plan_renewals
    WHERE org_id = ${orgId} AND status = ANY(${UNPAID as string[]})
      AND period + ${RENEWAL_GRACE_DAYS}::int <= ${today}::date
    ORDER BY period LIMIT 1`;
  return r ? overdueMessage(r.period) : null;
}

/**
 * The billing mode of an organisation, or null when no plan has been sold.
 * An account with no plan ever on it is still "no plan sold": a client that
 * filled in billing details, or started paying for a first plan and stopped,
 * is not thereby refused everything it ran before.
 */
async function modeOf(sql: TransactionSql, orgId: string): Promise<Mode | null> {
  const [row] = await sql<{ mode: Mode }[]>`
    SELECT b.mode FROM billing_accounts b
    WHERE b.org_id = ${orgId} AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id = b.org_id)`;
  return row?.mode ?? null;
}

/** The project a node counts against: itself, or the PROJECT above it. */
async function projectOf(sql: TransactionSql, orgId: string, nodeId: string | null): Promise<{ id: string; name: string } | null> {
  if (!nodeId) return null;
  const [row] = await sql<{ id: string; name: string }[]>`
    SELECT p.id, p.name FROM scope_nodes n
    JOIN scope_nodes p ON p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
    WHERE n.org_id = ${orgId} AND n.id = ${nodeId}
    LIMIT 1`;
  return row ?? null;
}

/** Every plan of the organisation that touches a month. */
async function subsIn(sql: TransactionSql, orgId: string, period: string): Promise<Sub[]> {
  const rows = await sql<SubRow[]>`
    SELECT s.id, s.project_id, n.name AS project, s.plan, s.status, s.cycle,
           s.starts_on::text AS starts_on, s.ends_on::text AS ends_on, s.terms,
           s.extra_channels, s.extra_agents, s.extra_numbers, s.setup_paise, s.payment_id, s.scope
    FROM subscriptions s LEFT JOIN scope_nodes n ON n.id = s.project_id
    WHERE s.org_id = ${orgId}
      AND s.starts_on < (${period}::date + interval '1 month')
      AND (s.ends_on IS NULL OR s.ends_on > ${period}::date)
    ORDER BY n.name NULLS FIRST, s.starts_on`;
  return rows.map(toSub);
}

type Standing = {
  mode: Mode | null;
  period: string;
  project: { id: string; name: string } | null;
  /** The plan covering the project today. */
  sub: Sub | null;
  pooled: boolean;
  allowance: Record<AllowanceUnit, number>;
  usedFromAllowance: Record<AllowanceUnit, number>;
  lots: Record<WalletUnit, (Lot & { test: boolean; unit: WalletUnit })[]>;
};

const zeroAllowance = (): Record<AllowanceUnit, number> => ({ MINUTE: 0, IMAGE: 0, CAROUSEL: 0, VIDEO: 0 });

async function lotsOf(sql: TransactionSql, orgId: string): Promise<Standing["lots"]> {
  const rows = await sql<{ id: string; unit: WalletUnit; left: string; expires_at: Date; test: boolean }[]>`
    SELECT c.id, c.unit, c.test, c.expires_at,
           c.qty - coalesce((SELECT sum(d.qty) FROM wallet_entries d WHERE d.lot_id = c.id), 0) AS left
    FROM wallet_entries c
    WHERE c.org_id = ${orgId} AND c.kind = 'CREDIT'`;
  const out = Object.fromEntries(WALLET_UNITS.map((u) => [u, [] as Standing["lots"][WalletUnit]])) as Standing["lots"];
  for (const r of rows) {
    const left = Number(r.left);
    if (left > 0) out[r.unit].push({ id: r.id, unit: r.unit, left, expiresAt: r.expires_at.toISOString(), test: r.test });
  }
  return out;
}

/**
 * Where a project stands this month: its plan, the allowance (the
 * organisation's pool from five projects), what the allowance has covered
 * so far, and the top-ups.
 */
async function standing(sql: TransactionSql, orgId: string, nodeId: string | null, nowIso: string): Promise<Standing> {
  const { period } = monthOf(nowIso);
  const today = istDate(nowIso);
  const mode = await modeOf(sql, orgId);
  const project = await projectOf(sql, orgId, nodeId);
  const empty: Standing = {
    mode,
    period,
    project,
    sub: null,
    pooled: false,
    allowance: zeroAllowance(),
    usedFromAllowance: zeroAllowance(),
    lots: Object.fromEntries(WALLET_UNITS.map((u) => [u, []])) as unknown as Standing["lots"],
  };
  if (!mode) return empty;
  const subs = await subsIn(sql, orgId, period);
  // A channel partner's plan covers the whole firm: every project draws on
  // its one allowance, so it is always the pool.
  const firmWide = subs.filter((s) => s.projectId === null);
  const firmToday = firmWide.find((s) => covers(s, today)) ?? null;
  const activeToday = subs.filter((s) => s.status === "ACTIVE" && covers(s, today));
  const pooled = !!firmToday || isPooled(new Set(activeToday.map((s) => s.projectId)).size);
  const sub = firmToday ?? (project ? (subs.find((s) => s.projectId === project.id && covers(s, today)) ?? null) : null);
  const counted = firmToday ? firmWide : pooled ? subs : subs.filter((s) => s.projectId === project?.id);
  const allowance = zeroAllowance();
  for (const s of counted) for (const u of ALLOWANCE_UNITS) allowance[u] += proratedAllowance(s.terms.allowance[u], s, period);
  const used = zeroAllowance();
  const rows = await sql<{ unit: string; used: string }[]>`
    SELECT unit, sum(from_allowance) AS used FROM usage_events
    WHERE org_id = ${orgId} AND period = ${period}
      AND ${pooled ? sql`true` : project ? sql`project_id = ${project.id}` : sql`false`}
    GROUP BY unit`;
  for (const r of rows) if (isAllowanceUnit(r.unit)) used[r.unit] = Number(r.used);
  return { mode, period, project, sub, pooled, allowance, usedFromAllowance: used, lots: await lotsOf(sql, orgId) };
}

/**
 * The plan a node's project stands on today, for what a plan opens beyond
 * the allowance (the agents' voices). `billed` false is an organisation no
 * plan was ever sold to.
 */
export async function planAt(orgId: string, nodeId: string | null, nowIso = new Date().toISOString()): Promise<{ billed: boolean; plan: PlanKey | null; projectId: string | null; agents: AgentJob[] }> {
  const s = await withTenant(orgId, (sql) => standing(sql, orgId, nodeId, nowIso));
  return {
    billed: !!s.mode,
    plan: s.sub?.plan ?? null,
    projectId: s.project?.id ?? null,
    agents: s.sub ? [...new Set([...s.sub.terms.agents, ...s.sub.extraAgents])] : [],
  };
}

/** Top-ups usable now. The real clock, never a pinned one: the database refuses an expired lot by its own. */
function walletLeft(lots: Standing["lots"]): Partial<Record<Unit, number>> {
  const now = Date.now();
  const out: Partial<Record<Unit, number>> = {};
  for (const u of WALLET_UNITS) out[u] = lots[u].filter((l) => Date.parse(l.expiresAt) > now).reduce((s, l) => s + l.left, 0);
  return out;
}

function allowanceLeft(s: Standing): Partial<Record<Unit, number>> {
  const out: Partial<Record<Unit, number>> = {};
  for (const u of ALLOWANCE_UNITS) out[u] = Math.max(0, s.allowance[u] - s.usedFromAllowance[u]);
  return out;
}

export type Entitled =
  | { ok: true; billed: false }
  | { ok: true; billed: true; terms: PlanTerms; sub: Sub }
  | { ok: false; code: "NO_PLAN" | "USED_UP" | "NOT_IN_PLAN" | "RETIRED" | "OVERDUE"; message: string };

/**
 * Whether the project a node sits in was retired (`project-life.ts`). A
 * retired project runs nothing paid, in development too: it is a decision
 * about the project, not a billing limit.
 */
async function retiredNode(orgId: string, nodeId: string | null): Promise<boolean> {
  if (!nodeId) return false;
  return withTenant(orgId, (sql) => retiredAt(sql, orgId, nodeId));
}

/**
 * May work needing `needs` run at `nodeId`? Asked before the vendor call.
 *
 * No plan sold to the organisation: yes, and nothing is counted against
 * anything (`billed: false`). A plan sold to the organisation but not to
 * this project: no. Otherwise the allowance first, then the top-ups.
 */
/**
 * A project's own limit on a shared allowance (`project-cap-rules.ts`): the
 * reason it may not spend `needs`, or null. Asked once the plan said yes.
 */
async function projectCapRefusal(sql: TransactionSql, orgId: string, s: Standing, needs: readonly Need[]): Promise<string | null> {
  if (!s.project) return null;
  const caps = await sql<{ unit: string; monthly: number }[]>`
    SELECT unit, monthly FROM project_caps WHERE org_id = ${orgId} AND project_id = ${s.project.id}`;
  if (!caps.length) return null;
  const used = await sql<{ unit: string; qty: string }[]>`
    SELECT unit, sum(qty)::text AS qty FROM usage_events
    WHERE org_id = ${orgId} AND project_id = ${s.project.id} AND period = ${s.period} AND billable
    GROUP BY unit`;
  return capRefusal({
    needs,
    caps: Object.fromEntries(caps.map((c) => [c.unit, c.monthly])),
    used: Object.fromEntries(used.map((u) => [u.unit, Number(u.qty)])),
    project: s.project.name,
  });
}

export async function entitle(opts: { orgId: string; nodeId: string | null; needs: readonly Need[]; nowIso?: string }): Promise<Entitled> {
  if (await retiredNode(opts.orgId, opts.nodeId)) return { ok: false, code: "RETIRED", message: RETIRED_MESSAGE };
  // Development (`ENVIRONMENT`) refuses nothing for billing; it is still metered.
  if (limitsLifted()) return { ok: true, billed: false };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const { s, capped, overdue } = await withTenant(opts.orgId, async (sql) => {
    const s = await standing(sql, opts.orgId, opts.nodeId, nowIso);
    return {
      s,
      capped: s.mode && s.sub ? await projectCapRefusal(sql, opts.orgId, s, opts.needs) : null,
      overdue: s.mode === "LIVE" ? await overdueRefusal(sql, opts.orgId, nowIso) : null,
    };
  });
  if (!s.mode) return { ok: true, billed: false };
  if (!s.sub) return { ok: false, code: "NO_PLAN", message: NO_PLAN_MESSAGE };
  if (overdue) return { ok: false, code: "OVERDUE", message: overdue };
  const verdict = decide(opts.needs, allowanceLeft(s), walletLeft(s.lots));
  if (!verdict.ok) {
    return { ok: false, code: "USED_UP", message: usedUpMessage(verdict.unit, s.project?.name ?? null, purchasingOpen(s.mode)) };
  }
  if (capped) return { ok: false, code: "USED_UP", message: capped };
  return { ok: true, billed: true, terms: s.sub.terms, sub: s.sub };
}

export type CallAllowance =
  | { billed: false }
  | {
      billed: true;
      ok: true;
      channels: number;
      /**
       * The lines belong to the whole organisation, not the project: a
       * channel partner's plan sells its calls at once once, for every
       * project it covers, so they are counted across all of them.
       */
      wide: boolean;
    }
  | { billed: true; ok: false; code: "NO_PLAN" | "USED_UP" | "NOT_IN_PLAN" | "RETIRED" | "OVERDUE"; message: string };

/**
 * Before a call is placed: the agent's job must be on the project's plan (or
 * bought for it on Launch), a minute must be left in the allowance or the
 * top-ups, and the plan says how many calls may run at once: per project
 * on a project's plan, across the organisation on a channel partner's.
 * Voices are never asked about: every plan has all four.
 */
export async function callAllowance(opts: { orgId: string; nodeId: string; agent: string; nowIso?: string }): Promise<CallAllowance> {
  if (await retiredNode(opts.orgId, opts.nodeId)) return { billed: true, ok: false, code: "RETIRED", message: RETIRED_MESSAGE };
  if (limitsLifted()) return { billed: false };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const { s, capped, overdue } = await withTenant(opts.orgId, async (sql) => {
    const s = await standing(sql, opts.orgId, opts.nodeId, nowIso);
    return {
      s,
      capped: s.mode && s.sub ? await projectCapRefusal(sql, opts.orgId, s, [{ unit: "MINUTE", qty: 1 }]) : null,
      overdue: s.mode === "LIVE" ? await overdueRefusal(sql, opts.orgId, nowIso) : null,
    };
  });
  if (!s.mode) return { billed: false };
  if (!s.sub) return { billed: true, ok: false, code: "NO_PLAN", message: NO_PLAN_MESSAGE };
  if (overdue) return { billed: true, ok: false, code: "OVERDUE", message: overdue };
  const job = agentJobFor(opts.agent);
  if (!s.sub.terms.agents.includes(job) && !s.sub.extraAgents.includes(job)) {
    return {
      billed: true,
      ok: false,
      code: "NOT_IN_PLAN",
      message: `The ${AGENT_JOB_LABEL[job]} is not on ${s.project?.name ?? "this project"}'s ${s.sub.terms.label} plan.`,
    };
  }
  const verdict = decide([{ unit: "MINUTE", qty: 1 }], allowanceLeft(s), walletLeft(s.lots));
  if (!verdict.ok) return { billed: true, ok: false, code: "USED_UP", message: usedUpMessage("MINUTE", s.project?.name ?? null, purchasingOpen(s.mode)) };
  if (capped) return { billed: true, ok: false, code: "USED_UP", message: capped };
  return { billed: true, ok: true, channels: s.sub.terms.channels + s.sub.extraChannels, wide: s.sub.projectId === null };
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

export type MeterInput = {
  orgId: string;
  nodeId: string | null;
  kind: UsageKind;
  /** In the kind's unit; a hand-off minute is weighted by the caller. */
  qty: number;
  costPaise: number;
  billable: boolean;
  source: { kind: "call" | "post" | "creative" | "ask_message" | "message" | "visit_note" | "calling_number"; id: string };
  atIso?: string;
};

/**
 * Record one outcome. Idempotent on its source: the second call for the same
 * source and kind writes nothing. Under a per-organisation lock, the amount
 * is covered from the allowance, then from the top-ups soonest to expire,
 * and whatever neither holds is recorded as over, never hidden.
 *
 * Returns whether a row was written.
 */
export async function meter(m: MeterInput): Promise<boolean> {
  const atIso = m.atIso ?? new Date().toISOString();
  const unit = KIND_UNIT[m.kind];
  const qty = m.billable ? Math.max(0, Math.round(m.qty * 100) / 100) : 0;
  return withTenant(m.orgId, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${m.orgId}`}, 0))`;
    const [dupe] = await sql`
      SELECT 1 FROM usage_events
      WHERE org_id = ${m.orgId} AND source_kind = ${m.source.kind} AND source_id = ${m.source.id} AND kind = ${m.kind}`;
    if (dupe) return false;
    const s = await standing(sql, m.orgId, m.nodeId, atIso);
    const plan = s.mode && s.sub ? s.sub.plan : null;
    let parts = { allowance: 0, wallet: 0, over: 0 };
    let draws: { lotId: string; qty: number }[] = [];
    if (plan && qty > 0) {
      // A question is inside its own allowance, which Ask Jimmy checks; a
      // number's month inside the plan's numbers, which renting checked.
      const allowance = unit === "QUESTION" || unit === "NUMBER" ? qty : isAllowanceUnit(unit) ? Math.max(0, s.allowance[unit] - s.usedFromAllowance[unit]) : 0;
      const lots = isWalletUnit(unit) ? s.lots[unit] : [];
      const inWallet = lots.filter((l) => Date.parse(l.expiresAt) > Date.now()).reduce((a, l) => a + l.left, 0);
      parts = split(qty, allowance, inWallet);
      draws = parts.wallet > 0 ? drawFrom(lots, parts.wallet, new Date().toISOString()) : [];
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO usage_events (org_id, project_id, node_id, kind, unit, qty, from_allowance, from_wallet, over,
                                billable, plan, cost_paise, source_kind, source_id, period, occurred_at)
      VALUES (${m.orgId}, ${s.project?.id ?? null}, ${m.nodeId}, ${m.kind}, ${unit}, ${qty},
              ${parts.allowance}, ${parts.wallet}, ${parts.over}, ${m.billable}, ${plan},
              ${Math.max(0, Math.round(m.costPaise))}, ${m.source.kind}, ${m.source.id}, ${s.period}, ${atIso})
      ON CONFLICT (org_id, source_kind, source_id, kind) DO NOTHING
      RETURNING id`;
    if (!row) return false;
    for (const d of draws) {
      await sql`
        INSERT INTO wallet_entries (org_id, kind, unit, qty, lot_id, source, usage_id)
        VALUES (${m.orgId}, 'DRAW', ${unit}, ${d.qty}, ${d.lotId}, 'USAGE', ${row.id})`;
    }
    return true;
  });
}

/**
 * Metering must never break the work it counts. A failure is logged and
 * left for `meterMissed()`, which finds the outcome again from its source.
 */
export async function meterQuietly(m: MeterInput): Promise<void> {
  try {
    await meter(m);
  } catch (e) {
    console.error(`billing: could not meter ${m.kind} for ${m.source.kind} ${m.source.id}`, e);
  }
}

export type PostOutcome = {
  orgId: string;
  nodeId: string;
  postId: string;
  kind: "IMAGE" | "CAROUSEL" | "VIDEO";
  /** Frames delivered: a carousel's slides. */
  frames: number;
  passed: boolean;
  /** Image-model calls made, and the art director's dollars. */
  attempts: number;
  agentUsd?: number;
  /** A video's paid clips, when the review counted them. */
  clips?: number;
  source?: "post" | "creative";
  atIso?: string;
};

/** A carousel of more than five slides needs this many slide top-ups. */
export const extraSlides = (slides: number) => Math.max(0, slides - CAROUSEL_SLIDES);

/**
 * A designed post. The client pays for a post that passed and nothing for
 * one that did not; either way what the attempts cost us is recorded.
 */
export async function meterPost(p: PostOutcome): Promise<void> {
  const clips = p.kind === "VIDEO" ? (p.clips ?? (p.passed ? 3 : 0)) : 0;
  const cost = p.attempts * COST_PAISE.DESIGN_ATTEMPT + usdToPaise(p.agentUsd ?? 0) + clips * COST_PAISE.VIDEO_CLIP;
  const main: UsageKind = p.kind === "IMAGE" ? "IMAGE_POST" : p.kind === "CAROUSEL" ? "CAROUSEL" : "VIDEO";
  const source = { kind: p.source ?? "post", id: p.postId } as const;
  await meterQuietly({ orgId: p.orgId, nodeId: p.nodeId, kind: main, qty: 1, costPaise: cost, billable: p.passed, source, atIso: p.atIso });
  if (p.passed && p.kind === "CAROUSEL" && extraSlides(p.frames) > 0) {
    await meterQuietly({ orgId: p.orgId, nodeId: p.nodeId, kind: "EXTRA_SLIDE", qty: extraSlides(p.frames), costPaise: 0, billable: true, source, atIso: p.atIso });
  }
}

/** What a post of this kind needs, for `entitle()` before it is designed. */
export function postNeeds(kind: "IMAGE" | "CAROUSEL" | "VIDEO", slides?: number | null): Need[] {
  if (kind === "IMAGE") return [{ unit: "IMAGE", qty: 1 }];
  if (kind === "VIDEO") return [{ unit: "VIDEO", qty: 1 }];
  return [
    { unit: "CAROUSEL", qty: 1 },
    { unit: "SLIDE", qty: extraSlides(slides ?? CAROUSEL_SLIDES) },
  ];
}

/** A finished video from the worker: a story reel, a film, or a film's new version. */
export async function meterVideo(v: { orgId: string; nodeId: string; postId: string; kind: "STORY_REEL" | "FILM" | "FILM_VERSION"; units: number; passed: boolean; atIso?: string }): Promise<void> {
  const cost = v.kind === "FILM" ? COST_PAISE.FILM : v.kind === "FILM_VERSION" ? COST_PAISE.FILM_VERSION : COST_PAISE.STORY_REEL;
  await meterQuietly({
    orgId: v.orgId,
    nodeId: v.nodeId,
    kind: v.kind,
    qty: v.units,
    costPaise: cost,
    billable: v.passed,
    source: { kind: "post", id: v.postId },
    atIso: v.atIso,
  });
}

/**
 * A call's minutes, once Sarvam or Vobiz has said how long it ran. A
 * connected minute is one AI minute; a minute with a sales person after a
 * hand-off counts as a quarter of one. Safe to call on every webhook.
 */
export async function meterCall(orgId: string, callId: string): Promise<void> {
  try {
    const [c] = await withTenant(orgId, (sql) => sql<{ scope_node_id: string; duration_s: number | null; handoff_bill_s: number | null; placed_at: Date }[]>`
      SELECT scope_node_id, duration_s, handoff_bill_s, placed_at FROM calls WHERE org_id = ${orgId} AND id = ${callId}`);
    if (!c) return;
    const at = c.placed_at.toISOString();
    if ((c.duration_s ?? 0) > 0) {
      const minutes = Math.ceil(c.duration_s! / 60);
      await meterQuietly({ orgId, nodeId: c.scope_node_id, kind: "CALL_MINUTE", qty: minutes, costPaise: minutes * COST_PAISE.CALL_MINUTE, billable: true, source: { kind: "call", id: callId }, atIso: at });
    }
    if ((c.handoff_bill_s ?? 0) > 0) {
      const minutes = Math.ceil(c.handoff_bill_s! / 60);
      await meterQuietly({ orgId, nodeId: c.scope_node_id, kind: "HANDOFF_MINUTE", qty: minutes * HANDOFF_WEIGHT, costPaise: minutes * COST_PAISE.HANDOFF_MINUTE, billable: true, source: { kind: "call", id: callId }, atIso: at });
    }
  } catch (e) {
    console.error(`billing: could not meter call ${callId}`, e);
  }
}

/** One Ask Jimmy question that reached a model, with what it cost. */
export async function meterQuestion(orgId: string, messageId: string | null, usd: number): Promise<void> {
  await meterQuietly({
    orgId,
    nodeId: null,
    kind: "QUESTION",
    qty: 1,
    costPaise: usdToPaise(usd),
    billable: true,
    source: { kind: "ask_message", id: messageId ?? randomUUID() },
  });
}

/** A WhatsApp message Meta delivered: its price plus 15%, in paise. */
export async function meterMessage(orgId: string, messageId: string): Promise<void> {
  try {
    const [m] = await withTenant(orgId, (sql) => sql<{ cost_paise: number | null; node: string | null; at: Date }[]>`
      SELECT m.cost_paise, coalesce(l.scope_node_id, m.scope_node_id) AS node, coalesce(m.sent_at, m.created_at) AS at
      FROM messages m LEFT JOIN leads l ON l.id = m.lead_id
      WHERE m.org_id = ${orgId} AND m.id = ${messageId} AND m.direction = 'OUT'
        AND m.status IN ('DELIVERED', 'READ')`);
    if (!m || !m.cost_paise) return;
    await meterQuietly({
      orgId,
      nodeId: m.node,
      kind: "WHATSAPP",
      qty: passThroughPaise(m.cost_paise),
      costPaise: m.cost_paise,
      billable: true,
      source: { kind: "message", id: messageId },
      atIso: m.at.toISOString(),
    });
  } catch (e) {
    console.error(`billing: could not meter message ${messageId}`, e);
  }
}

/** Before a WhatsApp goes: is there credit for its price plus 15%? */
export async function messageAllowed(orgId: string, nodeId: string | null, costPaise: number): Promise<Entitled> {
  if (costPaise <= 0) return { ok: true, billed: false };
  return entitle({ orgId, nodeId, needs: [{ unit: "WHATSAPP", qty: passThroughPaise(costPaise) }] });
}

/**
 * Outcomes the inline meter missed (a crash between the work and the
 * count, a webhook that arrived while the database was away), found again
 * from their own rows. Idempotent, so the worker runs it every pass.
 */
export async function meterMissed(orgId: string, sinceIso: string): Promise<number> {
  const found = await withTenant(orgId, async (sql) => {
    const calls = await sql<{ id: string }[]>`
      SELECT c.id FROM calls c
      WHERE c.org_id = ${orgId} AND c.placed_at >= ${sinceIso}
        AND ((c.duration_s > 0 AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.org_id = c.org_id AND u.source_kind = 'call' AND u.source_id = c.id::text AND u.kind = 'CALL_MINUTE'))
          OR (c.handoff_bill_s > 0 AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.org_id = c.org_id AND u.source_kind = 'call' AND u.source_id = c.id::text AND u.kind = 'HANDOFF_MINUTE')))
      LIMIT 200`;
    const posts = await sql<{ id: string; node: string; kind: "IMAGE" | "CAROUSEL" | "VIDEO"; frames: number; passed: boolean; attempts: number; usd: number; clips: number | null; format: string | null; units: number | null; revision: boolean; at: Date }[]>`
      SELECT p.id, p.scope_node_id AS node, p.kind, jsonb_array_length(coalesce(p.media, '[]'::jsonb)) AS frames,
             coalesce((p.review ->> 'passed')::boolean, false) AS passed,
             coalesce((p.review ->> 'attempts')::int, 0) AS attempts,
             coalesce((p.review -> 'agent' ->> 'usd')::numeric, 0)::float8 AS usd,
             (p.review -> 'motion' ->> 'attempts')::int AS clips,
             p.inputs ->> 'format' AS format,
             (p.inputs -> 'film' ->> 'units')::int AS units,
             (p.inputs -> 'film' ->> 'revisionOf') IS NOT NULL AS revision,
             p.created_at AS at
      FROM rendered_posts p
      WHERE p.org_id = ${orgId} AND p.created_at >= ${sinceIso}
        AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.org_id = p.org_id AND u.source_kind = 'post' AND u.source_id = p.id::text)
      LIMIT 200`;
    const messages = await sql<{ id: string }[]>`
      SELECT m.id FROM messages m
      WHERE m.org_id = ${orgId} AND m.direction = 'OUT' AND m.status IN ('DELIVERED', 'READ') AND m.cost_paise > 0
        AND m.created_at >= ${sinceIso}
        AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.org_id = m.org_id AND u.source_kind = 'message' AND u.source_id = m.id::text)
      LIMIT 500`;
    return { calls, posts, messages };
  });
  for (const c of found.calls) await meterCall(orgId, c.id);
  for (const p of found.posts) {
    const at = p.at.toISOString();
    if (p.units !== null) await meterVideo({ orgId, nodeId: p.node, postId: p.id, kind: p.revision ? "FILM_VERSION" : "FILM", units: p.units, passed: p.passed, atIso: at });
    else if (p.format === "story") await meterVideo({ orgId, nodeId: p.node, postId: p.id, kind: "STORY_REEL", units: 1, passed: p.passed, atIso: at });
    else await meterPost({ orgId, nodeId: p.node, postId: p.id, kind: p.kind, frames: p.frames, passed: p.passed, attempts: p.attempts, agentUsd: p.usd, clips: p.clips ?? undefined, atIso: at });
  }
  for (const m of found.messages) await meterMessage(orgId, m.id);
  return found.calls.length + found.posts.length + found.messages.length;
}

/** Write an EXPIRE row for every top-up past its date that still held something. */
export async function expireLots(orgId: string): Promise<number> {
  return withTenant(orgId, async (sql) => {
    const lots = await sql<{ id: string; unit: string; left: string }[]>`
      SELECT c.id, c.unit, c.qty - coalesce((SELECT sum(d.qty) FROM wallet_entries d WHERE d.lot_id = c.id), 0) AS left
      FROM wallet_entries c
      WHERE c.org_id = ${orgId} AND c.kind = 'CREDIT' AND c.expires_at <= now()
        AND NOT EXISTS (SELECT 1 FROM wallet_entries e WHERE e.lot_id = c.id AND e.kind = 'EXPIRE')`;
    let n = 0;
    for (const l of lots) {
      if (Number(l.left) <= 0) continue;
      await sql`
        INSERT INTO wallet_entries (org_id, kind, unit, qty, lot_id, source)
        VALUES (${orgId}, 'EXPIRE', ${l.unit}, ${Number(l.left)}, ${l.id}, 'EXPIRY')
        ON CONFLICT DO NOTHING`;
      n++;
    }
    return n;
  });
}

// ---------------------------------------------------------------------------
// What the screens read
// ---------------------------------------------------------------------------

export type UnitStanding = { unit: AllowanceUnit; allowance: number; used: number; level: "ok" | "warn" | "out" };

export type ProjectStanding = {
  id: string;
  name: string;
  sub: { plan: PlanKey; label: string; status: "PILOT" | "ACTIVE"; cycle: "MONTHLY" | "ANNUAL"; startsOn: string; endsOn: string | null; channels: number; agents: AgentJob[]; pricePaise: number } | null;
  units: UnitStanding[];
};

export type WalletStanding = { unit: WalletUnit; left: number; lots: { left: number; expiresAt: string; test: boolean }[] };

export type Overview = {
  mode: Mode | null;
  period: string;
  pooled: boolean;
  projects: ProjectStanding[];
  /** The pool, when minutes and posts are shared across five or more projects. */
  pool: UnitStanding[] | null;
  wallet: WalletStanding[];
  questions: { used: number; allowance: number };
  account: { billName: string; billGstin: string | null; billAddress: string | null; billState: string | null; billEmail: string | null } | null;
};

/**
 * Everything Settings, Plan and usage shows, and what Today warns about: per
 * project, its plan, this month's allowance and what has been used of it;
 * the top-ups with their dates; and the organisation's questions.
 */
export async function overview(orgId: string, nowIso = new Date().toISOString()): Promise<Overview> {
  return withTenant(orgId, async (sql) => {
    const { period } = monthOf(nowIso);
    const today = istDate(nowIso);
    const [acct] = await sql<{ mode: Mode; bill_name: string | null; bill_gstin: string | null; bill_address: string | null; bill_state: string | null; bill_email: string | null; legal_name: string; gstin: string | null }[]>`
      SELECT b.mode, b.bill_name, b.bill_gstin, b.bill_address, b.bill_state, b.bill_email::text AS bill_email, o.legal_name, o.gstin
      FROM orgs o LEFT JOIN billing_accounts b ON b.org_id = o.id
      WHERE o.id = ${orgId}`;
    const mode = acct?.mode ?? null;
    const projects = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT' ORDER BY name`;
    const subs = mode ? await subsIn(sql, orgId, period) : [];
    const firmWide = subs.filter((s) => s.projectId === null);
    const firmToday = firmWide.find((s) => covers(s, today)) ?? null;
    const activeToday = subs.filter((s) => s.status === "ACTIVE" && covers(s, today));
    const pooled = !!firmToday || isPooled(new Set(activeToday.map((s) => s.projectId)).size);
    const usage = await sql<{ project_id: string | null; unit: string; used: string }[]>`
      SELECT project_id, unit, sum(from_allowance) AS used FROM usage_events
      WHERE org_id = ${orgId} AND period = ${period} GROUP BY project_id, unit`;
    const usedBy = (pid: string | null, u: AllowanceUnit) =>
      usage.filter((r) => (pid === null || r.project_id === pid) && r.unit === u).reduce((s, r) => s + Number(r.used), 0);
    const unitsFor = (list: Sub[], pid: string | null): UnitStanding[] =>
      ALLOWANCE_UNITS.map((u) => {
        const allowance = list.reduce((s, x) => s + proratedAllowance(x.terms.allowance[u], x, period), 0);
        const used = usedBy(pid, u);
        return { unit: u, allowance, used, level: level(used, allowance) };
      });
    const out: ProjectStanding[] = projects.map((p) => {
      // A channel partner's projects all stand on the firm's one plan.
      const mine = firmToday ? firmWide : subs.filter((s) => s.projectId === p.id);
      const now = firmToday ?? mine.find((s) => covers(s, today)) ?? null;
      return {
        id: p.id,
        name: p.name,
        sub: now
          ? {
              plan: now.plan,
              label: now.terms.label,
              status: now.status,
              cycle: now.cycle,
              startsOn: now.startsOn,
              endsOn: now.endsOn,
              channels: now.terms.channels + now.extraChannels,
              agents: [...new Set([...now.terms.agents, ...now.extraAgents])],
              pricePaise: now.terms.pricePaise,
            }
          : null,
        units: mine.length ? unitsFor(mine, p.id) : [],
      };
    });
    const lots = mode ? await lotsOf(sql, orgId) : (Object.fromEntries(WALLET_UNITS.map((u) => [u, []])) as unknown as Standing["lots"]);
    const now = Date.now();
    const wallet: WalletStanding[] = WALLET_UNITS.map((u) => {
      const live = lots[u].filter((l) => Date.parse(l.expiresAt) > now).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
      return { unit: u, left: live.reduce((s, l) => s + l.left, 0), lots: live.map((l) => ({ left: l.left, expiresAt: l.expiresAt, test: l.test })) };
    });
    const [asked] = await sql<{ n: number }[]>`
      SELECT coalesce(sum(questions), 0)::int AS n FROM ask_usage
      WHERE org_id = ${orgId} AND day >= ${period}::date AND day < (${period}::date + interval '1 month')`;
    const subscribed = new Set(subs.filter((s) => covers(s, today)).map((s) => s.projectId)).size;
    return {
      mode,
      period,
      pooled,
      projects: out,
      pool: pooled ? unitsFor(firmToday ? firmWide : subs, null) : null,
      wallet,
      // A channel partner's plan sells its questions once, for the whole business.
      questions: { used: asked?.n ?? 0, allowance: firmToday ? firmToday.terms.questions : PLANS.LAUNCH.questions * Math.max(1, mode ? subscribed : projects.length) },
      account: acct?.mode
        ? {
            billName: acct.bill_name ?? acct.legal_name,
            billGstin: acct.bill_gstin ?? acct.gstin,
            billAddress: acct.bill_address,
            billState: acct.bill_state ?? (acct.bill_gstin ?? acct.gstin)?.slice(0, 2) ?? null,
            billEmail: acct.bill_email,
          }
        : null,
    };
  });
}

/** The words for one allowance line on Today. */
export function billingAlerts(o: Overview): { id: string; severity: "risk" | "warn"; title: string; why: string; tag: string }[] {
  if (!o.mode) return [];
  const out: { id: string; severity: "risk" | "warn"; title: string; why: string; tag: string }[] = [];
  const wallet = new Map(o.wallet.map((w) => [w.unit, w.left]));
  const lines: { key: string; name: string | null; units: UnitStanding[] }[] = o.pool
    ? [{ key: "pool", name: null, units: o.pool }]
    : o.projects.filter((p) => p.sub).map((p) => ({ key: p.id, name: p.name, units: p.units }));
  for (const l of lines) {
    for (const u of l.units) {
      if (u.level === "ok" || u.allowance <= 0) continue;
      const topUps = wallet.get(u.unit) ?? 0;
      const words = u.unit === "MINUTE" ? "AI call minutes" : `${u.unit === "IMAGE" ? "image posts" : u.unit === "CAROUSEL" ? "carousels" : "videos"}`;
      const who = l.name ?? "Your projects";
      if (u.level === "out" && topUps <= 0) {
        out.push({
          id: `billing-out-${l.key}-${u.unit}`,
          severity: "risk",
          title: `${who}: no ${words} left this month`,
          why: u.unit === "MINUTE" ? "The AI caller has stopped for this project until the month turns or minutes are topped up." : `Nothing more of this kind can be made this month until it is topped up.`,
          tag: "Stopped",
        });
      } else if (u.level === "warn" && topUps <= 0) {
        const pct = Math.floor((u.used / u.allowance) * 100);
        out.push({
          id: `billing-warn-${l.key}-${u.unit}`,
          severity: "warn",
          title: `${who}: ${pct}% of this month's ${words} used`,
          why: `${Math.max(0, Math.round((u.allowance - u.used) * 100) / 100).toLocaleString("en-IN")} of ${u.allowance.toLocaleString("en-IN")} left, and no top-ups. At zero this stops.`,
          tag: `${pct}%`,
        });
      }
    }
  }
  for (const w of o.wallet) {
    if (w.unit !== "WHATSAPP" || w.left > 0) continue;
    const anyPlan = o.projects.some((p) => p.sub);
    if (anyPlan) {
      out.push({
        id: "billing-out-whatsapp",
        severity: "risk",
        title: "No WhatsApp credit left",
        why: "Directions, visit reminders and follow-ups are not going out until WhatsApp credit is topped up.",
        tag: "Stopped",
      });
    }
  }
  return out;
}

/** Whether any plan has been sold to this organisation. */
export async function hasPlan(orgId: string): Promise<boolean> {
  return (await withTenant(orgId, (sql) => modeOf(sql, orgId))) !== null;
}

/**
 * Who the invoices are made out to. Only an organisation that has been sold
 * a plan has a billing account; the row is the operator's to create. The
 * audit row names which fields changed and never their values.
 */
export async function saveBillingDetails(opts: { orgId: string; userId: string; input: Record<string, unknown> }): Promise<{ ok: true; changed: number } | { ok: false; message: string }> {
  const read = readBillingDetails(opts.input);
  if (!read.ok) return { ok: false, message: read.problems.join(" ") };
  const v = read.value;
  const out = await withTenant(opts.orgId, async (sql) => {
    const [before] = await sql<{ bill_name: string | null; bill_gstin: string | null; bill_address: string | null; bill_state: string | null; bill_email: string | null }[]>`
      SELECT bill_name, bill_gstin, bill_address, bill_state, bill_email::text AS bill_email FROM billing_accounts WHERE org_id = ${opts.orgId}`;
    if (!before) return null;
    const changed = (
      [
        ["name", before.bill_name, v.name],
        ["gstin", before.bill_gstin, v.gstin],
        ["address", before.bill_address, v.address],
        ["state", before.bill_state, v.state],
        ["email", before.bill_email, v.email],
      ] as const
    ).filter(([, a, b]) => (a ?? null) !== (b ?? null)).map(([k]) => k);
    if (!changed.length) return [] as string[];
    await sql`
      UPDATE billing_accounts
      SET bill_name = ${v.name}, bill_gstin = ${v.gstin}, bill_address = ${v.address}, bill_state = ${v.state},
          bill_email = ${v.email}, updated_by = ${opts.userId}, updated_at = now()
      WHERE org_id = ${opts.orgId}`;
    return changed;
  });
  if (out === null) return { ok: false, message: "This organisation has no plan yet, so there is nothing to invoice." };
  if (out.length) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "billing.details_changed", targetType: "org", targetId: opts.orgId, metadata: { fields: out } });
  }
  return { ok: true, changed: out.length };
}

/**
 * Today's billing items. One query for a tenant with no plan sold, which is
 * every tenant until one is; and a failure here never costs the queue.
 */
export async function billingQueue(orgId: string, nowIso = new Date().toISOString()): Promise<ReturnType<typeof billingAlerts>> {
  try {
    const mode = await withTenant(orgId, (sql) => modeOf(sql, orgId));
    if (!mode) return [];
    const [o, open, renewals] = await Promise.all([
      overview(orgId, nowIso),
      withTenant(orgId, (sql) => sql<{ id: string; status: ChargeStatus; sku: string; qty: number; total_paise: string; due_at: Date | null }[]>`
        SELECT id, status, sku, qty, total_paise, due_at FROM auto_topup_charges
        WHERE org_id = ${orgId} AND status IN ('NOTIFIED', 'AWAITING_APPROVAL')`),
      // A month's plan is said only once it is money: a LIVE organisation's.
      mode === "LIVE"
        ? withTenant(orgId, (sql) => sql<{ id: string; status: RenewalStatus; period: string; total_paise: string; due_at: Date | null }[]>`
            SELECT id, status, period::text AS period, total_paise, due_at FROM plan_renewals
            WHERE org_id = ${orgId} AND status IN ('NOTIFIED', 'AWAITING_APPROVAL')`)
        : Promise.resolve([]),
    ]);
    const today = new Date(Date.parse(nowIso) + 330 * 60_000).toISOString().slice(0, 10);
    const renew = renewalAlerts(
      renewals.map((r) => ({ id: r.id, status: r.status, period: r.period, totalPaise: Number(r.total_paise), dueAt: r.due_at?.toISOString() ?? null })),
      today,
      (p) => rupees(p, true),
    );
    const auto = autoAlerts(
      open.map((c) => ({
        id: c.id,
        status: c.status,
        label: `${c.qty > 1 ? `${c.qty} x ` : ""}${skuByKey(c.sku)?.label ?? c.sku}`,
        totalPaise: Number(c.total_paise),
        dueAt: c.due_at?.toISOString() ?? null,
      })),
    );
    return [...renew, ...auto, ...billingAlerts(o)];
  } catch (e) {
    console.error("billing: Today's items could not be read", e);
    return [];
  }
}

export { level, termsFor } from "./billing-rules.ts";
export type { Need, Unit } from "./billing-rules.ts";
