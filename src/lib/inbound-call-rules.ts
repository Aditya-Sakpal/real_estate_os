/**
 * A buyer calling a developer's own number: the rules, with no database.
 *
 * Vobiz answers the call on the address the operator pasted for that number
 * (`inboundAddress()`), which carries an HMAC of the number in its own
 * namespace, because Vobiz signs nothing. Whose number it is comes from the
 * one lookup across tenants; who is rung is decided here: the lead's owner
 * first when there is one who can take it, then every free person on the
 * sales team. Outside calling hours nothing new is played: the free team is
 * rung if there is one, and otherwise the call is a missed call a person is
 * asked to return.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { CALLING_HOURS, istHour } from "./calling-hours.ts";
import { ringList, toE164, type Seller } from "./handoff-rules.ts";

/** The proof on a number's answer address. Its own namespace: it opens no call's webhook, and none opens it. */
export function inboundNumberToken(secret: string, number: string): string {
  return createHmac("sha256", secret).update(`inbound:${number}`).digest("hex");
}

/** The proof on one inbound call's callbacks. */
export function inboundCallToken(secret: string, orgId: string, id: string): string {
  return createHmac("sha256", secret).update(`inbound-call:${orgId}:${id}`).digest("hex");
}

function same(want: string, token: string | null | undefined): boolean {
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) return false;
  const a = Buffer.from(want, "hex");
  const b = Buffer.from(token, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const inboundNumberValid = (secret: string, number: string, token: string | null | undefined) =>
  /^\+[1-9][0-9]{7,14}$/.test(number) && same(inboundNumberToken(secret, number), token);

export const inboundCallValid = (secret: string, orgId: string, id: string, token: string | null | undefined) =>
  /^[0-9a-f-]{36}$/i.test(orgId) && /^[0-9a-f-]{36}$/i.test(id) && same(inboundCallToken(secret, orgId, id), token);

/** The address the operator pastes into Vobiz as the number's answer URL. */
export function inboundAddress(base: string, secret: string, number: string): string {
  return `${base.replace(/\/+$/, "")}/api/calls/inbound?n=${encodeURIComponent(number)}&t=${inboundNumberToken(secret, number)}`;
}

export type InboundCall = { uuid: string; from: string | null; to: string | null };

/** What Vobiz's answer request says: the call, who rang, and the number rung. */
export function readInbound(p: Record<string, string>): InboundCall | null {
  const uuid = (p.CallUUID ?? p.call_uuid ?? "").trim();
  if (!uuid || uuid.length > 100) return null;
  return { uuid, from: toE164(p.From ?? p.from), to: toE164(p.To ?? p.to) };
}

/** Whether an instant is inside calling hours, IST. */
export const inHours = (iso: string): boolean => {
  const h = istHour(iso);
  return h >= CALLING_HOURS.from && h < CALLING_HOURS.to;
};

export type Ring =
  | { stage: "OWNER" | "TEAM"; numbers: string[] }
  | { stage: null; numbers: [] };

/**
 * Who is rung first. The lead's owner alone when they have a proved phone
 * and are not already on a buyer; otherwise the free team, the one who has
 * waited longest first. Inside calling hours the organisation's hand-off
 * number stands in when nobody on the team is free; outside them it does
 * not, because a hand-off number is a desk, and a desk is shut at night.
 * The buyer's own phone is never rung.
 */
export function firstRing(o: {
  ownerPhone: string | null;
  team: readonly Seller[];
  fallback: string | null;
  inHours: boolean;
  caller: string | null;
  max: number;
}): Ring {
  const busy = new Set(o.team.filter((s) => s.busy).map((s) => s.phone));
  if (o.ownerPhone && o.ownerPhone !== o.caller && !busy.has(o.ownerPhone)) return { stage: "OWNER", numbers: [o.ownerPhone] };
  return teamRing({ ...o, skip: null });
}

/** The team, after the owner did not answer (`skip`), or straight away. */
export function teamRing(o: {
  team: readonly Seller[];
  fallback: string | null;
  inHours: boolean;
  caller: string | null;
  max: number;
  skip: string | null;
}): Ring {
  const others = o.team.filter((s) => s.phone !== o.caller && s.phone !== o.skip);
  const fallback = o.inHours && o.fallback && o.fallback !== o.caller && o.fallback !== o.skip ? o.fallback : null;
  const numbers = ringList(others, fallback, o.max);
  return numbers.length ? { stage: "TEAM", numbers } : { stage: null, numbers: [] };
}

/** What the lead is flagged with when nobody took the buyer. */
export const MISSED_FLAG = "Called in and nobody picked up. Call them back";

/** The lead's history line for one call in. */
export function callInLine(o: { status: "CONNECTED" | "MISSED" | "REFUSED" | "RINGING"; captured: boolean }): string {
  const first = o.captured ? "Called our number for the first time" : "Called our number";
  if (o.status === "MISSED") return `${first}. Nobody picked up`;
  if (o.status === "REFUSED") return `${first}. Nobody was rung`;
  return first;
}

// ---------------------------------------------------------------------------
// The AI receptionist: a number bound to the inbound agent on Sarvam
// ---------------------------------------------------------------------------

/**
 * The proof on the receptionist's start address. The agent is one for every
 * tenant, so the address is too; it opens nothing else, and the number rung
 * is read from what Sarvam sends and must be a number some tenant holds.
 */
export function inboundStartToken(secret: string): string {
  return createHmac("sha256", secret).update("inbound-start").digest("hex");
}

export const inboundStartValid = (secret: string, token: string | null | undefined) => same(inboundStartToken(secret), token);

/** The address set as the receptionist's on-start API, and the one its deployment's call-end webhook posts to. */
export function receptionistAddresses(base: string, secret: string): { start: string; ended: string } {
  const root = base.replace(/\/+$/, "");
  const t = inboundStartToken(secret);
  return { start: `${root}/api/calls/inbound/start?t=${t}`, ended: `${root}/api/calls/inbound/ended?t=${t}` };
}

const asText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** A number as E.164, from the shapes Sarvam's user information uses: digits with a country code apart, or whole. */
function numberFrom(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const raw = asText(o[k]);
    if (!raw) continue;
    const cc = asText(o.country_code)?.replace(/\D/g, "");
    const digits = raw.replace(/\D/g, "");
    if (cc && digits.length === 10 && !raw.startsWith("+")) return toE164(`+${cc}${digits}`);
    const e = toE164(raw);
    if (e) return e;
  }
  return null;
}

