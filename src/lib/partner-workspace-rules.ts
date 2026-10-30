/**
 * A channel partner's side of the console: the rules, pure and
 * database-free, covered by `check:logic`.
 *
 * A partner firm runs its own leads, calls and visits like any company in
 * the console, and registers each buyer with the developers that empanelled
 * it. These are the words its Developers screens say that in, the partner's
 * side of the same states the developer's desk shows, and what Today puts
 * in front of it.
 */
import {
  daysBetween,
  docState,
  isOwed,
  ladder,
  pct,
  rateFor,
  nextStep,
  ordinal,
  regState,
  validUntil,
  REJECT_REASONS,
  type Booking,
  type FirmProject,
  type PayState,
  type RefuseReason,
  type Registration,
  type RegState,
  type Step,
} from "./partner-rules.ts";

type Tone = "ok" | "blue" | "warn" | "risk" | "quiet";

/** A half of a commission, as the partner reads it. */
export const HALF_WORDS: Record<PayState, { label: string; tone: Tone }> = {
  held: { label: "Not due yet", tone: "quiet" },
  no_invoice: { label: "Send your invoice", tone: "warn" },
  verify: { label: "Invoice with the developer", tone: "blue" },
  approve: { label: "Being approved", tone: "blue" },
  approved: { label: "Approved, to be paid", tone: "ok" },
  paid: { label: "Paid", tone: "ok" },
  void: { label: "Cancelled", tone: "quiet" },
};

/** A buyer the firm registered, in the partner's words. */
export const BUYER_WORDS: Record<RegState, { label: string; tone: Tone }> = {
  live: { label: "Registered", tone: "blue" },
  lapsing: { label: "Ending soon", tone: "warn" },
  visited: { label: "Visited", tone: "ok" },
  booked: { label: "Booked", tone: "ok" },
  lapsed: { label: "Ran out", tone: "quiet" },
  refused: { label: "Not registered", tone: "risk" },
};

/** Why a registration was refused, never naming another partner. */
export function refusedWhy(reason: RefuseReason, heldUntil: string | undefined, longDay: (d: string) => string): string {
  switch (reason) {
    case "firm":
      return heldUntil ? `Another partner holds this buyer until ${longDay(heldUntil)}` : "Another partner holds this buyer";
    case "direct":
      return "The buyer enquired with the developer directly first";
    case "no_grant":
      return "You were not empanelled on this project then";
    case "agent_rera":
      return "Your agent registration was missing or lapsed";
    case "rate_limited":
      return "That day's registrations were used up";
  }
}

/** Where the firm stands on a project, in its own words. */
export const EMPANELMENT_WORDS: Record<FirmProject["status"], { label: string; tone: Tone }> = {
  live: { label: "Empanelled", tone: "ok" },
  on_hold: { label: "On hold", tone: "warn" },
  ended: { label: "Ended", tone: "quiet" },
  not_started: { label: "Starts soon", tone: "blue" },
};

/** What the firm's next booking on a project earns, and what lifts it. */
export function rateLine(steps: Step[], booked: number): string {
  const now = rateFor(steps, booked + 1);
  const up = nextStep(steps, booked);
  const first = booked === 0 ? `${pct(now)} on your first booking` : `${pct(now)} on your ${ordinal(booked + 1)} booking`;
  return up ? `${first} · ${pct(up.rate)} from your ${ordinal(booked + 1 + up.more)}` : first;
}

export type PartnerTotals = { owed: number; toInvoice: number; paidYear: number; bookings: number };

/** What the firm is owed now, the invoices it has to send, and what it was paid in the last year. */
export function partnerTotals(bookings: readonly Booking[], today: string): PartnerTotals {
  const yearAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  let owed = 0;
  let toInvoice = 0;
  let paidYear = 0;
  for (const b of bookings) {
    for (const r of ladder(b)) {
      if (isOwed(r)) owed += r.invoice.net;
      if (r.state === "no_invoice") toInvoice += 1;
      if (r.state === "paid" && r.paidOn && r.paidOn > yearAgo) paidYear += r.invoice.net;
    }
  }
  return { owed, toInvoice, paidYear, bookings: bookings.filter((b) => !b.cancelled).length };
}

/** The order the Buyers screen lists them in: what needs the partner first. */
const ORDER: Record<RegState, number> = { lapsing: 0, live: 1, visited: 2, booked: 3, lapsed: 4, refused: 5 };

