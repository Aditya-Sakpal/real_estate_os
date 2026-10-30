/**
 * Learning what works: every ad described by its ingredients, each
 * ingredient scored on our own results and on what the market runs, the
 * two blended, and the next creative chosen from the blend. Pure and
 * database-free, covered by `check:logic`.
 *
 * Six rules.
 *
 * 1. **One vocabulary for our ads and theirs.** An ingredient is a
 *    dimension and a value (angle: connectivity, format: carousel). Ours
 *    are read off what a post already records; a competitor's are read off
 *    the ad by a model, into the same values, so the two can be compared.
 * 2. **Our score is qualified buyers for the money**, against the
 *    average of the same ads. Organic posts have no spend and do not
 *    score. A value with little behind it is pulled towards what the
 *    organisation as a whole found (shrinkage: a small sample is not
 *    believed on its own), so two lucky leads never make a winner.
 * 3. **The market's score is what competitors lean on, weighted by how
 *    long each ad ran.** An advertiser keeps paying for what works, so an
 *    ad running for two months counts five times one seen for a week.
 *    Ads carrying a claim no ad of ours may make are left out.
 * 4. **The market leads, and ours takes over.** The market counts like
 *    `marketWeight` qualified buyers of our own (20 by default): with none
 *    of ours it decides, with 20 it counts half, with 80 a fifth.
 * 5. **Most posts follow the scores, some try something else.** The
 *    exploration share (20%) picks what has run least lately, the rotation
 *    the schedule always had, so a young project keeps finding out and a
 *    feed never repeats itself. The rest are drawn by score, never the
 *    same choice twice running when there is another.
 * 6. **The playbook is written by code from the scores**, so every
 *    number a person reads is one the scores hold. Nothing a competitor
 *    wrote is ever printed; only its pattern is counted.
 */

import { sellingKind } from "./creative-rules.ts";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

export type Dim = "angle" | "format" | "template" | "language" | "picture" | "price" | "occasion" | "hook";

export const DIM_LABEL: Record<Dim, string> = {
  angle: "What it leads with",
  format: "Format",
  template: "Design",
  language: "Language",
  picture: "Picture",
  price: "Price on the ad",
  occasion: "Festive",
  hook: "Opening line",
};

/** The dimensions the next creative is chosen along, and the playbook speaks to. */
export const CHOSEN_DIMS: Dim[] = ["angle", "format", "template", "picture", "language"];

export const ANGLES = ["CONNECTIVITY", "VIEW", "SPACE", "AMENITY", "PRICE", "OFFER", "TRUST", "OTHER"] as const;
export type Angle = (typeof ANGLES)[number];

export const HOOKS = ["QUESTION", "NUMBER", "BENEFIT", "OFFER", "EMOTION", "STATEMENT"] as const;
export const PICTURES = ["EXTERIOR", "AMENITY", "INTERIOR", "VIEW", "CONSTRUCTION", "MAP", "PEOPLE", "GRAPHIC", "OTHER"] as const;
export const AD_LANGUAGES = ["en", "hi", "mr", "hinglish", "gu", "ta", "te", "kn", "other"] as const;
export const FORMATS = ["IMAGE", "CAROUSEL", "VIDEO"] as const;

const VALUE_LABEL: Record<string, string> = {
  CONNECTIVITY: "location and connectivity",
  VIEW: "the view",
  SPACE: "open space and greenery",
  AMENITY: "amenities",
  PRICE: "the price",
  OFFER: "an offer",
  TRUST: "the developer's track record",
  OTHER: "other points",
  IMAGE: "single images",
  CAROUSEL: "carousels",
  VIDEO: "videos",
  EXTERIOR: "the building's exterior",
  INTERIOR: "the inside of a home",
  CONSTRUCTION: "construction photos",
  MAP: "maps and plans",
  PEOPLE: "people",
  GRAPHIC: "graphics without a photo",
  SHOWN: "the price shown",
  NOT_SHOWN: "no price",
  FESTIVE: "a festival",
  NONE: "no festival",
  QUESTION: "a question",
  NUMBER: "a number",
  BENEFIT: "a benefit",
  EMOTION: "a feeling",
  STATEMENT: "a plain statement",
  en: "English",
  hi: "Hindi",
  mr: "Marathi",
  hinglish: "Hinglish",
  gu: "Gujarati",
  ta: "Tamil",
  te: "Telugu",
  kn: "Kannada",
  other: "another language",
};

