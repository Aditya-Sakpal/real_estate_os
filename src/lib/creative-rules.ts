/**
 * Campaign Studio, decided without a database and without a model.
 *
 * Section 08 sets one rule and everything here follows from it: the AI never
 * originates the property. It assembles, adapts and localises material a
 * named human approved, and every claim it makes traces to a fact somebody
 * signed. A model writes the sentences. Nothing a model wrote is trusted.
 *
 * So this file is the gate, not the generator. The generator lives in
 * `creative.ts` and calls somebody else's machine; this decides whether what
 * came back may be advertised. A prompt is guidance and a gate is a control,
 * and only one of those is worth anything when a buyer withdraws under
 * Section 12 with refund, interest and compensation.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

import { asList, fieldByKey } from "./brain-rules.ts";
import {
  bedCountsIn,
  bedsRecorded,
  configDef,
  configLabel,
  configsNamedIn,
  namedProductsIn,
  priceLineLabel,
} from "./unit-rules.ts";
import { adRuleFor, hasTermsApply, hasTravelTime, withoutTermsApply } from "./rera-ad-rules.ts";
import { NAMES_LEAD, angleBreach, type CardAngle } from "./card-angle-core.ts";

// ---------------------------------------------------------------------------
// The axes
// ---------------------------------------------------------------------------

export type Segment = "END_USER" | "UPGRADER" | "INVESTOR" | "NRI";

/**
 * Who the copy is written at.
 *
 * Four, and the fourth is not decoration: an NRI buyer is outside +91, sees
 * different pricing rules and is the one segment the lead router already
 * treats separately. The investor segment is the reason the never-say list
 * exists at all, because copy aimed at yield drifts to returns claims on its
 * own and a returns claim is what Section 12 unwinds a booking over.
 */
export const SEGMENTS: { key: Segment; label: string; detail: string }[] = [
  { key: "END_USER", label: "First home", detail: "Buying to live in, often the first purchase." },
  { key: "UPGRADER", label: "Upgrader", detail: "Already owns, moving to more space." },
  { key: "INVESTOR", label: "Investor", detail: "Buying to let or to hold." },
  { key: "NRI", label: "NRI", detail: "Buying from outside India." },
];

export function isSegment(raw: string | null | undefined): raw is Segment {
  return SEGMENTS.some((s) => s.key === raw);
}

export function segmentLabel(key: string): string {
  return SEGMENTS.find((s) => s.key === key)?.label ?? key;
}

/**
 * One block of copy: a language and a segment.
 *
 * The format is deliberately not on it. Copy does not change between a 1:1
 * feed post and a 9:16 story, the layout does, so putting the format here
 * would multiply every model call by seven and pay seven times for one
 * sentence. Six languages by four segments is twenty four blocks; those
 * twenty four then lay out into however many placements the brief asked for.
 */
export type CopySpec = {
  language: string;
  segment: Segment;
  /** What the card is written for (`card-angle-rules.ts`); a general card when absent. */
  angle?: CardAngle;
};

/** A laid-out asset: a block of copy in one placement. */
export type VariantSpec = CopySpec & { format: string };

/**
 * Nine languages by four segments, plus one card per language for each of
 * the nine angles a template can take (`card-angle-rules.ts`), and no way to
 * ask for more.
 *
 * The ceiling is the catalog's own size rather than a number somebody picked,
 * so it cannot drift away from the lists it bounds.
 */
export const MAX_COPY_BLOCKS = 9 * (SEGMENTS.length + 9);

export function planCopy(input: {
  languages: readonly string[];
  segments?: readonly Segment[];
}): CopySpec[] {
  const segments = input.segments?.length
    ? SEGMENTS.filter((s) => input.segments!.includes(s.key))
    : SEGMENTS;
  const out: CopySpec[] = [];
  for (const language of input.languages) {
    for (const segment of segments) out.push({ language, segment: segment.key });
  }
  return out;
}

export function planVariants(input: {
  languages: readonly string[];
  formats: readonly string[];
  segments?: readonly Segment[];
}): VariantSpec[] {
  return planCopy(input).flatMap((block) =>
    input.formats.map((format) => ({ ...block, format })),
  );
}

// ---------------------------------------------------------------------------
// What the model is asked to return
// ---------------------------------------------------------------------------

export type Copy = {
  headline: string;
  body: string;
  cta: string;
};

/**
 * A card in a language with a script of its own, read back into English by
 * a second model. The gate's word checks read this, because a never-say list
 * written in English cannot be found inside Devanagari.
 */
export type CardReading = {
  headline: string;
  body: string;
  cta: string;
  place: string | null;
  points: string[];
};

/**
 * What a card in Hindi (or another script of its own) carries besides its
 * copy.
 *
 * An image ad is all English or all Hindi, never a mixture (the client, 1
 * October 2026). So a Hindi ad prints its location and price lines in Hindi,
 * and a carousel's point slides say the approved points in Hindi: the writer
 * gives the place and the points in the card's script, in the same call as
 * the copy. None of it is trusted: the card is read back into English
 * (`reading`), the gate reads that, and a place that reads back as anywhere
 * but the signed location refuses the card.
 */
export type LocalLines = {
  /** The exact location, in the card's own script. */
  place: string | null;
  /** The approved selling points the writer was given, each in the card's script. */
  points: { source: string; text: string }[];
  /** The card read back into English, or null when it could not be. */
  reading: CardReading | null;
};

/** A card's local lines as stored; a card written before them, or in English, has none. */
export function storedLocal(raw: unknown): LocalLines | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<LocalLines>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const points = Array.isArray(r.points)
    ? r.points
        .filter((p): p is { source: string; text: string } => !!p && typeof p.source === "string" && typeof p.text === "string")
        .map((p) => ({ source: p.source, text: p.text }))
    : [];
  const g = r.reading as Partial<CardReading> | null | undefined;
  const reading: CardReading | null =
    g && typeof g === "object" && typeof g.headline === "string"
      ? {
          headline: g.headline,
          body: String(g.body ?? ""),
          cta: String(g.cta ?? ""),
          place: text(g.place),
          points: Array.isArray(g.points) ? g.points.map((p) => String(p ?? "")) : [],
        }
      : null;
  const place = text(r.place);
  if (!place && !points.length && !reading) return null;
  return { place, points, reading };
}

/**
 * How much room a placement has.
 *
 * Measured in characters rather than words, because Devanagari and Tamil put
 * far more ink on the line per word than Latin does and the line that breaks
 * is the one that pushes the RERA lockup out of its quadrant. A generous
 * number here is not kindness: it is a story creative that fails the pixel
 * gate after it has been rendered.
 */
export const LENGTHS: Record<string, { headline: number; body: number }> = {
  "Meta feed 1:1": { headline: 60, body: 220 },
  "Meta story 9:16": { headline: 40, body: 110 },
  "Meta reel 9:16": { headline: 40, body: 110 },
  "Google display": { headline: 30, body: 90 },
  "YouTube 16:9": { headline: 55, body: 180 },
  "Portal listing": { headline: 70, body: 400 },
};

export type Budget = {
  headline: number;
  body: number;
  /** Which placement set each bound, so a refusal can name it. */
  headlineFrom: string | null;
  bodyFrom: string | null;
};

/**
 * The tightest placement the brief asked for, which is the one copy must fit.
 *
 * One block has to serve every placement the brief named, so the narrowest of
 * them sets the budget for all of them. Which placement that is travels with
 * the number: "91 characters against 90" is a fact nobody can act on, and
 * "against the 90 that Google display allows" names the thing to drop.
 */
export function budgetFor(formats: readonly string[]): Budget {
  const known = formats.filter((f) => LENGTHS[f]);
  if (!known.length) {
    return { headline: 60, body: 220, headlineFrom: null, bodyFrom: null };
  }
  const tightest = (part: "headline" | "body") =>
    known.reduce((a, b) => (LENGTHS[b][part] < LENGTHS[a][part] ? b : a));
  const headlineFrom = tightest("headline");
  const bodyFrom = tightest("body");
  return {
    headline: LENGTHS[headlineFrom].headline,
    body: LENGTHS[bodyFrom].body,
    headlineFrom,
    bodyFrom,
  };
}

// ---------------------------------------------------------------------------
// The copy gate
// ---------------------------------------------------------------------------

export type Verdict = "PASS" | "FAIL" | "HOLD";

export type ReasonCode =
  | "MISSING_PART"
  | "NEVER_SAY"
  | "UNGROUNDED_MONEY"
  | "UNGROUNDED_RATE"
  | "UNGROUNDED_NUMBER"
  | "POSSESSION_MISMATCH"
  | "NOT_ADVERTISABLE"
  | "NO_TALKING_POINT"
  | "OVER_LENGTH"
  | "NO_FACE_FOR_LANGUAGE"
  | "REGISTRATION_EXPIRING"
  | "UNCHECKED_WORDING"
  | "PRICE_NOT_FOR_CONFIG"
  | "CONFIG_NOT_RECORDED"
  | "PRICE_FORMAT"
  | "STATE_AD_RULE"
  | "MIXED_SCRIPT"
  | "LOCAL_PLACE"
  | "OFF_ANGLE";

export type Reason = { code: ReasonCode; detail: string };

/** FAIL blocks. HOLD renders and never publishes. */
export const REASON_VERDICT: Record<ReasonCode, Exclude<Verdict, "PASS">> = {
  MISSING_PART: "FAIL",
  NEVER_SAY: "FAIL",
  UNGROUNDED_MONEY: "FAIL",
  UNGROUNDED_RATE: "FAIL",
  // "8 min from the station" on a tower with no such fact is a claim about
  // the building nobody made, and a buyer drives there on it.
  UNGROUNDED_NUMBER: "FAIL",
  POSSESSION_MISMATCH: "FAIL",
  NOT_ADVERTISABLE: "FAIL",
  NO_TALKING_POINT: "FAIL",
  OVER_LENGTH: "FAIL",
  // Quoting one configuration's price beside another's name is an active
  // misstatement of what a flat costs, which is the exact thing a buyer acts
  // on and withdraws over.
  PRICE_NOT_FOR_CONFIG: "FAIL",
  // "Rs 2,18,24,000" on an advertisement reads as a quote sheet, not an ad,
  // and nobody in the trade writes it that way. The model's to fix.
  PRICE_FORMAT: "FAIL",
  // What the registering state's authority forbids on an ad: Tamil Nadu and
  // Goa allow a distance and never a travel time, and no "T&C apply".
  STATE_AD_RULE: "FAIL",
  // An image ad is all English or all Hindi (the client, 1 October 2026):
  // "Sea facing ghar" is neither, and the model's to write again.
  MIXED_SCRIPT: "FAIL",
  // A Hindi ad prints the place in Hindi, and one that reads back as another
  // place names the wrong locality on the one line a buyer drives to.
  LOCAL_PLACE: "FAIL",
  // A festival greeting that sells, or a construction update that promises
  // a schedule: the card says what its template must not.
  OFF_ANGLE: "FAIL",
  NO_FACE_FOR_LANGUAGE: "HOLD",
  REGISTRATION_EXPIRING: "HOLD",
  UNCHECKED_WORDING: "HOLD",
  // Naming a configuration nobody recorded is usually a gap in the library
  // rather than an invention by the model, and a person settles it in
  // seconds. A HOLD renders and never publishes, so nothing unsafe ships
  // while somebody works out which it was.
  CONFIG_NOT_RECORDED: "HOLD",
};

