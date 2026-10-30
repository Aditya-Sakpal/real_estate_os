/**
 * The instant form a Meta Leads ad opens, and what a buyer's answers on it
 * mean. Pure and database-free, covered by `check:logic`; `meta.ts` posts
 * the form and `capture-rules.ts` reads a lead's answers with it.
 *
 * Our first live Leads campaign (October 2026, Goregaon West, from ₹1.45 Cr)
 * brought 38 leads at Rs 134 each and not one qualified buyer: about one in
 * four said they never enquired, and one in five wanted another area or
 * budget. The form asked only a name and a phone, both filled in by
 * Facebook, so one tap sent it. `doc/lead-quality.md` is the research behind
 * what replaced it; in short, the trade's rules:
 *
 * 1. **Higher intent.** A review screen the buyer confirms before sending
 *    (`is_optimized_for_quality`), and their number confirmed with a code
 *    (`is_phone_sms_verify_enabled`). Fewer leads, far fewer taps by mistake.
 * 2. **The price and the place before any question.** The intro card prints
 *    the signed price lines and the exact locality, so a buyer with half the
 *    budget or another area in mind stops there instead of becoming a lead.
 * 3. **Three or four multiple-choice questions**: the home, the budget, when,
 *    and where they live. A tap each, so a real buyer is barely slowed, and
 *    each answer reaches the board and the agent's first call.
 * 4. **Answers are what the buyer said, not what we checked.** They enter the
 *    qualification at `FORM_CONFIDENCE`, enough to count toward the score,
 *    and any call that hears the buyer say otherwise wins.
 *
 * Option keys carry their meaning ("under_12500000", "cfg_2BHK"), and the
 * reader reads either the key or the words, because Meta's lead retrieval
 * has been seen to return either for a multiple-choice answer.
 */

import { qualConfigOf, type Heard, type Qualification } from "./qualification-rules.ts";
import { configDef } from "./unit-rules.ts";

/** The question keys, which come back as the field names of a lead's answers. */
export const FORM_Q = {
  home: "home_type",
  budget: "budget",
  when: "when_buying",
  lives: "lives_in",
} as const;

/**
 * How sure a form answer is. Above `MIN_CONFIDENCE`, so it counts toward the
 * score; below what a call reading carries, so a call that heard the buyer
 * say otherwise replaces it.
 */
export const FORM_CONFIDENCE = 0.6;

/** The intro card's lines, at most. */
export const INTRO_MAX_LINES = 4;

export type FormFacts = {
  /** The project, as the buyer knows it. */
  project: string;
  /** The tower advertised; left out of the title when it is the project. */
  tower: string | null;
  /** The one exact locality the ads print ("Goregaon West"), or null. */
  location: string | null;
  /** The region node's name ("Mumbai"). */
  city: string | null;
  /** The ad's own price lines, cheapest first ("1 BHK starting at ₹1.45 Cr*"). */
  prices: string[];
  /** The footnote the star points at. */
  priceNote: string | null;
  /** The cheapest approved price, in rupees. */
  cheapest: number | null;
  /** Configurations on sale, catalog keys (`2BHK`) with their labels. */
  configs: { key: string; label: string }[];
  /** The developer's sales phone, E.164, for the thank-you screen's call button. */
  salesPhone: string | null;
};

export type FormOption = { key: string; value: string };
export type FormQuestion = { type: "CUSTOM"; key: string; label: string; options: FormOption[] };

/** What a Leads ad's form says, frozen on the publication when it is queued. */
export type FormSpec = {
  intro: { title: string; lines: string[] } | null;
  questions: FormQuestion[];
  thanks: { body: string; phone: string | null };
};

// ---------------------------------------------------------------------------
// Money in the buyer's words
// ---------------------------------------------------------------------------

const LAKH = 1e5;
const CRORE = 1e7;

/** Round amounts a budget question is asked in, in rupees. */
const LADDER = [
  20, 30, 40, 50, 60, 75, 90, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000,
].map((l) => l * LAKH);

/** "₹90 Lakh", "₹1.25 Cr". */
export function rupeesWords(r: number): string {
  if (r >= CRORE) return `₹${String(Math.round((r / CRORE) * 100) / 100)} Cr`;
  return `₹${Math.round(r / LAKH)} Lakh`;
}

const floorTo = (r: number) => [...LADDER].reverse().find((x) => x <= r) ?? LADDER[0];
const ceilTo = (r: number) => LADDER.find((x) => x >= r) ?? LADDER[LADDER.length - 1];

