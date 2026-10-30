/**
 * What a qualifying call learned about the buyer, how sure we are of each
 * thing, the score, and where the lead goes next. Pure and database-free,
 * covered by `check:logic`; `qualify.ts` asks the model and writes.
 *
 * Section 02's rules, in code:
 *
 * - Nine fields, each `{ value, confidence, span }`. **No span, no value**:
 *   a field is kept only when the buyer's own words for it are found in the
 *   call's transcript. A model that says "budget 80 lakh" with nothing the
 *   buyer said behind it has invented a fact, and a fact is what the sales
 *   team acts on.
 * - Confidence is capped by what code can check. Where a parser of ours can
 *   read the same words (a budget, a configuration, a timeline) and reads
 *   something else, the model's confidence is cut to `DISAGREE_CAP`.
 * - The score is arithmetic with the tenant's weights, never a model's
 *   opinion. A field under `MIN_CONFIDENCE` counts as unknown.
 * - The route is decided in section 02's order: junk, a partner's buyer, a
 *   number outside India, hot, warm, cold.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { digitsFromWords, rupeesFrom } from "./cadence-rules.ts";
import { UNIT_CONFIGS, bedCountsIn, configDef, configLabel } from "./unit-rules.ts";
import { CONFIGS as BOARD_CONFIGS } from "./lead-rules.ts";

/**
 * A unit type's configuration key as the call reading writes it: a numbered
 * one as `2_BHK`, `2_5_BHK` (the spelling every stored reading already
 * uses), and anything else as the catalog's own key (`1RK`, `PENTHOUSE`,
 * `SHOP`). One catalog, so what a call heard and what a tower sells are
 * compared in one set of words.
 */
export function qualConfigOf(key: string): string | null {
  const m = /^(\d)(_5)?BHK$/.exec(key.trim());
  if (m) return `${m[1]}${m[2] ?? ""}_BHK`;
  return configDef(key) ? key : null;
}

/** The catalog key behind a reading's value: `2_BHK` is `2BHK`. */
export function unitConfigOfQual(value: string): string | null {
  const m = /^(\d)(_5)?_BHK$/.exec(value.trim());
  const key = m ? `${m[1]}${m[2] ?? ""}BHK` : value.trim();
  return configDef(key) ? key : null;
}

const QUAL_CONFIGS = UNIT_CONFIGS.map((c) => qualConfigOf(c.key)).filter((k): k is string => !!k);

export const QUAL_FIELDS = [
  "budget_band",
  "configuration",
  "micro_market",
  "purpose",
  "timeline",
  "funding",
  "current_residence",
  "decision_maker_present",
  "competing_projects",
  "wants",
] as const;
export type QualField = (typeof QUAL_FIELDS)[number];

/** The values each field may take. Micro-market and competitors are the tenant's own lists. */
export const QUAL_VALUES = {
  budget_band: ["UNDER_60L", "60L_90L", "90L_1_5CR", "ABOVE_1_5CR"],
  // Derived from the unit catalog. The values readings stored before
  // (1_BHK, 2_BHK, 2_5_BHK, 3_BHK, 4_BHK, VILLA, PLOT) are all in it.
  configuration: QUAL_CONFIGS as readonly string[],
  purpose: ["END_USE", "INVESTMENT", "UNCLEAR"],
  timeline: ["LE_30D", "31_90D", "91_180D", "GT_180D", "EXPLORING"],
  funding: ["SELF", "LOAN", "LOAN_PRE_APPROVED", "MIXED"],
  current_residence: ["OWNED", "RENTED", "WITH_FAMILY"],
  decision_maker_present: ["YES", "NO"],
} as const;

export type Heard = {
  value: string;
  /** 0 to 1, after our checks. */
  confidence: number;
  /** The buyer's own words, as the transcript has them. */
  span: string;
  /** A locality, who else decides, which projects: words that go with the value. */
  detail?: string;
  /** A budget's top in rupees, when the buyer gave one (a form's band): scored against the price instead of the band's. */
  max?: number;
};

export type Qualification = Partial<Record<QualField, Heard>>;

/** A field counts toward the score only this sure. */
export const MIN_CONFIDENCE = 0.5;
/** A value our own parser reads differently is held at this. */
export const DISAGREE_CAP = 0.4;
/** A value nothing of ours can check is the model's word, and held at this. */
export const UNCHECKED_CAP = 0.8;

