/**
 * The partner's WhatsApp: what a message means, and what the bot says back.
 * Pure and database-free, covered by `check:logic`.
 *
 * Section 07: a firm's agents write romanised Hinglish fragments to the
 * developer's own number, and a model picks one action from a fixed schema.
 * The model never writes the reply and never sees a phone number: numbers
 * are taken out of the message before it is sent and put back after, and
 * every reply below is built from rows by code. The obvious messages (a
 * code, a yes, a number from a list, "payout status") never reach the model
 * at all.
 *
 * Replies are one short line where they can be, in Roman letters, in the
 * language the partner's person chose: Hinglish (the default), English or
 * Marathi (`LINES`, `say()`). Buyer numbers are always masked.
 */

import { maskPhone } from "./mask-rules.ts";
import { voiceFor, type Voice } from "./message-rules.ts";
import { rupees, rupeesShort, showDate, showTime } from "./lead-rules.ts";
import { daysBetween, type Verdict } from "./partner-rules.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** A visit slot is held this long while the partner says yes. */
export const HOLD_SECONDS = 90;
/** A pick from a list the bot sent stays open this long. */
export const CHOOSE_MINUTES = 10;
/** Messages the bot reads for one person, and for one firm, in an IST day. */
export const TURNS_PER_AGENT_DAY = 60;
export const TURNS_PER_FIRM_DAY = 300;
/**
 * Messages the model reads for one organisation in an IST day, whoever sent
 * them. The ceiling a user cannot raise by adding firms or people, and the
 * one that holds Launch's 60% floor (`doc/pricing.md`): 70 a day is about
 * 2,100 a month, Rs 140 at the estimate below. Past it the bot still does
 * everything it reads without the model.
 */
export const MODEL_READS_PER_ORG_DAY = 70;
/** Co-branded pictures in one send, and sends a person may ask for a day. */
export const CREATIVES_PER_SEND = 6;
export const CREATIVE_SENDS_PER_DAY = 3;
/** Bookings listed in one payout answer. */
export const PAYOUTS_LISTED = 5;

/** The model that reads a message. Priced in `doc/pricing.md`. */
export const BOT_MODEL = "gpt-5-mini";
/** gpt-5-mini, dollars per million tokens: in, out. */
const PRICE = { in: 0.25, out: 2 };
/** What the prompt and the answer come to, with the reasoning at minimal. */
const PROMPT_TOKENS = 900;
const ANSWER_TOKENS = 250;

/** What reading one message costs, for the turn's row. */
export function turnUsd(messageChars: number): number {
  const input = PROMPT_TOKENS + Math.ceil(messageChars / 3);
  return +((input * PRICE.in + ANSWER_TOKENS * PRICE.out) / 1e6).toFixed(6);
}

// ---------------------------------------------------------------------------
// Numbers stay out of the model
// ---------------------------------------------------------------------------

/**
 * An Indian mobile with or without its country code, spaces and dashes
 * allowed, or any number written with a plus. A time beside it ("kal 4
 * 9812345621") is not swallowed into it.
 */
const PHONE_RUN = /(?<!\d)(?:(?:\+91|91|0)[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)|\+\d{8,14}(?!\d)/g;

/** The message with every number that could be a phone swapped for `#1`, `#2`. */
export function hidePhones(text: string): { text: string; numbers: string[] } {
  const numbers: string[] = [];
  const out = text.replace(PHONE_RUN, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) return m;
    numbers.push(m.trim());
    return `#${numbers.length}`;
  });
  return { text: out, numbers };
}

/** The number a placeholder stood for, or the text itself when it was not one. */
export function phoneBack(raw: string | null, numbers: readonly string[]): string | null {
  if (!raw) return numbers.length === 1 ? numbers[0] : null;
  const m = /^#(\d+)$/.exec(raw.trim());
  if (m) return numbers[Number(m[1]) - 1] ?? null;
  return /\d{10}/.test(raw.replace(/\D/g, "")) ? raw : null;
}

// ---------------------------------------------------------------------------
// What a message asks for
// ---------------------------------------------------------------------------

