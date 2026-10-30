import { PRONOUNCE, spokenForm } from "./film-rules.ts";
import { sameSound } from "./listen-rules.ts";

/**
 * Re-saying the words a film's own voice got wrong, in her own voice, and
 * nothing else. The pure half: which words need it, what the clone is asked to
 * say, whether a take said it, and what the person is told.
 *
 * Seedance voices the whole film in one call, and now and then says a word
 * wrong ("block" for plot, "lag" for crore, "Goregon"). Replacing only those
 * words, each fitted to her pitch, loudness and length, was indistinguishable
 * from the rest of the film to the client on 29 September 2026; replacing her
 * whole voice with the clone was not (it lost her delivery), and is not done.
 */

/** A word as the transcriber heard it, with when. */
export type HeardWord = { text: string; start: number; end: number };

/** One stretch of a film to say again. */
export type WordFix = {
  /** Which spoken line of the script it is in (lines with words, in order). */
  line: number;
  /** Its words as the script says them, and their place among the line's words. */
  words: string[];
  from: number;
  to: number;
  /** What was heard there, and when. */
  heard: string;
  start: number;
  end: number;
  /** It ends a sentence: it keeps its own length and may run into the pause after it. */
  final: boolean;
  /** Seconds from its start to the next word she says. */
  room: number;
  /** Heard as something else, or a place name the transcriber cannot judge. */
  reason: "misheard" | "name";
};

export const RESPEAK = {
  /** At most this many words re-said in one film. */
  maxFixes: 8,
  /** Takes of one line the clone is asked for, the first that says it right is kept. */
  takesPerLine: 3,
  /** A gap this long after a word makes it the end of a sentence. */
  finalGap: 0.25,
  /**
   * A word inside a sentence is never made more than this much faster or
   * slower; what is left over is a breath. A Goregaon stretched by the 15 per
   * cent this allowed first came back washed out.
   */
  maxStretch: 0.1,
  /** A take whose word is within this of her word's length needs no other take. */
  closeEnough: 0.05,
  /** The clone's first pace, a touch quicker than its own, which is slower than hers. */
  startSpeed: 1.05,
  /**
   * A pause inside a line longer than this is a note: within a sentence, and
   * after a sentence that ends inside the line. "Up? Sea facing." came back
   * with 1.2 s after the question and 0.6 s between "sea" and "facing".
   */
  pauseInSentence: 0.5,
  pauseAfterSentence: 0.8,
} as const;

/**
 * The pace the next take is asked at, from how much longer her words ran
 * than this take's (inside a sentence; a word ending one keeps its own
 * length): a word she said a fifth longer asks for a take a fifth slower.
 * Within what the voice accepts (0.7 to 1.2).
 */
export function nextSpeed(speed: number, ratios: readonly number[]): number {
  const good = ratios.filter((r) => Number.isFinite(r) && r > 0);
  if (!good.length) return speed;
  const r = good.reduce((a, b) => a + b, 0) / good.length;
  return Math.round(Math.min(1.2, Math.max(0.7, speed / r)) * 100) / 100;
}

/** How much a take's word would have to be stretched to her word's length, as a fraction. */
export function stretchNeeded(herSeconds: number, takeSeconds: number): number {
  return herSeconds > 0 && takeSeconds > 0 ? Math.abs(herSeconds / takeSeconds - 1) : Infinity;
}

/**
 * How the clone is asked to say a name, tested on the clone and the
 * transcriber: "Goregaon" came back "Gurugram" and "Gurgaon" on some takes,
 * "Goregao" was heard as Goregaon three times out of three in both lines of
 * the test film, and it is how the client says it ends. One word each, so the
 * line keeps its word count.
 */
export const CLONE_SAY: Readonly<Record<string, string>> = {
  Goregaon: "Goregao",
};

/**
 * The words re-said wherever they are said, heard right or not: every listed
 * place name, and the price's unit. A transcriber writes a word it expects
 * whatever the voice said. On 2 October 2026 Scribe wrote "Goregaon" over a
 * film that said "Gorahand", and "Gorego" over one that said it right; and
 * after "1.45" both transcribers wrote "crore" for a voice that said
 * "Korai". No listen can be trusted on these words, so they are always said
 * again, and the script says each once (`repeatedNames()` in
 * `film-rules.ts`; a film quotes one price).
 */
export const ALWAYS_RESAID: ReadonlySet<string> = new Set([...Object.keys(PRONOUNCE).map((n) => n.toLowerCase()), "lakh"]);

