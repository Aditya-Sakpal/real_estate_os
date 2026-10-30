/**
 * What happens to a lead next, and when. Pure and database-free, covered by
 * `check:logic`.
 *
 * Every decision the engine makes about a lead is a function here, fed what
 * just happened and returning the steps to schedule and the move to make.
 * `lead-engine.ts` only reads, writes and runs them, so the cadence can be
 * walked end to end without a database, a phone or a clock.
 *
 * The shape is section 02's: a lead captured inside calling hours is called
 * at once; outside them it is sent a WhatsApp saying when it will be called,
 * and called at ten. An unanswered call is tried again half an hour later,
 * three tries a day for three days, and then the lead is closed. A connected
 * call moves the lead, and what the agent heard decides the
 * rest: a visit booked is confirmed with the site's location and reminded a
 * day and two hours before; a warm lead is called again in two days; a cold
 * one goes to the monthly drip. A visit nobody turned up to is recovered on
 * the ladder `visit-rules.ts` draws. A booking is welcomed, asked for a
 * referral, and checked in on monthly.
 *
 * Automation only ever moves a lead FORWARD, and never out of a stage a
 * person put it in further along. A recovery call that books a visit must
 * not drag a lead in negotiation back to Visit scheduled.
 */

import { CALLING_HOURS } from "./calling-rules.ts";
import type { Connectivity, Outcome } from "./call-rules.ts";
import {
  BUDGETS,
  CONFIGS,
  INTEREST,
  OBJECTIONS,
  TIMELINES,
  VISIT_SLOTS,
  isPath,
  pathIndex,
  type Facts,
  type PathStage,
  type StageKey,
} from "./lead-rules.ts";
import type { MessagePurpose } from "./message-rules.ts";
import { RECOVERY } from "./visit-rules.ts";
import { slotsOn, type VisitHours } from "./visit-hours-rules.ts";

// ---------------------------------------------------------------------------
// The clock, in Asia/Kolkata
// ---------------------------------------------------------------------------

const IST_MS = 330 * 60_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The IST civil date, `HH:MM` and weekday (0 is Sunday) of an instant. */
export function ist(iso: string): { date: string; time: string; hour: number; minute: number; dow: number } {
  const d = new Date(Date.parse(iso) + IST_MS);
  return {
    date: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 16),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

/** The instant of an IST civil date and time. */
export function istAt(date: string, hhmm: string): string {
  return new Date(Date.parse(`${date}T${hhmm}:00Z`) - IST_MS).toISOString();
}

export function inCallingHours(iso: string): boolean {
  const h = ist(iso).hour;
  return h >= CALLING_HOURS.from && h < CALLING_HOURS.to;
}

/**
 * The first instant at or after `iso` inside calling hours. A few minutes
 * past ten rather than ten sharp, spread by `spreadMin`, so a night of
 * captured leads does not ring out in the same second and trip the project's
 * channel limit all at once.
 */
export function nextOpening(iso: string, spreadMin = 0): string {
  if (inCallingHours(iso)) return iso;
  const { date, hour } = ist(iso);
  const day = hour >= CALLING_HOURS.to ? addDays(date, 1) : date;
  const at = Date.parse(istAt(day, `${String(CALLING_HOURS.from).padStart(2, "0")}:00`)) + (5 + (spreadMin % 55)) * MIN;
  return new Date(at).toISOString();
}

/** Later than `iso` by `ms`, and inside calling hours. */
export function laterInHours(iso: string, ms: number, spreadMin = 0): string {
  return nextOpening(new Date(Date.parse(iso) + ms).toISOString(), spreadMin);
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A small, stable spread from an id: the same lead always lands on the same minute. */
export function spreadOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 50;
}

// ---------------------------------------------------------------------------
// "Call me back in five minutes"
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, "twenty five": 25, thirty: 30, forty: 40, "forty five": 45,
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, panch: 5, paanch: 5, pach: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  pandrah: 15, bees: 20, pachchis: 25, tees: 30, chalis: 40, paintalis: 45,
  "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पाँच": 5, "पांच": 5, "छह": 6, "छः": 6, "सात": 7, "आठ": 8, "नौ": 9, "दस": 10,
  "पंद्रह": 15, "बीस": 20, "पच्चीस": 25, "तीस": 30, "चालीस": 40, "पैंतालीस": 45,
};
const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|")})`;
const MINUTES = "(?:minutes?|mins?|minat|minit|मिनट|मिनिट)";
const HOURS = "(?:hours?|hrs?|ghante|ghanta|घंटे|घंटा|घण्टे)";
const HALF_HOUR = /half an hour|aadh[ae] ghant[ae]|आध[ाे] घंट[ेा]/giu;
const HOUR_AND_HALF = /an hour and a half|dedh ghant[ae]|डेढ़ घंट[ेा]/giu;
const SPAN = new RegExp(`(?<![\\p{L}\\p{N}])${NUM}\\s*(?:-\\s*${NUM}\\s*)?(${MINUTES}|${HOURS})(?![\\p{L}])`, "giu");
// Said about calling: "15 minutes from the station" is not a call back.
const ABOUT_A_CALL = /call|कॉल|काल|फ़ोन|फोन|phone|ring|back|वापस|baat|बात|\btry\b/iu;
const toAscii = (s: string) => s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
const numberOf = (w: string) => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w.toLowerCase()] ?? null);

/**
 * How long after the call the buyer asked to be called back, from what was
 * said: the newest line that names a wait wins, and inside a line the last
 * wait named, so "half an hour, sorry, five minutes" is five minutes. Lines
 * come newest first. Null when nobody named one.
 */
export function callbackDelayMs(lines: readonly (string | null | undefined)[]): number | null {
  for (const raw of lines) {
    const line = toAscii(raw ?? "");
    if (!line || !ABOUT_A_CALL.test(line)) continue;
    const found: { at: number; ms: number }[] = [];
    for (const m of line.matchAll(SPAN)) {
      const n = numberOf(m[2] ?? m[1]); // a range ("5-10 minutes") waits the longer
      if (n === null || n <= 0) continue;
      found.push({ at: m.index ?? 0, ms: n * (new RegExp(`^${HOURS}$`, "iu").test(m[3]) ? HOUR : MIN) });
    }
    for (const m of line.matchAll(HALF_HOUR)) found.push({ at: m.index ?? 0, ms: 30 * MIN });
    for (const m of line.matchAll(HOUR_AND_HALF)) found.push({ at: m.index ?? 0, ms: 90 * MIN });
    const last = found.filter((f) => f.ms <= 2 * DAY).sort((a, b) => a.at - b.at).at(-1);
    if (last) return last.ms;
  }
  return null;
}

// "Kal call karna", "call me on Monday evening", "next week"

/** The furthest a call back the buyer named a day for is put, in days. */
export const CALLBACK_MAX_DAYS = 14;

const word = (alts: string) => new RegExp(`(?<![\\p{L}\\p{M}])(?:${alts})(?![\\p{L}\\p{M}])`, "iu");
const AFTER_TOMORROW = word("day after tomorrow|parso|parson|परसों|परसो|parva|परवा");
const TOMORROW = word("tomorrow|tmrw|kal|कल|udya|उद्या");
const TODAY = word("today|aaj|आज");
const NEXT_WEEK = word("next week|agle hafte|agle week|agle hapte|अगले हफ्ते|अगले हफ़्ते|अगले सप्ताह|pudhchya athavdyat|पुढच्या आठवड्यात");
const DAYS_SPAN = new RegExp(`(?<![\\p{L}\\p{N}])${NUM}\\s*(?:days?|din|दिन|divas|दिवस)(?![\\p{L}])`, "iu");
// A later day the buyer named that cannot be read as a date: the next day.
const SOME_LATER_DAY = word(
  "another day|some other day|dusre din|doosre din|kisi aur din|aur kisi din|दूसरे दिन|किसी और दिन|" +
    "after (?:diwali|deepavali|dussehra|dasara|navratri|holi|eid|ganpati|ganesh chaturthi|christmas|new year|the festival)|" +
    "(?:diwali|deepavali|dussehra|dasara|navratri|holi|eid|ganpati|ganesh chaturthi|tyohar|त्योहार|दिवाली|होली)\\s*(?:ke\\s*)?(?:baad|nantar|के बाद|नंतर)",
);
const WEEKDAY_WORDS: readonly string[][] = [
  ["sunday", "ravivar", "रविवार", "itwar", "इतवार"],
  ["monday", "mon", "somvar", "somwar", "सोमवार"],
  ["tuesday", "tue", "tues", "mangalvar", "mangalwar", "मंगलवार", "मंगळवार"],
  ["wednesday", "wed", "budhvar", "budhwar", "बुधवार"],
  ["thursday", "thu", "thur", "thurs", "guruvar", "guruwar", "brihaspativar", "गुरुवार", "बृहस्पतिवार"],
  ["friday", "fri", "shukravar", "shukrawar", "शुक्रवार"],
  ["saturday", "shanivar", "shaniwar", "शनिवार"],
];
const WEEKDAY_RES = WEEKDAY_WORDS.map((ws) => word(ws.join("|")));
const MORNING = /morning|subah|सुबह|सकाळ|sakal/iu;
const AFTERNOON = /afternoon|dopahar|दोपहर|दुपार|dupar/iu;
const EVENING = /evening|shaam|sham|शाम|संध्याकाळ|sandhyakal/iu;
const NIGHT = /night|raat|रात|ratri|रात्री/iu;
const CLOCK = /(?<![\d:])(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|baje|बजे|vajta|वाजता|o'?clock)/iu;

/** The IST date a line names for a call back, counted from `from`, or null. */
function dayNamed(line: string, from: string): string | null {
  const today = ist(from);
  const toNextMonday = ((1 - today.dow + 7) % 7) || 7;
  const weekday = WEEKDAY_RES.findIndex((re) => re.test(line));
  if (weekday >= 0) {
    // "Next week Monday" is that day in the coming Monday-to-Sunday week.
    if (NEXT_WEEK.test(line)) return addDays(today.date, toNextMonday + ((weekday - 1 + 7) % 7));
    const ahead = ((weekday - today.dow + 7) % 7) || 7;
    return addDays(today.date, ahead);
  }
  if (NEXT_WEEK.test(line)) return addDays(today.date, toNextMonday);
  const span = DAYS_SPAN.exec(line);
  if (span) {
    const n = numberOf(span[1]);
    if (n !== null && n > 0) return addDays(today.date, n);
  }
  if (AFTER_TOMORROW.test(line)) return addDays(today.date, 2);
  if (TOMORROW.test(line)) return addDays(today.date, 1);
  if (TODAY.test(line)) return today.date;
  return null;
}

const AFTER_LUNCH = /after lunch|lunch ke baad|lunch ke bad|lunch nantar|लंच के बाद|जेवणानंतर/iu;
const AFTER_WORK = /after (?:office|work)|office ke baad|office ke bad|office (?:se|nantar) (?:aake|aane ke baad|ghari)|ऑफिस के बाद|ऑफिस नंतर/iu;

/**
 * A part of the day a buyer names, and when it starts and ends for a call
 * back. "Evening" means its first hour, 4 pm, not a guess at the middle of it.
 */
const DAY_PARTS: readonly { re: RegExp; from: string; to: string }[] = [
  { re: AFTER_WORK, from: "19:00", to: "21:00" },
  { re: AFTER_LUNCH, from: "14:00", to: "16:00" },
  { re: MORNING, from: "10:00", to: "12:00" },
  { re: AFTERNOON, from: "12:00", to: "16:00" },
  { re: EVENING, from: "16:00", to: "20:00" },
  { re: NIGHT, from: "20:00", to: "21:00" },
];

/** A call back to a part of the day the buyer is already in waits at least this long. */
export const CALLBACK_SOONEST_MS = HOUR;

/**
 * The IST time a line names: a clock time exactly, or a part of the day as
 * its start and end ("HH:MM"). Null when it names neither.
 */
function timeNamed(line: string): { time: string; until?: string } | null {
  const clock = clockNamed(line);
  if (clock) return { time: clock };
  const part = DAY_PARTS.find((p) => p.re.test(line));
  return part ? { time: part.from, until: part.to } : null;
}

/** A clock time a line names, "HH:MM", or null. */
function clockNamed(line: string): string | null {
  const pm = /p\.?m/i;
  const m = CLOCK.exec(line);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h > 23 || min > 59) return null;
    const isPm = pm.test(m[3]) || ((EVENING.test(line) || AFTERNOON.test(line) || NIGHT.test(line)) && !MORNING.test(line));
    const isAm = /a\.?m/i.test(m[3]) || MORNING.test(line);
    if (isPm && h < 12) h += 12;
    else if (!isAm && h >= 1 && h <= 7) h += 12; // "5 baje" in a working day is the evening
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return null;
}

