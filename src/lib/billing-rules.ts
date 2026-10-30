/**
 * Billing: the plans, the units, the wallet, the invoice arithmetic.
 *
 * Pure and client-safe: no database, no Node built-ins. `billing.ts` reads
 * and writes, `razorpay.ts` talks to the payment gateway, and the screens
 * import the catalogs from here so a price is written down once.
 *
 * The prices are the decision of 25 September 2026 (`doc/pricing.md`), with
 * the client's changes since: every kind of video is one unit and the
 * top-ups are the list published on salesdesk.app (28 September 2026), and
 * the plans carry 5, 10 and 15 videos a month at prices that keep 50% even
 * when every video is the dearest kind, asked for twice (29 September 2026).
 * Since 6 October 2026 a channel partner buys its own three plans (Solo,
 * Team, Firm), one per firm a month, never per project (`PARTNER_PLANS`).
 *
 * Money is integer paise everywhere. A rupee amount with a fraction is how a
 * GST total ends up a paisa off, and an invoice a paisa off is an invoice the
 * client's accountant sends back.
 */
import { validateGstin } from "./gstin.ts";
import { LISTEN_PER_PROJECT_MONTH } from "./ask-voice-rules.ts";

// ---------------------------------------------------------------------------
// What is counted
// ---------------------------------------------------------------------------

/** The dimension an allowance and a top-up are counted in. */
export type Unit = "MINUTE" | "IMAGE" | "CAROUSEL" | "SLIDE" | "VIDEO" | "QUESTION" | "WHATSAPP" | "NUMBER";

/** What actually happened, for the report. Several kinds count as one unit. */
export type UsageKind =
  | "CALL_MINUTE"
  | "HANDOFF_MINUTE"
  | "IMAGE_POST"
  | "CAROUSEL"
  | "EXTRA_SLIDE"
  | "VIDEO"
  | "FILM"
  | "FILM_VERSION"
  | "STORY_REEL"
  | "QUESTION"
  | "WHATSAPP"
  | "SMS"
  | "PHONE_NUMBER";

export const USAGE_KINDS: readonly UsageKind[] = [
  "CALL_MINUTE",
  "HANDOFF_MINUTE",
  "IMAGE_POST",
  "CAROUSEL",
  "EXTRA_SLIDE",
  "VIDEO",
  "FILM",
  "FILM_VERSION",
  "STORY_REEL",
  "QUESTION",
  "WHATSAPP",
  "SMS",
  "PHONE_NUMBER",
];

export const KIND_UNIT: Record<UsageKind, Unit> = {
  CALL_MINUTE: "MINUTE",
  HANDOFF_MINUTE: "MINUTE",
  IMAGE_POST: "IMAGE",
  CAROUSEL: "CAROUSEL",
  EXTRA_SLIDE: "SLIDE",
  // One price for every video (28 September 2026): a studio video, a story
  // reel and an agent on camera are each one video.
  VIDEO: "VIDEO",
  FILM: "VIDEO",
  FILM_VERSION: "VIDEO",
  STORY_REEL: "VIDEO",
  QUESTION: "QUESTION",
  WHATSAPP: "WHATSAPP",
  // An SMS sent when WhatsApp could not carry a service message draws on
  // the same messaging credit, at AWS's price plus 15%.
  SMS: "WHATSAPP",
  // A calling number's month (0076): inside the plan's own numbers and the
  // extra ones sold on it, which renting already asked for.
  PHONE_NUMBER: "NUMBER",
};

/** Units a plan includes every month. Slides and WhatsApp come only from top-ups. */
export const ALLOWANCE_UNITS = ["MINUTE", "IMAGE", "CAROUSEL", "VIDEO"] as const;
export type AllowanceUnit = (typeof ALLOWANCE_UNITS)[number];

/** Units a top-up can hold. WhatsApp is held in paise, at Meta's price plus 15%. */
export const WALLET_UNITS = ["MINUTE", "IMAGE", "CAROUSEL", "SLIDE", "VIDEO", "WHATSAPP"] as const;
export type WalletUnit = (typeof WALLET_UNITS)[number];

export const isAllowanceUnit = (u: string): u is AllowanceUnit => (ALLOWANCE_UNITS as readonly string[]).includes(u);
export const isWalletUnit = (u: string): u is WalletUnit => (WALLET_UNITS as readonly string[]).includes(u);

/** How a unit reads on a screen. */
export const UNIT_WORDS: Record<Unit, { one: string; many: string }> = {
  MINUTE: { one: "AI call minute", many: "AI call minutes" },
  IMAGE: { one: "image post", many: "image posts" },
  CAROUSEL: { one: "carousel", many: "carousels" },
  SLIDE: { one: "extra carousel slide", many: "extra carousel slides" },
  VIDEO: { one: "video", many: "videos" },
  QUESTION: { one: "Ask Jimmy question", many: "Ask Jimmy questions" },
  WHATSAPP: { one: "WhatsApp credit", many: "WhatsApp credit" },
  NUMBER: { one: "calling number", many: "calling numbers" },
};

/**
 * A minute the buyer spends with a sales person after a hand-off counts as a
 * quarter of an AI minute (`doc/pricing.md`, section 1). `calling.ts` reads
 * the allowance with the same weight.
 */
export const HANDOFF_WEIGHT = 0.25;

/** A carousel counts as one up to this many slides; each slide past it is a slide. */
export const CAROUSEL_SLIDES = 5;

// ---------------------------------------------------------------------------
// Agents are jobs, and a plan says which jobs it carries
// ---------------------------------------------------------------------------

export type AgentJob = "QUALIFIER" | "CONFIRMER" | "REENGAGER" | "POST_VISIT" | "RECEPTIONIST" | "CP_DESK";

export const AGENT_JOB_LABEL: Record<AgentJob, string> = {
  QUALIFIER: "Lead Qualifier",
  CONFIRMER: "Visit Confirmer",
  REENGAGER: "Re-engager",
  POST_VISIT: "Post-visit Follow-up",
  RECEPTIONIST: "Inbound Receptionist",
  CP_DESK: "CP Desk",
};

/**
 * Which job a placed call is. A call with a goal is the qualifier's own
 * minute on a copy of the same agent; the confirmation and no-show calls are
 * the confirmer's.
 * Anything unknown is the qualifier, which every plan carries, so a new kind
 * of call is never refused by a table nobody updated.
 */
