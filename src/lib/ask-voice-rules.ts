/**
 * Asking Jimmy by voice: the pure half, safe in the browser and on the server.
 *
 * A person taps the microphone, speaks, taps again. The clip goes to the
 * server, which checks the allowance, has Sarvam's Saaras v3 write it down
 * in Roman letters (so "Tower C mein is hafte kitne visits hue?" arrives the
 * way a sales head would type it), and hands the words back to the box. The
 * person reads them and presses send; nothing is asked by itself. The audio
 * is never stored, anywhere.
 *
 * A clip is one Saaras request, which takes thirty seconds at most, so the
 * recorder stops itself there and no clip is ever cut.
 */

/** Saaras's REST endpoint takes thirty seconds of audio at most. */
export const VOICE_MAX_SECONDS = 30;
/** Shorter than this is a slip of the thumb, not a question. */
export const VOICE_MIN_SECONDS = 1;
/**
 * Thirty seconds is about 120 KB of Opus and 480 KB of AAC; uncompressed
 * 16 kHz audio would be about 960 KB. Anything larger is not a clip from
 * this screen.
 */
export const VOICE_MAX_BYTES = 1_500_000;

/**
 * Clips a person may have written down: the same as the questions they may
 * ask (`DAILY_QUESTIONS`, `MONTHLY_QUESTIONS_PER_PROJECT` in ask-rules.ts,
 * restated here so the browser need not load the data map; `check:logic`
 * holds them equal). A clip is not a question, so it never uses one up: the
 * words it gives back are asked, and counted, when they are sent.
 */
export const VOICE_PER_DAY = 60;
export const VOICE_PER_PROJECT_MONTH = 1000;

/** Rs 30 an hour of audio (Saaras v3, billed by the second), at Rs 91 to the dollar. */
export const VOICE_RS_PER_SECOND = 30 / 3600;
export const VOICE_USD_TO_RS = 91;

/** What a browser's recorder produces, and what Saaras accepts. */
const TYPES: Record<string, string> = {
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/mp4": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/aac": "audio/aac",
  "audio/mpeg": "audio/mpeg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
};

/** The recorder's formats, best first: Chrome and Android record Opus in WebM, Safari AAC in MP4. */
export const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

/** The first format this browser's recorder can make, or null for "let it choose". */
export function recorderType(supported: (type: string) => boolean): string | null {
  return RECORDER_TYPES.find((t) => {
    try {
      return supported(t);
    } catch {
      return false;
    }
  }) ?? null;
}

/** A content type as sent ("audio/webm;codecs=opus"), read down to one Saaras accepts, or null. */
export function voiceType(raw: string | null | undefined): string | null {
  const base = (raw ?? "").split(";")[0].trim().toLowerCase();
  return TYPES[base] ?? null;
}

/** The file name Saaras is told, so its extension agrees with the type. */
export function voiceFileName(type: string): string {
  const ext: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  return `question.${ext[type] ?? "webm"}`;
}

/** What is wrong with a clip before anybody is paid to hear it, in the person's words. */
export function voiceProblem(clip: { type: string | null; bytes: number; seconds?: number | null }): string | null {
  if (!clip.type) return "That recording could not be read. Try again.";
  if (clip.bytes < 200) return "That was too short. Tap the microphone, speak, then tap again.";
  // Saaras refuses past thirty seconds, so a longer clip is refused here
  // first: it reached Saaras, failed, and was told to "try again".
  if (clip.bytes > VOICE_MAX_BYTES || (clip.seconds ?? 0) > VOICE_MAX_SECONDS + 0.5) return `Keep it under ${VOICE_MAX_SECONDS} seconds.`;
  return null;
}