/** The next quarter hour at or after `ms`. */
const toQuarter = (ms: number) => Math.ceil(ms / (15 * MIN)) * 15 * MIN;

/**
 * When the buyer asked to be called back, from what was said, newest line
 * first: a wait ("in five minutes") counted from when the call ended, or a
 * day ("kal", "Monday shaam", "next week", "in 3 days") at the time they
 * said, else 11:00 IST. Kept inside calling hours, never in the past, never
 * more than `CALLBACK_MAX_DAYS` out. A later day they named but that cannot
 * be read ("after Diwali", "some other day") is the next day at 11:00. A
 * part of the day is its first hour (`DAY_PARTS`: evening is 4 pm), or an
 * hour after the call when the buyer is already in it, while it lasts. A
 * time with no day ("in the evening", "5 baje") is today, or tomorrow once
 * it has passed. Null when nobody named either, and the caller waits its
 * usual two hours.
 */
export function callbackAt(
  lines: readonly (string | null | undefined)[],
  endedIso: string,
  nowIso: string,
  spread = 0,
): string | null {
  for (const raw of lines) {
    const line = toAscii(raw ?? "");
    if (!line || !ABOUT_A_CALL.test(line)) continue;
    const wait = callbackDelayMs([line]);
    if (wait !== null) {
      const at = Math.max(Date.parse(endedIso) + wait, Date.parse(nowIso));
      return nextOpening(new Date(at).toISOString(), spread);
    }
    const named = timeNamed(line);
    let date = dayNamed(line, endedIso) ?? (SOME_LATER_DAY.test(line) ? addDays(ist(endedIso).date, 1) : null);
    // "Try in the evening" names a time and no day: today, or tomorrow once it has gone.
    const dayless = !date && named !== null;
    if (dayless) date = ist(endedIso).date;
    if (!date) continue;
    let time = named?.time ?? (date === ist(endedIso).date ? null : "11:00");
    if (!time) continue; // "today" with no time is the usual wait
    const hour = Number(time.slice(0, 2));
    if (hour < CALLING_HOURS.from) time = `${String(CALLING_HOURS.from).padStart(2, "0")}:00`;
    else if (hour >= CALLING_HOURS.to) time = `${String(CALLING_HOURS.to - 1).padStart(2, "0")}:30`;
    let at = istAt(date, time);
    if (named?.until) {
      // A part of the day starts at its first hour, and a buyer already in it
      // ("evening", said at 4:30 pm) is given an hour, while the part lasts.
      const soonest = toQuarter(Math.max(Date.parse(endedIso) + CALLBACK_SOONEST_MS, Date.parse(nowIso)));
      if (Date.parse(at) < soonest) at = new Date(soonest).toISOString();
      if (Date.parse(at) > Date.parse(istAt(date, named.until))) {
        if (!dayless) continue;
        at = istAt(addDays(date, 1), time);
      }
    } else if (dayless && Date.parse(at) <= Date.parse(nowIso)) {
      at = istAt(addDays(date, 1), time);
    }
    if (Date.parse(at) <= Date.parse(nowIso)) continue;
    if (Date.parse(at) - Date.parse(endedIso) > CALLBACK_MAX_DAYS * DAY) continue;
    return at;
  }
  return null;
}

/** How long after a call that went dead the buyer is rung again. */
export const DROPPED_CALLBACK_MS = 2 * HOUR;

const GOODBYE = /thank|dhanyavaa?d|धन्यवाद|शुक्रिया|आभार|bye|अलविदा|good day|shubh din|शुभ दिन|take care/i;

/**
 * Whether a call that connected was cut off mid-conversation: the buyer
 * answered, the agent asked something, and the line went dead before
 * anybody replied or said goodbye. A call that settled something (an
 * opt-out, a no, a hand-off, a call back asked for) is not one.
 *
 * Nor is a call the buyer rang in on (they ring again when they want to),
 * nor one whose last line was the agent apologising: that is a buyer who
 * hung up annoyed, and ringing back to repeat the question they hung up on
 * was the first call back this rule ever made.
 *
 * Nor is one whose last line was the closing question ("anything else?"):
 * a buyer who hangs up on it has finished, and ringing them back to ask it
 * again was what the second one did (9 October 2026). A bad line always is
 * one: nothing got through, so the buyer is rung once more.
 */
export function wasCutOff(turns: readonly { role: string; text: string }[], outcome: string | null, inbound = false): boolean {
  if (inbound) return false;
  if (outcome === "BAD_LINE") return true;
  if (["OPTED_OUT", "NOT_INTERESTED", "WRONG_NUMBER", "BROKER", "HANDED_OFF", "CALLBACK", "NO_ANSWER", "HUNG_UP"].includes(outcome ?? "")) return false;
  const said = turns.filter((t) => t.text.trim());
  if (!said.some((t) => t.role === "user")) return false;
  const last = said.at(-1);
  if (!last || last.role !== "agent") return false;
  return /[?？]/.test(last.text) && !GOODBYE.test(last.text) && !APOLOGY.test(last.text) && !CLOSING_QUESTION.test(last.text);
}

const APOLOGY = /apologi[sz]e|sorry|maaf|माफ़|माफ|क्षमा|दिलगीर/i;
/** The agent's last question before goodbye, in the agents' three languages. */
const CLOSING_QUESTION =
  /anything else|anything more|any other question|aur kuch|kuch aur|aur koi|और कुछ|कुछ और|और कोई|ajun kahi|ajun kaahi|अजून काही|आणखी काही/i;

/**
 * When a call really ended. Sarvam's interaction id carries the moment it
 * was answered in IST ("20261002/5f12-17:58:00-e069"); with the length that
 * is the end. Otherwise the dial time plus the length, which is early by the
 * ringing. Never later than now: a result read late is not a call ended late.
 */
export function callEndedAt(o: { placedIso: string; durationS: number | null; interactionId?: string | null; nowIso: string }): string {
  const secs = Math.max(0, o.durationS ?? 0) * 1000;
  const m = /^(\d{4})(\d{2})(\d{2})\/[^-]*-(\d{2}):(\d{2}):(\d{2})-/.exec(o.interactionId ?? "");
  let start = Date.parse(o.placedIso);
  if (m) {
    const answered = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) - IST_MS;
    if (answered >= start - 5 * MIN && answered <= Date.parse(o.nowIso)) start = answered;
  }
  return new Date(Math.min(start + secs, Date.parse(o.nowIso))).toISOString();
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

export type CallPurpose =
  | "FIRST_CALL"
  | "RETRY_CALL"
  | "CALLBACK"
  | "REENGAGE_CALL"
  | "RECOVERY_CALL"
  | "CONFIRM_CALL"
  | "POST_VISIT_CALL"
  | "VISIT_FOLLOWUP_CALL"
  | "BRIDGE";
export type CheckPurpose = "NO_SHOW_CHECK" | "LAPSE_CHECK" | "ADMIT_CHECK" | "OFFER_CHECK";
export type Purpose = CallPurpose | CheckPurpose | MessagePurpose;

export type TaskKind = "CALL" | "MESSAGE" | "CHECK";

export const CALL_PURPOSES: CallPurpose[] = [
  "FIRST_CALL",
  "RETRY_CALL",
  "CALLBACK",
  "REENGAGE_CALL",
  "RECOVERY_CALL",
  "CONFIRM_CALL",
  "POST_VISIT_CALL",
  "VISIT_FOLLOWUP_CALL",
  "BRIDGE",
];
export const CHECK_PURPOSES: CheckPurpose[] = ["NO_SHOW_CHECK", "LAPSE_CHECK", "ADMIT_CHECK", "OFFER_CHECK"];

export function kindOf(p: Purpose): TaskKind {
  if ((CALL_PURPOSES as string[]).includes(p)) return "CALL";
  if ((CHECK_PURPOSES as string[]).includes(p)) return "CHECK";
  return "MESSAGE";
}

/**
 * Which due task is run first when more are due than a pass takes, as on a
 * launch day when the lines are few: 0, the first call (and its
 * acknowledgement) to a lead under an hour old; 1, a call back the buyer
 * asked for, a visit confirmation or reminder, a hand-off, and any call to a
 * hot lead; 2, everything else, the old retries and the drip included. Within
 * a tier, the one due longest goes first. `claim()` in `lead-engine.ts`
 * says the same in SQL; change both together.
 */
export const FRESH_LEAD_MS = HOUR;
export function claimPriority(t: { purpose: Purpose; leadAgeMs: number; temperature: string | null }): 0 | 1 | 2 {
  if ((t.purpose === "FIRST_CALL" || t.purpose === "ACK") && t.leadAgeMs < FRESH_LEAD_MS) return 0;
  if (URGENT_PURPOSES.includes(t.purpose)) return 1;
  if (kindOf(t.purpose) === "CALL" && t.temperature === "HOT") return 1;
  return 2;
}
export const URGENT_PURPOSES: readonly Purpose[] = [
  "CALLBACK", "CONFIRM_CALL", "BRIDGE", "VISIT_CONFIRMED", "VISIT_REMINDER_SOON", "VISIT_REMINDER_DAY", "ADMIT_CHECK",
];

/** Which of Sarvam's calling jobs a call is. */
export function agentFor(p: CallPurpose): "qualifier" | "reminder" | "recovery" | "reengage" | "post_visit" {
  if (p === "CONFIRM_CALL") return "reminder";
  if (p === "RECOVERY_CALL") return "recovery";
  if (p === "REENGAGE_CALL" || p === "VISIT_FOLLOWUP_CALL") return "reengage";
  if (p === "POST_VISIT_CALL") return "post_visit";
  return "qualifier";
}