export type StartRequest = { caller: string | null; called: string | null; sid: string | null };

/**
 * Who is ringing and which number they rang, from Sarvam's on-start request.
 * Sarvam documents the user information (the caller, with its country code
 * apart, and the provider's call id) but not where the number rung is put,
 * so every place it has been seen is read, and `n` on the address is used
 * only when the request names no number at all. Nothing here is trusted beyond
 * picking which tenant to look up.
 */
export function readStart(body: unknown, query: { n?: string | null } = {}): StartRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const nested = (k: string) => (b[k] && typeof b[k] === "object" ? (b[k] as Record<string, unknown>) : {});
  const user = { ...nested("user_information"), ...nested("user_info") };
  const vars = { ...nested("agent_variables"), ...nested("variables") };
  const caller =
    numberFrom(user, ["phone_number", "identifier"]) ??
    numberFrom(b, ["caller", "caller_number", "from", "from_number", "user_identifier", "phone_number"]);
  // The number this call really rang, as Sarvam sends it per call, comes
  // first. One receptionist agent serves every tenant's number, so `n` on its
  // address is the same for all of them and is only a last resort: put first,
  // it filed a call to one developer's number under another's (24 Oct 2026).
  const called =
    numberFrom(b, ["agent_phone_number", "called", "called_number", "to", "to_number", "dialed_number", "did", "bot_contact_identifier"]) ??
    numberFrom(vars, ["called_number", "to_number"]) ??
    toE164(query.n ?? undefined);
  const sid = asText(user.call_sid) ?? asText(b.call_sid) ?? asText(b.call_id);
  return { caller, called: called && called !== caller ? called : null, sid: sid ? sid.slice(0, 100) : null };
}

/**
 * How the receptionist takes this call. `talk`: it answers, from the
 * tower's facts. `connect`: it greets and puts the buyer through to a
 * person at once, because nothing lawful or paid-for is left to say (the
 * tower may not be advertised, or the project's minutes are used up).
 * `general`: it answers knowing nothing of the buyer or the tower.
 */
export type AnswerMode = "talk" | "connect" | "general";

