/**
 * A plan renewing itself each month, and a channel partner moving to a
 * smaller plan. The pure half: what a month's renewal decides, what happens
 * to one in flight, when an unpaid one stops the plan's work, and what a
 * smaller plan needs. `plan-renewal.ts` reads and writes. Covered by
 * `check:logic`.
 *
 * Nothing here charges an organisation that is not LIVE: a shadow
 * organisation's month is recorded and nothing else, and the database
 * refuses anything more (0109).
 */

import { AFA_LIMIT_PAISE, MAX_CHARGE_ATTEMPTS, PRE_DEBIT_HOURS, RETRY_AFTER_MINUTES, type MandateMethod } from "./auto-topup-rules.ts";
import { PLAN_RANK } from "./plan-purchase-rules.ts";
import type { PlanKey } from "./billing-rules.ts";

/** Days after the first of the month a LIVE month's plan may go unpaid before the plan's paid work stops. */
export const RENEWAL_GRACE_DAYS = 10;

export type RenewalStatus = "WOULD_CHARGE" | "NOTIFIED" | "AWAITING_APPROVAL" | "CHARGING" | "PAID" | "CANCELLED";

/** Still owed: the month's plan has not been paid and nobody called it off. */
export const UNPAID: readonly RenewalStatus[] = ["NOTIFIED", "AWAITING_APPROVAL", "CHARGING"];

/** The IST month a moment falls in, as its first day. */
export function renewalPeriod(nowIso: string): string {
  return `${new Date(Date.parse(nowIso) + 330 * 60_000).toISOString().slice(0, 7)}-01`;
}