/** A value as a person reads it: "location and connectivity", "carousels". */
export function valueLabel(dim: Dim, value: string, designName?: (key: string) => string | null): string {
  if (dim === "template") {
    const key = value.includes(":") ? value.split(":")[1] : value;
    return designName?.(value) ?? key.replace(/^\d+-/, "").replace(/-/g, " ");
  }
  if (dim === "picture" && value === "AMENITY") return "amenity pictures";
  if (dim === "picture" && value === "VIEW") return "view pictures";
  return VALUE_LABEL[value] ?? value.toLowerCase();
}

const PRICE_WORDS = /(₹|\brs\.?\s?\d|\blakh|\blac\b|\bcr\b|\bcrore|\bstarting\b|\bonwards\b|\bprice)/i;
const OFFER_WORDS = /\b(offer|waiver|no floor rise|discount|scheme|cashback|free|pay \d+|emi|subvention|limited period|book(?:ing)? amount)\b/i;
const TRUST_WORDS = /\b(years?|delivered|legacy|trusted|families|since \d{4}|track record|award)\b/i;

/** What a line leads with, in the vocabulary both sides share. */
export function pointAngle(text: string | null | undefined): Angle {
  const t = (text ?? "").trim();
  if (!t) return "OTHER";
  if (OFFER_WORDS.test(t)) return "OFFER";
  if (PRICE_WORDS.test(t)) return "PRICE";
  const kind = sellingKind(t);
  if (kind === 0) return "CONNECTIVITY";
  if (kind === 1) return "VIEW";
  if (kind === 2) return "SPACE";
  if (kind === 3) return "AMENITY";
  if (TRUST_WORDS.test(t)) return "TRUST";
  return "OTHER";
}

/** An approved asset's category, as a kind of picture. */
export function pictureOf(category: string | null | undefined): string | null {
  switch (category) {
    case "EXTERIOR_RENDER":
      return "EXTERIOR";
    case "AMENITY":
      return "AMENITY";
    case "LOBBY":
    case "SAMPLE_FLAT":
      return "INTERIOR";
    case "CONSTRUCTION":
      return "CONSTRUCTION";
    case "FLOOR_PLAN":
    case "SITE_PLAN":
    case "LOCATION_MAP":
      return "MAP";
    case "NEARBY_PLACE":
      return "VIEW";
    case null:
    case undefined:
      return null;
    default:
      return "OTHER";
  }
}

/** A design template, named with its kind, because image and video designs share numbers. */
export const templateValue = (kind: string, key: string | null | undefined) => (key ? `${kind}:${key}` : null);

export type Ingredients = Partial<Record<Dim, string | null>>;

/** A post the studio made, as its ingredients. */
export function postIngredients(p: {
  kind: string;
  language: string | null;
  headline: string | null;
  templateKey: string | null;
  pictureCategory: string | null;
  priceShown: boolean;
}): Ingredients {
  return {
    angle: pointAngle(p.headline),
    format: p.kind,
    template: templateValue(p.kind, p.templateKey),
    language: p.language,
    picture: pictureOf(p.pictureCategory),
    price: p.priceShown ? "SHOWN" : "NOT_SHOWN",
  };
}

