import {
  reelBounds,
  type ReelFormat,
  MAX_CLIP_SECONDS,
  MAX_REVIEW_ROUNDS,
  MAX_SHOT_REDOS,
  MAX_SHOT_TRIES,
  MAX_STRETCH,
  REEL_MAX_SECONDS,
  REEL_MIN_SECONDS,
  SPOKEN_FLOOR,
  type HardFindings,
  type ReviewIssue,
  type ShotKind,
} from "./reel-rules.ts";

/**
 * The video agent, decided without a network: its budget, how a clip's
 * motion is described to it, which cuts it may make, and whether an edit it
 * wants to hand over may go out.
 *
 * The agent is a director and editor. It writes the script, has every shot
 * filmed, looks at each clip the way an editor does (where the action starts,
 * where it smears, whether a hand melts), cuts it, has it filmed again with a
 * sharper direction when a cut cannot save it, grades the edit, renders it,
 * watches it and repairs it. Code keeps what it may not decide: the facts in
 * the script, the building being an approved picture, the spending, and the
 * rules a delivered reel must meet (`deliverGate()`).
 *
 * Imports are relative because the checks load this straight from source.
 */

/** Takes of one shot: the first try, the retries, and the review's reshoots, as the pipeline allowed. */
export const MAX_TAKES_PER_SHOT = MAX_SHOT_TRIES + MAX_SHOT_REDOS - 1;
/** Drafts of the script the guard will read. */
export const MAX_SCRIPTS = 8;
/** Renders of the whole reel, each one reviewed. */
export const MAX_RENDERS = MAX_REVIEW_ROUNDS;
/** Close looks at a clip. Free but for the agent's own tokens. */
export const MAX_LOOKS = 24;
/** Trims of one shot. */
export const MAX_TRIMS_PER_SHOT = 6;
/** Slowest and fastest a clip may be played: more than a little slow reads as slow motion. */
export const MIN_SPEED = Math.round((1 - MAX_STRETCH) * 100) / 100;
export const MAX_SPEED = 1.25;
export const MAX_PUSH = 0.08;
export const TRANSITIONS = ["cut", "fade", "dip", "flash"] as const;
export const GRADES = ["none", "warm", "cool", "punchy", "soft"] as const;
export type Transition = (typeof TRANSITIONS)[number];
export type Grade = (typeof GRADES)[number];

/** Turns and dollars of the agent's own thinking a reel may use; the clips are capped separately. */
export const REEL_AGENT_BUDGET = { turns: 70, usd: 4 } as const;

/** A take's name: its shot and which take of that shot it is. */
export function takeId(shot: string, n: number): string {
  return `${shot}t${n}`;
}

// ---------------------------------------------------------------------------
// A clip's motion, in words an editor reads
// ---------------------------------------------------------------------------

/**
 * A clip's motion curve (mean frame-to-frame difference, `hz` values a
 * second) as a digit per half second, 0 for still and 9 for the busiest the
 * clip gets, and a line saying where it is still, slow, moving and fading.
 * A model reading a contact sheet sees the frames; this is what it cannot
 * see in them, which is how fast things change between them.
 */
export function motionProfile(curve: readonly number[], hz: number): { halves: number[]; line: string } {
  if (!curve.length) return { halves: [], line: "No motion could be read." };
  const per = Math.max(1, Math.round(hz / 2));
  const halves: number[] = [];
  for (let i = 0; i < curve.length; i += per) {
    const part = curve.slice(i, i + per);
    halves.push(part.reduce((a, b) => a + b, 0) / part.length);
  }
  const sorted = [...halves].sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.9)] || sorted[sorted.length - 1] || 1;
  const digits = halves.map((v) => Math.max(0, Math.min(9, Math.round((v / (top || 1)) * 9))));
  const word = (d: number) => (d <= 1 ? "still" : d <= 4 ? "slow" : "moving");
  const spans: string[] = [];
  let from = 0;
  for (let i = 1; i <= digits.length; i++) {
    if (i === digits.length || word(digits[i]) !== word(digits[from])) {
      spans.push(`${(from / 2).toFixed(1)} to ${(i / 2).toFixed(1)} s ${word(digits[from])}`);
      from = i;
    }
  }
  return { halves: digits, line: spans.join(", ") };
}

// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------

/**
 * Whether a cut of a take fits its shot: the window from `start`, played at
 * `speed`, fills the shot's slot inside the clip. Speeds are held to what does
 * not read as slow or fast motion. Returns the cut, or what is wrong with it.
 */