export function agentJobFor(agent: string): AgentJob {
  if (agent === "recovery" || agent === "reminder") return "CONFIRMER";
  if (agent === "reengage") return "REENGAGER";
  if (agent === "post_visit") return "POST_VISIT";
  if (agent === "receptionist") return "RECEPTIONIST";
  return "QUALIFIER";
}

// ---------------------------------------------------------------------------
// The plans
// ---------------------------------------------------------------------------

export type PlanKey = "LAUNCH" | "GROWTH" | "SCALE";
export const PLAN_KEYS: readonly PlanKey[] = ["LAUNCH", "GROWTH", "SCALE"];
export const isPlanKey = (v: string): v is PlanKey => (PLAN_KEYS as readonly string[]).includes(v);

/** What a project was sold. Frozen onto the subscription the day it is signed. */
export type PlanTerms = {
  plan: PlanKey;
  label: string;
  /** A month, before GST. */
  pricePaise: number;
  allowance: Record<AllowanceUnit, number>;
  /** Calls at once, pooled across the project's agents. */
  channels: number;
  numbers: number;
  agents: AgentJob[];
  /** Ask Jimmy questions a month, pooled across the organisation. */
  questions: number;
  /**
   * Projects a channel partner's firm-wide plan covers at once. A developer's
   * and a mandate firm's plan covers its one project, and ignores this.
   */
  projects: number;
  /**
   * A channel partner's firm-wide plan (`PARTNER_PLANS`): its costs that are
   * per project (Jimmy reading aloud, the learning, the project's words) are
   * counted once per project it covers, and its document reading is capped
   * for the whole firm (`MAX_FIRM_MONTH_USD`).
   */
  firm?: boolean;
  /** Which version of this catalog the terms were copied from. */
  version: string;
};

export const CATALOG_VERSION = "2026-10-06";

const LAUNCH_AGENTS: AgentJob[] = ["QUALIFIER", "CONFIRMER"];
const GROWTH_AGENTS: AgentJob[] = [...LAUNCH_AGENTS, "REENGAGER", "POST_VISIT"];
const SCALE_AGENTS: AgentJob[] = [...GROWTH_AGENTS, "RECEPTIONIST", "CP_DESK"];

export const PLANS: Record<PlanKey, PlanTerms> = {
  LAUNCH: {
    plan: "LAUNCH",
    label: "Launch",
    pricePaise: 64_999_00,
    allowance: { MINUTE: 1_500, IMAGE: 40, CAROUSEL: 8, VIDEO: 5 },
    channels: 3,
    numbers: 1,
    agents: LAUNCH_AGENTS,
    questions: 1_000,
    projects: 5,
    version: CATALOG_VERSION,
  },
  GROWTH: {
    plan: "GROWTH",
    label: "Growth",
    pricePaise: 1_29_999_00,
    allowance: { MINUTE: 4_000, IMAGE: 100, CAROUSEL: 20, VIDEO: 10 },
    channels: 6,
    numbers: 2,
    agents: GROWTH_AGENTS,
    questions: 1_000,
    projects: 10,
    version: CATALOG_VERSION,
  },
  SCALE: {
    plan: "SCALE",
    label: "Scale",
    pricePaise: 1_99_999_00,
    allowance: { MINUTE: 6_500, IMAGE: 200, CAROUSEL: 40, VIDEO: 15 },
    channels: 10,
    numbers: 2,
    agents: SCALE_AGENTS,
    questions: 1_000,
    projects: 15,
    version: CATALOG_VERSION,
  },
};

/**
 * A channel partner's plans (the client, 6 October 2026): a partner works
 * many developers' projects at once, so it pays one price a month for the
 * whole firm, never per project. Stored under the same three keys, so the
 * add-ons, the voices and the agents follow the plan's rank, and labelled
 * apart. Every allowance is the firm's, used across up to `projects`.
 */
export const PARTNER_PLANS: Record<PlanKey, PlanTerms> = {
  LAUNCH: {
    plan: "LAUNCH",
    label: "Solo",
    pricePaise: 24_999_00,
    allowance: { MINUTE: 400, IMAGE: 20, CAROUSEL: 4, VIDEO: 1 },
    channels: 2,
    numbers: 1,
    agents: LAUNCH_AGENTS,
    questions: 300,
    projects: 5,
    firm: true,
    version: CATALOG_VERSION,
  },
  GROWTH: {
    plan: "GROWTH",
    label: "Team",
    pricePaise: 59_999_00,
    allowance: { MINUTE: 1_200, IMAGE: 60, CAROUSEL: 12, VIDEO: 3 },
    channels: 4,
    numbers: 1,
    agents: GROWTH_AGENTS,
    questions: 500,
    projects: 15,
    firm: true,
    version: CATALOG_VERSION,
  },
  SCALE: {
    plan: "SCALE",
    label: "Firm",
    pricePaise: 1_29_999_00,
    allowance: { MINUTE: 3_500, IMAGE: 150, CAROUSEL: 30, VIDEO: 7 },
    channels: 8,
    numbers: 2,
    agents: SCALE_AGENTS,
    questions: 1_000,
    projects: 30,
    firm: true,
    version: CATALOG_VERSION,
  },
};

/** Whose list a plan comes from: a project's (developer, mandate firm) or a firm's (channel partner). */
export type TermsScope = "PROJECT" | "ORG";

export const plansFor = (scope: TermsScope = "PROJECT"): Record<PlanKey, PlanTerms> => (scope === "ORG" ? PARTNER_PLANS : PLANS);

/** The plan's name on its own list: Launch, Growth, Scale for a project; Solo, Team, Firm for a partner. */
export const planLabel = (plan: PlanKey, scope: TermsScope = "PROJECT") => plansFor(scope)[plan].label;

/** A copy of the plan as it stands today, to freeze onto a subscription. */
export function termsFor(plan: PlanKey, scope: TermsScope = "PROJECT"): PlanTerms {
  const p = plansFor(scope)[plan];
  return { ...p, allowance: { ...p.allowance }, agents: [...p.agents] };
}

/**
 * Terms read back from a stored subscription. A row written by an older
 * catalog keeps its own numbers; anything missing or malformed reads as the
 * plan's current value rather than as zero, because a zero allowance would
 * stop a paying project for a parse error.
 */