/** A creative a schedule made, as its ingredients. */
export function creativeIngredients(c: {
  kind: string | null;
  language: string | null;
  scheduledTemplate: string | null;
  leadPoint: string | null;
  headline: string | null;
  pictureCategory: string | null;
  occasion: boolean;
}): Ingredients {
  return {
    angle: c.scheduledTemplate === "PRICE_REVEAL" ? "PRICE" : pointAngle(c.leadPoint ?? c.headline),
    format: c.kind ?? "IMAGE",
    template: c.scheduledTemplate ? `SCHEDULED:${c.scheduledTemplate}` : null,
    language: c.language,
    picture: pictureOf(c.pictureCategory),
    price: c.scheduledTemplate === "PRICE_REVEAL" ? "SHOWN" : "NOT_SHOWN",
    occasion: c.occasion ? "FESTIVE" : "NONE",
  };
}

// ---------------------------------------------------------------------------
// Our own score
// ---------------------------------------------------------------------------

/** One of our ads with money behind it. */
export type OwnAd = { ingredients: Ingredients; spend: number; qualified: number };

export type OwnScore = { qualified: number; spend: number; ads: number; score: number };

/** Qualified buyers a value's evidence is pulled towards the prior by. */
export const OWN_PRIOR = 3;

const key = (dim: Dim, value: string) => `${dim}|${value}`;

/**
 * Each value's qualified buyers for the money, against the average of the
 * same ads. `prior` gives the score a value is pulled towards when it has
 * little behind it: the organisation's own for a project, 1 at the top.
 */
