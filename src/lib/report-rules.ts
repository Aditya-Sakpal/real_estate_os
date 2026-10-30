/**
 * Reports: the funnel priced at every step, cost per booking by source and
 * campaign, and how much of a recent week is still to book.
 *
 * Pure, so the screen and `check:logic` read the same answers. There is no
 * lead, visit or booking table yet, so every figure the screen shows is
 * sample data; what is real is the arithmetic below.
 *
 * Two rules from section 09 of the product flow doc shape it. Media money and
 * partner commission are never added into one number: a Meta rupee decides
 * where next month's budget goes, a commission is what a booking cost once it
 * happened, and a total of the two answers neither question. And nothing is
 * ranked on too few bookings: twenty bookings spread over sixty creatives is
 * a third of a booking each, and a league table built on that is noise.
 */

export type Group = "partner" | "digital" | "portal" | "other";
export type Paid = "media" | "commission" | "none";

export type Source = { key: string; label: string; group: Group; paid: Paid };

export const SOURCES: Source[] = [
  { key: "meta", label: "Meta ads", group: "digital", paid: "media" },
  { key: "google", label: "Google Ads", group: "digital", paid: "media" },
  { key: "99acres", label: "99acres", group: "portal", paid: "media" },
  { key: "magicbricks", label: "MagicBricks", group: "portal", paid: "media" },
  { key: "housing", label: "Housing.com", group: "portal", paid: "media" },
  { key: "nobroker", label: "NoBroker", group: "portal", paid: "media" },
  { key: "portal", label: "Other portals", group: "portal", paid: "media" },
  { key: "cp", label: "Channel partners", group: "partner", paid: "commission" },
  { key: "walkin", label: "Walk-in", group: "other", paid: "none" },
  { key: "referral", label: "Referral", group: "other", paid: "none" },
  { key: "website", label: "Website", group: "digital", paid: "none" },
  { key: "manual", label: "Added by hand", group: "other", paid: "none" },
];

/** A portal lead's source, by the portal on its lineage (`portal-rules.ts` PortalKey). */
export function portalSourceKey(portal: string | undefined): string {
  return ({ "99ACRES": "99acres", MAGICBRICKS: "magicbricks", HOUSING: "housing", NOBROKER: "nobroker" } as Record<string, string>)[
    portal ?? ""
  ] ?? "portal";
}

/** The donut's slices, in the fixed order their colours are assigned in. */
export const GROUPS: { key: Group; label: string }[] = [
  { key: "partner", label: "Channel partners" },
  { key: "digital", label: "Digital ads" },
  { key: "portal", label: "Property portals" },
  { key: "other", label: "Walk-in and referral" },
];

export type Counts = {
  spend: number;
  commission: number;
  leads: number;
  reached: number;
  qualified: number;
  visited: number;
  booked: number;
  agreement: number;
  cancelled: number;
};

export const ZERO: Counts = {
  spend: 0,
  commission: 0,
  leads: 0,
  reached: 0,
  qualified: 0,
  visited: 0,
  booked: 0,
  agreement: 0,
  cancelled: 0,
};

export function add(a: Counts, b: Counts): Counts {
  const out = { ...a };
  for (const k of Object.keys(ZERO) as (keyof Counts)[]) out[k] = a[k] + b[k];
  return out;
}

export function total(list: readonly Counts[]): Counts {
  return list.reduce(add, ZERO);
}

export type StageKey = "leads" | "reached" | "qualified" | "visited" | "booked" | "agreement";

export const STAGES: { key: StageKey; label: string }[] = [
  { key: "leads", label: "Leads" },
  { key: "reached", label: "Reached" },
  { key: "qualified", label: "Qualified" },
  { key: "visited", label: "Visited" },
  { key: "booked", label: "Booked" },
  { key: "agreement", label: "Agreement signed" },
];

export type Step = {
  key: StageKey;
  label: string;
  count: number;
  /** Share of the stage before, null for the first. */
  rate: number | null;
  /** Spend divided by this stage's count, null when there is none. */
  costPer: number | null;
};

/** The funnel, priced at every step by the money that bought it. */
export function funnel(c: Counts, money: number): Step[] {
  return STAGES.map((s, i) => {
    const n = c[s.key];
    const prev = i === 0 ? null : c[STAGES[i - 1].key];
    return {
      key: s.key,
      label: s.label,
      count: n,
      rate: prev === null ? null : prev > 0 ? n / prev : 0,
      costPer: n > 0 && money > 0 ? money / n : null,
    };
  });
}

/**
 * Where the funnel leaks most: the step with the lowest share of the one
 * before it. The last step is left out, because agreement after booking is
 * paperwork rather than persuasion and always reads high.
 */
export function biggestDrop(steps: readonly Step[]): StageKey | null {
  let worst: Step | null = null;
  for (const s of steps.slice(1, -1)) {
    if (s.rate === null) continue;
    if (!worst || s.rate < (worst.rate ?? 1)) worst = s;
  }
  return worst?.key ?? null;
}

