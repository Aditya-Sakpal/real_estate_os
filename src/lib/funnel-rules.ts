/**
 * What an ad's leads became, judged against what the trade expects for a
 * home at that price. Pure and database-free, covered by `check:logic`;
 * the ad's page (`ad-detail.ts`) reads the counts.
 *
 * The formula (`doc/lead-quality.md`): an ad is worth its bookings, and a
 * booking is leads x reached x qualified x visited x booked. So an ad is
 * judged stage by stage, each against the band the research found for
 * Mumbai and Pune, and never on its cost per lead alone: in every Mumbai
 * case read, the cost per lead rose as the visits rose. A cost per lead far
 * below the band is itself a warning: it is what taps by mistake cost.
 *
 * Every rate waits for enough leads to mean something, and the booking
 * stage waits longest, since a buyer here takes about 27 days from the
 * enquiry to a booking (Anarock, H1 FY25).
 */

export type FunnelCounts = {
  /** Rupees spent. */
  spend: number;
  leads: number;
  /** Leads somebody spoke to on a call. */
  reached: number;
  /** Leads that reached Qualified or beyond. */
  qualified: number;
  /** Leads that came for a site visit. */
  visits: number;
  bookings: number;
  /** The cheapest home the ad sells, in rupees, or null. */
  ticket: number | null;
};

/** Cost per lead from Meta that buys real buyers, by the price of the home (Mumbai and Pune, 2026). */
export function cplBand(ticket: number | null): { low: number; high: number } {
  if (ticket === null || ticket <= 0) return { low: 500, high: 1500 };
  if (ticket < 60e5) return { low: 300, high: 900 };
  if (ticket < 1e7) return { low: 500, high: 1500 };
  if (ticket < 3e7) return { low: 800, high: 2000 };
  return { low: 1500, high: 5000 };
}

/** The share of leads each stage should reach, and below which it is a problem. */
export const STAGE_AIMS = {
  reached: { aim: 0.6, alarm: 0.5 },
  qualified: { aim: 0.25, alarm: 0.15 },
  visits: { aim: 0.08, alarm: 0.04 },
} as const;

/** A booking should cost the ads no more than a channel partner's brokerage, about 2.5 per cent. */
export const BOOKING_SHARE = 0.025;

/** Leads before the rates are read, and before the visit rate is. */
export const JUDGE_AFTER_LEADS = 30;
export const VISITS_AFTER_LEADS = 50;

export type FunnelVerdict = {
  tone: "ok" | "warn" | "risk" | "wait";
  headline: string;
  /** Each stage against its aim: "Reached on a call: 12 of 38 (32%), aim 60%". */
  stages: { label: string; count: number; share: number | null; aim: number | null; low: boolean }[];
  /** What to change, when something is wrong. */
  fix: string | null;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const rupees = (r: number) => `Rs ${Math.round(r).toLocaleString("en-IN")}`;

export function funnelVerdict(c: FunnelCounts): FunnelVerdict {
  const band = cplBand(c.ticket);
  const share = (n: number) => (c.leads > 0 ? n / c.leads : null);
  const judged = c.leads >= JUDGE_AFTER_LEADS;
  const stages = [
    { label: "Reached on a call", count: c.reached, share: share(c.reached), aim: STAGE_AIMS.reached.aim, alarm: STAGE_AIMS.reached.alarm, ready: judged },
    { label: "Qualified", count: c.qualified, share: share(c.qualified), aim: STAGE_AIMS.qualified.aim, alarm: STAGE_AIMS.qualified.alarm, ready: judged },
    { label: "Came for a visit", count: c.visits, share: share(c.visits), aim: STAGE_AIMS.visits.aim, alarm: STAGE_AIMS.visits.alarm, ready: c.leads >= VISITS_AFTER_LEADS },
  ];
  const out: FunnelVerdict["stages"] = stages.map((s) => ({ label: s.label, count: s.count, share: s.share, aim: s.aim, low: s.ready && s.share !== null && s.share < s.alarm }));
  out.push({ label: "Booked", count: c.bookings, share: share(c.bookings), aim: null, low: false });

  const cpl = c.leads > 0 ? c.spend / c.leads : null;
  if (c.leads < JUDGE_AFTER_LEADS) {
    const left = JUDGE_AFTER_LEADS - c.leads;
    return {
      tone: "wait",
      headline: `Too early to judge. ${left} more ${left === 1 ? "lead" : "leads"}, about ${rupees(left * band.low)} at a usual cost, before the rates mean something.`,
      stages: out,
      fix: null,
    };
  }
  const qualifiedShare = share(c.qualified) ?? 0;
  if (cpl !== null && cpl < band.low / 2 && qualifiedShare < STAGE_AIMS.qualified.alarm) {
    return {
      tone: "risk",
      headline: `Cheap leads that do not become buyers: ${rupees(cpl)} a lead against ${rupees(band.low)} to ${rupees(band.high)} for a home at this price, and ${pct(qualifiedShare)} qualify.`,
      stages: out,
      fix: "Run it as a new ad from the studio: it now opens a form that confirms the buyer's number, shows the price and asks the budget, and is shown only in the Facebook and Instagram feeds.",
    };
  }
  const reachedShare = share(c.reached) ?? 0;
  if (reachedShare < STAGE_AIMS.reached.alarm) {
    return {
      tone: "risk",
      headline: `Most leads cannot be reached: ${pct(reachedShare)} answered a call, against 60% or more.`,
      stages: out,
      fix: "Numbers that never answer are usually taps by mistake. A new ad from the studio confirms each number with a code.",
    };
  }
  if (qualifiedShare < STAGE_AIMS.qualified.alarm) {
    return {
      tone: "risk",
      headline: `Few leads are buyers for this home: ${pct(qualifiedShare)} qualify, against 25% or more.`,
      stages: out,
      fix: "Print the price on the picture and make sure the form asks the budget, so buyers it does not suit stop before they send it.",
    };
  }
  const visitShare = share(c.visits) ?? 0;
  if (c.leads >= VISITS_AFTER_LEADS && visitShare < STAGE_AIMS.visits.alarm) {
    return {
      tone: "warn",
      headline: `Leads qualify but few visit: ${pct(visitShare)} came, against 8% or more.`,
      stages: out,
      fix: "Offer a site visit on the first call and confirm it the evening before.",
    };
  }
  if (c.bookings > 0 && c.ticket && c.spend / c.bookings > c.ticket * BOOKING_SHARE) {
    return {
      tone: "warn",
      headline: `Each booking cost ${rupees(c.spend / c.bookings)}, more than a partner's brokerage of about ${rupees(c.ticket * BOOKING_SHARE)}.`,
      stages: out,
      fix: null,
    };
  }
  return { tone: "ok", headline: "On track: its leads reach, qualify and visit at the rates good campaigns do.", stages: out, fix: null };
}