export type BudgetOption = FormOption & { min: number | null; max: number | null };

/**
 * Four bands around the cheapest home: one below it, so a buyer who cannot
 * reach it says so rather than guessing, the band it sits in, and two above.
 * For ₹1.45 Cr: under ₹1.25 Cr, ₹1.25 Cr to ₹2.5 Cr, ₹2.5 Cr to ₹3.5 Cr,
 * above ₹3.5 Cr.
 */
export function budgetOptions(cheapest: number): BudgetOption[] {
  const lo = floorTo(cheapest * 0.9);
  let mid = ceilTo(cheapest * 1.4);
  if (mid <= lo) mid = ceilTo(lo + 1);
  let hi = ceilTo(cheapest * 2.2);
  if (hi <= mid) hi = ceilTo(mid + 1);
  return [
    { key: `under_${lo}`, value: `Under ${rupeesWords(lo)}`, min: null, max: lo },
    { key: `from_${lo}_to_${mid}`, value: `${rupeesWords(lo)} to ${rupeesWords(mid)}`, min: lo, max: mid },
    { key: `from_${mid}_to_${hi}`, value: `${rupeesWords(mid)} to ${rupeesWords(hi)}`, min: mid, max: hi },
    { key: `above_${hi}`, value: `Above ${rupeesWords(hi)}`, min: hi, max: null },
  ];
}

/** Reads a budget answer back, by its key or its words. */
export function readBudget(answer: string): { min: number | null; max: number | null } | null {
  const a = answer.trim();
  let m = /^under_(\d+)$/.exec(a);
  if (m) return { min: null, max: Number(m[1]) };
  m = /^from_(\d+)_to_(\d+)$/.exec(a);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = /^above_(\d+)$/.exec(a);
  if (m) return { min: Number(m[1]), max: null };
  const amounts = [...a.matchAll(/₹?\s*(\d+(?:\.\d+)?)\s*(cr|crore|lakh|lac|l)\b/gi)].map(
    (x) => Number(x[1]) * (/^c/i.test(x[2]) ? CRORE : LAKH),
  );
  if (!amounts.length) return null;
  if (/^under|^below|^less/i.test(a)) return { min: null, max: amounts[0] };
  if (/^above|^over|^more/i.test(a)) return { min: amounts[0], max: null };
  return amounts.length >= 2 ? { min: amounts[0], max: amounts[1] } : null;
}

