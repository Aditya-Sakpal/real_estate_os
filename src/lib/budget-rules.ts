/**
 * Moving budget to the ads that work. Pure and database-free, covered by
 * `check:logic`.
 *
 * Three ads on one project, one of them bringing buyers and two of them not:
 * the pass takes a step of budget from each of the two and gives it to the
 * one. The total the developer approved never changes. What changes is
 * which ad spends it.
 *
 * `doc/post-generation.md` section 11 is the design, and three of its rules
 * are what keep this from chasing noise:
 *
 * 1. **No verdict before evidence.** An ad that has not run for a few days
 *    and spent a floor amount holds, whatever its numbers say. Two clicks
 *    are not a result.
 * 2. **A bounded step, and a cooldown.** At most a fifth of an ad's budget
 *    moves in one pass, and an ad that was just moved is left alone for
 *    three days, so the platform's own learning phase is not reset daily.
 * 3. **Never to zero, never past the cap.** Pausing is a separate decision.
 *    A budget never goes over the daily cap somebody holding the budget key
 *    recorded on the account, and never under the floor the platforms take.
 *
 * The measure is the one a sales head would use: cost per QUALIFIED lead,
 * from our own call outcomes, once there are enough of those to rank on.
 * Before that, cost per lead; before that, cost per click. A cheap click
 * that never becomes a lead is exactly what a click-only rule rewards, which
 * is why the ladder goes that way round.
 */

export type AdPerf = {
  targetId: string;
  /** Rupees a day, as it stands. */
  dailyBudget: number;
  /** The account's recorded ceiling for one ad, in rupees. Null means none set. */
  cap: number | null;
  spendPaise: number;
  clicks: number;
  leads: number;
  qualified: number;
  /** Days it has been spending inside the window. */
  liveDays: number;
  /** When budget was last moved on this ad. */
  lastShiftAt: string | null;
};

export type Metric = "QUALIFIED" | "LEADS" | "CLICKS";

export type Shift = {
  targetId: string;
  from: number;
  to: number;
  rule: "SCALE_UP" | "SCALE_DOWN";
  metrics: { metric: Metric; cost: number | null; groupCost: number; spend: number; results: number };
};

export const BUDGET = {
  /** The window the numbers are read over. */
  windowDays: 7,
  /** Spend below this, in rupees, is not a result. */
  minSpend: 1_500,
  /** Days live before an ad is judged. */
  minDays: 3,
  /** The most of an ad's budget one pass moves. */
  step: 0.2,
  /** Hours an ad is left alone after a move. */
  cooldownHours: 72,
  /** Meta and Google both refuse a daily budget much below this, in rupees. */
  floor: 100,
  /** Results across the group before a measure is trusted to rank on. */
  minResults: 3,
  /** Better than the group by this much is a winner; worse by the other, a loser. */
  winBy: 0.8,
  loseBy: 1.25,
} as const;

type Scored = AdPerf & { results: number; cost: number | null };

/** The measure the group has enough of, best first. */
export function metricFor(ads: readonly AdPerf[]): Metric {
  const sum = (k: "qualified" | "leads" | "clicks") => ads.reduce((n, a) => n + a[k], 0);
  if (sum("qualified") >= BUDGET.minResults) return "QUALIFIED";
  if (sum("leads") >= BUDGET.minResults) return "LEADS";
  return "CLICKS";
}

const resultsOf = (a: AdPerf, m: Metric) => (m === "QUALIFIED" ? a.qualified : m === "LEADS" ? a.leads : a.clicks);

/**
 * The moves for one group: one ad account, one project. Returns nothing
 * when the evidence does not support moving anything, which is most days.
 */
export function planShifts(ads: readonly AdPerf[], nowIso: string): Shift[] {
  const now = Date.parse(nowIso);
  const ready = ads.filter(
    (a) =>
      a.liveDays >= BUDGET.minDays &&
      a.spendPaise >= BUDGET.minSpend * 100 &&
      (!a.lastShiftAt || now - Date.parse(a.lastShiftAt) >= BUDGET.cooldownHours * 3_600_000),
  );
  if (ready.length < 2) return [];

  const metric = metricFor(ready);
  const scored: Scored[] = ready.map((a) => {
    const results = resultsOf(a, metric);
    return { ...a, results, cost: results > 0 ? a.spendPaise / 100 / results : null };
  });
  const spend = scored.reduce((n, a) => n + a.spendPaise / 100, 0);
  const results = scored.reduce((n, a) => n + a.results, 0);
  if (results === 0) return [];
  const groupCost = spend / results;

  const winners = scored.filter((a) => a.cost !== null && a.cost <= groupCost * BUDGET.winBy);
  const losers = scored.filter((a) => a.cost === null || a.cost >= groupCost * BUDGET.loseBy);
  if (!winners.length || !losers.length) return [];

  // What each side can move this pass.
  const canGive = losers.map((a) => Math.max(0, Math.min(Math.floor(a.dailyBudget * BUDGET.step), a.dailyBudget - BUDGET.floor)));
  const canTake = winners.map((a) =>
    Math.max(0, Math.min(Math.floor(a.dailyBudget * BUDGET.step), a.cap === null ? Infinity : a.cap - a.dailyBudget)),
  );
  const give = canGive.reduce((n, x) => n + x, 0);
  const take = canTake.reduce((n, x) => n + x, 0);
  const pool = Math.floor(Math.min(give, take));
  if (pool < 1) return [];

  // Losers give in proportion to what they could; winners take in
  // proportion to how many results they brought, each within its own room.
  const cut = apportion(pool, canGive);
  const weights = winners.map((w, i) => (canTake[i] > 0 ? w.results : 0));
  const add = fillWithin(pool, weights, canTake);

  const metricsOf = (a: Scored) => ({
    metric,
    cost: a.cost === null ? null : Math.round(a.cost),
    groupCost: Math.round(groupCost),
    spend: Math.round(a.spendPaise / 100),
    results: a.results,
  });
  const out: Shift[] = [];
  losers.forEach((a, i) => {
    if (cut[i] > 0) out.push({ targetId: a.targetId, from: a.dailyBudget, to: a.dailyBudget - cut[i], rule: "SCALE_DOWN", metrics: metricsOf(a) });
  });
  winners.forEach((a, i) => {
    if (add[i] > 0) out.push({ targetId: a.targetId, from: a.dailyBudget, to: a.dailyBudget + add[i], rule: "SCALE_UP", metrics: metricsOf(a) });
  });
  return out;
}