export const ACTIONS = [
  "inventory",
  "register",
  "book_visit",
  "my_buyers",
  "payout_status",
  "creative",
  "attest_invoice",
  "unmask",
  "export",
  "not_here",
  "help",
  "unclear",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Never over WhatsApp: the web, and the firm's owner. */
export const NOT_HERE = ["payout_account", "access", "price", "approve_payout"] as const;
export type NotHere = (typeof NOT_HERE)[number];

export type Intent = {
  action: Action;
  /** A buyer's number as `#1`, or a name. */
  buyer: string | null;
  name: string | null;
  config: string | null;
  tower: string | null;
  project: string | null;
  when: string | null;
  occasion: string | null;
  what: NotHere | null;
};

export const EMPTY: Omit<Intent, "action"> = {
  buyer: null,
  name: null,
  config: null,
  tower: null,
  project: null,
  when: null,
  occasion: null,
  what: null,
};

const intent = (action: Action, rest: Partial<Intent> = {}): Intent => ({ action, ...EMPTY, ...rest });

/** A six-digit code, the way a person pastes one. */
export function codeIn(text: string): string | null {
  const d = text.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(d) ? d : null;
}

const words = (text: string) => text.trim().toLowerCase().replace(/[.!?,]+/g, " ").replace(/\s+/g, " ").trim();

export function isYes(text: string): boolean {
  return /^(haan|han|ha|haa|haan ji|hanji|ji haan|ji|yes|y|yeah|yup|ok|okay|k|confirm|confirmed|done|theek hai|thik hai|theek|thik|sure|kar do|kardo|book karo|book kar do|pakka|ho|hoy|ho kara|chalel|barobar)$/.test(words(text));
}

export function isNo(text: string): boolean {
  return /^(nahi|nahin|nai|na|no|n|cancel|mat karo|rehne do|chhodo|chodo|nako)$/.test(words(text));
}

export function isStart(text: string): boolean {
  return /^(start|unstop|resume|chalu|chalu karo|shuru)$/.test(words(text));
}

/** A number picked from a list of `n`. */
export function pickIn(text: string, n: number): number | null {
  const m = /^\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const k = Number(m[1]);
  return k >= 1 && k <= n ? k : null;
}

/**
 * The messages that need no model. `hidden` is the message with its numbers
 * already swapped out. Anything this does not recognise goes to the model.
 */
export function quickIntent(hidden: string, numbers: readonly string[]): Intent | null {
  const s = ` ${words(hidden)} `;
  if (/^ (hi|hello|hey|namaste|namaskar|help|menu|madad|options|start over) $/.test(s)) return intent("help");
  if (/\bpayout|payment status|paisa kab|commission status\b/.test(s)) return intent("payout_status");
  if (/^ (export|export karo|download|list bhejo|csv) $/.test(s)) return intent("export");
  if (/^ (my buyers|mere buyers|meri list|list|buyers|registrations|mere clients|my clients|maze buyers|majhe buyers|maze clients) $/.test(s)) return intent("my_buyers");
  if (/\binvoice\b/.test(s) && /\b(confirm|attest|sahi|theek|approve)\b/.test(s)) return intent("attest_invoice");
  if (/\b(reg|register|registration|tag|regd)\b/.test(s) && numbers.length === 1 && !/\b(visit|sv|book)\b/.test(s)) {
    return intent("register", { buyer: "#1", name: nameIn(hidden) });
  }
  return null;
}

const FILLER = new Set([
  "reg", "register", "registration", "regd", "tag", "client", "buyer", "customer", "karo", "kar", "do", "dijiye", "kijiye",
  "please", "pls", "plz", "naam", "name", "ka", "ki", "ke", "hai", "is", "for", "the", "a", "new", "mera", "mere", "ye", "yeh",
]);

/** The buyer's name in a register message: what is left once the command, the number and the filler are gone. */
export function nameIn(hidden: string): string | null {
  const left = hidden
    .replace(/#\d+/g, " ")
    .split(/[\s,.:;-]+/)
    .filter((w) => w && !FILLER.has(w.toLowerCase()));
  if (!left.length || left.length > 4 || !left.every((w) => /^[A-Za-z\u0900-\u097F']{2,30}$/.test(w))) return null;
  return left.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** The fixed schema the model answers in. Every field present, most of them null. */
export const INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["action", "buyer", "name", "config", "tower", "project", "when", "occasion", "what"],
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    buyer: { type: ["string", "null"], description: "The buyer: a placeholder like #1 exactly as written, or the buyer's name." },
    name: { type: ["string", "null"], description: "The buyer's name, when registering and the message gives one." },
    config: { type: ["string", "null"], description: "A configuration asked about, such as 2 BHK or 3BHK." },
    tower: { type: ["string", "null"], description: "A tower or wing named, such as Tower C." },
    project: { type: ["string", "null"], description: "A project named." },
    when: { type: ["string", "null"], description: "The visit day and time as written, such as kal 4pm or Saturday 11 am." },
    occasion: { type: ["string", "null"], description: "A festival or theme asked for, such as Diwali." },
    what: { type: ["string", "null"], enum: [...NOT_HERE, null], description: "For not_here: what was asked." },
  },
};

/** What the model is told. It picks an action; it never answers the partner. */
export function botInstructions(): string {
  return [
    "You read one WhatsApp message from a real-estate channel partner (a broker) to a developer's sales desk, and pick the ONE action it asks for.",
    "Messages are short romanised Hindi, Marathi or English fragments. Phone numbers have been replaced with #1, #2; copy the placeholder exactly into `buyer`.",
    "Actions:",
    "- inventory: what is available or what it costs. \"3bhk tower C mein kya hai\", \"2 bhk rate\".",
    "- register: register or tag a buyer. \"register client #1\", \"#1 Rahul Sharma reg karo\".",
    "- book_visit: book a site visit (SV) for a buyer. \"book SV kal 4pm #1\", \"Priya ka visit saturday 11 baje\".",
    "- my_buyers: the partner's own registered buyers and how long each claim runs.",
    "- payout_status: commission or payout status.",
    "- creative: posts or creatives to share. \"Diwali creative bhejo\", \"tower C ke posts\".",
    "- attest_invoice: confirm the partner's own invoice.",
    "- unmask: see a buyer's whole number. \"#1 ka pura number\", \"Priya ka number dikhao\".",
    "- export: the whole list as a file.",
    "- not_here: change bank or payout account (payout_account), add or remove a person's access (access), change or negotiate a price (price), approve or release a payout (approve_payout).",
    "- help: a greeting, or asking what the bot can do.",
    "- unclear: anything else.",
    "Fill only the fields the message itself gives. Never invent a number, a name, a tower or a time. Leave the rest null.",
  ].join("\n");
}

/** The model's answer, checked against the schema rather than believed. */
export function readIntent(raw: unknown): Intent {
  const r = (raw ?? {}) as Record<string, unknown>;
  const action = (ACTIONS as readonly string[]).includes(r.action as string) ? (r.action as Action) : "unclear";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
  const what = (NOT_HERE as readonly string[]).includes(r.what as string) ? (r.what as NotHere) : null;
  return {
    action,
    buyer: str(r.buyer),
    name: str(r.name),
    config: str(r.config),
    tower: str(r.tower),
    project: str(r.project),
    when: str(r.when),
    occasion: str(r.occasion),
    what,
  };
}

/** Whether `name` loosely names `candidate`: "tower c", "C", "Tower-C" all name "Tower C". */
export function names(name: string | null, candidate: string): boolean {
  if (!name) return false;
  const f = (x: string) => x.toLowerCase().replace(/\b(tower|wing|building|bldg|phase)\b/g, "").replace(/[^a-z0-9]/g, "");
  const a = f(name);
  const b = f(candidate);
  return !!a && !!b && (a === b || (a.length >= 3 && b.includes(a)));
}

// ---------------------------------------------------------------------------
// What the bot says
// ---------------------------------------------------------------------------

/**
 * A partner's person reads the bot in the language they chose: Hinglish (the
 * default, and every reply before 30 September 2026), English or Marathi,
 * all three in Roman letters and never Devanagari, the way the buyer
 * templates are (`message-rules.ts`). Stored on `partner_agents.language`
 * as the lead's language is stored: `hi`, `en`, `mr`, read by `voiceFor()`.
 */
export type PartnerLanguage = "hi" | "en" | "mr";
export const PARTNER_LANGUAGES: readonly PartnerLanguage[] = ["en", "hi", "mr"];

/** The version a partner's person reads. Nothing chosen, or anything unknown, is Hinglish, as it always was. */
export function partnerVoice(language: string | null | undefined): Voice {
  return language === "en" || language === "mr" ? voiceFor(language) : "HINGLISH";
}

/** What each language is called in the list a person picks from, in their own words. */
export const LANGUAGE_NAMES: Record<PartnerLanguage, string> = { en: "English", hi: "Hindi (Hinglish)", mr: "Marathi" };

/**
 * A language a person asked for, however they wrote it: "English",
 * "hindi mein", "language marathi", "मराठी". Null for anything else, so a
 * buyer's name is never read as a language.
 */
export function languageIn(text: string): PartnerLanguage | null {
  const s = words(text)
    .replace(/^(change|switch|set)\s+(the\s+)?(language|lang|bhasha)\s+(to\s+)?/, "")
    .replace(/^(language|lang|bhasha|bhaasha|bhasa|भाषा|in)\s+/, "")
    .replace(/\s+(please|pls|plz|mein|me|madhe|madhye|मध्ये|में|mein likho|mein bolo|madhe bola)$/, "")
    .trim();
  if (/^(english|eng|angrezi|angreji|इंग्रजी|अंग्रेजी|अंग्रेज़ी)$/.test(s)) return "en";
  if (/^(hindi|hinglish|हिंदी|हिन्दी)$/.test(s)) return "hi";
  if (/^(marathi|मराठी)$/.test(s)) return "mr";
  return null;
}

/** "language" on its own: the person wants the list to pick from. */
export function isLanguageAsk(text: string): boolean {
  return /^(language|languages|lang|bhasha|bhaasha|bhasha badlo|bhasha badla|change language|भाषा)$/.test(words(text));
}

/**
 * Every line the bot writes, in its three versions. `{name}` is filled by
 * `say()`. Roman letters only and no dash of any length between words:
 * `check:logic` reads every key.
 */
export const LINES = {
  help_head: {
    HINGLISH: "{developer} partner desk. Aap yeh likh sakte hain:",
    ENGLISH: "{developer} partner desk. You can write:",
    MARATHI: "{developer} partner desk. Tumhi he lihu shakta:",
  },
  help_register: {
    HINGLISH: "• register 98XXXXXXXX (buyer register karne ke liye)",
    ENGLISH: "• register 98XXXXXXXX (to register a buyer)",
    MARATHI: "• register 98XXXXXXXX (buyer register karnyasathi)",
  },
  help_buyers: { HINGLISH: "• mere buyers", ENGLISH: "• my buyers", MARATHI: "• maze buyers" },
  help_visit: {
    HINGLISH: "• book SV kal 4pm 98XXXXXXXX",
    ENGLISH: "• book SV tomorrow 4pm 98XXXXXXXX",
    MARATHI: "• book SV udya 4pm 98XXXXXXXX",
  },
  help_stock: {
    HINGLISH: "• 3bhk tower C mein kya hai",
    ENGLISH: "• 3bhk in tower C",
    MARATHI: "• tower C madhe 3bhk kay aahe",
  },
  help_payout: { HINGLISH: "• payout status", ENGLISH: "• payout status", MARATHI: "• payout status" },
  help_creative: {
    HINGLISH: "• Diwali creative bhejo",
    ENGLISH: "• send Diwali creative",
    MARATHI: "• Diwali creative pathva",
  },
  help_invoice: { HINGLISH: "• invoice confirm", ENGLISH: "• invoice confirm", MARATHI: "• invoice confirm" },
  help_language: {
    HINGLISH: "• language: English, Hindi ya Marathi",
    ENGLISH: "• language: English, Hindi or Marathi",
    MARATHI: "• bhasha: English, Hindi kiva Marathi",
  },
  bind_ask: {
    HINGLISH: "Namaste {first}! {developer} ke partner desk par aapka swagat hai. Humne Sales Desk ki taraf se WhatsApp par ek 6 digit code bheja hai. Woh code yahan bhejiye.",
    ENGLISH: "Hello {first}! Welcome to the {developer} partner desk. We have sent a 6 digit code on WhatsApp from Sales Desk. Send that code here.",
    MARATHI: "Namaskar {first}! {developer} chya partner desk var tumche swagat aahe. Aamhi Sales Desk kadun WhatsApp var ek 6 anki code pathavla aahe. To code ithe pathva.",
  },
  bound: {
    HINGLISH: 'Ho gaya, {first}. Ab aap yahin se buyer register kar sakte hain, site visit book kar sakte hain aur payout dekh sakte hain. "help" likhiye.',
    ENGLISH: 'Done, {first}. You can now register buyers, book site visits and see payouts right here. Type "help".',
    MARATHI: 'Jhala, {first}. Aata tumhi ithunach buyer register karu shakta, site visit book karu shakta ani payout baghu shakta. "help" liha.',
  },
  code_pending: {
    HINGLISH: "Sales Desk ki taraf se aaya 6 digit code yahan bhejiye.",
    ENGLISH: "Send the 6 digit code from Sales Desk here.",
    MARATHI: "Sales Desk kadun aalela 6 anki code ithe pathva.",
  },
  code_wrong: {
    HINGLISH: "Yeh code sahi nahi hai. Dobara bhejiye, ya naya code maangne ke liye pehla message phir likhiye.",
    ENGLISH: "That code is not right. Send it again, or write your first message again for a new code.",
    MARATHI: "Ha code barobar nahi. Punha pathva, kiva nava code magnyasathi pahila message punha liha.",
  },
  unclear: {
    HINGLISH: 'Samajh nahi aaya. "help" likh kar dekhiye kya kya kar sakte hain.',
    ENGLISH: 'I did not understand. Type "help" to see what you can do.',
    MARATHI: 'Samajla nahi. Kay kay karu shakta te baghnyasathi "help" liha.',
  },
  reads_capped: {
    HINGLISH: 'Aaj yeh message bot nahi padh sakta. "help" mein diye gaye seedhe commands likhiye, jaise "register 98XXXXXXXX" ya "payout status".',
    ENGLISH: 'The bot cannot read this message today. Write one of the direct commands in "help", like "register 98XXXXXXXX" or "payout status".',
    MARATHI: 'Aaj ha message bot vachu shakat nahi. "help" madhil thet commands liha, jase "register 98XXXXXXXX" kiva "payout status".',
  },
  capped: {
    HINGLISH: "Aaj ke liye messages ki limit poori ho gayi. Kal subah se phir likhiye.",
    ENGLISH: "Today's message limit is used up. Write again tomorrow morning.",
    MARATHI: "Aajchi messages chi maryada sampli. Udya sakali punha liha.",
  },
  cancelled: { HINGLISH: "Theek hai, cancel kar diya.", ENGLISH: "Okay, cancelled.", MARATHI: "Theek aahe, cancel kela." },
  muted: {
    HINGLISH: 'Theek hai, payout updates band. Wapas chalu karne ke liye "START" likhiye.',
    ENGLISH: 'Okay, payout updates are off. Type "START" to turn them back on.',
    MARATHI: 'Theek aahe, payout updates band. Punha chalu karnyasathi "START" liha.',
  },
  unmuted: { HINGLISH: "Payout updates phir se chalu.", ENGLISH: "Payout updates are on again.", MARATHI: "Payout updates punha chalu." },
  no_grant: {
    HINGLISH: "Aapki firm ka {developer} ke saath empanelment abhi live nahi hai.",
    ENGLISH: "Your firm's empanelment with {developer} is not live right now.",
    MARATHI: "Tumchya firm che {developer} sobat empanelment sadhya live nahi.",
  },
  talk_to_rm: { HINGLISH: " {rm} se baat kijiye.", ENGLISH: " Please speak to {rm}.", MARATHI: " {rm} yanchyashi bola." },
  not_here: {
    HINGLISH: "{thing} WhatsApp par nahi hota.",
    ENGLISH: "{thing} is not done on WhatsApp.",
    MARATHI: "{thing} WhatsApp var hot nahi.",
  },
  thing_payout_account: { HINGLISH: "Bank ya payout account badalna", ENGLISH: "Changing a bank or payout account", MARATHI: "Bank kiva payout account badalne" },
  thing_access: { HINGLISH: "Kisi ko access dena ya hatana", ENGLISH: "Giving or removing someone's access", MARATHI: "Konala access dene kiva kadhne" },
  thing_price: { HINGLISH: "Price badalna", ENGLISH: "Changing a price", MARATHI: "Price badalne" },
  thing_approve_payout: { HINGLISH: "Payout approve karna", ENGLISH: "Approving a payout", MARATHI: "Payout approve karne" },
  thing_other: { HINGLISH: "Yeh", ENGLISH: "This", MARATHI: "He" },
  verdict_registered: {
    HINGLISH: "Registered: {masked}, {project}. {left} din valid, {till} tak.",
    ENGLISH: "Registered: {masked}, {project}. Valid for {left} days, till {till}.",
    MARATHI: "Registered: {masked}, {project}. {left} divas valid, {till} paryant.",
  },
  verdict_already: {
    HINGLISH: "{masked} pehle se aapke naam par hai ({project}), {till} tak.",
    ENGLISH: "{masked} is already registered to you ({project}), till {till}.",
    MARATHI: "{masked} aadhich tumchya navavar aahe ({project}), {till} paryant.",
  },
  verdict_blocked: {
    HINGLISH: "{masked} {project} mein kisi aur partner ke paas registered hai.",
    ENGLISH: "{masked} is registered with another partner at {project}.",
    MARATHI: "{masked} {project} madhe dusrya partner kade registered aahe.",
  },
  verdict_blocked_till: {
    HINGLISH: "{masked} {project} mein {till} tak kisi aur partner ke paas registered hai.",
    ENGLISH: "{masked} is registered with another partner at {project} till {till}.",
    MARATHI: "{masked} {project} madhe {till} paryant dusrya partner kade registered aahe.",
  },
  verdict_direct: {
    HINGLISH: "{masked} ne {project} ke liye pehle hi seedha enquiry ki thi, isliye register nahi hua.",
    ENGLISH: "{masked} had already enquired about {project} directly, so they were not registered.",
    MARATHI: "{masked} yanni {project} sathi aadhich thet chaukashi keli hoti, mhanun register jhale nahi.",
  },
  verdict_grant_ended: {
    HINGLISH: "Aapki firm ka {project} par empanelment {till} ko khatam ho gaya.",
    ENGLISH: "Your firm's empanelment on {project} ended on {till}.",
    MARATHI: "Tumchya firm che {project} varil empanelment {till} la sampale.",
  },
  verdict_no_grant: {
    HINGLISH: "Aapki firm {project} par empanelled nahi hai.",
    ENGLISH: "Your firm is not empanelled on {project}.",
    MARATHI: "Tumchi firm {project} var empanelled nahi.",
  },
  verdict_agent_rera: {
    HINGLISH: "Aapki firm ka MahaRERA agent registration file par current nahi hai. Relationship manager ko naya certificate bhejiye.",
    ENGLISH: "Your firm's MahaRERA agent registration on file is not current. Send the new certificate to your relationship manager.",
    MARATHI: "Tumchya firm che MahaRERA agent registration file var current nahi. Relationship manager la nava certificate pathva.",
  },
  verdict_rate_limited: {
    HINGLISH: "Aaj ke registrations ki limit poori ho gayi. Kal phir try kijiye.",
    ENGLISH: "Today's registration limit is used up. Try again tomorrow.",
    MARATHI: "Aajchya registrations chi maryada sampli. Udya punha try kara.",
  },
  claims_none: {
    HINGLISH: 'Abhi aapke naam par koi live buyer nahi hai. "register 98XXXXXXXX" likh kar register kijiye.',
    ENGLISH: 'You have no live buyers right now. Type "register 98XXXXXXXX" to register one.',
    MARATHI: 'Sadhya tumchya navavar ekhi live buyer nahi. "register 98XXXXXXXX" lihun register kara.',
  },
  claims_head: { HINGLISH: "Aapke {n} live buyers:", ENGLISH: "Your {n} live buyers:", MARATHI: "Tumche {n} live buyers:" },
  claim_line: {
    HINGLISH: "• {buyer} {masked}, {project}: {left} din baaki{visited}",
    ENGLISH: "• {buyer} {masked}, {project}: {left} days left{visited}",
    MARATHI: "• {buyer} {masked}, {project}: {left} divas baki{visited}",
  },
  claim_visited: { HINGLISH: ", visit ho gaya", ENGLISH: ", visited", MARATHI: ", visit jhali" },
  and_more: { HINGLISH: "aur {n}", ENGLISH: "and {n} more", MARATHI: "ani {n}" },
  hold: {
    HINGLISH: '{buyer} ({masked}) ki site visit: {tower}, {date}, {time}. Confirm karne ke liye {secs} second mein "haan" likhiye.',
    ENGLISH: 'Site visit for {buyer} ({masked}): {tower}, {date}, {time}. To confirm, type "yes" within {secs} seconds.',
    MARATHI: '{buyer} ({masked}) chi site visit: {tower}, {date}, {time}. Confirm karnyasathi {secs} secondat "ho" liha.',
  },
  held_too_long: {
    HINGLISH: "Slot {secs} second tak hold tha, confirm nahi hua. Dobara book kijiye.",
    ENGLISH: "The slot was held for {secs} seconds and was not confirmed. Book again.",
    MARATHI: "Slot {secs} second hold hota, confirm jhala nahi. Punha book kara.",
  },
  booked: {
    HINGLISH: "Visit book ho gayi: {tower}, {date}, {time}.{maps} Buyer ko confirmation aur reminder jayenge.",
    ENGLISH: "Visit booked: {tower}, {date}, {time}.{maps} The buyer will get a confirmation and reminders.",
    MARATHI: "Visit book jhali: {tower}, {date}, {time}.{maps} Buyer la confirmation ani reminder jatil.",
  },
  location: { HINGLISH: " Location: {maps}", ENGLISH: " Location: {maps}", MARATHI: " Location: {maps}" },
  not_yours: {
    HINGLISH: 'Yeh buyer aapke naam par live registered nahi hai. Pehle "register 98XXXXXXXX" likhiye.',
    ENGLISH: 'This buyer is not registered to you right now. First type "register 98XXXXXXXX".',
    MARATHI: 'Ha buyer sadhya tumchya navavar registered nahi. Aadhi "register 98XXXXXXXX" liha.',
  },
  when: {
    HINGLISH: "Visit kab hai? Din aur time likhiye, jaise: kal 4pm. Site visit 10 am se 6:30 pm tak hote hain.",
    ENGLISH: "When is the visit? Write the day and time, like: tomorrow 4pm. Site visits run from 10 am to 6:30 pm.",
    MARATHI: "Visit kadhi aahe? Divas ani vel liha, jase: udya 4pm. Site visit 10 am te 6:30 pm paryant hotat.",
  },
  choose_tail: { HINGLISH: "Number bhejiye.", ENGLISH: "Send the number.", MARATHI: "Number pathva." },
  which_project: { HINGLISH: "Kis project ke liye?", ENGLISH: "For which project?", MARATHI: "Konatya project sathi?" },
  which_buyer: { HINGLISH: "Kaunsa buyer?", ENGLISH: "Which buyer?", MARATHI: "Konta buyer?" },
  which_tower: { HINGLISH: "Kaunsa tower?", ENGLISH: "Which tower?", MARATHI: "Konta tower?" },
  which_invoice: {
    HINGLISH: "Kaunsi invoice confirm karni hai?",
    ENGLISH: "Which invoice do you want to confirm?",
    MARATHI: "Konti invoice confirm karaychi aahe?",
  },
  which_language: { HINGLISH: "Kaunsi bhasha?", ENGLISH: "Which language?", MARATHI: "Konti bhasha?" },
  type_one: { HINGLISH: "Inme se ek likhiye.", ENGLISH: "Write one of these.", MARATHI: "Yapaiki ek liha." },
  language_set: {
    HINGLISH: "Theek hai, ab se Hinglish mein likhenge.",
    ENGLISH: "Okay, I will write in English from now on.",
    MARATHI: "Theek aahe, aata pasun Marathi madhe lihu.",
  },
  ask_number: {
    HINGLISH: "Buyer ka number bhejiye, jaise: register 9812345621",
    ENGLISH: "Send the buyer's number, like: register 9812345621",
    MARATHI: "Buyer cha number pathva, jase: register 9812345621",
  },
  no_tower_in_project: {
    HINGLISH: "{project} mein abhi koi tower nahi hai.",
    ENGLISH: "{project} has no tower yet.",
    MARATHI: "{project} madhe ajun konatahi tower nahi.",
  },
  no_tower: {
    HINGLISH: "Aapke projects mein abhi koi tower nahi hai.",
    ENGLISH: "Your projects have no tower yet.",
    MARATHI: "Tumchya projects madhe ajun konatahi tower nahi.",
  },
  not_advertisable: {
    HINGLISH: "{tower} abhi advertise nahi ho sakta, isliye yahan price nahi bata sakte.",
    ENGLISH: "{tower} cannot be advertised right now, so its price cannot be shared here.",
    MARATHI: "{tower} sadhya advertise hou shakat nahi, mhanun ithe price sangta yenar nahi.",
  },
  inventory_none: {
    HINGLISH: "{tower} mein is configuration ka koi approved price abhi nahi hai.",
    ENGLISH: "{tower} has no approved price for this configuration yet.",
    MARATHI: "{tower} madhe ya configuration chi approved price ajun nahi.",
  },
  inventory_head: {
    HINGLISH: "{tower}{list}:",
    ENGLISH: "{tower}{list}:",
    MARATHI: "{tower}{list}:",
  },
  price_list: {
    HINGLISH: " (price list v{version}, {on})",
    ENGLISH: " (price list v{version}, {on})",
    MARATHI: " (price list v{version}, {on})",
  },
  inventory_line: {
    HINGLISH: "• {label}: {area} sq ft carpet{price}",
    ENGLISH: "• {label}: {area} sq ft carpet{price}",
    MARATHI: "• {label}: {area} sq ft carpet{price}",
  },
  price_from: { HINGLISH: ", {price} se", ENGLISH: ", from {price}", MARATHI: ", {price} pasun" },
  half_paid: { HINGLISH: "PAID{on}{utr}", ENGLISH: "PAID{on}{utr}", MARATHI: "PAID{on}{utr}" },
  half_cancelled: { HINGLISH: "booking cancel hui", ENGLISH: "booking cancelled", MARATHI: "booking cancel jhali" },
  half_m1_later: {
    HINGLISH: "agreement registration ke baad milega",
    ENGLISH: "due after the agreement is registered",
    MARATHI: "agreement registration nantar milel",
  },
  half_m2_later: {
    HINGLISH: "30% collection ke baad milega",
    ENGLISH: "due after 30% is collected",
    MARATHI: "30% collection nantar milel",
  },
  half_await_invoice: {
    HINGLISH: "aapki invoice ka intezaar",
    ENGLISH: "waiting for your invoice",
    MARATHI: "tumchya invoice chi vaat",
  },
  half_confirm_invoice: {
    HINGLISH: 'invoice mili, "invoice confirm" likh kar confirm kijiye',
    ENGLISH: 'invoice received, type "invoice confirm" to confirm it',
    MARATHI: 'invoice milali, "invoice confirm" lihun confirm kara',
  },
  half_checking: { HINGLISH: "invoice check ho rahi hai", ENGLISH: "invoice is being checked", MARATHI: "invoice check hot aahe" },
  half_approval: { HINGLISH: "approval baaki", ENGLISH: "waiting for approval", MARATHI: "approval baki" },
  half_approved: {
    HINGLISH: "approved, payment process mein",
    ENGLISH: "approved, payment in process",
    MARATHI: "approved, payment process madhe",
  },
  payout_none: {
    HINGLISH: "Abhi aapki firm ki koi booking payout mein nahi hai.",
    ENGLISH: "Your firm has no booking in payout yet.",
    MARATHI: "Sadhya tumchya firm chi konatihi booking payout madhe nahi.",
  },
  payout_more: { HINGLISH: "aur {n} bookings", ENGLISH: "and {n} more bookings", MARATHI: "ani {n} bookings" },
  payout_booking: { HINGLISH: "{unit} · {buyer} ({project})", ENGLISH: "{unit} · {buyer} ({project})", MARATHI: "{unit} · {buyer} ({project})" },
  payout_half: { HINGLISH: "{key} {amount}: {state}", ENGLISH: "{key} {amount}: {state}", MARATHI: "{key} {amount}: {state}" },
  payout_update: { HINGLISH: "{key} {amount}, {state}.", ENGLISH: "{key} {amount}, {state}.", MARATHI: "{key} {amount}, {state}." },
  notify_booked: {
    HINGLISH: "Booking record ho gayi. {update}",
    ENGLISH: "The booking is recorded. {update}",
    MARATHI: "Booking record jhali. {update}",
  },
  notify_cancelled: {
    HINGLISH: "Booking cancel ho gayi. Jo hissa paid hai woh paid rahega, baaki nahi banega.",
    ENGLISH: "The booking was cancelled. What is paid stays paid; the rest will not be due.",
    MARATHI: "Booking cancel jhali. Je paid aahe te paid rahil, baki milnar nahi.",
  },
  notify_clawback: {
    HINGLISH: "Booking cancel ho gayi. Is booking par {amount} paid hua tha; yeh aapke agle payouts mein se kata jayega.",
    ENGLISH: "The booking was cancelled. {amount} was paid on it; that comes off your next payouts.",
    MARATHI: "Booking cancel jhali. Ya booking var {amount} paid zale hote; te tumchya pudhchya payouts madhun kami hoil.",
  },
  notify_adjusted: {
    HINGLISH: "{key} approve ho gaya. Cancel hui booking ke {amount} isme se kaate gaye.",
    ENGLISH: "{key} is approved. {amount} from a cancelled booking was taken off it.",
    MARATHI: "{key} approve zala. Cancel zalelya booking che {amount} yatun kami kele.",
  },
  step_up: {
    HINGLISH: "{what} ke liye Sales Desk ki taraf se ek naya 6 digit code bheja hai. 5 minute ke andar yahan bhejiye.",
    ENGLISH: "We have sent a new 6 digit code from Sales Desk for {what}. Send it here within 5 minutes.",
    MARATHI: "{what} sathi Sales Desk kadun nava 6 anki code pathavla aahe. 5 minitanchya aat ithe pathva.",
  },
  what_export: { HINGLISH: "List export karne", ENGLISH: "exporting the list", MARATHI: "List export" },
  what_attest: { HINGLISH: "Invoice {label} confirm karne", ENGLISH: "confirming invoice {label}", MARATHI: "Invoice {label} confirm karnya" },
  what_unmask: { HINGLISH: "{buyer} ka poora number dekhne", ENGLISH: "seeing {buyer}'s whole number", MARATHI: "{buyer} cha purna number baghnya" },
  unmasked_stored: {
    HINGLISH: "{buyer}: [poora number, code ke baad dikhaya gaya]",
    ENGLISH: "{buyer}: [whole number, shown after a code]",
    MARATHI: "{buyer}: [purna number, code nantar dakhavla]",
  },
  attested: {
    HINGLISH: "Invoice {no} confirm ho gayi. Ab developer ise check karega.",
    ENGLISH: "Invoice {no} is confirmed. The developer will check it now.",
    MARATHI: "Invoice {no} confirm jhali. Aata developer ti check karel.",
  },
  nothing_to_attest: {
    HINGLISH: "Abhi confirm karne ke liye koi invoice nahi hai.",
    ENGLISH: "There is no invoice to confirm right now.",
    MARATHI: "Sadhya confirm karnyasathi konatihi invoice nahi.",
  },
  creative_one: {
    HINGLISH: "1 co-branded creative bhej rahe hain. Isme aapka ref code hai.",
    ENGLISH: "Sending 1 co-branded creative. It carries your ref code.",
    MARATHI: "1 co-branded creative pathvat aahot. Tyat tumcha ref code aahe.",
  },
  creative_many: {
    HINGLISH: "{n} co-branded creatives bhej rahe hain. Har ek mein aapka ref code hai.",
    ENGLISH: "Sending {n} co-branded creatives. Each one carries your ref code.",
    MARATHI: "{n} co-branded creatives pathvat aahot. Pratyekat tumcha ref code aahe.",
  },
  no_creative: {
    HINGLISH: "Abhi aapke projects ke liye koi approved creative nahi hai.",
    ENGLISH: "There is no approved creative for your projects yet.",
    MARATHI: "Sadhya tumchya projects sathi konatehi approved creative nahi.",
  },
  creatives_today: {
    HINGLISH: "Aaj ke creatives bhej diye gaye hain. Kal phir maangiye.",
    ENGLISH: "Today's creatives have been sent. Ask again tomorrow.",
    MARATHI: "Aajche creatives pathavle aahet. Udya punha maga.",
  },
  caption: {
    HINGLISH: "Ref {code}. Buyer is link se WhatsApp karein: {link}",
    ENGLISH: "Ref {code}. Buyers can WhatsApp through this link: {link}",
    MARATHI: "Ref {code}. Buyer ya link varun WhatsApp karu shaktat: {link}",
  },
  file_failed: {
    HINGLISH: "File bhej nahi paaye. Thodi der baad phir try kijiye.",
    ENGLISH: "The file could not be sent. Try again in a while.",
    MARATHI: "File pathavta aali nahi. Thodya velane punha try kara.",
  },
} as const satisfies Record<string, Record<Voice, string>>;

export type LineKey = keyof typeof LINES;

/** One line in a version, its blanks filled. A blank nobody filled is left empty rather than printed as `{name}`. */
export function say(voice: Voice, key: LineKey, vars: Record<string, string | number | null | undefined> = {}): string {
  return LINES[key][voice].replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] === null || vars[k] === undefined ? "" : String(vars[k])));
}

/** The blanks a line carries, for `check:logic` to hold every version to the same ones. */
export function blanksOf(line: string): string[] {
  return [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function helpText(developer: string, voice: Voice = "HINGLISH"): string {
  const keys = ["help_register", "help_buyers", "help_visit", "help_stock", "help_payout", "help_creative", "help_invoice", "help_language"] as const;
  return [say(voice, "help_head", { developer }), ...keys.map((k) => say(voice, k))].join("\n");
}

export const bindAsk = (name: string, developer: string, voice: Voice = "HINGLISH") => say(voice, "bind_ask", { first: firstName(name), developer });

export const boundLine = (name: string, voice: Voice = "HINGLISH") => say(voice, "bound", { first: firstName(name) });

const rmLine = (rm: string | null, voice: Voice) => (rm ? say(voice, "talk_to_rm", { rm }) : "");

export const noGrantLine = (developer: string, rm: string | null, voice: Voice = "HINGLISH") =>
  say(voice, "no_grant", { developer }) + rmLine(rm, voice);

export function notHereLine(what: NotHere | null, rm: string | null, voice: Voice = "HINGLISH"): string {
  const thing = say(voice, what ? (`thing_${what}` as LineKey) : "thing_other");
  return say(voice, "not_here", { thing }) + rmLine(rm, voice);
}

/** The whole verdict in one line. The other firm is never named. */
export function verdictLine(v: {
  verdict: Verdict;
  phone: string;
  project: string;
  validUntil: string | null;
  today: string;
  booked?: boolean;
  voice?: Voice;
}): string {
  const voice = v.voice ?? "HINGLISH";
  const masked = maskPhone(v.phone);
  const till = v.validUntil ? showDate(v.validUntil.slice(0, 10)) : null;
  const left = v.validUntil ? Math.max(0, daysBetween(v.today, v.validUntil.slice(0, 10))) : null;
  const vars = { masked, project: v.project, till, left };
  switch (v.verdict) {
    case "REGISTERED":
      return say(voice, "verdict_registered", vars);
    case "ALREADY":
      return say(voice, "verdict_already", vars);
    case "BLOCKED":
      return say(voice, v.booked || !till ? "verdict_blocked" : "verdict_blocked_till", vars);
    case "DIRECT_FIRST":
      return say(voice, "verdict_direct", vars);
    case "NO_GRANT":
      return say(voice, till ? "verdict_grant_ended" : "verdict_no_grant", vars);
    case "AGENT_RERA":
      return say(voice, "verdict_agent_rera");
    case "RATE_LIMITED":
      return say(voice, "verdict_rate_limited");
  }
}

export type ClaimLine = { buyer: string; phone: string; project: string; validUntil: string; visited: boolean };

/** A partner's own live buyers, each with the days left on the claim. */
export function claimsText(claims: readonly ClaimLine[], today: string, more = 0, voice: Voice = "HINGLISH"): string {
  if (!claims.length) return say(voice, "claims_none");
  const lines = claims.map((c) =>
    say(voice, "claim_line", {
      buyer: c.buyer,
      masked: maskPhone(c.phone),
      project: c.project,
      left: Math.max(0, daysBetween(today, c.validUntil.slice(0, 10))),
      visited: c.visited ? say(voice, "claim_visited") : "",
    }),
  );
  return [say(voice, "claims_head", { n: claims.length + more }), ...lines, ...(more ? [say(voice, "and_more", { n: more })] : [])].join("\n");
}

export const holdLine = (h: { buyer: string; phone: string; tower: string; date: string; time: string }, voice: Voice = "HINGLISH") =>
  say(voice, "hold", { buyer: h.buyer, masked: maskPhone(h.phone), tower: h.tower, date: showDate(h.date), time: showTime(h.time), secs: HOLD_SECONDS });

export const heldTooLong = (voice: Voice = "HINGLISH") => say(voice, "held_too_long", { secs: HOLD_SECONDS });

export const bookedLine = (b: { tower: string; date: string; time: string; maps: string | null }, voice: Voice = "HINGLISH") =>
  say(voice, "booked", { tower: b.tower, date: showDate(b.date), time: showTime(b.time), maps: b.maps ? say(voice, "location", { maps: b.maps }) : "" });

/** A numbered list to pick from. */
export function chooseText(question: string, options: readonly string[], voice: Voice = "HINGLISH"): string {
  return [question, ...options.map((o, i) => `${i + 1}. ${o}`), say(voice, "choose_tail")].join("\n");
}

export type UnitLine = { label: string; carpetSqft: number; price: number | null };

/** Up to three configurations, from signed facts and approved unit types only. */
export function inventoryText(
  tower: string,
  units: readonly UnitLine[],
  priceList: { version: number; on: string } | null,
  voice: Voice = "HINGLISH",
): string {
  if (!units.length) return say(voice, "inventory_none", { tower });
  const head = say(voice, "inventory_head", {
    tower,
    list: priceList ? say(voice, "price_list", { version: priceList.version, on: showDate(priceList.on) }) : "",
  });
  const lines = units.slice(0, 3).map((u) =>
    say(voice, "inventory_line", {
      label: u.label,
      area: u.carpetSqft.toLocaleString("en-IN"),
      price: u.price ? say(voice, "price_from", { price: rupeesShort(u.price) }) : "",
    }),
  );
  return [head, ...lines].join("\n");
}

export type HalfLine = {
  key: "M1" | "M2";
  base: number;
  stage: "NONE" | "INVOICED" | "VERIFIED" | "APPROVED" | "PAID";
  owed: boolean;
  invoiced: boolean;
  attested: boolean;
  paidOn: string | null;
  utr: string | null;
};

export type PayoutLine = { unit: string; buyer: string; project: string; cancelled: boolean; halves: HalfLine[] };

/** What a half is waiting on, in the partner's words. */
export function halfState(h: HalfLine, cancelled: boolean, voice: Voice = "HINGLISH"): string {
  if (h.stage === "PAID") return say(voice, "half_paid", { on: h.paidOn ? ` ${showDate(h.paidOn)}` : "", utr: h.utr ? `, UTR ${h.utr}` : "" });
  if (cancelled) return say(voice, "half_cancelled");
  if (!h.owed) return say(voice, h.key === "M1" ? "half_m1_later" : "half_m2_later");
  if (h.stage === "NONE") return say(voice, "half_await_invoice");
  if (h.stage === "INVOICED") return say(voice, h.attested ? "half_checking" : "half_confirm_invoice");
  if (h.stage === "VERIFIED") return say(voice, "half_approval");
  return say(voice, "half_approved");
}

/** The milestone ladder for each booking, with what each half waits on. */
export function payoutText(rows: readonly PayoutLine[], more = 0, voice: Voice = "HINGLISH"): string {
  if (!rows.length) return say(voice, "payout_none");
  const blocks = rows.map((r) =>
    [
      say(voice, "payout_booking", { unit: r.unit, buyer: r.buyer, project: r.project }),
      ...r.halves.map((h) => say(voice, "payout_half", { key: h.key, amount: rupees(h.base), state: halfState(h, r.cancelled, voice) })),
    ].join("\n"),
  );
  return [...blocks, ...(more ? [say(voice, "payout_more", { n: more })] : [])].join("\n\n");
}

/** The line a payout update carries, for the template's last blank. */
export function payoutUpdate(h: HalfLine, cancelled: boolean, voice: Voice = "HINGLISH"): string {
  return say(voice, "payout_update", { key: h.key, amount: rupees(h.base), state: halfState(h, cancelled, voice) });
}

export type InvoiceChoice = { id: string; no: string; amount: number; unit: string; key: "M1" | "M2" };

export const invoiceLabel = (i: InvoiceChoice) => `${i.no}, ${rupees(i.amount)} (${i.unit} ${i.key})`;

export const stepUpAsk = (what: string, voice: Voice = "HINGLISH") => say(voice, "step_up", { what });

export const attestedLine = (i: InvoiceChoice, voice: Voice = "HINGLISH") => say(voice, "attested", { no: i.no });

export const creativeIntro = (n: number, voice: Voice = "HINGLISH") => say(voice, n === 1 ? "creative_one" : "creative_many", { n });

/** The caption under a co-branded picture: the code, and where a buyer taps. */
export const creativeCaption = (code: string, link: string, voice: Voice = "HINGLISH") => say(voice, "caption", { code, link });

// ---------------------------------------------------------------------------
// The partner's link on WhatsApp
// ---------------------------------------------------------------------------

/** What a buyer's message says when they tap the link. The code is the last word. */
export function tapText(project: string, code: string): string {
  return `Namaste! Mujhe ${project} ke baare mein jaanna hai. Ref ${code}`;
}

/** A link that opens WhatsApp to the developer's number with the message written in. */
export function waMeLink(e164: string, text: string): string {
  return `https://wa.me/${e164.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

/** A partner's ref code anywhere in a buyer's message, as the link wrote it. */
export function refCodeIn(text: string): string | null {
  const m = /\b([A-Z]{2,3}-[A-Z]{2,3}-\d{4})\b/i.exec(text);
  return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// An export a partner asked for
// ---------------------------------------------------------------------------

/** A cell a spreadsheet will not run: a leading =, +, - or @ is made literal. */
export function csvCell(v: string | null | undefined): string {
  let s = (v ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvOf(header: readonly string[], rows: readonly (readonly (string | null)[])[]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