/**
 * Where a refusal is fixed.
 *
 * A refusal shown with no way to act on it is only a little better than one
 * not shown at all. The studio used to list "the headline leads on nothing in
 * the approved talking points" on every card and offer nothing but "write it
 * again", which cannot help: the model will lead on the brief's hook again,
 * and the hook is not a signed fact. The fix is in the Brain or the brief, and
 * the screen has to say which.
 *
 * MISSING_PART has nowhere to go. An empty field is the model's failure, and
 * writing again is the whole answer.
 */
export type FixPlace = "brain" | "library" | "brief" | "branding" | "registration";

export const REASON_FIX: Record<ReasonCode, FixPlace | null> = {
  NO_TALKING_POINT: "brain",
  NEVER_SAY: "brain",
  UNCHECKED_WORDING: "brain",
  POSSESSION_MISMATCH: "brain",
  UNGROUNDED_RATE: "brain",
  UNGROUNDED_MONEY: "brain",
  UNGROUNDED_NUMBER: "brain",
  PRICE_NOT_FOR_CONFIG: "library",
  CONFIG_NOT_RECORDED: "library",
  OVER_LENGTH: "brief",
  PRICE_FORMAT: null,
  STATE_AD_RULE: null,
  MIXED_SCRIPT: null,
  LOCAL_PLACE: null,
  OFF_ANGLE: null,
  NO_FACE_FOR_LANGUAGE: "branding",
  REGISTRATION_EXPIRING: "registration",
  NOT_ADVERTISABLE: "registration",
  MISSING_PART: null,
};

/** What each refusal means for the person fixing it, once, in their words. */
export const REASON_HINT: Record<ReasonCode, string> = {
  NO_TALKING_POINT:
    "The headlines lead on something that is not one of the approved talking points.",
  NEVER_SAY: "The copy uses a phrase on the never-say list.",
  UNCHECKED_WORDING: "The approved wording is in another language, so a person has to read it.",
  POSSESSION_MISMATCH: "The copy names a possession year nobody approved.",
  UNGROUNDED_RATE: "The copy states a percentage nobody approved.",
  UNGROUNDED_MONEY: "The copy quotes an amount that is not an approved price.",
  UNGROUNDED_NUMBER: "The copy states a number that is not in the approved facts.",
  PRICE_NOT_FOR_CONFIG: "A price is quoted beside the wrong configuration.",
  CONFIG_NOT_RECORDED: "The copy offers a configuration this tower does not have on record.",
  OVER_LENGTH: "The copy is longer than the tightest placement allows.",
  PRICE_FORMAT: "A price is written out in full. Ads print it as ₹2.19 Cr* or ₹99 Lakh*.",
  STATE_AD_RULE: "The copy says something this state's RERA does not allow on an ad.",
  MIXED_SCRIPT: "The copy mixes English and Hindi. An ad is written all in one.",
  LOCAL_PLACE: "The location is not spelt as the approved one.",
  OFF_ANGLE: "The card says something its kind of ad must not.",
  NO_FACE_FOR_LANGUAGE: "The brand typeface does not cover this language.",
  REGISTRATION_EXPIRING: "The registration runs out within 30 days.",
  NOT_ADVERTISABLE: "This phase cannot be advertised.",
  MISSING_PART: "A part of the copy came back empty. Write it again.",
};

/**
 * Which refusals are the model's mistake, and which only a person can clear.
 *
 * The studio used to show every refusal to the client and offer "write it
 * again", which asked them to keep pressing a button until the model got it
 * right. That is our job. A block refused for something the model wrote (too
 * long, off the approved points, an amount nobody published) is written
 * again with the refusal spelled out, before anybody sees it.
 *
 * The rest are facts about the brief, the Brain or the registration. Writing
 * again changes none of them: a typeface that cannot set Tamil still cannot
 * set Tamil on the third attempt. Those are what a person is shown.
 */
export const MODEL_FIXABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "MISSING_PART",
  "NEVER_SAY",
  "UNGROUNDED_MONEY",
  "UNGROUNDED_RATE",
  "UNGROUNDED_NUMBER",
  "POSSESSION_MISMATCH",
  "NO_TALKING_POINT",
  "OVER_LENGTH",
  "PRICE_NOT_FOR_CONFIG",
  "CONFIG_NOT_RECORDED",
  "PRICE_FORMAT",
  "STATE_AD_RULE",
  "MIXED_SCRIPT",
  "LOCAL_PLACE",
  "OFF_ANGLE",
  // Retired: a card stored with it is written again, and clears without it.
  "NO_FACE_FOR_LANGUAGE",
]);

/** How many times one block is written before its best attempt is kept. */
export const MAX_WRITE_ATTEMPTS = 3;

/** Whether writing this block again could change its verdict. */
export function needsRewrite(reasons: readonly Reason[]): boolean {
  return reasons.some((r) => MODEL_FIXABLE.has(r.code));
}

/** The refusals a person has to act on, which are the ones a rewrite cannot clear. */
export function forAPerson(reasons: readonly Reason[]): Reason[] {
  return reasons.filter((r) => !MODEL_FIXABLE.has(r.code));
}

const VERDICT_RANK: Record<Verdict, number> = { PASS: 0, HOLD: 1, FAIL: 2 };

/**
 * The better of two attempts at one block.
 *
 * A cleaner verdict wins, and between two of the same, fewer refusals. Kept
 * rather than the LAST attempt, because a third attempt that is worse than
 * the second is a thing models do.
 */
export function betterAttempt<T extends { verdict: Verdict; reasons: readonly Reason[] }>(
  a: T | null,
  b: T,
): T {
  if (!a) return b;
  const ra = VERDICT_RANK[a.verdict];
  const rb = VERDICT_RANK[b.verdict];
  if (rb !== ra) return rb < ra ? b : a;
  return b.reasons.length < a.reasons.length ? b : a;
}

/**
 * What the writer is told after an attempt was refused.
 *
 * The gate's own words, because they already name the number and the limit
 * ("Body is 92 characters against the 90 that Google display allows"), plus
 * the one refusal whose words describe the rule rather than the fix.
 */
const HOW_TO_FIX: Partial<Record<ReasonCode, string>> = {
  NO_TALKING_POINT:
    "Start the headline with one of the approved facts, in its own words.",
  MISSING_PART: "Fill in the headline, the body and the call to action.",
};

export function feedbackFor(copy: Copy, reasons: readonly Reason[]): string {
  const fixable = reasons.filter((r) => MODEL_FIXABLE.has(r.code));
  const lines = [
    "Your last attempt was refused. It said:",
    `  Headline: ${copy.headline}`,
    `  Body: ${copy.body}`,
    `  Call to action: ${copy.cta}`,
    "What was wrong:",
    ...[...new Set(fixable.map((r) => HOW_TO_FIX[r.code] ?? r.detail))].map((l) => `  - ${l}`),
    "Write it again and fix exactly these. Use only the approved facts.",
  ];
  return lines.join("\n");
}

/**
 * What the writer is told to lead with.
 *
 * The brief's hook when it is an approved talking point, and otherwise the
 * approved points in general. Telling the model to lead with a hook nobody
 * approved, and then refusing every headline that did, was the system
 * contradicting itself: "Lead with: Metro and connectivity" beside "use only
 * the approved facts" on a tower with no metro fact.
 *
 * With no approved point there is nothing to lead on, and the hook is never
 * passed on in its place: "Lead with: Near schools" on a Brain with no
 * talking points came back as "Family Homes Near Schools" on every card.
 * Copy is not written at all in that case (`NO_POINTS_MESSAGE`); this only
 * makes sure the line could never say it.
 */
export function leadLine(hook: string | null, talkingPoints: readonly string[]): string | null {
  if (!talkingPoints.length) return null;
  if (hookIsApproved(hook, talkingPoints)) return `Lead with: ${hook!.trim()}`;
  return "Lead the headline with one of the approved facts below.";
}

/**
 * Why no copy is written: there is no approved selling point to write it
 * from. Refused before the writer is paid, in the studio and in a scheduled
 * run alike, because a writer with nothing to lead on invents something.
 */
export const NO_POINTS_MESSAGE = "Add at least one approved selling point to this project's facts first.";

/** Whether there is anything an ad could be built on. The spec sheet does not count. */
export function hasSellingPoint(ground: Pick<Ground, "talkingPoints">): boolean {
  return sellingPoints(ground.talkingPoints).length > 0;
}

/**
 * What exactly to change, in the person's own terms.
 *
 * `REASON_HINT` names the rule. That turned out not to be enough: "the
 * headlines lead on something that is not one of the approved talking
 * points" is true and still leaves somebody asking what they are supposed to
 * edit. Nearly every time the answer is the brief's HOOK, because the writer
 * is told to lead with it, so a hook nobody approved produces a headline
 * nobody approved on every block at once. This says that, with the value.
 *
 * `hookIsApproved` decides which of three things to say, so it is exported
 * for the screen that offers the replacements.
 */
export type FixAdvice = {
  /** What is wrong, naming the actual value. */
  problem: string;
  /** What to change. One sentence, and it names the control. */
  change: string;
};

export function hookIsApproved(hook: string | null, talkingPoints: readonly string[]): boolean {
  if (!hook?.trim()) return false;
  const h = fold(hook);
  return talkingPoints.some((p) => fold(p) === h);
}