/** Whole rupees in proportion to weights, summing exactly to `whole`. */
export function apportion(whole: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((n, w) => n + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (whole * w) / sum);
  const out = raw.map(Math.floor);
  let left = whole - out.reduce((n, x) => n + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    if (weights[i] > 0) {
      out[i] += 1;
      left -= 1;
    }
  }
  return out;
}

/** `whole` spread by weight, no share past its room, the overflow passed on. */
export function fillWithin(whole: number, weights: readonly number[], room: readonly number[]): number[] {
  const out = weights.map(() => 0);
  let left = whole;
  for (let round = 0; round < weights.length && left > 0; round++) {
    const open = weights.map((w, i) => (w > 0 && out[i] < room[i] ? w : 0));
    if (open.every((w) => w === 0)) {
      // Nobody with results has room: whoever has room at all takes it.
      const any = room.map((r, i) => (out[i] < r ? 1 : 0));
      if (any.every((x) => x === 0)) break;
      const share = apportion(left, any);
      share.forEach((s, i) => {
        const put = Math.min(s, room[i] - out[i]);
        out[i] += put;
        left -= put;
      });
      continue;
    }
    const share = apportion(left, open);
    share.forEach((s, i) => {
      const put = Math.min(s, room[i] - out[i]);
      out[i] += put;
      left -= put;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tired creatives and ads worth pausing
// ---------------------------------------------------------------------------

/**
 * post-generation.md section 11, the two signals the budget moves do not
 * act on by themselves. A creative whose own frequency has climbed, or
 * whose click rate has fallen well below where it started, is due a new
 * one. An ad costing far more per result than the ads beside it is worth
 * pausing, and pausing is a person's decision: it is only ever proposed.
 */
export const HEALTH = {
  /** Frequency at which a creative is watched, and at which a new one is due. */
  watchAt: 3.0,
  refreshAt: 3.5,
  /** A fall in click rate against the ad's own first week that says it is tiring. */
  ctrDrop: 0.2,
  /** Impressions each side needs before click rates are compared. */
  minImpressions: 1_000,
  /** Days that make up the baseline and the recent window. */
  baselineDays: 7,
  /** Costing this many times the group per result is worth a person's look. */
  pauseBy: 2,
} as const;

export type DayFigures = { day: string; impressions: number; clicks: number };

export type Health = {
  refresh: "WATCH" | "DUE" | null;
  frequency: number | null;
  /** How far the click rate has fallen from the ad's first week, as a share. */
  ctrDrop: number | null;
  /** Worth a person deciding whether to pause it. Never done automatically. */
  pause: boolean;
};

const ctr = (days: readonly DayFigures[]) => {
  const imp = days.reduce((n, d) => n + d.impressions, 0);
  const clk = days.reduce((n, d) => n + d.clicks, 0);
  return imp >= HEALTH.minImpressions ? clk / imp : null;
};

/** The click rate's fall from the ad's first live week to its last week. */
export function ctrFall(days: readonly DayFigures[]): number | null {
  const live = [...days].filter((d) => d.impressions > 0).sort((a, b) => (a.day < b.day ? -1 : 1));
  if (live.length < HEALTH.baselineDays * 2) return null;
  const base = ctr(live.slice(0, HEALTH.baselineDays));
  const recent = ctr(live.slice(-HEALTH.baselineDays));
  if (base === null || recent === null || base === 0) return null;
  return Math.max(0, 1 - recent / base);
}

/**
 * One ad's health beside the others in its group (one ad account, one
 * project). The pause test uses the same evidence floor and the same
 * measure as the budget moves, so it never fires on two clicks.
 */
export function adHealth(input: { ad: AdPerf; group: readonly AdPerf[]; days: readonly DayFigures[]; frequency: number | null }): Health {
  const { ad, group, days, frequency } = input;
  const ctrDrop = ctrFall(days);
  const refresh =
    frequency !== null && frequency >= HEALTH.refreshAt
      ? "DUE"
      : (frequency !== null && frequency >= HEALTH.watchAt) || (ctrDrop !== null && ctrDrop >= HEALTH.ctrDrop)
        ? "WATCH"
        : null;
  const ready = (a: AdPerf) => a.liveDays >= BUDGET.minDays && a.spendPaise >= BUDGET.minSpend * 100;
  const peers = group.filter(ready);
  let pause = false;
  if (ready(ad) && peers.length >= 2) {
    const metric = metricFor(peers);
    const results = peers.reduce((n, a) => n + resultsOf(a, metric), 0);
    const spend = peers.reduce((n, a) => n + a.spendPaise / 100, 0);
    if (results > 0) {
      const groupCost = spend / results;
      const own = resultsOf(ad, metric);
      const cost = own > 0 ? ad.spendPaise / 100 / own : null;
      pause = cost === null ? ad.spendPaise / 100 >= groupCost * HEALTH.pauseBy : cost >= groupCost * HEALTH.pauseBy;
    }
  }
  return { refresh, frequency, ctrDrop, pause };
}
