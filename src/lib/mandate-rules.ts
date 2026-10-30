/**
 * Mandate firms: the rules, pure and database-free, covered by `check:logic`.
 *
 * A developer engages a mandate firm to sell one or more projects, usually as
 * the sole selling agent, for a commission on every booking in them while
 * the mandate runs. The developer offers it; the firm accepts it from its
 * own workspace; it runs until the day chosen or until the developer ends
 * it. The commission is paid the way a partner's is: two halves (the
 * agreement registered, 30 per cent collected), GST on top when the firm is
 * registered, TDS on the amount before GST.
 */

import { payoutFor, REJECT_REASONS, type NewPayout, type RejectReason } from "./partner-rules.ts";
import type { StageKey } from "./lead-rules.ts";
import { validatePan } from "./gstin.ts";

export const MANDATE_MIN_RATE = 0.005;
export const MANDATE_MAX_RATE = 0.08;
/** What the dialog starts on: the trade's usual sole-mandate fee. */
export const MANDATE_DEFAULT_RATE = 0.03;

export type MandateStatus = "INVITED" | "OFFERED" | "LIVE" | "DECLINED" | "WITHDRAWN" | "ENDED";

/** Where a mandate stands on a given day, in the words the desk shows. */
export type MandateState = "invited" | "offered" | "live" | "not_started" | "expired" | "declined" | "withdrawn" | "ended";

export const MANDATE_STATE: Record<MandateState, { label: string; tone: "ok" | "blue" | "warn" | "risk" | "quiet" }> = {
  invited: { label: "Invited to Sales Desk", tone: "blue" },
  offered: { label: "Waiting for their answer", tone: "warn" },
  live: { label: "Live", tone: "ok" },
  not_started: { label: "Starts later", tone: "blue" },
  expired: { label: "Ran out", tone: "quiet" },
  declined: { label: "Declined", tone: "risk" },
  withdrawn: { label: "Withdrawn", tone: "quiet" },
  ended: { label: "Ended", tone: "quiet" },
};

export function mandateState(m: { status: MandateStatus; validFrom: string; validTo: string }, nowIso: string): MandateState {
  switch (m.status) {
    case "INVITED":
      return Date.parse(m.validTo) <= Date.parse(nowIso) ? "expired" : "invited";
    case "OFFERED":
      return Date.parse(m.validTo) <= Date.parse(nowIso) ? "expired" : "offered";
    case "DECLINED":
      return "declined";
    case "WITHDRAWN":
      return "withdrawn";
    case "ENDED":
      return "ended";
    case "LIVE":
      if (Date.parse(nowIso) < Date.parse(m.validFrom)) return "not_started";
      return Date.parse(nowIso) < Date.parse(m.validTo) ? "live" : "expired";
  }
}

/** A mandate earns on a booking made while it is live. */
export const earnsOn = (m: { status: MandateStatus; validFrom: string; validTo: string }, atIso: string) =>
  m.status === "LIVE" && Date.parse(atIso) >= Date.parse(m.validFrom) && Date.parse(atIso) < Date.parse(m.validTo);

/** The most days a tail may run after a mandate ends, and the choices the dialog offers. */
export const MANDATE_MAX_TAIL_DAYS = 180;
export const TAIL_CHOICES = [0, 30, 60, 90, 180] as const;

const DAY = 86_400_000;

type Tailed = { status: MandateStatus; validFrom: string; validTo: string; endedAt?: string | null; tailDays?: number | null };

/** When a mandate stopped earning in the ordinary way: the day it was ended, or its last day, whichever came first. */
export function mandateEnd(m: { validTo: string; endedAt?: string | null }): string {
  return m.endedAt && Date.parse(m.endedAt) < Date.parse(m.validTo) ? m.endedAt : m.validTo;
}

/**
 * The instant a mandate's tail runs out, or null when it has none. Only a
 * mandate that was live has a tail: an offer withdrawn, declined or never
 * answered earned nothing and owes nothing after.
 */
export function tailUntil(m: Tailed): string | null {
  const days = m.tailDays ?? 0;
  if (days <= 0 || (m.status !== "LIVE" && m.status !== "ENDED")) return null;
  return new Date(Date.parse(mandateEnd(m)) + days * DAY).toISOString();
}

/**
 * A booking made after a mandate ended, inside its tail, by a buyer who came
 * while it was live: the first enquiry, the claim of a partner on the firm's
 * desk, or the first site visit fell inside the mandate's live window. Any
 * one of them is enough; none of them, and the booking owes the firm nothing.
 */
