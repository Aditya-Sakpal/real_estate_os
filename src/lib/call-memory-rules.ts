/**
 * What an agent knows about a buyer before it dials: every call so far, who
 * took it and how it ended, what the buyer already told us, where the lead
 * stands, and why this call is being made. Pure, covered by `check:logic`.
 *
 * Two variables carry it (`callMemory()`), both plain English the agent's
 * prompt reads, never says aloud as written:
 *
 * - `call_context` is why THIS call: a call back the buyer asked for (open
 *   by saying so, then carry on from where it stopped), a try after a missed
 *   call, or a first call.
 * - `call_history` is the lead's story so far, newest call first, and what
 *   is already known, so the agent never asks for it again.
 *
 * Both are short, because the agent reads them on every turn, and any phone
 * number in a summary is struck out, because the agent reads it as its own
 * memory and a number is nothing it should say.
 */

import { OUTCOME, agentLabel, type AgentKind, type Outcome } from "./call-rules.ts";
import { callbackDelayMs, ist } from "./cadence-rules.ts";
import { FIELDS, stageLabel, type Facts, type StageKey } from "./lead-rules.ts";
import { redactPhones } from "./mask-rules.ts";

/** The longest `call_history` a call carries. */
export const CALL_HISTORY_MAX = 1100;
/** The most calls the history lists, newest first. */
export const CALL_HISTORY_CALLS = 5;
/** The longest note one call keeps in the history. */
const NOTE_MAX = 220;
/** The longest remark from a call list a call carries, whole. */
export const SHEET_MAX = 600;

/** One call to this buyer, by our AI or by a person. */
export type PriorCall = {
  at: string;
  /** The AI agent that rang, or null for a person ringing from their own phone. */
  agent: AgentKind | null;
  /** The person who rang or who placed it, by first name, when known. */
  person: string | null;
  answered: boolean;
  seconds: number | null;
  outcome: Outcome | null;
  /** The agent's summary, or a goal call's note. */
  note: string | null;
  /** What a person sent the call to do, when it had a goal. */
  goal: string | null;
  /** Put through to the sales team on the call. */
  handedTo: string | null;
  /** The project it was about, when it was another of this buyer's enquiries. */
  about?: string | null;
};

/** Why this call is being made. */
export type CallReason =
  /** `proven`: the buyer's own words (or a person's note) asked for it; otherwise only our notes did. */
  | { kind: "callback"; askedAt: string; said: readonly string[]; proven?: boolean }
  /** The agent was putting the buyer through to sales on the call at `at`, and nobody picked up. */
  | { kind: "handoff_missed"; at: string }
  /** The last call went dead mid-conversation; `asked` is the agent's last, unanswered line. */
  /** `proven`: the carrier says the network ended the call; otherwise who hung up is unknown. */
  | { kind: "dropped"; at: string; asked: string | null; proven?: boolean }
  | { kind: "retry"; missed: number }
  /** A follow-up some days after the site visit, to ask where they stand. */
  | { kind: "after_visit"; visitAt: string; day: number | null }
  /**
   * The buyer rang our number. `last` is our newest call to them, if any:
   * missed means this is most likely them calling back.
   */
  | { kind: "rang_us"; last: { at: string; answered: boolean } | null }
  | { kind: "first" }
  | { kind: "other" };

export type CallMemoryInput = {
  nowIso: string;
  calls: readonly PriorCall[];
  stage: StageKey;
  facts: Facts;
  /** A visit still on, as the buyer would hear it ("Sunday 4 Oct, 3:00 pm"). */
  visit: string | null;
  /** What the buyer said they must have, or why the project did not suit them. */
  wants?: string | null;
  /** What the call list's sheet said about this person, their remark as typed. */
  sheet?: string | null;
  reason: CallReason;
};