/** The qualification's band for a budget whose top is `max` (none is above every band). */
export function bandFor(max: number | null): string {
  if (max === null) return "ABOVE_1_5CR";
  if (max <= 60 * LAKH) return "UNDER_60L";
  if (max <= 90 * LAKH) return "60L_90L";
  if (max <= 150 * LAKH) return "90L_1_5CR";
  return "ABOVE_1_5CR";
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

export const WHEN_OPTIONS: (FormOption & { timeline: string })[] = [
  { key: "le_90d", value: "Within 3 months", timeline: "31_90D" },
  { key: "d91_180", value: "In 3 to 6 months", timeline: "91_180D" },
  { key: "gt_180d", value: "In 6 to 12 months", timeline: "GT_180D" },
  { key: "exploring", value: "Just looking for now", timeline: "EXPLORING" },
];

const NOT_SURE: FormOption = { key: "not_sure", value: "Not sure yet" };

function livesOptions(f: FormFacts): FormOption[] {
  const out: FormOption[] = [];
  if (f.location) out.push({ key: "near", value: `In or near ${f.location}`.slice(0, 80) });
  if (f.city) out.push({ key: "city", value: (f.location ? `Elsewhere in ${f.city}` : `In ${f.city}`).slice(0, 80) });
  out.push({ key: "india", value: f.city ? `Outside ${f.city}`.slice(0, 80) : "Elsewhere in India" });
  out.push({ key: "abroad", value: "Outside India" });
  return out;
}

/**
 * The questions, in the order a buyer answers them: the home (only when the
 * tower sells more than one kind), the budget (only with a signed price),
 * when, and where they live now. Name and phone come after, filled in.
 */
export function formQuestions(f: FormFacts): FormQuestion[] {
  const qs: FormQuestion[] = [];
  const configs = [...new Map(f.configs.filter((c) => configDef(c.key)).map((c) => [c.key, c])).values()].slice(0, 5);
  if (configs.length >= 2) {
    qs.push({
      type: "CUSTOM",
      key: FORM_Q.home,
      label: "Which home are you looking for?",
      options: [...configs.map((c) => ({ key: `cfg_${c.key}`, value: c.label.slice(0, 80) })), NOT_SURE],
    });
  }
  if (f.cheapest && f.cheapest > 0) {
    qs.push({
      type: "CUSTOM",
      key: FORM_Q.budget,
      label: "What is your budget?",
      options: budgetOptions(f.cheapest).map(({ key, value }) => ({ key, value })),
    });
  }
  qs.push({ type: "CUSTOM", key: FORM_Q.when, label: "When do you plan to buy?", options: WHEN_OPTIONS.map(({ key, value }) => ({ key, value })) });
  qs.push({ type: "CUSTOM", key: FORM_Q.lives, label: "Where do you live now?", options: livesOptions(f) });
  return qs;
}

/**
 * The intro card: the project and its locality as the title, the price lines
 * and the place as the lines under it. A buyer reads what it costs and where
 * it is before they are asked anything.
 */
export function formIntro(f: FormFacts): FormSpec["intro"] {
  const name = f.tower && f.tower !== f.project ? `${f.project} ${f.tower}` : f.project;
  const title = (f.location ? `${name}, ${f.location}` : name).slice(0, 60);
  const lines = [
    ...f.prices.slice(0, 3),
    ...(f.location ? [`In ${f.location}${f.city && !f.location.includes(f.city) ? `, ${f.city}` : ""}`] : []),
  ]
    .map((l) => l.slice(0, 80))
    .slice(0, INTRO_MAX_LINES - (f.prices.length && f.priceNote ? 1 : 0));
  if (f.prices.length && f.priceNote) lines.push(f.priceNote.slice(0, 80));
  return lines.length ? { title, lines } : null;
}

export function formSpec(f: FormFacts): FormSpec {
  return {
    intro: formIntro(f),
    questions: formQuestions(f),
    thanks: {
      body: "Our team will call you in a few minutes to answer your questions and set up a site visit.",
      phone: f.salesPhone,
    },
  };
}

/** A stored spec, read back defensively: anything malformed is no spec. */
export function readSpec(raw: unknown): FormSpec | null {
  const r = raw as Partial<FormSpec> | null | undefined;
  if (!r || !Array.isArray(r.questions) || !r.thanks || typeof r.thanks.body !== "string") return null;
  return r as FormSpec;
}

/**
 * The body posted to `{page}/leadgen_forms`. Without a spec (a publication
 * queued before forms carried one) it is still higher intent, with no
 * questions and no intro: better than what it replaced, short of the rest.
 */
export function leadFormBody(o: {
  name: string;
  spec: FormSpec | null;
  brand: string;
  place: string;
  privacyUrl: string;
  link: string;
  consentKey: string;
  measureKey: string;
}): Record<string, unknown> {
  const spec = o.spec;
  const thanks = spec?.thanks;
  return {
    name: o.name,
    locale: "EN_US",
    block_display_for_non_targeted_viewer: true,
    // Higher intent: the buyer reviews and confirms before it is sent.
    is_optimized_for_quality: true,
    // And proves the number with a code, which a tap by mistake never does.
    is_phone_sms_verify_enabled: true,
    ...(spec?.intro
      ? {
          context_card: {
            title: spec.intro.title,
            style: "LIST_STYLE",
            content: spec.intro.lines,
            button_text: "Continue",
          },
        }
      : {}),
    ...(spec?.questions.length ? { question_page_custom_headline: "A few quick questions" } : {}),
    questions: [...(spec?.questions ?? []), { type: "FULL_NAME" }, { type: "PHONE" }],
    privacy_policy: { url: o.privacyUrl, link_text: `${o.brand} privacy policy`.slice(0, 70) },
    custom_disclaimer: {
      title: "Before you send",
      body: { text: `${o.brand} will use your number to tell you about ${o.place}.` },
      checkboxes: [
        {
          key: o.consentKey,
          text: `I agree to be contacted by ${o.brand} about ${o.place} by call and WhatsApp.`,
          is_required: true,
          is_checked_by_default: false,
        },
        {
          key: o.measureKey,
          text: "Meta may be told, in coded form, whether this enquiry led to a visit or a booking.",
          is_required: false,
          is_checked_by_default: false,
        },
      ],
    },
    thank_you_page: thanks?.phone
      ? {
          title: "Thank you",
          body: thanks.body,
          button_type: "CALL_BUSINESS",
          button_text: "Call us now",
          business_phone_number: thanks.phone,
        }
      : {
          title: "Thank you",
          body: thanks?.body ?? "Our sales team will call you shortly.",
          button_type: "VIEW_WEBSITE",
          button_text: "View the project",
          website_url: o.link,
        },
  };
}

// ---------------------------------------------------------------------------
// Reading the answers back
// ---------------------------------------------------------------------------

export type FormAnswers = {
  /** Each answered question in the buyer's words, for the lead's page and the call. */
  answers: { question: string; answer: string }[];
  /** What counts toward the score, at `FORM_CONFIDENCE`. */
  qualification: Qualification;
  /** The buyer said they live outside India. */
  abroad: boolean;
};

const QUESTION_WORDS: Record<string, string> = {
  [FORM_Q.home]: "Looking for",
  [FORM_Q.budget]: "Budget",
  [FORM_Q.when]: "Buying",
  [FORM_Q.lives]: "Lives",
};

/** The words to show for an answer that came back as its key. */
function answerWords(question: string, a: string): string {
  if (question === FORM_Q.budget) {
    const b = readBudget(a);
    if (b && /^(under|from|above)_/.test(a)) {
      return b.min === null ? `Under ${rupeesWords(b.max!)}` : b.max === null ? `Above ${rupeesWords(b.min)}` : `${rupeesWords(b.min)} to ${rupeesWords(b.max)}`;
    }
  }
  if (question === FORM_Q.when) return WHEN_OPTIONS.find((w) => w.key === a)?.value ?? a;
  if (question === FORM_Q.home) {
    if (a === NOT_SURE.key) return NOT_SURE.value;
    const key = /^cfg_(.+)$/.exec(a)?.[1];
    if (key) return configDef(key)?.label ?? key;
  }
  if (question === FORM_Q.lives) {
    return ({ near: "Nearby", city: "Elsewhere in the city", india: "Elsewhere in India", abroad: "Outside India" } as Record<string, string>)[a] ?? a;
  }
  return a;
}

const heard = (value: string, words: string, extra?: Partial<Heard>): Heard => ({
  value,
  confidence: FORM_CONFIDENCE,
  span: `On the form: ${words}`.slice(0, 200),
  detail: "form",
  ...extra,
});

/**
 * A lead's answers to our questions, from its `field_data` keyed by field
 * name. Fields it does not know (a developer's own form's questions) are
 * kept as answers in their own words and count toward nothing.
 */
export function readFormAnswers(fields: ReadonlyMap<string, string>, known: ReadonlySet<string>): FormAnswers {
  const out: FormAnswers = { answers: [], qualification: {}, abroad: false };
  for (const [question, raw] of fields) {
    if (known.has(question)) continue;
    const a = raw.trim().slice(0, 200);
    if (!a) continue;
    const words = answerWords(question, a);
    out.answers.push({ question: QUESTION_WORDS[question] ?? question.replace(/_/g, " ").slice(0, 60), answer: words });
    if (question === FORM_Q.budget) {
      const b = readBudget(a);
      if (b) out.qualification.budget_band = heard(bandFor(b.max), words, b.max !== null ? { max: b.max } : {});
    } else if (question === FORM_Q.when) {
      const w = WHEN_OPTIONS.find((x) => x.key === a || x.value.toLowerCase() === a.toLowerCase());
      if (w) out.qualification.timeline = heard(w.timeline, w.value);
    } else if (question === FORM_Q.home) {
      const key = /^cfg_(.+)$/.exec(a)?.[1] ?? null;
      const byLabel = key ? null : a.replace(/\s+/g, "").toUpperCase();
      const q = key ? qualConfigOf(key) : byLabel ? qualConfigOf(byLabel) : null;
      if (q) out.qualification.configuration = heard(q, words);
    } else if (question === FORM_Q.lives) {
      if (a === "abroad" || /outside india/i.test(a)) out.abroad = true;
    }
  }
  out.answers = out.answers.slice(0, 8);
  return out;
}

/** One line for the call agent and the lead's page: "Budget: ₹1.25 Cr to ₹2.5 Cr. Buying: Within 3 months." */
export function answersLine(answers: readonly { question: string; answer: string }[]): string {
  return answers.map((a) => `${a.question}: ${a.answer}.`).join(" ").slice(0, 400);
}

/** Whether a lead's stored answers say the buyer lives outside India. */
export function saysAbroad(answers: readonly { question: string; answer: string }[]): boolean {
  return answers.some((a) => /^outside india$/i.test(a.answer.trim()));
}
