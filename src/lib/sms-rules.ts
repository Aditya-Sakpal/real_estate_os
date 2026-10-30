import type { MessagePurpose, Voice } from "./message-rules.ts";

/**
 * SMS, the pure half: which messages may fall back to SMS and when, the
 * words each is registered with on DLT, filling them, counting the parts,
 * the price, and reading what a person types into the DLT settings.
 *
 * An SMS is a SERVICE fallback only, decided with the client on 29
 * September 2026: when a service message could not go on WhatsApp (no
 * number connected for the project, Meta has not approved it, or the buyer
 * is not on WhatsApp). Never a promotion, so never a broadcast, a nudge or
 * a slot offer.
 *
 * The words are ours and the registration is the developer's. India's DLT
 * drops a message whose words do not match a template the sender
 * registered, word for word, so each version below is what the developer
 * registers, and the id DLT hands back is what we send with it.
 *
 * Client-safe: the settings screen shows these words to copy.
 */

/** The only messages that fall back to SMS. */
export const SMS_PURPOSES = ["ACK", "VISIT_CONFIRMED", "VISIT_REMINDER_DAY", "VISIT_REMINDER_SOON"] as const;
export type SmsPurpose = (typeof SMS_PURPOSES)[number];

export const isSmsPurpose = (p: string): p is SmsPurpose => (SMS_PURPOSES as readonly string[]).includes(p);

/** A blank in an SMS: a DLT variable, and what fills it. */
export type SmsBlank = "first_name" | "developer" | "project" | "when" | "pass" | "contact";

type SmsTemplate = {
  purpose: SmsPurpose;
  /** What the settings screen calls it. */
  label: string;
  /** The blanks, in the order they appear. */
  blanks: readonly SmsBlank[];
  /** The words per version, `{#var#}` and `{#url#}` where DLT's variables go. */
  body: Record<Voice, string>;
};

/**
 * DLT's variables: `{#var#}` holds up to 30 characters, `{#url#}` a link
 * on a domain the developer whitelisted.
 */
export const VAR = "{#var#}";
export const URL_VAR = "{#url#}";
export const VAR_MAX = 30;

export const SMS_TEMPLATES: Record<SmsPurpose, SmsTemplate> = {
  ACK: {
    purpose: "ACK",
    label: "Enquiry received",
    blanks: ["first_name", "developer"],
    body: {
      ENGLISH: "Hi {#var#}, thank you for your enquiry with {#var#}. Our team will call you after 10 am.",
      HINGLISH: "Hi {#var#}, {#var#} ke saath enquiry karne ke liye thank you. Hamari team aapko subah 10 baje ke baad call karegi.",
      MARATHI: "Namaskar {#var#}, {#var#} kade chaukashi kelyabaddal dhanyavaad. Aamchi team tumhala sakali 10 nantar call karel.",
    },
  },
  VISIT_CONFIRMED: {
    purpose: "VISIT_CONFIRMED",
    label: "Visit confirmed",
    blanks: ["first_name", "project", "when", "pass"],
    body: {
      ENGLISH: "Hi {#var#}, your site visit to {#var#} is confirmed for {#var#}. Show this pass at the gate: {#url#}",
      HINGLISH: "Hi {#var#}, {#var#} ka aapka site visit {#var#} ke liye confirm hai. Gate par yeh pass dikhaiye: {#url#}",
      MARATHI: "Namaskar {#var#}, {#var#} chi tumchi site visit {#var#} la confirm aahe. Gate var ha pass dakhva: {#url#}",
    },
  },
  VISIT_REMINDER_DAY: {
    purpose: "VISIT_REMINDER_DAY",
    label: "Visit reminder, a day before",
    blanks: ["first_name", "project", "when", "contact"],
    body: {
      ENGLISH: "Hi {#var#}, a reminder: your site visit to {#var#} is on {#var#}. To change the time, call {#var#}.",
      HINGLISH: "Hi {#var#}, ek reminder: {#var#} ka aapka site visit {#var#} ko hai. Time badalna ho toh {#var#} par call karein.",
      MARATHI: "Namaskar {#var#}, aathvan karun deto: {#var#} chi tumchi site visit {#var#} la aahe. Vel badlaychi asel tar {#var#} var call kara.",
    },
  },
  VISIT_REMINDER_SOON: {
    purpose: "VISIT_REMINDER_SOON",
    label: "Visit reminder, two hours before",
    blanks: ["first_name", "project", "when", "contact"],
    body: {
      ENGLISH: "Hi {#var#}, see you soon: your site visit to {#var#} is at {#var#}. For directions, call {#var#}.",
      HINGLISH: "Hi {#var#}, jaldi milte hain: {#var#} ka aapka site visit {#var#} par hai. Raasta jaanne ke liye {#var#} par call karein.",
      MARATHI: "Namaskar {#var#}, lavkarach bhetu: {#var#} chi tumchi site visit {#var#} la aahe. Rasta vicharnyasathi {#var#} var call kara.",
    },
  },
};