const oneLine = (s: string | null | undefined, max: number) => {
  if (!s) return "";
  const line = redactPhones(s.replace(/\s+/g, " ").trim(), "MASKED");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** "3 Oct, 10:15 am", or "today, 10:15 am" when it is today in India. */
export function whenSaid(iso: string, nowIso: string): string {
  const t = ist(iso);
  const h = t.hour % 12 || 12;
  const time = `${h}:${String(t.minute).padStart(2, "0")} ${t.hour < 12 ? "am" : "pm"}`;
  if (t.date === ist(nowIso).date) return `today, ${time}`;
  const d = new Date(`${t.date}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}, ${time}`;
}

/** "5 minutes", "half an hour", "2 hours". */
export function waitWords(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min === 30) return "half an hour";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? "" : "s"}` : `${min} minutes`;
}

function who(c: PriorCall): string {
  if (!c.agent) return c.person ? `${c.person} from the sales team, from their own phone` : "the sales team";
  const job = c.agent === "goal" ? "AI caller, sent to do one thing" : `AI ${agentLabel(c.agent).toLowerCase()}`;
  return c.person ? `${job} (placed by ${c.person})` : job;
}

function callLine(c: PriorCall, nowIso: string): string {
  const head = `${whenSaid(c.at, nowIso)}, ${who(c)}${c.about ? `, about ${c.about}` : ""}`;
  if (!c.answered) return `${head}: not answered.`;
  const len = c.seconds ? ` (${Math.floor(c.seconds / 60)}:${String(Math.round(c.seconds % 60)).padStart(2, "0")})` : "";
  // "Call back" read as "they asked for this call": on 29 October 2026 the
  // next call opened "calling back as you said" to a buyer who had said he
  // would ring himself.
  const how = c.outcome === "CALLBACK" ? "Left for later" : c.outcome ? OUTCOME[c.outcome].label : "Answered";
  const goal = c.goal ? ` Asked to: ${oneLine(c.goal, 120)}.` : "";
  const handed = c.handedTo ? ` Put through to ${c.handedTo}.` : "";
  const note = c.note ? ` ${oneLine(c.note, NOTE_MAX)}` : "";
  return `${head}, answered${len}: ${how}.${goal}${note}${handed}`;
}

/** What the buyer already told us, in the board's words. */
export function knownLines(f: Facts): string[] {
  const keys = ["config", "budget", "timeline", "interest", "objection", "owner"] as const;
  return keys.filter((k) => f[k]).map((k) => `${k === "owner" ? "Their sales contact" : FIELDS[k].label}: ${f[k]}`);
}

/** Why this call, as the agent should open it. Empty for an ordinary first call. */
/**
 * Whether a buyer's own words asked for a call back: "call me later", "baad
 * mein call karo", "thodi der baad", "nantar phone kara", "evening mein".
 */
export function asksCallback(text: string | null | undefined): boolean {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(call|phone|ring)\b.{0,30}\b(back|later|again|tomorrow|evening|morning|afternoon|night|after)\b/.test(t) ||
    /\b(baad|bad|phir|dobara|fir|nantar|parat|punha|thodi der|thoda time|kal|sham|shaam|subah|raat)\b.{0,30}\b(call|phone|karo|karna|kijiye|kara|kar)\b/.test(t) ||
    /(बाद में|थोड़ी देर|फिर से|दोबारा|कल|शाम|सुबह|नंतर|परत|पुन्हा|संध्याकाळी|उद्या).{0,30}(कॉल|फोन|कर)/.test(t) ||
    /(कॉल|फोन).{0,20}(बाद में|थोड़ी देर|फिर से|दोबारा|नंतर|परत|पुन्हा)/.test(t)
  );
}

export function callContext(r: CallReason, nowIso: string): string {
  switch (r.kind) {
    case "callback": {
      if (r.proven === false) {
        return (
          `This is a SECOND CALL to this buyer. On the call at ${whenSaid(r.askedAt, nowIso)} our notes say a call back was wanted, but the buyer's own words did not ask for one. ` +
          "Open normally: say who is calling and why. Never say they asked you to call back. Carry on from where things stand below and do not ask again what is already known."
        );
      }
      const wait = callbackDelayMs(r.said);
      const asked = wait ? `asked you to call back in ${waitWords(wait)}` : "asked you to call back";
      return (
        `This is a CALL BACK. On the call at ${whenSaid(r.askedAt, nowIso)} the buyer ${asked}. ` +
        "Open by saying you are calling back as they asked (for example: \"Namaste ji, aapne kaha tha thodi der baad call karne ko, isliye call kiya\"), " +
        "then carry on from where that call stopped. Do not start the conversation again from the beginning."
      );
    }
    case "handoff_missed":
      return (
        `This is a CALL BACK. On the call at ${whenSaid(r.at, nowIso)} you were putting the buyer through to the sales manager, ` +
        "but nobody could pick up and the line dropped. Open by saying sorry, the sales manager could not pick up just now, " +
        "in the user's language (Hindi such as \"Sorry ji, sales manager abhi call utha nahi paaye, isliye maine wapas call kiya\"; " +
        "Marathi such as \"Sorry, sales manager aata call uchlu shakle nahit, mhanun mi parat call kela\"), " +
        "and that a sales manager will call them back soon. Then carry on helping from where that call stopped. " +
        "Do not try to connect them to the sales team again on this call."
      );
    case "dropped": {
      const asked = oneLine(r.asked, 200);
      if (r.proven !== true) {
        return (
          `This is a SECOND CALL today. The call at ${whenSaid(r.at, nowIso)} ended` +
          (asked ? ` before they answered your question "${asked}"` : " early") +
          ". You do not know who ended it: never say the call was cut, that the line dropped or that the network was bad. " +
          "Open normally, saying who is calling and why, and once that is done ask that question again if it still fits. Do not start the conversation again from the beginning."
        );
      }
      return (
        `This is a CALL BACK. The call at ${whenSaid(r.at, nowIso)} was cut off in the middle` +
        (asked ? `: you had just said "${asked}" and the line went dead before they answered. ` : ". ") +
        "Open by saying the call got cut, so you are calling back, in the user's language " +
        "(Hindi such as \"Sir, aapse baat ho rahi thi aur call achanak cut ho gaya, isliye maine wapas call kiya hai\"; " +
        "Marathi such as \"Sir, aapla bolna chalu hota ani call achanak cut jhala, mhanun mi parat call kela aahe\"), " +
        "then pick up from exactly that point" + (asked ? " and ask that question again" : "") +
        ". Do not start the conversation again from the beginning."
      );
    }
    case "after_visit":
      return (
        `This is a FOLLOW-UP after the site visit on ${whenSaid(r.visitAt, nowIso)}` +
        (r.day ? ` (day ${r.day} after it)` : "") +
        ". Remind them warmly that they visited, then ask, one at a time: how they feel about the home now, " +
        "whether the family has decided, and what is still holding them back. Do not ask the qualifying questions again. " +
        "Never discuss a discount or negotiate the price: if they want to talk price, block a flat or book, offer to put them " +
        "through to the sales team with connect_sales. If they want to see it again, agree a day and time for another visit. " +
        "If they need more time, say you will check in again in a couple of days, and end politely."
      );
    case "rang_us": {
      if (r.last && !r.last.answered) {
        return (
          `The buyer is CALLING YOU BACK. You rang them at ${whenSaid(r.last.at, nowIso)} and they could not pick up. ` +
          "The opening line has already thanked them for calling back and said what you rang about: do not say it again. " +
          "Carry on from their answer and from where things stand below. Do not ask again what is already known."
        );
      }
      if (r.last) {
        return (
          `The buyer is CALLING YOU. You have spoken before, most recently at ${whenSaid(r.last.at, nowIso)}. ` +
          "The opening line has already greeted them by name as someone you know. Carry on from their answer and from where that call stopped. " +
          "Do not greet them again, do not start over, and do not ask again what is already known."
        );
      }
      return "The buyer is CALLING YOU. They enquired before, but this is the first time you speak; the opening line has already greeted them and named the project.";
    }
    case "retry":
      return `Earlier calls to this buyer were not answered (${r.missed} so far). Do not mention the missed calls; start normally.`;
    case "first":
    case "other":
      return "";
  }
}

