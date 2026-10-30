/**
 * The call log: what one call was, and what a list of them adds up to.
 *
 * Pure and database-free, covered by `check:logic`. The record is shaped after
 * what Sarvam posts to a webhook when an outbound attempt ends (attempt id,
 * connectivity, duration, recording, the agent's variables at the end, the
 * transcript turn by turn), so the day a calls table exists the screen reads
 * rows instead of samples and nothing here changes.
 *
 * Every time is shown in Asia/Kolkata whatever offset it arrived with. Sarvam
 * sends conversation times in UTC and the attempt time with an offset, and a
 * call placed at 9:40 pm IST is on the next UTC day: a log that grouped by the
 * UTC date would file the evening's calls under tomorrow.
 */

import { addDays, showDate, showTime } from "./lead-rules.ts";
import type { Shown } from "./mask-rules.ts";

export type Connectivity = "connected" | "no_answer" | "busy" | "failed";

/** The calling jobs section 02 gives the AI. */
export type AgentKind = "qualifier" | "reminder" | "recovery" | "reengage" | "post_visit" | "goal" | "receptionist";

export const AGENTS: { key: AgentKind; label: string }[] = [
  { key: "qualifier", label: "Lead qualifier" },
  { key: "reminder", label: "Visit confirmation" },
  { key: "recovery", label: "No-show recovery" },
  { key: "reengage", label: "Follow-up" },
  { key: "post_visit", label: "After the visit" },
  { key: "goal", label: "Goal" },
  { key: "receptionist", label: "Answered a call in" },
];

export const agentLabel = (k: AgentKind) => AGENTS.find((a) => a.key === k)?.label ?? k;

/**
 * The jobs with a Sarvam agent of their own. Each is a copy of the qualifier
 * (same voice, settings and hand-off) with its role written into the prompt:
 * the visit confirmer confirms a visit and rebooks a missed one, the
 * re-engager follows a lead up, and the post-visit agent asks how a visit
 * went.
 */
export type RoleAgent = "confirmer" | "reengager" | "post_visit";

export function roleAgentFor(agent: AgentKind): RoleAgent | null {
  if (agent === "reminder" || agent === "recovery") return "confirmer";
  if (agent === "reengage") return "reengager";
  if (agent === "post_visit") return "post_visit";
  return null;
}

/**
 * What a call does while its job's agent is not set up. A no-show call and a
 * follow-up call ran on the qualifier before their agents existed, and still
 * do rather than stop. A confirmation call and a post-visit call are new:
 * without their agent they are not placed, and a WhatsApp does the job.
 */
export function withoutOwnAgent(agent: AgentKind): "qualifier" | "not_placed" {
  return agent === "reminder" || agent === "post_visit" ? "not_placed" : "qualifier";
}

export type Language = "hi" | "mr" | "en";

/**
 * The languages a call may open in: a lead's own, and the language of the
 * state the project is in (Kannada, Tamil, Telugu, Bengali, Gujarati), which
 * `openingLanguage()` picks for a buyer whose name says nothing else.
 */
export type CallLanguage = Language | "kn" | "ta" | "te" | "bn" | "gu";

export const LANGUAGE_LABEL: Record<Language, string> = {
  hi: "Hindi",
  mr: "Marathi",
  en: "English",
};

export type Outcome =
  | "HANDED_OFF"
  | "QUALIFIED"
  | "COLD"
  | "BAD_LINE"
  | "VISIT_CONFIRMED"
  | "VISIT_MOVED"
  | "VISIT_CANCELLED"
  | "CALLBACK"
  | "NOT_INTERESTED"
  | "BROKER"
  | "WRONG_NUMBER"
  | "HUNG_UP"
  | "OPTED_OUT"
  | "NO_ANSWER"
  | "BUSY"
  | "DECLINED"
  | "SCREENED"
  | "NO_REPLY"
  | "NOT_IN_SERVICE"
  | "SWITCHED_OFF"
  | "FAILED"
  | "CALLING"
  | "NO_REPORT"
  | "NOT_PLACED";