/** The blanks of a registered text, in order, as DLT reads them. */
export function variablesIn(body: string): ("var" | "url")[] {
  return [...body.matchAll(/\{#(var|url)#\}/g)].map((m) => m[1] as "var" | "url");
}

/** What a buyer gets when their name is not known. */
const NO_NAME: Record<Voice, string> = { ENGLISH: "there", HINGLISH: "there", MARATHI: "ji" };

/** One DLT variable's value: one line, trimmed, never over 30 characters. */
export function varValue(raw: string): string {
  const one = raw.replace(/\s+/g, " ").trim();
  return one.length <= VAR_MAX ? one : one.slice(0, VAR_MAX).trimEnd();
}

export type SmsFill = { ok: true; text: string } | { ok: false; code: "MISSING"; blank: SmsBlank };

/**
 * The SMS a buyer reads: the registered words with each variable filled.
 * A blank with nothing to fill it is refused rather than sent empty, because
 * an empty variable is a message the operator will not match.
 */
export function fillSms(purpose: SmsPurpose, voice: Voice, values: Partial<Record<SmsBlank, string | null>>): SmsFill {
  const t = SMS_TEMPLATES[purpose];
  const parts = t.body[voice].split(/\{#(?:var|url)#\}/);
  let text = parts[0];
  for (let i = 0; i < t.blanks.length; i++) {
    const blank = t.blanks[i];
    const raw = values[blank] ?? (blank === "first_name" ? NO_NAME[voice] : null);
    if (!raw || !raw.trim()) return { ok: false, code: "MISSING", blank };
    text += (blank === "pass" ? raw.trim() : varValue(raw)) + parts[i + 1];
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Parts and price
// ---------------------------------------------------------------------------

// GSM 03.38's basic set and its extension (each extension character counts twice).
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";

/** At most this many parts: a message that runs longer is refused, not split further. */
export const MAX_SMS_PARTS = 3;

/** How a text is carried, and how many parts it takes. */
export function smsParts(text: string): { encoding: "GSM7" | "UCS2"; parts: number } {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXT.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: "GSM7", parts: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { encoding: "UCS2", parts: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/**
 * What AWS charges us for one part to an Indian number, in paise
 * (`doc/pricing.md`), and the most AWS may charge for one before it refuses
 * to send, in dollars: the ceiling on a price nobody expected.
 */
export const SMS_PART_PAISE = 36;
export const SMS_MAX_PRICE_USD = "0.0060";

/** An SMS's price: ours, and what the credit is drawn at (cost plus 15%). */
export function smsPrice(parts: number): { costPaise: number; billedPaise: number } {
  const costPaise = parts * SMS_PART_PAISE;
  return { costPaise, billedPaise: Math.ceil(costPaise * 1.15) };
}

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

/**
 * WhatsApp's refusals an SMS answers: the project has no number, Meta has
 * not approved the message, or Meta said the buyer is not on WhatsApp
 * (131026). Anything else (an opt-out, no consent, a stopped project, no
 * credit) is a refusal an SMS must honour too, so it never falls back.
 */
export const FALLBACK_CODES = ["NOT_SWITCHED_ON", "NOT_APPROVED"] as const;
export const NOT_ON_WHATSAPP = 131026;

export function fallsBack(purpose: string, why: { code?: string | null; metaError?: number | null }): purpose is SmsPurpose {
  if (!isSmsPurpose(purpose)) return false;
  if (why.metaError === NOT_ON_WHATSAPP) return true;
  return !!why.code && (FALLBACK_CODES as readonly string[]).includes(why.code);
}

// ---------------------------------------------------------------------------
// The DLT settings, as typed
// ---------------------------------------------------------------------------

/** DLT's Principal Entity id: 19 digits, spaces and dashes ignored. */
export function pickEntityId(raw: string): string | null {
  const d = raw.replace(/[\s-]/g, "");
  return /^[0-9]{19}$/.test(d) ? d : null;
}

/** A content template id is 19 digits too. */
export const pickTemplateId = pickEntityId;

/** A header is six letters, read in capitals. Operators add their own suffix; that is not typed. */
export function pickHeader(raw: string): string | null {
  const h = raw.trim().toUpperCase().replace(/-[STPG]$/, "");
  return /^[A-Z]{6}$/.test(h) ? h : null;
}

/** Whether a template id still matches the words it was registered with. */
export type SmsTemplateState = "SENDS" | "REWORDED" | "MISSING";

export function smsTemplateState(row: { bodySha256: string } | null, currentSha256: string): SmsTemplateState {
  if (!row) return "MISSING";
  return row.bodySha256 === currentSha256 ? "SENDS" : "REWORDED";
}

/** What a person reads beside each state. */
export const SMS_STATE_WORDS: Record<SmsTemplateState, string> = {
  SENDS: "Registered",
  REWORDED: "Wording changed, register again",
  MISSING: "Not registered",
};