export const PURPOSE_LABEL: Record<Purpose, string> = {
  FIRST_CALL: "First call",
  RETRY_CALL: "Call again",
  CALLBACK: "Call back, as asked",
  REENGAGE_CALL: "Follow-up call",
  RECOVERY_CALL: "Call to rebook the visit",
  CONFIRM_CALL: "Call to confirm the visit",
  POST_VISIT_CALL: "Call to ask how the visit went",
  VISIT_FOLLOWUP_CALL: "Follow-up call after the visit",
  BRIDGE: "Put through to a sales person",
  NO_SHOW_CHECK: "Check the visit happened",
  LAPSE_CHECK: "Close the missed visit",
  ADMIT_CHECK: "Check the visit may go ahead",
  OFFER_CHECK: "Check a time was picked",
  ACK: "WhatsApp: enquiry received",
  AFTER_CALL: "WhatsApp: after the call",
  MISSED_CALL: "WhatsApp: missed call",
  VISIT_CONFIRMED: "WhatsApp: visit confirmed, with directions",
  VISIT_REMINDER_DAY: "WhatsApp: reminder a day before",
  VISIT_REMINDER_SOON: "WhatsApp: reminder two hours before",
  NO_SHOW: "WhatsApp: missed visit",
  NO_SHOW_FOLLOWUP: "WhatsApp: rebook the visit",
  POST_VISIT: "WhatsApp: thank you for visiting",
  POST_VISIT_FOLLOWUP: "WhatsApp: follow-up after the visit",
  BOOKING: "WhatsApp: booking welcome",
  REFERRAL: "WhatsApp: referral ask",
  BOOKED_CHECKIN: "WhatsApp: monthly check-in",
  NURTURE: "WhatsApp: monthly nudge",
  SITE_LOCATION: "WhatsApp: site location",
  PARTNER_PAYOUT: "WhatsApp: a partner's payout update",
  SLOT_OFFER: "WhatsApp: three open times offered",
  VISIT_REOFFER: "WhatsApp: a visit offered again",
  VISIT_CANCELLED: "WhatsApp: visit cancelled",
  VISIT_EMI: "WhatsApp: the EMI on the unit they saw",
  LENDER_ASK: "WhatsApp: asked before a lender calls",
  LOAN_SHARE_ASK: "WhatsApp: asked before the partner hears about the loan",
  REVISIT_OFFER: "WhatsApp: a revisit with family offered",
  TOKEN_LINK: "WhatsApp: the token link",
  PROJECT_DETAILS: "WhatsApp: the project details",
};

/** One step to schedule. The key makes the same step scheduled twice one row. */
export type Step = { purpose: Purpose; dueAt: string; key: string; visitId?: string; detail?: Record<string, unknown> };

/**
 * The first call's run, the client's rule of 29 September 2026: three tries
 * a day, half an hour apart, from the first call (or from ten the next
 * morning), for three days. A ninth unanswered dial closes the lead.
 */
export const DIALS_PER_DAY = 3;
export const RUN_DAYS = 3;
export const RETRY_GAP_MIN = 30;

/** Dials in one qualification run, answered or not. Rule 3 in CLAUDE.md. */
export const MAX_DIAL_ATTEMPTS = DIALS_PER_DAY * RUN_DAYS;

/**
 * Automatic calls to one lead over its whole life, whatever they were for:
 * the first run's nine, then the visit's and the follow-ups' after it.
 */
export const MAX_AUTO_CALLS = 16;

/** Where a try sits in the run: which day of it, and which try that day. */
export type RunPlace = { day: number; tryInDay: number };

/**
 * A try's place, from its task's detail when the run wrote one, else from
 * its number alone (a run started before the ladder carried its place).
 */
export function runPlace(attempt: number, detail?: { day?: unknown; tryInDay?: unknown } | null): RunPlace {
  const day = Number(detail?.day);
  const tryInDay = Number(detail?.tryInDay);
  if (Number.isInteger(day) && day >= 1 && Number.isInteger(tryInDay) && tryInDay >= 1) return { day, tryInDay };
  const n = Math.max(1, attempt);
  return { day: Math.ceil(n / DIALS_PER_DAY), tryInDay: ((n - 1) % DIALS_PER_DAY) + 1 };
}

/** A few minutes past ten on an IST date, spread by the lead so a night's leads do not ring as one. */
function openingOn(date: string, spread: number): string {
  const ten = `${String(CALLING_HOURS.from).padStart(2, "0")}:00`;
  return new Date(Date.parse(istAt(date, ten)) + (5 + (spread % 55)) * MIN).toISOString();
}

/**
 * The next dial after an unanswered try, or null when the run is over. Half
 * an hour later while the day has tries left and calling hours hold; else
 * the next morning, starting that day's three; after the third day, none.
 */
export function nextDial(
  place: RunPlace,
  attempt: number,
  nowIso: string,
  spread: number,
): { dueAt: string; place: RunPlace; attempt: number } | null {
  if (attempt >= MAX_DIAL_ATTEMPTS) return null;
  const soon = new Date(Date.parse(nowIso) + RETRY_GAP_MIN * MIN).toISOString();
  if (place.tryInDay < DIALS_PER_DAY && inCallingHours(soon) && ist(soon).date === ist(nowIso).date) {
    return { dueAt: soon, place: { day: place.day, tryInDay: place.tryInDay + 1 }, attempt: attempt + 1 };
  }
  if (place.day >= RUN_DAYS) return null;
  return { dueAt: openingOn(addDays(ist(nowIso).date, 1), spread), place: { day: place.day + 1, tryInDay: 1 }, attempt: attempt + 1 };
}

// ---------------------------------------------------------------------------
// A lead arrived
// ---------------------------------------------------------------------------

export type Captured = {
  leadId: string;
  nowIso: string;
  autoOutreach: boolean;
  /** Merged into a lead that already existed, rather than new. */
  merged: boolean;
  /** The last automatic call to this lead, if any. */
  lastCallAt: string | null;
};

/**
 * Inside calling hours, a call now. Outside, a WhatsApp saying when, and the
 * call at ten. A re-enquiry from a lead called in the last day is left to
 * the cadence already running rather than rung twice.
 */
export function afterCapture(c: Captured): Step[] {
  if (!c.autoOutreach) return [];
  if (c.merged && c.lastCallAt && Date.parse(c.nowIso) - Date.parse(c.lastCallAt) < DAY) return [];
  const spread = spreadOf(c.leadId);
  const tag = c.merged ? `:${c.nowIso.slice(0, 13)}` : "";
  if (inCallingHours(c.nowIso)) {
    return [{ purpose: "FIRST_CALL", dueAt: c.nowIso, key: `${c.leadId}:FIRST_CALL${tag}` }];
  }
  return [
    { purpose: "ACK", dueAt: c.nowIso, key: `${c.leadId}:ACK${tag}` },
    { purpose: "FIRST_CALL", dueAt: nextOpening(c.nowIso, spread), key: `${c.leadId}:FIRST_CALL${tag}` },
  ];
}

// ---------------------------------------------------------------------------
// A call ended
// ---------------------------------------------------------------------------

export type CallEnded = {
  leadId: string;
  callId: string;
  nowIso: string;
  purpose: CallPurpose;
  /** Which try this was in its run, 1 to MAX_DIAL_ATTEMPTS. */
  attempt: number;
  /** Which day of the run and which try that day, from the task that placed it. */
  place?: RunPlace;
  /** Automatic calls to this lead so far, this one included. */
  autoCalls: number;
  connectivity: Connectivity;
  outcome: Outcome;
  vars: Record<string, unknown> | null;
  /** The lead as it stood before the call. */
  stage: StageKey;
  pathStage: PathStage;
  facts: Facts;
  /** People who may own a lead here, least loaded first. */
  owners: readonly string[];
  /** Whether a missed-call WhatsApp already went to this lead. */
  missedMessageSent: boolean;
  /** The visit a confirmation, rebooking or post-visit call was about, and when it is or was. */
  visitId?: string | null;
  visitAt?: string | null;
  /**
   * Where section 02's table sends the lead, from what the call was read to
   * say (`qualification-rules.ts`). Null when the call was not read, and the
   * agent's own word on the lead decides, as it always did.
   */
  route?: "JUNK" | "CP" | "NRI" | "HOT" | "WARM" | "COLD" | null;
  /**
   * False when the call was read and learnt nothing the score counts: the
   * buyer is then neither warm nor cold, and is not put in the drip.
   */
  learnt?: boolean;
  /** The buyer agreed to hear from the developer on WhatsApp, so a nudge may go. */
  marketingConsent?: boolean;
  /**
   * Whether the call ran on its own job's agent rather than the qualifier. A
   * no-show call placed before the visit confirmer existed ran the
   * qualifier's script, and is read as a qualifying call.
   */
  onOwnAgent?: boolean;
  /** When the call really ended (`callEndedAt()`), which a wait the buyer asked for counts from. */
  endedIso?: string;
  /** The project's opening hours, which a visit time said on the call must fall in. */
  visitHours?: VisitHours | null;
  /** What was said on the call, newest line first, read for a call-back time. */
  said?: readonly string[];
  /** The line went dead mid-conversation (`wasCutOff()`): the buyer is called back to carry on. */
  dropped?: boolean;
  /** This call was itself the call back after a call that went dead, so a second drop is not chased again. */
  afterDrop?: boolean;
  /**
   * The call failed on our side or the calling service's, not the buyer's
   * (`isSystemFailure()`): it is tried again without using one of their dials.
   */
  systemFailure?: boolean;
  /** Calls to this lead that failed on our side today (IST), this one included. */
  systemFailuresToday?: number;
  /** The agent promised the project's details on WhatsApp, or the buyer asked for them (`promisedDetails()`). */
  promisedDetails?: boolean;
};

/** Calls that failed on our side tried again per lead per IST day, before a person is asked. */
export const MAX_SYSTEM_RETRIES_PER_DAY = 3;
/** How long each of those waits, in minutes: a service having a bad few minutes, then a bad hour. */
export const SYSTEM_RETRY_MIN = [15, 30, 60] as const;
export const SYSTEM_FAILING = "Calls to this lead are failing on our side. Call them yourself";

/**
 * A call that failed on our side. The buyer never heard a ring, so nothing
 * of theirs is used: no dial of the run, no automatic call, no missed-call
 * WhatsApp, and the lead is never closed. The same call is tried again,
 * `SYSTEM_RETRY_MIN` apart, up to `MAX_SYSTEM_RETRIES_PER_DAY` times a day;
 * after that a person is asked, and a visit confirmation becomes its
 * WhatsApp reminder.
 */