export function adviceFor(
  code: ReasonCode,
  ctx: {
    node: string;
    hook: string | null;
    talkingPoints: readonly string[];
    /** The distinct `detail` strings the gate wrote for this code. */
    details: readonly string[];
    /** Every amount a creative may quote, already written the Indian way. */
    approvedAmounts?: readonly string[];
    /** Headlines that were refused, so the note can quote what went wrong. */
    examples?: readonly string[];
  },
): FixAdvice {
  const said = [...new Set(ctx.details)].join(" ");
  switch (code) {
    case "NO_TALKING_POINT": {
      if (!ctx.talkingPoints.length) {
        return {
          problem: `${ctx.node} has no approved selling points, so there is nothing for a headline to lead on.`,
          change: `Add at least one selling point to ${ctx.node}'s facts and get it approved.`,
        };
      }
      if (!ctx.hook?.trim()) {
        return {
          problem: `The brief has no hook, so the headlines led on something that is not approved for ${ctx.node}.`,
          change: "Pick one of the approved points below as the hook, then write it again.",
        };
      }
      if (!hookIsApproved(ctx.hook, ctx.talkingPoints)) {
        return {
          problem: `The brief's hook is "${ctx.hook.trim()}", and that is not an approved talking point for ${ctx.node}.`,
          change: `Use one of the approved points below as the hook. If "${ctx.hook.trim()}" is true, add it to ${ctx.node}'s facts instead and get it approved.`,
        };
      }
      const ex = [...new Set(ctx.examples ?? [])].slice(0, 2).map((h) => `"${h}"`);
      return {
        problem: ex.length
          ? `The hook is approved, but ${ex.length === 1 ? "a headline leads" : "some headlines lead"} on something else, like ${ex.join(" and ")}.`
          : "The hook is approved, but some headlines lead on something else.",
        change: "Write it again. The copy is told to lead with the hook.",
      };
    }
    case "OVER_LENGTH":
      return {
        problem: said,
        change:
          "Write it again, which usually fixes a small overrun. If it keeps happening, remove that format from the brief.",
      };
    case "UNGROUNDED_MONEY":
      return {
        problem: said,
        change: ctx.approvedAmounts?.length
          ? `Write it again. The amounts it may use are ${ctx.approvedAmounts.join(", ")}. If the amount is real, add it to ${ctx.node}'s facts.`
          : `Write it again. If the amount is real, add it to ${ctx.node}'s facts.`,
      };
    case "UNGROUNDED_RATE":
      return { problem: said, change: "Write it again. A percentage has to be in an approved talking point first." };
    case "UNGROUNDED_NUMBER":
      return {
        problem: said,
        change: `Write it again. If the number is true (minutes to the station, acres, floors), add it to ${ctx.node}'s facts first.`,
      };
    case "POSSESSION_MISMATCH":
      return { problem: said, change: `Write it again, or correct the possession date in ${ctx.node}'s facts.` };
    case "NEVER_SAY":
      return { problem: said, change: "Write it again. The phrase is on the never-say list." };
    case "PRICE_NOT_FOR_CONFIG":
      return { problem: said, change: "Write it again. Each flat type must be quoted with its own price." };
    case "CONFIG_NOT_RECORDED":
      return { problem: said, change: "Add that flat type to the configurations, or write it again." };
    case "NO_FACE_FOR_LANGUAGE":
      return { problem: said, change: "Record which languages the brand typeface covers, or drop the language from the brief." };
    case "REGISTRATION_EXPIRING":
      return { problem: said, change: "Renew the registration or file the extension. A person can still approve it." };
    case "UNCHECKED_WORDING":
      return { problem: said, change: "Write the card again. It is read back and checked each time." };
    case "NOT_ADVERTISABLE":
      return { problem: said, change: "Record a registration that is in force." };
    case "MISSING_PART":
      return { problem: said, change: "Write it again." };
    case "PRICE_FORMAT":
      return { problem: said, change: "Write it again; the price is printed in Lakh or Cr." };
    case "STATE_AD_RULE":
      return { problem: said, change: "Write it again without it." };
    case "MIXED_SCRIPT":
      return { problem: said, change: "Write it again in one language." };
    case "LOCAL_PLACE":
      return { problem: said, change: "Write it again." };
    case "OFF_ANGLE":
      return { problem: said, change: "Write it again." };
  }
}

/**
 * Whether a block was written against something that has since changed.
 *
 * A verdict is only true of the brief and the facts it was reached on. The
 * studio compared OLD blocks to the CURRENT brief and got it wrong in a way
 * that looked like advice: the hook was changed to an approved point a
 * quarter of a second after the run finished, so every block still led on the
 * old hook, and the screen reported "the hook is approved, but some headlines
 * drifted away from it", pointing at a Brain with nothing to change in it.
 *
 * Two causes, told apart because they send a person to different places. The
 * brief edited after the block was written, by its time. The facts moved, by
 * comparing the ground the verdict stored with the ground now: only the parts
 * a claim is measured against, and never the days left on a registration,
 * which changes every morning without anything changing.
 */
export type Staleness = "brief" | "facts" | null;

/**
 * JSON with every object's keys sorted.
 *
 * The stored ground comes back from a jsonb column, and jsonb does not keep
 * the order keys were written in. Comparing it to the live ground with plain
 * `JSON.stringify` therefore found a difference in every block that quoted a
 * configuration, and the studio called freshly written copy "written before
 * the facts changed" straight after it was written.
 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const groundKey = (g: Ground | null): string =>
  g
    ? stable({
        t: g.talkingPoints,
        n: g.neverSay,
        p: g.possessionDate,
        m: g.money,
        // The three fields every stored ground carries. An area was added to
        // the ground later, and comparing it would call every card written
        // before that "written before the facts changed".
        c: (g.configurations ?? []).map((c) => ({ config: c.config, label: c.label, startingPrice: c.startingPrice })),
        r: g.registrationNo,
        a: g.advertisable,
      })
    : "";

export function stalenessOf(
  block: { generatedAt: string; ground: Ground | null },
  now: { briefUpdatedAt: string; ground: Ground },
): Staleness {
  if (Date.parse(block.generatedAt) < Date.parse(now.briefUpdatedAt)) return "brief";
  if (block.ground && groundKey(block.ground) !== groundKey(now.ground)) return "facts";
  return null;
}

/**
 * "Nothing", "none" and "n/a" in the offer box mean no offer.
 *
 * Passed through as written, the model is told `Offer: nothing` and treats it
 * as the offer, which is the one instruction a person typing "nothing" did
 * not mean to give.
 */
export function meaningfulOffer(raw: string | null): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  return /^(nothing|none|no offers?|n\/?a|nil|-+|\.+)$/i.test(t) ? null : t;
}

/**
 * The distinct reasons across a set of blocks, most common first.
 *
 * Twelve cards carrying one reason is one thing to fix, and saying it twelve
 * times buries it.
 */
export function reasonSummary(
  blocks: readonly { reasons: readonly Reason[] }[],
): { code: ReasonCode; count: number }[] {
  const counts = new Map<ReasonCode, number>();
  for (const b of blocks) {
    for (const code of new Set(b.reasons.map((r) => r.code))) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Words that say nothing about a building, so sharing one proves nothing.
 *
 * The rule used to be "any word over three letters, as a substring", which was
 * wrong in both directions on a real Tower C run. "Tower C: Sea Views" was
 * refused, because "sea" is three letters and the point it plainly leads on is
 * "Sea facing from the 18th floor up". And "2 BHK from Rs 2,18,24,000"
 * cleared, because "from" is four letters and appears in that same point.
 */
const FILLER = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "by", "for",
  "from", "with", "into", "near", "over", "up", "per", "each", "every", "all",
  "any", "more", "most", "only", "just", "also", "very", "than", "your", "you",
  "our", "its", "this", "that", "these", "those", "here", "there", "now",
  "new", "get", "are", "is", "be", "has", "have", "will", "can",
  "home", "homes", "house", "flat", "flats", "tower", "towers", "project",
  "floor", "floors", "wing", "wings", "one", "two", "three",
]);

const wordsOf = (text: string): string[] =>
  fold(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !FILLER.has(w));

/**
 * Whether a headline leads on something signed.
 *
 * A talking point's own words, matched as whole words and forgiving a plural,
 * so "sea views" leads on "sea facing" and "seasonal" does not. Or an approved
 * amount or flat type, because a price reveal leads on the most signed fact
 * there is; whether that amount belongs to that flat is the price checks'
 * business, and they run regardless.
 */
export function leadsOnSigned(headline: string, ground: Ground): boolean {
  const said = new Set(wordsOf(headline));
  const has = (w: string) => said.has(w) || said.has(`${w}s`) || (w.endsWith("s") && said.has(w.slice(0, -1)));
  if (ground.talkingPoints.some((p) => wordsOf(p).some(has))) return true;
  if (ground.location && wordsOf(ground.location).some(has)) return true;

  const ascii = toAsciiDigits(headline);
  if (moneyIn(ascii).length > 0) return true;
  const priced = ground.configurations.map((c) => c.config);
  return priced.length > 0 && configsNamedIn(ascii, priced).length > 0;
}

/** Whether a headline names the project or the tower, by a whole word of its name. */
function namesProject(headline: string, names: readonly string[]): boolean {
  const said = new Set(wordsOf(headline));
  return names.some((n) => wordsOf(n).filter((w) => w.length >= 3 && !/^(tower|phase|wing|block)$/.test(w)).some((w) => said.has(w)));
}

export function verdictOf(reasons: readonly Reason[]): Verdict {
  if (reasons.some((r) => REASON_VERDICT[r.code] === "FAIL")) return "FAIL";
  if (reasons.length) return "HOLD";
  return "PASS";
}

/**
 * Everything the gate is allowed to measure copy against.
 *
 * All of it is signed or recorded elsewhere. Nothing on this object came from
 * the model that wrote the copy, which is the entire point: a generator
 * grading its own homework grades it as correct.
 */
export type UnitPrice = {
  /** A key from `UNIT_CONFIGS`, which is what the copy is matched against. */
  config: string;
  /** "2 BHK", or "2 BHK Optima". What a refusal says out loud. */
  label: string;
  /** Rupees. Null where no rate is signed and no price was set by hand. */
  startingPrice: number | null;
  /** The approved carpet area, so "682 sq ft" in the copy is a number somebody signed. */
  areaSqft?: number | null;
  /** A plot's approved area in the unit it is sold in, so "200 sq yd plots" quotes a signed 200. */
  plotArea?: number | null;
};

export type Ground = {
  /** `claims.talking_points`, one per line, as published. */
  talkingPoints: string[];
  /** `claims.nearby`: places near the project and how far, one per line. Absent when none are signed. */
  nearby?: string[];
  /** `claims.nearby_measured`: how those times were measured, for a location film's small print. */
  nearbyMeasured?: string;
  /** `claims.never_say`, one per line, as published. */
  neverSay: string[];
  /** `claims.possession_date`, the date sales may state. */
  possessionDate: string | null;
  /** Every money value the Brain published, as written. */
  money: string[];
  /**
   * The configurations this tower sells, and what each starts at.
   *
   * Approved ones only, because an unapproved carpet area or price is a
   * number somebody typed. Without this the gate could only ask whether an
   * amount was signed SOMEWHERE on the tower, which cleared "2 BHK from
   * Rs 48 lakh" whenever Rs 48 lakh was really the 1 BHK.
   */
  configurations: UnitPrice[];
  /** Whether this node may be advertised at all, and how long that lasts. */
  advertisable: boolean;
  /** The registration this copy would be published under. */
  registrationNo: string | null;
  /**
   * The state that registered it, whose authority's rules the copy follows.
   * Absent on a ground stored before states other than Maharashtra.
   */
  registrationState?: string | null;
  /** Telangana's building permit number, printed beside the registration. */
  permitNo?: string | null;
  registrationDaysLeft: number | null;
  /** Languages the brand typeface cannot set. */
  facelessLanguages: string[];
  /**
   * Where the project is, as an ad prints it: the signed exact locality
   * ("Goregaon West"), never the city. Null when nobody signed one, and then
   * no ad is made. An ad that never said where the building was, and then one
   * that said "Mumbai", were the first things a person in the trade noticed:
   * "sabka exact location likha hai", every developer's ad names the exact one.
   */
  location?: string | null;
  /**
   * The project's and the tower's own names. The writer is told them, so a
   * number in one ("Sector 150 Heights", "Tower 2") is not a number it made up.
   */
  names?: string[];
};

