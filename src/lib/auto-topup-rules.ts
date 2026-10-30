/**
 * Automatic top-ups: the pure half. No database, no Node built-ins, and safe
 * for a client component.
 *
 * An organisation may ask to be topped up by itself when a unit runs low:
 * one pack (and how many of it), below what, and never past a monthly
 * ceiling it sets. `auto-topup.ts` reads and writes, `razorpay.ts` charges,
 * and the billing sweep runs it.
 *
 * What decides everything here, in order:
 *
 * 1. **Nothing is charged in shadow mode.** An organisation that is not LIVE
 *    records what it would have bought (`WOULD_CHARGE`), once a day at
 *    most, counted against its ceiling as though it had, and nothing else.
 *    The database refuses anything more (0071).
 * 2. **The client is told before the money moves.** A charge is announced
 *    (`NOTIFIED`) and taken no sooner than `PRE_DEBIT_HOURS` later, and a
 *    charge that is no longer needed by then, or whose setting was switched
 *    off, is cancelled rather than taken.
 * 3. **Over Rs 15,000 the client pays it themselves.** RBI's e-mandate rule
 *    lets a saved mandate take up to Rs 15,000 unattended; above that each
 *    charge needs the customer to authenticate it. So such a purchase (or
 *    one with no saved mandate, or over the mandate's own maximum) waits
 *    as `AWAITING_APPROVAL` for the client to pay it through Checkout, and
 *    expires after `APPROVAL_DAYS`.
 * 4. **One purchase in flight, and each one bounded.** A charge is tried at
 *    most `MAX_CHARGE_ATTEMPTS` times, looking for the earlier try's payment
 *    before trying again.
 */
import { SKUS, rupees, taxFor, defaultThreshold, type Sku, type SkuKey, type WalletUnit } from "./billing-rules.ts";

/** Most one automatic purchase buys of a counted item (posts, videos). A pack is one. */
export const AUTO_MAX_QTY = 10;
/** RBI's limit for a recurring charge taken without the customer authenticating it. */
export const AFA_LIMIT_PAISE = 15_000_00;
/** The notice before a charge is taken. */
export const PRE_DEBIT_HOURS = 24;
/** How long a purchase waits for the client to pay it before it lapses. */
export const APPROVAL_DAYS = 7;
/** A shadow organisation records a purchase it would have made at most this often. */
export const SHADOW_COOLDOWN_HOURS = 24;
/** Tries at one charge, each looking first for the one before. */
export const MAX_CHARGE_ATTEMPTS = 3;
/** Minutes before a charge with no answer is looked at again. */
export const RETRY_AFTER_MINUTES = 10;
/** The highest monthly ceiling the screen accepts: Rs 10,00,000. */
export const MAX_CEILING_PAISE = 10_00_000_00;

/** What may be bought automatically: nothing paid by bank transfer, and Scale's pack only on Scale. */
export function autoSkus(hasScale: boolean): Sku[] {
  return SKUS.filter((s) => !s.bankTransfer && (!s.scaleOnly || hasScale));
}

export type AutoSetting = {
  on: boolean;
  sku: SkuKey | null;
  qty: number;
  /** In the pack's unit: minutes, posts, videos, or paise of WhatsApp credit. */
  threshold: number | null;
  ceilingPaise: number | null;
};

export const AUTO_OFF: AutoSetting = { on: false, sku: null, qty: 1, threshold: null, ceilingPaise: null };

/** What the threshold is typed in: minutes, posts and videos as counts, WhatsApp credit in rupees. */
export function thresholdUnitWords(unit: WalletUnit): string {
  if (unit === "WHATSAPP") return "rupees of credit";
  if (unit === "MINUTE") return "minutes";
  if (unit === "IMAGE") return "image posts";
  if (unit === "CAROUSEL") return "carousels";
  if (unit === "SLIDE") return "extra slides";
  return "videos";
}

/** A stored threshold as a person types it back: WhatsApp's paise as rupees. */
export const thresholdShown = (unit: WalletUnit, stored: number) => (unit === "WHATSAPP" ? stored / 100 : stored);