/** The lead's story so far, newest call first, and what is already known. */
export function callHistory(i: CallMemoryInput): string {
  // A list's remark travels whole, ahead of the calls, and is never trimmed
  // to fit them: it was only ever the source of a one-line goal, and a remark
  // with a budget in it made no goal at all (30 October 2026).
  const said = oneLine(i.sheet, SHEET_MAX);
  const sheet = said && !/[.!?…]$/.test(said) ? `${said}.` : said;
  const head = sheet
    ? `Your team's own notes on this person, from the sheet they were called from: ${sheet} Use these to know what they want and how to talk to them. Do not read them out, and quote no price but the facts' own.`
    : "";
  const rest = callsSoFar(i, head ? CALL_HISTORY_MAX - head.length - 1 : CALL_HISTORY_MAX);
  return [head, rest].filter(Boolean).join("\n");
}

function callsSoFar(i: CallMemoryInput, max: number): string {
  const answered = i.calls.filter((c) => c.answered).length;
  if (!i.calls.length || max < 80) return "";
  const lines = [`Calls so far: ${i.calls.length} (${answered} answered). Newest first:`];
  for (const c of i.calls.slice(0, CALL_HISTORY_CALLS)) lines.push(`- ${callLine(c, i.nowIso)}`);
  lines.push(`Where the lead stands: ${stageLabel(i.stage)}.`);
  if (i.visit) lines.push(`Site visit booked: ${i.visit}. Do not offer a new visit; confirm or move this one only if they ask.`);
  const known = knownLines(i.facts);
  const wants = oneLine(i.wants, 120);
  if (wants) known.push(`Must have, as they said: ${wants}`);
  if (known.length) lines.push(`Already known: ${known.join("; ")}. Do not ask for these again; confirm only if something sounds different.`);
  let out = lines.join("\n");
  // Drop the oldest calls first when it runs long, never the known facts.
  while (out.length > max && lines.length > 3) {
    const lastCall = lines.findLastIndex((l) => l.startsWith("- "));
    if (lastCall <= 1) break;
    lines.splice(lastCall, 1);
    out = lines.join("\n");
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** The two variables a call carries. */
export function callMemory(i: CallMemoryInput): { call_context: string; call_history: string } {
  return { call_context: callContext(i.reason, i.nowIso), call_history: callHistory(i) };
}

/**
 * One buyer's facts across their enquiries: this one's own first, then
 * whatever another enquiry already holds and this one does not. A buyer who
 * told us their budget about one project is not asked it again about the
 * next. Only the board's own fields; a stage and its dates stay each lead's.
 */
export function buyerFacts(own: Facts | null | undefined, others: readonly (Facts | null | undefined)[]): Facts {
  const out: Facts = { ...(own ?? {}) };
  for (const k of ["config", "budget", "timeline", "objection"] as const) {
    if (out[k]) continue;
    const from = others.find((o) => o?.[k]);
    if (from?.[k]) out[k] = from[k];
  }
  return out;
}
