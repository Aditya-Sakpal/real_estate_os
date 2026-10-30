/**
 * The third checker: each shot judged in the film as a whole, the way its
 * viewer watches it. Pure, covered by `check:logic`; `checkContext()` in
 * `film-review.ts` asks the model.
 *
 * Built 19 October 2026, when the client split the film's checks in three
 * (one checker for what is broken in the picture, one for the sound, one for
 * whether each shot makes sense where it is), because one checker asked to do
 * everything filed a silent close ("she walks to the lens and points, and the
 * booking line is never heard") under the voice, where nothing fixed it.
 * This one is told each shot's job and asked only whether it does it.
 */

import type { FilmScript } from "./film-rules.ts";

/** The model that judges. `FILM_CONTEXT_MODEL` overrides it. */
export const FILM_CONTEXT_MODEL = process.env.FILM_CONTEXT_MODEL || "gpt-5.5";

/**
 * What each shot of the script is for, in the viewer's words: the opening
 * hooks, a nearby place is shown with its time, a line she says is seen
 * said, the ending asks for its action or closes on the project.
 */
export function shotJobs(
  script: Pick<FilmScript, "scenes">,
  pictures: readonly ({ category: string; title: string | null } | undefined)[],
): string[] {
  const last = script.scenes.length - 1;
  return script.scenes.map((s, i) => {
    const pic = pictures[s.picture];
    const place = pic?.category === "NEARBY_PLACE" ? pic.title : null;
    const said = s.line?.trim() ? `"${s.line.trim()}"` : "";
    const parts: string[] = [];
    if (i === 0) parts.push("the opening: it must make a viewer stop scrolling and tell them what this film is about");
    if (i === last) {
      parts.push(
        s.kind === "presenter" && said
          ? `the ending: she asks the viewer, clearly and to the lens, ${said}, so the film ends on a call to act`
          : "the ending: the film closes on the project and lands as an ending, never trailing off on nothing",
      );
    }
    if (place) parts.push(`shows ${place}, the real place in its approved photo, while its distance is said`);
    if (s.kind === "presenter" && said && i !== last) parts.push(`she is seen saying ${said} to the camera, her mouth moving with the words`);
    if (s.kind === "presenter" && !said) parts.push("she reacts on camera without words");
    if (s.kind === "property" && !place) parts.push(`shows ${pic?.title || "the project"}${said ? ` while the voice says ${said}` : ""}`);
    if (s.kind === "people") parts.push(`the story moment: ${s.shot}`);
    return parts.join("; ");
  });
}

export const CONTEXT_INSTRUCTIONS =
  "You watch a finished 30-second Indian real-estate video as the buyer it is made for, from start to end, and judge one " +
  "thing only: whether each shot does its job in this film and makes sense where it is. You are given the script shot by " +
  "shot with each shot's job, what was heard with its times, and the film one frame a second with the time printed on " +
  "each frame. Find each shot of the script in the film by what you see and hear; the film may have dropped a shot, merged " +
  "two, or put them in another order, and that itself is a fault of the shot that is missing.\n\n" +
  "For every shot of the script say what the film shows for it and whether a viewer watching the whole film gets its job. " +
  "Wrong, even when nothing in the picture looks broken:\n" +
  "- the shot is missing, or shows something other than what its job and its words are about (a station named over a " +
  "balcony, a mall named over a room);\n" +
  "- a person who has a line is not seen saying it (only walking, smiling, pointing or waving while the line is not " +
  "heard), or says it off camera when the job is to say it to the lens;\n" +
  "- the opening does not hook: nothing happens, nobody speaks, or it is unclear what the film is about;\n" +
  "- the ending does not land: no clear call to act when one is the job, the action asked for is not heard, or the film " +
  "trails off;\n" +
  "- a shot repeats a place or a view already shown for no reason, or does nothing a viewer would notice;\n" +
  "- the order makes no sense to a viewer (an ending in the middle, a place shown before it is named and never again).\n" +
  "Never judge what is broken in the picture (a warped hand, a stray object, text on screen), the registration block, " +
  "the price card, the logo or the small print (added later), the music, or how a word is pronounced: other checkers do " +
  "that. Judge only the job. 'from' and 'to' are the seconds the shot runs in the film, read off the frame labels; for a " +
  "missing shot, where it should have been. 'wrong' and 'fix' are a few plain words each, no numbers in 'fix', empty when " +
  "the shot does its job. 'serious' is true only when a buyer would be misled or lost (a place named over a different " +
  "place, a shot missing, an ending with no call to act); a shot that does its job less well than it could is not " +
  "serious, and neither is lighting or pace. Fixing a shot means filming it again, which can break what was right: when " +
  "the film works as a whole, say so. Answer in JSON.";

export const CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["shots"],
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["shot", "from", "to", "seen", "does_job", "wrong", "fix", "serious"],
        properties: {
          shot: { type: "integer", description: "The script's shot number, from 1." },
          from: { type: "number" },
          to: { type: "number" },
          seen: { type: "string", description: "What the film shows for this shot, and what is heard over it." },
          does_job: { type: "string", enum: ["yes", "no"] },
          wrong: { type: "string" },
          fix: { type: "string" },
          serious: { type: "boolean", description: "True only when a buyer would be misled or lost: a place named over a different place, a shot that is missing." },
        },
      },
    },
  },
} as const;

export type ContextFinding = { shot: number; at: number; end: number; what: string; fix: string; serious?: boolean };

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The model's answer as findings: a shot that does not do its job, with
 * words saying why, inside the film's length. A shot out of range, or a
 * "no" with nothing said, is dropped rather than guessed at.
 */
export function readContext(value: unknown, shots: number, length: number): ContextFinding[] {
  const list = (value as { shots?: unknown })?.shots;
  if (!Array.isArray(list)) return [];
  const out: ContextFinding[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown>;
    const shot = Number(r.shot);
    const what = typeof r.wrong === "string" ? r.wrong.trim().slice(0, 240) : "";
    const fix = typeof r.fix === "string" ? r.fix.trim().slice(0, 240) : "";
    if (r.does_job !== "no" || !what || !Number.isInteger(shot) || shot < 1 || shot > shots) continue;
    if (out.some((f) => f.shot === shot)) continue;
    const from = Math.max(0, Math.min(length - 0.2, Number(r.from) || 0));
    const to = Math.min(length, Math.max(from + 0.5, Number(r.to) || from + 1));
    out.push({ shot, at: round1(from), end: round1(to), what, fix: fix || "make the shot do its job", serious: r.serious === true });
  }
  return out;
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** One line for the film's notes. */
export function contextNote(f: ContextFinding): string {
  return `At ${mmss(f.at)} (shot ${f.shot}): ${f.what.replace(/[.\s]+$/, "")}. ${f.fix.charAt(0).toUpperCase()}${f.fix.slice(1).replace(/[.\s]+$/, "")}.`;
}