/** One automatic purchase: what it adds, and what it costs before and after GST. */
export function chargeFor(sku: Sku, qty: number, sellerState: string, buyerState: string): { units: number; taxablePaise: number; totalPaise: number } {
  const taxable = sku.pricePaise * qty;
  return { units: sku.units * qty, taxablePaise: taxable, totalPaise: taxFor(taxable, sellerState, buyerState).total };
}

const num = (v: unknown): number | null => {
  const t = String(v ?? "").replace(/[,\s]/g, "").replace(/^rs\.?/i, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * The setting from the form. Switched on, every field is required and
 * checked; switched off, what was typed is kept when it reads and dropped
 * when it does not, because nothing runs on it. Every field that cannot be
 * read is named in the screen's words, and nothing is stored until all of
 * them can.
 */
export function readAutoTopUp(
  raw: Record<string, unknown>,
  ctx: { hasScale: boolean; sellerState: string; buyerState: string | null },
): { ok: true; value: AutoSetting } | { ok: false; problems: string[] } {
  const on = raw.on === "on" || raw.on === "true" || raw.on === true;
  const problems: string[] = [];
  const skuKey = String(raw.sku ?? "").trim();
  const sku = skuKey ? autoSkus(ctx.hasScale).find((s) => s.key === skuKey) : undefined;
  if (skuKey && !sku) problems.push("Buy: choose a top-up from the list.");
  if (on && !skuKey) problems.push("Buy: choose what to top up with.");

  let qty = 1;
  const q = num(raw.qty);
  if (q !== null) {
    if (!Number.isInteger(q) || q < 1 || q > AUTO_MAX_QTY) problems.push(`How many: 1 to ${AUTO_MAX_QTY}.`);
    else if (sku && !sku.countable && q !== 1) problems.push(`How many: ${sku.label} is bought one at a time.`);
    else qty = q;
  }

  let threshold: number | null = null;
  const t = num(raw.threshold);
  if (t === null) {
    if (on) problems.push("When fewer than: say how low it may run.");
  } else if (Number.isNaN(t) || t < 0 || t > 1_00_00_000) {
    problems.push("When fewer than: a number, zero or more.");
  } else if (sku) {
    threshold = sku.unit === "WHATSAPP" ? Math.round(t * 100) : Math.floor(t);
  }

  let ceilingPaise: number | null = null;
  const c = num(raw.ceiling);
  if (c === null) {
    if (on) problems.push("Monthly limit: say the most it may spend in a month.");
  } else if (Number.isNaN(c) || c <= 0 || Math.round(c * 100) > MAX_CEILING_PAISE) {
    problems.push(`Monthly limit: more than zero and at most ${rupees(MAX_CEILING_PAISE)}.`);
  } else {
    ceilingPaise = Math.round(c * 100);
  }

  if (on && sku && ceilingPaise !== null) {
    const one = chargeFor(sku, qty, ctx.sellerState, ctx.buyerState ?? ctx.sellerState).totalPaise;
    if (one > ceilingPaise) problems.push(`Monthly limit: one top-up costs ${rupees(one, true)} with GST, more than the limit.`);
  }
  if (on && !ctx.buyerState) problems.push("Add the state you are billed in, under Billing details, first.");
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { on, sku: sku?.key ?? null, qty, threshold, ceilingPaise } };
}

/**
 * How much of a unit is left where it matters most: the project (or the
 * pool) with the least allowance left, plus the top-ups every project
 * shares. Null when nothing on a plan uses the unit, so nothing is bought
 * for it. Slides and WhatsApp credit have no allowance: the top-ups alone.
 */
export function lowestLeft(unit: WalletUnit, allowanceLeft: readonly number[] | null, walletLeft: number): number | null {
  const allowanceUnit = unit === "MINUTE" || unit === "IMAGE" || unit === "CAROUSEL" || unit === "VIDEO";
  if (!allowanceUnit) return allowanceLeft === null ? null : Math.max(0, walletLeft);
  if (!allowanceLeft || !allowanceLeft.length) return null;
  return Math.max(0, Math.min(...allowanceLeft)) + Math.max(0, walletLeft);
}

export type AutoDecision =
  | { kind: "none"; why: "OFF" | "IN_FLIGHT" | "NOTHING_RUNNING" | "NOT_LOW" | "CEILING" | "COOLDOWN" | "GATEWAY" }
  | { kind: "record"; status: "WOULD_CHARGE"; note: "SHADOW" }
  | { kind: "record"; status: "NOTIFIED"; dueAt: string }
  | { kind: "record"; status: "AWAITING_APPROVAL"; note: "OVER_LIMIT" | "NO_MANDATE" | "OVER_MANDATE" };

/**
 * Whether to start an automatic purchase now, and of which kind. Asked on
 * every sweep; the order is the rule, and every refusal costs a query.
 */
export function decideAuto(input: {
  setting: AutoSetting;
  sku: Sku | undefined;
  live: boolean;
  inFlight: boolean;
  lastRecordedAt: string | null;
  left: number | null;
  spentThisMonthPaise: number;
  totalPaise: number;
  mandate: { maxAmountPaise: number } | null;
  gatewayOpen: boolean;
  nowIso: string;
}): AutoDecision {
  const s = input.setting;
  if (!s.on || !input.sku || s.ceilingPaise === null || s.threshold === null) return { kind: "none", why: "OFF" };
  if (input.inFlight) return { kind: "none", why: "IN_FLIGHT" };
  if (input.left === null) return { kind: "none", why: "NOTHING_RUNNING" };
  if (input.left >= s.threshold) return { kind: "none", why: "NOT_LOW" };
  if (input.spentThisMonthPaise + input.totalPaise > s.ceilingPaise) return { kind: "none", why: "CEILING" };
  const now = Date.parse(input.nowIso);
  if (!input.live) {
    if (input.lastRecordedAt && now - Date.parse(input.lastRecordedAt) < SHADOW_COOLDOWN_HOURS * 3_600_000) return { kind: "none", why: "COOLDOWN" };
    return { kind: "record", status: "WOULD_CHARGE", note: "SHADOW" };
  }
  if (!input.gatewayOpen) return { kind: "none", why: "GATEWAY" };
  if (input.totalPaise > AFA_LIMIT_PAISE) return { kind: "record", status: "AWAITING_APPROVAL", note: "OVER_LIMIT" };
  if (!input.mandate) return { kind: "record", status: "AWAITING_APPROVAL", note: "NO_MANDATE" };
  if (input.totalPaise > input.mandate.maxAmountPaise) return { kind: "record", status: "AWAITING_APPROVAL", note: "OVER_MANDATE" };
  return { kind: "record", status: "NOTIFIED", dueAt: new Date(now + PRE_DEBIT_HOURS * 3_600_000).toISOString() };
}

export type OpenCharge = {
  status: "NOTIFIED" | "AWAITING_APPROVAL" | "CHARGING";
  notifiedAt: string;
  dueAt: string | null;
  attempts: number;
  triedAt: string | null;
};

export type OpenStep =
  | { kind: "wait" }
  | { kind: "charge" }
  | { kind: "look" }
  | { kind: "cancel"; note: "TURNED_OFF" | "NOT_LIVE" | "NO_MANDATE" | "NOT_NEEDED" }
  | { kind: "expire" }
  | { kind: "fail"; note: "NO_ANSWER" };

/**
 * What to do with a purchase already in flight. A notified charge is taken
 * only when it is due and every reason it was decided on still holds; one
 * being charged is looked for before it is tried again, and given up after
 * `MAX_CHARGE_ATTEMPTS`.
 */
export function nextForOpen(c: OpenCharge, ctx: { on: boolean; live: boolean; mandateActive: boolean; stillLow: boolean; nowIso: string }): OpenStep {
  const now = Date.parse(ctx.nowIso);
  if (c.status === "NOTIFIED") {
    if (!ctx.on) return { kind: "cancel", note: "TURNED_OFF" };
    if (!ctx.live) return { kind: "cancel", note: "NOT_LIVE" };
    if (!ctx.mandateActive) return { kind: "cancel", note: "NO_MANDATE" };
    if (c.dueAt && now < Date.parse(c.dueAt)) return { kind: "wait" };
    if (!ctx.stillLow) return { kind: "cancel", note: "NOT_NEEDED" };
    return { kind: "charge" };
  }
  if (c.status === "AWAITING_APPROVAL") {
    if (!ctx.on) return { kind: "cancel", note: "TURNED_OFF" };
    if (now >= Date.parse(c.notifiedAt) + APPROVAL_DAYS * 86_400_000) return { kind: "expire" };
    return { kind: "wait" };
  }
  if (c.triedAt && now - Date.parse(c.triedAt) < RETRY_AFTER_MINUTES * 60_000) return { kind: "wait" };
  if (c.attempts >= MAX_CHARGE_ATTEMPTS) return { kind: "fail", note: "NO_ANSWER" };
  return { kind: "look" };
}

export type ChargeStatus = "WOULD_CHARGE" | "NOTIFIED" | "AWAITING_APPROVAL" | "CHARGING" | "PAID" | "FAILED" | "CANCELLED" | "EXPIRED";

/** Counts against the month's ceiling: everything that was or will be bought, and what shadow mode would have. */
export const COUNTS_TOWARD_CEILING: readonly ChargeStatus[] = ["WOULD_CHARGE", "NOTIFIED", "AWAITING_APPROVAL", "CHARGING", "PAID"];

/** How a purchase reads on the screen. */
export function chargeWords(status: ChargeStatus, note: string | null): { label: string; tone: "quiet" | "blue" | "warn" | "risk" | "ok" } {
  switch (status) {
    case "WOULD_CHARGE":
      return { label: "Would have bought, not billed", tone: "quiet" };
    case "NOTIFIED":
      return { label: "Will be charged", tone: "blue" };
    case "AWAITING_APPROVAL":
      return { label: "Waiting for you to pay", tone: "warn" };
    case "CHARGING":
      return { label: "Being charged", tone: "blue" };
    case "PAID":
      return { label: "Paid", tone: "ok" };
    case "FAILED":
      return { label: "Did not go through", tone: "risk" };
    case "EXPIRED":
      return { label: "Not paid in time", tone: "quiet" };
    case "CANCELLED":
      return {
        label:
          note === "NOT_NEEDED" ? "Cancelled, no longer needed" : note === "TURNED_OFF" ? "Cancelled, switched off" : note === "BY_CLIENT" ? "Cancelled by you" : "Cancelled",
        tone: "quiet",
      };
  }
}

/** Today's items for automatic top-ups: one to pay, and one about to be charged. */
export function autoAlerts(
  open: readonly { id: string; status: ChargeStatus; label: string; totalPaise: number; dueAt: string | null }[],
): { id: string; severity: "risk" | "warn"; title: string; why: string; tag: string }[] {
  const out: { id: string; severity: "risk" | "warn"; title: string; why: string; tag: string }[] = [];
  for (const c of open) {
    if (c.status === "AWAITING_APPROVAL") {
      out.push({ id: `auto-approve-${c.id}`, severity: "risk", title: `Pay for your automatic top-up: ${c.label}`, why: `${rupees(c.totalPaise, true)} with GST, under Settings, Plan and usage, Auto top-up.`, tag: "To pay" });
    } else if (c.status === "NOTIFIED") {
      const when = c.dueAt ? new Date(c.dueAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "soon";
      out.push({ id: `auto-notified-${c.id}`, severity: "warn", title: `Automatic top-up on ${when}: ${c.label}`, why: `${rupees(c.totalPaise, true)} with GST. Cancel it under Auto top-up if it is not wanted.`, tag: "Upcoming" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setting up the mandate: the client authorises it, on screen
// ---------------------------------------------------------------------------

/**
 * The client sets up its own recurring mandate: Checkout authorises a
 * token for a customer of ours at Razorpay, capped at the monthly limit,
 * and the token is saved sealed where the operator's script saves one.
 * Open only where a person may buy here at all (`purchasingOpen()`): live
 * keys for a LIVE organisation, the gateway's test mode off a production
 * host. A card and UPI AutoPay are authorised with a rupee; a bank
 * e-mandate with nothing, and it is confirmed by the bank a day or more
 * later, so it waits as AUTHORISED until it is.
 */
export const MANDATE_METHODS = ["CARD", "UPI", "EMANDATE"] as const;
export type MandateMethod = (typeof MANDATE_METHODS)[number];
export const MANDATE_METHOD_WORDS: Record<MandateMethod, string> = { CARD: "Card", UPI: "UPI AutoPay", EMANDATE: "Bank e-mandate" };
/** How long a mandate is asked for. */
export const MANDATE_VALID_YEARS = 5;
/** A set-up nobody finished at Checkout is let go after this. */
export const SETUP_TTL_HOURS = 24;
/** An e-mandate the bank has not confirmed after this is let go. */
export const BANK_WAIT_DAYS = 10;

export function readMandateMethod(raw: unknown): MandateMethod | null {
  const v = String(raw ?? "").trim().toUpperCase();
  return (MANDATE_METHODS as readonly string[]).includes(v) ? (v as MandateMethod) : null;
}

/** What the authorisation itself takes, in paise: nothing for an e-mandate, a rupee for a card or UPI. */
export const mandateAuthPaise = (m: MandateMethod): number => (m === "EMANDATE" ? 0 : 100);

/** When the mandate ends, as the Unix seconds Razorpay's `expire_at` takes. */
export function mandateExpireAt(nowIso: string): number {
  const d = new Date(nowIso);
  d.setUTCFullYear(d.getUTCFullYear() + MANDATE_VALID_YEARS);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Why the client may not set up a mandate now, in the screen's words, or
 * null when they may. The order is the rule.
 */
export function mandateSetupRefusal(ctx: {
  mode: "SHADOW" | "LIVE" | null;
  open: boolean;
  buyerState: string | null;
  ceilingPaise: number | null;
  waiting: "CREATED" | "AUTHORISED" | null;
}): string | null {
  if (!ctx.mode) return "Automatic payment starts once a project has a plan.";
  if (!ctx.open) return "Automatic payment cannot be set up here yet. Ask us to switch it on.";
  if (!ctx.buyerState) return "Add the state you are billed in, under Billing details, first.";
  if (!ctx.ceilingPaise) return "Set a monthly limit first. It is the most one payment may take.";
  if (ctx.waiting === "AUTHORISED") return "Your bank has not confirmed the last one yet.";
  return null;
}

/**
 * What a set-up's authorisation payment and its token come to. A payment
 * for another order, or one that failed, fails the set-up; one not yet
 * authorised is not an answer; a token the bank has not confirmed waits.
 */
export function setupOutcome(
  p: { orderId: string | null; status: string; amount: number; tokenId: string | null; email: string | null; contact: string | null } | null,
  setup: { orderId: string; authPaise: number },
  token: "confirmed" | "pending" | "rejected" | null,
): { kind: "confirm" } | { kind: "wait" } | { kind: "not_yet" } | { kind: "fail"; note: "DECLINED" | "WRONG_ORDER" | "NO_TOKEN" | "BANK_REJECTED" | "NO_CONTACT" } {
  if (!p) return { kind: "not_yet" };
  if (p.orderId !== setup.orderId || p.amount !== setup.authPaise) return { kind: "fail", note: "WRONG_ORDER" };
  if (p.status === "failed") return { kind: "fail", note: "DECLINED" };
  if (p.status !== "authorized" && p.status !== "captured") return { kind: "not_yet" };
  if (!p.tokenId) return { kind: "fail", note: "NO_TOKEN" };
  if (!p.email || !p.contact) return { kind: "fail", note: "NO_CONTACT" };
  if (token === "rejected") return { kind: "fail", note: "BANK_REJECTED" };
  if (token === "confirmed") return { kind: "confirm" };
  return { kind: "wait" };
}

/** What the sweep does with a set-up still open: let it go, look again, or leave it. */
export function setupDue(s: { status: "CREATED" | "AUTHORISED"; createdAt: string }, nowIso: string): "expire" | "check" | "none" {
  const age = Date.parse(nowIso) - Date.parse(s.createdAt);
  if (s.status === "CREATED") return age >= SETUP_TTL_HOURS * 3_600_000 ? "expire" : "check";
  return age >= BANK_WAIT_DAYS * 86_400_000 ? "expire" : "check";
}

export { defaultThreshold };
