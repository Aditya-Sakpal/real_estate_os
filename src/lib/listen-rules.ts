/**
 * The listener: a model that hears the film's sound itself and says which
 * words of the script were said wrong, the way a person listening would.
 * Pure, covered by `check:logic`; `listen.ts` asks it.
 *
 * Built 19 October 2026 (the client: "we need something that would listen,
 * not just read the transcript"). The locality film said "three km" as
 * "k-meter" three times and nothing caught it: every check compared written
 * text with written text, and both transcribers wrote "km" for whatever she
 * said, which matched the script's "km" exactly. Asked to listen,
 * `gpt-audio` heard "kemeter" each time, "Inlort" for Inorbit and the missing
 * close, in about three seconds. It replaces the transcript comparison as the
 * judge of how each word was said; the transcript still times the words.
 */

import { namesSaid, spokenForm } from "./film-rules.ts";

/** The models that listen, each once; what either hears wrong counts. One run of one missed a "kemeter" the other heard. */
export const LISTEN_MODELS: readonly string[] = (process.env.FILM_LISTEN_MODELS || "gpt-audio-1.5,gpt-audio")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

export type ListenProblem = {
  /** The line, from 0, among the lines said. */
  line: number;
  /** The word or words as they should be said. */
  word: string;
  /** What was said instead, spelled the way it sounds; empty when missing. */
  heard: string;
  kind: "wrong" | "missing" | "added";
};

export function listenPrompt(lines: readonly string[]): string {
  return (
    "You are a careful listener checking the voice of a 30-second Indian real-estate video before it goes out. Listen to " +
    "the audio itself, never to what a transcript would tidy it into: a unit read out as its letters is wrong even if a " +
    "transcript would write it as the unit. She is meant to say these lines, in order, exactly as written (numbers and " +
    `units as words):\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n\n` +
    "For every line: is it said at all; and for every word, does she say it the way a native Indian English speaker says " +
    "that word? Report only problems: a word said wrong (an abbreviation read out as letters, a mispronounced place or " +
    "name, a wrong number or unit, a word swapped for another), a word or a whole line missing, or a word added. An Indian " +
    "accent is not a problem. For each problem give the line number, the word as it should be said, and what she actually " +
    "says, spelled the way it sounds." + namesRule(lines) +
    ' Answer only with JSON: {"problems":[{"line":n,"word":"...","heard":"...","kind":"wrong|missing|added"}]}'
  );
}

/**
 * How the local names a clip should say are said, for the listener to judge
 * them by: an accent is forgiven, and "Gore-ga-awn" was heard right in every
 * take of the recording and then caught on the finished film (20 October 2026).
 */
function namesRule(lines: readonly string[]): string {
  const names = namesSaid(lines);
  if (!names.length) return "";
  return (
    " Local names are judged strictly, by how people in Mumbai say them, not by an accent: " +
    names.map((n) => `${n.name} is said "${n.say}"${n.hint ? ` (${n.hint})` : ""}`).join("; ") +
    ". Said any other way, the name is wrong."
  );
}

/** The JSON inside a model's answer, which may come wrapped in prose or a code fence. */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** One listen's answer, kept to the lines the film has; anything unreadable is dropped. */
export function readListen(text: string, lines: number | readonly string[]): ListenProblem[] | null {
  const count = typeof lines === "number" ? lines : lines.length;
  const j = jsonIn(text) as { problems?: unknown } | null;
  if (!j || !Array.isArray(j.problems)) return null;
  const out: ListenProblem[] = [];
  for (const raw of j.problems) {
    const r = raw as Record<string, unknown>;
    const line = Number(r.line) - 1;
    const word = typeof r.word === "string" ? r.word.trim().slice(0, 120) : "";
    const heard = typeof r.heard === "string" ? r.heard.trim().slice(0, 120) : "";
    const kind = (["wrong", "missing", "added"] as const).find((k) => k === r.kind);
    if (!Number.isInteger(line) || line < 0 || line >= count || !word || !kind) continue;
    // A "wrong" word heard as itself is no problem, nor one heard run into the
    // word beside it ("E" heard as "Eving" in "E Wing", 21 October 2026).
    if (kind === "wrong" && sameSound(word, heard)) continue;
    if (kind === "wrong" && typeof lines !== "number" && besideWords(lines[line], word).some((w) => sameSound(w, heard))) continue;
    out.push({ line, word, heard, kind });
  }
  return out;
}

/**
 * A word as it sounds, spelling aside: British and American spellings are one
 * word to the ear, and a listener writing "kilometers" for "kilometres" heard
 * it right (19 October 2026, every voice-track take of a line refused for it).
 */
const norm = (s: string) =>
  // Figures in words first: a listener writing "20th" for "twentieth" or "2"
  // for "two" heard it right (20 October 2026, three such "fixes" in one film).
  spokenForm(s)
    .toLowerCase()
    .replace(/tre(s?)\b/g, "ter$1")
    .replace(/our(s?)\b/g, "or$1")
    .replace(/is(e|es|ed|ing)\b/g, "iz$1")
    .replace(/[^a-z0-9]+/g, "");

