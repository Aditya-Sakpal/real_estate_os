/**
 * Placing a real call: who may be called, what the agent is told, and what
 * came back. Pure and database-free, covered by `check:logic`.
 *
 * The policy is the client's. Whether a call needs consent, whether the agent
 * says the call is recorded and whether it says it is an AI are set per
 * organisation (or per project) under the client's agreement with us. Two
 * things are not the client's to switch off: an opt-out is final, and nobody
 * is called outside 10:00 to 21:00 IST.
 *
 * Every call is about one tower, and the agent is handed that tower's signed
 * facts with the call (`projectFacts()`): where it is, the homes and what
 * they start at, possession, the registration and the approved talking
 * points. They are read from the published Brain when the call is placed,
 * never kept on Sarvam, so there is no copy of a price that can go stale.
 * Anything the facts do not say goes to the sales team.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { outcomeOf, type AgentKind, type CallLanguage, type Fact, type Outcome, type Turn } from "./call-rules.ts";
import { redactPhones } from "./mask-rules.ts";
import { adPrice, exactLocation } from "./creative-rules.ts";
import { growthLine, loanLines, type CityGrowth, type LoanMarket } from "./money-facts-rules.ts";
import { guessLanguage } from "./name-language-rules.ts";
import { saidPlace } from "./pronounce-rules.ts";
import { isDevelopment } from "./app-env.ts";

// ---------------------------------------------------------------------------
// The client's calling policy
// ---------------------------------------------------------------------------

export type CallingPolicy = {
  consentRequired: boolean;
  announceRecording: boolean;
  /** The client's own words for the recording notice. Null uses ours. */
  recordingLine: string | null;
  announceAi: boolean;
  /** E.164. Null means no hand-off is possible. */
  handoffNumber: string | null;
  /** Call and message new leads without anybody pressing anything. */
  autoOutreach: boolean;
  /** AI call minutes one project may use in a calendar month. A cap, not a bill. */
  minuteAllowance: number;
  /** Calls at once, pooled across a project's agents. */
  channelLimit: number;
};

/** One stored layer. Null in any field means "inherit from above". */
export type PolicyLayer = {
  [K in keyof CallingPolicy]: CallingPolicy[K] | null;
};

/**
 * The AI line and the recording notice start off. Buyers hung up on hearing
 * them in testing (30 September 2026), and the client chose to drop both;
 * neither is required on the call today. A client can still switch either on
 * in Settings, Calling. The agent never claims to be a person when asked.
 */
export const DEFAULT_POLICY: CallingPolicy = {
  consentRequired: true,
  announceRecording: false,
  recordingLine: null,
  announceAi: false,
  handoffNumber: null,
  autoOutreach: true,
  // The Launch plan's allowance and channels, until a plan is recorded.
  minuteAllowance: 1_500,
  channelLimit: 3,
};