export function readTerms(plan: PlanKey, raw: unknown, scope?: TermsScope): PlanTerms {
  const firm = scope === "ORG" || (!!raw && typeof raw === "object" && (raw as { firm?: unknown }).firm === true);
  const base = termsFor(plan, firm ? "ORG" : "PROJECT");
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<PlanTerms> & { allowance?: Partial<Record<AllowanceUnit, unknown>> };
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const allowance = { ...base.allowance };
  for (const u of ALLOWANCE_UNITS) allowance[u] = num(r.allowance?.[u], base.allowance[u]);
  const agents = Array.isArray(r.agents) ? r.agents.filter((a): a is AgentJob => a in AGENT_JOB_LABEL) : base.agents;
  return {
    plan,
    label: typeof r.label === "string" ? r.label : base.label,
    pricePaise: num(r.pricePaise, base.pricePaise),
    allowance,
    channels: num(r.channels, base.channels),
    numbers: num(r.numbers, base.numbers),
    agents: agents.length ? agents : base.agents,
    questions: num(r.questions, base.questions),
    projects: num(r.projects, base.projects),
    ...(firm ? { firm: true } : {}),
    version: typeof r.version === "string" ? r.version : base.version,
  };
}

// ---------------------------------------------------------------------------
// One-time fees, add-ons and discounts
// ---------------------------------------------------------------------------

export const SETUP_FIRST_PAISE = 49_999_00;
export const SETUP_FURTHER_PAISE = 14_999_00;
/** A channel partner's firm pays one setup, whichever plan, once. */
export const PARTNER_SETUP_PAISE = 14_999_00;

/** Thirty days on Launch limits, adjusted against the setup fee on signing. */
/**
 * A pilot runs on Launch's limits except videos. At Rs 29,999, Launch's five
 * would cost more than the pilot brings in at the worst case, so it keeps
 * the one video it always had until the client prices it again.
 */
export const PILOT = { plan: "LAUNCH" as PlanKey, days: 30, pricePaise: 29_999_00, videos: 1 };

/** A pilot's terms, to freeze onto its subscription. */
export function pilotTerms(): PlanTerms {
  const t = termsFor(PILOT.plan);
  return { ...t, allowance: { ...t.allowance, VIDEO: PILOT.videos } };
}

/** Pay for ten months, get twelve. */
export const ANNUAL = { paidMonths: 10, months: 12 };

export type AddOnKey = "EXTRA_CHANNEL" | "EXTRA_AGENT" | "EXTRA_NUMBER";
export const ADD_ONS: Record<AddOnKey, { label: string; pricePaise: number; launchOnly?: boolean }> = {
  EXTRA_CHANNEL: { label: "Extra calling channel", pricePaise: 999_00 },
  EXTRA_AGENT: { label: "Extra agent on Launch", pricePaise: 4_999_00, launchOnly: true },
  EXTRA_NUMBER: { label: "Extra phone number", pricePaise: 999_00 },
};

/** 10% off each project from three, 20% from five. */
export function projectDiscount(activeProjects: number): 0 | 10 | 20 {
  if (activeProjects >= 5) return 20;
  if (activeProjects >= 3) return 10;
  return 0;
}

/** From five projects, minutes and posts are one pool across them. */
export const isPooled = (activeProjects: number) => activeProjects >= 5;

// ---------------------------------------------------------------------------
// Top-ups
// ---------------------------------------------------------------------------

export type SkuKey = "MIN_1000" | "MIN_5000" | "MIN_10000" | "IMAGE" | "CAROUSEL" | "SLIDE" | "VIDEO" | "WHATSAPP_1000" | "WHATSAPP_5000";

export type Sku = {
  key: SkuKey;
  unit: WalletUnit;
  /** Units one of these adds. WhatsApp credit is counted in paise. */
  units: number;
  pricePaise: number;
  label: string;
  /** Only a project on Scale may buy it. */
  scaleOnly?: boolean;
  /** Bought one at a time or by the dozen: the screen offers a quantity. */
  countable?: boolean;
  /**
   * Paid by bank transfer, never through the gateway: Razorpay's 2% takes
   * the 5,000 and 10,000 minute packs further under the 50% top-up floor.
   */
  bankTransfer?: boolean;
};

/**
 * The list on salesdesk.app (chosen 28 September 2026), plus the extra slide
 * from `doc/pricing.md` and the one video price. At worst-case cost the
 * image post keeps 29%, the carousel nothing and the 10,000 minutes 38%, all
 * under the 50% top-up floor: that is recorded in `doc/pricing.md` as the
 * client's decision, not a default.
 */
export const SKUS: readonly Sku[] = [
  { key: "MIN_1000", unit: "MINUTE", units: 1_000, pricePaise: 10_000_00, label: "1,000 AI call minutes" },
  { key: "MIN_5000", unit: "MINUTE", units: 5_000, pricePaise: 45_000_00, label: "5,000 AI call minutes", bankTransfer: true },
  { key: "MIN_10000", unit: "MINUTE", units: 10_000, pricePaise: 80_000_00, label: "10,000 AI call minutes", scaleOnly: true, bankTransfer: true },
  { key: "IMAGE", unit: "IMAGE", units: 1, pricePaise: 49_00, label: "Image post", countable: true },
  { key: "CAROUSEL", unit: "CAROUSEL", units: 1, pricePaise: 149_00, label: "Carousel, up to 5 slides", countable: true },
  { key: "SLIDE", unit: "SLIDE", units: 1, pricePaise: 59_00, label: "Extra carousel slide", countable: true },
  { key: "VIDEO", unit: "VIDEO", units: 1, pricePaise: 5_499_00, label: "Video", countable: true },
  { key: "WHATSAPP_1000", unit: "WHATSAPP", units: 1_000_00, pricePaise: 1_000_00, label: "Rs 1,000 of WhatsApp credit" },
  { key: "WHATSAPP_5000", unit: "WHATSAPP", units: 5_000_00, pricePaise: 5_000_00, label: "Rs 5,000 of WhatsApp credit" },
];

export const skuByKey = (k: string): Sku | undefined => SKUS.find((s) => s.key === k);

/** At most this many of one item in one purchase. */
export const MAX_SKU_QTY = 200;

/** A top-up lasts twelve months from the day it was bought. */
export const TOP_UP_MONTHS = 12;