function afterSystemFailure(c: CallEnded, spread: number, none: CallDecision): CallDecision {
  const n = Math.max(1, c.systemFailuresToday ?? 1);
  if (n <= MAX_SYSTEM_RETRIES_PER_DAY && c.purpose !== "BRIDGE") {
    const place = c.place ?? runPlace(c.attempt);
    return {
      ...none,
      steps: [{
        purpose: c.purpose,
        dueAt: laterInHours(c.nowIso, SYSTEM_RETRY_MIN[n - 1] * MIN, spread),
        key: `${c.leadId}:${c.purpose}:sys:${c.callId}`,
        ...(c.visitId ? { visitId: c.visitId } : {}),
        detail: { attempt: c.attempt, day: place.day, tryInDay: place.tryInDay, systemRetry: n, ...(c.afterDrop ? { dropped: true } : {}) },
      }],
    };
  }
  const steps: Step[] = c.purpose === "CONFIRM_CALL" && c.visitId
    ? [{ purpose: "VISIT_REMINDER_DAY", dueAt: c.nowIso, key: `${c.visitId}:VISIT_REMINDER_DAY`, visitId: c.visitId }]
    : [];
  return { ...none, steps, needsPerson: SYSTEM_FAILING };
}

export type StageMove = {
  to: StageKey;
  facts: Facts;
  exitReason?: string;
  followUpOn?: string;
  /** For a side lane, the path stage the facts now support. */
  pathStage?: PathStage;
  why: string;
  /** Takes a closed lead back onto the path: the latest call outranks the one that closed it. */
  reopen?: boolean;
};

export type CallDecision = {
  steps: Step[];
  /** Cancel every step still due, before scheduling these. */
  cancelPending: boolean;
  move: StageMove | null;
  temperature: "HOT" | "WARM" | "COLD" | null;
  score: number | null;
  /** Why a person has to act now, or null. */
  needsPerson: string | null;
  /** A visit the agent booked, when it said when. */
  visit: { at: string; askedFor: string } | null;
  /** The visit the buyer called off on the call: cancelled if it was still on, lapsed if they had missed it. */
  endVisit?: { visitId: string; as: "CANCELLED" | "LAPSED" } | null;
};

const HANDOFF_WORDS = "Hamare sales manager aapko thodi der mein call karenge.";

export function afterCall(c: CallEnded): CallDecision {
  const none: CallDecision = {
    steps: [],
    cancelPending: false,
    move: null,
    temperature: null,
    score: null,
    needsPerson: null,
    visit: null,
  };
  const spread = spreadOf(c.leadId);
  const today = ist(c.nowIso).date;

  // The call failed on our side: the buyer did not miss it, so none of the
  // unanswered-call rules below apply.
  if (c.systemFailure && c.connectivity === "failed") return afterSystemFailure(c, spread, none);

  // Nobody picked up. A voicemail connects, and is still nobody. A bad line
  // the buyer was already rung back on is read as one too: nothing they said
  // is a verdict, so the lead is neither moved nor judged.
  const badAgain = c.outcome === "BAD_LINE" && (c.afterDrop || !c.dropped);
  if (c.connectivity !== "connected" || c.outcome === "HUNG_UP" || c.outcome === "NO_ANSWER" || badAgain) {
    const steps: Step[] = [];
    const inRun = c.purpose === "FIRST_CALL" || c.purpose === "RETRY_CALL";
    const next = inRun ? nextDial(c.place ?? runPlace(c.attempt), c.attempt, c.nowIso, spread) : null;
    if (next && c.autoCalls < MAX_AUTO_CALLS) {
      steps.push({
        purpose: "RETRY_CALL",
        dueAt: next.dueAt,
        key: `${c.leadId}:RETRY_CALL:${next.attempt}`,
        detail: { attempt: next.attempt, day: next.place.day, tryInDay: next.place.tryInDay },
      });
    }
    // A confirmation nobody answered becomes the WhatsApp reminder it
    // replaced, and one more try on the morning of the visit. A post-visit
    // call nobody answered is left to the follow-up WhatsApp already due.
    if (c.purpose === "CONFIRM_CALL") {
      if (c.attempt < 2 && c.visitId) {
        const again = c.visitAt ? morningOf(c.visitAt, c.nowIso, spread) : null;
        if (again && c.autoCalls < MAX_AUTO_CALLS) {
          steps.push({ purpose: "CONFIRM_CALL", dueAt: again, key: `${c.visitId}:CONFIRM_CALL:2`, visitId: c.visitId, detail: { attempt: 2 } });
        }
        steps.push({ purpose: "VISIT_REMINDER_DAY", dueAt: c.nowIso, key: `${c.visitId}:VISIT_REMINDER_DAY`, visitId: c.visitId });
      }
      return { ...none, steps };
    }
    if (c.purpose === "POST_VISIT_CALL" || c.purpose === "VISIT_FOLLOWUP_CALL") return { ...none, steps };
    if (!c.missedMessageSent) {
      steps.push({ purpose: "MISSED_CALL", dueAt: c.nowIso, key: `${c.leadId}:MISSED_CALL` });
    }
    // Three days of tries and nobody picked up: the lead is closed, and
    // nothing more goes to it.
    const exhausted = inRun && !next;
    if (exhausted && pathIndex(c.stage) <= pathIndex("new") && isPath(c.stage)) {
      return {
        ...none,
        steps: [],
        cancelPending: true,
        move: {
          to: "lost",
          facts: c.facts,
          exitReason: "Not reachable",
          why: `Not reached in ${RUN_DAYS} days of calls`,
        },
      };
    }
    return { ...none, steps };
  }

  // Connected. The outcomes that close the lead come first.
  if (c.outcome === "OPTED_OUT") {
    return {
      ...none,
      cancelPending: true,
      move: offPath(c, "lost", "Asked not to be contacted"),
    };
  }
  if (c.outcome === "NOT_INTERESTED" || c.outcome === "WRONG_NUMBER" || c.outcome === "BROKER") {
    const reason = c.outcome === "NOT_INTERESTED" ? notInterestedReason(textOf(c.vars?.call_summary) ?? "") : c.outcome === "WRONG_NUMBER" ? "Wrong number" : "Duplicate or junk";
    return { ...none, cancelPending: true, move: offPath(c, "lost", reason), endVisit: visitCalledOff(c) };
  }

  if (c.purpose === "CONFIRM_CALL" || (c.purpose === "RECOVERY_CALL" && c.onOwnAgent)) return afterVisitCall(c);
  if (c.purpose === "POST_VISIT_CALL") return afterPostVisitCall(c);
  if (c.purpose === "VISIT_FOLLOWUP_CALL") return afterVisitFollowUp(c);

  const v = c.vars ?? {};
  const facts: Facts = { ...c.facts };
  // Reached: the first stage's facts.
  if (!facts.contactChannel) facts.contactChannel = "AI voice call";
  if (!facts.contactedOn) facts.contactedOn = today;
  const heard = qualificationFrom(v);
  for (const [k, val] of Object.entries(heard) as [keyof Facts, string][]) {
    if (val && !c.facts[k]) facts[k] = val;
  }
  const route = c.route ?? null;
  const bookedText = v.site_visit_status === "booked" ? textOf(v.site_visit_time) ?? "" : null;
  const visitAt = bookedText !== null ? parseVisitTime(bookedText, c.nowIso, c.visitHours) : null;
  // A buyer who agreed a visit on the call is hot, whatever else the call
  // left unsaid; one the call learnt nothing about is neither warm nor cold.
  // Both were cold: a visit booked for Thursday read COLD, and a buyer who
  // hung up after hello was put in the drip as "not ready to buy" (South
  // Field, 30 October 2026).
  const temperature = bookedText !== null ? "HOT" : c.learnt === false ? null : callTemperature(route, v);
  const score = scoreOf({ temperature, facts, visitBooked: bookedText !== null });

  let target: PathStage = "contacted";
  const qualified = !!(facts.config && facts.budget && facts.timeline);
  if (qualified) {
    if (!facts.owner && c.owners.length) facts.owner = c.owners[0];
    if (facts.owner) target = "qualified";
  }
  if (visitAt) {
    facts.visitDate = visitAt.date;
    facts.visitTime = visitAt.slot;
    if (!facts.visitHost && facts.owner) facts.visitHost = facts.owner;
    target = "visit_scheduled";
  }

  // The line went dead mid-conversation: nothing the buyer said is a
  // verdict, so the lead is not judged warm or cold off half a call. They
  // are rung again in a few hours to carry on from where it stopped. Once:
  // a call back that is cut too is read as the call it was.
  if (c.dropped && !c.afterDrop && !visitAt && c.outcome !== "HANDED_OFF") {
    // A closed lead whose call went dead said nothing new: it stays closed and is not rung back.
    if (c.stage === "lost") return none;
    const dropped: Step[] = c.autoCalls < MAX_AUTO_CALLS
      ? [{ purpose: "CALLBACK", dueAt: laterInHours(c.endedIso ?? c.nowIso, DROPPED_CALLBACK_MS, spread), key: `${c.leadId}:CALLBACK:${c.callId}`, detail: { dropped: true } }]
      : [];
    return { steps: dropped, cancelPending: false, move: forward(c, target, facts, "Reached on the call"), temperature: null, score: null, needsPerson: null, visit: null };
  }

  const steps: Step[] = [];
  let needsPerson: string | null = null;
  let move: StageMove | null = forward(c, target, facts, target === "visit_scheduled" ? "Visit booked on the call" : "Reached on the call");

  if (c.outcome === "HANDED_OFF") {
    needsPerson = "Handed to sales on the call. Follow up today";
  }
  if (bookedText !== null && !visitAt) {
    needsPerson = `Visit agreed on the call${bookedText ? ` ("${bookedText.slice(0, 60)}")` : ""}. Fix the time`;
  }

  if (c.outcome === "CALLBACK") {
    if (move?.reopen) move = { ...move, why: "Reopened: asked to be called back" };
    if (c.autoCalls < MAX_AUTO_CALLS) {
      steps.push({ purpose: "CALLBACK", dueAt: callbackDue(c, spread), key: `${c.leadId}:CALLBACK:${c.callId}` });
    }
    // "Call me later, send the details meanwhile" is the ordinary case.
    if (c.promisedDetails) steps.push(detailsStep(c));
    return { steps, cancelPending: false, move, temperature, score, needsPerson, visit: null };
  }

  // The message after the call says what happens next, in one sentence.
  const next = visitAt
    ? null // the visit confirmation says it, with directions
    : c.outcome === "HANDED_OFF" || temperature === "HOT"
      ? HANDOFF_WORDS
      : temperature === "COLD"
        ? "Hum touch mein rahenge, jab bhi aap ready hon yahin reply kar dijiye."
        : "Site visit fix karne ke liye hum ek do din mein aapko call karenge.";
  // Details promised on the call go in its place: they thank the buyer too,
  // and two messages a minute apart read as a machine.
  if (c.promisedDetails) steps.push(detailsStep(c));
  else if (next) {
    steps.push({ purpose: "AFTER_CALL", dueAt: c.nowIso, key: `${c.leadId}:AFTER_CALL:${c.callId}`, detail: { nextStep: next } });
  }

  if (!visitAt) {
    // A hot lead was offered the sales manager on the call; if they are not
    // marked handed off, the transfer did not happen and they were promised
    // a call back. Read as hot by the score, they are put straight through
    // to a free sales person instead of waiting for one to see a flag.
    if (temperature === "HOT" && route === "HOT" && c.outcome !== "HANDED_OFF") {
      steps.push({ purpose: "BRIDGE", dueAt: c.nowIso, key: `${c.leadId}:BRIDGE:${c.callId}`, detail: { callId: c.callId } });
    } else if (temperature === "HOT" && !needsPerson) {
      needsPerson = "Hot lead, promised a call from sales. Call now";
    }
    if (route === "NRI" && !needsPerson) needsPerson = "Buyer calling from outside India. Call at a time that suits them";
    // Warm, with WhatsApp consent: three visit offers, each with three open
    // times, two hours, two days and a week after the call. Without it, the
    // follow-up call it always had.
    if (route === "WARM" && c.marketingConsent) {
      for (const [n, ms] of [[1, 2 * HOUR], [2, 2 * DAY], [3, 7 * DAY]] as const) {
        steps.push({ purpose: "VISIT_REOFFER", dueAt: laterInHours(c.nowIso, ms, spread), key: `${c.leadId}:VISIT_REOFFER:${c.callId}:${n}` });
      }
    } else if (temperature === "WARM" || (temperature === null && (c.outcome === "QUALIFIED" || c.learnt === false))) {
      if (c.autoCalls < MAX_AUTO_CALLS) {
        steps.push({
          purpose: "REENGAGE_CALL",
          dueAt: laterInHours(new Date(Date.parse(c.nowIso) + 2 * DAY).toISOString(), 0, spread),
          key: `${c.leadId}:REENGAGE_CALL:${addDays(today, 2)}`,
        });
      }
    }
    // A lead with a visit booked is not dropped into the drip by one cold
    // reading: the visit stands until it is called off.
    const visitBooked = isPath(c.stage) && pathIndex(c.stage) >= pathIndex("visit_scheduled");
    // "Not ready to buy yet" is said only of a buyer whose budget or
    // timeline we know. A cold buyer who said neither is called once more.
    const knowsWhy = !!(facts.timeline || facts.budget);
    if (temperature === "COLD" && !visitBooked && !knowsWhy && c.autoCalls < MAX_AUTO_CALLS) {
      steps.push({
        purpose: "REENGAGE_CALL",
        dueAt: laterInHours(new Date(Date.parse(c.nowIso) + 2 * DAY).toISOString(), 0, spread),
        key: `${c.leadId}:REENGAGE_CALL:cold-once`,
      });
    }
    if (temperature === "COLD" && !visitBooked && knowsWhy) {
      const off = offPath({ ...c, facts }, "nurture", "Not ready to buy yet", addDays(today, 30));
      if (off) {
        const from = isPath(c.stage) ? c.stage : c.pathStage;
        move = { ...off, pathStage: pathIndex(target) > pathIndex(from) ? target : from };
        steps.push(...nurtureSteps(c.leadId, c.nowIso, 30));
      }
    }
  }

  return { steps, cancelPending: false, move, temperature, score, needsPerson, visit: visitAt ? { at: visitAt.at, askedFor: bookedText ?? "" } : null };
}