/**
 * A ground read back from a row, with every list present. A card written
 * before a field existed (configurations came with unit types) stored a
 * ground without it, and re-gating it must not fall over on the gap.
 */
export function storedGround(g: Partial<Ground>): Ground {
  return {
    talkingPoints: g.talkingPoints ?? [],
    neverSay: g.neverSay ?? [],
    possessionDate: g.possessionDate ?? null,
    money: g.money ?? [],
    configurations: g.configurations ?? [],
    // Nothing is written for a phase that may not be advertised, so a stored
    // ground that does not say was advertisable when its card was written.
    advertisable: g.advertisable ?? true,
    registrationNo: g.registrationNo ?? null,
    registrationDaysLeft: g.registrationDaysLeft ?? null,
    facelessLanguages: g.facelessLanguages ?? [],
    location: g.location ?? null,
    names: g.names,
  };
}

/** Inside this many days of lapse, a creative renders but does not publish. */
export const EXPIRY_HOLD_DAYS = 30;

/** How far a quoted price may sit from a computed one and still be it. */
export const CONFIG_PRICE_TOLERANCE = 0.01;

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The digits of the nine Indian scripts, read as digits.
 *
 * A Marathi creative writes eight as `८`, and a gate that only knew `8` would
 * let a price, a yield and a possession year through untouched in every
 * language but English. That is the opposite of the intended reading: the
 * vernacular ad is the one nobody in the office proofreads.
 *
 * Only the digits are folded. The words are a separate problem with a
 * separate answer, and pretending otherwise is how a gate comes to look like
 * it checked something it did not.
 */
const DIGIT_BLOCKS = [
  0x0966, // Devanagari, for Hindi and Marathi
  0x09e6, // Bengali
  0x0ae6, // Gujarati
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0a66, // Gurmukhi
  0x0b66, // Odia
];

export function toAsciiDigits(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      for (const base of DIGIT_BLOCKS) {
        if (code >= base && code <= base + 9) return String(code - base);
      }
      return ch;
    })
    .join("");
}

/**
 * Whether two pieces of text are written in a script the other can be
 * searched in.
 *
 * A never-say list written in English cannot be found inside Devanagari copy,
 * and a substring search that returns nothing there returns nothing for the
 * wrong reason: not "it does not say that" but "this cannot be read here".
 * Those two answers must never be confused, so the gate asks this first and
 * holds the block when the answer is no.
 */
const NON_LATIN =
  /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;

export function sameScript(a: string, b: string): boolean {
  return NON_LATIN.test(a) === NON_LATIN.test(b);
}

/**
 * Hindi's and Marathi's words for money, read as the trade's Latin ones:
 * करोड़ and कोटी are a crore, लाख a lakh, रु a rupee, प्रतिशत and टक्के a
 * per cent. A Hindi ad prints "₹2.19 करोड़*", and a gate that knew only "Cr"
 * read that as two rupees nineteen.
 */
const INDIC_MONEY: [RegExp, string][] = [
  [/\u0915\u0930\u094B(?:\u0921\u093C|\u095C|\u0921)/g, " cr "],
  [/\u0915\u094B\u091F\u0940|\u0915\u094B\u091F\u093F/g, " cr "],
  [/\u0932\u093E\u0916/g, " lakh "],
  [/\u0930\u0941(?:\u092A\u092F\u0947|\u092A\u090F|\.)?(?=\s*\d)/g, " rs "],
  [/\s*(?:\u092A\u094D\u0930\u0924\u093F\u0936\u0924|\u091F\u0915\u094D\u0915\u0947)/g, "%"],
];

export function foldIndic(text: string): string {
  let out = toAsciiDigits(text);
  for (const [re, to] of INDIC_MONEY) out = out.replace(re, to);
  return out;
}

/**
 * The languages written in Latin letters: English, and Hinglish on cards and
 * posts made before it left the catalog on 1 October 2026.
 */
const LATIN_LANGUAGES = new Set(["English", "Hinglish"]);

export function writesLatin(language: string): boolean {
  return LATIN_LANGUAGES.has(language);
}

const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * The words written in the other script: English letters in a Hindi card,
 * Devanagari in an English one. An image ad is all English or all Hindi,
 * never a mixture (the client, 1 October 2026). The rupee sign, digits and
 * punctuation belong to neither.
 */
export function otherScriptWords(text: string, language: string): string[] {
  const latin = writesLatin(language);
  const words = text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  return [...new Set(words.filter((w) => (latin ? NON_LATIN.test(w) : LATIN_LETTER.test(w))))];
}

/**
 * Money written any of the ways a person writes it.
 *
 * `Rs 76,30,000`, `76.3 lakh`, `1.25 Cr` and a bare `7630000` are one number,
 * and a gate that only recognised one spelling would pass the other three.
 *
 * "Rs" and "INR" must start a word. Without that, the "rs" at the end of
 * "buyers", "towers" or "floors" read as a rupee sign, so "for first time
 * buyers. 2 BHK" quoted Rs 2 and "Nine towers 12 acres" quoted Rs 12, and a
 * clean block was refused for a price it never stated.
 */
const MONEY = /(?:(?<![a-z])(?:rs\.?|inr)|₹)\s*([\d,.]+)\s*(cr|crore|lakh|lac|l|k)?|([\d,.]+)\s*(cr|crore|lakh|lac)\b/gi;

const SCALE: Record<string, number> = {
  cr: 1e7, crore: 1e7, lakh: 1e5, lac: 1e5, l: 1e5, k: 1e3,
};

export function moneyIn(raw: string): number[] {
  const text = foldIndic(raw);
  const out: number[] = [];
  for (const m of text.matchAll(MONEY)) {
    const digits = (m[1] ?? m[3] ?? "").replace(/,/g, "");
    const unit = (m[2] ?? m[4] ?? "").toLowerCase();
    const n = Number(digits);
    if (!Number.isFinite(n) || !digits) continue;
    // To the rupee: 2.51 lakh is 251000, not 250999.99999999997.
    out.push(Math.round(unit ? n * (SCALE[unit] ?? 1) : n));
  }
  return out;
}

/**
 * A price the way Indian property advertisements print it: ₹99 Lakh,
 * ₹1.49 Cr, ₹76.4 Lakh. Crores to two places, lakhs to one (two under ten
 * lakh), trailing zeros dropped.
 *
 * Rounded UP at the printed precision, never to the nearest: "starting
 * ₹2.18 Cr" for a flat that starts at 2,18,24,000 names a price no flat is
 * sold at, and "starting" is a promise about the cheapest one. The step up
 * is always inside the gate's one per cent.
 */
export function adPrice(rupees: number): string {
  const trim = (x: string) => x.replace(/\.?0+$/, "");
  if (!Number.isFinite(rupees) || rupees <= 0) return "";
  if (rupees >= 1e7) return `₹${trim((Math.ceil(Math.round(rupees) / 1e5) / 100).toFixed(2))} Cr`;
  if (rupees >= 1e6) return `₹${trim((Math.ceil(Math.round(rupees) / 1e4) / 10).toFixed(1))} Lakh`;
  if (rupees >= 1e5) return `₹${trim((Math.ceil(Math.round(rupees) / 1e3) / 100).toFixed(2))} Lakh`;
  return `₹${Math.round(rupees).toLocaleString("en-IN")}`;
}

/**
 * Talking points an ad is not built on: the building's services and the
 * spec sheet. "Two lifts per wing" led the first live ad, and a person at a
 * marketing firm said nobody writes that; across 1,018 active ads from
 * fourteen of India's largest developers on 26 September 2026, lifts per
 * wing, flooring, fittings, parking and structure never appeared on an image.
 * They stay approved facts (a buyer on a call may ask about the lifts); they
 * are just not what an advertisement says.
 */
const SPEC_SHEET =
  /\b(lifts?|elevators?|power ?back-?up|dg ?back-?up|water (?:supply|tank)|sump|fire[- ]?(?:fighting|safety|alarm|exit)|sprinklers?|smoke detectors?|intercom|vitrified|tiles?|tiling|flooring|fittings?|sanitary ?ware|plumbing|wiring|modular switch(?:es)?|earthquake|rcc|structur(?:e|al)|parking|car ?parks?|stilt)\b/i;

/**
 * On construction ads (site progress reports, construction updates, timelines),
 * structure and engineering specifications (earthquake resistance, RCC, structural compliance)
 * are legitimate, approved selling points.
 */
const SPEC_SHEET_CONSTRUCTION =
  /\b(lifts?|elevators?|power ?back-?up|dg ?back-?up|water (?:supply|tank)|sump|fire[- ]?(?:fighting|safety|alarm|exit)|sprinklers?|smoke detectors?|intercom|vitrified|tiles?|tiling|flooring|fittings?|sanitary ?ware|plumbing|wiring|modular switch(?:es)?|parking|car ?parks?|stilt)\b/i;

/** Construction milestones, active progress, and structural engineering lead a construction ad. */
const CONSTRUCTION_SELLS =
  /\b(slab|floor|level|cast|concre\w*|rcc|foundat\w*|excavat\w*|plinth|piling|structur\w*|seismic|earthquake|possession|deliver\w*|on track|on schedule|handover|finishing|mivan|active construction|site progress)\b/i;

/** What sells a home, in the order the big developers lead with it. */
/** A road: what a luxury buyer is driven along. */
const ROAD = /\b(road|highway|expressway|sea ?link|coastal road|freeway|flyover|bridge|jvlr|svr|link road|marg)\b/i;
/** A station: what everybody else gets to work by. */
const RAIL = /\b(metro|station|railway|local train)\b/i;

/**
 * From this starting price a project sells as luxury, and its ads lead on
 * the road rather than the station. A person at a marketing firm, on the
 * first live ad: station connectivity matters, "or if it is a luxury project
 * like 20-50 cr project then road connectivity is must".
 */
export const LUXURY_FROM = 20_00_00_000;