export function topUpExpiry(boughtIso: string): string {
  const d = new Date(boughtIso);
  const out = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  // 29 February plus a year is 1 March, never 28 February: never shorter than promised.
  return out.toISOString();
}

/** WhatsApp is passed through at Meta's price plus 15%, rounded up to the paisa. */
export const PASS_THROUGH_MARKUP = 0.15;
export const passThroughPaise = (costPaise: number) => Math.ceil(costPaise * (1 + PASS_THROUGH_MARKUP) - 1e-9);

export type CartLine = { sku: SkuKey; qty: number };

/**
 * A basket read back from a form. Unknown items, quantities that are not
 * whole numbers from 1 to `MAX_SKU_QTY`, a non-countable item bought twice
 * and a Scale-only item on an organisation with no Scale project are
 * refused rather than trimmed, because what was paid for must be exactly
 * what the person saw.
 */
export function readCart(raw: readonly { sku: string; qty: unknown }[], hasScale: boolean): { ok: true; lines: CartLine[] } | { ok: false; message: string } {
  const lines: CartLine[] = [];
  for (const r of raw) {
    const sku = skuByKey(r.sku);
    if (!sku) return { ok: false, message: "That top-up is not on the price list." };
    const qty = typeof r.qty === "number" ? r.qty : Number(String(r.qty ?? "").trim());
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_SKU_QTY) return { ok: false, message: `Choose from 1 to ${MAX_SKU_QTY} of ${sku.label.toLowerCase()}.` };
    if (!sku.countable && qty !== 1) return { ok: false, message: `${sku.label} is bought one at a time.` };
    if (sku.scaleOnly && !hasScale) return { ok: false, message: `${sku.label} is for projects on Scale.` };
    if (sku.bankTransfer) return { ok: false, message: `${sku.label} is paid by bank transfer. Ask us and we invoice it.` };
    if (lines.some((l) => l.sku === sku.key)) return { ok: false, message: `${sku.label} is in the basket twice.` };
    lines.push({ sku: sku.key, qty });
  }
  if (!lines.length) return { ok: false, message: "Choose a top-up." };
  return { ok: true, lines };
}

// ---------------------------------------------------------------------------
// Months, and a plan that starts or ends inside one
// ---------------------------------------------------------------------------

const IST_MS = 330 * 60_000;

/** The IST calendar month an instant falls in. */
export function monthOf(iso: string): { period: string; startIso: string; endIso: string; days: number } {
  const ist = new Date(Date.parse(iso) + IST_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const start = Date.UTC(y, m, 1) - IST_MS;
  const end = Date.UTC(y, m + 1, 1) - IST_MS;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return {
    period: `${y}-${String(m + 1).padStart(2, "0")}-01`,
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
    days,
  };
}

/** The IST day an instant falls on, as YYYY-MM-DD. */
export const istDate = (iso: string) => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);

const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/**
 * How many days of the month `period` (YYYY-MM-01) a subscription covers.
 * `endsOn` is exclusive: a pilot starting 1 October for 30 days ends on 31
 * October and does not cover it.
 */
export function coveredDays(sub: { startsOn: string; endsOn: string | null }, period: string): number {
  const first = dayNo(period);
  const [y, m] = period.split("-").map(Number);
  const next = dayNo(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10));
  const from = Math.max(first, dayNo(sub.startsOn));
  const to = Math.min(next, sub.endsOn ? dayNo(sub.endsOn) : next);
  return Math.max(0, to - from);
}

/**
 * A month's allowance for a subscription that covers only part of it,
 * rounded up. Rounded up because the plan carries one video: a project that
 * starts on the 10th is owed its video, not 0.7 of one.
 */
export function proratedAllowance(allowance: number, sub: { startsOn: string; endsOn: string | null }, period: string): number {
  const [y, m] = period.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const covered = coveredDays(sub, period);
  if (covered >= days) return allowance;
  return Math.ceil((allowance * covered) / days);
}

/** A month's price for a partial month, rounded to the paisa. */
export function proratedPrice(pricePaise: number, sub: { startsOn: string; endsOn: string | null }, period: string): number {
  const [y, m] = period.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const covered = coveredDays(sub, period);
  return Math.round((pricePaise * covered) / days);
}

// ---------------------------------------------------------------------------
// Allowance, then wallet, then refusal
// ---------------------------------------------------------------------------

export type Need = { unit: Unit; qty: number };

/**
 * Whether work that needs `needs` may run, from what is left of this
 * month's allowance and what the top-ups hold. The order is the rule:
 * allowance first, then top-ups, then a refusal, and all of it before
 * anything is paid for. A unit with no allowance line (slides, WhatsApp)
 * goes straight to the top-ups.
 */
export function decide(
  needs: readonly Need[],
  left: Partial<Record<Unit, number>>,
  wallet: Partial<Record<Unit, number>>,
): { ok: true } | { ok: false; unit: Unit; short: number } {
  for (const n of needs) {
    if (n.qty <= 0) continue;
    const have = Math.max(0, left[n.unit] ?? 0) + Math.max(0, wallet[n.unit] ?? 0);
    if (have + 1e-9 < n.qty) return { ok: false, unit: n.unit, short: round2(n.qty - have) };
  }
  return { ok: true };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** How one metered amount is covered: allowance first, then top-ups, and what neither held. */
export function split(qty: number, allowanceLeft: number, walletLeft: number): { allowance: number; wallet: number; over: number } {
  const allowance = round2(Math.min(qty, Math.max(0, allowanceLeft)));
  const wallet = round2(Math.min(qty - allowance, Math.max(0, walletLeft)));
  return { allowance, wallet, over: round2(qty - allowance - wallet) };
}

export type Lot = { id: string; left: number; expiresAt: string };

/**
 * Which top-ups a draw comes out of: the one that expires soonest first, so
 * nothing lapses while a later one is spent. An expired lot is never drawn
 * on, whatever it holds.
 */
export function drawFrom(lots: readonly Lot[], qty: number, nowIso: string): { lotId: string; qty: number }[] {
  const now = Date.parse(nowIso);
  const usable = lots
    .filter((l) => l.left > 0 && Date.parse(l.expiresAt) > now)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.id.localeCompare(b.id));
  const out: { lotId: string; qty: number }[] = [];
  let need = round2(qty);
  for (const l of usable) {
    if (need <= 0) break;
    const take = round2(Math.min(need, l.left));
    if (take > 0) out.push({ lotId: l.id, qty: take });
    need = round2(need - take);
  }
  return out;
}

