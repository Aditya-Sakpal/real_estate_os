/**
 * The film reviewer as an agent: the pure half.
 *
 * Built 7 October 2026. The one-look story review (`reviewStory()`) saw 30
 * small frames at once against the script's PLANNED times, and caught the
 * family story's father already inside the flat as the door opened one run in
 * three. Claude, handed the same film, worked like an editor: a survey with
 * the time on every frame, what was heard with its times, the voice measured
 * in code, then a close look at every place something happens, and it caught
 * that and three more. This is that method: `film-review.ts` runs it.
 */

/** The model that reviews. `FILM_REVIEW_MODEL` overrides it. */
export const FILM_REVIEW_MODEL = process.env.FILM_REVIEW_MODEL || "gpt-5.5";
/** Close looks a review may ask for. */
export const MAX_ZOOMS = 24;
/** Frames in one close look, and how dense it may be. */
export const ZOOM_MAX_FRAMES = 16;
export const ZOOM_MAX_FPS = 6;
/** The review's own thinking, in turns and dollars (`doc/pricing.md`). */
// Raised on 8 October 2026 (the client: "go as much as reviews are required"):
// a review that misses a fault costs a film, never a few cents more.
export const REVIEW_TURNS = 40;
export const REVIEW_MAX_USD = 2.5;
/** At most this many findings go to the fix. */
export const MAX_FINDINGS = 16;
/** Editors who watch each film apart; what any of them finds is kept. */
export const REVIEW_PASSES = 2;

const wordsOf = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));

/**
 * Findings from several reviews of one film, each fault once: two findings
 * are the same when their spans overlap, they are about the same kind of
 * thing, and they share a third of their words. The earlier review's wording
 * is kept. Worst first is not decided here: the scene fix ranks them.
 */
