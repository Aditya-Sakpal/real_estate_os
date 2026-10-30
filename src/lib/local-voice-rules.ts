/**
 * The voice fix for a film in Hindi or Marathi (8 October 2026). The video's
 * voice reads Devanagari like an English speaker: the first Hindi film said
 * गोरेगांव as "घोरेगम", करोड़ as "कराह", देर as "धियर" and समय as "smile".
 * So every line is heard back in its own script, and a line with a word
 * heard wrong (or with a name or a price unit in it, which no listen can be
 * trusted on) is said again WHOLE in the narrator's own voice, cloned by
 * Sarvam from the film itself, and put in where the line was. A line is
 * swapped rather than a word because a Hindi word cut into a different
 * take's breath reads as a join; the lines that were right keep the film's
 * own performance.
 *
 * Pure, client-safe and covered by `check:logic`. `local-voice.ts` runs it.
 */
import { numberIn, spokenFormIn } from "./film-language-rules.ts";
import { numberWords, spokenForm } from "./film-rules.ts";

/**
 * The languages a narration is made and heard in. English joined Hindi and
 * Marathi on 9 October 2026: an English story said by the video model came
 * back "Goremad West" and "two point one nine krong", and its fix was lost.
 */
export type VoiceCode = "hi" | "mr" | "en";

/** A line as it is said: its numbers, prices and units in words. */
export const sayLine = (line: string, code: VoiceCode): string => (code === "en" ? spokenForm(line) : spokenFormIn(line, code));
const numberSaid = (n: number, code: VoiceCode): string => (code === "en" ? numberWords(n) : numberIn(n, code));

export const LOCAL_VOICE = {
  /** Lines said again in one film, at most. */
  maxLines: 8,
  /** Takes of a line from Sarvam's clone, then from ElevenLabs'. */
  sarvamTakes: 3,
  elevenTakes: 2,
  /** The reference clip handed to the clone: the film's own voice, its silences taken out. */
  refSeconds: 14,
  /** How far a take may be sped up or slowed to fit its place. */
  fastest: 1.2,
  slowest: 0.88,
  /** Kept clear before the next line starts. */
  gap: 0.12,
} as const;

/** Words no listen is trusted on: the line holding one is always said again. */
export const ALWAYS_SAID_AGAIN: readonly string[] = ["गोरेगांव", "गोरेगाव", "करोड़", "करोड", "कोटी"];

/** A word as compared: digits in words, no punctuation, no nukta, a chandrabindu read as an anusvara. */
export function normWord(w: string, code: VoiceCode): string {
  return w
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    // A transcriber writes "2.19" for "two point one nine".
    .replace(/(\d+)\.(\d+)/g, (_, a: string, b: string) => (code === "en" ? `${a} point ${b.split("").join(" ")}` : `${a}.${b}`))
    .replace(/\d+/g, (n) => ` ${numberSaid(Number(n), code)} `)
    .replace(/[^\p{L}\p{M}\s]/gu, " ")
    .replace(/़/g, "")
    .replace(/ँ/g, "ं")
    .toLowerCase()
    .trim();
}

export function tokens(text: string, code: VoiceCode): string[] {
  return normWord(text, code).split(/\s+/).filter(Boolean);
}