export type Tone = "ok" | "blue" | "warn" | "risk" | "quiet";

export const OUTCOME: Record<Outcome, { label: string; tone: Tone }> = {
  HANDED_OFF: { label: "Handed to sales", tone: "blue" },
  // The agent rated it hot or warm and the call was not read. "Qualified"
  // is the board's stage, never a call's: the agent's word is not that.
  QUALIFIED: { label: "Warm lead", tone: "ok" },
  // Answered the questions and is not ready, or the project does not fit.
  COLD: { label: "Cold lead", tone: "quiet" },
  // Picked up, but nothing could be heard or said: no verdict on the lead.
  BAD_LINE: { label: "Bad line", tone: "warn" },
  VISIT_CONFIRMED: { label: "Visit confirmed", tone: "ok" },
  VISIT_MOVED: { label: "Visit moved", tone: "ok" },
  VISIT_CANCELLED: { label: "Visit cancelled", tone: "warn" },
  CALLBACK: { label: "Call back", tone: "warn" },
  NOT_INTERESTED: { label: "Not interested", tone: "quiet" },
  BROKER: { label: "Broker", tone: "quiet" },
  WRONG_NUMBER: { label: "Wrong number", tone: "quiet" },
  HUNG_UP: { label: "Hung up", tone: "quiet" },
  // Red because it is the one outcome that forbids something: this number is
  // never dialled again, by us or by anybody the tenant hands the list to.
  OPTED_OUT: { label: "Opted out", tone: "risk" },
  NO_ANSWER: { label: "No answer", tone: "quiet" },
  BUSY: { label: "Line busy", tone: "quiet" },
  // The phone rang and the person cut it: the carrier's USER_BUSY after
  // seconds of ringing, or CALL_REJECTED (`carrierOutcome()`).
  DECLINED: { label: "Declined", tone: "quiet" },
  // The phone's call screener (an iPhone's, Truecaller's) answered and the
  // person never came on: tried again like a call nobody picked up.
  SCREENED: { label: "Call screener answered", tone: "quiet" },
  // Picked up, and the agent heard nobody: a screener it could not hear, a
  // pocket, a dead line. Tried again like a call nobody picked up.
  NO_REPLY: { label: "Picked up, no reply", tone: "quiet" },
  NOT_IN_SERVICE: { label: "Number not in service", tone: "warn" },
  SWITCHED_OFF: { label: "Switched off", tone: "quiet" },
  FAILED: { label: "Did not connect", tone: "warn" },
  CALLING: { label: "Calling now", tone: "blue" },
  // Placed long enough ago that it cannot still be ringing, and no result
  // has come back. Not "Calling now", which it has not been for a while.
  NO_REPORT: { label: "No result yet", tone: "warn" },
  NOT_PLACED: { label: "Not placed", tone: "warn" },
};

/**
 * What happens after this call. A retry is the dialler's; a callback is a
 * time the buyer asked for; `sales` is a live hand-off, and one nobody picked
 * up turns into a callback owed by that person rather than disappearing.
 */
export type NextStep =
  | { kind: "none" }
  | { kind: "never" }
  | { kind: "retry"; at: string; done: boolean }
  | { kind: "callback"; at: string; done: boolean; by?: string }
  | { kind: "visit"; at: string }
  | { kind: "sales"; who: string };

export type Turn =
  | { role: "agent" | "user"; en: string; indic: string | null }
  | { role: "event"; en: string };

export type Fact = { label: string; value: string | null };