// ---------------------------------------------------------------------------
// The visit confirmer's and the post-visit agent's calls
// ---------------------------------------------------------------------------

/** A decision that changes nothing, fresh each time: its steps are pushed to. */
const noDecision = (): CallDecision => ({
  steps: [],
  cancelPending: false,
  move: null,
  temperature: null,
  score: null,
  needsPerson: null,
  visit: null,
});

/**
 * The second try at confirming a visit: the morning of it, a few minutes
 * past ten, and only while the visit is at least two hours off. Closer than
 * that the two-hour WhatsApp reminder is the next word, and a call on top of
 * it is one call too many.
 */
export function morningOf(visitAtIso: string, nowIso: string, spread = 0): string | null {
  const at = istAt(ist(visitAtIso).date, `${String(CALLING_HOURS.from).padStart(2, "0")}:00`);
  const when = Date.parse(at) + (5 + (spread % 25)) * MIN;
  if (when <= Date.parse(nowIso) + 30 * MIN) return null;
  if (when > Date.parse(visitAtIso) - 2 * HOUR) return null;
  return new Date(when).toISOString();
}

/** The visit a confirmation or rebooking call was about, ended the way its state allows. */
function visitCalledOff(c: CallEnded): CallDecision["endVisit"] {
  if (!c.visitId) return null;
  if (c.purpose === "CONFIRM_CALL") return { visitId: c.visitId, as: "CANCELLED" };
  if (c.purpose === "RECOVERY_CALL") return { visitId: c.visitId, as: "LAPSED" };
  return null;
}

/**
 * A call from the visit confirmer: a day before the visit, the morning of
 * it, or after a no-show. It records what happened to the visit
 * (`visit_status`) and, when the buyer moved it, the new time. It does not
 * qualify, so nothing here reads budget or timeline.
 */
function afterVisitCall(c: CallEnded): CallDecision {
  const v = c.vars ?? {};
  const today = ist(c.nowIso).date;
  const temperature = temperatureOf(v);
  const rebook = c.purpose === "RECOVERY_CALL";
  const out: CallDecision = { ...noDecision(), temperature };

  if (c.outcome === "HANDED_OFF") out.needsPerson = "Handed to sales on the call. Follow up today";

  // A new time, from whichever field the agent wrote it in.
  const said = textOf(v.new_visit_time) ?? (v.site_visit_status === "booked" ? textOf(v.site_visit_time) : null);
  const parsed = said ? parseVisitTime(said, c.nowIso, c.visitHours) : null;
  // The booked time said back is a confirmation, not a move: booking it
  // again would send the buyer a second confirmation for the same slot.
  const newTime = parsed && !(c.visitAt && parsed.at === c.visitAt && !rebook) ? parsed : null;
  if (parsed && !newTime && c.outcome !== "VISIT_CANCELLED") return out;
  const moved = c.outcome === "VISIT_MOVED" || rebook || (v.site_visit_status === "booked" && c.outcome !== "VISIT_CONFIRMED");
  if (newTime && moved) {
    const facts: Facts = { ...c.facts, visitDate: newTime.date, visitTime: newTime.slot };
    out.move = forward(c, "visit_scheduled", facts, rebook ? "Visit rebooked on the call" : "Visit moved on the call");
    out.visit = { at: newTime.at, askedFor: said ?? "" };
    return out;
  }
  if (c.outcome === "VISIT_MOVED" || (rebook && c.outcome === "VISIT_CONFIRMED")) {
    out.needsPerson ??= `${rebook ? "Agreed to come again" : "Wants to move the visit"}${said ? ` ("${said.slice(0, 60)}")` : ""}. Fix the time`;
    return out;
  }
  if (c.outcome === "VISIT_CANCELLED") {
    const off = offPath(c, "nurture", rebook ? "No-show" : "Called off the visit", addDays(today, 30));
    return {
      ...out,
      move: off,
      endVisit: visitCalledOff(c),
      steps: off ? nurtureSteps(c.leadId, c.nowIso, 30) : [],
      needsPerson: out.needsPerson ?? (rebook ? null : "Called off the visit on the call. Rebook it or close the lead"),
    };
  }
  if (c.outcome === "CALLBACK") {
    out.needsPerson ??= `Asked to be called back about the visit`;
    return out;
  }
  if (c.outcome === "VISIT_CONFIRMED") return out;
  // Reached, and nothing settled about the visit: the reminder still goes.
  if (c.purpose === "CONFIRM_CALL" && c.attempt < 2 && c.visitId) {
    out.steps.push({ purpose: "VISIT_REMINDER_DAY", dueAt: c.nowIso, key: `${c.visitId}:VISIT_REMINDER_DAY`, visitId: c.visitId });
  }
  return out;
}

const INTEREST_OF: Record<string, (typeof INTEREST)[number]> = { hot: "Hot", warm: "Warm", cold: "Cold" };

/** The objection the post-visit agent heard, in the board's own words, or nothing. */
export function objectionFrom(raw: unknown): (typeof OBJECTIONS)[number] | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[_-]+/g, " ") : "";
  if (!s || /^(not specified|null|n\/a)$/.test(s)) return null;
  if (/^(none|no|nothing|no objection)$/.test(s)) return "None";
  if (/loan|finance|emi|bank/.test(s)) return "Loan";
  if (/possession|handover|ready|delay/.test(s)) return "Possession date";
  if (/carpet|area|size|small|sq/.test(s)) return "Carpet area";
  if (/layout|plan|design|vaastu|vastu/.test(s)) return "Layout";
  if (/price|cost|budget|expensive|rate/.test(s)) return "Price";
  if (/location|far|distance|commute|connectivity/.test(s)) return "Location";
  if (/family|wife|husband|parents|spouse/.test(s)) return "Family";
  return "Other";
}

/**
 * A call from the post-visit agent, the day after a visit: how it went, what
 * is holding the buyer back, and the next step they agree to. What it hears
 * fills the Visit done facts the host left empty, and never overwrites one a
 * person recorded.
 */
function afterPostVisitCall(c: CallEnded): CallDecision {
  const v = c.vars ?? {};
  const spread = spreadOf(c.leadId);
  const today = ist(c.nowIso).date;
  const facts: Facts = { ...c.facts };
  const interest = typeof v.visit_interest === "string" ? INTEREST_OF[v.visit_interest.trim().toLowerCase()] : undefined;
  if (interest && !facts.interest) facts.interest = interest;
  const objection = objectionFrom(v.visit_objection);
  if (objection && !facts.objection) facts.objection = objection;
  const next = typeof v.next_step === "string" ? v.next_step.trim().toLowerCase() : "";
  const temperature = temperatureOf(v) ?? (interest ? (interest.toUpperCase() as "HOT" | "WARM" | "COLD") : null);
  const out: CallDecision = { ...noDecision(), temperature, move: forward(c, "visit_done", facts, "Asked how the visit went") };

  if (next === "not_interested") {
    return { ...out, cancelPending: true, move: offPath({ ...c, facts }, "lost", "Not interested after the visit") };
  }
  if (c.outcome === "HANDED_OFF") {
    out.needsPerson = "Handed to sales after the visit. Follow up today";
    return out;
  }
  if (next === "negotiation") {
    out.temperature = "HOT";
    out.needsPerson = "Ready to talk price after the visit. Call today";
    return out;
  }
  if (next === "second_visit" || v.site_visit_status === "booked") {
    const said = textOf(v.site_visit_time);
    const at = said ? parseVisitTime(said, c.nowIso, c.visitHours) : null;
    if (at) return { ...out, visit: { at: at.at, askedFor: said ?? "" } };
    out.needsPerson = `Wants a second visit${said ? ` ("${said.slice(0, 60)}")` : ""}. Fix the time`;
    return out;
  }
  if ((next === "callback" || c.outcome === "CALLBACK") && c.autoCalls < MAX_AUTO_CALLS && c.visitId) {
    out.steps.push({ purpose: "POST_VISIT_CALL", dueAt: laterInHours(c.nowIso, 2 * HOUR, spread), key: `${c.visitId}:POST_VISIT_CALL:${c.callId}`, visitId: c.visitId, detail: { attempt: c.attempt + 1 } });
    return out;
  }
  // Still thinking: one more call in a week, then the follow-up WhatsApp and a person.
  if (next === "thinking" && c.attempt < 2 && c.autoCalls < MAX_AUTO_CALLS && c.visitId) {
    const inWeek = laterInHours(istAt(addDays(today, 7), "11:00"), 0, spread);
    out.steps.push({ purpose: "POST_VISIT_CALL", dueAt: inWeek, key: `${c.visitId}:POST_VISIT_CALL:2`, visitId: c.visitId, detail: { attempt: 2 } });
  }
  return out;
}