/** Where a unit stands for the month: fine, warned at 80%, or used up. */
export function level(used: number, allowance: number): "ok" | "warn" | "out" {
  if (allowance <= 0) return "out";
  if (used >= allowance) return "out";
  if (used >= allowance * 0.8) return "warn";
  return "ok";
}

/** The refusal a person reads when a unit has run out. No internals, no talk of charges. */
export function usedUpMessage(unit: Unit, project: string | null, canBuy: boolean): string {
  const w = UNIT_WORDS[unit].many;
  const where = project ? `${project} has used this month's ${w}` : `This month's ${w} are used up`;
  if (unit === "WHATSAPP") return `There is no WhatsApp credit left, so this message was not sent. ${canBuy ? "Top up in Settings, Plan and usage." : "Ask us to add credit."}`;
  if (unit === "SLIDE") return `A carousel longer than ${CAROUSEL_SLIDES} slides needs extra slide top-ups, and there are none left. ${canBuy ? "Top up in Settings, Plan and usage, or make it shorter." : "Make it shorter, or ask us to add slides."}`;
  return `${where}, and there are no top-ups left. ${canBuy ? "Top up in Settings, Plan and usage." : "Ask us to add a top-up."}`;
}

export const NO_PLAN_MESSAGE = "This project has no plan yet, so nothing that costs money can run for it. Ask us to start one.";

// ---------------------------------------------------------------------------
// What each unit costs us, for the margin report
// ---------------------------------------------------------------------------

/**
 * Our cost per unit in paise, from `doc/pricing.md`. A metered row carries
 * what is known about its own cost (design attempts, an agent's dollars)
 * and these fill the rest, so the report is an estimate and says so.
 */
export const COST_PAISE = {
  CALL_MINUTE: 435,
  HANDOFF_MINUTE: 90,
  DESIGN_ATTEMPT: 850,
  IMAGE_POST: 1_700,
  CAROUSEL: 7_200,
  /** One five-second Kling 3.0 Standard clip through OpenRouter at $0.084 a second, from 5 October 2026. */
  VIDEO_CLIP: 3_822,
  /**
   * Seedance 2.5 through OpenRouter since 2 October 2026: $6.94 for thirty
   * seconds at 720p, plus the writer, the eyes and the voice fix; and, since
   * the same day, the film made again to put right what the checks found
   * ($8.29 with the first film sent back in, its eyes and its voice fix),
   * priced as if every film needed it.
   */
  FILM: 1_42_000,
  /** The film sent back in: about $8.29 of video tokens at the video-input rate. */
  FILM_VERSION: 76_000,
  /** Kling 3.0 Pro clips through OpenRouter at $0.112 a second since 5 October 2026. */
  STORY_REEL: 72_000,
  CHANNEL_MONTH: 400_00,
  NUMBER_MONTH: 600_00,
  QUESTION: 50,
  /**
   * A question spoken rather than typed: Saaras v3 at Rs 30 an hour, about
   * eight seconds a question. Counted once per question in the plan
   * (`VOICE_PER_PROJECT_MONTH` holds clips to the questions allowance).
   */
  VOICE_QUESTION: 7,
  /**
   * An answer read aloud: Bulbul v3 at Rs 30 for 10,000 letters, about 300
   * letters an answer. At most `LISTEN_PER_PROJECT_MONTH` a project a month.
   */
  ANSWER_READ: 90,
  /**
   * Reading competitor ads for the learning, a project's month at its caps:
   * 60 pictures at about Rs 0.55 and 20 videos at about Rs 1.82
   * (`COMPETITOR_CAPS`, `READ_COST_USD`). The scores themselves cost nothing.
   */
  LEARNING_MONTH: 69_00,
  /**
   * Reading a project's documents into its Brain (`extract.ts`): a set of
   * nine is a few rupees read once, so a month's allowance for reading
   * again as prices change. The pages are read on our own machine; only
   * `gpt-5-mini` is paid.
   */
  BRAIN_DOCS_MONTH: 30_00,
  /**
   * Hearing how the calling agent says a project's words: about 60 sayings
   * a month at Rs 0.19 each (said by Bulbul, heard by Saaras, the word
   * transliterated when no spelling is set), measured on 1 October 2026.
   */
  WORDS_MONTH: 12_00,
} as const;

/** A dollar is Rs 91 with card forex (`doc/pricing.md`). */
export const USD_PAISE = 9_100;
export const usdToPaise = (usd: number) => Math.round(Math.max(0, usd) * USD_PAISE);

/** Platform and support carried per project a month (`doc/pricing.md`, section 8). */
export const PLATFORM_PAISE: Record<PlanKey, number> = { LAUNCH: 4_500_00, GROWTH: 6_000_00, SCALE: 8_000_00 };
/** The same for a channel partner's firm-wide plan: one setup of tools, lighter support than a developer's project. */
export const PARTNER_PLATFORM_PAISE: Record<PlanKey, number> = { LAUNCH: 2_000_00, GROWTH: 3_500_00, SCALE: 5_000_00 };

/**
 * Document reading a channel partner's whole firm may spend in a month
 * (`extract.ts`), in place of `MAX_PROJECT_MONTH_USD` once per project: a
 * firm-wide plan covering thirty projects would otherwise carry thirty
 * projects' worst case.
 */
export const MAX_FIRM_MONTH_USD = 16;

const platformFor = (t: PlanTerms) => (t.firm ? PARTNER_PLATFORM_PAISE : PLATFORM_PAISE)[t.plan];
/** How many projects' per-project costs a plan carries. */
const projectsCosted = (t: PlanTerms) => (t.firm ? Math.max(1, t.projects) : 1);

export const PLAN_FLOOR = 0.6;
export const WORST_FLOOR = 0.5;
export const TOP_UP_FLOOR = 0.5;

export const margin = (pricePaise: number, costPaise: number) => (pricePaise <= 0 ? 0 : 1 - costPaise / pricePaise);

/**
 * What a plan costs us when every unit of it is used, `doc/pricing.md`
 * section 8's formula, with every video priced as a 30-second Seedance film
 * with its fix film, the dearest kind since every video became one film on
 * 5 October 2026. A change to an allowance that breaks the 60% floor fails
 * `check:logic` rather than a month's margin. A channel partner's plan counts
 * its per-project costs once for every project it covers.
 */