export type CallRecord = {
  /** Sarvam's attempt id. */
  id: string;
  leadId: string;
  leadName: string;
  /**
   * The buyer's number as this viewer may see it (`98XXXXXX21` unless the
   * policy shows it whole). The dialled number never leaves the server.
   */
  phone: Shown;
  /** The tower the enquiry was about. */
  place: string;
  agent: AgentKind;
  agentVersion: number;
  /** The number the call went out from. */
  from: string;
  /** ISO 8601 with an offset. */
  startedAt: string;
  connectivity: Connectivity;
  /** Seconds of conversation. Null when nobody picked up. */
  duration: number | null;
  /** 1 is the first try. */
  attempt: number;
  maxAttempts: number;
  language: Language;
  outcome: Outcome;
  next: NextStep;
  recordingUrl: string | null;
  summary: string | null;
  keyPoints: string[];
  /** What the buyer said, field by field. A field they never spoke to is null. */
  facts: Fact[];
  transcript: Turn[];
  /** True when the turns were left out of the list, to be fetched when the call is opened. */
  transcriptLater?: true;
  /** The qualifier's read on the lead, when it ran. */
  temp: "HOT" | "WARM" | "COLD" | null;
  /** A site visit was booked on this call: it reads "Visit booked", never hot, warm or cold. */
  visitBooked?: boolean;
  /** True while a real call is still ringing or talking. */
  live?: boolean;
  /** What a person sent the call to do, and how the agent says it went. */
  goal?: CallGoalResult | null;
};

export type GoalStatus = "done" | "partly" | "not_done";

export type CallGoalResult = { text: string; status: GoalStatus | null; note: string | null };

export const GOAL_STATUS: Record<GoalStatus, { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "ok" },
  partly: { label: "Partly done", tone: "warn" },
  not_done: { label: "Not done", tone: "quiet" },
};

/** What the goal agent recorded about its goal. Anything else it wrote reads as nothing. */
export function goalResult(text: string, vars: Record<string, unknown> | null): CallGoalResult {
  const s = typeof vars?.goal_status === "string" ? vars.goal_status.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  const status = s === "done" || s === "partly" || s === "not_done" ? (s as GoalStatus) : null;
  const note = typeof vars?.goal_note === "string" && vars.goal_note.trim() ? vars.goal_note.trim().slice(0, 300) : null;
  return { text, status, note };
}

// ---------------------------------------------------------------------------
// From Sarvam's payload to an outcome
// ---------------------------------------------------------------------------

const QUALIFIER_OUTCOMES: Record<string, Outcome> = {
  QUALIFIED: "QUALIFIED",
  CALLBACK: "CALLBACK",
  NOT_INTERESTED: "NOT_INTERESTED",
  WRONG_NUMBER: "WRONG_NUMBER",
  BROKER: "BROKER",
  NO_ANSWER: "NO_ANSWER",
};

/**
 * The qualifier's `lead_disposition`. Only hot and warm are qualified; a
 * cold lead answered the questions and is not ready, or the project does not
 * fit, and reading it as "Qualified" told the sales head the opposite. A
 * voicemail is nobody answering: the agent hangs up without a message, and
 * the lead is dialled again rather than booked as a callback.
 */
const DISPOSITIONS: Record<string, Outcome> = {
  hot_lead: "QUALIFIED",
  warm_lead: "QUALIFIED",
  cold_lead: "COLD",
  callback_requested: "CALLBACK",
  not_interested: "NOT_INTERESTED",
  wrong_person: "WRONG_NUMBER",
  voicemail: "NO_ANSWER",
};

/**
 * One outcome per attempt, from the fields Sarvam sends.
 *
 * Order matters and is the rule: a call that never connected has no
 * conversation to read, so connectivity decides it first; an opt-out beats
 * everything the conversation otherwise produced, because it is the one
 * answer that binds every later call; a transfer beats the agent's own
 * outcome, because the agent writes "qualified" and then hands over, and the
 * hand-over is what the sales head needs to see. A connected call whose agent
 * recorded nothing is a hang-up, not a success.
 */