/** Fewer bookings than this and a source or campaign is not ranked. */
export const RANK_FLOOR = 3;

export const rankable = (c: Counts) => c.booked >= RANK_FLOOR;

/** What one booking cost from this source, in the money that source costs. */
export function costPerBooking(c: Counts, paid: Paid): number | null {
  const money = paid === "media" ? c.spend : paid === "commission" ? c.commission : 0;
  if (!money || !c.booked) return null;
  return money / c.booked;
}

/** Cancellations as a share of gross bookings. */
export function cancelRate(c: Counts): number | null {
  const gross = c.booked + c.cancelled;
  return gross ? c.cancelled / gross : null;
}

// ---------------------------------------------------------------------------
// Bookings arrive late
// ---------------------------------------------------------------------------

/**
 * The share of a week's eventual bookings that have landed, by the lead's age
 * in weeks. Bookings come 30 to 120 days after the lead, so a lead from last
 * week has barely begun to book and one from four months ago is done.
 */
export function matured(ageWeeks: number): number {
  if (ageWeeks <= 0) return 0;
  if (ageWeeks >= 17) return 1;
  const curve = [0, 0.02, 0.05, 0.1, 0.18, 0.28, 0.38, 0.48, 0.57, 0.65, 0.72, 0.78, 0.83, 0.88, 0.92, 0.95, 0.98];
  return curve[Math.floor(ageWeeks)];
}

/** Under this share landed, a week is still booking and is drawn as such. */
export const STILL_BOOKING = 0.8;

/**
 * Split a whole number across weights so the parts add up to it exactly:
 * floor each share, then hand the remainder to the largest fractions. A
 * column of people that adds up to more than the total above it is a table
 * nobody trusts.
 */