/** The first of the month after a day. */
export function nextMonthStart(day: string): string {
  const [y, m] = day.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export type RenewalDecision =
  | { status: "WOULD_CHARGE"; note: "SHADOW" }
  | { status: "NOTIFIED"; dueAt: string }
  | { status: "AWAITING_APPROVAL"; note: "GATEWAY" | "NO_MANDATE" | "OVER_LIMIT" | "OVER_MANDATE" };

/**
 * How a month's plan is paid. Taken from the client's automatic payment
 * when it may be, a day after it is announced: a card or UPI mandate only
 * up to the amount RBI lets one charge unattended, a bank e-mandate up to
 * its own maximum. Anything else waits for the client to pay it.
 */
export function decideRenewal(i: {
  live: boolean;
  gatewayOpen: boolean;
  totalPaise: number;
  mandate: { method: MandateMethod; maxAmountPaise: number } | null;
  nowIso: string;
}): RenewalDecision {
  if (!i.live) return { status: "WOULD_CHARGE", note: "SHADOW" };
  if (!i.gatewayOpen) return { status: "AWAITING_APPROVAL", note: "GATEWAY" };
  if (!i.mandate) return { status: "AWAITING_APPROVAL", note: "NO_MANDATE" };
  if (i.mandate.method !== "EMANDATE" && i.totalPaise > AFA_LIMIT_PAISE) return { status: "AWAITING_APPROVAL", note: "OVER_LIMIT" };
  if (i.totalPaise > i.mandate.maxAmountPaise) return { status: "AWAITING_APPROVAL", note: "OVER_MANDATE" };
  return { status: "NOTIFIED", dueAt: new Date(Date.parse(i.nowIso) + PRE_DEBIT_HOURS * 3_600_000).toISOString() };
}

export type RenewalStep =
  | { kind: "wait" }
  | { kind: "charge" }
  | { kind: "look" }
  | { kind: "to_client"; note: "NOT_LIVE" | "NO_MANDATE" | "NOT_TAKEN" }
  | { kind: "cancel"; note: "NOT_LIVE" };

/**
 * A renewal in flight. An announced one is taken when due, while the
 * organisation is LIVE and the mandate stands; one being charged is looked
 * for before it is tried again, and after `MAX_CHARGE_ATTEMPTS` it waits
 * for the client. A renewal waiting for the client waits: it is owed.
 */
export function nextForRenewal(
  r: { status: "NOTIFIED" | "AWAITING_APPROVAL" | "CHARGING"; dueAt: string | null; attempts: number; triedAt: string | null },
  ctx: { live: boolean; mandateActive: boolean; nowIso: string },
): RenewalStep {
  const now = Date.parse(ctx.nowIso);
  if (r.status === "NOTIFIED") {
    if (!ctx.live) return { kind: "cancel", note: "NOT_LIVE" };
    if (!ctx.mandateActive) return { kind: "to_client", note: "NO_MANDATE" };
    if (r.dueAt && now < Date.parse(r.dueAt)) return { kind: "wait" };
    return { kind: "charge" };
  }
  if (r.status === "AWAITING_APPROVAL") return { kind: "wait" };
  if (r.triedAt && now - Date.parse(r.triedAt) < RETRY_AFTER_MINUTES * 60_000) return { kind: "wait" };
  if (r.attempts >= MAX_CHARGE_ATTEMPTS) return { kind: "to_client", note: "NOT_TAKEN" };
  return { kind: "look" };
}

/** The day an unpaid month stops the plan's paid work. */
export function renewalDueBy(period: string): string {
  return new Date(Date.parse(`${period}T00:00:00Z`) + RENEWAL_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** An unpaid month past its grace. */
export function renewalOverdue(r: { status: RenewalStatus; period: string }, today: string): boolean {
  return UNPAID.includes(r.status) && today >= renewalDueBy(r.period);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (period: string) => MONTHS[Number(period.slice(5, 7)) - 1] ?? period;

export const overdueMessage = (period: string) =>
  `Your plan for ${monthName(period)} is not paid yet. Pay it on Settings, Plan and usage, and this starts working again.`;

/** What the client reads beside a month's renewal. */
export function renewalWords(r: { status: RenewalStatus; note: string | null; period: string; dueAt: string | null }, today: string, day: (d: string) => string): { label: string; line: string; tone: "quiet" | "blue" | "warn" | "risk" | "ok" } {
  const month = monthName(r.period);
  switch (r.status) {
    case "WOULD_CHARGE":
      return { label: "Not charged", line: `${month}'s plan is recorded. Nothing is charged yet.`, tone: "quiet" };
    case "NOTIFIED":
      return { label: "Paying automatically", line: `Taken from your automatic payment ${r.dueAt ? `on ${day(r.dueAt.slice(0, 10))}` : "shortly"}.`, tone: "blue" };
    case "CHARGING":
      return { label: "Being paid", line: "Taken from your automatic payment; waiting for the bank.", tone: "blue" };
    case "AWAITING_APPROVAL": {
      const over = renewalOverdue(r, today);
      const why =
        r.note === "OVER_LIMIT"
          ? "Your bank asks you to approve a payment this size."
          : r.note === "OVER_MANDATE"
            ? "It is more than your automatic payment allows."
            : r.note === "NOT_TAKEN" || r.note === "DECLINED"
              ? "Your automatic payment did not go through."
              : "Pay it here.";
      return over
        ? { label: "Overdue", line: `${why} Calls, posts and videos are paused until it is paid.`, tone: "risk" }
        : { label: "To pay", line: `${why} Pay by ${day(renewalDueBy(r.period))} to keep everything running.`, tone: "warn" };
    }
    case "PAID":
      return { label: "Paid", line: `${month}'s plan is paid.`, tone: "ok" };
    case "CANCELLED":
      return { label: "Not due", line: `Nothing is owed for ${month}.`, tone: "quiet" };
  }
}

// ---------------------------------------------------------------------------
// A smaller plan
// ---------------------------------------------------------------------------

/** The plans a firm on `from` may move down to. */
export const smallerPlans = (from: PlanKey): PlanKey[] => (["LAUNCH", "GROWTH", "SCALE"] as PlanKey[]).filter((k) => PLAN_RANK[k] < PLAN_RANK[from]);

/** Why a firm may not move to a smaller plan now, or null. */
export function downgradeRefusal(i: {
  from: PlanKey;
  to: PlanKey;
  toLabel: string;
  toProjects: number;
  activeProjects: number;
  pending: boolean;
}): string | null {
  if (PLAN_RANK[i.to] >= PLAN_RANK[i.from]) return "Choose a smaller plan.";
  if (i.pending) return "A move to a smaller plan is already set. Cancel it to choose another.";
  if (i.activeProjects > i.toProjects) {
    const over = i.activeProjects - i.toProjects;
    return `${i.toLabel} covers ${i.toProjects} projects and you run ${i.activeProjects}. Retire ${over} ${over === 1 ? "project" : "projects"} first.`;
  }
  return null;
}

/** Today's items for a LIVE organisation's month: one to pay, overdue, or about to be taken. */
export function renewalAlerts(
  rows: readonly { id: string; status: RenewalStatus; period: string; totalPaise: number; dueAt: string | null }[],
  today: string,
  rupees: (paise: number) => string,
): { id: string; severity: "risk" | "warn"; title: string; why: string; tag: string }[] {
  const out: { id: string; severity: "risk" | "warn"; title: string; why: string; tag: string }[] = [];
  for (const r of rows) {
    const month = monthName(r.period);
    if (r.status === "AWAITING_APPROVAL") {
      const over = renewalOverdue(r, today);
      out.push({
        id: `renewal-${r.id}`,
        severity: over ? "risk" : "warn",
        title: over ? `Your plan for ${month} is overdue` : `Pay your plan for ${month}`,
        why: over
          ? `${rupees(r.totalPaise)} with GST. Calls, posts and videos are paused until it is paid, under Settings, Plan and usage.`
          : `${rupees(r.totalPaise)} with GST, under Settings, Plan and usage, by ${renewalDueBy(r.period)}.`,
        tag: over ? "Overdue" : "To pay",
      });
    } else if (r.status === "NOTIFIED") {
      out.push({
        id: `renewal-${r.id}`,
        severity: "warn",
        title: `Your plan for ${month} is paid automatically${r.dueAt ? ` on ${r.dueAt.slice(0, 10)}` : ""}`,
        why: `${rupees(r.totalPaise)} with GST, from your automatic payment.`,
        tag: "Upcoming",
      });
    }
  }
  return out;
}