function lev(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** How alike two words are, 0 to 1, letter by letter. */
export function likeness(a: string, b: string): number {
  return 1 - lev(a, b) / Math.max(a.length, b.length, 1);
}

export type Heard = { text: string; start: number; end: number };

/**
 * The script's words lined up with the words heard, in order: each script
 * word gets the heard word it most resembles, or none. A heard word that is
 * the same in a different spelling (बीएच के for बीएचके) is joined first.
 */
export function alignHeard(
  lines: readonly string[],
  heard: readonly Heard[],
  code: VoiceCode,
): { line: number; want: string; got: (Heard & { w: string }) | null }[] {
  const want = lines.flatMap((l, line) => tokens(sayLine(l, code), code).map((w) => ({ w, line })));
  const got = heard.flatMap((h) => tokens(h.text, code).map((w) => ({ ...h, w })));
  const S = want.length;
  const H = got.length;
  const cost: number[][] = Array.from({ length: S + 1 }, (_, i) => Array.from({ length: H + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const back: string[][] = Array.from({ length: S + 1 }, (_, i) => Array.from({ length: H + 1 }, (_, j) => (i === 0 ? "h" : j === 0 ? "s" : "")));
  for (let i = 1; i <= S; i++) {
    for (let j = 1; j <= H; j++) {
      const m = cost[i - 1][j - 1] + (1 - likeness(want[i - 1].w, got[j - 1].w)) * 1.6;
      const s = cost[i - 1][j] + 1;
      const h = cost[i][j - 1] + 1;
      cost[i][j] = Math.min(m, s, h);
      back[i][j] = cost[i][j] === m ? "m" : cost[i][j] === s ? "s" : "h";
    }
  }
  const out: { line: number; want: string; got: (Heard & { w: string }) | null }[] = want.map((w) => ({ line: w.line, want: w.w, got: null }));
  for (let i = S, j = H; i > 0 || j > 0; ) {
    const op = back[i][j];
    if (op === "m") {
      out[i - 1].got = got[j - 1];
      i--;
      j--;
    } else if (op === "s") i--;
    else j--;
  }
  return out;
}

/** When each line was said, from the words heard; null for a line nobody heard. */
export function localSpans(lines: readonly string[], heard: readonly Heard[], code: VoiceCode): ({ start: number; end: number } | null)[] {
  const out: ({ start: number; end: number } | null)[] = lines.map(() => null);
  for (const a of alignHeard(lines, heard, code)) {
    if (!a.got) continue;
    const c = out[a.line];
    out[a.line] = c ? { start: Math.min(c.start, a.got.start), end: Math.max(c.end, a.got.end) } : { start: a.got.start, end: a.got.end };
  }
  return out;
}

/** The same word, allowing for how a transcriber spells it: exact, or one letter off in a long word. */
export function sameWord(want: string, got: string): boolean {
  if (want === got) return true;
  return want.length >= 6 && got[0] === want[0] && lev(want, got) <= 1;
}

export type LineFix = { line: number; reason: "misheard" | "name"; wrong: string[]; heard: string };

/**
 * The lines to say again, in order of the film: any with a word heard as
 * something else or not heard at all (each line heard on its own, in
 * Devanagari, so an English word in it is not read as wrong for its
 * script), and any holding a name or a price unit. A line nobody heard is
 * not one this can put back. At most `LOCAL_VOICE.maxLines`, the misheard first.
 */
export function linesToFix(lines: readonly string[], heard: readonly (string | null)[], code: VoiceCode): LineFix[] {
  const always = new Set(ALWAYS_SAID_AGAIN.map((w) => normWord(w, code)));
  const fixes: LineFix[] = [];
  lines.forEach((l, line) => {
    const h = heard[line];
    if (!l.trim() || h === null || h === undefined) return;
    const wrong = takeWrong(l, h, code);
    const named = tokens(sayLine(l, code), code).some((w) => always.has(w));
    if (!wrong.length && !named) return;
    fixes.push({ line, reason: wrong.length ? "misheard" : "name", wrong, heard: h });
  });
  return [...fixes.filter((f) => f.reason === "misheard"), ...fixes.filter((f) => f.reason === "name")]
    .slice(0, LOCAL_VOICE.maxLines)
    .sort((a, b) => a.line - b.line);
}

/** The words of a line a take did not say, as heard back; none when the take is right. */
export function takeWrong(line: string, heardText: string, code: VoiceCode): string[] {
  const want = tokens(sayLine(line, code), code);
  const got = tokens(heardText, code);
  const joined = got.join("");
  return want.filter((w) => !got.some((g) => sameWord(w, g)) && !joined.includes(w));
}

/**
 * The names a take broke in two: two capitalised words side by side in the
 * line ("Mindspace Malad") heard with a stop or a comma between them, which
 * is a pause inside the name. The narrator said "Mindspace. Malad" as two
 * things on the locality film of 13 October 2026. English lines only.
 */
export function namesBroken(line: string, heardText: string): string[] {
  const out: string[] = [];
  const pairs = line.matchAll(/\b([A-Z][A-Za-z]{2,})\s+([A-Z][A-Za-z]{2,})\b/g);
  for (const [, a, b] of pairs) {
    const re = new RegExp(`\\b${a}\\s*[.,;:!?\u2013\u2014-]+\\s*${b}\\b`, "i");
    if (re.test(heardText)) out.push(`${a} ${b}`);
  }
  return out;
}

/**
 * How a take is fitted to its place: its own speed when it fits before the
 * next line, else sped up as far as `fastest`; a take much shorter than the
 * line it replaces is slowed a little toward it. Null when it cannot fit.
 */
export function fitTake(take: number, place: { start: number; end: number }, next: number): { tempo: number; end: number } | null {
  const room = next - place.start - LOCAL_VOICE.gap;
  const was = place.end - place.start;
  if (take <= room) {
    const tempo = take < was * 0.8 ? Math.max(LOCAL_VOICE.slowest, take / (was * 0.9)) : 1;
    return { tempo, end: place.start + take / tempo };
  }
  const tempo = take / room;
  return tempo <= LOCAL_VOICE.fastest ? { tempo, end: place.start + room } : null;
}

/**
 * Words the film's voice said that no line has, outside every line's place:
 * the first Sarvam-written film had "Bright" before one line and "Nine
 * Bright" before another, said by nobody in the script (8 October 2026).
 * They are taken out of the voice, and the music under them stays.
 */
export function strayHeard(lines: readonly string[], heard: readonly Heard[], code: VoiceCode): Heard[] {
  const al = alignHeard(lines, heard, code);
  const used = new Set(al.flatMap((a) => (a.got ? [a.got.start] : [])));
  const spans = localSpans(lines, heard, code).filter((s): s is { start: number; end: number } => !!s);
  return heard.filter((h) => !used.has(h.start) && !spans.some((s) => h.end > s.start + 0.02 && h.start < s.end - 0.02));
}

// ---------------------------------------------------------------------------
// A Hindi or Marathi story's narration, recorded on its own (the client chose
// the voice "Amit" on 8 October 2026): every Hindi and Marathi property film
// studied records its voice-over apart from the picture, and the video
// model's Hindi voice was flat and said every line wrong. The film is made
// with its score and no voice; each line is then said by an expressive Hindi
// voice and laid over it where its shot is.
// ---------------------------------------------------------------------------

export const VOICEOVER = {
  /** ElevenLabs v3 voices from its library: a warm man and a calm woman, both narrators in Hindi. */
  male: "Sxk6njaoa7XLsAFT7WcN",
  female: "1qEiC6qsybMkmnNdVMbK",
  model: "eleven_v3",
  /** Takes of a line before the best one is kept, each heard back by Saaras. */
  takes: 3,
  /** A line starts this far into its shot. */
  lead: 0.25,
  /** How far a take may be sped up to fit before the next line. */
  fastest: 1.25,
} as const;

/** Where each line of a story goes in the film as it came back: its shot's planned start, stretched to the film's length. */
export function voiceoverPlaces(
  scenes: readonly { line: string; start: number; end: number }[],
  length: number,
): { line: number; text: string; at: number; room: number }[] {
  const planned = scenes.length ? scenes[scenes.length - 1].end : length;
  const k = planned > 0 ? length / planned : 1;
  const spoken = scenes.filter((s) => s.line.trim());
  return spoken.map((s, i) => {
    const at = Math.max(0.3, s.start * k + VOICEOVER.lead);
    const next = i + 1 < spoken.length ? Math.max(0.3, spoken[i + 1].start * k + VOICEOVER.lead) : length - 0.1;
    return { line: i, text: s.line, at, room: Math.max(0.6, next - at - 0.15) };
  });
}

/** An ElevenLabs v3 line: the delivery as its tag, the words as they are said. */
export function voiceoverText(said: string, delivery: string | null | undefined): string {
  const tag = String(delivery ?? "").replace(/[[\]]/g, "").split(/[,;]/)[0]?.trim();
  return tag ? `[${tag}] ${said}` : said;
}

/**
 * Where the video model's own voice can still be heard once ours is laid:
 * every stretch it spoke (its words, joined across short gaps, padded a
 * little) less the stretches our narrator covers. Demucs leaves a faint,
 * smeared copy of that voice in the score; under our narrator nobody hears
 * it, but when a line of ours moves (the first one always starts by 0.8 s)
 * it plays alone: "The day starts softly here" came back slow and blurry a
 * second time in a launch film (11 October 2026).
 */
export function bleedSpans(
  modelWords: readonly { start: number; end: number }[],
  ours: readonly ({ start: number; end: number } | null)[],
  pad = 0.12,
): { start: number; end: number }[] {
  const said = [...modelWords].sort((a, b) => a.start - b.start);
  const joined: { start: number; end: number }[] = [];
  for (const w of said) {
    const last = joined[joined.length - 1];
    if (last && w.start - last.end < 0.35) last.end = Math.max(last.end, w.end);
    else joined.push({ start: w.start, end: w.end });
  }
  const covers = ours.filter((x): x is { start: number; end: number } => !!x).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const j of joined) {
    let pieces = [{ start: Math.max(0, j.start - pad), end: j.end + pad }];
    for (const c of covers) {
      pieces = pieces.flatMap((p) => {
        if (c.end <= p.start || c.start >= p.end) return [p];
        return [
          ...(c.start > p.start ? [{ start: p.start, end: c.start }] : []),
          ...(c.end < p.end ? [{ start: c.end, end: p.end }] : []),
        ];
      });
    }
    out.push(...pieces.filter((p) => p.end - p.start >= 0.15));
  }
  return out.map((p) => ({ start: Math.round(p.start * 100) / 100, end: Math.round(p.end * 100) / 100 }));
}

/**
 * An ffmpeg filter that takes the voice band out of the score inside those
 * stretches and lowers what is left of it, easing in and out over a tenth
 * of a second, so the leftover voice cannot be heard and the music only
 * breathes in. Empty when there is nothing to hide.
 */
export function bleedFilter(spans: readonly { start: number; end: number }[], ramp = 0.1): string {
  if (!spans.length) return "";
  const w = spans
    .map((p) => `clip(min((t-${(p.start - ramp).toFixed(3)})/${ramp},(${(p.end + ramp).toFixed(3)}-t)/${ramp}),0,1)`)
    .reduce((a, b) => `max(${a},${b})`);
  const on = spans.map((p) => `between(t,${p.start.toFixed(2)},${p.end.toFixed(2)})`).join("+");
  return (
    `equalizer=f=1100:t=o:w=3.2:g=-24:enable='${on}',` +
    `volume=volume='1-0.6*${w}':eval=frame`
  );
}