export function fullUseCostPaise(t: PlanTerms): number {
  const n = projectsCosted(t);
  return (
    t.allowance.MINUTE * COST_PAISE.CALL_MINUTE +
    t.allowance.IMAGE * COST_PAISE.IMAGE_POST +
    t.allowance.CAROUSEL * COST_PAISE.CAROUSEL +
    t.allowance.VIDEO * COST_PAISE.FILM +
    t.channels * COST_PAISE.CHANNEL_MONTH +
    t.numbers * COST_PAISE.NUMBER_MONTH +
    t.questions * (COST_PAISE.QUESTION + COST_PAISE.VOICE_QUESTION) +
    n * (LISTEN_PER_PROJECT_MONTH * COST_PAISE.ANSWER_READ + COST_PAISE.LEARNING_MONTH + COST_PAISE.BRAIN_DOCS_MONTH + COST_PAISE.WORDS_MONTH) +
    platformFor(t)
  );
}

/**
 * The worst case, section 8's other column: every post at three attempts,
 * every call rounding up badly, every question at its ceiling, and every
 * video a 30-second film the service lost and was asked for again, with its
 * fix film. The story reel (the director's) is made by nothing since 5
 * October 2026, so it no longer sets the worst case.
 */
export const WORST_COST_PAISE = {
  CALL_MINUTE: 494,
  IMAGE_POST: 3_500,
  CAROUSEL: 14_900,
  /**
   * Two films asked for (`MAX_FILM_REQUESTS`), every draft written, every
   * word said again, and the one fix film (`MAX_FIX_REQUESTS`) with its own
   * eyes and voice fix: under the story reel's, so the plans' worst case
   * does not move.
   */
  FILM: 2_12_000,
  /** A story reel at its clip cap and its director's budget. */
  STORY_REEL: 2_29_000,
  QUESTION: 209,
  /** Every clip the full thirty seconds (`VOICE_MAX_SECONDS`). */
  VOICE_QUESTION: 25,
  /** Every answer read the full `LISTEN_MAX_CHARS` (500 letters, Rs 1.50). */
  ANSWER_READ: 150,
  /** The same reads if every one ran to twice its estimate. */
  LEARNING_MONTH: 1_40_00,
  /** `MAX_PROJECT_MONTH_USD` ($8), the most reading may spend on a project in a month. */
  BRAIN_DOCS_MONTH: 728_00,
  /** `SAYING_CAPS.perProjectMonth` (150) sayings at Rs 0.50, a sixty-letter word's. */
  WORDS_MONTH: 75_00,
} as const;

export function worstUseCostPaise(t: PlanTerms): number {
  const n = projectsCosted(t);
  // A firm's document reading is capped for the whole firm, not per project.
  const docs = t.firm ? usdToPaise(MAX_FIRM_MONTH_USD) : WORST_COST_PAISE.BRAIN_DOCS_MONTH;
  return (
    t.allowance.MINUTE * WORST_COST_PAISE.CALL_MINUTE +
    t.allowance.IMAGE * WORST_COST_PAISE.IMAGE_POST +
    t.allowance.CAROUSEL * WORST_COST_PAISE.CAROUSEL +
    t.allowance.VIDEO * WORST_COST_PAISE.FILM +
    t.channels * COST_PAISE.CHANNEL_MONTH +
    t.numbers * COST_PAISE.NUMBER_MONTH +
    t.questions * (WORST_COST_PAISE.QUESTION + WORST_COST_PAISE.VOICE_QUESTION) +
    n * (LISTEN_PER_PROJECT_MONTH * WORST_COST_PAISE.ANSWER_READ + WORST_COST_PAISE.LEARNING_MONTH + WORST_COST_PAISE.WORDS_MONTH) +
    docs +
    platformFor(t)
  );
}

// ---------------------------------------------------------------------------
// GST and the invoice
// ---------------------------------------------------------------------------

export const GST_RATE = 18;

/**
 * SAC 998315, hosting and IT infrastructure provisioning services. Its UN
 * CPC parent, 8315, includes 83152, application service provisioning: leased
 * software run from the provider's own hosted environment, which is what a
 * subscription to this product is. 18% either way; a CA confirms the code.
 */
export const SAC = "998315";

/** GST state codes, for the place of supply. */
export const STATE_NAMES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
};

export const isStateCode = (v: string) => v in STATE_NAMES;

/**
 * The tax on a taxable amount. Inside one state it is CGST and SGST at 9%
 * each; across states it is IGST at 18%. The halves are rounded separately
 * and the IGST once, so each line on the invoice is itself exact.
 */
export function taxFor(taxablePaise: number, sellerState: string, buyerState: string): { cgst: number; sgst: number; igst: number; total: number; interState: boolean } {
  const interState = sellerState !== buyerState;
  if (interState) {
    const igst = Math.round((taxablePaise * GST_RATE) / 100);
    return { cgst: 0, sgst: 0, igst, total: taxablePaise + igst, interState };
  }
  const half = Math.round((taxablePaise * GST_RATE) / 200);
  return { cgst: half, sgst: half, igst: 0, total: taxablePaise + half * 2, interState };
}

/** India's financial year for a date, as it goes in an invoice number: "26-27". */
export function financialYear(isoDate: string): string {
  const [y, m] = isoDate.slice(0, 10).split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export type Series = "EST" | "ECN" | "TST" | "TCN";

/**
 * "EST/26-27/00001": at most 16 characters, unique for the financial year,
 * of letters, digits, hyphens and slashes (CGST Rule 46(b)). Credit notes
 * run their own series (ECN, and TCN in test mode), and test-mode purchases
 * a third, so a test never takes a number from the real one.
 */
export function invoiceNumber(series: Series, fy: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 99_999) throw new Error(`invoice sequence out of range: ${seq}`);
  return `${series}/${fy}/${String(seq).padStart(5, "0")}`;
}

export type InvoiceLine = { description: string; sac: string; qty: number; unitPaise: number; amountPaise: number };

export type Party = { name: string; gstin: string | null; address: string | null; state: string };

export type InvoiceDraft = {
  lines: InvoiceLine[];
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  placeOfSupply: string;
};

