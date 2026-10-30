import {
  plansFor,
  coveredDays,
  isPlanKey,
  proratedPrice,
  projectDiscount,
  setupFor,
  type InvoiceLine,
  type PlanKey,
  type PlanTerms,
  sellerFromEnv,
} from "./billing-rules.ts";
import { isDevelopment, isProduction } from "./app-env.ts";

/**
 * Buying a plan in the console: the pure half, client-safe.
 *
 * Decided with the client on 4 October 2026. Each company pays for its own
 * work and nothing is shared between them:
 *
 *   * A developer or a mandate firm buys a plan for ONE project, before the
 *     project exists, in production. The plan applies to that project only.
 *   * A channel partner buys ONE plan for the whole firm and spreads it
 *     across its projects up to the plan's project cap
 *     (`PlanTerms.projects`). Since 6 October 2026 those are its own three
 *     plans, Solo, Team and Firm (`PARTNER_PLANS`), priced per firm a month.
 *   * Development is free: projects are created as they always were.
 */

export type PlanScope = "PROJECT" | "ORG";

/** A channel partner's plan covers the firm; everybody else's one project. */
export const planScopeFor = (orgType: string | null | undefined): PlanScope => (orgType === "CHANNEL_PARTNER" ? "ORG" : "PROJECT");

/**
 * Whether a plan may be bought here: Razorpay's test keys off a production
 * host, live keys only with our GSTIN to invoice under (`BILLING_SELLER_*`).
 */
export function plansSellable(env: Record<string, string | undefined>): boolean {
  const keyId = env.RAZORPAY_KEY_ID?.trim() ?? "";
  if (!keyId || !env.RAZORPAY_KEY_SECRET?.trim()) return false;
  if (keyId.startsWith("rzp_test_")) return !(env.NODE_ENV === "production" || !!env.VERCEL);
  return sellerFromEnv(env).ok;
}

/**
 * Whether a plan comes before a project here: in production, and only where
 * a plan can actually be bought. Until then (no live keys or no GSTIN) a
 * project is created free, as in development, rather than behind a button
 * that cannot be pressed (the client, 17 October 2026).
 */
export function planRequired(env: Record<string, string | undefined>): boolean {
  return isProduction(env) && plansSellable(env);
}

/**
 * Whether the limits that protect our money are lifted here: plans,
 * allowances and top-ups, the calling minute allowance, Ask Jimmy's limits,
 * a schedule's daily cap and the stories at once. In development, and also
 * wherever a plan cannot yet be bought (the client, 17 October 2026): a
 * limit nobody can pay to lift only stops the work. Calling hours and the
 * work-account bar stay on `ENVIRONMENT` alone, because they protect buyers
 * and accounts, not our bill.
 */
export function limitsLifted(env: Record<string, string | undefined> = process.env): boolean {
  return isDevelopment(env) || !plansSellable(env);
}

export const readPlanKey = (raw: unknown): PlanKey | null => (typeof raw === "string" && isPlanKey(raw) ? raw : null);

/** Projects a firm-wide plan still has room for. */
export const slotsLeft = (terms: Pick<PlanTerms, "projects">, projects: number) => Math.max(0, terms.projects - projects);

export type ProjectGate =
  /** No plan needed here (development, or the gate switched off). */
  | { kind: "FREE" }
  /** A developer or mandate firm: a plan is bought with the project. */
  | { kind: "BUY_WITH_PROJECT" }
  /** A channel partner with room on its plan. */
  | { kind: "FIRM_PLAN"; plan: string; left: number; cap: number }
  /** A channel partner with no plan yet. */
  | { kind: "NEED_FIRM_PLAN" }
  /** A channel partner whose plan is full. */
  | { kind: "FIRM_FULL"; plan: string; cap: number };

/** What creating a project needs, decided from what the tenant holds today. */
export function projectGate(o: { required: boolean; scope: PlanScope; firmPlan: PlanTerms | null; projects: number }): ProjectGate {
  if (!o.required) return { kind: "FREE" };
  if (o.scope === "PROJECT") return { kind: "BUY_WITH_PROJECT" };
  if (!o.firmPlan) return { kind: "NEED_FIRM_PLAN" };
  const left = slotsLeft(o.firmPlan, o.projects);
  return left > 0
    ? { kind: "FIRM_PLAN", plan: o.firmPlan.label, left, cap: o.firmPlan.projects }
    : { kind: "FIRM_FULL", plan: o.firmPlan.label, cap: o.firmPlan.projects };
}

/** Why a project may not be created this way, in the screen's words, or null. */
export function gateRefusal(g: ProjectGate): string | null {
  switch (g.kind) {
    case "FREE":
    case "FIRM_PLAN":
      return null;
    case "BUY_WITH_PROJECT":
      return "Choose a plan for this project first.";
    case "NEED_FIRM_PLAN":
      return "Choose a plan for your firm first.";
    case "FIRM_FULL":
      return `Your ${g.plan} plan covers ${g.cap} projects, and you have ${g.cap}. Move to a bigger plan to add another.`;
  }
}