export function validateTrim(input: {
  clipSeconds: number;
  slot: number;
  start: number;
  speed: number;
}): { ok: true; start: number; speed: number; takes: number } | { ok: false; problem: string } {
  const speed = Math.round(input.speed * 100) / 100;
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    return { ok: false, problem: `Speed must be between ${MIN_SPEED} and ${MAX_SPEED}; outside that it reads as slow or fast motion.` };
  }
  const start = Math.round(Math.max(0, input.start) * 100) / 100;
  const takes = Math.round(input.slot * speed * 100) / 100;
  const room = Math.round((input.clipSeconds - 0.1 - start) * 100) / 100;
  if (takes > room) {
    return {
      ok: false,
      problem:
        `From ${start} s at speed ${speed} the shot needs ${takes} s of clip and only ${Math.max(0, room)} s is left. ` +
        `Start earlier, play it a little slower, or make the clip again.`,
    };
  }
  return { ok: true, start, speed, takes };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** What a render found: the rules code checks, and the reviewer's reading. */
export type RenderFindings = {
  /** The edit this render was made from; any change since makes it stale. */
  version: number;
  hard: HardFindings;
  issues: readonly ReviewIssue[];
  /** Whether the reviewer's call succeeded at all. */
  reviewed: boolean;
  /** How long this kind of film may run; a narrated story's when not given. */
  bounds?: { min: number; max: number };
};

/**
 * Blockers a reviewer raised that the agent may not overrule: what a buyer
 * sees or hears broken. A narrator saying something the script does not is a
 * claim nobody cleared, even when the whole still scores over the floor.
 */
const HARD_KINDS: ReadonlySet<ReviewIssue["kind"]> = new Set(["artefact", "building", "text", "audio"]);

/** The problems with a render as the rules see them, in the words the screen and the agent read. */
export function renderProblems(r: RenderFindings): string[] {
  const out: string[] = [];
  if (!r.hard.qrScans) out.push("The RERA QR code does not scan on every shot.");
  if (r.hard.spokenMatch < SPOKEN_FLOOR) out.push("The narration does not carry the approved script.");
  const { min, max } = r.bounds ?? { min: REEL_MIN_SECONDS, max: REEL_MAX_SECONDS };
  if (r.hard.seconds < min || r.hard.seconds > max) {
    out.push(`The reel runs ${Math.round(r.hard.seconds)} seconds, outside ${min} to ${max}.`);
  }
  for (const id of r.hard.buildingDrift) out.push(`Shot ${id} changed the building.`);
  for (const text of r.hard.pixel ?? []) out.push(`The picture check: ${text}`);
  if (!r.reviewed) out.push("The reel could not be reviewed.");
  for (const i of r.issues) {
    if (i.blocker && HARD_KINDS.has(i.kind)) out.push(`${i.shot ? `Shot ${i.shot}: ` : ""}${i.note}`.slice(0, 240));
  }
  return out;
}

/**
 * Whether the edit may be delivered: it was rendered as it stands, the render
 * met every rule, the reviewer found nothing broken a buyer would see, and
 * every building shot matched its approved picture when it was cut. The
 * reviewer's taste (pacing, story) is the agent's to weigh; what is broken
 * is not.
 */