export function outcomeOf(p: {
  agent: AgentKind;
  connectivity: Connectivity | null;
  vars: Record<string, unknown> | null;
  transferred: boolean;
  /** What was said, when known: a call where nothing got through is a bad line, not a verdict. */
  turns?: readonly { role: string; text: string }[];
  /** Why it did not connect, as Sarvam or the carrier said: tells a declined call from a busy line. */
  failureReason?: string | null;
}): Outcome {
  if (p.connectivity === "no_answer") return "NO_ANSWER";
  const why = p.failureReason ?? "";
  if (p.connectivity === "busy") return /^Declined/.test(why) ? "DECLINED" : "BUSY";
  if (p.connectivity !== "connected") {
    if (/^Number not in service/.test(why)) return "NOT_IN_SERVICE";
    if (/^Switched off/.test(why)) return "SWITCHED_OFF";
    return "FAILED";
  }

  const v = p.vars ?? {};
  if (v.opt_out === true || v.opt_out === "true" || v.lead_disposition === "dnc") return "OPTED_OUT";
  if (p.transferred) return "HANDED_OFF";

  // A cold rating on a call that got nowhere is the line, not the buyer. A
  // hot or warm one is believed unless the buyer said nothing at all.
  const rated = (o: Outcome | undefined) =>
    p.turns && ((o === "COLD" && badLine(p.turns, v)) || (o === "QUALIFIED" && badLine(p.turns, v, true))) ? "BAD_LINE" : o;
  const qualified = () =>
    rated((typeof v.outcome === "string" ? QUALIFIER_OUTCOMES[v.outcome] : undefined) ??
      (typeof v.lead_disposition === "string" ? DISPOSITIONS[v.lead_disposition] : undefined));
  if (p.agent === "qualifier") return qualified() ?? "HUNG_UP";

  // Every other agent is a copy of the qualifier, so it records the
  // qualifier's fields too. The visit confirmer's `visit_status` says what
  // the call was for, so it is read first.
  const visit = typeof v.visit_status === "string" ? v.visit_status.trim().toUpperCase() : "";
  if (visit === "CONFIRMED") return "VISIT_CONFIRMED";
  if (visit === "MOVED") return "VISIT_MOVED";
  if (visit === "CANCELLED") return "VISIT_CANCELLED";
  if (v.outcome === "CALLBACK") return "CALLBACK";
  if (v.outcome === "NOT_INTERESTED") return "NOT_INTERESTED";
  return qualified() ?? "HUNG_UP";
}

/** The fields a qualifying call fills; one of them known means the call got somewhere. */
const LEARNT_FIELDS = ["bhk_preference", "budget", "location_preference", "purchase_timeline"];
const UNKNOWN_VALUE = /^(|not[ _]specified|unknown|none|null|n\/?a|not[ _]booked|not[ _]asked)$/i;
/** A reply that says nothing: a greeting, a yes, a "what?". */
const FILLER_WORD =
  /^(hello|hallo|helo|hi|hey|haan|han|ha|haa|hmm|hm|ji|jee|yes|yeah|yah|ok|okay|sorry|what|who|kya|kaun|bolo|boliye|ho|हाँ|हां|हा|हैलो|हेलो|हॅलो|जी|क्या|कौन|हो|बोलो|बोलिए)$/i;
/** The buyer saying the line is the problem. */
const CANT_HEAR =
  /can'?t hear|cannot hear|could not hear|not audible|no sound|voice is (not|breaking)|awaaz|aawaz|awaz|sunai nahi|aiku yet nahi|आवाज़|आवाज|सुनाई नहीं|ऐकू येत नाही/i;

/**
 * Whether a call that connected got nowhere because of the line: the agent
 * learnt nothing, no visit was agreed, and the buyer only said hello, could
 * not hear, or a few unclear words. Such a call was rated cold by the agent
 * and read as "Qualified" on the call log; it is neither.
 */