export function answerMode(o: { tenant: boolean; advertisable: boolean; minutesLeft: boolean }): AnswerMode {
  if (!o.tenant) return "general";
  if (!o.advertisable || !o.minutesLeft) return "connect";
  return "talk";
}

/**
 * The receptionist's first line (`opening_line`), said before the caller
 * speaks: the way a sales person answers a prospect whose number they know.
 * A buyer we rang and who missed it is thanked for calling back and told
 * what we rang about; one we spoke to is greeted by name and reminded where
 * it stood; a stranger is asked how to help. Devanagari for Hindi and
 * Marathi, which the voice reads right; property words stay English.
 */
export type OpeningInput = {
  language: "hi" | "mr" | "en";
  /** The first name the agent may say, or empty. */
  name: string;
  developer: string;
  /** "Northwind" or "Sath Heights Tower C": what the call is about. */
  project: string;
  /** Our newest call to this buyer, or null when we never rang. `outcome` is how it ended, when known. */
  last: { answered: boolean; outcome?: string | null } | null;
  /** True when the caller is on our list at all. */
  known: boolean;
  /** "2 BHK" when a call already learnt it. */
  config: string | null;
  agent?: string;
};

/** A last call that ended with the buyer declining: nothing is presumed decided when they ring. */
const DECLINED = new Set(["NOT_INTERESTED", "WRONG_NUMBER", "OPTED_OUT", "BROKER"]);

export function openingLine(o: OpeningInput): string {
  const agent = o.agent ?? "Advait";
  const name = o.name.trim();
  const project = o.project.trim();
  const from = project || o.developer.trim();
  // A buyer who said no on the last call and rings anyway is asked how to
  // help, never whether they "decided anything further" (28 October 2026).
  const declined = !!o.last?.answered && DECLINED.has(o.last.outcome ?? "");
  if (o.language === "mr") {
    const hi = name ? `नमस्कार ${name} जी` : "नमस्कार";
    const me = from ? `मी ${agent}, ${from} मधून बोलतोय` : `मी ${agent} बोलतोय`;
    if (o.known && o.last && !o.last.answered) return `${hi}, ${me}. कॉल बॅक केल्याबद्दल धन्यवाद. आम्ही तुम्हाला ${project || "प्रोजेक्ट"} बद्दल कॉल केला होता, आत्ता बोलायला वेळ आहे का?`;
    if (o.known && declined) return `${hi}, ${me}. कॉल केल्याबद्दल धन्यवाद. सांगा, मी काय मदत करू शकतो?`;
    if (o.known && o.last) return `${hi}, ${me}. कॉल केल्याबद्दल धन्यवाद. आपलं आधी ${project || "प्रोजेक्ट"} बद्दल बोलणं झालं होतं${o.config ? `, तुम्ही ${o.config} बघत होतात` : ""}. पुढे काही ठरवलंत का?`;
    if (o.known) return `${hi}, ${me}. तुम्ही ${project || "आमच्या प्रोजेक्ट"} बद्दल enquiry केली होती, कॉल केल्याबद्दल धन्यवाद. काय जाणून घ्यायचंय?`;
    return `नमस्कार, ${me}. कॉल केल्याबद्दल धन्यवाद, मी आपली काय मदत करू शकतो?`;
  }
  if (o.language === "en") {
    const hi = name ? `Hello ${name} ji` : "Hello";
    const me = from ? `this is ${agent} from ${from}` : `this is ${agent}`;
    if (o.known && o.last && !o.last.answered) return `${hi}, ${me}. Thank you for calling back. We had called you about ${project || "the project"}, is this a good time to talk?`;
    if (o.known && declined) return `${hi}, ${me}. Thank you for calling. How can I help?`;
    if (o.known && o.last) return `${hi}, ${me}. Thank you for calling. We spoke earlier about ${project || "the project"}${o.config ? `, you were looking at a ${o.config}` : ""}. Have you thought about it further?`;
    if (o.known) return `${hi}, ${me}. You had enquired about ${project || "our project"}, thank you for calling. What would you like to know?`;
    return `Namaste, ${me}. Thank you for calling, how may I help you?`;
  }
  const hi = name ? `नमस्ते ${name} जी` : "नमस्ते";
  const me = from ? `मैं ${agent}, ${from} से बात कर रहा हूँ` : `मैं ${agent} बात कर रहा हूँ`;
  if (o.known && o.last && !o.last.answered) return `${hi}, ${me}. कॉल बैक करने के लिए शुक्रिया. हमने आपको ${project || "प्रोजेक्ट"} के बारे में कॉल किया था, अभी बात करने का सही समय है?`;
  if (o.known && declined) return `${hi}, ${me}. कॉल करने के लिए शुक्रिया. बताइए, मैं कैसे मदद कर सकता हूँ?`;
  if (o.known && o.last) return `${hi}, ${me}. कॉल करने के लिए शुक्रिया. हमारी पहले ${project || "प्रोजेक्ट"} के बारे में बात हुई थी${o.config ? `, आप ${o.config} देख रहे थे` : ""}. आगे क्या सोचा आपने?`;
  if (o.known) return `${hi}, ${me}. आपने ${project || "हमारे प्रोजेक्ट"} के बारे में enquiry की थी, कॉल करने के लिए शुक्रिया. क्या जानना चाहेंगे?`;
  return `नमस्ते, ${me}. कॉल करने के लिए शुक्रिया, मैं आपकी कैसे मदद कर सकता हूँ?`;
}

