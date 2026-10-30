/**
 * The second checker: the film's sound, judged by code against the script.
 * Pure, covered by `check:logic`.
 *
 * Built 19 October 2026 when the client split the film's checks in three. A
 * model watching frames reads the sound only as a transcript and filed a line
 * never said under "the voice", where nothing fixed it. What is heard is
 * measured instead: the words with their times (ElevenLabs Scribe) lined up
 * with the script's lines, and the voice's pitch. Every finding names where
 * it goes: "scene" is a scene to film again (she never says her line on
 * camera), "voice" is the sound's to put right (the voice fix, a fresh
 * narration), "note" is for a person to listen to.
 */

import { unsaidLines } from "./respeak-rules.ts";

export type AudioFinding = { at: number; end: number; what: string; fix: string; route: "scene" | "voice" | "note"; grave?: boolean };

export type HeardWord = { text: string; start: number; end: number };

const round1 = (n: number) => Math.round(n * 10) / 10;

export function audioFindings(input: {
  /** The script's scenes, in order. */
  scenes: readonly { kind: string; line: string }[];
  /** Each scene's line among the lines said (`lineOf`), or -1. */
  lineOf: readonly number[];
  /** The lines said, in order. */
  lines: readonly string[];
  /** Where each scene really runs in the film. */
  shots: readonly { start: number; end: number }[];
  words: readonly HeardWord[] | null;
  length: number;
  speech: "presenter" | "voiceover" | "none";
  /** The voice the script asks for, and the one measured (null when not clear). */
  voice: "male" | "female";
  measured: "male" | "female" | null;
  /** A film made in English: the words are compared as English. */
  english: boolean;
}): AudioFinding[] {
  if (input.speech === "none") return [];
  const out: AudioFinding[] = [];
  if (input.measured && input.measured !== input.voice) {
    out.push({
      at: 0,
      end: round1(input.length),
      what: `The voice is a ${input.measured === "male" ? "man's" : "woman's"}, but the script asks for a ${input.voice === "male" ? "man's" : "woman's"}`,
      fix: `a ${input.voice === "male" ? "man's" : "woman's"} voice throughout`,
      route: "voice",
    });
  }
  if (!input.words?.length || !input.english) return out;
  // Every line never said, whatever room there is to say it in.
  for (const u of unsaidLines(input.lines, input.words, input.length, 0)) {
    const i = input.lineOf.indexOf(u.line);
    const span = input.shots[i];
    if (i < 0 || !span) continue;
    const line = input.lines[u.line];
    const presenter = input.speech === "presenter" && input.scenes[i]?.kind === "presenter";
    out.push({
      at: round1(span.start + 0.1),
      end: round1(span.end),
      what: presenter ? `She never says her line "${line}": she only moves and gestures` : `The line "${line}" is never heard`,
      fix: presenter ? `she says "${line}" to the lens, clearly, lips moving with every word` : `"${line}" is said over this shot`,
      route: presenter ? "scene" : "voice",
      grave: presenter && i === input.scenes.length - 1,
    });
  }
  return out;
}
