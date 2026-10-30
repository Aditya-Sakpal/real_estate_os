/**
 * Her voice, recorded before the film is made (19 October 2026, the client).
 * Pure, covered by `check:logic`; `voice-track.ts` records it.
 *
 * Until now a presenter's film was made speaking in the video model's own
 * voice, and the words it got wrong were said again by an instant clone of
 * that voice, cut in word by word. People heard the cut-in words as another
 * voice. Now every line is said first by a fixed ElevenLabs voice, each line
 * heard back by the listener (`listen.ts`) and said again until it is right,
 * and the lines are laid end to end at the times the plan gives them. That
 * recording goes to Seedance as `@Audio1`, which films her lips to it, and
 * the same recording is laid back over the finished film. One voice, every
 * word checked before anything is filmed, and the last line always fits,
 * because the scenes are timed from how long each line really takes.
 *
 * A word no take of a line says right is joined in by Cartesia's infill
 * (`cartesia.ts`) between the words around it, in a clone of the same voice.
 */
import { ACTION_SECONDS, actionsIn, spokenForm, type TimedScene } from "./film-rules.ts";
import { cloneText } from "./respeak-rules.ts";

export const TRACK = {
  /**
   * ElevenLabs library voices, young Indian English creators, used with
   * `eleven_v3`. "Monika Sogam, Youthful and Expressive" for her; "Akshat,
   * Deep and Conversational" for him. `TRACK_VOICE_FEMALE`, `TRACK_VOICE_MALE`.
   */
  female: "UYoWPkHjaRgjWccloxC5",
  male: "HM0qQxowG9aKQmddRXox",
  /**
   * `eleven_multilingual_v2`, which keeps to the pace asked for: `eleven_v3`
   * ignored it and read a reel at 2.5 words a second against a creator's
   * three or more, so a locality script Seedance said in 30 seconds took 33
   * as recorded (19 October 2026, seven voices measured). `TRACK_MODEL`.
   */
  model: process.env.TRACK_MODEL || "eleven_multilingual_v2",
  /** Her pace, about 3.2 words a second on this voice. */
  speed: 1.15,
  /** Takes of a line before Cartesia is asked to join in the words still wrong. */
  takes: 3,
  /** Words of one line Cartesia may join in; more than that and the best take stands. */
  infillWords: 2,
  /** Her first word, this far into the film. */
  firstLead: 0.25,
  /** Each later line, this far into its shot. */
  lead: 0.15,
  /** A breath after a line before the next shot. */
  breath: 0.3,
  /** Kept after the last line, so the film's end never cuts it off. */
  tail: 0.8,
  /** How far the whole recording may be sped up to fit the film; the writer's last draft may go to `lastFastest`. */
  fastest: 1.1,
  lastFastest: 1.2,
  /** A spoken shot may run this much past its line before time goes elsewhere. */
  slack: 1.0,
} as const;

/** The voice for the presenter, from the environment or the defaults above. */
export function trackVoice(male: boolean): string {
  return male ? process.env.TRACK_VOICE_MALE || TRACK.male : process.env.TRACK_VOICE_FEMALE || TRACK.female;
}

/** A line as the voice is asked to say it: words as they are said, and on `eleven_v3` how, as its tag (any other model would say the tag). */
export function trackText(line: string, delivery?: string | null, model: string = TRACK.model, respell = false): string {
  // A second take spells a local name the way a voice has said it right ("Goregao").
  const said = respell ? cloneText(line) : spokenForm(line);
  const tag = String(delivery ?? "").replace(/[[\]]/g, "").split(/[,;]/)[0]?.trim();
  return tag && model === "eleven_v3" ? `[${tag}] ${said}` : said;
}

/**
 * Whether a film is made to her recorded voice: a presenter's English film,
 * made fresh (a new version keeps the film's own voice), unless
 * `PRESENTER_TRACK=off`.
 */
export function usesTrack(o: { speech: string; language: string; revision: boolean; injected: boolean }): boolean {
  return o.speech === "presenter" && o.language === "en" && !o.revision && !o.injected && process.env.PRESENTER_TRACK !== "off";
}

export type TrackTiming = {
  /** Each scene's length, adding to the film's. */
  durations: number[];
  /** Where each spoken line starts in the film, by line (in the order said). */
  starts: number[];
  /** How much every line is sped up to fit (1 when it fits as said). */
  tempo: number;
};

const r1 = (n: number) => Math.round(n * 100) / 100;

/**
 * The scenes timed from the recording: a spoken shot runs its line (as the
 * voice really said it) from a small lead to a breath after, a silent one
 * long enough to see, and one with people doing things long enough for
 * them; the last line keeps `TRACK.tail` after it. Time left over goes to
 * the silent shots first, then to spoken ones up to `TRACK.slack` past
 * their line. Too long, the whole recording is sped up as far as
 * `TRACK.fastest`; still too long, null, and the film is planned as before.
 */
/** Each scene's line index (in the order said), -1 for a silent one. */
function linesOf(scenes: readonly TimedScene[]): number[] {
  let k = 0;
  return scenes.map((s) => (s.line?.trim() ? k++ : -1));
}

