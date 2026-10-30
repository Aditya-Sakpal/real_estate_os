/**
 * Putting a ready buyer through to the sales team: who is rung, the Vobiz
 * instructions that ring them, and what Vobiz reports back. Pure and
 * database-free, covered by `check:logic`.
 *
 * The agent does not transfer the call itself. It asks Sales Desk, which
 * redirects the live Vobiz call to `ringXml()`: every free person on the team
 * is rung at once, the first to answer takes the buyer, and the others stop
 * ringing. Nobody answering ends in a recorded line and a flag on the lead.
 *
 * Two things start it: the agent asking (a price, an offer, negotiating,
 * payment or a loan, or the buyer asking for a person), and the call running
 * past `LONG_CALL_SECONDS`, which Sales Desk watches for itself because the
 * agent cannot keep time (`longCallDue()`, `handOffLongCalls()`).
 */

import type { AgentKind, Language } from "./call-rules.ts";

/** How long the team's phones ring before the agent rings the buyer back. */
export const RING_SECONDS = 25;

/**
 * How long after the agent asks before the buyer's line is moved, so the
 * agent finishes saying it is connecting them. Moved at once, "I will
 * connect you with the sales manager now" was cut off mid-sentence.
 */
export const HANDOFF_SPEAK_MS = 4000;

/**
 * Most phones rung at once. Every ringing phone is a call on the Vobiz
 * account, and the account allows a fixed number at once (3 today): the
 * buyer's own call is one, so two are left to ring. Raise it with the
 * account's channels (`HANDOFF_RING_MAX`).
 */
export const RING_MAX_DEFAULT = 2;

/**
 * A hand-off marked connected longer ago than this is treated as over even
 * if Vobiz never said so, so a lost hang-up report cannot bench a person for
 * the rest of the day.
 */
export const TALK_CAP_MINUTES = 90;

/**
 * A call with the AI that has run this long goes to a person: a buyer still
 * talking after five minutes is interested, and a person closes better. The
 * client's rule of 30 September 2026. Counted from when Vobiz first showed the
 * call in progress, so ringing time is not counted.
 */
export const LONG_CALL_SECONDS = 300;

/** How often the watcher looks at live calls. The hand-off lands this late at most. */
export const WATCH_SECONDS = 15;

/** Why a call went to a person: the agent asked, or it ran long. */
export type HandoffReason = "ASKED" | "LONG_CALL";

/**
 * Whether a call has run long enough to be handed over now. Only a call still
 * with the AI (placed, not finished, never handed over) and seen live.
 */
export function longCallDue(c: {
  status: string;
  handoffState: string | null;
  liveSince: string | null;
  now: string;
}): boolean {
  if (c.status !== "DIALLING" || c.handoffState !== null || !c.liveSince) return false;
  return Date.parse(c.now) - Date.parse(c.liveSince) >= LONG_CALL_SECONDS * 1000;
}

/**
 * Each agent's voice on Sarvam (Bulbul v3), set by hand on the agent and
 * mirrored here so the hand-off lines are played in the same voice: a buyer
 * who hears a second person mid-call is lost. The client's choice of 30
 * September 2026: Shubh for the qualifier, Priya for the rest, who is strong
 * in Hindi, Marathi and English alike.
 */
export type Voice = "shubh" | "priya";
export const AGENT_VOICE: Record<AgentKind, Voice> = {
  qualifier: "shubh",
  goal: "priya",
  reminder: "priya",
  recovery: "priya",
  reengage: "priya",
  post_visit: "priya",
  receptionist: "shubh",
};
export const VOICES: readonly Voice[] = ["shubh", "priya"];

/**
 * What a buyer handed over for a long call hears before the ring, so the
 * switch is not a surprise, per voice because Hindi says "I am connecting"
 * differently for a man and a woman. `CONNECT_LINE` is Vobiz's English
 * voice, for a line not yet recorded, because Vobiz has no Hindi or Marathi
 * voice.
 */
export const CONNECT_LINES: Record<Voice, Record<Language, string>> = {
  shubh: {
    hi: "कृपया लाइन पर बने रहिए, मैं आपको हमारे सेल्स एग्ज़ीक्यूटिव से जोड़ रहा हूँ।",
    mr: "कृपया लाइनवर थांबा, मी तुम्हाला आमच्या सेल्स एक्झिक्युटिव्हशी जोडत आहे.",
    en: "Please hold, I am connecting you to our sales executive.",
  },
  priya: {
    hi: "कृपया लाइन पर बने रहिए, मैं आपको हमारे सेल्स एग्ज़ीक्यूटिव से जोड़ रही हूँ।",
    mr: "कृपया लाइनवर थांबा, मी तुम्हाला आमच्या सेल्स एक्झिक्युटिव्हशी जोडत आहे.",
    en: "Please hold, I am connecting you to our sales executive.",
  },
};
export const CONNECT_LINE = CONNECT_LINES.priya.en;