export function mergeFindings(runs: readonly (readonly ReviewFinding[])[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  runs.forEach((run, r) => {
    for (const f of run) {
      const w = wordsOf(f.what);
      // The same fault from another editor: anything overlapping in time, of
      // the same kind, sharing a third of its words.
      const same = out.findIndex((g) => {
        if (g.about !== f.about || g.end < f.at || f.end < g.at) return false;
        const v = wordsOf(g.what);
        const shared = [...w].filter((x) => v.has(x)).length;
        return shared / Math.max(1, Math.min(w.size, v.size)) >= 0.34;
      });
      if (same < 0) out.push({ ...f, agree: 1, seenIn: [r] } as ReviewFinding & { seenIn: number[] });
      else {
        const g = out[same] as ReviewFinding & { seenIn: number[] };
        if (!g.seenIn.includes(r)) g.seenIn.push(r);
        g.agree = g.seenIn.length;
        g.serious = !!(g.serious || f.serious);
      }
    }
  });
  return out.slice(0, MAX_FINDINGS).map((f) => {
    const { seenIn: _, ...rest } = f as ReviewFinding & { seenIn?: number[] };
    return rest;
  });
}

/** A scene shorter than this is a transition, not a shot to look at closely. */
export const LOOK_SCENE_SECONDS = 0.8;

export type ReviewFinding = {
  at: number;
  end: number;
  what: string;
  fix: string;
  about: "picture" | "slow" | "rushed" | "voice";
  /** The editor's own grade: only a serious fault may cost a remade shot. Absent is not serious. */
  serious?: boolean;
  /** How many editors saw it. */
  agree?: number;
};

/** A man's voice sits around 85 to 155 Hz, a woman's around 165 to 255: the middle is not called. */
export function voiceFromPitch(hz: number | null): "male" | "female" | null {
  if (!hz || !Number.isFinite(hz)) return null;
  if (hz < 160) return "male";
  if (hz > 175) return "female";
  return null;
}

/** What was heard, as lines with their times: words joined until a sentence ends or a pause of 0.6 s. */
export function heardLines(words: readonly { text: string; start: number; end: number }[]): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let cur: { start: number; end: number; text: string } | null = null;
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    if (cur && w.start - cur.end > 0.6) {
      out.push(cur);
      cur = null;
    }
    cur = cur ? { start: cur.start, end: w.end, text: `${cur.text} ${w.text}` } : { start: w.start, end: w.end, text: w.text };
    if (/[.!?]$/.test(w.text)) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.map((l) => ({ start: round1(l.start), end: round1(l.end), text: l.text.trim() }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The scenes no close look has covered at least half of, so the report is not taken yet. */
export function unlooked(scenes: readonly { start: number; end: number }[], looks: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  return scenes.filter((s) => {
    const len = s.end - s.start;
    if (len < LOOK_SCENE_SECONDS) return false;
    const covered = looks.reduce((n, l) => n + Math.max(0, Math.min(s.end, l.end) - Math.max(s.start, l.start)), 0);
    return covered < len * 0.5;
  });
}

/** A close look asked for, kept inside its caps: the span, and a frame rate that fits it in `ZOOM_MAX_FRAMES`. */
export function zoomPlan(start: number, end: number, fps: number, length: number): { start: number; end: number; fps: number; times: number[] } | null {
  const s = Math.max(0, Math.min(start, length - 0.1));
  // The last frame sits a little before the end: a grab at the very end comes back empty.
  const e = Math.min(length - 0.15, Math.max(end, s + 0.25));
  if (!(e > s)) return null;
  const want = Math.min(ZOOM_MAX_FPS, Math.max(1, fps || 4));
  const rate = Math.min(want, ZOOM_MAX_FRAMES / (e - s));
  const n = Math.max(2, Math.min(ZOOM_MAX_FRAMES, Math.floor((e - s) * rate) + 1));
  const times = Array.from({ length: n }, (_, i) => round2(s + ((e - s) * i) / (n - 1)));
  return { start: round2(s), end: round2(e), fps: round2((n - 1) / (e - s)), times };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The report the agent hands in, read and checked: each finding has a time,
 * words and a kind; a finding in the picture must sit inside a close look,
 * because the survey's one frame a second is where the last reviewer missed
 * what happened between two frames.
 */
export function readReport(
  args: unknown,
  looks: readonly { start: number; end: number }[],
): { ok: true; findings: ReviewFinding[] } | { ok: false; why: string } {
  const list = (args as { problems?: unknown })?.problems;
  if (!Array.isArray(list)) return { ok: false, why: "Refused: send problems as a list (an empty list when nothing is wrong)." };
  const findings: ReviewFinding[] = [];
  const unseen: number[] = [];
  for (const p of list.slice(0, MAX_FINDINGS * 2)) {
    const r = p as Record<string, unknown>;
    const at = Number(r.at);
    const end = Number(r.end);
    const what = typeof r.what === "string" ? r.what.trim().slice(0, 240) : "";
    const fix = typeof r.fix === "string" ? r.fix.trim().slice(0, 240) : "";
    const about = (["picture", "slow", "rushed", "voice"] as const).find((a) => a === r.about) ?? "picture";
    if (!Number.isFinite(at) || !what) continue;
    // Pace is never serious: a shot held or rushed is a note, not a remake.
    const serious = r.serious === true && about === "picture";
    const f = { at: round1(at), end: round1(Number.isFinite(end) && end > at ? end : at + 1), what, fix, about, serious };
    if ((about === "picture" || about === "rushed") && !looks.some((l) => f.at >= l.start - 0.5 && f.at <= l.end + 0.5)) unseen.push(f.at);
    findings.push(f);
  }
  if (unseen.length) {
    return { ok: false, why: `Refused: look closely before reporting. Nothing you looked at closely covers ${unseen.map((t) => `${t} s`).join(", ")}.` };
  }
  return { ok: true, findings: findings.slice(0, MAX_FINDINGS) };
}

export const REPORT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["problems"],
  properties: {
    problems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "end", "what", "fix", "about", "serious"],
        properties: {
          at: { type: "number", description: "Second it starts, read off the frame's time label." },
          end: { type: "number", description: "Second it ends." },
          what: { type: "string", description: "What a viewer sees that is wrong, in a few plain words." },
          fix: { type: "string", description: "What the shot should show instead, in a few plain words, no numbers." },
          about: { type: "string", enum: ["picture", "slow", "rushed", "voice"] },
          serious: { type: "boolean", description: "A fault a buyer would notice at once that makes the film wrong; false for light, pace, taste." },
        },
      },
    },
  },
} as const;