export function ownScores(ads: readonly OwnAd[], prior: (dim: Dim, value: string) => number = () => 1): Map<string, OwnScore> {
  const paid = ads.filter((a) => a.spend > 0);
  const spend = paid.reduce((n, a) => n + a.spend, 0);
  const qualified = paid.reduce((n, a) => n + a.qualified, 0);
  const out = new Map<string, OwnScore>();
  if (!spend) return out;
  const groupRate = qualified / spend;
  const tally = new Map<string, { q: number; s: number; n: number }>();
  for (const a of paid) {
    for (const [d, v] of Object.entries(a.ingredients) as [Dim, string | null | undefined][]) {
      if (!v) continue;
      const t = tally.get(key(d, v)) ?? { q: 0, s: 0, n: 0 };
      t.q += a.qualified;
      t.s += a.spend;
      t.n += 1;
      tally.set(key(d, v), t);
    }
  }
  for (const [k, t] of tally) {
    const [d, v] = k.split("|") as [Dim, string];
    // With no qualified buyer anywhere yet, nothing can be told apart.
    const raw = groupRate > 0 ? t.q / t.s / groupRate : 1;
    const p = prior(d, v);
    const score = (t.q * raw + OWN_PRIOR * p) / (t.q + OWN_PRIOR);
    out.set(k, { qualified: t.q, spend: Math.round(t.s), ads: t.n, score: round3(score) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The market's score
// ---------------------------------------------------------------------------

export type MarketAd = { ingredients: Ingredients; runningDays: number | null; flagged: boolean };

export type MarketScore = { ads: number; weight: number; share: number; score: number };

/** How much one competitor ad counts, by how long it had run when it was seen. */
export function longevityWeight(days: number | null): number {
  if (days === null || days < 7) return 0.2;
  if (days < 30) return 0.5;
  if (days < 60) return 0.8;
  return 1;
}

/** Days an ad had run by the day it was seen, or null when nobody noted the start. */
export function runningDays(runningSince: string | null, seenOn: string): number | null {
  if (!runningSince) return null;
  const d = Math.floor((Date.parse(`${seenOn}T00:00:00Z`) - Date.parse(`${runningSince}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/**
 * Each possible value starts with this much weight before any ad is
 * counted (smoothing: a handful of ads cannot make a value look like the
 * whole market, and a value nobody ran is not scored at all).
 */
export const MARKET_ALPHA = 0.5;
/** However one-sided the market, its score stops here. */
export const MARKET_CAP = 2;

/** How many values each dimension has, so a share is read against all of them. */
const CATALOG: Record<Dim, number> = {
  angle: ANGLES.length,
  format: FORMATS.length,
  template: 20,
  language: AD_LANGUAGES.length,
  picture: PICTURES.length,
  price: 2,
  occasion: 2,
  hook: HOOKS.length,
};

/**
 * What the market leans on: each value's weighted share of its dimension,
 * smoothed across every value the dimension has and scaled so an even
 * split scores 1. A market that runs one thing far more than the rest
 * scores it well above 1, up to `MARKET_CAP`.
 */
export function marketScores(ads: readonly MarketAd[]): Map<string, MarketScore> {
  const kept = ads.filter((a) => !a.flagged);
  const out = new Map<string, MarketScore>();
  const byDim = new Map<Dim, Map<string, { w: number; n: number }>>();
  for (const a of kept) {
    const w = longevityWeight(a.runningDays);
    for (const [d, v] of Object.entries(a.ingredients) as [Dim, string | null | undefined][]) {
      if (!v) continue;
      const m = byDim.get(d) ?? new Map<string, { w: number; n: number }>();
      const t = m.get(v) ?? { w: 0, n: 0 };
      t.w += w;
      t.n += 1;
      m.set(v, t);
      byDim.set(d, m);
    }
  }
  for (const [d, m] of byDim) {
    const total = [...m.values()].reduce((n, t) => n + t.w, 0);
    const n = Math.max(m.size, CATALOG[d]);
    for (const [v, t] of m) {
      const share = total ? t.w / total : 0;
      const smoothed = (t.w + MARKET_ALPHA) / (total + MARKET_ALPHA * n);
      const score = Math.min(MARKET_CAP, smoothed * n);
      out.set(key(d, v), { ads: t.n, weight: round2(t.w), share: round3(share), score: round3(score) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The blend
// ---------------------------------------------------------------------------

export const DEFAULT_MARKET_WEIGHT = 20;
export const DEFAULT_EXPLORE = 0.2;

export type Blended = {
  dim: Dim;
  value: string;
  own: OwnScore | null;
  market: MarketScore | null;
  /** How much the market counted, 0 to 1. */
  marketWeight: number;
  score: number;
};

/** How much the market counts against `qualified` buyers of our own. */
export const marketShare = (weight: number, qualified: number) => (weight + qualified > 0 ? weight / (weight + qualified) : 0);

export function blend(own: Map<string, OwnScore>, market: Map<string, MarketScore>, weight: number): Blended[] {
  const keys = new Set([...own.keys(), ...market.keys()]);
  const out: Blended[] = [];
  for (const k of keys) {
    const [dim, value] = k.split("|") as [Dim, string];
    const o = own.get(k) ?? null;
    const m = market.get(k) ?? null;
    // No market ad on this value means the market has not spoken: it counts nothing.
    const w = m ? marketShare(weight, o?.qualified ?? 0) : 0;
    const score = w * (m?.score ?? 1) + (1 - w) * (o?.score ?? 1);
    out.push({ dim, value, own: o, market: m, marketWeight: round3(w), score: round3(score) });
  }
  return out.sort((a, b) => (a.dim < b.dim ? -1 : a.dim > b.dim ? 1 : b.score - a.score));
}

/** The blended score of a value, 1 when nothing is known. */
export function scoreOf(scores: readonly Blended[], dim: Dim, value: string | null | undefined): number {
  return knownScore(scores, dim, value) ?? 1;
}

/** The blended score of a value with evidence behind it, ours or the market's, or null. */
export function knownScore(scores: readonly Blended[], dim: Dim, value: string | null | undefined): number | null {
  if (!value) return null;
  const s = scores.find((x) => x.dim === dim && x.value === value);
  return s && ((s.own?.qualified ?? 0) > 0 || (s.market?.ads ?? 0) > 0) ? s.score : null;
}

/** Whether a dimension has anything to go on, ours or the market's. */
export const knows = (scores: readonly Blended[], dim: Dim) =>
  scores.some((s) => s.dim === dim && ((s.own?.qualified ?? 0) > 0 || (s.market?.ads ?? 0) > 0));

// ---------------------------------------------------------------------------
// Choosing the next creative
// ---------------------------------------------------------------------------

/** A seeded random number from a string, so the same run makes the same choice. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  let a = h || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The first option nobody has used lately, or the one used longest ago. */
function leastRecent<T>(options: readonly T[], used: readonly T[]): T {
  let best = options[0];
  let bestRank = -1;
  for (const o of options) {
    const i = used.indexOf(o);
    const rank = i === -1 ? Number.POSITIVE_INFINITY : i;
    if (rank > bestRank) {
      best = o;
      bestRank = rank;
    }
  }
  return best;
}

export type Pick<T> = { pick: T; by: "LEARNT" | "EXPLORE" | "ROTATION" };

/**
 * One choice among `options`. With nothing learnt, the rotation (least
 * recently used). Otherwise the exploration share still rotates, which is
 * how an option nothing is known about gets tried; the rest is drawn among
 * the options with evidence behind them, by score (sharpened, so a clear
 * winner wins most draws), never repeating the last choice when there is
 * another. `score` answers null for an option nothing is known about.
 */
export function pickLearned<T>(
  options: readonly T[],
  score: (o: T) => number | null,
  opts: { learnt: boolean; explore: number; rand: () => number; recent: readonly T[] },
): Pick<T> {
  if (!options.length) throw new Error("Nothing to choose from.");
  if (options.length === 1) return { pick: options[0], by: opts.learnt ? "LEARNT" : "ROTATION" };
  if (!opts.learnt) return { pick: leastRecent(options, opts.recent), by: "ROTATION" };
  if (opts.rand() < opts.explore) return { pick: leastRecent(options, opts.recent), by: "EXPLORE" };
  const pool = options.filter((o) => o !== opts.recent[0] && score(o) !== null);
  if (!pool.length) {
    const others = options.filter((o) => o !== opts.recent[0]);
    return { pick: leastRecent(others.length ? others : options, opts.recent), by: "EXPLORE" };
  }
  const weights = pool.map((o) => Math.max(0.01, score(o) ?? 1) ** 3);
  const total = weights.reduce((n, w) => n + w, 0);
  let r = opts.rand() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return { pick: pool[i], by: "LEARNT" };
  }
  return { pick: pool[pool.length - 1], by: "LEARNT" };
}

/**
 * The approved selling points in the order the scores favour their angle,
 * keeping the writer's own order among equals. With nothing learnt about
 * angles, the order is left alone.
 */
export function orderByLearning(points: readonly string[], scores: readonly Blended[]): string[] {
  if (!knows(scores, "angle")) return [...points];
  return points
    .map((p, i) => ({ p, i, s: scoreOf(scores, "angle", pointAngle(p)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.p);
}

/**
 * A scheduled post's three choices (the template, the point it leads on,
 * the picture) from the scores, with the exploration share rotating as the
 * schedule always did. The price template still needs an approved price.
 * Returns what `chooseVariation()` returns, plus how each was chosen.
 */
export function chooseLearnedVariation(input: {
  templates: readonly { key: string; needsPrice: boolean }[];
  pools: { talkingPoints: readonly string[]; assetIds: readonly string[]; hasPrice: boolean };
  recent: readonly { template: string; leadPoint: string | null; assetId: string | null }[];
  occasionId: string | null;
  scores: readonly Blended[];
  pictureOf: (assetId: string) => string | null;
  explore: number;
  rand: () => number;
}): { template: string; leadPoint: string | null; assetId: string | null; occasionId: string | null; by: { template: Pick<string>["by"]; leadPoint: Pick<string>["by"] | null; assetId: Pick<string>["by"] | null } } {
  const recent = input.recent.slice(0, 3);
  const allowed = input.templates.filter((t) => !t.needsPrice || input.pools.hasPrice);
  const usable = (allowed.length ? allowed : input.templates).map((t) => t.key);
  const template = pickLearned(usable, (k) => knownScore(input.scores, "template", `SCHEDULED:${k}`), {
    learnt: knows(input.scores, "template"),
    explore: input.explore,
    rand: input.rand,
    recent: recent.map((r) => r.template),
  });
  const lead = input.pools.talkingPoints.length
    ? pickLearned(input.pools.talkingPoints, (p) => knownScore(input.scores, "angle", pointAngle(p)), {
        learnt: knows(input.scores, "angle"),
        explore: input.explore,
        rand: input.rand,
        recent: recent.map((r) => r.leadPoint).filter((p): p is string => p !== null),
      })
    : null;
  const asset = input.pools.assetIds.length
    ? pickLearned(input.pools.assetIds, (a) => knownScore(input.scores, "picture", pictureOf(input.pictureOf(a))), {
        learnt: knows(input.scores, "picture"),
        explore: input.explore,
        rand: input.rand,
        recent: recent.map((r) => r.assetId).filter((a): a is string => a !== null),
      })
    : null;
  return {
    template: template.pick,
    leadPoint: lead?.pick ?? null,
    assetId: asset?.pick ?? null,
    occasionId: input.occasionId,
    by: { template: template.by, leadPoint: lead?.by ?? null, assetId: asset?.by ?? null },
  };
}

// ---------------------------------------------------------------------------
// The playbook
// ---------------------------------------------------------------------------

export type PlaybookLine = { tone: "do" | "avoid" | "market"; dim: Dim; value: string; text: string };

const pct = (x: number) => `${Math.round(Math.abs(x - 1) * 100)}%`;

/** Evidence before a line of our own is written: qualified buyers behind the value. */
export const PLAYBOOK_MIN_QUALIFIED = 5;
/** Competitor ads before a market line is written. */
export const PLAYBOOK_MIN_MARKET = 4;
/** Better or worse than average by this much before it is worth saying. */
export const PLAYBOOK_MIN_GAP = 0.15;

/**
 * Plain sentences from the scores: what works for us, what does not, and
 * what the market leans on. Every number is computed here.
 */
export function playbookLines(scores: readonly Blended[], designName?: (key: string) => string | null): PlaybookLine[] {
  const out: PlaybookLine[] = [];
  for (const dim of CHOSEN_DIMS) {
    const rows = scores.filter((s) => s.dim === dim);
    const ours = rows.filter((s) => s.own && s.own.qualified >= PLAYBOOK_MIN_QUALIFIED);
    const best = [...ours].sort((a, b) => b.own!.score - a.own!.score)[0];
    const worst = [...ours].sort((a, b) => a.own!.score - b.own!.score)[0];
    if (best && best.own!.score >= 1 + PLAYBOOK_MIN_GAP) {
      out.push({
        tone: "do",
        dim,
        value: best.value,
        text: `${cap(valueLabel(dim, best.value, designName))}: ${pct(best.own!.score)} more qualified buyers for the money than our average, across ${best.own!.ads} ${best.own!.ads === 1 ? "ad" : "ads"}.`,
      });
    }
    if (worst && worst !== best && worst.own!.score <= 1 - PLAYBOOK_MIN_GAP) {
      out.push({
        tone: "avoid",
        dim,
        value: worst.value,
        text: `${cap(valueLabel(dim, worst.value, designName))}: ${pct(worst.own!.score)} fewer qualified buyers for the money than our average, across ${worst.own!.ads} ${worst.own!.ads === 1 ? "ad" : "ads"}.`,
      });
    }
    const market = rows.filter((s) => s.market && s.market.ads >= PLAYBOOK_MIN_MARKET);
    const lean = [...market].sort((a, b) => b.market!.share - a.market!.share)[0];
    if (lean && lean.market!.score >= 1 + PLAYBOOK_MIN_GAP) {
      const total = rows.reduce((n, s) => n + (s.market?.ads ?? 0), 0);
      out.push({
        tone: "market",
        dim,
        value: lean.value,
        text: `Competitors lean on ${valueLabel(dim, lean.value, designName)}: ${lean.market!.ads} of ${total} ads.`,
      });
    }
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