/**
 * When to call back: the wait the buyer named, counted from when the call
 * ended (a result read ten minutes late still rings at the minute promised,
 * or at once if that has passed), or the day they named (`callbackAt()`),
 * else two hours. Inside calling hours.
 */
function detailsStep(c: CallEnded): Step {
  return { purpose: "PROJECT_DETAILS", dueAt: c.nowIso, key: `${c.leadId}:PROJECT_DETAILS:${c.callId}` };
}

function callbackDue(c: CallEnded, spread: number): string {
  const v = c.vars ?? {};
  const said = [...(c.said ?? []), textOf(v.goal_note), textOf(v.call_summary)];
  return callbackAt(said, c.endedIso ?? c.nowIso, c.nowIso, spread) ?? laterInHours(c.nowIso, 2 * HOUR, spread);
}

/**
 * The move forward, or nothing when the lead is already there or further.
 * A closed lead the buyer has just spoken to is opened again: the latest call
 * says where it stands, not the one that closed it. It returns to where the
 * call puts it, or where it had got to, but no further than Qualified unless
 * the call itself booked a visit.
 */
function forward(c: { stage: StageKey; pathStage: PathStage }, to: PathStage, facts: Facts, why: string): StageMove | null {
  if (c.stage === "lost") {
    const reached = pathIndex(c.pathStage) > pathIndex("qualified") ? "qualified" : c.pathStage;
    const back = pathIndex(to) >= pathIndex("visit_scheduled") || pathIndex(to) >= pathIndex(reached) ? to : reached;
    return { to: back, facts, why: `Reopened: ${why.toLowerCase()}`, reopen: true };
  }
  const from = isPath(c.stage) ? c.stage : c.pathStage;
  if (isPath(c.stage) && pathIndex(to) <= pathIndex(from)) {
    // Not forward, but the facts the call heard are still worth keeping.
    return { to: c.stage, facts, why };
  }
  // A lead in the drip that answers and books comes back onto the path.
  if (!isPath(c.stage) && pathIndex(to) < pathIndex("visit_scheduled") && pathIndex(to) <= pathIndex(from)) {
    return { to: c.stage, facts, why };
  }
  return { to, facts, why };
}

function offPath(
  c: { stage: StageKey; facts: Facts },
  to: "nurture" | "lost",
  reason: string,
  followUpOn?: string,
): StageMove | null {
  // Automation never closes a booking. Leaving Booked is a cancellation, and
  // that is a person's decision with a person's reason.
  if (c.stage === "booked" || (c.stage === "lost" && to === "lost")) return null;
  // A closed lead the buyer has just spoken to goes where this call puts it.
  if (c.stage === "lost") return { to, facts: c.facts, exitReason: reason, followUpOn, why: `Reopened: ${reason.toLowerCase()}`, reopen: true };
  return { to, facts: c.facts, exitReason: reason, followUpOn, why: reason };
}

/** A monthly nudge, and a call on the follow-up date. */
export function nurtureSteps(leadId: string, nowIso: string, days: number): Step[] {
  const at = new Date(Date.parse(nowIso) + days * DAY).toISOString();
  const month = ist(at).date.slice(0, 7);
  return [
    { purpose: "NURTURE", dueAt: nextOpening(at, spreadOf(leadId)), key: `${leadId}:NURTURE:${month}` },
  ];
}

// ---------------------------------------------------------------------------
// From what the agent heard to the board's facts
// ---------------------------------------------------------------------------

const textOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && !/^(not_specified|not_booked|not_offered|declined|none|null|n\/a)$/i.test(s) ? s : null;
};

export function temperatureOf(v: Record<string, unknown>): "HOT" | "WARM" | "COLD" | null {
  const d = v.lead_disposition;
  if (d === "hot_lead" || d === "handed_off") return "HOT";
  if (d === "warm_lead" || d === "callback_requested") return "WARM";
  if (d === "cold_lead") return "COLD";
  return null;
}

/**
 * How hot this call leaves the lead: our own score's route whenever the call
 * was read, and the agent's rating only when it could not be. The agent rated
 * almost anybody who answered as warm (the client, 13 October 2026: a buyer
 * who gave no budget, no timeline and wanted another area read "Qualified"),
 * so its word no longer overrules a reading that found nothing.
 */
export function callTemperature(
  route: "HOT" | "WARM" | "COLD" | "JUNK" | "CP" | "NRI" | null | undefined,
  vars: Record<string, unknown> | null | undefined,
): "HOT" | "WARM" | "COLD" | null {
  const fromRoute = route === "HOT" || route === "WARM" || route === "COLD" ? route : null;
  return fromRoute ?? temperatureOf(vars ?? {});
}

/**
 * Why a buyer said no, from the call's summary, in the board's own reasons.
 * Every no was "Not interested", including a buyer who had already bought
 * and one who wanted another area.
 */
export function notInterestedReason(summary: string): "Bought elsewhere" | "Location did not suit" | "Budget mismatch" | "Not interested" {
  const s = summary.toLowerCase();
  if (/already (?:purchased|bought|booked|finali[sz]ed|own)|has (?:purchased|bought)|bought (?:a|another|one|elsewhere)/.test(s)) return "Bought elsewhere";
  if (/\blocation\b|\barea\b|too far|\bfar\b|looking (?:for (?:a )?(?:property|home|flat) )?in\b/.test(s)) return "Location did not suit";
  if (/budget|expensive|costly|price|afford/.test(s)) return "Budget mismatch";
  return "Not interested";
}

const AMOUNT_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Number words as digits, the way a transcript writes what was said: "sixty
 * five" and "sixty-five" are 65, "one and a half" and "one point five" 1.5,
 * "dedh" 1.5, "dhai" 2.5, "a crore" 1 crore.
 */
export function digitsFromWords(raw: string): string {
  let s = ` ${raw.toLowerCase().replace(/-/g, " ")} `
    .replace(/\bdedh\b/g, " 1.5 ")
    .replace(/\b(?:dhai|dhaai|adhai)\b/g, " 2.5 ")
    .replace(/\ba (crores?|lakhs?|lacs?)\b/g, " 1 $1");
  const word = Object.keys(AMOUNT_WORDS).join("|");
  const tens = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
  s = s.replace(new RegExp(`\\b(${tens})\\s+(one|two|three|four|five|six|seven|eight|nine)\\b`, "g"), (_, t, u) => ` ${AMOUNT_WORDS[t] + AMOUNT_WORDS[u]} `);
  s = s.replace(new RegExp(`\\b(${word})\\b`, "g"), (_, w) => ` ${AMOUNT_WORDS[w]} `);
  s = s.replace(/\b(\d+)\s+and a half\b/g, (_, n) => ` ${Number(n) + 0.5} `).replace(/\b(\d+)\s+point\s+(\d+)\b/g, " $1.$2 ");
  return s.replace(/\s+/g, " ").trim();
}

/** Rupees from "80 lakh", "1.2 crore", "75L", "₹90,00,000", "60-70 lakhs", "seventy lakh". A range reads as its middle. */
export function rupeesFrom(raw: string): number | null {
  const s = digitsFromWords(raw).replace(/,/g, "").replace(/₹|rs\.?|inr/g, " ");
  const unit = (u: string | undefined) =>
    !u ? 0 : /^(cr|crore|crores|c)$/.test(u) ? 1e7 : /^(l|lac|lacs|lakh|lakhs|lk)$/.test(u) ? 1e5 : /^(k|thousand)$/.test(u) ? 1e3 : 0;
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(crores?|cr|c|lakhs?|lacs?|lac|lk|l|k|thousand)?\b/g)].map((m) => ({
    n: Number(m[1]),
    u: unit(m[2]),
  }));
  if (!nums.length) return null;
  // "60 to 70 lakh": the unit on the last number covers the first.
  const lastUnit = [...nums].reverse().find((x) => x.u)?.u ?? 0;
  const values = nums.map((x) => {
    const u = x.u || lastUnit;
    if (u) return x.n * u;
    // A bare number: big enough to be rupees, else lakhs as people say them.
    return x.n >= 1e5 ? x.n : x.n * 1e5;
  });
  const v = values.length > 1 ? (Math.min(...values) + Math.max(...values)) / 2 : values[0];
  return Number.isFinite(v) && v >= 1e5 ? Math.round(v) : null;
}

export function budgetBand(rupees: number): (typeof BUDGETS)[number] {
  if (rupees < 60e5) return BUDGETS[0];
  if (rupees <= 90e5) return BUDGETS[1];
  if (rupees <= 150e5) return BUDGETS[2];
  return BUDGETS[3];
}

export function configFrom(raw: string): (typeof CONFIGS)[number] | null {
  const s = raw.toLowerCase();
  if (/villa|bungalow|row ?house/.test(s)) return "Villa";
  if (/plot|land/.test(s)) return "Plot";
  const m = /(\d(?:\.5)?)\s*-?\s*(?:bhk|bed|b\.h\.k|room)?/.exec(s);
  if (!m) return null;
  const hit = CONFIGS.find((c) => c === `${m[1]} BHK`);
  return hit ?? null;
}

export function timelineFrom(raw: string): (typeof TIMELINES)[number] | null {
  const s = raw.toLowerCase();
  if (/^within_3_months$/.test(s)) return "1 to 3 months";
  if (/^3_to_6_months$/.test(s)) return "3 to 6 months";
  if (/^6_plus_months$/.test(s)) return "6 months or more";
  if (/immediate|this month|30 days|asap|right away/.test(s)) return "Within 30 days";
  if (/explor|just looking|not sure/.test(s)) return "Just exploring";
  return null;
}

/** The qualification facts a call heard, in the board's own words. */
export function qualificationFrom(v: Record<string, unknown>): Facts {
  const out: Facts = {};
  const bhk = textOf(v.bhk_preference);
  const config = bhk ? configFrom(bhk) : null;
  if (config) out.config = config;
  const budget = textOf(v.budget);
  const rupees = budget ? rupeesFrom(budget) : null;
  if (rupees) out.budget = budgetBand(rupees);
  const when = textOf(v.purchase_timeline);
  const timeline = when ? timelineFrom(when) : null;
  if (timeline) out.timeline = timeline;
  return out;
}

/**
 * The score is arithmetic, never a model's opinion: the agent's read of the
 * lead, plus a step for each thing it learned, plus a visit.
 */