/** What one close look showed, written while its pictures are still in view. */
export type ReviewNote = { from: number; to: number; start: string; end: string; door: string; sense?: string; wrong: string };

export const NOTE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "start", "end", "door", "sense", "wrong"],
  properties: {
    from: { type: "number", description: "Second the shot starts." },
    to: { type: "number", description: "Second it ends." },
    start: { type: "string", description: "As it starts: who is where (inside or outside the home, which room, which side of a door, standing or sitting) and what each holds." },
    end: { type: "string", description: "As it ends: the same." },
    door: {
      type: "string",
      description:
        "When a door opens in it: is the camera inside the home or outside it; in the first frame, which side of the doorway is " +
        "each person on; which way does each move (toward the camera or away, through the doorway or not). 'none' when no door opens.",
    },
    sense: {
      type: "string",
      description:
        "Does every frame of it make sense to an ordinary person watching? Say what each object is doing and which way it faces " +
        "(a laptop's screen toward the one using it?), where each door leads (a front door opens into a hall or living room, " +
        "never straight into a bedroom), whether the room is one of the approved rooms and the same place as in the shot before, " +
        "whether anybody walks through, over or stands inside something solid (a lounger, a table, a chair, a railing, a wall, " +
        "a step or the water), and any odd, floating, melted or impossible thing, hand or face. 'all sensible' only after checking each.",
    },
    wrong: { type: "string", description: "What is wrong in it, against its own frames, the shot before, the approved pictures, common sense and the script; empty when nothing." },
  },
} as const;

/** What the notes found wrong, as findings: what a review that ran out of turns still hands over. */
export function findingsFromNotes(notes: readonly ReviewNote[]): ReviewFinding[] {
  return notes
    .filter((n) => n.wrong.trim())
    .slice(0, MAX_FINDINGS)
    .map((n) => ({ at: n.from, end: n.to, what: n.wrong, fix: "", about: "picture" as const }));
}

export function readNote(args: unknown): ReviewNote | null {
  const r = (args ?? {}) as Record<string, unknown>;
  const from = Number(r.from);
  const to = Number(r.to);
  const text = (k: string) => (typeof r[k] === "string" ? String(r[k]).trim().slice(0, 500) : "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !text("start") || !text("end")) return null;
  return { from: round1(from), to: round1(to), start: text("start"), end: text("end"), door: text("door") || "none", sense: text("sense"), wrong: text("wrong") };
}

export const ZOOM_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end", "fps"],
  properties: {
    start: { type: "number", description: "Second to start at." },
    end: { type: "number", description: "Second to end at." },
    fps: { type: "number", description: "Frames a second, 2 to 6; 4 or more where something happens fast." },
  },
} as const;