export function badLine(turns: readonly { role: string; text: string }[], vars: Record<string, unknown>, strict = false): boolean {
  const goal = typeof vars.goal_status === "string" ? vars.goal_status.trim().toLowerCase() : "";
  if (goal === "done" || goal === "partly") return false;
  const known = (k: string) => typeof vars[k] === "string" && !UNKNOWN_VALUE.test((vars[k] as string).trim());
  if (LEARNT_FIELDS.some(known)) return false;
  if (typeof vars.site_visit_status === "string" && vars.site_visit_status.trim().toLowerCase() === "booked") return false;
  const buyer = turns.filter((t) => t.role === "user" && t.text.trim()).map((t) => t.text);
  if (!buyer.length) return false;
  if (buyer.some((t) => CANT_HEAR.test(t))) return true;
  const words = buyer
    .join(" ")
    .split(/[\s,.!?।"'()]+/)
    .filter((w) => w && !FILLER_WORD.test(w));
  return words.length <= (strict ? 0 : 4);
}

// ---------------------------------------------------------------------------
// Time, in Asia/Kolkata
// ---------------------------------------------------------------------------

const IST_MS = 330 * 60_000;

/** `2026-09-24T11:42` for any ISO instant, read in IST. */
function istStamp(iso: string): string {
  return new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 16);
}

/** The IST calendar date an instant falls on. */
export const istDate = (iso: string) => istStamp(iso).slice(0, 10);

/** `HH:MM` in IST. */
export const istTime = (iso: string) => istStamp(iso).slice(11, 16);

/** Two lines for a table cell: the time, and which day. */
export function whenLabel(iso: string, today: string): { time: string; day: string } {
  const d = istDate(iso);
  const day = d === today ? "Today" : d === addDays(today, -1) ? "Yesterday" : showDate(d);
  return { time: showTime(istTime(iso)), day };
}

/** `today, 7:00 pm` or `Sat 26 Sep, 11:00 am`, to sit inside a sentence. */
export function momentLabel(iso: string, today: string): string {
  const d = istDate(iso);
  const day =
    d === today
      ? "today"
      : d === addDays(today, 1)
        ? "tomorrow"
        : d === addDays(today, -1)
          ? "yesterday"
          : showDate(d);
  return `${day}, ${showTime(istTime(iso))}`;
}

/** `3:12`, and `1:02:09` past the hour. */
export function durationLabel(seconds: number | null): string {
  if (seconds === null) return "0:00";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * `+91 98••• ••210`. Enough to tell two leads apart on a list and not enough
 * to dial: the full number is behind `lead.phone:unmask`.
 */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (e164.startsWith("+91") && digits.length === 12) {
    const n = digits.slice(2);
    return `+91 ${n.slice(0, 2)}••• ••${n.slice(7)}`;
  }
  if (digits.length < 6) return "•••";
  return `+${digits.slice(0, 2)} •••• ${digits.slice(-3)}`;
}

/** `+91 98765 43210`, the way the number is read aloud. */
export function showPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (e164.startsWith("+91") && digits.length === 12) {
    const n = digits.slice(2);
    return `+91 ${n.slice(0, 5)} ${n.slice(5)}`;
  }
  return e164;
}

// ---------------------------------------------------------------------------
// Periods, views and search
// ---------------------------------------------------------------------------

export type Period = "today" | "week" | "month";

export const PERIODS: { key: Period; label: string; noun: string }[] = [
  { key: "today", label: "Today", noun: "today" },
  { key: "week", label: "7 days", noun: "in 7 days" },
  { key: "month", label: "This month", noun: "this month" },
];

/** Every IST date in the period, oldest first. */
export function periodDays(period: Period, today: string): string[] {
  if (period === "today") return [today];
  const n = period === "week" ? 7 : Number(today.slice(8, 10));
  return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
}

export type View =
  | "all"
  | "picked"
  | "missed"
  | "qualified"
  | "handed"
  | "followup"
  | "optout";