// ---------------------------------------------------------------------------
// Finding the buyer's words
// ---------------------------------------------------------------------------

/** Lower case, punctuation out, one space between words. Devanagari is kept. */
export function normaliseWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether the buyer said `span`: its words appear in the transcript in
 * order, side by side, with at most one word different when the span is
 * three words or more (a transcriber writes "lakh" as "lac"). A span of one
 * or two words must be exact.
 */
export function spanFound(span: string, transcript: string): boolean {
  const want = normaliseWords(span);
  const have = normaliseWords(transcript);
  if (!want.length || want.length > have.length) return false;
  const slack = want.length >= 3 ? 1 : 0;
  for (let i = 0; i + want.length <= have.length; i++) {
    let misses = 0;
    for (let j = 0; j < want.length && misses <= slack; j++) if (have[i + j] !== want[j]) misses++;
    if (misses <= slack) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Our own readers, which cap the model's confidence
// ---------------------------------------------------------------------------

export function bandOf(rupees: number): (typeof QUAL_VALUES.budget_band)[number] {
  if (rupees < 60e5) return "UNDER_60L";
  if (rupees <= 90e5) return "60L_90L";
  if (rupees <= 150e5) return "90L_1_5CR";
  return "ABOVE_1_5CR";
}

export function configOfWords(s: string): string | null {
  const t = s.toLowerCase();
  if (/row ?house/.test(t)) return "ROWHOUSE";
  if (/villa|bungalow/.test(t)) return "VILLA";
  if (/pent ?house/.test(t)) return "PENTHOUSE";
  if (/\bjodi\b/.test(t)) return "JODI";
  if (/\bplots?\b|\bland\b/.test(t)) return "PLOT";
  if (/\bshops?\b|\bshowrooms?\b|\bdukaan\b|\bdukan\b/.test(t)) return "SHOP";
  if (/\boffices?\b/.test(t)) return "OFFICE";
  if (/\bstudios?\b/.test(t)) return "STUDIO";
  if (/\b1\s*(?:r\.?\s?k|room,? kitchen)\b/.test(t)) return "1RK";
  // "four plus" and "4+" are the catalog's 4+; a count above four its own.
  if (/\b4\s*\+|\bfour plus\b/.test(t)) return "4PLUS";
  const m = /(\d(?:\.5)?)\s*-?\s*(?:bhk|b h k|bed|bedroom|room)/.exec(t);
  const beds = m ? Number(m[1]) : bedCountsIn(t)[0];
  if (beds === undefined) return null;
  const def = UNIT_CONFIGS.find((c) => c.beds === beds);
  return def ? qualConfigOf(def.key) : null;
}

/** Days until the buyer means to buy, from how they said it, or null. */
export function timelineOfWords(s: string): (typeof QUAL_VALUES.timeline)[number] | null {
  const t = ` ${digitsFromWords(s)} `;
  if (/just looking|exploring|not sure|dekh rahe|abhi nahi|no hurry/.test(t)) return "EXPLORING";
  if (/immediately|right away|this month|asap|turant|is mahine|within (a|one) month|30 days/.test(t)) return "LE_30D";
  const m = /(\d+)\s*(day|days|din|week|weeks|hafte|month|months|mahine|mahina|year|years|saal)/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const days = /day|din/.test(unit) ? n : /week|hafte/.test(unit) ? n * 7 : /month|mahin/.test(unit) ? n * 30 : n * 365;
    if (days <= 30) return "LE_30D";
    if (days <= 90) return "31_90D";
    if (days <= 180) return "91_180D";
    return "GT_180D";
  }
  if (/next year|agle saal/.test(t)) return "GT_180D";
  return null;
}

// ---------------------------------------------------------------------------
// Reading what the model said
// ---------------------------------------------------------------------------

export type ReadContext = {
  /** Everything the buyer said on the call, in order, as the transcript has it. */
  transcript: string;
  microMarkets: readonly string[];
  competitors: readonly string[];
};

const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
const inList = (list: readonly string[], v: string) => list.find((x) => x.trim().toLowerCase() === v.trim().toLowerCase()) ?? null;

/**
 * The model's answer, kept only where it holds up: a known value, and the
 * buyer's own words found in the transcript. Confidence is capped where our
 * readers disagree or cannot check.
 */
export function readQualification(raw: unknown, ctx: ReadContext): Qualification {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Qualification = {};
  for (const field of QUAL_FIELDS) {
    const f = (r[field] ?? null) as { value?: unknown; confidence?: unknown; span?: unknown; detail?: unknown } | null;
    if (!f) continue;
    const span = str(f.span);
    let value = str(f.value);
    const detail = str(f.detail) ?? undefined;
    if (!span || !value || !spanFound(span, ctx.transcript)) continue;
    let confidence = clamp01(f.confidence);
    if (field === "micro_market") {
      value = inList(ctx.microMarkets, value) ?? inList(ctx.microMarkets, detail ?? "") ?? "UNKNOWN";
      confidence = Math.min(confidence, UNCHECKED_CAP);
    } else if (field === "wants") {
      // What they must have, or why this project does not fit them, in
      // their own words: the call's feedback, kept for the next call and
      // for what the area's buyers ask for. Free text, never scored.
      confidence = Math.min(confidence, UNCHECKED_CAP);
    } else if (field === "competing_projects") {
      const named = [value, ...(detail ?? "").split(/,|\band\b/)].map((x) => inList(ctx.competitors, x ?? "")).filter((x): x is string => !!x);
      value = named.length ? [...new Set(named)].join(", ") : "OTHER";
      confidence = Math.min(confidence, UNCHECKED_CAP);
    } else {
      const allowed = QUAL_VALUES[field as keyof typeof QUAL_VALUES] as readonly string[];
      if (!allowed.includes(value)) continue;
      const ours =
        field === "budget_band" ? (() => { const rs = rupeesFrom(span); return rs ? bandOf(rs) : null; })()
        : field === "configuration" ? configOfWords(span)
        : field === "timeline" ? timelineOfWords(span)
        : undefined;
      // Our reader finding nothing is not a disagreement: it cannot read
      // "the budget is seventy" or "after a few months", and holding those
      // at 0.4 scored a buyer who gave both as knowing neither (Northwind,
      // 30 October 2026). Only a different value of its own caps the model.
      if (ours === undefined || ours === null) confidence = Math.min(confidence, UNCHECKED_CAP);
      else if (ours !== value) confidence = Math.min(confidence, DISAGREE_CAP);
    }
    out[field] = { value, confidence: Math.round(confidence * 100) / 100, span, ...(detail ? { detail } : {}) };
  }
  return out;
}

/**
 * Two calls' worth of what a buyer said, as one: a field heard more surely
 * wins, and at the same certainty the newer call wins, because people
 * change their minds.
 */
export function mergeQualification(older: Qualification, newer: Qualification): Qualification {
  const out: Qualification = { ...older };
  for (const field of QUAL_FIELDS) {
    const n = newer[field];
    if (!n) continue;
    const o = out[field];
    if (!o || n.confidence >= o.confidence) out[field] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

export type Weights = {
  timeline: number;
  budget: number;
  decision_maker: number;
  funding: number;
  configuration: number;
  purpose: number;
  micro_market: number;
};

export const DEFAULT_WEIGHTS: Weights = {
  timeline: 25,
  budget: 20,
  decision_maker: 15,
  funding: 15,
  configuration: 10,
  purpose: 10,
  micro_market: 5,
};

export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as (keyof Weights)[];

export const DEFAULT_FLOORS = { hot: 70, warm: 40 } as const;

export type ScoreContext = {
  /** The cheapest approved configuration's price at the tower, in rupees, or null. */
  cheapest: number | null;
  /** Configurations the tower sells, in the qualification's words (`2_BHK`). */
  offered: readonly string[];
  /** Replies the buyer sent on WhatsApp since the call. */
  replies?: number;
};

const BAND_TOP: Record<string, number> = { UNDER_60L: 60e5, "60L_90L": 90e5, "90L_1_5CR": 150e5, ABOVE_1_5CR: Number.POSITIVE_INFINITY };

const HOUSES = new Set(["VILLA", "ROWHOUSE"]);

/** Each field's points, 0 to 1. Unknown is 0: not knowing never raises a score. */
export function points(q: Qualification, ctx: ScoreContext): Record<keyof Weights, number> {
  const sure = (f: QualField) => (q[f] && q[f]!.confidence >= MIN_CONFIDENCE ? q[f]!.value : null);
  const timeline = sure("timeline");
  const band = sure("budget_band");
  const decider = sure("decision_maker_present");
  const funding = sure("funding");
  const config = sure("configuration");
  const purpose = sure("purpose");
  const market = sure("micro_market");
  const top = band ? (typeof q.budget_band?.max === "number" && q.budget_band.max > 0 ? q.budget_band.max : BAND_TOP[band]) : 0;
  const budget = !band
    ? 0
    : ctx.cheapest === null
      ? 0.6
      : top >= ctx.cheapest
        ? 1
        : top >= ctx.cheapest * 0.85
          ? 0.5
          : 0;
  return {
    timeline: ({ LE_30D: 1, "31_90D": 0.8, "91_180D": 0.45, GT_180D: 0.2, EXPLORING: 0 } as Record<string, number>)[timeline ?? ""] ?? 0,
    budget,
    decision_maker: decider === "YES" ? 1 : decider === "NO" ? 0.3 : 0,
    funding: ({ LOAN_PRE_APPROVED: 1, SELF: 0.9, MIXED: 0.8, LOAN: 0.6 } as Record<string, number>)[funding ?? ""] ?? 0,
    // A reading stored before row houses were their own value says VILLA for one.
    configuration: !config
      ? 0
      : !ctx.offered.length || ctx.offered.includes(config) || (HOUSES.has(config) && ctx.offered.some((o) => HOUSES.has(o)))
        ? 1
        : 0.2,
    purpose: ({ END_USE: 1, INVESTMENT: 0.8, UNCLEAR: 0.4 } as Record<string, number>)[purpose ?? ""] ?? 0,
    micro_market: !market ? 0 : market === "UNKNOWN" ? 0.5 : 1,
  };
}

/**
 * Whether the reading knows anything the score counts. A call that learnt
 * nothing (the buyer hung up after hello) is neither warm nor cold.
 */
export function learntAnything(q: Qualification): boolean {
  const scored: QualField[] = ["timeline", "budget_band", "decision_maker_present", "funding", "configuration", "purpose", "micro_market"];
  return scored.some((f) => !!q[f] && q[f]!.confidence >= MIN_CONFIDENCE);
}

/** A reply on WhatsApp is engagement: a few points each, at most `ENGAGED_MAX`. */
export const ENGAGED_POINTS = 5;
export const ENGAGED_MAX = 10;

/** 0 to 100, arithmetic only. */
export function scoreLead(q: Qualification, weights: Weights, ctx: ScoreContext): number {
  const p = points(q, ctx);
  const total = WEIGHT_KEYS.reduce((a, k) => a + Math.max(0, weights[k]), 0);
  if (total <= 0) return 0;
  const got = WEIGHT_KEYS.reduce((a, k) => a + Math.max(0, weights[k]) * p[k], 0);
  const engaged = Math.min(ENGAGED_MAX, (ctx.replies ?? 0) * ENGAGED_POINTS);
  return Math.min(100, Math.round((got / total) * 100) + engaged);
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export type Route = "JUNK" | "CP" | "NRI" | "HOT" | "WARM" | "COLD";

export const ROUTE_WORDS: Record<Route, string> = {
  JUNK: "Junk",
  CP: "Partner's buyer",
  NRI: "NRI desk",
  HOT: "Hot",
  WARM: "Warm",
  COLD: "Cold",
};

/** A number outside India goes to the NRI desk. */
export const isNriNumber = (e164: string) => !e164.startsWith("+91");

/**
 * Section 02's routing table, in its order: junk, a live partner's claim, a
 * number outside +91, hot (at the hot floor, the decision maker on the call,
 * buying inside 90 days), warm (at the warm floor), else cold.
 */
export function routeLead(i: {
  junk: boolean;
  partnerClaim: boolean;
  phone: string;
  score: number;
  q: Qualification;
  floors: { hot: number; warm: number };
  /** A site visit agreed on the call, or one still booked: that buyer is hot whatever the score. */
  visitBooked?: boolean;
}): Route {
  if (i.junk) return "JUNK";
  if (i.partnerClaim) return "CP";
  if (isNriNumber(i.phone)) return "NRI";
  if (i.visitBooked) return "HOT";
  const sure = (f: QualField) => (i.q[f] && i.q[f]!.confidence >= MIN_CONFIDENCE ? i.q[f]!.value : null);
  const soon = sure("timeline") === "LE_30D" || sure("timeline") === "31_90D";
  if (i.score >= i.floors.hot && sure("decision_maker_present") === "YES" && soon) return "HOT";
  if (i.score >= i.floors.warm) return "WARM";
  return "COLD";
}

// ---------------------------------------------------------------------------
// The tenant's settings
// ---------------------------------------------------------------------------

/** Weights as stored, with anything missing or odd set back to its default. */
export function readWeights(raw: unknown): Weights {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of WEIGHT_KEYS) {
    const n = Number(r[k]);
    if (Number.isInteger(n) && n >= 0 && n <= 100) out[k] = n;
  }
  return out;
}

/** Why weights or floors typed in Settings cannot be saved, or null. */
export function scoringProblem(o: { weights: Record<string, string>; hot: string; warm: string }): string | null {
  for (const k of WEIGHT_KEYS) {
    const s = (o.weights[k] ?? "").trim();
    if (!/^\d{1,3}$/.test(s) || Number(s) > 100) return "Each weight is a whole number from 0 to 100.";
  }
  if (WEIGHT_KEYS.every((k) => Number(o.weights[k]) === 0)) return "At least one weight has to count.";
  const hot = o.hot.trim();
  const warm = o.warm.trim();
  if (!/^\d{1,3}$/.test(hot) || !/^\d{1,3}$/.test(warm) || Number(hot) > 100 || Number(warm) > 100) return "Scores are whole numbers from 0 to 100.";
  if (Number(warm) >= Number(hot)) return "Warm has to start below hot.";
  return null;
}

/** A list typed one per line or with commas: trimmed, no repeats, at most 50 of up to 60 letters. */
export function readList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const v = part.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length >= 50) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The board's facts, and what the model is asked
// ---------------------------------------------------------------------------

const BAND_WORDS: Record<string, string> = {
  UNDER_60L: "Under Rs 60 lakh",
  "60L_90L": "Rs 60 to 90 lakh",
  "90L_1_5CR": "Rs 90 lakh to 1.5 Cr",
  ABOVE_1_5CR: "Above Rs 1.5 Cr",
};
/** Every reading's configuration in the catalog's own label: "2 BHK", "1 RK", "Penthouse". */
const CONFIG_WORDS: Record<string, string> = Object.fromEntries(
  QUAL_CONFIGS.map((v) => [v, configLabel(unitConfigOfQual(v) ?? v)]),
);
const TIMELINE_WORDS: Record<string, string> = {
  LE_30D: "Within 30 days", "31_90D": "1 to 3 months", "91_180D": "3 to 6 months", GT_180D: "6 months or more", EXPLORING: "Just exploring",
};

/** The board's own words for what the call was sure of: configuration, budget, timeline. */
export function boardFacts(q: Qualification): { config?: string; budget?: string; timeline?: string } {
  const sure = (f: QualField) => (q[f] && q[f]!.confidence >= MIN_CONFIDENCE ? q[f]!.value : null);
  const out: { config?: string; budget?: string; timeline?: string } = {};
  const c = sure("configuration");
  const b = sure("budget_band");
  const t = sure("timeline");
  // The board's select offers fewer configurations than a call can hear, so
  // only one it offers goes onto the card; the lead's page shows the rest.
  if (c && CONFIG_WORDS[c] && (BOARD_CONFIGS as readonly string[]).includes(CONFIG_WORDS[c])) out.config = CONFIG_WORDS[c];
  if (b && BAND_WORDS[b]) out.budget = BAND_WORDS[b];
  if (t && TIMELINE_WORDS[t]) out.timeline = TIMELINE_WORDS[t];
  return out;
}

/** Each field and value in plain words, for the lead's page. */
export const FIELD_WORDS: Record<QualField, string> = {
  budget_band: "Budget",
  configuration: "Looking for",
  micro_market: "Area",
  purpose: "Buying to",
  timeline: "Buying in",
  funding: "Paying by",
  current_residence: "Lives in",
  decision_maker_present: "Decides",
  competing_projects: "Also seeing",
  wants: "Must have",
};

export function valueWords(field: QualField, h: Heard): string {
  const v = h.value;
  const w: Record<string, string> = {
    ...BAND_WORDS, ...CONFIG_WORDS, ...TIMELINE_WORDS,
    END_USE: "Live in", INVESTMENT: "Invest", UNCLEAR: "Not clear",
    SELF: "Own funds", LOAN: "Home loan", LOAN_PRE_APPROVED: "Loan, pre-approved", MIXED: "Loan and own funds",
    OWNED: "Own home", RENTED: "Rented home", WITH_FAMILY: "With family",
    YES: "Yes, on the call", NO: "Not alone",
    UNKNOWN: "Not on your list", OTHER: "Another project",
  };
  const base = field === "micro_market" || field === "competing_projects" ? (w[v] ?? v) : (w[v] ?? v);
  return h.detail && (field === "current_residence" || field === "decision_maker_present" || field === "micro_market") ? `${base} (${h.detail})` : base;
}

/** The JSON schema the model answers in: every field present, each nullable. */
export function extractionSchema(): Record<string, unknown> {
  const field = (values: readonly string[] | null) => ({
    type: ["object", "null"],
    additionalProperties: false,
    required: ["value", "confidence", "span", "detail"],
    properties: {
      value: values ? { type: ["string", "null"], enum: [...values, null] } : { type: ["string", "null"] },
      confidence: { type: "number" },
      span: { type: ["string", "null"] },
      detail: { type: ["string", "null"] },
    },
  });
  return {
    type: "object",
    additionalProperties: false,
    required: [...QUAL_FIELDS],
    properties: {
      budget_band: field(QUAL_VALUES.budget_band),
      configuration: field(QUAL_VALUES.configuration),
      micro_market: field(null),
      purpose: field(QUAL_VALUES.purpose),
      timeline: field(QUAL_VALUES.timeline),
      funding: field(QUAL_VALUES.funding),
      current_residence: field(QUAL_VALUES.current_residence),
      decision_maker_present: field(QUAL_VALUES.decision_maker_present),
      competing_projects: field(null),
      wants: field(null),
    },
  };
}

/** What the model is told. It reads; code decides what it said counts. */
export function extractionPrompt(o: { microMarkets: readonly string[]; competitors: readonly string[] }): string {
  return [
    "You read the transcript of a call between an AI sales agent and a home buyer in India, and record what the BUYER said about ten things.",
    "For each field give: value (from the allowed values), confidence (0 to 1), span (the buyer's own words, copied exactly from the transcript, a few words), and detail (a short note, or null).",
    "If the buyer did not say it, the whole field is null. Never infer a value from what the agent said, and never guess. A value without the buyer's own words is wrong.",
    "configuration: what they want to buy. N_BHK for a flat of N bedrooms (2_5_BHK for 2.5), 1RK for one room and a kitchen, 4PLUS for four or more, else STUDIO, PENTHOUSE, JODI (two flats joined), VILLA, ROWHOUSE, PLOT, SHOP or OFFICE.",
    "budget_band: the budget in rupees (lakh, crore). timeline: when they mean to buy. funding: own money or a home loan; LOAN_PRE_APPROVED only if they said the loan is already approved.",
    "current_residence: whether they own or rent where they live now; detail is the locality if said. decision_maker_present: YES if the buyer decides alone or the person who decides was on the call; detail is who else decides.",
    `micro_market: the area they want, as said. The developer's areas are: ${o.microMarkets.length ? o.microMarkets.join(", ") : "not listed"}.`,
    `competing_projects: other projects they are looking at, as said. The developer's list of competitors: ${o.competitors.length ? o.competitors.join(", ") : "not listed"}.`,
    "wants: what the buyer said they must have, or why this project does not suit them (a view, a balcony, a floor, an area, a bigger home, a lower price, ready to move), as a short note in English such as \"sea view, high floor\" or \"wants Thane, this is too far\". Only what they said; null when they said nothing like it.",
  ].join("\n");
}

/** The transcript as the model reads it: who spoke, and what, one line each. */
export function transcriptText(turns: readonly { role: string; en: string | null; indic?: string | null }[]): { forModel: string; buyer: string } {
  const lines: string[] = [];
  const buyer: string[] = [];
  for (const t of turns) {
    const words = (t.en ?? t.indic ?? "").trim();
    if (!words) continue;
    lines.push(`${t.role === "agent" ? "Agent" : "Buyer"}: ${words}`);
    if (t.role !== "agent") buyer.push(words, t.indic ?? "");
  }
  return { forModel: lines.join("\n").slice(0, 24_000), buyer: buyer.join(" \n ") };
}