export function deliverGate(input: {
  version: number;
  render: RenderFindings | null;
  /** Each building shot's eye check on its current cut. */
  buildings: readonly { shot: string; matches: boolean | null }[];
}): string[] {
  if (!input.render) return ["Render and review the reel first."];
  if (input.render.version !== input.version) return ["The edit has changed since it was rendered. Render and review it again."];
  const out = renderProblems(input.render);
  for (const b of input.buildings) {
    if (b.matches === false) out.push(`Shot ${b.shot}'s building does not match its approved picture.`);
    // Unchecked is not a pass: trim it again (free) to have it checked.
    else if (b.matches !== true) out.push(`Shot ${b.shot}'s building was never checked against its picture. Trim it again to check it.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

export function reelAgentInstructions(format: ReelFormat = "story"): string {
  const { min, max } = reelBounds(format);
  const presenter = format === "presenter";
  return [
    presenter
      ? "You are the director and editor of an Indian real-estate 'agent on camera' reel: a presenter at the project talks"
      : "You are the director and editor of an Indian real-estate story reel of at most 30 seconds, working the way an agency editor",
    ...(presenter ? ["to the viewer, lip-synced to their own recorded lines, cut with the property, with large text on the words. You", "work the way an agency editor"] : []),
    "does: write the script, record the voice, film every scene, look at each clip, cut away the dead and smeared",
    "parts, reshoot what is broken, set the edit, render it, watch it, fix it, and deliver it only when a client would",
    "take it.",
    "",
    "HOW TO WORK",
    "1. write_script: the whole story, from the brief below. A guard checks every number and phrase; fix what it names",
    "   and submit again.",
    "2. prepare_audio: records the narration and chooses the music. Each shot lasts as long as its line, cut on the beat.",
    `   The reel must run ${min} to ${max} seconds as timed; if it does not, rewrite the script before filming.`,
    "3. make_clip for every shot except cards, all in the same turn: they are filmed at the same time. Each comes back",
    "   with a contact sheet, its motion by half second, a suggested cut (already applied) and an editor's eye check.",
    ...(presenter
      ? [
          "   A presenter shot puts the presenter into its approved picture and lip-syncs them to their recorded line. The",
          "   building behind them is checked against the picture before any video is paid for. A presenter shot is never",
          "   trimmed or sped up (the lips are synced from its first frame): if it is wrong, make it again.",
        ]
      : []),
    "4. Look at every clip as an editor:",
    "   - A dead start, a slow drift, a smear or a freeze at the end: trim_clip to the stretch where the action",
    "     happens (look_at to see part of a clip closer). A speed a little under or over one fits a clip that is a",
    "     little short or a little sluggish for its line.",
    "   - Broken (melting faces or hands, morphing objects, garbled text, flicker), a building that warps or does not",
    "     match its picture, the wrong action, or pace that fights the narration: make_clip again, with a direction that",
    "     says what to do differently. For a building, never describe what changed; ask for it exactly as in the",
    "     approved picture.",
    "5. set_style: one grade for the whole reel, and a transition and a gentle push-in per shot where they help. Cuts",
    "   on the beat are the default; a fade or a dip is for a change of mood or the ending, not every shot.",
    "6. render_and_review: renders the reel, checks the QR on every frame, what the narration really says and the",
    "   length, and an independent reviewer watches it. Repair only the shots it names, and render again.",
    "7. deliver once a render passes and you would hand it to the client.",
    "   Out of video budget, or of takes for a shot? Do not give up: rewrite the script so that shot is a card (set in",
    "   type, free) or is dropped. Every shot you keep keeps its takes and cuts, wherever it moves. give_up only when",
    "   no rewrite can make a reel that passes.",
    "",
    "RULES (code refuses anything else)",
    "- The building is only ever an approved picture brought to life. A people shot never shows a building, the",
    "  project or the flat being sold.",
    ...(presenter ? ["- The large text says only what the approved facts and the cleared card say, and is checked like the narration."] : []),
    "- Every number said or shown is one of the approved facts, written exactly as it is there. Directions to the",
    "  camera carry no numbers at all.",
    "- Nothing on the never-say list, and no promise beyond the facts.",
    "",
    `BUDGET: ${MAX_CLIP_SECONDS} seconds of video in all, ${MAX_TAKES_PER_SHOT} takes a shot, ${MAX_RENDERS} renders. Every clip costs`,
    "real money and a reshoot takes minutes: reshoot only what a client would reject. Trimming and styling are free.",
    "Keep what you write short.",
  ].join("\n");
}

/** A take as the agent reads it. The first line is fixed in shape, for a log and for a person reading one. */
export function takeReport(input: {
  id: string;
  shot: string;
  kind: ShotKind;
  n: number;
  clipSeconds: number;
  slot: number;
  motion: { halves: number[]; line: string };
  cut: { start: number; speed: number } | null;
  eye: { clean: boolean; building: boolean | null; issue: string } | null;
  spentSeconds: number;
}): string {
  const lines = [
    `${input.id} · shot ${input.shot} (${input.kind}) · take ${input.n} of ${MAX_TAKES_PER_SHOT} · ${input.clipSeconds.toFixed(1)} s of clip for a ${input.slot.toFixed(2)} s shot`,
    `Motion by half second, 0 still to 9 busiest: ${input.motion.halves.join(" ")}`,
    `That is: ${input.motion.line}.`,
    input.cut
      ? `Cut applied: from ${input.cut.start.toFixed(2)} s at speed ${input.cut.speed.toFixed(2)}.`
      : "No usable stretch was found: the action is too short or too slow to fill the shot. Trim it by hand if some of it works, or make it again.",
  ];
  if (input.eye) {
    lines.push(
      `Editor's eye on the cut: ${input.eye.clean ? "clean" : "not clean"}` +
        (input.kind === "property" ? `; building ${input.eye.building === false ? "does NOT match" : "matches"} its approved picture` : "") +
        (input.eye.issue ? `. ${input.eye.issue}` : "."),
    );
  }
  lines.push(`Video spent so far: ${Math.round(input.spentSeconds)} of ${MAX_CLIP_SECONDS} seconds.`);
  lines.push("The contact sheet below is the whole clip as filmed, its time under each frame.");
  return lines.join("\n");
}