const SELLS: RegExp[] = [
  // Where it is and how fast you get anywhere from it.
  /\b(metro|station|highway|expressway|airport|road|junction|minutes?|mins?|km|next to|near|connect\w*|walk)\b/i,
  // What you see from it.
  /\b(sea|view|views|facing|lake|creek|hills?|skyline|panoramic|horizon|river|golf|forest|national park)\b/i,
  // How much room there is.
  /\b(acres?|open|green|garden|podium|park|landscap\w*|low[- ]density|homes per floor)\b/i,
  // What there is to do.
  /\b(club ?house|clubhouse|pool|gym|amenit\w*|decks?|sundecks?|sky ?lounge)\b/i,
];

/**
 * Which of the four things that sell a home a point is about: 0 where it
 * is, 1 what it looks at, 2 how much room, 3 what there is to do, -1 none.
 * The learning scores ads by it, so it is the same test the writer's order
 * uses and the two cannot drift.
 */
export function sellingKind(point: string): number {
  return SELLS.findIndex((re) => re.test(point));
}

/**
 * The approved talking points an ad may be built on, strongest first:
 * where it is, what it looks at, how much room, what there is to do, then
 * the rest. Spec-sheet items are left out (unless it is a construction ad,
 * where structural engineering and construction milestones are the focus).
 */
export function sellingPoints(
  points: readonly string[],
  opts: { luxury?: boolean; construction?: boolean } = {},
): string[] {
  const filter = opts.construction ? SPEC_SHEET_CONSTRUCTION : SPEC_SHEET;
  const kept = points.map((p) => p.trim()).filter((p) => p && !filter.test(p));
  const rank = (p: string) => {
    if (opts.construction && CONSTRUCTION_SELLS.test(p)) return -1;
    const i = SELLS.findIndex((re) => re.test(p));
    if (i !== 0) return i < 0 ? SELLS.length : i;
    // Connectivity leads either way; which kind leads it depends on who buys.
    const first = opts.luxury ? ROAD : RAIL;
    return first.test(p) ? 0 : 0.5;
  };
  return kept.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
}

/**
 * The approved point that says how the project connects, if there is one:
 * the road first for a luxury project, the station first for the rest. The
 * writer is told to make the body of it only when it exists; told so on a
 * tower with no such fact, it wrote "8 min from the station" from the
 * prompt's own example.
 */
export function connectivityPoint(points: readonly string[], opts: { luxury?: boolean } = {}): string | null {
  const [first, second] = opts.luxury ? [ROAD, RAIL] : [RAIL, ROAD];
  return points.find((p) => first.test(p)) ?? points.find((p) => second.test(p)) ?? null;
}

/** Why no ad is made yet: every one names the exact locality, and none is signed. */
export const NO_LOCATION_MESSAGE =
  "Add the project's exact location (for example Goregaon West) to its Brain and sign it before making ads.";

/** Whether a project sells as luxury: its cheapest approved configuration starts at twenty crore or more. */
export function isLuxury(configurations: readonly { startingPrice: number | null }[]): boolean {
  const prices = configurations.map((c) => c.startingPrice).filter((n): n is number => !!n && n > 0);
  return prices.length > 0 && Math.min(...prices) >= LUXURY_FROM;
}

/**
 * The exact locality an ad prints, from what was signed: the city taken out
 * ("Goregaon West, Mumbai" prints "Goregaon West"), and nothing when only
 * the city is left. Every developer's ad names the exact locality and none
 * writes the city; an ad with "Mumbai" on it beside "Goregaon station" in
 * the copy named two places.
 */
export function exactLocation(signed: string | null | undefined, city: string | null | undefined): string | null {
  const c = city ? fold(city) : null;
  const parts = (signed ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && (!c || fold(p) !== c));
  return parts.join(", ") || null;
}

/**
 * What an ad prints on lines of its own, apart from the copy: where the
 * project is, and what each configuration starts at. Both were missing or
 * buried on the first live ad, and both are what a buyer looks for first.
 * The Ashford Regal ad a marketing firm sent back as the example sets them
 * as "LAUNCHING NEW TOWER / NAHUR WEST" and "SPACIOUS 2 BED STARTING
 * ₹1.49 CR*".
 */
export type AdFacts = {
  /** "Nahur West, Mumbai", or the city alone. */
  location: string | null;
  /** "2 BHK starting at ₹2.19 Cr*", cheapest first. */
  prices: string[];
  /**
   * The signed facts these lines say in another language: a Hindi ad prints
   * "गोरेगांव पश्चिम", and whether the picture went stale is decided on
   * "Goregaon West". Absent on lines that are the signed facts themselves.
   */
  signed?: { location: string | null; prices: string[] };
};

/**
 * How a Hindi or Marathi ad prints its price lines, in its own words: the
 * flat type, the amount with its ₹ and its digits, and "starting". Code, not
 * the writer, so a price on the picture is always the approved one.
 */
type LocalFactWords = {
  crore: string;
  lakh: string;
  bhk: string;
  starting: (config: string, amount: string) => string;
  names: Record<string, string>;
};

const LOCAL_FACT_WORDS: Record<string, LocalFactWords> = {
  Hindi: {
    crore: "करोड़",
    lakh: "लाख",
    bhk: "बीएचके",
    starting: (config, amount) => `${config} ${amount}* से शुरू`,
    names: {
      STUDIO: "स्टूडियो", "1RK": "1 आरके", PENTHOUSE: "पेंटहाउस", JODI: "जोड़ी फ़्लैट",
      VILLA: "विला", ROWHOUSE: "रो हाउस", PLOT: "प्लॉट", SHOP: "दुकान", OFFICE: "ऑफ़िस",
    },
  },
  Marathi: {
    crore: "कोटी",
    lakh: "लाख",
    bhk: "बीएचके",
    starting: (config, amount) => `${config} ${amount}* पासून`,
    names: {
      STUDIO: "स्टुडिओ", "1RK": "1 आरके", PENTHOUSE: "पेंटहाऊस", JODI: "जोडी फ्लॅट",
      VILLA: "व्हिला", ROWHOUSE: "रो हाऊस", PLOT: "प्लॉट", SHOP: "दुकान", OFFICE: "ऑफिस",
    },
  },
};

const DIRECTIONS: Record<string, string> = {
  w: "west", e: "east", n: "north", s: "south",
  paschim: "west", pashchim: "west", purv: "east", purva: "east", poorv: "east", uttar: "north", dakshin: "south",
};

/**
 * Whether a place read back from Hindi is the signed one: the same words,
 * with "(W)", "West" and "Paschim" one direction.
 */
export function samePlace(read: string | null | undefined, signed: string | null | undefined): boolean {
  if (!read?.trim() || !signed?.trim()) return false;
  const words = (s: string) =>
    new Set(fold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean).map((w) => DIRECTIONS[w] ?? w));
  const a = words(read);
  const b = words(signed);
  return a.size === b.size && [...b].every((w) => a.has(w));
}

/** Edit distance between two words, by code point. */
function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[y.length];
}

/**
 * A word in the copy that is nearly a word of the place line and not it:
 * the same place spelt a second way. A word of five letters may be one off,
 * a longer one a quarter of its length; a shorter word is left alone, since
 * at that length a near miss is usually another word.
 */
export function misspeltPlace(copy: string, place: string): { said: string; place: string } | null {
  const words = (s: string) => s.split(/[^\p{L}\p{M}]+/u).filter((w) => [...w].length >= 5);
  // A direction is a word in its own right ("पश्चिमी", western), never a spelling of the place.
  const placeWords = words(place).filter((w) => !["पश्चिम", "पूर्व", "उत्तर", "दक्षिण"].includes(w));
  for (const said of words(copy)) {
    for (const p of placeWords) {
      if (said === p) continue;
      const d = editDistance(said, p);
      if (d > 0 && d <= Math.max(1, Math.floor([...p].length / 4))) return { said, place: p };
    }
  }
  return null;
}

/**
 * The approved points a Hindi carousel may set, in Hindi: each one whose
 * reading carries exactly its own numbers, no never-say phrase and at least
 * half of its words, and whose Hindi adds no number. One that does not is
 * left off, and its slide shows the picture alone, as a slide past the
 * signed points does.
 */
export function checkedPoints(
  local: LocalLines | null | undefined,
  ground: Pick<Ground, "neverSay">,
  language: string,
): { source: string; text: string }[] {
  const reading = local?.reading;
  if (!local || !reading) return [];
  const nums = (s: string) => new Set(numbersSaid(foldIndic(s)).map((n) => n.value));
  const same = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((n) => b.has(n));
  return local.points.filter((p, i) => {
    const read = reading.points[i] ?? "";
    if (!p.text.trim() || !read.trim() || otherScriptWords(p.text, language).length) return false;
    const signed = nums(p.source);
    if (![...nums(p.text)].every((n) => signed.has(n)) || !same(nums(read), signed)) return false;
    const said = fold(read);
    if (ground.neverSay.some((phrase) => fold(phrase) && said.includes(fold(phrase)))) return false;
    const want = wordsOf(p.source);
    const got = new Set(wordsOf(read));
    const hit = want.filter((w) => got.has(w) || got.has(`${w}s`) || (w.endsWith("s") && got.has(w.slice(0, -1))));
    return hit.length * 2 >= want.length;
  });
}

/**
 * The points a post sets, in the ad's order: for a card with local lines,
 * each signed point said in its language that read back true, and the rest
 * left off; for any other card, the signed points.
 */
export function pointsFor(
  talkingPoints: readonly string[],
  local: LocalLines | null | undefined,
  ground: Pick<Ground, "neverSay">,
  language: string,
  opts: { luxury?: boolean } = {},
): string[] {
  if (!local || writesLatin(language)) return [...talkingPoints];
  const said = new Map(checkedPoints(local, ground, language).map((p) => [p.source.trim(), p.text.trim()]));
  return sellingPoints(talkingPoints, opts)
    .map((p) => said.get(p.trim()))
    .filter((t): t is string => !!t);
}

/** Whether an ad in this language prints its location and prices in its own words. */
export function printsLocalFacts(language: string): boolean {
  return Object.hasOwn(LOCAL_FACT_WORDS, language);
}

/** "2 बीएचके ₹2.19 करोड़* से शुरू" for a 2 BHK at Rs 2,18,24,000, or null for a language with no words here. */
export function localPriceLine(language: string, config: string, rupees: number): string | null {
  const w = LOCAL_FACT_WORDS[language];
  if (!w || !(rupees > 0)) return null;
  const def = configDef(config);
  const name =
    def && def.beds !== null && /BHK$/i.test(def.label)
      ? `${def.label.replace(/\s*BHK$/i, "")} ${w.bhk}`
      : config === "4PLUS"
        ? `4+ ${w.bhk}`
        : w.names[config] ?? def?.label ?? config;
  const amount = adPrice(rupees).replace(/ Cr$/, ` ${w.crore}`).replace(/ Lakh$/, ` ${w.lakh}`);
  return w.starting(name, amount);
}