export function sortBuyers<T extends Registration>(rows: readonly T[], today: string): T[] {
  return [...rows].sort((a, b) => {
    const sa = regState(a, today);
    const sb = regState(b, today);
    if (sa !== sb) return ORDER[sa] - ORDER[sb];
    if (sa === "lapsing" || sa === "live" || sa === "visited") return validUntil(a).localeCompare(validUntil(b));
    return b.registeredOn.localeCompare(a.registeredOn);
  });
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export type PartnerItem = {
  id: string;
  severity: "risk" | "warn" | "info";
  title: string;
  why: string;
  action: string;
  href: string;
  /** The keys that can act on it; anybody else sees it and cannot. */
  resolvers: string[];
};

export type TodayInput = {
  /** The firm's own record of its agent registration. */
  agent: { reraNo: string | null; reraTill: string | null };
  /** What each developer holds on file for it, which is what a registration is checked against. */
  onFile: { developer: string; rm: string | null; reraNo: string | null; reraTill: string | null }[];
  projects: { developer: string; project: string; status: FirmProject["status"]; validTo: string }[];
  buyers: (Registration & { live?: boolean; developer: string })[];
  visits: { id: string; buyer: string; tower: string; project: string; day: string; time: string }[];
  bookings: (Booking & { developer: string })[];
  /** False where money may not be named: an invoice to send says which, never how much. */
  amounts: boolean;
};

const DEVELOPERS = "/dashboard/developers";
const BUYERS = "/dashboard/developers/buyers";
const PAYOUTS = "/dashboard/developers/payouts";
const FIRM = "/dashboard/settings/firm";

const inDays = (n: number) => (n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

/**
 * What needs the partner, most urgent first. A registration running out
 * with no visit, the firm's agent registration, an empanelment ending or on
 * hold, an invoice to send, and the visits of the next two days.
 */
export function partnerToday(i: TodayInput, today: string, longDay: (d: string) => string, rupees: (n: number) => string): PartnerItem[] {
  const out: PartnerItem[] = [];

  const agent = docState(i.agent.reraNo ? i.agent.reraTill : null, today);
  if (!i.agent.reraNo) {
    out.push({ id: "agent-missing", severity: "warn", title: "Add your MahaRERA agent number", why: "Developers ask for it before they empanel you.", action: "Add it", href: FIRM, resolvers: ["org:manage"] });
  } else if (agent === "expired" || agent === "missing") {
    out.push({
      id: "agent-lapsed",
      severity: "warn",
      title: "Your MahaRERA agent registration has lapsed",
      why: "Renew it, update your record, and send it to each developer you sell for.",
      action: "Update it",
      href: FIRM,
      resolvers: ["org:manage"],
    });
  } else if (agent === "expiring") {
    out.push({
      id: "agent-expiring",
      severity: "warn",
      title: `Your MahaRERA agent registration ends ${longDay(i.agent.reraTill!)}`,
      why: "Renew it before then, and send it to each developer you sell for.",
      action: "Update it",
      href: FIRM,
      resolvers: ["org:manage"],
    });
  }

  for (const f of i.onFile) {
    const st = docState(f.reraNo ? f.reraTill : null, today);
    const who = f.rm ?? "your relationship manager";
    if (st === "expired" || st === "missing") {
      out.push({
        id: `onfile-${f.developer}`,
        severity: "risk",
        title: `${f.developer} can't take new buyers from you`,
        why: f.reraNo
          ? `The agent registration they hold for you has lapsed. Send ${who} the renewed one.`
          : `They hold no MahaRERA agent registration for you. Send it to ${who}.`,
        action: "Open Developers",
        href: DEVELOPERS,
        resolvers: [],
      });
    } else if (st === "expiring") {
      out.push({
        id: `onfile-${f.developer}`,
        severity: "warn",
        title: `${f.developer} holds your agent registration until ${longDay(f.reraTill!)}`,
        why: `Send ${who} the renewed one before then.`,
        action: "Open Developers",
        href: DEVELOPERS,
        resolvers: [],
      });
    }
  }

  for (const p of i.projects) {
    if (p.status === "on_hold") {
      out.push({
        id: `hold-${p.developer}-${p.project}`,
        severity: "risk",
        title: `${p.project} is on hold`,
        why: `${p.developer} paused your empanelment. You can't register buyers there for now.`,
        action: "Open Developers",
        href: DEVELOPERS,
        resolvers: [],
      });
    } else if (p.status === "live") {
      const left = daysBetween(today, p.validTo);
      if (left <= 30) {
        out.push({
          id: `ending-${p.developer}-${p.project}`,
          severity: left <= 7 ? "risk" : "warn",
          title: `Your empanelment on ${p.project} ends ${inDays(left)}`,
          why: `${p.developer}. Ask your relationship manager to renew it.`,
          action: "Open Developers",
          href: DEVELOPERS,
          resolvers: [],
        });
      }
    }
  }

  for (const b of i.buyers) {
    if (regState(b, today) !== "lapsing" || b.live === false) continue;
    const left = daysBetween(today, validUntil(b));
    out.push({
      id: `lapsing-${b.id}`,
      severity: left <= 2 ? "risk" : "warn",
      title: `${b.buyer}'s registration on ${b.project} ends ${inDays(left)}`,
      why: "Book a site visit to keep the buyer.",
      action: "Book a visit",
      href: `${BUYERS}?book=${b.id}`,
      resolvers: ["partner:register"],
    });
  }

  for (const b of i.bookings) {
    for (const r of ladder(b)) {
      if (r.state !== "no_invoice") continue;
      const half = r.key === "M1" ? "first" : "second";
      const back = b.progress[r.key]?.sentBack;
      out.push({
        id: `invoice-${b.id}-${r.key}`,
        severity: "warn",
        title: back ? `${b.developer} sent back your invoice for ${b.buyer}'s booking` : `Send your invoice for ${b.buyer}'s booking`,
        why: back
          ? `${sentBackWords(back.reason)}. Send a corrected one for the ${half} half${i.amounts ? `, ${rupees(r.invoice.gross)}` : ""}.`
          : `${b.developer} · ${b.place}${b.unit ? ` · ${b.unit}` : ""}: ${half} half${i.amounts ? `, ${rupees(r.invoice.gross)}` : ""}.`,
        action: "See brokerage",
        href: PAYOUTS,
        resolvers: ["payout:read"],
      });
    }
  }

  for (const v of i.visits) {
    const d = daysBetween(today, v.day);
    if (d < 0 || d > 1) continue;
    out.push({
      id: `visit-${v.id}`,
      severity: "info",
      title: `Site visit ${d === 0 ? "today" : "tomorrow"} at ${v.time}: ${v.buyer}`,
      why: `${v.tower}, ${v.project}.`,
      action: "See buyers",
      href: BUYERS,
      resolvers: [],
    });
  }

  const rank = { risk: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Buyers still worth a visit: registered, live, and not yet visited or booked. */
export const canBook = (r: Registration & { live?: boolean }, today: string) =>
  r.live !== false && (regState(r, today) === "live" || regState(r, today) === "lapsing");


// ---------------------------------------------------------------------------
// A firm filing its own invoice with a developer
// ---------------------------------------------------------------------------

/**
 * Whether a firm may file its invoice for one half, from its own console. A
 * channel partner files for its brokerage (PARTNER), a mandate firm for its
 * commission (MANDATE); either only for a half of its own that is owed and
 * has nothing on file. The developer's own checks then run as they do for
 * an invoice its desk files. Null when it may.
 */
export function firmInvoiceRefusal(
  h: { kind: string; firmOrgId: string; stage: string; owed: boolean; cancelled: boolean } | null,
  want: { kind: "PARTNER" | "MANDATE"; firmOrgId: string },
): string | null {
  if (!h || h.kind !== want.kind || h.firmOrgId !== want.firmOrgId) return "That booking is not yours to invoice.";
  if (h.cancelled) return "This booking was cancelled.";
  if (!h.owed) return "This half is not owed yet.";
  if (h.stage !== "NONE") return "Your invoice for this half is already with the developer.";
  return null;
}

/** The half a form names: the first or the second. */
export const halfKey = (raw: unknown): "M1" | "M2" | null => (raw === "M1" || raw === "M2" ? raw : null);

/** Why the developer sent an invoice back, in the partner's words. */
export function sentBackWords(reason: string | null | undefined): string {
  return reason && reason in REJECT_REASONS ? REJECT_REASONS[reason as keyof typeof REJECT_REASONS] : "The developer did not accept it. Ask them why";
}