const monthWords = (period: string) =>
  new Date(`${period}T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * What the first payment is: this month's plan from today, prorated the way
 * the monthly invoice prorates it, less the multi-project discount for a
 * project plan, plus the setup fee. Priced the same in the browser and on
 * the server, and the server's is the one charged.
 */
export function firstPaymentLines(o: {
  plan: PlanKey;
  scope: PlanScope;
  /** Today in India, YYYY-MM-DD. */
  today: string;
  /** What the line names: the project, or the firm. */
  forName: string;
  /** Plans this tenant has held before (any project), for the setup fee. */
  earlierPlans: number;
  hadPilot: boolean;
  /** Project plans active this month once this one is added. */
  activeAfter: number;
}): Omit<InvoiceLine, "amountPaise" | "sac">[] {
  const terms = plansFor(o.scope)[o.plan];
  const period = `${o.today.slice(0, 7)}-01`;
  const sub = { startsOn: o.today, endsOn: null };
  const off = o.scope === "PROJECT" ? projectDiscount(o.activeAfter) : 0;
  const [y, m] = period.split("-").map(Number);
  const part = coveredDays(sub, period) < new Date(Date.UTC(y, m, 0)).getUTCDate();
  const price = Math.round((proratedPrice(terms.pricePaise, sub, period) * (100 - off)) / 100);
  const lines: Omit<InvoiceLine, "amountPaise" | "sac">[] = [
    {
      description: `${o.forName}: ${terms.label} plan, ${monthWords(period)}${part ? ", from " + Number(o.today.slice(8, 10)) : ""}${off ? `, ${off}% multi-project discount` : ""}`,
      qty: 1,
      unitPaise: price,
    },
  ];
  const setup = setupFor({ earlierPlans: o.earlierPlans, hadPilot: o.hadPilot, scope: o.scope });
  if (setup > 0) lines.push({ description: `${o.forName}: setup`, qty: 1, unitPaise: setup });
  return lines;
}

/** One plan as the picker shows it. */
export type PlanCard = {
  key: PlanKey;
  label: string;
  pricePaise: number;
  minutes: number;
  posts: number;
  carousels: number;
  videos: number;
  channels: number;
  projects: number;
};

/** The plans the picker offers: a project's for a developer or mandate firm, a firm's for a channel partner. */
export const planCards = (scope: PlanScope = "PROJECT"): PlanCard[] => {
  const plans = plansFor(scope);
  return (Object.keys(plans) as PlanKey[]).map((k) => ({
    key: k,
    label: plans[k].label,
    pricePaise: plans[k].pricePaise,
    minutes: plans[k].allowance.MINUTE,
    posts: plans[k].allowance.IMAGE,
    carousels: plans[k].allowance.CAROUSEL,
    videos: plans[k].allowance.VIDEO,
    channels: plans[k].channels,
    projects: plans[k].projects,
  }));
};

export const PLAN_CARDS: PlanCard[] = planCards("PROJECT");

// ---------------------------------------------------------------------------
// A channel partner moving its firm to a bigger plan
// ---------------------------------------------------------------------------

export const PLAN_RANK: Record<PlanKey, number> = { LAUNCH: 1, GROWTH: 2, SCALE: 3 };

/** The plans a firm on `from` may move up to. */
export const biggerPlans = (from: PlanKey): PlanKey[] => (["LAUNCH", "GROWTH", "SCALE"] as PlanKey[]).filter((k) => PLAN_RANK[k] > PLAN_RANK[from]);

/**
 * What moving up costs: the bigger plan for the rest of this month from
 * today, prorated the way the monthly invoice prorates it, less the smaller
 * plan's price for the same days when this month of it was already paid. No
 * setup: the firm paid it once. One line, so the invoice never carries a
 * negative amount.
 */
export function upgradeLines(o: { from: PlanKey; fromPricePaise: number; to: PlanKey; today: string; forName: string; prepaid: boolean }): Omit<InvoiceLine, "amountPaise" | "sac">[] {
  const period = `${o.today.slice(0, 7)}-01`;
  const sub = { startsOn: o.today, endsOn: null };
  const to = plansFor("ORG")[o.to];
  const from = plansFor("ORG")[o.from];
  const bigger = proratedPrice(to.pricePaise, sub, period);
  const credit = o.prepaid ? proratedPrice(o.fromPricePaise, sub, period) : 0;
  return [
    {
      description: `${o.forName}: ${to.label} plan, ${monthWords(period)}, from ${Number(o.today.slice(8, 10))}${credit ? `, less ${from.label} already paid for those days` : ""}`,
      qty: 1,
      unitPaise: Math.max(0, bigger - credit),
    },
  ];
}
