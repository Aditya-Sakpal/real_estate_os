/**
 * One ad's page, the arithmetic half: its days in order with nothing
 * missing, what they add up to, and how its cost per lead sits beside the
 * other ads on the same account. Pure, so `check:logic` holds it.
 */

export type AdDay = {
  /** IST calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Rupees. */
  spend: number;
  impressions: number;
  clicks: number;
  /** Leads that reached us from this ad that day. */
  leads: number;
};

export type AdTotals = {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  /** Clicks over impressions, 0 to 1; null before anybody saw it. */
  clickRate: number | null;
  /** Whole rupees; null before the first lead. */
  costPerLead: number | null;
  /** Rupees a thousand impressions; null before anybody saw it. */
  costPerThousand: number | null;
};

const DAY_MS = 86_400_000;
/** The most days a page draws: two months is a long run for one creative. */
export const MAX_DAYS = 60;

/** `YYYY-MM-DD` one calendar day on. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Every day from the first to the last, a day with no row being a day of
 * nothing (an ad paused for a day spent nothing that day; leaving the day
 * out would close the gap and hide the pause). Held to the last `MAX_DAYS`.
 */
export function fillDays(rows: readonly AdDay[], from: string | null, to: string): AdDay[] {
  const byDay = new Map<string, AdDay>();
  for (const r of rows) {
    const had = byDay.get(r.day);
    byDay.set(
      r.day,
      had
        ? { day: r.day, spend: had.spend + r.spend, impressions: had.impressions + r.impressions, clicks: had.clicks + r.clicks, leads: had.leads + r.leads }
        : { ...r },
    );
  }
  const first = [from, ...byDay.keys()].filter((d): d is string => !!d && d <= to).sort()[0] ?? to;
  const out: AdDay[] = [];
  for (let d = first; d <= to; d = nextDay(d)) {
    out.push(byDay.get(d) ?? { day: d, spend: 0, impressions: 0, clicks: 0, leads: 0 });
  }
  return out.slice(-MAX_DAYS);
}

export function totalsOf(days: readonly AdDay[]): AdTotals {
  const t = days.reduce(
    (a, d) => ({ spend: a.spend + d.spend, impressions: a.impressions + d.impressions, clicks: a.clicks + d.clicks, leads: a.leads + d.leads }),
    { spend: 0, impressions: 0, clicks: 0, leads: 0 },
  );
  return {
    ...t,
    clickRate: t.impressions ? t.clicks / t.impressions : null,
    costPerLead: t.leads ? Math.round(t.spend / t.leads) : null,
    costPerThousand: t.impressions ? Math.round((t.spend / t.impressions) * 1000) : null,
  };
}

export type Peer = { id: string; spend: number; leads: number };

export type PeerStanding = {
  /** This ad's cost per lead, whole rupees. */
  mine: number;
  /** The other ads' together: their spend over their leads. */
  others: number;
  /** How many other ads that is. */
  count: number;
  /** Mine over theirs: under 1 is cheaper. */
  ratio: number;
};

/**
 * This ad's cost per lead beside the other ads on its account, taken
 * together (their spend over their leads, so one ad with two leads does not
 * count as much as one with forty). Nothing to compare when either side has
 * no lead yet.
 */
export function peerStanding(mine: { spend: number; leads: number }, peers: readonly Peer[]): PeerStanding | null {
  const withLeads = peers.filter((p) => p.leads > 0);
  if (!mine.leads || !withLeads.length) return null;
  const spend = withLeads.reduce((a, p) => a + p.spend, 0);
  const leads = withLeads.reduce((a, p) => a + p.leads, 0);
  const m = mine.spend / mine.leads;
  const o = spend / leads;
  return { mine: Math.round(m), others: Math.round(o), count: withLeads.length, ratio: o > 0 ? m / o : 1 };
}

/** "18% cheaper", "2.1 times the cost", "about the same": the standing in words. */
export function standingWords(s: PeerStanding): string {
  if (s.ratio >= 0.95 && s.ratio <= 1.05) return "About the same as";
  if (s.ratio < 1) return `${Math.round((1 - s.ratio) * 100)}% cheaper than`;
  if (s.ratio < 1.5) return `${Math.round((s.ratio - 1) * 100)}% dearer than`;
  return `${s.ratio.toFixed(1)} times the cost of`;
}

/** The measures the chart switches between. */
export type Measure = "spend" | "leads" | "clicks";
export const MEASURES: { key: Measure; label: string }[] = [
  { key: "spend", label: "Spend" },
  { key: "leads", label: "Leads" },
  { key: "clicks", label: "Clicks" },
];

/** The day the chart lights before anybody points at one: the last that had anything. */
export function defaultDay(days: readonly AdDay[], m: Measure): number {
  for (let i = days.length - 1; i >= 0; i--) if (days[i][m] > 0) return i;
  return days.length - 1;
}