/** The length the browser says it recorded, as said, before it is held to the recorder's limit. */
export function saidSeconds(said: unknown): number | null {
  const n = typeof said === "string" ? Number(said) : typeof said === "number" ? said : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * The seconds a clip is metered at. The browser says how long it recorded;
 * the number is only ever our own cost record, never a charge, and it is
 * held to what the recorder can make.
 */
export function voiceSeconds(said: unknown): number {
  const n = typeof said === "string" ? Number(said) : typeof said === "number" ? said : NaN;
  if (!Number.isFinite(n)) return VOICE_MAX_SECONDS;
  return Math.max(VOICE_MIN_SECONDS, Math.min(VOICE_MAX_SECONDS, Math.ceil(n)));
}

/** What writing a clip down costs us, in dollars, for `ask_usage`. */
export function voiceUsd(seconds: number): number {
  return Math.round(((seconds * VOICE_RS_PER_SECOND) / VOICE_USD_TO_RS) * 1e6) / 1e6;
}

/**
 * A channel partner's plan, for the month's ceilings: the questions it was
 * sold for the whole business, and the projects it covers at once.
 */
export type PartnerAsk = { questions: number; projects: number };

/**
 * The month's ceilings for an organisation. A developer or a mandate firm
 * gets each per project, pooled. A channel partner pays one plan for all its
 * projects, so its questions and clips are the plan's own number however
 * many projects it adds, and its answers read aloud stop at the projects the
 * plan covers, which is what the plan was priced on.
 */
export function askMonthLimits(input: { projects: number; partner?: PartnerAsk | null }): { questions: number; voice: number; listen: number } {
  const projects = Math.max(1, input.projects);
  if (input.partner) {
    return {
      questions: input.partner.questions,
      voice: input.partner.questions,
      listen: LISTEN_PER_PROJECT_MONTH * Math.max(1, Math.min(projects, input.partner.projects)),
    };
  }
  return { questions: VOICE_PER_PROJECT_MONTH * projects, voice: VOICE_PER_PROJECT_MONTH * projects, listen: LISTEN_PER_PROJECT_MONTH * projects };
}

/** The clip allowance, asked before Saaras is. Null when there is room. */
export function overVoiceAllowance(input: { todayByPerson: number; monthByOrg: number; projects: number; partner?: PartnerAsk | null }): string | null {
  if (input.todayByPerson >= VOICE_PER_DAY) return "You've used today's voice questions. Type your question, or try again tomorrow.";
  if (input.monthByOrg >= askMonthLimits(input).voice) {
    return "Your organisation has used this month's voice questions. Type your question instead.";
  }
  return null;
}

/** The words Saaras wrote, made ready for the box: one line, no stray spaces, never longer than a question. */
export function cleanTranscript(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** Where the words a person spoke go: after anything already typed, with one space between. */
export function joinSpoken(typed: string, spoken: string): string {
  const a = typed.trimEnd();
  return a ? `${a} ${spoken}` : spoken;
}

/** A recorder or microphone failure, in the person's words. `name` is the DOMException's. */
export function micProblem(name: string | undefined): string {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "The microphone is blocked. Allow it for this site in your browser's settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found on this device.";
    case "NotReadableError":
    case "AbortError":
      return "Another app is using the microphone. Close it and try again.";
    default:
      return "The microphone could not be started. Try again.";
  }
}

/** "0:07". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// An answer read aloud
// ---------------------------------------------------------------------------
//
// A speaker on an answer: its words go to Sarvam's Bulbul v3, in the chat's
// language (Roman Hinglish is read by a Hindi voice, which reads it the way
// it is said), and the sound comes back to the one request that asked. It is
// never stored. The allowance is asked before Bulbul is paid, and the cost
// joins the day's dollars in `ask_usage`, beside the questions and clips.

/**
 * The most of an answer that is read: its first sentences up to this many
 * letters, about thirty-five seconds of speech. Bulbul bills by the letter,
 * so this is what holds the worst case (`doc/pricing.md`).
 */
export const LISTEN_MAX_CHARS = 500;
/** Answers a person may have read aloud in an IST day. */
export const LISTEN_PER_DAY = 10;
/**
 * And an organisation in a month, for each of its projects, pooled like the
 * questions. Scale's worst case had Rs 121 of room above its 50% floor on 30
 * September 2026; 60 reads at the Rs 1.50 ceiling is Rs 90 of it.
 */
export const LISTEN_PER_PROJECT_MONTH = 60;
/** Bulbul v3: Rs 30 for 10,000 letters, billed by the letter (Sarvam's list price, 30 September 2026). */
export const LISTEN_RS_PER_CHAR = 30 / 10_000;
/** The Bulbul v3 speaker who reads Jimmy: Priya, the same voice that calls buyers. */
export const LISTEN_SPEAKER = "priya";

/** What reading these words costs us, in dollars, for `ask_usage`. */
export function listenUsd(chars: number): number {
  return Math.round(((Math.max(0, chars) * LISTEN_RS_PER_CHAR) / VOICE_USD_TO_RS) * 1e6) / 1e6;
}

/**
 * The words of an answer as they are said: bold, links and headings reduced
 * to their words, a table's rows left out (a table is read with the eyes),
 * and the whole cut after the last full sentence that fits in
 * `LISTEN_MAX_CHARS`, so a long answer is read to a full stop rather than
 * stopped mid-word.
 */
export function spokenAnswer(body: string, max = LISTEN_MAX_CHARS): string {
  const text = body
    .split(/\r?\n/)
    .filter((l) => !/^\s*\|/.test(l))
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, ""))
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "), head.lastIndexOf("। "));
  if (stop > max / 3) return head.slice(0, stop + 1).trim();
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trim();
}

/**
 * The language Bulbul is told. Devanagari, and Hinglish in Roman letters,
 * are read by the Hindi voice; everything else in English. `hinglish` is the
 * data map's own reading of the question or the answer (`questionLanguage()`).
 */
export function listenLanguage(o: { text: string; hinglish: boolean }): "hi-IN" | "en-IN" {
  return /[\u0900-\u097F]/.test(o.text) || o.hinglish ? "hi-IN" : "en-IN";
}

/** The read-aloud allowance, asked before Bulbul is. Null when there is room. */
export function overListenAllowance(input: { todayByPerson: number; monthByOrg: number; projects: number; partner?: PartnerAsk | null }): string | null {
  if (input.todayByPerson >= LISTEN_PER_DAY) return "You've had today's answers read aloud. Try again tomorrow.";
  if (input.monthByOrg >= askMonthLimits(input).listen) {
    return "Your organisation has used this month's answers read aloud.";
  }
  return null;
}