export function scoreOf(o: { temperature: "HOT" | "WARM" | "COLD" | null; facts: Facts; visitBooked: boolean }): number | null {
  if (!o.temperature && !o.facts.config && !o.facts.budget) return null;
  const base = o.temperature === "HOT" ? 70 : o.temperature === "WARM" ? 45 : o.temperature === "COLD" ? 20 : 30;
  const known = (["config", "budget", "timeline"] as const).filter((k) => o.facts[k]).length;
  return Math.min(100, base + known * 5 + (o.visitBooked ? 10 : 0));
}

// ---------------------------------------------------------------------------
// When the buyer said they would come
// ---------------------------------------------------------------------------

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAYS_HI = ["ravivar", "somvar", "mangalvar", "budhvar", "guruvar", "shukravar", "shanivar"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The site's day: the first and last half-hour a visit may start. */
export const SITE_OPEN = VISIT_SLOTS[0];
export const SITE_LAST = VISIT_SLOTS[VISIT_SLOTS.length - 1];

/**
 * An instant from what the agent wrote down: an ISO time, "2026-09-27
 * 11:00", "27/09 4 pm", "Saturday 11 am", "tomorrow at 4:30 pm", "kal shaam
 * 5 baje". Null when there is no day and time a person would agree on,
 * because a visit booked for a guessed time is a buyer at a locked gate.
 *
 * The time snaps to the site's half-hour slots, and a time outside the
 * site's day is refused rather than moved: "7 am" is not "10 am".
 */
export function parseVisitTime(
  raw: string,
  nowIso: string,
  /** The project's opening hours (`visit-hours-rules.ts`); the default site day without them. */
  hours?: VisitHours | null,
): { at: string; date: string; slot: string } | null {
  const s0 = raw.trim();
  if (!s0) return null;
  const now = ist(nowIso);

  // An ISO instant, or a date and time.
  const iso = /^(\d{4}-\d{2}-\d{2})[t\s](\d{1,2}):(\d{2})/i.exec(s0);
  if (iso) {
    const hasZone = /(z|[+-]\d{2}:?\d{2})$/i.test(s0);
    const local = hasZone ? ist(new Date(s0).toISOString()) : null;
    const date = local ? local.date : iso[1];
    const h = local ? local.hour : Number(iso[2]);
    const m = local ? local.minute : Number(iso[3]);
    return slotAt(date, h, m, nowIso, hours);
  }

  const s = ` ${s0.toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ")} `;

  // The day.
  let date: string | null = null;
  const dm = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(s);
  const named = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")})[a-z]*\\b|\\b(${MONTHS.join("|")})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s);
  if (dm) {
    const d = Number(dm[1]);
    const mo = Number(dm[2]);
    date = dateNear(now.date, mo, d, dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : null);
  } else if (named) {
    const d = Number(named[1] ?? named[4]);
    const mo = MONTHS.indexOf((named[2] ?? named[3]).slice(0, 3)) + 1;
    date = dateNear(now.date, mo, d, null);
  } else if (/\b(day after tomorrow|parso|parson|परसों)\b/.test(s)) {
    date = addDays(now.date, 2);
  } else if (/\b(tomorrow|tmrw|kal|कल|udya|उद्या)\b/.test(s)) {
    date = addDays(now.date, 1);
  } else if (/\b(today|aaj|आज|aj)\b/.test(s)) {
    date = now.date;
  } else {
    const w = WEEKDAYS.findIndex((d) => s.includes(` ${d}`) || s.includes(` ${d.slice(0, 3)} `));
    const wh = WEEKDAYS_HI.findIndex((d) => s.includes(d));
    const dow = w >= 0 ? w : wh;
    if (dow >= 0) {
      let ahead = (dow - now.dow + 7) % 7;
      if (ahead === 0) ahead = 7;
      if (/\bnext\b|\bagle\b/.test(s) && ahead < 7 && /next week/.test(s)) ahead += 7;
      date = addDays(now.date, ahead);
    }
  }

  // The time.
  const t = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m|baje|o'?clock)?\b/g;
  let hour: number | null = null;
  let minute = 0;
  let meridian: string | null = null;
  for (const m of s.matchAll(t)) {
    const n = Number(m[1]);
    // Skip the day and month we already read, and anything that is not an hour.
    if (dm && (m.index ?? 0) >= dm.index && (m.index ?? 0) < dm.index + dm[0].length) continue;
    if (named && (m.index ?? 0) >= named.index && (m.index ?? 0) < named.index + named[0].length) continue;
    if (n > 23 || (!m[2] && !m[3] && n > 12)) continue;
    if (!m[2] && !m[3] && !/\b(at|around|by|baje|pe|ko)\b/.test(s) && !/(subah|shaam|sham|dopahar|morning|evening|afternoon|noon)/.test(s)) continue;
    hour = n;
    minute = m[2] ? Number(m[2]) : 0;
    meridian = m[3] ?? null;
    break;
  }
  if (hour === null) {
    if (/\bnoon\b|dopahar 12/.test(s)) hour = 12;
    else return null;
  }
  const pm = /p ?m/.test(meridian ?? "") || /(shaam|sham|evening|afternoon|dopahar|raat|night|संध्याकाळ|शाम|दोपहर)/.test(s);
  const am = /a ?m/.test(meridian ?? "") || /(subah|morning|सुबह|सकाळ)/.test(s);
  if (pm && hour < 12) hour += 12;
  if (am && hour === 12) hour = 0;
  // "at 4" with nothing else, in a site's day, means the afternoon.
  if (!pm && !am && hour >= 1 && hour <= 7) hour += 12;

  if (!date) {
    // A time with no day: the next time it comes round.
    const today = slotAt(now.date, hour, minute, nowIso, hours);
    return today ?? slotAt(addDays(now.date, 1), hour, minute, nowIso, hours);
  }
  return slotAt(date, hour, minute, nowIso, hours);
}

function dateNear(today: string, month: number, day: number, year: number | null): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = year ?? Number(today.slice(0, 4));
  let d = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).getUTCDate() !== day) return null;
  // "27/01" said in December is next January.
  if (!year && d < today) d = `${y + 1}${d.slice(4)}`;
  return d;
}

/** Snap to the half-hour at or after, inside the site's day, and in the future. */
function slotAt(date: string, hour: number, minute: number, nowIso: string, hours?: VisitHours | null): { at: string; date: string; slot: string } | null {
  let m = hour * 60 + minute;
  m = Math.ceil(m / 30) * 30;
  const slot = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  if (!(hours ? slotsOn(hours, date) : VISIT_SLOTS).includes(slot)) return null;
  const at = istAt(date, slot);
  if (Date.parse(at) <= Date.parse(nowIso)) return null;
  // A visit more than two months out is a misheard date, not a plan.
  if (Date.parse(at) - Date.parse(nowIso) > 62 * DAY) return null;
  return { at, date, slot };
}

// ---------------------------------------------------------------------------
// A visit was booked, missed or made
// ---------------------------------------------------------------------------

/**
 * The reminders a booked visit gets, skipping any whose moment has passed.
 * With the visit confirmer switched on, the reminder a day ahead is a call
 * (`confirmCall`), and the WhatsApp goes only when the call does not.
 */
export function visitSteps(o: { leadId: string; visitId: string; atIso: string; nowIso: string; confirmCall?: boolean }): Step[] {
  const at = Date.parse(o.atIso);
  const now = Date.parse(o.nowIso);
  // Section 02's admission gate, asked as the visit is booked and again a day
  // and two hours before it, each a moment ahead of what goes out then, so a
  // visit it bars never gets the message.
  const admit = (dueMs: number, when: string): Step => ({
    purpose: "ADMIT_CHECK",
    dueAt: new Date(dueMs - 1_000).toISOString(),
    key: `${o.visitId}:ADMIT_CHECK:${when}`,
    visitId: o.visitId,
  });
  const steps: Step[] = [
    admit(now, "booked"),
    { purpose: "VISIT_CONFIRMED", dueAt: o.nowIso, key: `${o.visitId}:VISIT_CONFIRMED`, visitId: o.visitId },
  ];
  const dayBefore = at - DAY;
  // A reminder a day ahead only makes sense if the visit is more than a day
  // and a bit away; booked this morning for this evening, the confirmation
  // is the reminder.
  if (dayBefore > now + 2 * HOUR) {
    steps.push(admit(dayBefore, "day"));
    steps.push(
      o.confirmCall
        ? { purpose: "CONFIRM_CALL", dueAt: new Date(dayBefore).toISOString(), key: `${o.visitId}:CONFIRM_CALL:1`, visitId: o.visitId, detail: { attempt: 1 } }
        : { purpose: "VISIT_REMINDER_DAY", dueAt: new Date(dayBefore).toISOString(), key: `${o.visitId}:VISIT_REMINDER_DAY`, visitId: o.visitId },
    );
  }
  const twoBefore = at - 2 * HOUR;
  if (twoBefore > now + 30 * MIN) {
    steps.push(admit(twoBefore, "soon"));
    steps.push({ purpose: "VISIT_REMINDER_SOON", dueAt: new Date(twoBefore).toISOString(), key: `${o.visitId}:VISIT_REMINDER_SOON`, visitId: o.visitId });
  }
  steps.push({
    purpose: "NO_SHOW_CHECK",
    dueAt: new Date(at + RECOVERY[0].offset * MIN).toISOString(),
    key: `${o.visitId}:NO_SHOW_CHECK`,
    visitId: o.visitId,
  });
  return steps;
}

/**
 * The hour a buyer agreed was full: three others go on WhatsApp at once, held
 * for ten minutes, and an hour later a person is told if none was picked.
 */
export function offerSteps(o: { leadId: string; visitId: string; nowIso: string }): Step[] {
  return [
    { purpose: "SLOT_OFFER", dueAt: o.nowIso, key: `${o.visitId}:SLOT_OFFER`, visitId: o.visitId },
    { purpose: "OFFER_CHECK", dueAt: new Date(Date.parse(o.nowIso) + HOUR).toISOString(), key: `${o.visitId}:OFFER_CHECK`, visitId: o.visitId },
  ];
}

/** The recovery ladder `visit-rules.ts` draws, from the missed slot. */
export function noShowSteps(o: { leadId: string; visitId: string; atIso: string; nowIso: string }): Step[] {
  const at = Date.parse(o.atIso);
  const when = (offsetMin: number) => new Date(Math.max(at + offsetMin * MIN, Date.parse(o.nowIso))).toISOString();
  return [
    { purpose: "NO_SHOW", dueAt: when(RECOVERY[0].offset), key: `${o.visitId}:NO_SHOW`, visitId: o.visitId },
    {
      purpose: "RECOVERY_CALL",
      dueAt: nextOpening(when(RECOVERY[1].offset), spreadOf(o.leadId)),
      key: `${o.visitId}:RECOVERY_CALL`,
      visitId: o.visitId,
    },
    { purpose: "NO_SHOW_FOLLOWUP", dueAt: nextOpening(when(RECOVERY[2].offset)), key: `${o.visitId}:NO_SHOW_FOLLOWUP`, visitId: o.visitId },
    { purpose: "LAPSE_CHECK", dueAt: when(RECOVERY[3].offset), key: `${o.visitId}:LAPSE_CHECK`, visitId: o.visitId },
  ];
}