/**
 * Whether a word the listener wrote down is the word itself: the same
 * letters spelling aside, or for a word of five letters or more the same
 * consonants in order ("Hights" for "Heights" is how it sounds, written
 * down; "Gorega" for "Goregaon" is a word cut short).
 */
export function sameSound(word: string, heard: string): boolean {
  const a = norm(word);
  const b = norm(heard);
  if (a === b) return true;
  // The consonants in order, an h, a doubled letter and v against w aside:
  // "Bhahndup", "Bushaan" and "Vik-ruh-lee" are how those names sound
  // written down, and were taken as said wrong (21 October 2026).
  const bones = (x: string) => x.replace(/[aeiouy]+/g, "").replace(/h/g, "").replace(/v/g, "w").replace(/(.)+/g, "$1");
  return a.length >= 5 && b.length >= 5 && bones(a) === bones(b) && bones(a).length >= 3;
}

/** The word with the one before it and the one after it in its line, as a listener may hear them run together. */
export function besideWords(line: string | undefined, word: string): string[] {
  if (!line) return [];
  const words = line.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]+/gu, "")).filter(Boolean);
  const want = word.toLowerCase().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i + want.length <= words.length; i++) {
    if (!want.every((w, k) => words[i + k].toLowerCase() === w)) continue;
    const run = words.slice(i, i + want.length).join(" ");
    if (i > 0) out.push(`${words[i - 1]} ${run}`);
    if (i + want.length < words.length) out.push(`${run} ${words[i + want.length]}`);
  }
  return out;
}

/** Every listen's problems together, each once: what any listener heard wrong counts. */
export function mergeListens(runs: readonly (readonly ListenProblem[] | null)[]): ListenProblem[] | null {
  const done = runs.filter((r): r is readonly ListenProblem[] => !!r);
  if (!done.length) return null;
  const out: ListenProblem[] = [];
  for (const p of done.flat()) {
    if (!out.some((q) => q.line === p.line && q.kind === p.kind && norm(q.word) === norm(p.word))) out.push(p);
  }
  // A line missing is one problem, not one a word: the listeners name it whole, word by word, or both.
  const missing = new Map<number, ListenProblem[]>();
  for (const p of out) if (p.kind === "missing") missing.set(p.line, [...(missing.get(p.line) ?? []), p]);
  return out.filter((p) => {
    const all = missing.get(p.line) ?? [];
    if (p.kind !== "missing" || all.length < 2) return true;
    const longest = all.reduce((a, b) => (b.word.split(/\s+/).length > a.word.split(/\s+/).length ? b : a));
    return p === longest;
  });
}

/**
 * What a take must be heard to say, for the take's own listen: only the
 * words being fixed, since only they are cut from it. Asked about the whole
 * line, the listener turned a good "kilometres" down for "workday" heard in
 * "workdays" one time in three.
 */
export function takePrompt(line: string, words: string = line): string {
  const whole = words.trim().toLowerCase() === line.trim().toLowerCase();
  return (
    `Listen to this short clip of a woman speaking. She is meant to say: "${line}". Listen to the audio itself. ` +
    (whole ? "Does she say every word" : `Listen to "${words}" in it, and only to that: does she say it`) +
    ", the way a native Indian English speaker says it? An Indian accent is fine; a unit read out as its letters, a " +
    "mispronounced name, a missing or swapped word is not." + namesRule([whole ? line : words]) +
    ' Answer only with JSON: {"ok":true|false,"wrong":[{"word":"...","heard":"..."}]}'
  );
}

/** A take's listen: true when every word was said right, false when not, null when unreadable. */
export function readTake(text: string): boolean | null {
  return readTakeWords(text)?.ok ?? null;
}

/** A take's listen with the words heard wrong: what Cartesia is asked to join in again. */
export function readTakeWords(text: string): { ok: boolean; wrong: { word: string; heard: string }[] } | null {
  const j = jsonIn(text) as { ok?: unknown; wrong?: unknown } | null;
  if (!j || typeof j.ok !== "boolean") return null;
  const wrong = (Array.isArray(j.wrong) ? j.wrong : [])
    .map((w) => w as Record<string, unknown>)
    .map((w) => ({ word: typeof w.word === "string" ? w.word.trim().slice(0, 80) : "", heard: typeof w.heard === "string" ? w.heard.trim().slice(0, 80) : "" }))
    .filter((w) => w.word && !sameSound(w.word, w.heard));
  return { ok: j.ok && !wrong.length, wrong };
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** A note for a word still said wrong in the film delivered. */
export function listenNote(p: ListenProblem, line: string, at: number | null): string {
  const where = at !== null ? `at ${mmss(at)}` : `in "${line}"`;
  if (p.kind === "missing") return `Listen ${where}: "${p.word}" is not said.`;
  if (p.kind === "added") return `Listen ${where}: "${p.word}" is said, and the script does not have it.`;
  return `Listen ${where}: "${p.word}" sounds like "${p.heard}".`;
}