export const VIEWS: { key: View; label: string }[] = [
  { key: "all", label: "All calls" },
  { key: "picked", label: "Picked up" },
  { key: "missed", label: "Not picked up" },
  { key: "qualified", label: "Hot or warm" },
  { key: "handed", label: "Handed to sales" },
  { key: "followup", label: "Follow-up due" },
  { key: "optout", label: "Opted out" },
];

/**
 * What the call log says a call came to. A call that reached a verdict on the
 * buyer says hot, warm or cold as our own score read it (`temp`, the call's
 * temperature once read); the agent's own rating is only the fallback.
 */
export function verdictOf(c: Pick<CallRecord, "outcome" | "temp"> & { visitBooked?: boolean }): { label: string; tone: Tone } {
  // A booked visit is the verdict, whatever the score said (the client, 18 October 2026).
  if (c.visitBooked && (c.outcome === "QUALIFIED" || c.outcome === "COLD" || c.outcome === "HANDED_OFF")) {
    return { label: "Visit booked", tone: "ok" };
  }
  if ((c.outcome === "QUALIFIED" || c.outcome === "COLD") && c.temp) {
    return c.temp === "HOT"
      ? { label: "Hot lead", tone: "ok" }
      : c.temp === "WARM"
        ? { label: "Warm lead", tone: "blue" }
        : { label: "Cold lead", tone: "quiet" };
  }
  return OUTCOME[c.outcome];
}

/** A buyer worth working: put through to sales, or read hot or warm. */
export function hotOrWarm(c: Pick<CallRecord, "outcome" | "temp"> & { visitBooked?: boolean }): boolean {
  if (c.outcome === "HANDED_OFF") return true;
  if (c.visitBooked && (c.outcome === "QUALIFIED" || c.outcome === "COLD")) return true;
  if (c.outcome !== "QUALIFIED" && c.outcome !== "COLD") return false;
  return c.temp ? c.temp !== "COLD" : c.outcome === "QUALIFIED";
}

/**
 * Whether a person answered. A call that connected to voicemail reports
 * "connected" and is recorded as NO_ANSWER, and counting it as picked up put
 * the call log at 4 and Ask Jimmy at 5 for the same day. The one rule both
 * use (`calls_connected` in `ask-rules.ts` writes it in SQL).
 */
export function pickedUp(c: Pick<CallRecord, "connectivity" | "outcome">): boolean {
  return c.connectivity === "connected" && c.outcome !== "NO_ANSWER";
}

/** A follow-up is owed when a retry or a callback is set and nothing has happened since. */
export function followUpDue(c: CallRecord): boolean {
  return (c.next.kind === "retry" || c.next.kind === "callback") && !c.next.done;
}

export function followUpAt(c: CallRecord): string | null {
  return c.next.kind === "retry" || c.next.kind === "callback" ? c.next.at : null;
}

export type NextTone = "due" | "overdue" | "done" | "plain" | "stop";

/**
 * The next-step cell. Overdue is its own tone because it is the only one
 * that is somebody's failure rather than the calendar's.
 */
export function nextLabel(c: CallRecord, today: string, nowIso: string): { text: string; tone: NextTone } {
  const n = c.next;
  const late = (iso: string) => Date.parse(iso) < Date.parse(nowIso);
  switch (n.kind) {
    case "retry":
      if (n.done) return { text: "Tried again", tone: "done" };
      return { text: `Tries again ${momentLabel(n.at, today)}`, tone: late(n.at) ? "overdue" : "due" };
    case "callback": {
      if (n.done) return { text: n.by ? `${n.by} called back` : "Called back", tone: "done" };
      const who = n.by ? `${n.by} to call back` : "Call back";
      return late(n.at)
        ? { text: `${who}, overdue since ${showTime(istTime(n.at))}`, tone: "overdue" }
        : { text: `${who} ${momentLabel(n.at, today)}`, tone: "due" };
    }
    case "visit":
      return { text: `Visit ${momentLabel(n.at, today)}`, tone: "plain" };
    case "sales":
      return { text: `With ${n.who}`, tone: "plain" };
    case "never":
      return { text: "Never call again", tone: "stop" };
    case "none":
      return c.connectivity !== "connected" && c.attempt >= c.maxAttempts
        ? { text: `Tried ${c.maxAttempts} times`, tone: "done" }
        : { text: "Nothing more", tone: "done" };
  }
}