/**
 * The footnote a starred price needs, set in the ad's small print. Worded
 * the way Godrej and Oberoi word theirs: what the price leaves out.
 */
export const PRICE_NOTE = "*Starting base price. GST, stamp duty, registration and other charges extra. T&C apply.";

/**
 * The price footnote for an ad registered in `stateCode`: Tamil Nadu and Goa
 * forbid "T&C apply", so theirs leaves it out and says the rest.
 */
export function priceNoteFor(stateCode: string | null | undefined): string {
  return adRuleFor(stateCode)?.noTermsApply ? withoutTermsApply(PRICE_NOTE) : PRICE_NOTE;
}

/** At most this many configurations are priced on one ad: more is a price list. */
export const MAX_PRICE_LINES = 3;

export function adFacts(
  ground: {
    location?: string | null;
    configurations: readonly { config?: string; label: string; startingPrice: number | null }[];
  },
  /**
   * A card in Hindi or Marathi, with the place it wrote and that read back as
   * the signed one. Its lines are then in its own words, the price lines
   * built here from the approved prices; without a place, the signed facts.
   */
  local?: { language: string; place: string | null } | null,
): AdFacts {
  const priced = ground.configurations
    .filter((c): c is { config?: string; label: string; startingPrice: number } => !!c.startingPrice && c.startingPrice > 0)
    .sort((a, b) => a.startingPrice - b.startingPrice)
    .slice(0, MAX_PRICE_LINES);
  const signed = {
    location: ground.location?.trim() || null,
    // "Plots starting at ₹45 Lakh*": a product sold by name is plural on a
    // price line, the way the trade writes it; "1 RK" and "2 BHK" are not.
    prices: priced.map((c) => `${priceLineLabel(c)} starting at ${adPrice(c.startingPrice)}*`),
  };
  const place = local?.place?.trim();
  if (!local || !place || !printsLocalFacts(local.language)) return signed;
  // One line a flat type, the cheapest: a variant's name ("QA Classic") has
  // no Hindi, and two "2 बीएचके" lines at two prices read as a mistake.
  const seen = new Set<string>();
  const prices = priced
    .filter((c) => {
      const k = c.config ?? c.label;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .map((c) => localPriceLine(local.language, c.config ?? "", c.startingPrice))
    .filter((l): l is string => !!l);
  return { location: place, prices, signed };
}

/**
 * The copy without the lines that only repeat what the ad prints on its own
 * lines: a line that is just the location, or just a configuration and its
 * starting price. Told not to, the writer still pasted "Mumbai / 2 BHK:
 * starting ₹2.19 Cr*" into three bodies and one call to action out of
 * eight, which printed the price twice. Only whole lines go; a price inside
 * a sentence stays, and the design leaves its own line out instead.
 *
 * A configuration is named by its whole label ("2 BHK QA Classic"), so the
 * label's words are part of a price line too; a Marathi card printed "2 BHK
 * QA Classic: starting \u20b91.25 Cr*" in its call to action because only "2 BHK"
 * was recognised. One word left over in another script is the location
 * written in that script ("\u092c\u0928\u0947\u0930"), and the line is still only the facts.
 */
const PRICE_LINE_WORDS = new Set([
  "rs", "inr", "cr", "crore", "crores", "lakh", "lakhs", "lac", "starting", "starts", "from", "onwards",
  "at", "bhk", "bed", "beds", "rk", "only", "price", "prices",
  // The same line in Hindi and Marathi.
  "करोड़", "करोड़", "करोड", "कोटी", "लाख", "रु", "रुपये", "से", "शुरू", "पासून", "सुरू", "बीएचके", "केवल", "सिर्फ",
]);

export function withoutFactLines(
  copy: Copy,
  ground: Pick<Ground, "location" | "configurations">,
  /** The location as a Hindi or Marathi card writes it, a line of its own on that ad. */
  localPlace?: string | null,
): Copy {
  const loc = ground.location ? fold(ground.location) : null;
  const here = localPlace?.trim() ? fold(localPlace) : null;
  const priced = ground.configurations.filter((c) => c.startingPrice !== null && c.startingPrice > 0);
  // Marks as well as letters: a Devanagari word's vowel signs are marks, and
  // splitting on them read "बनेर" as two words.
  const tokens = (s: string) => fold(s).split(/[^\p{L}\p{M}\p{N}.]+/u).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const known = new Set([
    ...PRICE_LINE_WORDS,
    ...priced.flatMap((c) => tokens(c.label)),
    ...priced.flatMap((c) => tokens(priceLineLabel(c))),
    ...(loc ? tokens(loc) : []),
    ...(here ? tokens(here) : []),
  ]);
  const isFactLine = (line: string) => {
    const t = fold(line.replace(/^[\s\-\u2022\u00b7|/]+|[\s.|/]+$/g, ""));
    if (!t) return true;
    if (loc && (t === loc || loc.split(",").map((x) => x.trim()).includes(t))) return true;
    if (here && t === here) return true;
    const amounts = moneyIn(t);
    if (!amounts.length) return false;
    if (!amounts.every((n) => priced.some((c) => Math.abs(n - c.startingPrice!) <= c.startingPrice! * CONFIG_PRICE_TOLERANCE))) {
      return false;
    }
    const rest = tokens(toAsciiDigits(t)).filter((w) => !/^[\d.,]+$/.test(w) && !known.has(w));
    return rest.length === 0 || (!!loc && rest.length === 1 && NON_LATIN.test(rest[0]));
  };
  const clean = (text: string) =>
    text
      .split(/\n|\s+\/\s+/)
      .filter((l) => !isFactLine(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  return { headline: copy.headline.trim(), body: clean(copy.body), cta: clean(copy.cta) || copy.cta.trim() };
}

/**
 * The fact lines a cover prints, less whatever its own copy already says, so
 * nothing on the picture is printed twice.
 */
export function factsBeside(facts: AdFacts | null | undefined, copy: Copy): AdFacts | null {
  if (!facts) return null;
  const text = `${copy.headline}\n${copy.body}\n${copy.cta}`;
  const said = moneyIn(text);
  const loc = facts.location ? fold(facts.location) : null;
  return {
    ...facts,
    location: loc && fold(text).includes(loc) ? null : facts.location,
    prices: said.length
      ? facts.prices.filter((line) => !moneyIn(line).some((n) => said.some((m) => Math.abs(m - n) <= n * CONFIG_PRICE_TOLERANCE)))
      : facts.prices,
  };
}

/**
 * Why the facts printed on a picture no longer hold, or null when they do.
 * A price rises after a post is made, and the words are gated again at
 * publishing; the picture's own price line has to be too, or a superseded
 * price goes out on the one line a buyer reads.
 */
export function staleFacts(printed: AdFacts | null | undefined, today: AdFacts): string | null {
  if (!printed) return null;
  // A Hindi picture is measured on the signed facts its lines said; what it
  // printed is what the person is told.
  const was = printed.signed ?? printed;
  const now = today.signed ?? today;
  // Compared as a configuration and an amount, not as wording: "starting
  // ₹2.19 Cr*" printed last week and "starting at ₹2.19 Cr*" today are
  // the same price, and only a changed price makes a picture wrong.
  // A trailing plural is dropped too: "Plot starting" printed before plots
  // read "Plots starting" is the same configuration.
  const key = (line: string) =>
    `${fold(line.split(/\bstarting\b/i)[0]).replace(/s\b/g, "")}|${moneyIn(line).join(",")}`;
  const current = new Set(now.prices.map(key));
  const gone = was.prices.findIndex((p) => !current.has(key(p)));
  if (gone >= 0) {
    const said = printed.signed ? (printed.prices.find((l) => moneyIn(l).join(",") === moneyIn(was.prices[gone]).join(",")) ?? was.prices[gone]) : was.prices[gone];
    return `The picture says "${said}", which is no longer the approved price. Make the post again.`;
  }
  if (was.location && was.location !== now.location) {
    return `The picture says "${printed.location ?? was.location}", and the approved location has changed. Make the post again.`;
  }
  return null;
}

/**
 * Amounts of a lakh or more written out in full, as they appear: "Rs
 * 2,18,24,000", "₹5,00,000", a bare "2,18,24,000". A figure with its own
 * unit ("2.19 Cr", "99 lakh") is how it should be, and a smaller amount (a
 * rate of ₹32,000 per sq ft) is fine written out.
 */
export function fullFigures(raw: string): string[] {
  const text = toAsciiDigits(raw);
  const out: string[] = [];
  const FULL = /((?:(?<![a-z])(?:rs\.?|inr)|₹)\s*)?(\d{1,3}(?:,\d{2,3})+|\d{6,})(?!\s*(?:cr|crore|lakh|lac|l|k)\b)(?![\d.,]*\d)/gi;
  for (const m of text.matchAll(FULL)) {
    const n = Number(m[2].replace(/,/g, ""));
    // A bare run of digits is a price only with a currency in front of it:
    // "9876543210" is a phone number and "400076" a pin code.
    if (!m[1] && !m[2].includes(",")) continue;
    if (n >= 1e5) out.push(m[0].trim());
  }
  return out;
}

/**
 * A rate, which is the shape a returns claim arrives in.
 *
 * "8.5% assured" and "8.5 per cent" are the same promise. A percentage that
 * is not on a signed fact is refused outright rather than matched loosely,
 * because the one number nobody may improvise is a yield.
 */
const RATE = /(\d+(?:\.\d+)?)\s*(?:%|per\s*cent|percent)/gi;

export function ratesIn(raw: string): number[] {
  return [...foldIndic(raw).matchAll(RATE)]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
}

/** Four-digit years, which is how a possession promise is usually written. */
export function yearsIn(raw: string): number[] {
  return [...toAsciiDigits(raw).matchAll(/(?:^|\D)(20\d{2})(?:\D|$)/g)].map((m) =>
    Number(m[1]),
  );
}

/**
 * Numbers written as words, the way copy writes them: "eight minutes", "two
 * towers", "twenty five acres". "One" is left out on purpose: "the one", "one
 * of a kind" and "one step closer" are not counts of anything.
 */
const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_NUMBER = new RegExp(
  `\\b(?:(${Object.keys(TENS).join("|")})(?:[\\s-](${Object.keys(UNITS).join("|")}))?|(${Object.keys(TEENS).join("|")})|(${Object.keys(UNITS).filter((w) => w !== "one").join("|")}))\\b`,
  "gi",
);

/** A run of digits that is a number rather than part of a name ("P52100012345", "QA2"). */
const DIGIT_NUMBER = /(?<![\p{L}\d.,])(\d+(?:,\d{2,3})*(?:\.\d+)?)(?!\d)/gu;

/** "2 BHK", "1 & 2 BHK", "3BHK", "2.5 bed": a configuration, measured by the configuration checks. */
const BHK_FIGURE = /(?<![\p{L}\d])\d+(?:\.\d+)?(?:\s*(?:&|and|,|\/|or|-|to)\s*\d+(?:\.\d+)?)*\s*(?:bhk|bed(?:room)?s?|rk)\b/giu;

function numbersSaid(text: string): { value: number; said: string }[] {
  const out: { value: number; said: string }[] = [];
  for (const m of text.matchAll(DIGIT_NUMBER)) {
    const value = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(value)) out.push({ value, said: m[1] });
  }
  for (const m of text.matchAll(WORD_NUMBER)) {
    const value = m[1]
      ? TENS[m[1].toLowerCase()] + (m[2] ? UNITS[m[2].toLowerCase()] : 0)
      : m[3]
        ? TEENS[m[3].toLowerCase()]
        : UNITS[m[4].toLowerCase()];
    out.push({ value, said: m[0] });
  }
  return out;
}

/**
 * Every number in the copy that no other check already measures: not an
 * amount, a rate, a year or a configuration. Each value once.
 */
export function looseNumbersIn(raw: string): { value: number; said: string }[] {
  let text = foldIndic(raw);
  for (const figure of fullFigures(text)) text = text.replace(figure, " ");
  text = text
    .replace(MONEY, " ")
    .replace(RATE, " ")
    .replace(/(?<!\d)20\d{2}(?!\d)/g, " ")
    .replace(BHK_FIGURE, " ");
  const seen = new Set<number>();
  return numbersSaid(text).filter((n) => (seen.has(n.value) ? false : (seen.add(n.value), true)));
}

/** Every number somebody signed: in a talking point, an amount, a configuration, the date, the place, a name. */
export function signedNumbers(ground: Ground): Set<number> {
  const text = [
    ...ground.talkingPoints,
    ...ground.money,
    ...ground.configurations.map((c) => c.label),
    ground.possessionDate ?? "",
    ground.location ?? "",
    ...(ground.names ?? []),
  ].join("\n");
  const out = new Set(numbersSaid(toAsciiDigits(text)).map((n) => n.value));
  for (const c of ground.configurations) if (c.areaSqft) out.add(Math.round(c.areaSqft));
  for (const c of ground.configurations) if (c.plotArea) out.add(Math.round(c.plotArea));
  return out;
}

/**
 * Whether one written copy block may be advertised.
 *
 * Every check runs against `ground`, never against the brief and never
 * against the prompt. The order is deliberate: the cheapest refusals that
 * make the rest pointless come first, so a phase nobody may advertise is not
 * measured for line length.
 */
export function gateCopy(
  copy: Copy,
  spec: CopySpec,
  ground: Ground,
  budget: Budget,
  /** A Hindi card's place, points and its reading in English. Without a reading, its words are unread. */
  local?: LocalLines | null,
): { verdict: Verdict; reasons: Reason[] } {
  const reasons: Reason[] = [];
  const add = (code: ReasonCode, detail: string) => {
    if (!reasons.some((r) => r.code === code && r.detail === detail)) reasons.push({ code, detail });
  };

  if (!ground.advertisable) {
    add("NOT_ADVERTISABLE", "This phase can't be advertised yet.");
    return { verdict: "FAIL", reasons };
  }

  const parts: [keyof Copy, string][] = [
    ["headline", copy.headline],
    ["body", copy.body],
    ["cta", copy.cta],
  ];
  for (const [name, value] of parts) {
    if (!value.trim()) add("MISSING_PART", `The ${name} came back empty.`);
  }
  if (reasons.length) return { verdict: "FAIL", reasons };

  const all = `${copy.headline}\n${copy.body}\n${copy.cta}`;
  const folded = fold(all);

  // One script to an advertisement: all English or all Hindi, never a mix
  // (the client, 1 October 2026). The writer is told; this is the refusal.
  const stray = otherScriptWords(all, spec.language);
  if (stray.length) {
    const said = stray.slice(0, 3).map((w) => `"${w}"`).join(", ");
    add(
      "MIXED_SCRIPT",
      writesLatin(spec.language)
        ? `Writes ${said} in another script. An English ad is all English.`
        : `Writes ${said} in English letters. A ${spec.language} ad is all ${spec.language}.`,
    );
  }

  // The word checks below are substring matches, and a substring match across
  // two scripts finds nothing for the wrong reason. Rather than report a clean
  // block, the gate says it could not read this one and holds it for a person.
  // The number checks are unaffected: `toAsciiDigits()` makes a price a price
  // in every script, which is the half that carries Section 12.
  //
  // Readable means written in the Brain's own script, which is Latin unless
  // its signed words say otherwise. An empty never-say list is not a reason
  // to pass Marathi copy unread: "मेट्रो से आठ मिनट" on a tower with no metro
  // fact cleared that way, because nothing was there to fail to match.
  const signedWords = [...ground.neverSay, ...ground.talkingPoints, ground.location ?? ""].join(" ").trim();
  const readable = sameScript(all, signedWords || "Latin");
  // A card in a script of its own is read back into English by a second
  // model, and the word checks read that. A reading is a model's too, so the
  // numbers below are measured on the card AND on the reading: one the
  // reading dropped is still in the card.
  const reading = readable ? null : local?.reading ?? null;
  const read = reading ? `${reading.headline}\n${reading.body}\n${reading.cta}` : null;
  const measured = read ? `${all}\n${read}` : all;

  if (readable || read) {
    // A banned phrase, however it was cased or spaced.
    const said = read ? `${folded}\n${fold(read)}` : folded;
    for (const phrase of ground.neverSay) {
      const needle = fold(phrase);
      if (needle && said.includes(needle)) {
        add("NEVER_SAY", `Says "${phrase.trim()}", which is on the never-say list.`);
      }
    }
  } else {
    add(
      "UNCHECKED_WORDING",
      writesLatin(spec.language)
        ? `The approved facts are not written in ${spec.language}, so a person has to read this.`
        : `This ${spec.language} card could not be read back into English to be checked.`,
    );
  }

  // Every amount has to be an amount somebody signed.
  // A published value arrives either labelled ("Booking amount: Rs 5,00,000")
  // or bare, and both have to resolve to the same number.
  const allowed = new Set(
    ground.money.flatMap((v) => {
      const bare = /^[\d,.]+$/.test(v.trim()) ? [Number(v.replace(/[^\d.]/g, ""))] : [];
      return [...moneyIn(v), ...bare].filter((n) => Number.isFinite(n) && n > 0);
    }),
  );
  const pointMoney = ground.talkingPoints.flatMap(moneyIn);
  for (const n of pointMoney) allowed.add(n);
  // A signed amount may be quoted the way an ad prints it: a booking amount
  // of 2,50,500 is written ₹2.51 Lakh, and that is still the signed amount.
  for (const n of [...allowed]) for (const m of moneyIn(adPrice(n))) allowed.add(m);

  // A configuration's price is usually computed, so it arrives as 7,631,000
  // while every launch advertisement in India writes it as 76.3 lakh.
  // Matching those two exactly would refuse the ordinary rounding, so a
  // quoted amount counts as this configuration's when it is within one per
  // cent of it. The tolerance reaches configuration prices only: a booking
  // amount is typed by hand and is quoted as it was typed.
  const priced = ground.configurations.filter(
    (c): c is UnitPrice & { startingPrice: number } =>
      c.startingPrice !== null && c.startingPrice > 0,
  );
  const near = (quoted: number, price: number) =>
    Math.abs(quoted - price) <= price * CONFIG_PRICE_TOLERANCE;

  const quoted = [...new Set(moneyIn(measured))];
  for (const n of quoted) {
    if (allowed.has(n)) continue;
    if (priced.some((c) => near(n, c.startingPrice))) continue;
    add("UNGROUNDED_MONEY", `Quotes ${n.toLocaleString("en-IN")}, which is not a published price.`);
  }

  // A price is printed the way the trade prints one. "Rs 2,18,24,000" on the
  // first live ad was the first thing a person at a marketing firm pointed
  // at; ₹2.19 Cr* is how every developer's ad in India writes it.
  for (const figure of fullFigures(all)) {
    add("PRICE_FORMAT", `Writes ${figure} in full; write it as ${adPrice(Number(figure.replace(/[^\d]/g, "")))}*.`);
  }

  // The price has to belong to the configuration the copy names.
  //
  // This is the check the whole `unit_types` table exists for. "2 BHK from
  // Rs 48 lakh" was cleared by everything above whenever Rs 48 lakh was a
  // real approved price on this tower, including when it was the 1 BHK's.
  //
  // "1 & 2 BHK from Rs 48 lakh" is ordinary and lawful, which is why the
  // rule is about the configurations NAMED rather than about the cheapest:
  // name the 1 BHK and its price is yours to quote.
  //
  // The configurations named are read against every one recorded, priced or
  // not: a plot priced at Rs 45 lakh beside a villa nobody priced is one
  // priced configuration, and "Villas from Rs 45 lakh" still quotes the
  // plot's price.
  const ascii = toAsciiDigits(measured);
  const recorded = [...new Set(ground.configurations.map((c) => c.config))];
  if (priced.length && recorded.length > 1) {
    const named = configsNamedIn(ascii, recorded);
    if (named.length) {
      const mine = priced.filter((c) => named.includes(c.config));
      const theirs = priced.filter((c) => !named.includes(c.config));
      const heading = [
        ...new Set(
          (mine.length ? mine : ground.configurations.filter((c) => named.includes(c.config))).map((c) => c.label),
        ),
      ].join(" and ");
      for (const n of quoted) {
        if (mine.some((c) => near(n, c.startingPrice))) continue;
        const wrong = theirs.find((c) => near(n, c.startingPrice));
        if (wrong) {
          add(
            "PRICE_NOT_FOR_CONFIG",
            `Says ${heading} and quotes Rs ${n.toLocaleString("en-IN")}, which is the ${wrong.label} price.`,
          );
        }
      }
    }
  }

  // A configuration nobody recorded is a product the advertisement offers and
  // the library cannot price. Usually that is a gap rather than an invention,
  // so it holds for a person rather than failing outright.
  if (ground.configurations.length) {
    for (const beds of bedCountsIn(ascii)) {
      if (bedsRecorded(beds, recorded)) continue;
      add(
        "CONFIG_NOT_RECORDED",
        beds === 0.5
          ? "Offers a 1 RK, and no approved configuration here is one."
          : `Offers a ${beds} BHK, and no approved configuration here is one.`,
      );
    }
    // A plot, a shop, an office, a villa or a penthouse offered as the thing
    // for sale, which nobody recorded here. Read as a product only: "20
    // minutes to your office" and "a site office" offer nothing.
    for (const key of namedProductsIn(ascii)) {
      if (recorded.includes(key)) continue;
      add(
        "CONFIG_NOT_RECORDED",
        `Offers ${priceLineLabel({ config: key, label: configLabel(key) }).toLowerCase()}, and no approved configuration here is one.`,
      );
    }
  }

  // A rate is the shape an assured-returns promise takes.
  const allowedRates = new Set(ground.talkingPoints.flatMap(ratesIn));
  for (const r of new Set(ratesIn(measured))) {
    if (!allowedRates.has(r)) {
      add("UNGROUNDED_RATE", `States ${r} per cent, which no signed fact supports.`);
    }
  }

  // A year in the copy is read as a possession promise, and the only one that
  // may be made is the one the brand approver signed.
  const promisedYear = ground.possessionDate
    ? Number(ground.possessionDate.slice(0, 4))
    : null;
  const pointYears = new Set(ground.talkingPoints.flatMap(yearsIn));
  for (const y of new Set(yearsIn(measured))) {
    if (y === promisedYear || pointYears.has(y)) continue;
    add(
      "POSSESSION_MISMATCH",
      promisedYear
        ? `Says ${y} where the approved possession date is ${ground.possessionDate}.`
        : `Says ${y} where no possession date has been approved.`,
    );
  }

  // Every other number is a claim too: minutes to a station, acres, floors,
  // towers. "8 min from the station" cleared on a tower whose Brain said
  // nothing about a station, because only money, rates and years were
  // measured. A number no signed fact carries is one the writer made up, in
  // any script, because the digits fold.
  const signed = signedNumbers(ground);
  for (const n of looseNumbersIn(measured)) {
    if (signed.has(n.value)) continue;
    add("UNGROUNDED_NUMBER", `Says "${n.said}", which no approved fact says.`);
  }

  // The headline has to lead on something the Brain actually says. With no
  // talking points it may still lead on the location, a price or a
  // configuration, which `leadsOnSigned()` accepts; anything else it leads
  // on was made up. (Copy is not written at all without a selling point, so
  // this is the gate holding when something else wrote it.)
  // A festival greeting sells nothing, so it leads on nothing; an invitation,
  // a construction update and "ready to move" may lead on the project's name.
  const headline = readable ? copy.headline : reading?.headline ?? null;
  const namesLead =
    !!spec.angle && NAMES_LEAD.has(spec.angle) && headline !== null && namesProject(headline, ground.names ?? []);
  if (headline !== null && spec.angle !== "GREETING" && !namesLead && !leadsOnSigned(headline, ground)) {
    add("NO_TALKING_POINT", "The headline leads on nothing in the approved talking points.");
  }
  // What the card's angle forbids it to say, on the card and its reading.
  const breach = angleBreach(spec.angle, measured);
  if (breach) add("OFF_ANGLE", breach);

  const against = (limit: number, from: string | null) =>
    from ? `the ${limit} that ${from} allows` : `${limit}`;
  if (copy.headline.length > budget.headline) {
    add(
      "OVER_LENGTH",
      `Headline is ${copy.headline.length} characters against ${against(budget.headline, budget.headlineFrom)}.`,
    );
  }
  if (copy.body.length > budget.body) {
    add(
      "OVER_LENGTH",
      `Body is ${copy.body.length} characters against ${against(budget.body, budget.bodyFrom)}.`,
    );
  }

  // What the registering state's authority forbids an ad to say.
  const ad = adRuleFor(ground.registrationState);
  if (ad?.noTravelTime && hasTravelTime(measured)) {
    add("STATE_AD_RULE", `States a travel time. ${ad.authority} allows a distance ("2 km from"), never a time.`);
  }
  if (ad?.noTermsApply && hasTermsApply(measured)) {
    add("STATE_AD_RULE", `Says "T&C apply", which ${ad.authority} does not allow on an ad.`);
  }

  // A Hindi ad prints the location in Hindi, on a line of its own. It has to
  // read back as the place that was signed, or that line names another place.
  if (reading && ground.location && printsLocalFacts(spec.language)) {
    const place = local?.place?.trim() ?? "";
    if (!place) {
      add("LOCAL_PLACE", `Gives no ${spec.language} spelling of ${ground.location}.`);
    } else if (otherScriptWords(place, spec.language).length) {
      add("LOCAL_PLACE", `Writes the location "${place}" in English letters.`);
    } else if (!samePlace(reading.place, ground.location)) {
      add("LOCAL_PLACE", `Writes the location as "${place}", which reads as "${reading.place ?? "nothing"}", not ${ground.location}.`);
    } else {
      // The place said twice, spelt two ways: "गोरगांव" in the body under
      // "गोरेगांव पश्चिम" on the place line. The reading cannot see it, because
      // it reads both as Goregaon.
      const drift = misspeltPlace(all, place);
      if (drift) add("LOCAL_PLACE", `Spells "${drift.said}" in the copy and "${drift.place}" on the place line. Spell it one way.`);
    }
  }

  // The brand typeface no longer holds a card (the client, 1 October 2026).
  // Posts never set the brand's own font: every word is set in the bundled
  // faces, Noto Devanagari included, so a Hindi ad under an English brand
  // kit is made, and the brand stays as it is.

  // An exemption registers nothing and so has no lapse to warn about, which
  // is why this reads the days rather than the number.
  if (ground.registrationDaysLeft !== null && ground.registrationDaysLeft <= EXPIRY_HOLD_DAYS) {
    add("REGISTRATION_EXPIRING", `The registration runs out in ${ground.registrationDaysLeft} days.`);
  }

  return { verdict: verdictOf(reasons), reasons };
}

/**
 * The ground, read out of published Brain values.
 *
 * Kept here beside the gate rather than in the reader, so a check can build
 * one from a plain object and never touch a database.
 */
/** The published fields that carry an amount a creative may quote. */
export const MONEY_FIELDS = ["price.base_psf", "price.booking_amount"] as const;

export function groundFrom(input: {
  values: Record<string, string | null>;
  advertisable: boolean;
  registrationNo: string | null;
  registrationState?: string | null;
  permitNo?: string | null;
  registrationDaysLeft: number | null;
  facelessLanguages: readonly string[];
  /** Approved configurations only. The reader is what withholds the rest. */
  configurations?: readonly UnitPrice[];
  /** The city the node sits in (its REGION), taken OUT of the location: an ad names the locality only. */
  city?: string | null;
  /** The project's and the tower's names, which the writer is told. */
  names?: readonly string[];
}): Ground {
  return {
    talkingPoints: asList(input.values["claims.talking_points"]),
    ...(asList(input.values["claims.nearby"]).length ? { nearby: asList(input.values["claims.nearby"]) } : {}),
    ...(input.values["claims.nearby_measured"]?.trim() ? { nearbyMeasured: input.values["claims.nearby_measured"]!.trim() } : {}),
    neverSay: asList(input.values["claims.never_say"]),
    possessionDate: input.values["claims.possession_date"] ?? null,
    // Labelled, and in Indian digit grouping. Handed to a writer as a bare
    // "28500" it comes back printed on the creative as a bare 28500, which is
    // how one of these first reached a Marathi draft.
    money: MONEY_FIELDS.flatMap((key) => {
      const n = Number(String(input.values[key] ?? "").replace(/[^\d.]/g, ""));
      if (!Number.isFinite(n) || !n) return [];
      return [`${fieldByKey(key)?.label ?? key}: Rs ${n.toLocaleString("en-IN")}`];
    }),
    configurations: [...(input.configurations ?? [])],
    advertisable: input.advertisable,
    registrationNo: input.registrationNo,
    registrationState: input.registrationState ?? null,
    permitNo: input.permitNo ?? null,
    registrationDaysLeft: input.registrationDaysLeft,
    facelessLanguages: [...input.facelessLanguages],
    location: exactLocation(input.values["claims.location"], input.city),
    names: [...(input.names ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Generated imagery, and what it may never be
// ---------------------------------------------------------------------------

/**
 * What a generated picture is allowed to be.
 *
 * The Approved Asset Library exists because every pixel of the building has
 * to trace to a file a named human approved. An image model that draws the
 * tower destroys that in one call, and the drawing is a misrepresentation
 * under Section 3 before it is anything else. So generated imagery is
 * backdrop, texture and abstraction, and the building is never in it.
 *
 * `canGenerate()` refuses a prompt that asks for the property. It is a coarse
 * check on words, and it is not the only control: a generated file is stored
 * with its own origin and the layout can never place one in the hero layer.
 */
export const GENERATED_ROLES = ["BACKDROP", "TEXTURE", "GRADIENT", "PATTERN"] as const;

export type GeneratedRole = (typeof GENERATED_ROLES)[number];

export function isGeneratedRole(raw: string | null | undefined): raw is GeneratedRole {
  return GENERATED_ROLES.includes(raw as GeneratedRole);
}

const PROPERTY_WORDS = [
  "apartment", "balcony", "bedroom", "building", "bungalow", "clubhouse",
  "elevation", "facade", "façade", "flat", "floor plan", "highrise",
  "high rise", "interior", "kitchen", "lobby", "penthouse", "property",
  "residence", "rooftop", "skyline", "society", "tower", "villa",
];

export type GenerateCheck =
  | { ok: true; prompt: string }
  | { ok: false; code: "NO_PROMPT" | "ROLE" | "DEPICTS_PROPERTY"; message: string };

export function canGenerate(input: { role: string; prompt: string }): GenerateCheck {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return { ok: false, code: "NO_PROMPT", message: "Describe the backdrop you want." };
  }
  if (!isGeneratedRole(input.role)) {
    return {
      ok: false,
      code: "ROLE",
      message: "A generated picture can only be a backdrop, a texture, a gradient or a pattern.",
    };
  }
  const folded = fold(prompt);
  const hit = PROPERTY_WORDS.find((w) => folded.includes(w));
  if (hit) {
    return {
      ok: false,
      code: "DEPICTS_PROPERTY",
      message: `Asks for "${hit}". The building comes from the Asset Library, never from a model.`,
    };
  }
  return { ok: true, prompt };
}

/**
 * What is actually sent, rather than what was typed.
 *
 * The refusal above catches the prompt that asks for a tower. This catches
 * the one that did not ask and gets one anyway, which is most of them: an
 * image model handed "warm evening light over a city" will draw buildings
 * because that is what the words mean to it.
 */
export function backdropPrompt(prompt: string): string {
  return (
    `${prompt.trim()}. Abstract advertising backdrop only. ` +
    "No buildings, no architecture, no interiors, no windows, no skyline, " +
    "no people, no faces, no text, no letters, no numbers, no logos. " +
    "Soft, evenly lit, uncluttered, with room for text to sit over it."
  );
}