/** Lines, the taxable total and the tax, with the place of supply the buyer's state. */
export function draftInvoice(lines: readonly Omit<InvoiceLine, "amountPaise" | "sac">[], seller: Party, buyer: Party): InvoiceDraft {
  const full: InvoiceLine[] = lines.map((l) => ({ ...l, sac: SAC, amountPaise: Math.round(l.qty * l.unitPaise) }));
  const taxable = full.reduce((s, l) => s + l.amountPaise, 0);
  const tax = taxFor(taxable, seller.state, buyer.state);
  return {
    lines: full,
    taxablePaise: taxable,
    cgstPaise: tax.cgst,
    sgstPaise: tax.sgst,
    igstPaise: tax.igst,
    totalPaise: tax.total,
    placeOfSupply: buyer.state,
  };
}

/** A top-up basket as invoice lines. */
export function cartLines(cart: readonly CartLine[]): Omit<InvoiceLine, "amountPaise" | "sac">[] {
  return cart.map((l) => {
    const sku = skuByKey(l.sku)!;
    return { description: `Top-up: ${sku.label}`, qty: l.qty, unitPaise: sku.pricePaise };
  });
}

// ---------------------------------------------------------------------------
// A month's plan invoice
// ---------------------------------------------------------------------------

export type SubscriptionRow = {
  id: string;
  project: string;
  plan: PlanKey;
  status: "PILOT" | "ACTIVE";
  cycle: "MONTHLY" | "ANNUAL";
  startsOn: string;
  endsOn: string | null;
  terms: PlanTerms;
  extraChannels: number;
  extraAgents: AgentJob[];
  extraNumbers: number;
  setupPaise: number;
  /**
   * Bought in the console: its first month and its setup were paid in
   * Checkout and carry an invoice of their own, so the month it starts in is
   * never billed again.
   */
  prepaid?: boolean;
};

/**
 * The lines of one month's plan invoice for an organisation. A pilot is
 * billed once, in the month it starts; a monthly plan is billed for the
 * days of the month it covers, less the multi-project discount; an annual
 * plan is billed once, for ten months, in the month it starts; add-ons
 * follow their plan; the setup fee rides on the month a plan starts.
 */