/**
 * The recording to play for a hand-off line, or null for Vobiz's English
 * voice. The agent's own voice when recorded. A call-back line not yet
 * recorded in that voice falls back to Shubh's, which always exists: another
 * voice in the buyer's language beats an English robot. A connecting line
 * has no fallback.
 */
export function handoffAudio(kind: "busy" | "connect", language: Language, voice: Voice, recorded: readonly string[]): string | null {
  const own = `${kind}-${language}-${voice}.wav`;
  if (recorded.includes(own)) return own;
  const shubh = `${kind}-${language}-shubh.wav`;
  if (kind === "busy" && recorded.includes(shubh)) return shubh;
  return null;
}

export type Seller = {
  phone: string;
  onDuty: boolean;
  /** Talking to a buyer handed over, or being rung for one, right now. */
  busy: boolean;
  /** When they last took a buyer, or null. */
  lastTookAt: string | null;
};

/**
 * Who to ring, in order: on duty and not busy, the one who has waited
 * longest first, at most `max`. With nobody free, the organisation's own
 * hand-off number, unless that is somebody already busy. Empty means nobody
 * can be rung and the buyer hears the call-back line.
 */
export function ringList(team: readonly Seller[], fallback: string | null, max = RING_MAX_DEFAULT): string[] {
  const waited = (s: Seller) => (s.lastTookAt === null ? -Infinity : Date.parse(s.lastTookAt));
  const free = team
    .filter((s) => s.onDuty && !s.busy)
    .sort((a, b) => waited(a) - waited(b) || a.phone.localeCompare(b.phone))
    .slice(0, Math.max(1, max))
    .map((s) => s.phone);
  if (free.length) return free;
  if (fallback && !team.some((s) => s.phone === fallback && s.busy)) return [fallback];
  return [];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Ring every number at once and bridge the first to answer. The caller ID is
 * our own Vobiz number, which Vobiz requires for a PSTN leg. `redirect` is
 * true so the result URL decides what a buyer nobody answered hears.
 */
export function dialXml(o: {
  numbers: string[]; callerId: string; eventsUrl: string; resultUrl: string;
  /** A recording to play before the ring; beats `say`. */
  play?: string | null;
  /** English words for Vobiz's own voice before the ring. */
  say?: string | null;
}): string {
  const numbers = o.numbers.map((n) => `    <Number>${esc(n)}</Number>`).join("\n");
  const say = o.play
    ? `  <Play>${esc(o.play)}</Play>\n`
    : o.say ? `  <Speak voice="WOMAN" language="en-GB">${esc(o.say)}</Speak>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${say}  <Dial callerId="${esc(o.callerId)}" timeout="${RING_SECONDS}" timeLimit="3600" callbackUrl="${esc(o.eventsUrl)}" callbackMethod="POST" action="${esc(o.resultUrl)}" method="POST" redirect="true">
${numbers}
  </Dial>
</Response>`;
}

/** What a buyer nobody could take hears, then the call ends. */
export const BUSY_LINES: Record<Language, string> = {
  hi: "माफ़ कीजिए, हमारे सभी सेल्स मैनेजर अभी दूसरी कॉल पर हैं। उनमें से कोई आपको कुछ ही मिनटों में कॉल करेगा। धन्यवाद!",
  mr: "माफ करा, आमचे सगळे सेल्स मॅनेजर आत्ता दुसऱ्या कॉलवर आहेत. त्यांच्यापैकी कोणीतरी तुम्हाला काही मिनिटांत कॉल करेल. धन्यवाद!",
  en: "Sorry, all our sales managers are on other calls right now. One of them will call you back in a few minutes. Thank you!",
};

/** The recorded line when it exists, and Vobiz's English voice when it does not. */
export function busyXml(audioUrl: string | null): string {
  const say = audioUrl
    ? `  <Play>${esc(audioUrl)}</Play>`
    : `  <Speak voice="WOMAN" language="en-GB">${esc(BUSY_LINES.en)}</Speak>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${say}
  <Hangup/>
</Response>`;
}

export const HANGUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;

/** Vobiz sends numbers with or without the +. */
export function toE164(n: string | null | undefined): string | null {
  const d = (n ?? "").replace(/[^\d+]/g, "");
  if (!d) return null;
  const bare = d.replace(/^\+/, "").replace(/^0(?=[6-9]\d{9}$)/, "");
  if (/^[6-9]\d{9}$/.test(bare)) return `+91${bare}`;
  return /^[1-9]\d{7,14}$/.test(bare) ? `+${bare}` : null;
}

export type DialEvent =
  | { kind: "answered"; to: string | null }
  | { kind: "ended"; to: string | null; billS: number }
  | { kind: "ignored" };

/**
 * One of Vobiz's real-time Dial callbacks. A leg that lost the race to
 * another phone is expected and changes nothing.
 */
export function readDialEvent(p: Record<string, string>): DialEvent {
  const event = p.Event ?? "";
  const action = p.DialAction ?? "";
  const to = toE164(p.DialBLegTo);
  if (event === "DialAnswer" || event === "DialConnected" || action === "answer" || action === "connected") {
    return { kind: "answered", to };
  }
  if (event === "DialHangup" || action === "hangup") {
    if ((p.DialBLegHangupCause ?? "") === "LOSE_RACE") return { kind: "ignored" };
    const bill = Number(p.DialBLegBillDuration ?? p.BillDuration ?? "0");
    return { kind: "ended", to, billS: Number.isFinite(bill) && bill > 0 ? Math.round(bill) : 0 };
  }
  return { kind: "ignored" };
}

/** Vobiz's final Dial result: did anybody take the buyer. */
export function dialAnswered(p: Record<string, string>): boolean {
  return (p.DialStatus ?? "").toLowerCase() === "completed" && !!(p.DialBLegUUID ?? "");
}

// ---------------------------------------------------------------------------
// When nobody can take a hand-off
// ---------------------------------------------------------------------------

/**
 * Put at the top of a call's facts when nobody can take a hand-off (no free
 * person on the sales team and no hand-off number of the organisation's own).
 * Every outbound agent reads `project_facts`, so this reaches all of them,
 * and their voice copies, without a prompt edit. Written after Harbour View's
 * qualifier offered the sales manager to a buyer on an account with no sales
 * team, and the transfer failed on the call (24 October 2026): an offer that
 * cannot be kept is worse than none.
 */
export const NO_SALES_NOTE =
  "ON THIS CALL NOBODY FROM THE SALES TEAM CAN TAKE THE LINE. Never offer to connect the user to the sales manager or the sales team, never say you are connecting them, and never call connect_sales. " +
  "Wherever you would have offered the sales manager (a price question, a loan, the payment plan, an offer, which flats are free, anything not written below, a ready buyer, or a user asking for a person), " +
  "say once, in the user's language, that the sales manager will explain it properly and will call them back, such as \"Iske baare mein hamare sales manager aapko achhe se bata payenge, woh aapko jaldi call karenge\" " +
  "or in Marathi \"याबद्दल आमचे sales manager तुम्हाला नीट सांगतील, ते तुम्हाला लवकरच call करतील\", then carry on with your next question or a site visit. " +
  "Say that promise once in the call, never again. If the user wants to speak to someone right now, say it once more in a few words and close politely.";

/** A call's facts as sent: with the note above first when nobody can take a hand-off. */
export function withSalesNote(facts: string, salesReady: boolean): string {
  if (salesReady) return facts;
  return facts ? `${NO_SALES_NOTE}\n\n${facts}` : NO_SALES_NOTE;
}

/** What the lead says when a call promised the sales manager would ring back and nobody could take it then. */
export const PROMISED_SALES_CALL = "Was told on the call that the sales manager will call back. Call them";

/**
 * Whether the agent told the buyer the sales manager or team would be in
 * touch: any agent line naming them, in English or Devanagari. Only asked of
 * a call placed with nobody to hand off to, where naming them can only be
 * that promise.
 */
export function promisedSalesCall(turns: readonly { role: string; text: string }[]): boolean {
  return turns.some((t) => t.role === "agent" && /sales\s*(manager|team|head)|सेल्स\s*(मैनेजर|मॅनेजर|टीम)/i.test(t.text));
}

/**
 * What `connect_sales` answers when nobody can take the call: the agent's own
 * words to say, so it is honest about it. It said "due to some technical
 * reasons the connection didn't go through" once (24 October 2026), which
 * reads as our system breaking rather than a team not set up. Answered with
 * a 200, so the agent reads this instead of the tool's fixed failure line.
 */
export const NO_SALES_REPLY =
  "Not connected: nobody from the sales team can take the call right now. Tell the user plainly, in their language and in one short line, " +
  "that the sales team is not available to take the call right now so you cannot connect them directly, that you will let the team know, " +
  "and that the sales manager will call them back. Never call it a technical problem. Do not try to connect again on this call.";