export function inView(c: CallRecord, view: View): boolean {
  switch (view) {
    case "all":
      return true;
    case "picked":
      return pickedUp(c);
    case "missed":
      return !pickedUp(c);
    case "qualified":
      return hotOrWarm(c);
    case "handed":
      return c.outcome === "HANDED_OFF";
    case "followup":
      return followUpDue(c);
    case "optout":
      return c.outcome === "OPTED_OUT";
  }
}

/**
 * A name, a tower, or digits of the number. Digits are matched against what
 * this viewer can see of it, so a masked number matches on its first two and
 * last two. A whole number typed in is answered by the server instead
 * (`numberLeads`, the leads carrying it), because the browser never holds
 * the whole number to compare against.
 */
export function matchesQuery(c: CallRecord, query: string, numberLeads?: ReadonlySet<string> | null): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3 && digits.length === q.replace(/[\s+-]/g, "").length) {
    if (numberLeads) return numberLeads.has(c.leadId);
    return c.phone.text.replace(/\D/g, "").includes(digits);
  }
  return [c.leadName, c.place, c.leadId].some((s) => s.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// What a list of calls adds up to
// ---------------------------------------------------------------------------

export type CallMetrics = {
  total: number;
  connected: number;
  /** 0 to 1. Null with no calls, rather than a zero that reads as a failure. */
  pickup: number | null;
  qualified: number;
  handed: number;
  followUps: number;
  overdue: number;
  avgTalk: number | null;
  /** Calls per day, oldest first, for the days given. */
  perDay: { date: string; count: number }[];
};

export function callMetrics(calls: readonly CallRecord[], days: readonly string[], nowIso: string): CallMetrics {
  const now = Date.parse(nowIso);
  const connected = calls.filter(pickedUp);
  const talk = connected.reduce((s, c) => s + (c.duration ?? 0), 0);
  const due = calls.filter(followUpDue);
  const byDate = new Map<string, number>();
  for (const c of calls) {
    const d = istDate(c.startedAt);
    byDate.set(d, (byDate.get(d) ?? 0) + 1);
  }
  return {
    total: calls.length,
    connected: connected.length,
    pickup: calls.length ? connected.length / calls.length : null,
    qualified: calls.filter(hotOrWarm).length,
    handed: calls.filter((c) => c.outcome === "HANDED_OFF").length,
    followUps: due.length,
    overdue: due.filter((c) => {
      const at = followUpAt(c);
      return at !== null && Date.parse(at) < now;
    }).length,
    avgTalk: connected.length ? talk / connected.length : null,
    perDay: days.map((date) => ({ date, count: byDate.get(date) ?? 0 })),
  };
}

/**
 * The page buttons to draw: the first, the last, and the pages either side of
 * the one you are on, with a gap wherever pages are skipped. Seven buttons at
 * most, so the row never outgrows a phone.
 */
export function pageItems(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const near = current <= 4 ? [2, 3, 4, 5] : current >= total - 3 ? [total - 4, total - 3, total - 2, total - 1] : [current - 1, current, current + 1];
  const out: (number | "gap")[] = [1];
  if (near[0] > 2) out.push("gap");
  out.push(...near);
  if (near[near.length - 1] < total - 1) out.push("gap");
  out.push(total);
  return out;
}

/** `64%`. */
export const percent = (x: number | null) => (x === null ? "0%" : `${Math.round(x * 100)}%`);

/** `1,248`, grouped the Indian way. */
export const count = (n: number) => n.toLocaleString("en-IN");