/**
 * The receptionist starts every call in Hindi (one agent answers every
 * number, and an inbound call cannot be given a language before it starts),
 * so when the opening line was said in Marathi or English the agent is told
 * to carry on in that language from the first reply. Without it, Harbour View's
 * receptionist greeted a Marathi buyer in Marathi and answered him in Hindi,
 * and he had to ask for Marathi (24 October 2026). Empty for Hindi.
 */
export function openingLanguageNote(language: "hi" | "mr" | "en"): string {
  const name = language === "mr" ? "Marathi" : language === "en" ? "English" : null;
  if (!name) return "";
  return (
    `LANGUAGE: The opening line was said in ${name}, the user's language. Before your first reply, call change_output_language with ${name}, ` +
    `and speak ${name} from then on, unless the user speaks a whole sentence in another language or asks for one.`
  );
}

/** The call-end webhook's link back to our row: the agent's own variables carry it. */
export function startedCall(body: unknown): { orgId: string; callId: string; token: string } | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const k of ["final_agent_variables", "agent_variables", "variables", "final_variables"]) {
    const v = b[k];
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const orgId = asText(o.salesdesk_org);
    const callId = asText(o.salesdesk_call);
    const token = asText(o.salesdesk_key);
    if (orgId && callId && token) return { orgId, callId, token };
  }
  return null;
}

// ---------------------------------------------------------------------------
// A caller to a number that covers several towers
// ---------------------------------------------------------------------------

/**
 * A tower a call to a shared number may be about: one the RERA gate cleared
 * when the call began, under the number's place.
 */
export type PortfolioTower = { id: string; project: string; tower: string | null };

/** Lower case, letters and digits only, single spaces, padded so a whole word is found by " word ". */
const words = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9ऀ-ॿ]+/g, " ").trim()} `;

/**
 * The tower a finished call was about, read off what was said: the one
 * project named, and its one tower or the one of its towers named. Never a
 * guess: two projects named, or a project of several towers with none or
 * two of them named, is null, and the caller waits for a person to file.
 */
export function towerNamed(said: string, towers: readonly PortfolioTower[]): string | null {
  const text = words(said);
  const has = (name: string) => {
    const w = words(name).trim();
    return w.length >= 3 && text.includes(` ${w} `);
  };
  const projects = [...new Set(towers.map((t) => t.project))].filter(has);
  if (projects.length !== 1) return null;
  const mine = towers.filter((t) => t.project === projects[0]);
  if (mine.length === 1) return mine[0].id;
  const named = mine.filter((t) => t.tower && has(t.tower));
  return named.length === 1 ? named[0].id : null;
}

/** What a caller nobody could file asked about, for the person filing: the agent's summary, one line, no number in it. */
export function heardLine(summary: string | null | undefined): string | null {
  const line = (summary ?? "").replace(/\s+/g, " ").replace(/\+?\d[\d\s-]{8,}\d/g, "a number").trim();
  return line ? line.slice(0, 300) : null;
}

/** Why a caller waits on Today, and what the lead says once a person files it. */
export const WAITING_REASON = "Called your number. Which project is not known yet.";
export const FILED_FLAG = "Called your number before it was filed under a project. Call them back";