/** Layers from the root down; the deepest value that was actually set wins. */
export function resolvePolicy(layers: readonly PolicyLayer[], base = DEFAULT_POLICY): CallingPolicy {
  const out: CallingPolicy = { ...base };
  for (const layer of layers) {
    for (const key of Object.keys(out) as (keyof CallingPolicy)[]) {
      const v = layer[key];
      if (v !== null && v !== undefined) (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * A number the way somebody typed it, to E.164, or null.
 *
 * Ten digits starting 6 to 9 is an Indian mobile and gets +91; a leading 0 or
 * 91 in front of those ten is dropped the same way. Anything already carrying
 * a + is kept if its length is plausible. Anything else is refused rather
 * than guessed at, because a guessed number rings a stranger.
 */
export function normalisePhone(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const digits = raw.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  const bare = digits.replace(/^\+/, "");
  if (!/^\d+$/.test(bare)) return null;
  if (/^[6-9]\d{9}$/.test(bare)) return `+91${bare}`;
  if (/^0[6-9]\d{9}$/.test(bare)) return `+91${bare.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(bare)) return `+${bare}`;
  return null;
}

/**
 * A phone number typed into a request, as typed, or null. A number names the
 * buyer outright: "call 8652212814 and ask her" once became a call to the last
 * lead the chat had named, because the model read "her" off the chat's
 * memory. Eight to thirteen digits, spaces and dashes allowed; a date is not a
 * number, and "9876543210 2 BHK" is the number and a size.
 */
export function numberIn(text: string): string | null {
  const ascii = text.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
  for (const m of ascii.matchAll(/\+?\d[\d\s-]{6,17}\d/g)) {
    const raw = m[0].trim();
    if (/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}-\d{1,2}-\d{2,4}\b/.test(raw)) continue;
    const parts = raw.split(/\s+/);
    for (let n = parts.length; n > 0; n--) {
      const head = parts.slice(0, n).join(" ");
      if (normalisePhone(head)) return head;
    }
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 13) return raw;
  }
  return null;
}

/**
 * Why a number typed for a buyer will not do, in words that say what to fix.
 * India is the default, so an Indian number is never asked for its country
 * code; a number one digit short is told it is one digit short. "That does
 * not look like a phone number" for 862212814 read as the number never
 * having been given. Null when the number is fine.
 */
export function phoneProblem(input: string): string | null {
  if (normalisePhone(input)) return null;
  const typed = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(typed)) return "That does not look like a mobile number. Type the 10 digits.";
  const local = typed.replace(/\D/g, "").replace(/^(?:0|91)(?=\d{10}$)/, "");
  if (local.length !== 10) return `${typed} has ${local.length} digits. An Indian mobile number has 10.`;
  return `${typed} does not start like an Indian mobile number, which starts with 6, 7, 8 or 9.`;
}

// ---------------------------------------------------------------------------
// Whether this number may be called now
// ---------------------------------------------------------------------------

export { CALLING_HOURS, ENQUIRY_DAYS, istDate, istHour } from "./calling-hours.ts";
import { CALLING_HOURS, ENQUIRY_DAYS, istHour } from "./calling-hours.ts";

export type ConsentRow = {
  channels: string[];
  capturedAt: string;
  expiresAt: string | null;
};

export type GateInput = {
  policy: CallingPolicy;
  nowIso: string;
  enquiredAt: string;
  consents: readonly ConsentRow[];
  optedOut: boolean;
  /**
   * Development (`ENVIRONMENT`, `anyHourFor()`): the hours do not apply, and
   * neither does the enquiry's seven days (the client, 22 October 2026). An
   * opt-out still refuses. The worker and the hosted console run under
   * production, so this lifts nothing there.
   */
  anyHour?: boolean;
};

/**
 * Whether the hours are lifted for this call. In development
 * (`ENVIRONMENT=development`) every call may go out at any hour; in
 * production never, because there the hours are the law, not a setting.
 * The one variable replaced `CALLS_ANY_HOUR` and `CALLS_ANY_HOUR_NUMBERS`
 * (the client, 4 October 2026). The worker runs under production, so the
 * engine's own calls keep the hours wherever it runs.
 */
export function anyHourFor(_phone: string, _byPerson: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return isDevelopment(env);
}

export type GateVerdict =
  | { ok: true; basis: "CONSENT" | "ENQUIRY" | "NOT_REQUIRED" }
  | { ok: false; code: "OPTED_OUT" | "OUTSIDE_HOURS" | "NO_CONSENT"; message: string };

const DAY_MS = 86_400_000;
/** How far the database's clock may run ahead of the pass that reads it. */
const CLOCK_SKEW_MS = 5 * 60_000;


/**
 * The order is the rule. An opt-out refuses whatever else is true. Hours come
 * next, because a call at 11 pm is wrong with every consent in the world.
 * Then consent. Inside the enquiry's seven days the client's setting decides;
 * past them a call needs consent for calls on file whatever the setting says,
 * because that is TRAI's line between answering an enquiry and promotion,
 * and it is not the client's to switch off.
 */
export function gateCall(input: GateInput): GateVerdict {
  if (input.optedOut) {
    return { ok: false, code: "OPTED_OUT", message: "This number asked not to be called." };
  }
  const hour = istHour(input.nowIso);
  if (!input.anyHour && (hour < CALLING_HOURS.from || hour >= CALLING_HOURS.to)) {
    return {
      ok: false,
      code: "OUTSIDE_HOURS",
      message: "Calls go out between 10 am and 9 pm. Try again then.",
    };
  }

  const now = Date.parse(input.nowIso);
  // A consent the database stamped a moment after this pass read its clock
  // (a call list records it just before ringing) is not from the future.
  const consented = input.consents.some(
    (c) =>
      c.channels.includes("call") &&
      Date.parse(c.capturedAt) <= now + CLOCK_SKEW_MS &&
      (c.expiresAt === null || Date.parse(c.expiresAt) > now),
  );
  if (consented) return { ok: true, basis: "CONSENT" };

  const age = now - Date.parse(input.enquiredAt);
  // A few minutes of clock difference between the database and this server
  // must not make a lead entered a moment ago look like the future.
  if (age >= -CLOCK_SKEW_MS && age <= ENQUIRY_DAYS * DAY_MS) {
    return { ok: true, basis: input.policy.consentRequired ? "ENQUIRY" : "NOT_REQUIRED" };
  }
  if (input.anyHour) return { ok: true, basis: "NOT_REQUIRED" };

  return {
    ok: false,
    code: "NO_CONSENT",
    message: `The enquiry is over ${ENQUIRY_DAYS} days old and there is no consent on file.`,
  };
}

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

/**
 * A call opens in Hindi unless the buyer is Marathi (the client, 2 October
 * 2026). The lead's language already holds the name's guess, made when the
 * lead was captured or added (`languageOf()`, the dialog's pick), so a
 * stored Hindi or Marathi stands: a person who chose Hindi for a Patil is
 * obeyed. A lead stored English (a WhatsApp lead, or one from before the
 * guess) is guessed from its name here (`guessLanguage()`, the surname
 * first). English never opens a call. The agent then follows the
 * buyer: it detects the language they answer in and switches to it, and back
 * again if they switch (a setting on the Sarvam agent, and a rule in its
 * prompt; doc/sarvam-qualifier-agent.md section 16).
 */
export const START_LANGUAGE = "hi" as const;

/**
 * The language of the state a project is in, where it is not Hindi or
 * Marathi. A call to a buyer in Bengaluru opens in Kannada unless the name
 * says Marathi or Hindi.
 */
export const STATE_LANGUAGE: Readonly<Record<string, Exclude<CallLanguage, "hi" | "mr" | "en">>> = {
  KA: "kn",
  TN: "ta",
  TG: "te",
  TS: "te",
  AP: "te",
  WB: "bn",
  GJ: "gu",
};

/** The cities a project is most often filed under, to a state code, for a project with no registration state recorded. */
const CITY_STATE: Readonly<Record<string, string>> = {
  bengaluru: "KA", bangalore: "KA", mysuru: "KA", mysore: "KA", mangaluru: "KA", mangalore: "KA", hubballi: "KA", hubli: "KA",
  chennai: "TN", madras: "TN", coimbatore: "TN", madurai: "TN", tiruchirappalli: "TN", trichy: "TN", salem: "TN",
  hyderabad: "TG", secunderabad: "TG", warangal: "TG",
  visakhapatnam: "AP", vizag: "AP", vijayawada: "AP", guntur: "AP", tirupati: "AP", amaravati: "AP",
  kolkata: "WB", calcutta: "WB", howrah: "WB", siliguri: "WB", durgapur: "WB", "new town": "WB", rajarhat: "WB",
  ahmedabad: "GJ", surat: "GJ", vadodara: "GJ", baroda: "GJ", rajkot: "GJ", gandhinagar: "GJ",
  mumbai: "MH", pune: "MH", thane: "MH", "navi mumbai": "MH", nagpur: "MH", nashik: "MH",
};

/** A state code from a city's name, or null when the city is not one we know. */
export function stateOfCity(city: string | null | undefined): string | null {
  const c = (city ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return CITY_STATE[c] ?? null;
}

/** Surnames that are Gujarati far more often than not: in Gujarat they take a Gujarati call, elsewhere a Hindi one. */
const GUJARATI = new Set(
  "patel shah mehta parikh trivedi thakkar modi soni desai joshi pandya vyas bhatt dave raval amin chokshi gandhi kothari sanghvi doshi".split(" "),
);

/**
 * The language a call opens in. A stored Marathi stands, and outside the
 * states in `STATE_LANGUAGE` the rule is as it was: Hindi unless the buyer
 * is Marathi (the client, 2 October 2026).
 *
 * In those states the call opens in the state's language unless the name
 * says Marathi or Hindi (a Gujarati surname in Gujarat says Gujarati). A
 * stored Hindi there is usually the default a lead is given when nothing
 * said otherwise, so it does not outweigh the state on its own.
 */
export function openingLanguage(
  stored: string | null | undefined,
  name: string | null | undefined,
  state?: string | null,
): CallLanguage {
  if (stored === "mr") return "mr";
  const guess = guessLanguage(name);
  const regional = state ? STATE_LANGUAGE[state.trim().toUpperCase()] : undefined;
  if (regional) {
    if (guess === "mr") return "mr";
    if (regional === "gu" && surnamesOf(name).some((s) => GUJARATI.has(s))) return "gu";
    if (guess === "hi") return "hi";
    return regional;
  }
  if (stored === "hi") return "hi";
  return guess === "mr" ? "mr" : START_LANGUAGE;
}

function surnamesOf(name: string | null | undefined): string[] {
  const parts = (name ?? "").toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1) : [];
}

/**
 * Who is calling and what the client chose to disclose, which the agent says
 * once the buyer has confirmed who they are. The greeting itself stays one
 * short question ("am I speaking to Rohan?"), because four sentences before
 * the buyer has said a word is what made the first agent sound like an IVR.
 *
 * English on purpose: the agent says it in whatever language the call is in.
 */
export function callNotice(o: { developer: string; project?: string | null; place?: string | null; policy: CallingPolicy }): string {
  let s = `calling from ${callFrom(o)}`;
  if (o.policy.announceAi) s += " as an AI assistant";
  if (o.policy.announceRecording) {
    const own = o.policy.recordingLine?.trim();
    s += own ? `, and it also says: ${own}` : ", and that this call is recorded for quality purposes";
  }
  return s;
}

/**
 * Who is calling, the way a good pre-sales caller says it in her first
 * breath: "Harbour View by Northwind, Bhandup East". The project first, because
 * a buyer knows the building they saw an ad for, and "calling from BillBay"
 * alone was met with "who is this?" on call after call; the place too,
 * because on 29 October 2026 eight of thirteen buyers asked "kahan se?"
 * when the agent named only the project. Never the wing or tower: "Harbour View
 * E Wing" came out of the voice as "Harbour View Evening". The greeting carries
 * it (`call_from`), so the buyer hears who it is before they answer.
 */
export function callFrom(o: { developer: string; project?: string | null; place?: string | null }): string {
  const project = o.project?.trim();
  const developer = o.developer.trim();
  const who = project && project.toLowerCase() !== developer.toLowerCase() ? `${project} by ${developer}` : developer;
  const place = o.place?.trim();
  return place && !who.toLowerCase().includes(place.toLowerCase()) ? `${who}, ${place}` : who;
}

// ---------------------------------------------------------------------------
// What the agent says aloud: the buyer's name and where they enquired
// ---------------------------------------------------------------------------

/** Words a form fills in that are nobody's name. */
const NOT_A_NAME = new Set([
  "hi", "hii", "hiii", "hello", "hey", "test", "testing", "qa", "user", "unknown", "na", "none", "null", "nil",
  "abc", "xyz", "asdf", "customer", "client", "lead", "buyer", "sir", "madam", "ok", "okay", "yes", "no", "name",
]);
/** Titles in front of a name, said by the agent its own way or not at all. */
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "shri", "shree", "sri", "smt", "kumari", "md", "mohd"]);

/**
 * The first name the agent greets a buyer by, or "" when what the form
 * holds is no name to say: a handle ("bhim__ka__divanaaa"), a greeting
 * ("Hii"), initials ("P K S BL") or a title alone ("MD"). Said aloud, those
 * were "Hii ji" and "bhim ka divanaaa ji". A title in front is skipped, so
 * "MD Samijuddin" is greeted as Samijuddin.
 */
export function spokenName(raw: string | null | undefined): string {
  const s = (raw ?? "").normalize("NFC").trim();
  if (!s) return "";
  // A handle, not a name: underscores, digits, an emoji or an at sign.
  if (/[_@0-9]/.test(s) || /\p{Extended_Pictographic}/u.test(s)) return "";
  const words = s.replace(/[^\p{L}\p{M}'\s.-]/gu, " ").split(/[\s.]+/).filter(Boolean);
  for (const w of words) {
    const low = w.toLowerCase();
    if (TITLES.has(low)) continue;
    if (NOT_A_NAME.has(low)) return "";
    if ([...w].length < 3) return "";
    return w === w.toLowerCase() || w === w.toUpperCase() ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
  }
  return "";
}

/**
 * Where the buyer enquired, as the agent may say it: "a Facebook or Instagram
 * form", "a Google form", "our website", a portal by its name. "" when the
 * source is ours to know and not theirs to hear: a lead typed in by hand
 * (said aloud once as "through Manual"), a walk-in, a referral, a partner.
 */
export function spokenSource(source: string | null | undefined): string {
  const s = (source ?? "").trim().toLowerCase();
  if (!s) return "";
  if (/meta|facebook|instagram/.test(s)) return "a Facebook or Instagram form";
  if (/google/.test(s)) return "a Google form";
  if (/website|web form|landing/.test(s)) return "our website";
  if (/call to our number|called us|inbound/.test(s)) return "a call to our number";
  const flat = s.replace(/[\s.]/g, "");
  const portal = ["MagicBricks", "99acres", "Housing.com", "NoBroker", "Square Yards", "Makaan", "PropTiger"]
    .find((name) => flat.includes(name.toLowerCase().replace(/[\s.]/g, "")));
  return portal ?? "";
}

/**
 * A project, entity or flat named like one of our own checks' fixtures
 * ("QA Project", "Compose Check SPV", "2 BHK QA Classic"). Never offered to
 * a buyer as another project: one was, from the shared dev tenant.
 */
export const looksLikeTest = (name: string | null | undefined): boolean =>
  /\b(qa|test|testing|check|fixture|dummy|xss)\b/i.test(name ?? "");

/**
 * The agent's variables for one call. Every value is a string, because that
 * is what the agent receives, and an empty string means "not known": the
 * prompt asks the question from scratch rather than confirming a guess.
 *
 * The agent is told the tower the call is about (`call_project`) and its
 * signed facts (`project_facts`), and answers from those alone. Anything
 * else goes to the sales team, on the same call: the agent asks Sales Desk
 * to put the buyer through (`connect_sales`), sending back the org, the call
 * and its token, which is why they travel with the call.
 *
 * `property_viewed` stays what the buyer enquired about, so a call about
 * another tower never tells the buyer they asked about it.
 */
export function callVariables(o: {
  leadName: string;
  developer: string;
  project: string;
  tower: string | null;
  city: string | null;
  source: string;
  notice: string;
  /** What the agent sends back when it asks to put the buyer through. */
  hook: { orgId: string; callId: string; token: string };
  /** A call with a goal: what it is for, and today's date so "tomorrow" means something. */
  goal?: { text: string; today: string } | null;
  /** A call placed for another job's agent, and what that job is told. */
  role?: RoleContext | null;
  /** The tower the call is about, as said, and its signed facts (`projectFacts()`). */
  about?: { place: string; facts: string } | null;
  /** How to say the tower's words, "written = said" lines (`wordsToSay()`); sent only once the agents read it. */
  sayWords?: string;
  /** What the buyer said on the form, for the agent to confirm rather than ask (`enquiryFromForm()`). */
  enquiry?: { budget: string; bhk: string } | null;
  /**
   * The opening's place and price, said word for word (`openingFacts()`): the
   * signed locality and the cheapest approved home in words. The agent once
   * worked them out itself and said "flats in Mumbai from one crore fifty
   * lakh" for Goregaon West from one crore forty five lakh.
   */
  opening?: { place: string; price: string } | null;
  /**
   * False when this person never enquired (a cold call list). The agent is
   * told `lead_enquired` "no", and no source or enquired property is sent
   * for it to repeat: a cold contact was once told "you had inquired about
   * Harbour View, E Wing".
   */
  enquired?: boolean;
}): Record<string, string> {
  const cold = o.enquired === false;
  const project = o.about?.place ?? (o.tower ? `${o.project} ${o.tower}` : o.project);
  return {
    user_name: spokenName(o.leadName),
    developer_name: o.developer,
    property_viewed: cold ? project : o.tower ? `${o.project} ${o.tower}` : o.project,
    enquiry_location: o.city ?? "",
    opening_place: o.opening?.place || o.city || "",
    opening_price: o.opening?.price ?? "",
    lead_source: cold ? "" : spokenSource(o.source),
    enquiry_budget: cold ? "" : o.enquiry?.budget ?? "",
    enquiry_bhk: cold ? "" : o.enquiry?.bhk ?? "",
    call_notice: o.notice,
    call_from: callFrom({ developer: o.developer, project: o.project, place: saidPlace(o.opening?.place || o.city, o.city) }),
    call_project: project,
    project_facts: o.about?.facts ?? "",
    ...(o.goal ? { call_goal: o.goal.text, today_date: o.goal.today } : {}),
    // Only the goal agent declares it (v26), and only a cold call sends it.
    ...(cold ? { lead_enquired: "no" } : {}),
    ...(o.sayWords !== undefined ? { say_words: o.sayWords } : {}),
    ...(o.role ? roleVariables(o.role) : {}),
    salesdesk_org: o.hook.orgId,
    salesdesk_call: o.hook.callId,
    salesdesk_key: o.hook.token,
  };
}

/**
 * The place and price the qualifier opens with, as it must say them: the one
 * locality an advertisement prints (`exactLocation()`, never the city when a
 * locality is signed) and the cheapest approved home in the same words its
 * facts carry in brackets. Empty when nothing is signed or priced.
 */
export function openingFacts(o: { location: string | null | undefined; city: string | null | undefined; cheapest: number | null }): { place: string; price: string } {
  const place = exactLocation(o.location, o.city) ?? (o.city ?? "");
  const price = o.cheapest && o.cheapest > 0 ? rupeeWords(o.cheapest) : "";
  return { place, price };
}

/**
 * The budget and the home a buyer picked on our form, as the agent reads
 * `enquiry_budget` and `enquiry_bhk`: it confirms them instead of asking.
 * "Not sure yet" is no answer.
 */
export function enquiryFromForm(answers: readonly { question: string; answer: string }[]): { budget: string; bhk: string } | null {
  const said = (q: string) => answers.find((a) => a.question === q)?.answer ?? "";
  const budget = said("Budget");
  const bhk = /^not sure/i.test(said("Looking for")) ? "" : said("Looking for");
  return budget || bhk ? { budget, bhk } : null;
}

// ---------------------------------------------------------------------------
// The project a call is about
// ---------------------------------------------------------------------------

/**
 * The longest `project_facts` a call carries. The agent reads it on every
 * turn, so a longer one is slower to answer; the talking points past it are
 * left out whole, never cut mid-sentence.
 */
export const PROJECT_FACTS_MAX = 3800;

/** Configurations, amenities, other towers and never-say lines a call carries at most. */
const FACT_UNITS_MAX = 8;
const AMENITIES_MAX = 20;
const OTHER_TOWERS_MAX = 8;
const NEVER_SAY_MAX = 12;

export type FactHome = { label: string; carpetSqft: number; price: number | null };

/**
 * The last line of every call's facts, so it reaches every agent without a
 * prompt edit. Written after a call back where the qualifier said "yes, there
 * is a gym" on a tower whose facts named none, called Goregaon convenient for
 * a buyer in Chembur, and offered a Rs 1.45 crore home to a Rs 1 crore budget.
 * Then it closed on a Rs 1 crore budget for a Rs 1.85 crore home without
 * asking whether a loan was on top (21 October 2026), so a budget below the
 * price is now a question and a loan before it is a no.
 */
export const FACTS_RULE =
  "Only what is written above is true about this project. Anything not written here (an amenity, a size, a tower, how near it is for the buyer) is never confirmed and never denied: the team will confirm it. When the buyer's budget is below every starting price above, never say a home fits it. Ask once whether that is all they can spend, or what they can put down themselves with a home loan on top. When a loan could close the gap, say the tie-up banks and the EMI written above, offer the sales manager to explain the loan and the payment plan, then a site visit. When even a loan cannot (the budget is under half the lowest starting price and it already counts the loan), say so plainly and close. A price is said exactly as the words in brackets beside it, never rounded or changed, and the same way every time it is said in the call: a home from one crore forty five lakh is never one crore fifty lakh. No bank is said to be tied up with this project unless a tie-up is written above.";

/**
 * How every outbound call ends, sent after its facts so it reaches every
 * agent and voice copy without a prompt edit. Their prompts let a "new
 * question" reopen the closing question and let the next step be confirmed
 * before it, and on 24 October 2026 the receptionist, working from the same
 * rules, asked "anything else?" four times and said WhatsApp three times
 * after the buyer had said "it's okay".
 */
export const CLOSING_RULE =
  "How the call ends: the details on WhatsApp are mentioned once in the call and never again. The closing question (such as \"aur kuch?\" or \"अजून काही?\") is asked once in the whole call, as its own short line, never again in any words and never added to another sentence. " +
  "After it, any reply that is not a clear new question (no, okay, theek hai, it's okay, chalega, thank you, a misheard or odd reply, silence) ends the call: call end_interaction with one short goodbye and nothing else. A clear new question is answered in one line, and the next reply ends the call.";

/**
 * The family objection, the way a good closer answers it, sent after every
 * call's facts so it reaches every agent and voice copy. The prompts'
 * Objections item 11 says "invite them to come together", but both examples
 * it gives only accept ("theek hai, unko bhi bol do"), and the agent copies
 * examples: on 25 October 2026 a buyer who said he would discuss it with his
 * wife was told "no rush, details on WhatsApp" and the call ended. The
 * client's answer: agree, paint her happiness at a home he chose, make it a
 * decision they take together, and fix the visit with the family.
 */
export const FAMILY_RULE =
  "When the user says they will first talk to their wife, husband, parents or family, this replaces Objections item 11: agree in one short sentence that it is right to decide together, then invite them to come with the family and ask the day, such as \"Bilkul sir, ek baar family ke saath aa jaiye, kaunsa din theek rahega?\" or in Marathi \"नक्कीच सर, एकदा घरच्यांसोबत या, कोणता दिवस जमेल?\". If they still want to talk first, ask once when to call back, say it back, and close. Never push them to book without the family. Said once in the call; a second no is final.";

/**
 * How a practical human caller works, sent after every call's facts so it
 * reaches every agent and voice copy without a prompt edit, and stated to
 * replace any earlier rule on the same subject. Written from 111 real calls
 * and the client's review (28 October 2026): the agent proposed the visit in
 * its first pitch, asked why after a clear no, congratulated a buyer who had
 * bought elsewhere, talked past "kaun bol raha hai?", and said guesses about
 * earlier calls as facts.
 */
export const HUMAN_RULE =
  "How you work on every call (these replace any rule above on the same subject): " +
  "1. Find out before you propose. Never offer a site visit, a loan, the sales manager or another project until you know what they want (for themselves or investment, the size, the area, roughly the budget) and have said one fact that answers it; the only exception is the person asking for that step first. A goal is where the call should end, never your first sentence. " +
  "2. One short sentence and at most one question a turn. Never repeat the whole pitch. " +
  "3. If they ask something, even while you are speaking (\"kaun bol raha hai?\", \"kahan se?\", \"kya?\"), stop and answer that first in one line (who you are, the team, the developer), then ask your question again. Never resume the sentence they cut. " +
  "4. Be practical, never expressive: no congratulations, no \"wow\", \"great\", \"perfect\", \"kya baat hai\", no praise of their news or budget. " +
  "5. Already bought: say \"Theek hai sir. Abhi koi doosri investment ya second home dekh rahe hain?\" once. Yes: ask for whom and the size, then carry on. No: close in one line. Never ask where they bought. " +
  "6. A clear no (not interested, never enquired, wrong person): on a cold call close in one line, no reason asked. On an enquiry, one short reason check (\"location ki wajah se, ya budget?\"), one fact if a fact answers it, then close. A second no is final. " +
  "7. No urgency (never that homes are selling fast) and no investment advice. Loans, EMI and price history only when they raise money or investment, once, as written in the facts. " +
  "8. The sales manager is offered at most once in the call, and never again after a failed connect. " +
  "9. Never say they asked you to call back, or that the call got cut, unless the reason for this call says so in those words.";

/**
 * How a good human pre-sales caller runs the call, sent after every call's
 * facts so it reaches every agent and voice copy, and stated to replace any
 * earlier rule on the same subject. Written from a real Harbour View caller's
 * recorded calls set beside thirteen of our own (29 October 2026): she said
 * her name, the project and the place before the buyer had to ask, asked
 * "1 BHK ki 2 BHK?" rather than "are you looking for a home?", answered a
 * question in a line, gave a fact every turn, tied the project to the area
 * the buyer named, and did not let go of a visit without a day, a time, the
 * WhatsApp number and a reminder. Ours was asked "kahan se?" on eight of
 * thirteen calls, said the same sentence again when asked, and opened with a
 * yes or no question most buyers answered no. Built per call, so its examples
 * carry the real project, place and price rather than ones an agent copies.
 */
export function callerRule(o: { project: string; place?: string | null; price?: string | null }): string {
  const project = o.project.trim();
  const place = o.place?.trim() || "";
  const at = place ? `${project}, ${place}` : project;
  const fact = place && o.price ? `${place} mein homes ${o.price} se shuru` : o.price ? `homes ${o.price} se shuru` : `${at}`;
  return "How a good human caller runs this call (these replace any rule above on the same subject): " +
    `1. The greeting already said your name and that you are calling from ${at}. Once they confirm who they are, never say who you are again; reply at once with the reason in one short line, then one choice question, never a yes or no question such as "are you looking for a home?". ` +
    `When they enquired: "Ji sir, aapne ${project} ke liye enquiry ki thi. 1 BHK dekh rahe hain ya 2 BHK?" (only sizes the facts carry). When they never enquired: "Ji sir, ${fact}. Aap abhi ghar dekh rahe hain, ya kuch mahine baad?" ` +
    "The project is said by its name alone; the wing or tower only when they ask. " +
    "This holds on a later call too: never open with the visit, and never say you are calling back or that they asked you to call, unless the reason for this call says the buyer asked for it in those words. " +
    "2. Start every reply with one or two words that react to what they just said (ji, achha, haan sir, theek hai; in Marathi हो, बरं, चालेल), then the shortest useful sentence first. At most two short sentences a turn. " +
    `3. Asked who you are, where you are calling from or what this is about, answer in under eight words, such as "Main [your name], ${at} se". Asked where you got their number, answer that and nothing else: when they enquired, the form they filled (as their enquiry source says); when they never enquired, that the team is calling people about homes in the area. Then ask your last question again in fewer and other words. Never say the same sentence twice in the call, and never end two turns with the same question: after "kya?" or a number asked again, give only the answer, in other words. ` +
    "4. When they speak while you are speaking, stop; what you were saying is dropped, and your next reply answers what they said. " +
    "5. Every answer carries one concrete fact from the facts above that fits what they asked or said (a starting price, a carpet area, the possession date, an amenity, the location, a highlight), then one question about them: where they live, who it is for, the size. " +
    "6. Objections, only from the facts: an area they want is answered with what the facts say about how the project connects to it, then one ask whether they would come and see it; a budget below the price is answered with the nearest home and its price said plainly and one question about what they can put down with a home loan; possession too far is answered with the possession date and the work the facts say is done. A second no is final. " +
    "7. A visit is asked for at most twice in the whole call. \"Dekhna padega\", \"sochna padega\", \"wife se puchna padega\" or any not-yet is not a yes: say the details will come on WhatsApp and ask once when to call back, then close; never ask the day again, and never say good homes go fast. Only when they agree to come, ask the day and the time until you have both (twice at most) and say them back once. Then, in one short line each: confirm \"yahi aapka WhatsApp number hai na?\", say the details will come on WhatsApp, say you will call the day before to remind them, and ask them to save this number as [your name] from " + project + ". " +
    "8. Cutting in, the way a good caller does. You hear them whenever they pause, and a pause is often only a breath or a thought, so first judge whether they have finished. When they are thinking or the piece ends mid-thought, your whole reply is \"ji\" and nothing else, so they can carry on over it. Say more at a pause only on these occasions, and in at most five words: " +
    "they are still going and the piece adds nothing new: say only \"ji\" or \"haan ji\" (in Marathi \"हो\") and stop; " +
    "the piece already holds the answer you asked for (a size, a budget, a day, a time): say it back in two or three words and ask your next question, such as \"2 BHK, theek hai. Kahan rehte hain aap?\"; " +
    "the piece asks a question: answer it in one line; " +
    "the piece says something wrong about the project (the place, a price, the possession date): correct it in one line from the facts; " +
    "they go over the same complaint or off the subject a second time: agree in a few words and ask your question again. " +
    "Any other piece that ends mid-thought gets only \"ji\". Never cut in on a no, a goodbye, or a reason they are giving for a no. " +
    "When they say they are thinking or ask you to wait (ruko, ek minute, sochne do, let me think, थांबा), say \"ji\" once and nothing more until they speak again: no \"ji bataiye\", no \"have you thought?\", no question. A sound that is not words is not a turn: never answer it. " +
    "9. Language: speak only Hindi, Marathi or English, the one they speak, and always the respectful aap (in Marathi tumhi), never tum or tu. When they ask for Hindi or Marathi, switch at once and carry on with your last question in it; never ask them which language they want.";
}

/**
 * What to do when a phone's call screener answers, sent after every call's
 * facts so it reaches every agent and voice copy. On 28 October 2026 an
 * iPhone's screener answered "I'll see if this person is available", the
 * agent said "Yes, please let me know", hung up, and recorded a wrong
 * number, which closed the lead.
 */
export const SCREENER_RULE =
  "When the first voice is not the person but their phone's call screener or assistant (an iPhone saying \"I'll see if this person is available\" or asking you to say your name and why you are calling, Truecaller or Google's assistant asking who is calling and why, or any recorded voice that answers for them), it is not a wrong number and not the person. " +
  "Say once, in one short sentence in English, your name, who you are calling from and why, then ask for the person by name, such as \"Hi, this is <your name> from the <project> team, calling <their name> about homes in <place>. Could you please put me through?\" " +
  "Then say nothing more and wait. When the person comes on, greet them by name and start the call the usual way. If the assistant says they are not available, asks you to leave a message, or nobody but the assistant speaks for about fifteen seconds, say one short goodbye and call end_interaction. " +
  "Never ask the assistant questions or answer it as if it were the person, and never record such a call as a wrong number, wrong person or not interested: record it as no answer (voicemail).";

/**
 * Whether a call that "connected" reached only the phone's call screener.
 * Strong phrases only: a person saying "kaun bol raha hai" is a person.
 */
const SCREENER_LINE =
  /see if (this|the) person is available|record your name|(state|say) your name and (the )?reason|reason for (your |the )?call(ing)?.{0,40}(name|record)|(name|record).{0,40}reason for (your |the )?call(ing)?|call screening|screening (service|this call)|digital assistant|truecaller assistant|google assistant|is using a screening|i('| a)m (an? )?(ai|automated|virtual) (call )?assistant|(this|the) person is (not|un)available|leave (a|your) message (after|at) the (tone|beep)/i;

export function screenerAnswered(
  turns: readonly { role: string; text: string }[],
  outcome: string | null,
): boolean {
  const said = turns.filter((t) => t.role === "user" && t.text.trim());
  if (!said.some((t) => SCREENER_LINE.test(t.text))) return false;
  // The person came on after the screener and the call was really had.
  if (["WRONG_NUMBER", "HUNG_UP", "BAD_LINE", "NO_ANSWER"].includes(outcome ?? "")) return true;
  return said.every((t) => SCREENER_LINE.test(t.text) || t.text.trim().split(/\s+/).length <= 2);
}

/** The reason a screened call carries, which `outcomeOf()` reads. */
export const SCREENER_REASON = "Call screener answered (iPhone or a call assistant), not the person";

/**
 * A call that connected and in which the other side said nothing the agent
 * heard. On 28 October 2026 an iPhone screener spoke over the agent's
 * greeting, the agent heard none of it, and the call was rated a cold lead.
 * Nobody was reached, so it is tried again like a call nobody picked up, and
 * the recording is heard afterwards (`hearSilentCalls()`), which names a
 * screener where there was one.
 */
export const NO_REPLY_REASON = "Picked up, but the agent heard nobody speak";
/** The same call once its recording was heard and held no screener. */
export const NO_REPLY_HEARD = "Picked up, nobody spoke (recording checked)";

/** Whether the other side said anything at all on a connected call. */
export function nobodySpoke(turns: readonly { role: string; text: string }[]): boolean {
  // A result with no transcript at all says nothing either way.
  if (!turns.some((t) => t.role === "agent" && t.text.trim())) return false;
  return !turns.some((t) => t.role === "user" && /[\p{L}\p{N}]/u.test(t.text));
}

/**
 * What the recording of a call nobody spoke on says: a screener, or nothing.
 * `heard` is the whole recording as transcribed, the agent's own lines in it;
 * they are taken out first, so what is left is the other side.
 */
export function heardOnSilentCall(heard: string, agentLines: readonly string[]): { screener: boolean; other: string } {
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  let other = ` ${plain(heard)} `;
  for (const line of agentLines) {
    const p = plain(line);
    if (p) other = other.split(` ${p} `).join(" ");
  }
  other = other.replace(/\s+/g, " ").trim();
  return { screener: SCREENER_LINE.test(other), other };
}

export type ProjectFactsInput = {
  developer: string;
  project: string;
  tower: string | null;
  city: string | null;
  /** The signed "Exact location, as advertised". */
  location: string | null;
  /** The site's address for visits, as the visits screen holds it. */
  siteAddress: string | null;
  /** Approved configurations, with the starting price `priceFor()` gives, cheapest first. */
  units: FactHome[];
  bookingAmount: number | null;
  paymentPlan: string | null;
  /** The marketed possession date as signed, 2029-06-30. Never the filing's completion date. */
  possession: string | null;
  registrationNo: string | null;
  /** Approved talking points, in the order they were signed. */
  points: readonly string[];
  /** Approved amenities (`claims.amenities`), each a few words. */
  amenities?: readonly string[];
  /**
   * The project's other towers a buyer may be told about: only ones the RERA
   * gate clears today, each with its approved configurations. So "is there a
   * 3 BHK?" on a tower of 1 and 2 BHKs is answered with the tower that has
   * one, never with "this project has none".
   */
  otherTowers?: readonly { name: string; units: FactHome[] }[];
  /**
   * The developer's other projects, for a buyer this one does not suit (10
   * October 2026): each with its location and cheapest home of each size.
   */
  otherProjects?: readonly { name: string; location: string | null; units: FactHome[] }[];
  /** The banks the project is approved with, as signed, and the signed loan rate. */
  loanBanks?: readonly string[];
  loanRate?: number | null;
  /** The rate and index tables and today's date; the shipped ones when absent. The checks pass their own. */
  money?: { market?: LoanMarket; growth?: readonly CityGrowth[]; today?: string };
  neverSay: readonly string[];
};

/** Rs 1.15 crore, Rs 76.4 lakh, Rs 1,00,000: an advertisement's price, the way it is said. */
export function spokenRupees(rupees: number): string {
  const printed = adPrice(rupees);
  if (!printed) return "";
  return printed.replace("\u20b9", "Rs ").replace(/ Cr$/, " crore").replace(/ Lakh$/, " lakh");
}

/**
 * A booking amount as it was signed, never rounded: Rs 5 lakh, Rs 1.25 lakh,
 * Rs 75,000. Rounding is for a "from" price; this one is quoted as typed.
 */
export function exactRupees(rupees: number): string {
  const r = Math.round(rupees);
  if (!Number.isFinite(r) || r <= 0) return "";
  const trim = (x: string) => x.replace(/\.?0+$/, "");
  if (r >= 1e7 && r % 1e5 === 0) return `Rs ${trim((r / 1e7).toFixed(2))} crore`;
  if (r >= 1e5 && r % 1e3 === 0) return `Rs ${trim((r / 1e5).toFixed(2))} lakh`;
  return `Rs ${r.toLocaleString("en-IN")}`;
}

/** 2029-06-30 as a buyer is told it: June 2029. */
function possessionMonth(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * What the agent may say about the tower a call is about, as plain lines it
 * answers from. Every value is signed: the Brain's published facts and the
 * approved configurations, plus the site address the visits screen keeps.
 * Nothing is written by a model, and a fact nobody signed is simply absent,
 * which the prompt turns into "the sales team will tell you".
 *
 * Prices are the starting prices an advertisement prints, rounded up, so
 * "from" is never below the cheapest flat. The possession date is the
 * marketed one, never the filing's completion date.
 */
export function projectFacts(o: ProjectFactsInput): string {
  const place = o.tower ? `${o.project}, ${o.tower}` : o.project;
  const located = o.location?.trim() || null;
  const where = located
    ? o.city && !fold(located).includes(fold(o.city))
      ? `${located}, ${o.city}`
      : located
    : o.city;
  const homes = homeLines(o.units);
  const amenities = [...new Set((o.amenities ?? []).map((a) => a.trim()).filter(Boolean))].slice(0, AMENITIES_MAX);
  const possession = o.possession ? possessionMonth(o.possession) : null;
  const head = [
    `Project: ${place}, by ${o.developer}.`,
    where ? `Location: ${where}.` : null,
    o.siteAddress?.trim() ? `Site address for visits: ${o.siteAddress.trim()}.` : null,
    homes.length ? `Homes: ${homes.join("; ")}.` : null,
    o.bookingAmount && o.bookingAmount > 0 ? `Booking amount: ${exactRupees(o.bookingAmount)}.` : null,
    o.paymentPlan?.trim() ? `Payment plan: ${o.paymentPlan.trim()}.` : null,
    possession ? `Possession: ${possession}.` : null,
    o.registrationNo?.trim() ? `RERA registration: ${o.registrationNo.trim()}.` : null,
    amenities.length ? `Amenities: ${amenities.join(", ")}.` : null,
  ].filter((l): l is string => !!l);
  const banned = o.neverSay.map((l) => l.trim()).filter(Boolean).slice(0, NEVER_SAY_MAX);
  const tail = [...(banned.length ? [`Never say: ${banned.join("; ")}.`] : []), FACTS_RULE];

  const lines = [...head];
  const room = () => PROJECT_FACTS_MAX - [...lines, ...tail].join("\n").length;
  const points = o.points.map((p) => p.trim()).filter(Boolean);
  if (points.length && room() > 40) {
    lines.push("Highlights:");
    let kept = 0;
    for (const p of points) {
      if (`\n- ${p}`.length > room()) continue;
      lines.push(`- ${p}`);
      kept++;
    }
    if (!kept) lines.pop();
  }
  const others = (o.otherTowers ?? [])
    .map((t) => ({ name: t.name.trim(), homes: homeLines(t.units) }))
    .filter((t) => t.name && t.homes.length)
    .slice(0, OTHER_TOWERS_MAX);
  // Home loans and the city's price history: code builds every number from
  // the signed prices and a dated table of published rates and indices.
  const money = [
    ...loanLines({ banks: o.loanBanks ?? [], signedRate: o.loanRate ?? null, homes: o.units, market: o.money?.market, today: o.money?.today }),
    ...[growthLine(o.city ?? null, o.money?.growth)].filter((l): l is string => !!l),
  ];
  if (money.length && room() > 80) {
    lines.push("Home loans and price history:");
    let kept = 0;
    for (const m of money) {
      if (`\n- ${m}`.length > room()) continue;
      lines.push(`- ${m}`);
      kept++;
    }
    if (!kept) lines.pop();
  }
  if (others.length && room() > 60) {
    lines.push(o.tower ? `Other towers in ${o.project}, for a buyer who wants what ${o.tower} does not have:` : `Towers in ${o.project}:`);
    let kept = 0;
    for (const t of others) {
      const line = `- ${t.name}: ${t.homes.join("; ")}`;
      if (`\n${line}`.length > room()) continue;
      lines.push(line);
      kept++;
    }
    if (!kept) lines.pop();
  }
  const projects = (o.otherProjects ?? [])
    .map((p) => ({ name: p.name.trim(), where: p.location?.trim() || null, homes: homeLines(p.units) }))
    .filter((p) => p.name && p.homes.length);
  if (projects.length && room() > 60) {
    lines.push(`Other projects by ${o.developer}, for a buyer this one does not suit:`);
    let kept = 0;
    for (const p of projects) {
      const line = `- ${p.name}${p.where ? ` (${p.where})` : ""}: ${p.homes.join("; ")}`;
      if (`\n${line}`.length > room()) continue;
      lines.push(line);
      kept++;
    }
    if (!kept) lines.pop();
  }
  return [...lines, ...tail].join("\n").slice(0, PROJECT_FACTS_MAX);
}

/**
 * What the receptionist may say when the number rung covers several towers
 * and the caller is nobody we know: each tower the RERA gate clears, with its
 * place and its homes, and the instruction to ask which one before saying
 * anything about a price. Prices never cross from one project to another.
 */
export function portfolioFacts(o: {
  seller: string;
  towers: readonly { project: string; tower: string | null; location: string | null; units: FactHome[] }[];
  neverSay: readonly string[];
}): string {
  const head = [
    `${o.seller} sells the projects below. The caller has not said which one they are calling about: ask which project, then answer only from that project's line. Never give one project's price for another.`,
  ];
  const banned = o.neverSay.map((l) => l.trim()).filter(Boolean).slice(0, NEVER_SAY_MAX);
  const tail = [...(banned.length ? [`Never say: ${banned.join("; ")}.`] : []), FACTS_RULE];
  const lines = [...head];
  const room = () => PROJECT_FACTS_MAX - [...lines, ...tail].join("\n").length;
  for (const t of o.towers) {
    const homes = homeLines(t.units);
    const name = t.tower ? `${t.project} ${t.tower}` : t.project;
    const line = `- ${name}${t.location?.trim() ? ` (${t.location.trim()})` : ""}${homes.length ? `: ${homes.join("; ")}` : ""}`;
    if (`\n${line}`.length > room()) continue;
    lines.push(line);
  }
  return [...lines, ...tail].join("\n").slice(0, PROJECT_FACTS_MAX);
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0 to 999 in English words: 45 is "forty five". */
function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
}

/**
 * A starting price in words, so the agent says exactly what is printed: Rs
 * 1.45 crore is "one crore forty five lakh", Rs 76.4 lakh "seventy six lakh
 * forty thousand". Live calls rounded 1.45 crore to "one crore fifty lakh"
 * and read 2.19 crore as "two crore twenty nine lakh" from the figure alone.
 */
export function rupeeWords(rupees: number): string {
  const printed = adPrice(rupees);
  if (!printed) return "";
  const m = /([\d.]+)\s*(Cr|Lakh)$/.exec(printed);
  if (!m) return "";
  const value = Number(m[1]);
  const whole = Math.floor(value);
  const part = Math.round((value - whole) * 100);
  if (whole > 999) return "";
  if (m[2] === "Cr") return `${numberWords(whole)} crore${part ? ` ${numberWords(part)} lakh` : ""}`;
  return `${numberWords(whole)} lakh${part ? ` ${numberWords(part)} thousand` : ""}`;
}

/** Configurations as the agent says them: "2 BHK, 682 sq ft carpet, from Rs 2.19 crore (two crore nineteen lakh)". */
function homeLines(units: readonly FactHome[]): string[] {
  return units
    .filter((u) => u.label.trim())
    .slice(0, FACT_UNITS_MAX)
    .map((u) => {
      const area = Number.isFinite(u.carpetSqft) && u.carpetSqft > 0 ? `, ${Math.round(u.carpetSqft).toLocaleString("en-IN")} sq ft carpet` : "";
      const words = u.price && u.price > 0 ? rupeeWords(u.price) : "";
      const price = u.price && u.price > 0 ? `, from ${spokenRupees(u.price)}${words ? ` (${words})` : ""}` : "";
      return `${u.label.trim()}${area}${price}`;
    });
}

// ---------------------------------------------------------------------------
// The other jobs' agents
// ---------------------------------------------------------------------------

/**
 * What a job's own agent is told besides what every call carries. Each agent
 * is a copy of the qualifier (the same voice, pacing and hand-off) with its
 * role written into the prompt. A visit's day and time, what the buyer said
 * last time and who showed them round are about the buyer; what it may say
 * about the building is the tower's signed facts, which every call carries.
 *
 * What the buyer already told us (budget, configuration) is passed so the
 * agent confirms it rather than asking again. The qualifier is not given it:
 * its first call has nothing to pass, and it is the agent nobody edits.
 */
export type RoleContext =
  | {
      job: "confirm";
      /** Confirm a visit still on, or rebook one the buyer missed. */
      reason: "confirm" | "rebook";
      /** The visit as the agent says it: "Saturday 3 October 2026, 4:30 pm". */
      visitAt: string;
      today: string;
    }
  | {
      job: "reengage";
      /** A warm lead called back two days on, a date a person set, or a follow-up after the site visit. */
      reason: "warm" | "follow_up" | "after_visit";
      today: string;
      lastCallOn: string | null;
      lastSummary: string | null;
      budget: string | null;
      config: string | null;
    }
  | {
      job: "post_visit";
      today: string;
      visitOn: string;
      /** Who showed them round, by first name. */
      host: string | null;
      budget: string | null;
      config: string | null;
    };

/** The longest note from the last call an agent is handed. */
export const LAST_SUMMARY_MAX = 280;

/**
 * The last call's summary as the next agent is handed it: one line, short,
 * and with any phone number in it struck out, because the agent reads it
 * aloud as its own memory and a number is nothing it should say.
 */
export function lastSummaryLine(summary: string | null): string {
  if (!summary) return "";
  const line = redactPhones(summary.replace(/\s+/g, " ").trim(), "MASKED");
  return line.length > LAST_SUMMARY_MAX ? `${line.slice(0, LAST_SUMMARY_MAX - 1).trimEnd()}…` : line;
}

export function roleVariables(r: RoleContext): Record<string, string> {
  switch (r.job) {
    case "confirm":
      return { call_reason: r.reason, visit_time: r.visitAt, today_date: r.today };
    case "reengage":
      return {
        followup_reason: r.reason,
        today_date: r.today,
        last_call_date: r.lastCallOn ?? "",
        last_call_summary: lastSummaryLine(r.lastSummary),
        enquiry_budget: r.budget ?? "",
        enquiry_bhk: r.config ?? "",
      };
    case "post_visit":
      return {
        today_date: r.today,
        visit_date: r.visitOn,
        visit_host: r.host?.split(/\s+/)[0] ?? "",
        enquiry_budget: r.budget ?? "",
        enquiry_bhk: r.config ?? "",
      };
  }
}

// ---------------------------------------------------------------------------
// A free host, asked for on the call
// ---------------------------------------------------------------------------

/**
 * What the agent's `check_visit_slot` tool hears back when a buyer names a
 * visit time: that the hour has a free host, or that it is full and which
 * nearby hours are free. Written as plain facts, so it reads right whether
 * the agent repeats it or works from it, in whatever language the call is
 * in. The seat is taken when the call ends and the visit is booked; this
 * only stops the agent agreeing to an hour that is already full.
 */
export type SlotAnswer =
  | { kind: "free"; asked: string }
  | { kind: "full"; asked: string; offers: string[] }
  | { kind: "unclear" };

export function slotReply(a: SlotAnswer): { free: boolean; say: string } {
  if (a.kind === "unclear") {
    return {
      free: false,
      say: "That is not a time a visit can start. Visits start on the hour or the half hour, between 10 AM and 6:30 PM, today or later.",
    };
  }
  if (a.kind === "free") return { free: true, say: `${a.asked} is free.` };
  if (!a.offers.length) {
    return { free: false, say: `${a.asked} is fully booked, and nothing is free in the week after it. The team will call back with a time.` };
  }
  const list = a.offers.length === 1 ? a.offers[0] : `${a.offers.slice(0, -1).join(", ")} or ${a.offers.at(-1)}`;
  return { free: false, say: `${a.asked} is fully booked. Free times nearby: ${list}.` };
}

/** "Saturday 3 October, 4:30 pm" for an instant, in IST: a visit time as the agent says it. */
export function slotLabel(iso: string): string {
  return visitMoment(iso).replace(/ \d{4},/, ",");
}

/** "Saturday 3 October 2026, 4:30 pm" for an instant, in IST. */
export function visitMoment(iso: string): string {
  const ist = new Date(Date.parse(iso) + 330 * 60_000).toISOString();
  const [h, m] = [Number(ist.slice(11, 13)), ist.slice(14, 16)];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${longDay(ist.slice(0, 10))}, ${h12}:${m} ${h >= 12 ? "pm" : "am"}`;
}

// ---------------------------------------------------------------------------
// A call with a goal
// ---------------------------------------------------------------------------

/**
 * A person can send the agent to do one thing: invite the buyer for a site
 * visit, ask how a visit went, or whatever they write. The goal travels with
 * the call as a variable (`call_goal`) to a second agent, a copy of the
 * qualifier that reads it, so the qualifier itself is never edited and no
 * agent is ever created or changed per call.
 *
 * The goal is an instruction, not a fact: what the agent may say about the
 * building comes from the tower's signed facts and nowhere else. So a goal
 * may name a day and a time and nothing else with a number in it: a price,
 * an offer, a size or a possession date written into a goal would be the
 * agent making a claim nobody signed.
 */
export type GoalKey = "site_visit" | "after_visit" | "custom";

export const GOAL_KEYS: GoalKey[] = ["site_visit", "after_visit", "custom"];

export type CallGoal = { key: GoalKey; text: string };

/** The longest goal a person may write. */
export const GOAL_MAX = 240;

/** The goals offered by name, beside the person's own words. */
export const CALL_GOALS: { key: Exclude<GoalKey, "custom">; label: string }[] = [
  { key: "site_visit", label: "Invite them for a site visit" },
  { key: "after_visit", label: "Ask how their site visit went" },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** 2026-09-28 as the agent is told it: "Monday 28 September 2026". */
export function longDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[dow]} ${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/**
 * The instruction for a goal picked by name. English, because the agent says
 * it in the call's language, and about "the buyer", because the agent already
 * has their name.
 */
export function goalText(o: { key: "site_visit"; day: string | null } | { key: "after_visit" }): string {
  if (o.key === "after_visit") {
    return "The buyer has visited the site. Ask how the visit went, what they liked and what is holding them back, and offer to put them through to the sales team.";
  }
  // An end state, never an opening act: the agent finds out what the buyer
  // wants before the visit is proposed. The site's hours travel with the call.
  return o.day
    ? `By the end of the call: a site visit agreed on ${longDay(o.day)} at a time inside the site's visiting hours, or on another day if that one does not suit`
    : "By the end of the call: a site visit agreed, on a day and at a time inside the site's visiting hours";
}

const MONEY = /₹|\brs\.?\s*\d|\binr\b|\brupees?\b|\blakhs?\b|\blacs?\b|\bcrores?\b|\d\s*cr\b|%|\bper\s*cent\b|\bpercent\b/i;
const OFFER =
  /\bdiscount|\bcash\s*back|\bwaive|\bfreebie|\bgifts?\b|\bemi\b|\bsubvention|\bno\s+floor\s+rise|\bstamp\s+duty|\bfree\s+(parking|club|membership|gst|stamp|registration|modular|kitchen|car|gold|ac|furniture)/i;
const CONTACT = /@|https?:|www\.|\d[\d\s-]{7,}\d/i;
const SENSITIVE = /\baadhaa?r\b|\bpan\s*(card|number|no)?\b|\botp\b|\bbank\b|\baccount\s+(number|no)\b|\bcvv\b|\bpassword\b|\bcard\s+(number|details)\b/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
/** Numbers a goal may carry: a time, a date, a configuration. */
const ALLOWED_NUMBERS = [
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|baje|bje)\b/gi,
  /\b\d{1,2}:\d{2}\b/g,
  // A date may carry its year: the site visit goal this file writes says
  // "Friday 2 October 2026", and was refused by this very check at Call now.
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+(?:19|20)\\d{2})?\\b`, "gi"),
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:19|20)\\d{2})?\\b`, "gi"),
  /\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g,
  /\b\d{1,2}(?:st|nd|rd|th)\b/gi,
  /\b\d(?:\.5)?\s*bhk\b/gi,
];

/** Devanagari and other Indic digits read as 0 to 9, so a number cannot hide in a script. */
function asciiDigits(s: string): string {
  return s.replace(/[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g, (c) =>
    String((c.codePointAt(0)! - 0x0966) % 16),
  );
}

/**
 * Why a goal a person wrote cannot be sent, or null. The agent is told the
 * goal never overrides its rules; this is the half that does not depend on
 * it listening.
 */
/** An amount said with its unit or its sign, and the word that leads into it. */
const PRICE_PHRASE =
  /(?:\s*\b(?:for|at|@|around|about|approx(?:imately)?|just|only|of)\s+)?(?:(?:₹|\brs\.?|\binr)\s*\d[\d,.]*(?:\s*(?:lakhs?|lacs?|crores?|cr|k)\b)?|\b\d[\d,.]*\s*(?:lakhs?|lacs?|crores?|cr)\b)(?:\s*(?:only|rupees))?/gi;

/**
 * The same goal with its price taken out, when that is all that was wrong
 * with it: "offer him Tower C for 50 lakhs and ask about a visit tomorrow"
 * becomes "offer him Tower C and ask about a visit tomorrow", offered on the
 * card as one press. A price on a call is only ever the tower's approved one,
 * which the agent already has. Null when nothing is left, or the rest still
 * fails.
 */
export function withoutPrice(raw: string, neverSay: readonly string[] = []): string | null {
  const cut = asciiDigits(raw).replace(PRICE_PHRASE, "").replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
  if (!cut || cut === raw.trim() || cut.split(/\s+/).length < 3) return null;
  // "tell him the 2 BHK is" lost what it was saying, not a detail.
  if (/\b(?:is|are|was|be|at|for|of|costs?|priced|price|rate|from|starting|starts)[\s,.]*$/i.test(cut)) return null;
  return goalProblem(cut, neverSay) ? null : cut;
}

export function goalProblem(raw: string, neverSay: readonly string[] = []): string | null {
  const text = raw.trim();
  if (!text) return "Say what the call should do.";
  if (text.length > GOAL_MAX) return `Keep it under ${GOAL_MAX} letters.`;
  const s = asciiDigits(text);
  if (CONTACT.test(s)) return "Leave phone numbers, emails and links out of the goal.";
  if (SENSITIVE.test(s)) return "The agent never asks for ID, bank details or an OTP.";
  if (MONEY.test(s) || OFFER.test(s)) {
    return "A goal can't carry a price or an offer. The agent already has the tower's approved prices and says only those.";
  }
  const rest = ALLOWED_NUMBERS.reduce((acc, re) => acc.replace(re, " "), s);
  if (/\d/.test(rest)) {
    return "A goal can carry a day and a time, but no other numbers. The agent puts questions about size, floors or possession through to your sales team.";
  }
  const lower = s.toLowerCase();
  const banned = neverSay.find((p) => p.trim() && lower.includes(p.trim().toLowerCase()));
  if (banned) return `That goal uses a phrase this project never says: "${banned.trim()}".`;
  if (isScript(s)) return "A goal says what the call should end with, in one sentence. The agent decides what to say first.";
  return null;
}

/**
 * A goal written as a script of what to say first ("Ask for Praful; say you
 * are calling about...; ask if...; if interested...") makes the agent open
 * with the step and skip finding out what the person wants. A goal is an end
 * state; a chain of steps, or an opening act, is refused.
 */
export function isScript(goal: string): boolean {
  const t = goal.trim();
  if (/^(say (you are|that you)|tell them you are calling|ask for [A-Z]|greet|introduce yourself|start by|first,? )/i.test(t)) return true;
  const steps = t.split(/;|\bthen\b|\. /i).map((x) => x.trim()).filter(Boolean);
  return steps.length > 2;
}

// ---------------------------------------------------------------------------
// The webhook: who sent it, and what it says
// ---------------------------------------------------------------------------

/**
 * A token binding one webhook address to one call in one organisation.
 *
 * Sarvam signs nothing, so the address carries its own proof: an HMAC of the
 * org and the call under a key only this server holds. A request naming any
 * other call, or another tenant's, fails the check before a row is read.
 */
export function callToken(secret: string, orgId: string, callId: string): string {
  return createHmac("sha256", secret).update(`call:${orgId}:${callId}`).digest("hex");
}

export function verifyCallToken(secret: string, orgId: string, callId: string, token: string): boolean {
  const want = Buffer.from(callToken(secret, orgId, callId), "hex");
  const got = Buffer.from(token, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export type WebhookResult = {
  connectivity: "connected" | "no_answer" | "busy" | "failed";
  outcome: Outcome;
  durationS: number | null;
  interactionId: string | null;
  failureReason: string | null;
  finalVariables: Record<string, unknown> | null;
  transcript: Turn[];
  optedOut: boolean;
};

const CONNECTIVITY = new Set(["connected", "no_answer", "busy", "failed"]);

/**
 * Sarvam's instant-outbound payload, read defensively: anything odd is a
 * failure, not a crash. `agent` is the job the call was placed for, because
 * the visit confirmer records what happened to the visit first.
 */
export function readWebhook(body: unknown, agent: AgentKind = "qualifier"): WebhookResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const known = typeof b.status === "string" && CONNECTIVITY.has(b.status);
  const status = known ? (b.status as WebhookResult["connectivity"]) : "failed";
  // A status we do not know is the calling service's problem, not the
  // buyer's: it is said so in the reason, which `isSystemFailure()` reads.
  const unknownReason = known ? null : `${UNKNOWN_STATUS_REASON} (${typeof b.status === "string" ? b.status.slice(0, 40) : "none"})`;
  const vars =
    b.final_agent_variables && typeof b.final_agent_variables === "object"
      ? (b.final_agent_variables as Record<string, unknown>)
      : null;
  const turns = Array.isArray(b.interaction_transcript) ? b.interaction_transcript : [];
  const transcript: Turn[] = turns
    .filter((t): t is { role: string; en_text: string } => !!t && typeof (t as { en_text?: unknown }).en_text === "string")
    .map((t) => ({ role: t.role === "agent" ? "agent" : "user", en: t.en_text, indic: null }));
  const optedOut = vars?.opt_out === true || vars?.opt_out === "true" || vars?.lead_disposition === "dnc";
  const read = {
    connectivity: status,
    outcome: outcomeOf({
      agent,
      connectivity: status,
      vars,
      transferred: vars?.outcome === "HANDED_OFF" || vars?.lead_disposition === "handed_off",
      turns: transcript.map((t) => ({ role: t.role, text: t.role === "event" ? "" : t.en })),
      failureReason: typeof b.failure_reason === "string" ? b.failure_reason : null,
    }),
    durationS: typeof b.duration === "number" ? b.duration : null,
    interactionId: typeof b.interaction_id === "string" ? b.interaction_id : null,
    failureReason: unknownReason ?? (typeof b.failure_reason === "string" ? b.failure_reason : null),
    finalVariables: vars,
    transcript,
    optedOut,
  };
  // A phone's call screener answered and the person never came on: nobody
  // was reached, so the call is a no answer and is tried again.
  if (
    agent !== "receptionist" &&
    read.connectivity === "connected" &&
    !optedOut &&
    screenerAnswered(transcript.map((t) => ({ role: t.role, text: t.en })), read.outcome)
  ) {
    return { ...read, connectivity: "no_answer", outcome: "SCREENED", failureReason: SCREENER_REASON };
  }
  // Picked up, and the agent heard nobody: nobody was reached.
  // Never on a call the buyer made: they rang us, so somebody was there.
  if (agent !== "receptionist" && read.connectivity === "connected" && !optedOut && read.outcome !== "HANDED_OFF" && nobodySpoke(transcript.map((t) => ({ role: t.role, text: t.en })))) {
    return { ...read, connectivity: "no_answer", outcome: "NO_REPLY", failureReason: NO_REPLY_REASON };
  }
  return read;
}

// ---------------------------------------------------------------------------
// A call that failed on our side, not the buyer's
// ---------------------------------------------------------------------------

/** What `closeSilentCalls()` writes on a call no result ever came back for. */
export const SILENT_CALL_REASON = "No result came back from the calling service.";

/** The start of the reason `readWebhook()` writes for a status it does not know. */
export const UNKNOWN_STATUS_REASON = "The calling service sent a status we do not know";

/**
 * Words a carrier uses when the buyer's phone is the reason: switched off,
 * out of coverage, a number that does not exist, busy, declined, the DND
 * register. A failure that names one of these is the buyer's, and counts as
 * a dial like any unanswered call.
 */
const BUYER_SIDE =
  /unreachable|not reachable|switched off|switch off|out of (coverage|service|range)|not in service|invalid (number|destination)|invalid_number|unallocated|no route|does not exist|user.?busy|\bbusy\b|reject|declin|no.?answer|not answered|subscriber|absent|\bdnd\b|ncpr|do not disturb|\b(404|480|486|487|603|604)\b/i;

/**
 * What the carrier's hang-up cause says about a call Sarvam reported only as
 * "failed". On 27 October 2026 every such Harbour View call was, by Vobiz's own
 * record, a phone that rang 50 to 60 seconds unanswered (NO_USER_RESPONSE),
 * and reading them as our failure redialled two buyers five times in an
 * afternoon. Null when the cause is not the buyer's phone, so the call stays
 * our failure.
 */
export function carrierOutcome(
  cause: string | null | undefined,
  ringSeconds: number | null = null,
): { connectivity: "no_answer" | "busy" | "failed"; reason: string } | null {
  const c = (cause ?? "").trim().toUpperCase();
  if (!c) return null;
  const rang = ringSeconds !== null && ringSeconds >= 0 ? ` after ${Math.round(ringSeconds)} s` : "";
  // Vobiz names NO_USER_RESPONSE "Rejected", but it is the 50 to 60 second
  // ring running out: nobody picked up.
  if (["NO_USER_RESPONSE", "NO_ANSWER", "ORIGINATOR_CANCEL", "RECOVERY_ON_TIMER_EXPIRE", "ALLOTTED_TIMEOUT"].includes(c)) {
    return { connectivity: "no_answer", reason: `Rang${rang}, nobody picked up (carrier: ${c})` };
  }
  // A busy line answers at once; USER_BUSY after seconds of ringing is the
  // person cutting the call (27 October 2026: 20 to 35 s, every time).
  if (c === "CALL_REJECTED" || (c === "USER_BUSY" && ringSeconds !== null && ringSeconds >= DECLINE_AFTER_S)) {
    return { connectivity: "busy", reason: `Declined${rang} of ringing (carrier: ${c})` };
  }
  if (c === "USER_BUSY") return { connectivity: "busy", reason: `Line busy (carrier: ${c})` };
  if (["UNALLOCATED_NUMBER", "INVALID_NUMBER_FORMAT", "NO_ROUTE_DESTINATION", "NUMBER_CHANGED"].includes(c)) {
    return { connectivity: "failed", reason: `Number not in service (carrier: ${c})` };
  }
  if (["SUBSCRIBER_ABSENT", "MOBILE_NOT_REACHABLE"].includes(c)) return { connectivity: "failed", reason: `Switched off or out of coverage (carrier: ${c})` };
  return null;
}

/** Seconds of ringing after which the carrier's USER_BUSY is a person cutting the call, not a busy line. */
export const DECLINE_AFTER_S = 8;

/**
 * Who ended a connected call, from the carrier's hang-up source. On a call
 * we placed the caller leg is ours, the callee the buyer; on a call the
 * buyer made it is the other way round. "Answer XML" is our own
 * instructions ending the call (the agent said goodbye). Null for anything
 * else, which is never read as the network.
 */
export function hungUpBy(source: string | null | undefined, direction: "OUT" | "IN" = "OUT"): "BUYER" | "AGENT" | "NETWORK" | null {
  const s = (source ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "answer xml" || s === "app" || s === "api") return "AGENT";
  if (s === "caller") return direction === "OUT" ? "AGENT" : "BUYER";
  if (s === "callee") return direction === "OUT" ? "BUYER" : "AGENT";
  if (s === "carrier" || s === "network") return "NETWORK";
  return null;
}

/**
 * The carrier's record of one of our calls: same numbers, started from a
 * minute before we placed it to three after, the nearest first.
 */
export function carrierRecordOf<T extends { from: string | null; to: string | null; startedIso: string | null }>(
  records: readonly T[],
  call: { from: string; to: string; placedIso: string },
): T | null {
  const digits = (s: string | null) => (s ?? "").replace(/\D/g, "").slice(-10);
  const placed = Date.parse(call.placedIso);
  let best: T | null = null;
  let gap = Infinity;
  for (const r of records) {
    if (!r.startedIso || digits(r.to) !== digits(call.to) || digits(r.from) !== digits(call.from)) continue;
    const d = Date.parse(r.startedIso) - placed;
    if (d < -60_000 || d > 180_000) continue;
    if (Math.abs(d) < gap) [best, gap] = [r, Math.abs(d)];
  }
  return best;
}

/**
 * Whether a call that did not connect failed on our side or the calling
 * service's: no result ever came back, a status we do not know, or Sarvam's
 * own "failed" with no carrier cause naming the buyer's phone. Such a call is
 * not the buyer not answering, so it never uses one of the buyer's dials,
 * never counts toward `MAX_AUTO_CALLS`, and never closes a lead.
 */
export function isSystemFailure(connectivity: string | null | undefined, failureReason: string | null | undefined): boolean {
  if (connectivity !== "failed") return false;
  const reason = (failureReason ?? "").trim();
  if (reason.startsWith(SILENT_CALL_REASON) || reason.startsWith(UNKNOWN_STATUS_REASON)) return true;
  return !BUYER_SIDE.test(reason);
}

// ---------------------------------------------------------------------------
// A calling number buyers have stopped picking up
// ---------------------------------------------------------------------------

/** Calls a number must have placed in the last week before its pickup rate is judged. */
export const PICKUP_MIN_CALLS = 50;
/** How far the pickup rate must fall against the four weeks before for a number to be named. */
export const PICKUP_DROP = 0.4;

export type PickupCounts = { dialled: number; picked: number };

/**
 * Whether buyers have stopped picking up a calling number: the last seven
 * days' pickup rate against the four weeks before, on at least
 * `PICKUP_MIN_CALLS` calls in each, fallen by `PICKUP_DROP` or more. The
 * usual cause is the number being labelled spam on buyers' phones.
 */
export function pickupFell(recent: PickupCounts, before: PickupCounts): { recentRate: number; beforeRate: number } | null {
  if (recent.dialled < PICKUP_MIN_CALLS || before.dialled < PICKUP_MIN_CALLS) return null;
  const recentRate = recent.picked / recent.dialled;
  const beforeRate = before.picked / before.dialled;
  if (beforeRate <= 0) return null;
  return recentRate <= beforeRate * (1 - PICKUP_DROP) ? { recentRate, beforeRate } : null;
}

// ---------------------------------------------------------------------------
// From what the agent extracted to what the call log shows
// ---------------------------------------------------------------------------

/** A value the agent filled in. Its "nothing was said" markers read as nothing. */
const str = (v: unknown) => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && !/^(not_specified|not_booked|not_offered|none|null)$/i.test(s) ? s : null;
};

const LABELS: Record<string, string> = {
  within_3_months: "Within 3 months",
  "3_to_6_months": "3 to 6 months",
  "6_plus_months": "After 6 months",
};
const label = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  return LABELS[s] ?? s.replace(/^(\d)\s*BHK$/i, "$1 BHK").replace(/(\d)\s*-\s*(\d)/g, "$1 to $2").replace(/_/g, " ");
};

/** The fields the qualifier records, in plain words. A field never spoken to is null. */
export function factsFromVariables(vars: Record<string, unknown> | null): Fact[] {
  const v = vars ?? {};
  const visit = v.site_visit_status === "booked" ? (str(v.site_visit_time) ?? "Booked") : null;
  return [
    { label: "Budget", value: label(v.budget) },
    { label: "Looking for", value: label(v.bhk_preference) },
    { label: "Preferred area", value: str(v.location_preference) },
    { label: "Buying in", value: label(v.purchase_timeline) },
    { label: "Site visit", value: visit },
  ];
}

/** The qualifier's read on the lead, from the disposition it recorded. */
export function tempOf(vars: Record<string, unknown> | null): "HOT" | "WARM" | "COLD" | null {
  const d = vars?.lead_disposition;
  if (d === "hot_lead" || d === "handed_off") return "HOT";
  if (d === "warm_lead") return "WARM";
  if (d === "cold_lead") return "COLD";
  return null;
}