/** The place names among them, which the person is told about by name. */
const PLACE_NAMES = new Set(Object.keys(PRONOUNCE).filter((n) => n !== "crore").map((n) => n.toLowerCase()));

/** The counts a configuration is said with ("one B H K"). */
const COUNTS = new Set(["one", "two", "three", "four", "five", "six"]);

// American and British spellings are one word said: "three kilometers" from
// the transcriber is the script's "three kilometres", and every take of it
// was turned down until 19 October 2026.
const SAME: Readonly<Record<string, string>> = {
  ok: "okay",
  kilometers: "kilometres",
  kilometer: "kilometre",
  meters: "metres",
  meter: "metre",
  centre: "center",
  centres: "centers",
  theatre: "theater",
  neighbour: "neighbor",
  neighbours: "neighbors",
  neighbourhood: "neighborhood",
  colour: "color",
  favourite: "favorite",
};

export type Tok = { w: string; from: number; to: number };

/** The words of a text as they are said, with where each sits in the text. */
export function sayTokens(text: string): Tok[] {
  const out: Tok[] = [];
  // A curly apostrophe is the same mark: "That’s" in a script was heard as
  // "That's", read as two wrong words, and cost six takes of the clone.
  const re = /[a-z0-9]+(?:['’ʼ][a-z]+)?/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = m[0].toLowerCase().replace(/[’ʼ]/g, "'");
    out.push({ w: SAME[w] ?? w, from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/** The words of a line in the order the voice says them. */
export const lineWords = (line: string) => sayTokens(spokenForm(line)).map((t) => t.w);

type Heard = { w: string; word: number; start: number; end: number };

/** Roughly how many syllables a word has: its groups of vowels, at least one. */
export function syllables(w: string): number {
  return Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) ?? []).length);
}

/**
 * Every heard word as it is said ("12-acre" is twelve, acre; "1.45" is one
 * point four five), each part given its share of the word's time by its
 * syllables. The transcriber writes "Jogeshwari-Vikhroli" as one word, and a
 * fix for Vikhroli alone once took the whole word's time: Jogeshwari was cut
 * out and Vikhroli drawn out over both (20 October 2026).
 */
function heardTokens(words: readonly HeardWord[]): Heard[] {
  return words.flatMap((h, word) => {
    const parts = sayTokens(spokenForm(h.text));
    if (parts.length < 2) return parts.map((t) => ({ w: t.w, word, start: h.start, end: h.end }));
    const weights = parts.map((t) => syllables(t.w));
    const total = weights.reduce((a, b) => a + b, 0);
    let at = h.start;
    return parts.map((t, k) => {
      const end = k === parts.length - 1 ? h.end : at + ((h.end - h.start) * weights[k]) / total;
      const tok = { w: t.w, word, start: Math.round(at * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
      at = end;
      return tok;
    });
  });
}

/**
 * Words that are all local names (`PRONOUNCE`): the transcriber writes these
 * however it likes ("Pikroli", "Kendrick Lamar"), so the listener alone
 * judges a take of one.
 */
export function localNamesOnly(words: readonly string[]): boolean {
  const names = new Set(Object.keys(PRONOUNCE).filter((n) => n !== "crore").flatMap((n) => sayTokens(n).map((t) => t.w)));
  return words.length > 0 && words.every((w) => names.has(w));
}

type Op = { kind: "same" | "sub" | "del" | "ins"; s: number; h: number };

/** The cheapest way to turn what was meant into what was heard, word by word. */
function align(want: readonly string[], got: readonly string[]): Op[] {
  const n = want.length;
  const m = got.length;
  const cost = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[i][j] = Math.min(cost[i - 1][j - 1] + (want[i - 1] === got[j - 1] ? 0 : 1), cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (want[i - 1] === got[j - 1] ? 0 : 1)) {
      ops.push({ kind: want[i - 1] === got[j - 1] ? "same" : "sub", s: i - 1, h: j - 1 });
      i--;
      j--;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      ops.push({ kind: "del", s: i - 1, h: -1 });
      i--;
    } else {
      ops.push({ kind: "ins", s: -1, h: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

/**
 * The words to say again, from the script's lines and what the film was heard
 * to say. A stretch the transcriber heard differently is re-said; so is every
 * listed place name, heard right or not. A word she left out has no place to
 * go and is only reported, and so is a stretch across two lines or of nothing
 * but short words. At most `RESPEAK.maxFixes`, the misheard first.
 *
 * With `listened` (the listener's verdict, `listen-rules.ts`), the listener
 * decides which words were said wrong and the transcript only times them: a
 * word it heard wrong is re-said even where the transcript wrote it as the
 * script has it ("km" for a voice that said "k-meter", 19 October 2026), and
 * a stretch only the transcript disagrees with is left alone.
 */
export function planFixes(
  lines: readonly string[],
  heard: readonly HeardWord[],
  seconds: number,
  listened: readonly { line: number; word: string; heard: string; kind: string }[] | null = null,
): { fixes: WordFix[]; missed: { words: string[]; line: number }[] } {
  const script = lines.flatMap((l, line) => lineWords(l).map((w, at) => ({ w, line, at })));
  const got = heardTokens(heard);
  const ops = align(script.map((s) => s.w), got.map((g) => g.w));
  const found: WordFix[] = [];
  const missed: { words: string[]; line: number }[] = [];
  // The script's words the listener heard said wrong, with what it heard.
  const flagged = new Map<number, string>();
  for (const p of listened ?? []) {
    if (p.kind !== "wrong") continue;
    const want = sayTokens(spokenForm(p.word)).map((t) => t.w);
    const inLine = script.map((t, i) => ({ t, i })).filter((x) => x.t.line === p.line);
    for (let k = 0; want.length && k + want.length <= inLine.length; k++) {
      if (want.every((w, o) => inLine[k + o].t.w === w)) want.forEach((_, o) => flagged.set(inLine[k + o].i, p.heard));
    }
  }

  const fixFrom = (ss: number[], hs: number[], reason: WordFix["reason"]) => {
    const toks = ss.map((i) => script[i]);
    const hw = [...new Set(hs.map((i) => got[i].word))].sort((a, b) => a - b);
    // The parts' own times, so a fix covers only its own part of a joined word.
    const lastTok = Math.max(...hs);
    const start = Math.min(...hs.map((i) => got[i].start));
    const end = Math.max(...hs.map((i) => got[i].end));
    const next = got[lastTok + 1] ?? null;
    found.push({
      line: toks[0].line,
      words: toks.map((t) => t.w),
      from: toks[0].at,
      to: toks[toks.length - 1].at + 1,
      heard: ss.some((i) => flagged.has(i))
        ? [...new Set(ss.flatMap((i) => (flagged.has(i) ? [flagged.get(i)!] : [])))].join(" ")
        : hw.map((i) => heard[i].text).join(" ").replace(/[^\p{L}\p{N}']+$/u, ""),
      start,
      end,
      final: !next || next.start - end >= RESPEAK.finalGap,
      room: Math.max(0, (next ? next.start : seconds) - start - 0.05),
      reason,
    });
  };

  let run: Op[] = [];
  const close = () => {
    const ss = run.filter((o) => o.s >= 0).map((o) => o.s);
    const hs = run.filter((o) => o.h >= 0).map((o) => o.h);
    run = [];
    if (!ss.length) return;
    // With the listener heard, only what it heard wrong is the transcript's to time.
    if (listened && !ss.some((i) => flagged.has(i))) return;
    const line = script[ss[0]].line;
    const words = ss.map((i) => script[i].w);
    // BHK is three short letters, and still a word worth saying again: it
    // came back "one, two, three homes" on 2 October 2026.
    const bhk = words.join(" ").includes("b h k");
    if (!hs.length || ss.some((i) => script[i].line !== line) || (words.every((w) => w.length < 3) && !bhk)) {
      missed.push({ words, line });
      return;
    }
    // The count before BHK is said with it ("one B H K"), or her "One," would
    // stand alone before the fixed letters.
    const before = ss[0] - 1;
    if (bhk && before >= 0 && script[before].line === line && COUNTS.has(script[before].w) && sameAt.has(before)) {
      ss.unshift(before);
      hs.unshift(sameAt.get(before)!);
    }
    fixFrom(ss, hs, "misheard");
  };
  const sameAt = new Map(ops.filter((o) => o.kind === "same").map((o) => [o.s, o.h] as const));
  for (const o of ops) {
    if (o.kind === "same") {
      close();
      if (flagged.has(o.s)) fixFrom([o.s], [o.h], "misheard");
      // A name is said again whatever the transcript wrote only when nobody
      // listened: the listener hears the sound itself, and re-saying a name it
      // heard right put a clone's word in her mouth for nothing (the client,
      // 20 October 2026: replace only the words said wrong).
      else if (!listened && ALWAYS_RESAID.has(script[o.s].w)) fixFrom([o.s], [o.h], "name");
    } else {
      run.push(o);
    }
  }
  close();

  // Two stretches next to each other in one line are said as one.
  const merged: WordFix[] = [];
  for (const f of found.sort((a, b) => a.start - b.start)) {
    const prev = merged[merged.length - 1];
    if (prev && prev.line === f.line && prev.to === f.from) {
      merged[merged.length - 1] = {
        ...prev,
        words: [...prev.words, ...f.words],
        to: f.to,
        heard: `${prev.heard} ${f.heard}`,
        end: f.end,
        final: f.final,
        room: f.start + f.room - prev.start,
        reason: prev.reason === "misheard" || f.reason === "misheard" ? "misheard" : "name",
      };
    } else {
      merged.push(f);
    }
  }
  const order = [...merged].sort((a, b) => (a.reason === b.reason ? a.start - b.start : a.reason === "misheard" ? -1 : 1));
  const kept = new Set(order.slice(0, RESPEAK.maxFixes));
  return { fixes: merged.filter((f) => kept.has(f)), missed };
}

/**
 * When each line was said, from what was heard: the first and last of the
 * line's words heard as written. A word heard as another is left out, since
 * the alignment will pair a word of a line she never said with whatever is
 * left over. Null for a line none of which was heard.
 */
export function lineSpans(lines: readonly string[], heard: readonly HeardWord[]): ({ start: number; end: number } | null)[] {
  const script = lines.flatMap((l, line) => lineWords(l).map((w) => ({ w, line })));
  const got = heardTokens(heard);
  const out: ({ start: number; end: number } | null)[] = lines.map(() => null);
  for (const o of align(script.map((t) => t.w), got.map((g) => g.w))) {
    if (o.kind !== "same") continue;
    const line = script[o.s].line;
    const g = got[o.h];
    const cur = out[line];
    out[line] = cur ? { start: Math.min(cur.start, g.start), end: Math.max(cur.end, g.end) } : { start: g.start, end: g.end };
  }
  return out;
}

/**
 * The lines the film never said at all, each with where it can be said in
 * her voice: just after the last line said before it, with room until the
 * next line said or the film's end. On 18 October 2026 the locality film's
 * close, "Book a site visit this weekend!", was never spoken: she pointed at
 * the lens in silence. A line with under 0.8 s of room is left to the notes.
 */
export function unsaidLines(
  lines: readonly string[],
  heard: readonly HeardWord[],
  length: number,
  /** The least room a line is returned with: 0.8 s to say it in, 0 to find every line never said. */
  minRoom = 0.8,
): { line: number; start: number; room: number }[] {
  const spans = lineSpans(lines, heard);
  const r = (n: number) => Math.round(n * 100) / 100;
  return lines.flatMap((l, i) => {
    if (spans[i] || !lineWords(l).length) return [];
    const before = spans.slice(0, i).filter((s): s is { start: number; end: number } => !!s);
    const after = spans.slice(i + 1).filter((s): s is { start: number; end: number } => !!s);
    const start = before.length ? Math.max(...before.map((s) => s.end)) + UNSAID_BREATH : 0.3;
    const room = (after.length ? Math.min(...after.map((s) => s.start)) : length) - start - 0.15;
    return room >= minRoom ? [{ line: i, start: r(start), room: r(Math.max(0, room)) }] : [];
  });
}

/** The breath before a line said in her voice where the film left it out. */
export const UNSAID_BREATH = 0.35;
/** How much quicker than the clone's own pace a missing line may be said to fit its room. */
export const UNSAID_MAX_TEMPO = 1.15;

/** A pause inside a line that the person should listen to. */
export type LinePause = { line: number; at: number; seconds: number; after: string };

/**
 * Pauses inside a line, from what was heard: between two of a line's words
 * heard as written, longer than `pauseInSentence` within a sentence or
 * `pauseAfterSentence` after one that ends inside the line. Between lines
 * the film may breathe; inside one it should flow.
 */
export function linePauses(lines: readonly string[], heard: readonly HeardWord[]): LinePause[] {
  const script = lines.flatMap((l, line) => lineWords(l).map((w, at) => ({ w, line, at })));
  const got = heardTokens(heard);
  const ops = align(script.map((t) => t.w), got.map((g) => g.w));
  const out: LinePause[] = [];
  let prev: { s: number; h: Heard } | null = null;
  for (const o of ops) {
    if (o.kind !== "same") {
      if (o.s >= 0) prev = null;
      continue;
    }
    const g = got[o.h];
    if (prev && prev.s === o.s - 1 && script[prev.s].line === script[o.s].line && prev.h.word !== g.word) {
      const gap = g.start - prev.h.end;
      const ended = /[.?!]["')\]]*$/.test(heard[prev.h.word].text);
      if (gap > (ended ? RESPEAK.pauseAfterSentence : RESPEAK.pauseInSentence)) {
        out.push({ line: script[o.s].line, at: prev.h.end, seconds: Math.round(gap * 10) / 10, after: heard[prev.h.word].text.replace(/[^\p{L}\p{N}']+$/u, "") });
      }
    }
    prev = { s: o.s, h: g };
  }
  return out;
}

/** What the person is told about a pause inside a line. */
export function pauseNotes(lines: readonly string[], pauses: readonly LinePause[]): string[] {
  return pauses.map((p) => `Listen at ${clock(p.at)}: a pause of ${p.seconds} s after "${p.after}" in "${lines[p.line]}".`);
}

/** What the clone is asked to say for a line: the line as it is said, names spelled the way the clone says them right. */
export function cloneText(line: string): string {
  let t = spokenForm(line);
  for (const [name, say] of Object.entries(CLONE_SAY)) t = t.replace(new RegExp(`\\b${name}\\b`, "gi"), say);
  return t;
}

/**
 * Whether a take of a line said the words being fixed as the script says
 * them, from what the transcriber heard in it. The rest of the take does not
 * matter: only these words are cut from it.
 */
export function takeSays(line: string, from: number, to: number, heardText: string): boolean {
  const want = lineWords(line);
  const got = sayTokens(spokenForm(heardText)).map((t) => t.w);
  const hit = new Set(align(want, got).filter((o) => o.kind === "same").map((o) => o.s));
  for (let i = from; i < to; i++) if (!hit.has(i)) return false;
  return true;
}

/**
 * A take of a local name the transcriber spelled its own way: every other word
 * of the line heard as written, and the name heard as something that sounds
 * like it. The listener's yes alone let a Cartesia join heard as "Abundant"
 * stand for Bhandup, and the film said "Purulia East" (21 October 2026).
 */
export function takeSaysLoosely(line: string, from: number, to: number, heardText: string): boolean {
  const want = lineWords(line);
  const got = sayTokens(spokenForm(heardText)).map((t) => t.w);
  const r = stretchHeard(align(want, got), want, got, from, to, 0, want.length, want.length);
  return r.ok && r.inside.length === to - from && sameSound(want.slice(from, to).join(" "), r.inside.join(" "));
}

/**
 * What was heard where words from..to of the script should be, and whether
 * the words around them (up to `around` either side, inside lo..hi) were heard
 * as written, or as something that sounds like them, with nothing extra in
 * between.
 */
function stretchHeard(ops: readonly Op[], want: readonly string[], got: readonly string[], from: number, to: number, lo: number, hi: number, around: number): { ok: boolean; inside: string[] } {
  const hOf = new Map<number, Op>();
  for (const o of ops) if (o.s >= 0) hOf.set(o.s, o);
  const near = (s: number) => {
    const o = hOf.get(s);
    return !!o && o.h >= 0 && (o.kind === "same" || sameSound(want[s], got[o.h]));
  };
  const outside: number[] = [];
  for (let s = Math.max(lo, from - around); s < from; s++) outside.push(s);
  for (let s = to; s < Math.min(hi, to + around); s++) outside.push(s);
  let ok = outside.every(near);
  // Nothing heard twice between two words either side of the stretch.
  for (let k = 0; ok && k + 1 < outside.length; k++) {
    const x = outside[k];
    const y = outside[k + 1];
    if (y !== x + 1) continue;
    if (hOf.get(y)!.h - hOf.get(x)!.h !== 1) ok = false;
  }
  const before = from - 1 >= lo ? hOf.get(from - 1) : undefined;
  const after = to < hi ? hOf.get(to) : undefined;
  const start = before && before.h >= 0 ? before.h + 1 : from === lo ? firstHeard(ops, from) : -1;
  const end = after && after.h >= 0 ? after.h : to === hi ? lastHeard(ops, to - 1) + 1 : -1;
  if (start < 0 || end < 0 || end < start) return { ok: false, inside: [] };
  return { ok, inside: got.slice(start, end) as string[] };
}

const firstHeard = (ops: readonly Op[], s: number) => {
  const i = ops.findIndex((o) => o.s === s);
  for (let k = i; k >= 0 && k < ops.length; k++) if (ops[k].h >= 0) return ops[k].h;
  return -1;
};
const lastHeard = (ops: readonly Op[], s: number) => {
  const i = ops.findIndex((o) => o.s === s);
  for (let k = i; k >= 0; k--) if (ops[k].h >= 0) return ops[k].h;
  return -1;
};

/**
 * The stretches a patch broke, heard back from the patched film: a word of the
 * line beside a fix heard as anything else, a word heard twice or a fragment
 * left at its edge ("a, a minute", "a-awardee archit-architect", 21 October
 * 2026), or the fixed words heard as something that does not sound like them
 * ("Purulia" for Bhandup). Each such fix is taken out and her own sound kept.
 */
export function brokenFixes(lines: readonly string[], heard: readonly HeardWord[], fixes: readonly WordFix[]): WordFix[] {
  const script = lines.flatMap((l, line) => lineWords(l).map((w, at) => ({ w, line, at })));
  const want = script.map((t) => t.w);
  const got = heardTokens(heard).map((g) => g.w);
  const ops = align(want, got);
  return fixes.filter((f) => {
    const lo = script.findIndex((t) => t.line === f.line);
    if (lo < 0) return true;
    const hi = lo + script.filter((t) => t.line === f.line).length;
    const r = stretchHeard(ops, want, got, lo + f.from, lo + f.to, lo, hi, 2);
    // As many words heard there as were meant: a vowel left over ("e wing a") sounds alike but is a word said twice.
    return !(r.ok && r.inside.length === f.to - f.from && sameSound(want.slice(lo + f.from, lo + f.to).join(" "), r.inside.join(" ")));
  });
}

/** Where the words being fixed sit in a take, from the voice's own timing of each character. */
export function takeSpan(
  alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] },
  from: number,
  to: number,
): { start: number; end: number } | null {
  const toks = sayTokens(alignment.characters.join(""));
  if (to > toks.length || from >= to) return null;
  return {
    start: alignment.character_start_times_seconds[toks[from].from],
    end: alignment.character_end_times_seconds[toks[to - 1].to - 1],
  };
}

export type RespeakReport = {
  fixed: { words: string; heard: string; at: number; reason: WordFix["reason"] }[];
  /** Words that could not be re-said, and why, in the person's words. */
  skipped: { words: string; heard: string; at: number; why: string }[];
  /** What it used: characters spoken by the clone, takes made, seconds transcribed. */
  chars: number;
  takes: number;
  heardSeconds: number;
  /** What was heard in the film, word by word, which also times the cards we set on it (`lineSpans()`). */
  words?: HeardWord[];
  /** What the listener heard said wrong in the film, before anything was said again (`listen-rules.ts`). */
  listened?: { line: number; word: string; heard: string; kind: string }[];
  /** Lines the film never said, said in her voice where they belong (`unsaidLines()`). */
  added?: { words: string; at: number }[];
  /** When each line was said, worked out in the film's own script (a Hindi or Marathi film, `local-voice.ts`). */
  spans?: ({ start: number; end: number } | null)[];
  /** The music and background sound made for a narrated film (`film-sound.ts`). */
  sound?: { score: boolean; places: number; requests: { music: number; sfx: number }; fallback: string | null };
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What the person is told about it, beside the film's other findings. */
export function respeakNotes(r: RespeakReport | null, failed?: string | null): string[] {
  const notes: string[] = [];
  if (failed) notes.push(`How words were said was not checked: ${failed}`);
  if (!r) return notes;
  const misheard = r.fixed.filter((f) => f.reason === "misheard");
  if (misheard.length) {
    notes.push(`Said again in her voice: ${misheard.map((f) => `"${f.words}" (heard as "${f.heard}", ${clock(f.at)})`).join(", ")}.`);
  }
  const names = [...new Set(r.fixed.filter((f) => f.reason === "name").map((f) => f.words))];
  if (names.length) {
    const cap = (w: string) => (PLACE_NAMES.has(w) ? w.replace(/\b\w/g, (c) => c.toUpperCase()) : w);
    notes.push(`Said again in her voice, to be sure they are right: ${names.map(cap).join(", ")}.`);
  }
  for (const a of r.added ?? []) notes.push(`"${a.words}" was never said in the film, so it was said in her voice at ${clock(a.at)}.`);
  for (const s of r.skipped) notes.push(`Listen at ${clock(s.at)}: "${s.words}" may not be said right. ${s.why}`);
  return notes;
}