/** How the reviewer works. Its checklist is the faults films have shipped with. */
export const REVIEW_INSTRUCTIONS =
  "You check a finished Indian real-estate video for the client who ordered it, like an editor watching a cut. A viewer " +
  "must never see something that makes no sense. You have a survey (one frame a second, each frame labelled with its " +
  "time), what was heard with its times, where the picture cuts, and the script the film was made from. The script's " +
  "shots are in order, but the film does not keep the script's timing: find each shot in the film by what you see and " +
  "what is heard. The script can itself be wrong: judge what a viewer sees.\n\n" +
  "How to work:\n" +
  "1. Read the survey and match each shot of the script to its span in the film.\n" +
  "2. Look closely (zoom) at every shot with people in it, at 4 frames a second or more, and at every moment someone " +
  "arrives, leaves, opens or passes something, picks something up or puts it down. Several zooms may go in one turn. " +
  "A building or a view needs only a quick look at 2 frames a second. Work fast: ask for the close looks of two or three shots in one turn, and write their notes together in the next.\n" +
  "3. After every close look, write a note on it (the note tool), its 'sense' answered object by object: who is where (inside or outside the home, which room, " +
  "which side of a door, standing or sitting) and what each person holds, as it starts and as it ends. Then compare " +
  "its start with the END of the shot before it: anybody who was outside, at work or on the way and is now inside must " +
  "be SEEN coming in; a thing a person now holds must be seen being given or picked up. Anything that does not follow " +
  "goes in the note as wrong, even when the script asked for it.\n" +
  "4. When every shot has a note, report.\n\n" +
  "You judge what is broken or impossible in the PICTURE, shot by shot. Whether each shot does its job in the film, and " +
  "anything about the sound (who speaks, what is said or not said, how), are two other checkers' work: never report them.\n\n" +
  "What counts as wrong, worst first:\n" +
  "- A movement that never happened: someone coming home is already inside when the door opens (the person opening " +
  "the door from inside must be the one who is home, and the one arriving must be outside it as it opens), or appears " +
  "in a room without coming in; someone opens a door from the wrong side. Read the direction, not the script: when " +
  "the camera looks through a doorway from outside, a person arriving comes from the camera's side, back to the " +
  "camera, and crosses the doorway into the room; a person already in the room, facing the camera or walking toward " +
  "it from inside, or stepping out from behind the door inside, was already home. Someone appearing between two " +
  "frames was not seen coming in. Look at the first second of a door shot at 6 frames a second.\n" +
  "- Common sense, which a viewer notices at once even when nothing moves: an object facing or working the wrong way (a " +
  "laptop whose screen faces away from the person using it, a phone held backwards, a book upside down); a person " +
  "ringing a bell and then opening the door himself (the bell is for someone inside to open it); a front door that " +
  "opens straight into a bedroom, a bathroom or a kitchen instead of a hall or a living room; a balcony, room or view " +
  "that is a different place from the one the family stood in a shot before; a room unlike every approved room; a " +
  "floating, melted or impossible object; a person whose legs or body pass through something solid (walking through a pool " +
  "lounger, a table, a railing or a wall, standing in the water as if on the floor), so watch every walk at 6 frames a " +
  "second where the feet meet the floor; a hand with the wrong number of fingers, a face that warps; a shot framed so " +
  "the subject is cut off or the camera looks at nothing. Ask of every shot: would an ordinary person watching say " +
  "\"that's odd\"? If yes, it is a fault.\n" +
  "- A thing that appears, disappears, changes colour or jumps from one hand to another without being shown.\n" +
  "- A person whose face, hair or clothes change between shots, or a different person in their place.\n" +
  "- The time of day changing within one shot or one continuous space. A cut to another space may be in its own light, " +
  "and that is never a fault: another place (a station, a mall), and the project's own spaces too (the drone view, the " +
  "towers, the pool, a room, the balcony).\n" +
  "- One view held for more than about three seconds with nothing new happening, or a pause or slow motion.\n" +
  "- Never trust the spelling of what was heard: it is given only to find each shot by.\n" +
  "Never report the registration block, the price card, the logo or the small print (added later), the music, or taste " +
  "a client would not raise. Report only what you saw in a close look, with its time read off the frame labels. " +
  "'about' is 'slow' for held too long or slow motion, 'rushed' for an action skipped " +
  "for lack of time, 'picture' for the rest. 'serious' is true only for what a buyer would notice at once and that makes the " +
  "film wrong or embarrassing: a building or place that is not the one named, a body passing through something solid, a " +
  "warped face or hand clearly seen, a different person in someone's place, a door or movement that is impossible, words " +
  "on screen that are wrong. Everything else is false: light, a pause, a shot a little long, where someone stands when it " +
  "looks safe and natural, taste. A serious fault costs a remade shot, and a remade shot can break what was right, so be " +
  "sure. When nothing is wrong, report an empty list.";