/**
 * After the host records the visit: thanks now, a nudge in three days. With
 * the post-visit agent switched on, a call the next day in between
 * (`followUpCall`), a little after eleven.
 */
/**
 * What the objection recorded on a visit starts, beside the usual follow-up:
 * price sends the EMI on the unit they saw, a loan asks whether a lender may
 * call, the family offers a revisit. Anything else is the owner's, as always.
 * Half an hour after the visit, so the buyer is out of the gallery; the
 * revisit after two, so it does not arrive on the drive home.
 */
export function objectionSteps(o: { leadId: string; visitId: string; objection: string; unitIds: string[]; nowIso: string }): Step[] {
  const at = (min: number) => new Date(Date.parse(o.nowIso) + min * 60_000).toISOString();
  switch (o.objection) {
    case "Price":
      return [{ purpose: "VISIT_EMI", dueAt: at(30), key: `${o.visitId}:VISIT_EMI`, visitId: o.visitId, detail: { units: o.unitIds.slice(0, 6) } }];
    case "Loan":
      return [{ purpose: "LENDER_ASK", dueAt: at(30), key: `${o.visitId}:LENDER_ASK`, visitId: o.visitId }];
    case "Family":
      // No visit named: the times are fresh ones, not the hour they came.
      return [{ purpose: "REVISIT_OFFER", dueAt: at(120), key: `${o.visitId}:REVISIT_OFFER` }];
    default:
      return [];
  }
}

/**
 * The days after a visit the re-engager rings to ask where the buyer stands,
 * until they book (the client, 4 October 2026): day 3 and day 5.
 */
export const VISIT_FOLLOWUP_DAYS = [3, 5] as const;

/**
 * What a follow-up call after the visit decides. It runs on the re-engager,
 * which records the qualifier's own fields, so it reads those: a second
 * visit booked, a hand-off, a call back, a hot buyer. Price is never
 * negotiated on it: a buyer ready to talk money or book goes to a person,
 * and the follow-ups still due are called off, because a person now has it.
 */
export function afterVisitFollowUp(c: CallEnded): CallDecision {
  const v = c.vars ?? {};
  const spread = spreadOf(c.leadId);
  const facts: Facts = { ...c.facts };
  const temperature = callTemperature(c.route, v);
  const out: CallDecision = { ...noDecision(), temperature, move: forward(c, "visit_done", facts, "Followed up after the visit") };

  if (v.site_visit_status === "booked") {
    const said = textOf(v.site_visit_time);
    const at = said ? parseVisitTime(said, c.nowIso, c.visitHours) : null;
    if (at) return { ...out, visit: { at: at.at, askedFor: said ?? "" } };
    out.needsPerson = `Wants another visit${said ? ` ("${said.slice(0, 60)}")` : ""}. Fix the time`;
    return out;
  }
  if (c.outcome === "HANDED_OFF") {
    return { ...out, cancelPending: true, needsPerson: "Handed to sales on the follow-up after the visit. Follow up today" };
  }
  if (temperature === "HOT") {
    return { ...out, cancelPending: true, temperature: "HOT", needsPerson: "Ready to book after the visit. Call today" };
  }
  if (c.outcome === "CALLBACK" && c.autoCalls < MAX_AUTO_CALLS && c.visitId) {
    out.steps.push({
      purpose: "VISIT_FOLLOWUP_CALL",
      dueAt: callbackDue(c, spread),
      key: `${c.visitId}:VISIT_FOLLOWUP_CALL:${c.callId}`,
      visitId: c.visitId,
      detail: { day: c.attempt },
    });
  }
  return out;
}

export function postVisitSteps(o: { leadId: string; visitId: string; nowIso: string; followUpCall?: boolean; followUps?: boolean }): Step[] {
  const call: Step[] = o.followUpCall
    ? [
        {
          purpose: "POST_VISIT_CALL",
          dueAt: nextOpening(istAt(addDays(ist(o.nowIso).date, 1), "11:00"), spreadOf(o.leadId)),
          key: `${o.visitId}:POST_VISIT_CALL:1`,
          visitId: o.visitId,
          detail: { attempt: 1 },
        },
      ]
    : [];
  // Day 3 and day 5: the re-engager asks where they stand, until they book.
  const followUps: Step[] = o.followUps
    ? VISIT_FOLLOWUP_DAYS.map((day) => ({
        purpose: "VISIT_FOLLOWUP_CALL" as const,
        dueAt: nextOpening(istAt(addDays(ist(o.nowIso).date, day), "11:30"), spreadOf(o.leadId)),
        key: `${o.visitId}:VISIT_FOLLOWUP_CALL:${day}`,
        visitId: o.visitId,
        detail: { attempt: day, day },
      }))
    : [];
  return [
    { purpose: "POST_VISIT", dueAt: o.nowIso, key: `${o.visitId}:POST_VISIT`, visitId: o.visitId },
    ...call,
    ...followUps,
    {
      purpose: "POST_VISIT_FOLLOWUP",
      dueAt: nextOpening(new Date(Date.parse(o.nowIso) + 3 * DAY).toISOString(), spreadOf(o.leadId)),
      key: `${o.visitId}:POST_VISIT_FOLLOWUP`,
      visitId: o.visitId,
    },
  ];
}

// ---------------------------------------------------------------------------
// A person moved the card
// ---------------------------------------------------------------------------

/**
 * What a move on the board starts. Booked welcomes the buyer, asks for a
 * referral three days later (section 09's "inside 72 hours") and checks in
 * monthly. Nurture with a follow-up date calls on that date. Lost stops
 * everything. Anything else leaves the cadence already running alone.
 */
export function afterMove(o: { leadId: string; to: StageKey; from: StageKey; followUpOn: string | null; nowIso: string }): {
  steps: Step[];
  cancelPending: boolean;
} {
  if (o.to === "lost") return { steps: [], cancelPending: true };
  if (o.to === "booked" && o.from !== "booked") {
    const spread = spreadOf(o.leadId);
    const in3 = nextOpening(new Date(Date.parse(o.nowIso) + 3 * DAY).toISOString(), spread);
    const in30 = nextOpening(new Date(Date.parse(o.nowIso) + 30 * DAY).toISOString(), spread);
    return {
      cancelPending: true,
      steps: [
        { purpose: "BOOKING", dueAt: o.nowIso, key: `${o.leadId}:BOOKING:${ist(o.nowIso).date}` },
        { purpose: "REFERRAL", dueAt: in3, key: `${o.leadId}:REFERRAL:${ist(in3).date.slice(0, 7)}` },
        { purpose: "BOOKED_CHECKIN", dueAt: in30, key: `${o.leadId}:BOOKED_CHECKIN:${ist(in30).date.slice(0, 7)}` },
      ],
    };
  }
  if (o.from === "booked" && o.to !== "booked") return { steps: [], cancelPending: true };
  if (o.to === "nurture") {
    const steps = nurtureSteps(o.leadId, o.nowIso, 30);
    if (o.followUpOn) {
      steps.push({
        purpose: "REENGAGE_CALL",
        dueAt: nextOpening(istAt(o.followUpOn, "11:00"), spreadOf(o.leadId)),
        key: `${o.leadId}:REENGAGE_CALL:${o.followUpOn}`,
      });
    }
    return { steps, cancelPending: true };
  }
  return { steps: [], cancelPending: false };
}

/** After a monthly message went, the next month's. */
export function nextMonthly(purpose: "NURTURE" | "BOOKED_CHECKIN", leadId: string, nowIso: string): Step {
  const at = nextOpening(new Date(Date.parse(nowIso) + 30 * DAY).toISOString(), spreadOf(leadId));
  return { purpose, dueAt: at, key: `${leadId}:${purpose}:${ist(at).date.slice(0, 7)}` };
}

// ---------------------------------------------------------------------------
// Whether a step still makes sense when its time comes
// ---------------------------------------------------------------------------

/**
 * Checked when a step runs, not when it was scheduled, because the lead may
 * have moved on in between. A follow-up call to somebody who has since
 * booked, or a reminder for a visit that was moved, is a mistake the buyer
 * notices.
 */
export function stillRelevant(p: Purpose, o: { stage: StageKey; visitStatus: string | null }): string | null {
  const s = o.stage;
  if (s === "lost") return "The lead is closed";
  switch (p) {
    // The buyer asked for this call, so it is made whatever stage the lead
    // reached since; only a booking settles it.
    case "CALLBACK":
      return s === "booked" ? "Already booked" : null;
    case "FIRST_CALL":
    case "RETRY_CALL":
      return isPath(s) && pathIndex(s) >= pathIndex("visit_scheduled") ? "Already past qualifying" : null;
    case "REENGAGE_CALL":
    case "NURTURE":
      return s === "booked" || (isPath(s) && pathIndex(s) >= pathIndex("visit_scheduled")) ? "Already moving" : null;
    case "MISSED_CALL":
    case "ACK":
    case "AFTER_CALL":
    case "PROJECT_DETAILS":
      return s === "booked" ? "Already booked" : null;
    case "VISIT_CONFIRMED":
    case "VISIT_REMINDER_DAY":
    case "VISIT_REMINDER_SOON":
    case "CONFIRM_CALL":
    case "NO_SHOW_CHECK":
    case "ADMIT_CHECK":
      return o.visitStatus === "CONFIRMED" ? null : "The visit is no longer on";
    case "BRIDGE":
      return s === "booked" ? "Already booked" : null;
    case "SLOT_OFFER":
    case "OFFER_CHECK":
      return o.visitStatus === "REQUESTED" ? null : "A time was already fixed";
    case "VISIT_REOFFER":
      return s === "booked" || (isPath(s) && pathIndex(s) >= pathIndex("visit_scheduled")) ? "Already booked a visit" : null;
    case "VISIT_CANCELLED":
      return o.visitStatus === "CANCELLED" ? null : "The visit is on again";
    case "VISIT_EMI":
    case "LENDER_ASK":
      return s === "booked" ? "The lead moved on" : null;
    case "REVISIT_OFFER":
      return s === "booked" || s === "visit_scheduled" ? "Already booked a visit" : null;
    // Sent by the quote itself, never scheduled.
    case "TOKEN_LINK":
    // Sent by the loan executive's press, never scheduled.
    case "LOAN_SHARE_ASK":
      return null;
    case "NO_SHOW":
    case "NO_SHOW_FOLLOWUP":
    case "RECOVERY_CALL":
    case "LAPSE_CHECK":
      return o.visitStatus === "NO_SHOW" ? null : "The visit was rebooked or recovered";
    case "POST_VISIT":
      return o.visitStatus === "VISITED" ? null : "The visit is no longer recorded as made";
    case "POST_VISIT_FOLLOWUP":
    case "POST_VISIT_CALL":
    case "VISIT_FOLLOWUP_CALL":
      return s === "visit_done" ? null : "The lead moved on";
    case "BOOKING":
    case "REFERRAL":
    case "BOOKED_CHECKIN":
      return s === "booked" ? null : "No longer booked";
    case "SITE_LOCATION":
      return null;
    // Sent to a channel partner by the payout itself, never scheduled on a lead.
    case "PARTNER_PAYOUT":
      return "Not a message to the buyer";
  }
}