/** What each scene needs, its line said at `tempo`: the lead, the line, a breath (the tail after the last); people's actions; a silent shot's least. */
export function trackNeeds(scenes: readonly TimedScene[], lineSeconds: readonly number[], silent: { min: number; max: number }, tempo = 1): number[] {
  const lineOf = linesOf(scenes);
  const last = lineOf.reduce((a, l, i) => (l >= 0 ? i : a), -1);
  return scenes.map((s, i) => {
    const acts = s.shot && (s.kind === "people" || s.kind === "presenter") ? actionsIn(s.shot) * ACTION_SECONDS : 0;
    if (lineOf[i] < 0) return Math.max(silent.min, acts);
    const lead = i === 0 ? TRACK.firstLead : TRACK.lead;
    const speech = lead + (lineSeconds[lineOf[i]] ?? 0) / tempo + (i === last ? TRACK.tail : TRACK.breath);
    return Math.max(speech, acts);
  });
}

/**
 * What the writer is told when the lines, as said, do not fit: how long they
 * take, what the film needs and has, and about how many words to cut.
 */
export function trackTooLong(scenes: readonly TimedScene[], lineSeconds: readonly number[], seconds: number, silent: { min: number; max: number }): string {
  const need = trackNeeds(scenes, lineSeconds, silent).reduce((a, b) => a + b, 0);
  const said = lineSeconds.reduce((a, b) => a + b, 0);
  const words = scenes.reduce((a, s) => a + (s.line?.trim() ? s.line.trim().split(/\s+/).length : 0), 0);
  const wps = said > 0 ? words / said : 2.8;
  const cut = need - seconds + 0.5;
  const long = lineSeconds
    .map((x, i) => ({ x, i }))
    .sort((a, b) => b.x - a.x)
    .slice(0, 3)
    .map((l) => `line ${l.i + 1} (${l.x.toFixed(1)} s)`);
  return (
    `Said in her voice, your lines take ${said.toFixed(1)} seconds, and with each shot's moment before and after its line the film needs ` +
    `${need.toFixed(1)} and has ${seconds}: cut about ${cut.toFixed(1)} seconds, about ${Math.ceil(cut * wps)} words (she says about ` +
    `${wps.toFixed(1)} words a second). The longest are ${long.join(", ")}. Shorten them or drop a line; keep every place, its time and the close.`
  );
}

export function trackTiming(
  scenes: readonly TimedScene[],
  lineSeconds: readonly number[],
  seconds: number,
  silent: { min: number; max: number },
  fastest: number = TRACK.fastest,
): TrackTiming | null {
  if (!scenes.length) return null;
  const lineOf = linesOf(scenes);
  const k = lineOf.filter((l) => l >= 0).length;
  if (k !== lineSeconds.length || lineSeconds.some((x) => !(x > 0))) return null;
  const firstSpoken = lineOf.findIndex((l) => l >= 0);
  const plan = (tempo: number) => trackNeeds(scenes, lineSeconds, silent, tempo);
  let tempo = 1;
  let need = plan(1);
  let total = need.reduce((a, b) => a + b, 0);
  if (total > seconds) {
    // The speech alone decides how far to speed up: actions do not shrink.
    const speech = lineSeconds.reduce((a, b) => a + b, 0);
    const over = total - seconds;
    tempo = speech / Math.max(0.1, speech - over);
    if (tempo > fastest + 1e-9) return null;
    need = plan(tempo);
    total = need.reduce((a, b) => a + b, 0);
    if (total > seconds + 0.05) return null;
  }
  const cap = need.map((n, i) => (lineOf[i] < 0 ? Math.max(n, silent.max) : n + TRACK.slack));
  const t = [...need];
  let left = seconds - total;
  for (let pass = 0; pass < 40 && left > 1e-6; pass++) {
    let open = t.map((_, i) => i).filter((i) => t[i] < cap[i] - 1e-6);
    const lifted = !open.length;
    if (lifted) open = t.map((_, i) => i);
    const weight = (i: number) => (lineOf[i] < 0 ? 1 : 0.6);
    const sum = open.reduce((a, i) => a + weight(i), 0);
    let given = 0;
    for (const i of open) {
      const share = (left * weight(i)) / sum;
      const add = lifted ? share : Math.min(share, cap[i] - t[i]);
      t[i] += add;
      given += add;
    }
    left -= given;
  }
  // Hundredths, with the rounding given back to the last scene so the lengths add up exactly.
  const durations = t.map(r1);
  durations[durations.length - 1] = r1(durations[durations.length - 1] + (seconds - durations.reduce((a, b) => a + b, 0)));
  const starts: number[] = [];
  let at = 0;
  durations.forEach((d, i) => {
    if (lineOf[i] >= 0) starts.push(r1(at + (i === firstSpoken && i === 0 ? TRACK.firstLead : TRACK.lead)));
    at += d;
  });
  return { durations, starts, tempo: Math.round(tempo * 1000) / 1000 };
}

/** ElevenLabs' character times, as `/with-timestamps` gives them. */
export type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Where a word (or words) is said in a take, from the voice's own character
 * times: the first place its letters run in order, from its first letter's
 * start to its last letter's end. Null when the take does not hold it.
 */
export function wordSpan(al: Alignment, words: string): { start: number; end: number } | null {
  const want = plain(words);
  if (!want) return null;
  const idx: number[] = [];
  let text = "";
  al.characters.forEach((c, i) => {
    const p = plain(c);
    for (const ch of p) {
      text += ch;
      idx.push(i);
    }
  });
  const at = text.indexOf(want);
  if (at < 0) return null;
  const a = idx[at];
  const b = idx[at + want.length - 1];
  const start = al.character_start_times_seconds[a];
  const end = al.character_end_times_seconds[b];
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

/** Where to cut a take round a word for Cartesia: a little clear of the word on each side, inside the take. */
export function infillCut(span: { start: number; end: number }, length: number): { left: number; right: number } {
  return { left: Math.max(0, span.start - 0.03), right: Math.min(length, span.end + 0.03) };
}