export function earnsOnTail(m: Tailed, o: { atIso: string; sourcedAt: (string | null | undefined)[] }): boolean {
  const until = tailUntil(m);
  if (!until) return false;
  const end = Date.parse(mandateEnd(m));
  const at = Date.parse(o.atIso);
  if (!(at >= end && at < Date.parse(until))) return false;
  const from = Date.parse(m.validFrom);
  return o.sourcedAt.some((s) => {
    if (!s) return false;
    const t = Date.parse(s);
    return Number.isFinite(t) && t >= from && t < end;
  });
}

/** What the desk says about a tail, given the IST day it runs to. */
export const tailLine = (untilDay: string) => `Bookings until ${longDay(untilDay)} from buyers who came during the mandate still owe the firm.`;

/** Read the tail the dialog posted: one of the offered choices, or none. */
export function readTail(raw: string): number {
  const n = Number(String(raw ?? "").trim() || 0);
  return Number.isInteger(n) ? n : NaN;
}

/** Two windows share a moment. */
export const overlaps = (a: { validFrom: string; validTo: string }, b: { validFrom: string; validTo: string }) =>
  Date.parse(a.validFrom) < Date.parse(b.validTo) && Date.parse(b.validFrom) < Date.parse(a.validTo);

export type MandateInput = {
  pan: string;
  firmName: string;
  /** Needed only when the firm is not on Sales Desk yet. */
  contactName: string | null;
  contactEmail: string | null;
  /** A fraction: 0.03 is 3 per cent. */
  rate: number;
  projectIds: string[];
  /** The last day it runs, IST. */
  validTo: string;
  /** Days after it ends that its buyers still owe the firm. None when left out. */
  tailDays?: number;
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Every problem at once, keyed by field, in the screen's own words. Empty when it is fine. */
export function mandateProblems(i: MandateInput, o: { onPlatform: boolean; today: string }): Record<string, string> {
  const out: Record<string, string> = {};
  const pan = validatePan(i.pan);
  if (!pan.ok) out.pan = pan.error;
  if (!o.onPlatform && !i.firmName.trim()) out.firmName = "Enter the firm's name.";
  if (!(i.rate >= MANDATE_MIN_RATE && i.rate <= MANDATE_MAX_RATE)) {
    out.rate = `Commission is between ${+(MANDATE_MIN_RATE * 100).toFixed(2)}% and ${MANDATE_MAX_RATE * 100}%.`;
  }
  if (!i.projectIds.length) out.projects = "Choose at least one project.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.validTo) || i.validTo <= o.today) out.validTo = "Pick a last day after today.";
  const tail = i.tailDays ?? 0;
  if (!Number.isInteger(tail) || tail < 0 || tail > MANDATE_MAX_TAIL_DAYS) out.tailDays = `Choose up to ${MANDATE_MAX_TAIL_DAYS} days.`;
  if (!o.onPlatform) {
    if (!i.contactName?.trim()) out.contactName = "Enter who at the firm we should invite.";
    if (!i.contactEmail || !EMAIL.test(i.contactEmail.trim())) out.contactEmail = "Enter their work email.";
  }
  return out;
}

/** Read a percentage the way a person types it ("3", "2.5%") into a fraction. */
export function readRate(raw: string): number {
  const n = Number(String(raw).replace(/%/g, "").trim());
  return Number.isFinite(n) ? Math.round((n / 100) * 100_000) / 100_000 : NaN;
}

/** What a booking under a mandate owes the firm: one rate, no pass-back, two halves. */
export function mandatePayout(o: { agreement: number; rate: number; bookingNo: number; gstRegistered: boolean }):
  | { ok: true; payout: NewPayout }
  | { ok: false; message: string } {
  return payoutFor({
    agreement: o.agreement,
    steps: [{ from: 1, rate: o.rate }],
    booked: o.bookingNo - 1,
    passBack: 0,
    passBackMax: 0,
    gstRegistered: o.gstRegistered,
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The IST day a stored instant falls on: a mandate's last day from its `valid_to`. */
export const lastDay = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

/** `30 Sep 2026`, from `2026-09-30`. */
export function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** A commission rate as people write it: 0.03 is "3%", 0.0225 is "2.25%". */
export const showRate = (rate: number) => `${+(rate * 100).toFixed(2)}%`;

/** The invite a firm not yet on Sales Desk receives. Plain words, no internals. */
export function inviteText(o: { developer: string; firm: string; projects: string[]; rate: number; validTo: string; link: string; tailDays?: number }): {
  subject: string;
  body: string;
} {
  const list = o.projects.length === 1 ? o.projects[0] : `${o.projects.slice(0, -1).join(", ")} and ${o.projects[o.projects.length - 1]}`;
  const tail = o.tailDays ? ` Bookings for ${o.tailDays} days after that, from buyers who came during it, still earn the commission.` : "";
  return {
    subject: `${o.developer} is offering ${o.firm} the mandate for ${list}`,
    body: [
      `${o.developer} is offering ${o.firm} the selling mandate for ${list}, at ${showRate(o.rate)} commission, until ${longDay(o.validTo)}.${tail}`,
      "",
      `To see the offer and answer it, sign up on Sales Desk as a mandate firm, with the PAN ${o.developer} has for your firm:`,
      o.link,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// What Today says about mandates
// ---------------------------------------------------------------------------

export type MandateAlert = {
  id: string;
  severity: "risk" | "warn" | "info";
  title: string;
  why: string;
  tag: string;
  /** Who can act on it. Absent: anybody who sees it, because it only opens a screen. */
  resolvers?: string[];
};

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const listOf = (p: string[]) => (p.length <= 1 ? (p[0] ?? "") : `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`);

/** A firm said no, a live mandate is about to end, or an offer sits unanswered. */
export function mandateAlerts(
  rows: {
    id: string; firm: string; projects: string[]; status: MandateStatus; validTo: string; answeredOn: string | null; offeredOn: string;
    tailDays?: number;
    /** The IST day the firm asked to run it longer, while nobody has answered. */
    extensionAskedOn?: string | null;
  }[],
  today: string,
): MandateAlert[] {
  const between = daysBetween;
  const list = listOf;
  const out: MandateAlert[] = [];
  for (const m of rows) {
    const last = lastDay(m.validTo);
    if (m.status === "LIVE" && m.extensionAskedOn && last >= today) {
      out.push({
        id: `mandate-extension-${m.id}`,
        severity: "warn",
        title: `${m.firm} asks to run the mandate on ${list(m.projects)} longer`,
        why: `It ends on ${longDay(last)}. Run it longer, or let it end on that day.`,
        tag: "Asked",
      });
      continue;
    }
    if (m.status === "LIVE" && m.answeredOn && between(m.answeredOn, today) <= 14 && last >= today) {
      out.push({
        id: `mandate-accepted-${m.id}`,
        severity: "info",
        title: `${m.firm} accepted the mandate for ${list(m.projects)}`,
        why: `Their people now work ${m.projects.length === 1 ? "it" : "them"} in your console, until ${longDay(last)}.`,
        tag: "Accepted",
      });
    }
    if (m.status === "DECLINED" && m.answeredOn && between(m.answeredOn, today) <= 14) {
      out.push({
        id: `mandate-declined-${m.id}`,
        severity: "warn",
        title: `${m.firm} declined the mandate for ${list(m.projects)}`,
        why: "Appoint another firm, or sell it through your channel partners.",
        tag: "Declined",
      });
    } else if (m.status === "LIVE" && last >= today && between(today, last) <= 30) {
      const left = between(today, last);
      out.push({
        id: `mandate-ending-${m.id}`,
        severity: left <= 7 ? "risk" : "warn",
        title: `${m.firm}'s mandate on ${list(m.projects)} ends on ${longDay(last)}`,
        why: m.tailDays
          ? `After that day only buyers who came during it owe them, for ${m.tailDays} days. Run it longer if they are staying on.`
          : "Bookings after that day owe them nothing. Run it longer if they are staying on.",
        tag: left === 0 ? "Ends today" : `${left} ${left === 1 ? "day" : "days"} left`,
      });
    } else if ((m.status === "OFFERED" || m.status === "INVITED") && last > today && between(m.offeredOn, today) >= 7) {
      out.push({
        id: `mandate-waiting-${m.id}`,
        severity: "info",
        title: `${m.firm} has not answered your offer for ${list(m.projects)}`,
        why: m.status === "INVITED"
          ? "They have not signed up yet. Ask them to sign up on Sales Desk as a mandate firm, with their PAN."
          : "It is waiting on their Developers screen. Ask them to accept or decline it.",
        tag: `${between(m.offeredOn, today)} days`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The three kinds of company at sign-up
// ---------------------------------------------------------------------------

/**
 * Today, for a mandate firm: an offer a developer is waiting on, a mandate
 * about to end, and what a developer did to one lately (withdrew, ended,
 * ran it longer).
 */
export function firmAlerts(
  rows: {
    id: string; developer: string; projects: string[]; state: MandateState; validTo: string; tailDays?: number;
    status?: MandateStatus; endedAt?: string | null; renewedAt?: string | null; extensionAskedAt?: string | null;
  }[],
  nowIso: string,
): MandateAlert[] {
  const out: MandateAlert[] = [];
  const today = lastDay(nowIso);
  const recent = (iso: string | null | undefined, days: number) => !!iso && daysBetween(lastDay(iso), today) <= days;
  for (const m of rows) {
    const projects = listOf(m.projects);
    if (m.state === "offered") {
      out.push({
        id: `firm-offer-${m.id}`,
        severity: "warn",
        title: `${m.developer} offers you ${projects}`,
        why: "Accept it to work the project in their console and earn on every booking.",
        tag: "Offer",
        resolvers: ["org:manage"],
      });
    }
    if (m.status === "WITHDRAWN" && recent(m.endedAt, 14)) {
      out.push({
        id: `firm-withdrawn-${m.id}`,
        severity: "info",
        title: `${m.developer} withdrew its offer for ${projects}`,
        why: "There is nothing to answer now.",
        tag: "Withdrawn",
      });
    }
    if (m.status === "ENDED" && m.endedAt && recent(m.endedAt, 14)) {
      const until = tailUntil({ status: "ENDED", validFrom: m.endedAt, validTo: m.validTo, endedAt: m.endedAt, tailDays: m.tailDays ?? 0 });
      out.push({
        id: `firm-ended-${m.id}`,
        severity: "warn",
        title: `${m.developer} ended your mandate on ${projects} on ${longDay(lastDay(m.endedAt))}`,
        why: until
          ? `Bookings until ${longDay(lastDay(new Date(Date.parse(until) - 1).toISOString()))} from buyers who came during it still earn. What you earned stays yours.`
          : "Bookings from now on earn nothing. What you earned stays yours.",
        tag: "Ended",
      });
    }
    if (m.state === "live" && recent(m.renewedAt, 14)) {
      out.push({
        id: `firm-renewed-${m.id}`,
        severity: "info",
        title: `${m.developer} ran your mandate on ${projects} to ${longDay(lastDay(m.validTo))}`,
        why: "Keep working it as before.",
        tag: "Runs longer",
      });
      continue;
    }
    if (m.state === "live") {
      const days = Math.floor((Date.parse(m.validTo) - Date.parse(nowIso)) / 86_400_000);
      if (days >= 0 && days <= 30) {
        const asked = recent(m.extensionAskedAt, 7);
        const earns = m.tailDays
          ? `After its last day only buyers who came during it earn, for ${m.tailDays} days.`
          : "Bookings after its last day earn nothing.";
        out.push({
          id: `firm-ending-${m.id}`,
          severity: days <= 7 ? "risk" : "warn",
          title: `Your mandate on ${projects} ends ${days === 0 ? "today" : `in ${days} ${days === 1 ? "day" : "days"}`}`,
          why: asked ? `${earns} You asked ${m.developer} to run it longer.` : `${earns} Ask ${m.developer} to run it longer from Developers.`,
          tag: days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"} left`,
        });
      }
    }
  }
  return out;
}

/** Today, for a mandate firm: commission to invoice, and an invoice a developer sent back. */
export function commissionAlerts(
  rows: { id: string; developer: string; project: string; unit: string | null; buyer: string | null; cancelled: boolean; halves: FirmHalf[] }[],
): MandateAlert[] {
  const out: MandateAlert[] = [];
  let toSend = 0;
  for (const r of rows) {
    for (const h of r.halves) {
      if (halfState(h, r.cancelled) !== "send_invoice") continue;
      if (h.rejected) {
        const what = [r.project, r.unit, r.buyer].filter(Boolean).join(", ");
        out.push({
          id: `firm-rejected-${r.id}-${h.key}`,
          severity: "risk",
          title: `${r.developer} sent back your invoice for ${what}`,
          why: `${rejectWords(h.rejectReason)}. Send a corrected one.`,
          tag: "Sent back",
          resolvers: ["partner:register"],
        });
      } else toSend++;
    }
  }
  if (toSend) {
    out.push({
      id: "firm-invoices-to-send",
      severity: "warn",
      title: `${toSend} commission ${toSend === 1 ? "invoice" : "invoices"} to send`,
      why: "A booking reached the step that makes its commission due. Send the developer your invoice for it.",
      tag: "Invoice",
      resolvers: ["partner:register"],
    });
  }
  return out;
}

/** Why an invoice came back, in the firm's words. */
export function rejectWords(reason: RejectReason | string | null | undefined): string {
  return reason && reason in REJECT_REASONS ? REJECT_REASONS[reason as RejectReason] : "The developer did not accept it";
}

/**
 * Working through a mandate, a firm's people never book a buyer or cancel a
 * booking: a booking writes the firm's own commission on the developer's
 * books, so the developer records it. The move is refused with what to do.
 */
export function mandateMoveRefusal(from: StageKey, to: StageKey, developer: string): string | null {
  if (to === "booked" && from !== "booked") return `${developer} records each booking. We have told them this buyer booked, and your commission follows once they record it.`;
  if (from === "booked" && to !== "booked") return `Only ${developer} can cancel a booking. Ask them to.`;
  return null;
}

// ---------------------------------------------------------------------------
// What each side is told by email
// ---------------------------------------------------------------------------

export type MandateMail =
  | { kind: "offered"; developer: string; projects: string[]; rate: number; validTo: string; tailDays: number }
  | { kind: "withdrawn"; developer: string; projects: string[] }
  | { kind: "ended"; developer: string; projects: string[]; tailUntil: string | null }
  | { kind: "renewed"; developer: string; projects: string[]; validTo: string }
  | { kind: "accepted"; firm: string; projects: string[]; validTo: string }
  | { kind: "declined"; firm: string; projects: string[] }
  | { kind: "extension"; firm: string; projects: string[]; validTo: string }
  | { kind: "commission"; developer: string; project: string; booking: string; update: string };

/** One email about a mandate, in plain words, with where to act. */
export function mandateMail(m: MandateMail, link: string): { subject: string; body: string } {
  const p = "projects" in m ? listOf(m.projects) : "";
  const lines = (subject: string, ...body: string[]) => ({ subject, body: [...body, "", link].join("\n") });
  switch (m.kind) {
    case "offered":
      return lines(
        `${m.developer} offers you the mandate for ${p}`,
        `${m.developer} is offering your firm the selling mandate for ${p}, at ${showRate(m.rate)} commission, until ${longDay(m.validTo)}.${m.tailDays ? ` Bookings for ${m.tailDays} days after that, from buyers who came during it, still earn.` : ""}`,
        "Accept or decline it on Developers in Sales Desk:",
      );
    case "withdrawn":
      return lines(`${m.developer} withdrew its mandate offer for ${p}`, `${m.developer} withdrew the mandate it offered your firm for ${p}. There is nothing to answer now.`);
    case "ended":
      return lines(
        `${m.developer} ended your mandate for ${p}`,
        `${m.developer} ended your firm's mandate for ${p} today. ${m.tailUntil ? `Bookings until ${longDay(m.tailUntil)} from buyers who came during it still earn.` : "Bookings from now on earn nothing."} What you earned stays yours.`,
        "See your commission on Developers in Sales Desk:",
      );
    case "renewed":
      return lines(`${m.developer} ran your mandate for ${p} longer`, `${m.developer} ran your firm's mandate for ${p} to ${longDay(m.validTo)}.`);
    case "accepted":
      return lines(
        `${m.firm} accepted the mandate for ${p}`,
        `${m.firm} accepted your mandate for ${p}. Their people now work ${m.projects.length === 1 ? "it" : "them"} in your console until ${longDay(m.validTo)}.`,
        "See it on Partners, Mandate firms in Sales Desk:",
      );
    case "declined":
      return lines(`${m.firm} declined the mandate for ${p}`, `${m.firm} declined your mandate for ${p}. Appoint another firm, or sell it through your channel partners.`);
    case "extension":
      return lines(
        `${m.firm} asks to run the mandate for ${p} longer`,
        `${m.firm} asks you to run its mandate for ${p} past ${longDay(m.validTo)}.`,
        "Run it longer, or let it end, on Partners, Mandate firms in Sales Desk:",
      );
    case "commission":
      return lines(`Your commission on ${m.booking}, ${m.project}`, `${m.developer}: ${m.update}`, "See it on Developers in Sales Desk:");
  }
}

export type CompanyKind = "DEVELOPER" | "MANDATE_FIRM" | "CHANNEL_PARTNER";
export const COMPANY_KINDS: CompanyKind[] = ["DEVELOPER", "MANDATE_FIRM", "CHANNEL_PARTNER"];

export const COMPANY_KIND: Record<CompanyKind, { label: string; line: string; param: string }> = {
  DEVELOPER: { label: "Developer", line: "You build and sell your own projects.", param: "developer" },
  MANDATE_FIRM: { label: "Mandate firm", line: "Developers engage you to sell their projects.", param: "mandate" },
  CHANNEL_PARTNER: { label: "Channel partner", line: "You bring buyers to developers' projects.", param: "partner" },
};

export function kindFromParam(raw: string | null | undefined): CompanyKind | null {
  const hit = COMPANY_KINDS.find((k) => COMPANY_KIND[k].param === raw || k === raw);
  return hit ?? null;
}

/**
 * Where a company's people land: the console, for all three kinds. A
 * mandate firm sells developers' projects whether or not the developer is on
 * Sales Desk; a channel partner runs its own ads, callers and site visits
 * across several developers' projects and registers each buyer with the
 * developer (decided 30 September 2026). Each works its own leads in its
 * own tenant.
 */
export const hasConsole = (orgType: string) => orgType === "DEVELOPER" || orgType === "MANDATE_FIRM" || orgType === "CHANNEL_PARTNER";
export const homeFor = (orgType: string) => (hasConsole(orgType) ? "/dashboard" : "/workspace");

/** A company that sells other companies' projects: a mandate firm or a channel partner. Its console speaks of developers. */
export const sellsForOthers = (orgType: string) => orgType === "MANDATE_FIRM" || orgType === "CHANNEL_PARTNER";

export const isAgentNo = (raw: string) => /^A\d{11}$/.test(raw.trim().toUpperCase());

// ---------------------------------------------------------------------------
// The firm's own side: what each half of its commission is doing
// ---------------------------------------------------------------------------

export type FirmHalf = {
  key: "M1" | "M2";
  net: number;
  gross: number;
  stage: "NONE" | "INVOICED" | "VERIFIED" | "APPROVED" | "PAID";
  paidOn: string | null;
  owed: boolean;
  /** The invoice last filed against it, and whether the developer sent it back and why. */
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  rejected?: boolean;
  rejectReason?: RejectReason | null;
};

export type HalfState = "cancelled" | "not_due" | "send_invoice" | "with_developer" | "approved" | "paid";

export const HALF_STATE: Record<HalfState, { label: string; tone: "ok" | "blue" | "warn" | "risk" | "quiet" }> = {
  cancelled: { label: "Booking cancelled", tone: "quiet" },
  not_due: { label: "Not due yet", tone: "quiet" },
  send_invoice: { label: "Send your invoice", tone: "warn" },
  with_developer: { label: "Invoice with the developer", tone: "blue" },
  approved: { label: "Approved for payment", tone: "blue" },
  paid: { label: "Paid", tone: "ok" },
};

/**
 * Where one half of a mandate firm's commission stands, in the firm's own
 * words. A half is due once its milestone is reached (the agreement
 * registered, or 30 per cent collected); a paid half stays paid even when
 * the booking is later cancelled.
 */
export function halfState(h: FirmHalf, cancelled: boolean): HalfState {
  if (h.stage === "PAID") return "paid";
  if (cancelled) return "cancelled";
  if (h.stage === "APPROVED") return "approved";
  if (h.stage === "INVOICED" || h.stage === "VERIFIED") return "with_developer";
  return h.owed ? "send_invoice" : "not_due";
}

/** What the developers owe the firm now, and what they paid it in the last twelve months. */
export function commissionTotals(rows: { cancelled: boolean; halves: FirmHalf[] }[], today: string): { owed: number; paidYear: number; toInvoice: number } {
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  let owed = 0;
  let paidYear = 0;
  let toInvoice = 0;
  for (const r of rows) {
    for (const h of r.halves) {
      const s = halfState(h, r.cancelled);
      if (s === "send_invoice" || s === "with_developer" || s === "approved") owed += h.net;
      if (s === "send_invoice") toInvoice++;
      if (s === "paid" && h.paidOn && h.paidOn > yearAgo) paidYear += h.net;
    }
  }
  return { owed, paidYear, toInvoice };
}