export function planLines(subs: readonly SubscriptionRow[], period: string): Omit<InvoiceLine, "amountPaise" | "sac">[] {
  const active = subs.filter((s) => s.status === "ACTIVE" && coveredDays(s, period) > 0).length;
  const off = projectDiscount(active);
  const monthName = new Date(`${period}T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  const lines: Omit<InvoiceLine, "amountPaise" | "sac">[] = [];
  const [py, pm] = period.split("-").map(Number);
  const startsHere = (s: SubscriptionRow) => {
    const [y, m] = s.startsOn.split("-").map(Number);
    return y === py && m === pm;
  };
  for (const s of subs) {
    if (coveredDays(s, period) <= 0) continue;
    if (s.prepaid && startsHere(s)) continue;
    if (s.status === "PILOT") {
      if (startsHere(s)) lines.push({ description: `${s.project}: ${PILOT.days}-day pilot on Launch limits`, qty: 1, unitPaise: PILOT.pricePaise });
      continue;
    }
    const discount = (p: number) => Math.round((p * (100 - off)) / 100);
    const tag = off ? `, ${off}% multi-project discount` : "";
    if (s.cycle === "ANNUAL") {
      if (!startsHere(s)) continue;
      lines.push({ description: `${s.project}: ${s.terms.label} plan, 12 months paid as ${ANNUAL.paidMonths}${tag}`, qty: 1, unitPaise: discount(s.terms.pricePaise * ANNUAL.paidMonths) });
    } else {
      const part = coveredDays(s, period) < new Date(Date.UTC(py, pm, 0)).getUTCDate();
      lines.push({
        description: `${s.project}: ${s.terms.label} plan, ${monthName}${part ? ", part month" : ""}${tag}`,
        qty: 1,
        unitPaise: discount(proratedPrice(s.terms.pricePaise, s, period)),
      });
    }
    const months = s.cycle === "ANNUAL" ? 12 : 1;
    const addOn = (key: AddOnKey, n: number) => {
      if (n <= 0) return;
      if (s.cycle === "ANNUAL" && !startsHere(s)) return;
      const each = s.cycle === "ANNUAL" ? ADD_ONS[key].pricePaise * months : proratedPrice(ADD_ONS[key].pricePaise, s, period);
      lines.push({ description: `${s.project}: ${ADD_ONS[key].label}${s.cycle === "ANNUAL" ? ", 12 months" : ""}`, qty: n, unitPaise: each });
    };
    addOn("EXTRA_CHANNEL", s.extraChannels);
    addOn("EXTRA_AGENT", s.extraAgents.length);
    addOn("EXTRA_NUMBER", s.extraNumbers);
    if (startsHere(s) && s.setupPaise > 0) lines.push({ description: `${s.project}: setup`, qty: 1, unitPaise: s.setupPaise });
  }
  return lines;
}

/** The setup fee a new plan carries: the first project pays the full fee, later ones less, and a pilot is adjusted against it. */
export function setupFor(opts: { earlierPlans: number; hadPilot: boolean; scope?: TermsScope }): number {
  if (opts.scope === "ORG") return opts.earlierPlans > 0 ? 0 : PARTNER_SETUP_PAISE;
  const fee = opts.earlierPlans > 0 ? SETUP_FURTHER_PAISE : SETUP_FIRST_PAISE;
  return Math.max(0, fee - (opts.hadPilot ? PILOT.pricePaise : 0));
}

// ---------------------------------------------------------------------------
// Auto top-up
// ---------------------------------------------------------------------------

/**
 * Whether an automatic top-up may be bought now: it is on, the unit is
 * below its trigger, and buying one more stays inside the monthly ceiling
 * the client set. Nothing buys past the ceiling, whatever runs out.
 */
export function autoTopUpDue(opts: {
  on: boolean;
  sku: Sku | undefined;
  ceilingPaise: number;
  spentThisMonthPaise: number;
  left: number;
  /** Below this, it buys. Unset, a default per unit: 100 minutes, Rs 200 of WhatsApp credit, one of anything else. */
  threshold?: number | null;
  /** How many of the pack one purchase buys. */
  qty?: number;
  /** The purchase's total with GST, when the caller knows the buyer's state. */
  grossPaise?: number;
}): boolean {
  if (!opts.on || !opts.sku || opts.ceilingPaise <= 0) return false;
  const trigger = opts.threshold ?? defaultThreshold(opts.sku.unit);
  if (opts.left >= trigger) return false;
  const gross = opts.grossPaise ?? taxFor(opts.sku.pricePaise * (opts.qty ?? 1), "00", "00").total;
  return opts.spentThisMonthPaise + gross <= opts.ceilingPaise;
}

/** Where an automatic top-up buys when nobody said: 100 minutes, Rs 200 of WhatsApp credit, one of anything else. */
export const defaultThreshold = (unit: WalletUnit): number => (unit === "MINUTE" ? 100 : unit === "WHATSAPP" ? 200_00 : 1);

// ---------------------------------------------------------------------------
// Who is billed
// ---------------------------------------------------------------------------

export type BillingDetails = { name: string | null; gstin: string | null; address: string | null; state: string | null; email: string | null };

/**
 * The bill-to details from a form. A blank name or GSTIN means "the
 * organisation's own"; a state is taken from the GSTIN when it is left
 * empty, and refused when it disagrees with it, because the GSTIN's state is
 * the place of supply and a mismatch taxes the invoice wrongly. Every field
 * that cannot be read is named in the screen's own words, and nothing is
 * stored until all of them can.
 */
export function readBillingDetails(raw: Record<string, unknown>): { ok: true; value: BillingDetails } | { ok: false; problems: string[] } {
  const text = (k: string) => String(raw[k] ?? "").replace(/\s+/g, " ").trim();
  const problems: string[] = [];
  const name = text("name");
  if (name.length > 200) problems.push("Invoice to: keep it under 200 characters.");
  const gstinRaw = text("gstin").replace(/\s+/g, "").toUpperCase();
  let gstin: string | null = null;
  if (gstinRaw) {
    const g = validateGstin(gstinRaw);
    if (g.ok) gstin = g.gstin;
    else problems.push(`GSTIN: ${g.error}`);
  }
  const address = String(raw.address ?? "").replace(/[ \t]+/g, " ").trim();
  if (address.length > 500) problems.push("Address: keep it under 500 characters.");
  let state = text("state") || null;
  if (state && !isStateCode(state)) {
    problems.push("State: choose one from the list.");
    state = null;
  }
  if (gstin) {
    const from = gstin.slice(0, 2);
    if (state && state !== from) problems.push(`State: that GSTIN is registered in ${STATE_NAMES[from] ?? "another state"}.`);
    state = state ?? from;
  }
  const email = text("email").toLowerCase();
  if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email))) problems.push(`Invoices go to: ${email} is not an email address.`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { name: name || null, gstin, address: address || null, state, email: email || null } };
}

// ---------------------------------------------------------------------------
// Who invoices
// ---------------------------------------------------------------------------

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * The company on every invoice: the new Sales Desk Private Limited, never
 * the parent company. Read from the environment, because it is one company's
 * registration and not a tenant's setting. Without a GSTIN there is no tax
 * invoice to issue, so a live purchase is not offered at all.
 */
export function sellerFromEnv(env: Record<string, string | undefined>): { ok: true; seller: Party; bank: string | null } | { ok: false; missing: string[] } {
  const name = env.BILLING_SELLER_NAME?.trim() ?? "";
  const gstin = (env.BILLING_SELLER_GSTIN ?? "").replace(/\s+/g, "").toUpperCase();
  const address = env.BILLING_SELLER_ADDRESS?.trim() ?? "";
  const missing = [
    !name && "BILLING_SELLER_NAME",
    !GSTIN_SHAPE.test(gstin) && "BILLING_SELLER_GSTIN",
    !address && "BILLING_SELLER_ADDRESS",
  ].filter((m): m is string => !!m);
  if (missing.length) return { ok: false, missing };
  const state = env.BILLING_SELLER_STATE?.trim() || gstin.slice(0, 2);
  return { ok: true, seller: { name, gstin, address, state }, bank: env.BILLING_BANK_DETAILS?.trim() || null };
}

/** Who a test-mode invoice is made out from while the company is not registered yet. It is marked as a test on every page. */
export function testSeller(env: Record<string, string | undefined>): Party {
  const real = sellerFromEnv(env);
  if (real.ok) return real.seller;
  const state = env.BILLING_SELLER_STATE?.trim();
  return {
    name: env.BILLING_SELLER_NAME?.trim() || "Sales Desk Private Limited",
    gstin: null,
    address: env.BILLING_SELLER_ADDRESS?.trim() || null,
    state: state && isStateCode(state) ? state : "27",
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? below100(r) : ""].filter(Boolean).join(" ");
}

/** A whole number in the Indian system: crore, lakh, thousand. */
export function indianWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1_00_00_000);
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  n %= 1_00_00_000;
  const lakh = Math.floor(n / 1_00_000);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  n %= 1_00_000;
  const thousand = Math.floor(n / 1_000);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  n %= 1_000;
  if (n) parts.push(below1000(n));
  return parts.join(" ");
}

/** "Rupees Ninety Four Thousand Three Hundred Ninety Eight and Eighty Two Paise Only". */
export function amountInWords(paise: number): string {
  const p = Math.abs(Math.round(paise));
  const r = Math.floor(p / 100);
  const f = p % 100;
  return `Rupees ${indianWords(r)}${f ? ` and ${below100(f)} Paise` : ""} Only`;
}

/** "Rs 1,25,000", or "Rs 1,25,000.50" when there are paise. */
export function rupees(paise: number, exact = false): string {
  const neg = paise < 0;
  const p = Math.abs(Math.round(paise));
  const whole = Math.floor(p / 100);
  const frac = p % 100;
  const body = whole.toLocaleString("en-IN");
  const tail = exact || frac ? `.${String(frac).padStart(2, "0")}` : "";
  return `${neg ? "-" : ""}Rs ${body}${tail}`;
}

/** A quantity of a unit as a person reads it. */
export function amountOf(unit: Unit, qty: number): string {
  if (unit === "WHATSAPP") return rupees(qty);
  const n = Math.round(qty * 100) / 100;
  const words = n === 1 ? UNIT_WORDS[unit].one : UNIT_WORDS[unit].many;
  return `${n.toLocaleString("en-IN")} ${words}`;
}