export function apportion(whole: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((t, w) => t + w, 0);
  if (!sum || whole <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (whole * w) / sum);
  const out = exact.map(Math.floor);
  let left = whole - out.reduce((t, n) => t + n, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading numbers
// ---------------------------------------------------------------------------

export const percent = (x: number | null, digits = 0) =>
  x === null ? "None" : `${(x * 100).toFixed(digits).replace(/\.0+$/, "")}%`;

/** Indian grouping for a plain count. */
export const count = (n: number) => Math.round(n).toLocaleString("en-IN");

// ---------------------------------------------------------------------------
// Where the money went: by campaign, by creative, by place
// ---------------------------------------------------------------------------

/**
 * The dimensions paid media rolls up by. A place is the scope tree read
 * upwards (`path @>`): the city a tower sits in is its REGION, the micro-
 * market a developer thinks in, then the project, then the tower itself.
 */
export type Dim = "campaign" | "creative" | "market" | "project" | "tower";

export const DIMS: { key: Dim; label: string }[] = [
  { key: "campaign", label: "Campaign" },
  { key: "creative", label: "Creative" },
  { key: "market", label: "City" },
  { key: "project", label: "Project" },
  { key: "tower", label: "Tower" },
];

export type Placed = {
  source: string;
  project: string;
  campaign: string;
  creative: string;
  market: string;
  tower: string;
  counts: Counts;
};

export type Rolled = { key: string; label: string; sub: string | null; c: Counts };

/** Media money divided by one stage's count, or null when either is none. */
export function costPer(c: Counts, stage: "leads" | "qualified" | "visited" | "booked"): number | null {
  return c.spend > 0 && c[stage] > 0 ? c.spend / c[stage] : null;
}

/**
 * Paid media rolled up by one dimension, ranked by cost per booking where
 * there are enough bookings to rank on and by volume after that. A partner
 * booking never enters: it is costed in commission, and commission is not
 * media money.
 */
export function rollup(rows: readonly Placed[], dim: Dim): Rolled[] {
  const media = new Set(SOURCES.filter((s) => s.paid === "media").map((s) => s.key));
  const by = new Map<string, Rolled>();
  for (const r of rows) {
    if (!media.has(r.source)) continue;
    const label = r[dim] || "Not known";
    const sub = dim === "campaign" || dim === "creative" || dim === "tower" ? r.project : null;
    const key = `${sub ?? ""}|${label}`;
    const cur = by.get(key) ?? { key, label, sub, c: ZERO };
    by.set(key, { ...cur, c: add(cur.c, r.counts) });
  }
  return [...by.values()].sort((a, b) => {
    const ra = rankable(a.c);
    const rb = rankable(b.c);
    if (ra !== rb) return ra ? -1 : 1;
    if (ra) return (costPerBooking(a.c, "media") ?? Infinity) - (costPerBooking(b.c, "media") ?? Infinity);
    return b.c.booked - a.c.booked || b.c.leads - a.c.leads;
  });
}

// ---------------------------------------------------------------------------
// The quarterly check: do qualified leads book?
// ---------------------------------------------------------------------------

/**
 * Section 09: each quarter, recompute the qualified-lead rate against the
 * eventual booking rate per campaign. Qualified is what the ads are told to
 * find; if a campaign's qualified leads never book, the qualification is
 * what is wrong, not the creative.
 */

/** Qualified leads a campaign needs in the quarter before it is judged. */
export const QUARTER_MIN_QUALIFIED = 20;
/** Booking at under this share of the average is "rarely books". */
export const RARELY = 0.5;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The last quarter of the Indian financial year to have ended, as the
 * Mondays its lead weeks start on. Its leads have had at least a quarter
 * to book, which is most of the window a booking lands in.
 */
export function lastFullQuarter(today: string): { from: string; to: string; label: string } {
  const [y, m] = today.split("-").map(Number);
  // Quarters start in April, July, October and January.
  const starts = [1, 4, 7, 10];
  const current = [...starts].reverse().find((s) => m >= s)!;
  let qy = y;
  let q = current - 3;
  if (q < 1) {
    q += 12;
    qy -= 1;
  }
  const from = `${qy}-${String(q).padStart(2, "0")}-01`;
  const endMonth = q + 2;
  const lastDay = new Date(Date.UTC(qy, endMonth, 0)).getUTCDate();
  const to = `${qy}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to, label: `${MONTHS[q - 1]} to ${MONTHS[endMonth - 1]} ${qy}` };
}

/**
 * What Today says about the reports: campaigns whose qualified leads rarely
 * book (the quarterly check), and ads costing twice their group per result
 * (a pause the budget pass proposes). Counts only: no campaign's name, so
 * a member who cannot read reports learns nothing more than that there is
 * something to look at. Each names the key that acts on it.
 */
export type ReportAlert = {
  id: string;
  severity: "warn" | "info";
  title: string;
  why: string;
  action: string;
  href: string;
  tag: string;
  resolvers: string[];
};

export function reportAlerts(o: { rarely: number; quarterLabel: string; pauses: number }): ReportAlert[] {
  const out: ReportAlert[] = [];
  if (o.rarely > 0) {
    out.push({
      id: "quarter-check",
      severity: "warn",
      title: `Qualified leads from ${o.rarely === 1 ? "1 campaign" : `${o.rarely} campaigns`} rarely book`,
      why: `Leads from ${o.quarterLabel}. Check what the agent asks to qualify a buyer before changing the ad.`,
      action: "Open Reports",
      href: "/dashboard/reports#rp-quarter",
      tag: "This quarter",
      resolvers: ["report:read"],
    });
  }
  if (o.pauses > 0) {
    out.push({
      id: "ad-pause-proposed",
      severity: "warn",
      title: `${o.pauses === 1 ? "1 ad costs" : `${o.pauses} ads cost`} twice the others per buyer`,
      why: o.pauses === 1 ? "Worth pausing. Decide on Published." : "Worth pausing. Decide on each on Published.",
      action: "Open ads",
      href: "/dashboard/campaigns/live?view=ads",
      tag: "Pause?",
      resolvers: ["campaign.budget:manage"],
    });
  }
  return out;
}

export type QuarterLine = {
  campaign: string;
  project: string;
  leads: number;
  qualified: number;
  booked: number;
  qualifiedRate: number | null;
  /** Bookings as a share of qualified leads. */
  bookRate: number | null;
  verdict: "BOOKS" | "RARELY_BOOKS" | "TOO_FEW";
};

export function quarterCheck(
  rows: readonly (Placed & { week: string })[],
  today: string,
): { quarter: { from: string; to: string; label: string }; bookRate: number | null; lines: QuarterLine[] } {
  const quarter = lastFullQuarter(today);
  const inQ = rows.filter((r) => r.week >= quarter.from && r.week <= quarter.to);
  const by = new Map<string, QuarterLine>();
  for (const r of inQ) {
    const k = `${r.project}|${r.campaign}`;
    const cur = by.get(k) ?? { campaign: r.campaign, project: r.project, leads: 0, qualified: 0, booked: 0, qualifiedRate: null, bookRate: null, verdict: "TOO_FEW" as const };
    cur.leads += r.counts.leads;
    cur.qualified += r.counts.qualified;
    cur.booked += r.counts.booked;
    by.set(k, cur);
  }
  const all = [...by.values()];
  const q = all.reduce((n, l) => n + l.qualified, 0);
  const b = all.reduce((n, l) => n + l.booked, 0);
  const bookRate = q > 0 ? b / q : null;
  const lines = all
    .map((l) => {
      const qualifiedRate = l.leads ? l.qualified / l.leads : null;
      const own = l.qualified ? l.booked / l.qualified : null;
      const verdict: QuarterLine["verdict"] =
        l.qualified < QUARTER_MIN_QUALIFIED || bookRate === null || own === null
          ? "TOO_FEW"
          : own < bookRate * RARELY
            ? "RARELY_BOOKS"
            : "BOOKS";
      return { ...l, qualifiedRate, bookRate: own, verdict };
    })
    .filter((l) => l.leads > 0)
    .sort((a, b) => (a.verdict === "RARELY_BOOKS" ? -1 : 0) - (b.verdict === "RARELY_BOOKS" ? -1 : 0) || b.qualified - a.qualified);
  return { quarter, bookRate, lines };
}
