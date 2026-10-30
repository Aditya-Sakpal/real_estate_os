/**
 * A film's mistakes put right one scene at a time: the pure half.
 *
 * Built 7 October 2026, from the family story whose office had a book in it
 * and whose door had a mother nobody wrote. A whole new film to fix two
 * scenes copied the first film's faults back (sent in as @Video1) or brought
 * new ones (made fresh). So only the scenes the checks name are made again:
 * the scene cut out to the frame, sent back as the reference with only what
 * to change, its new take checked, and spliced in mute over the film's own
 * sound. Agent on camera keeps the whole fix film,
 * because a presenter's lips are cut to her own voice (`fixesByScene()`).
 *
 * `scene-fix.ts` cuts, asks, checks and splices; this file decides.
 */

// Raised on 8 October 2026 (the client: "don't limit yourself because of
// budget; I want the perfect video"): every bound below still ends the loop,
// none of them stops a fault being fixed for its cost.
/** Takes of one scene at most, the first included. */
export const SCENE_FIX_ATTEMPTS = 6;
/** Scenes put right in one round at most. */
export const MAX_SCENE_FIXES = 8;
/** Rounds of fixing, each film watched again by the editor before the next. */
export const SCENE_FIX_ROUNDS = 3;
/**
 * What the scene fixes of one round may cost, in dollars, counted before each
 * request. It was the price of the one whole fix film ($7); since 8 October
 * 2026 it is a ceiling that ends a runaway, $40 a round unless
 * `SCENE_FIX_MAX_USD` says otherwise (`doc/pricing.md` records what a
 * perfect film really costs).
 */
export const MAX_SCENE_FIX_USD = Number(process.env.SCENE_FIX_MAX_USD) || 40;
/** Seedance 2.5 at 720p through OpenRouter, a second of film made with a film sent in. */
export const SEEDANCE_USD_PER_SECOND = 0.231;
/** Google Veo 3.1 at 720p through the Gemini API, a second (list price, unconfirmed on a bill). */
export const VEO_USD_PER_SECOND = 0.4;
/** Seedance's shortest and longest film. */
export const SEEDANCE_SECONDS = { min: 4, max: 15 } as const;
/** Veo makes 8 seconds whenever it is given reference pictures. */
export const VEO_SECONDS = 8;
/** Two cuts closer than this are one transition (a whip pan reads as two). */
export const MIN_SCENE_SECONDS = 0.6;
/** A scene is never cut shorter than this. */
export const SHORTEST_SCENE = 1.2;
/** The most a crammed scene is given, in seconds more than it had. */
export const MOST_ADDED = 1.5;
/** Music under no words may be slowed to this rate at most, to give a scene room (ffmpeg's `atempo` floor is 0.5). */
export const SLOWEST_MUSIC = 0.6;

export type SceneProvider = "seedance" | "fresh" | "veo";

/**
 * A template's films are fixed scene by scene unless a presenter speaks on
 * camera, whose lips follow her own voice. `asStory` puts a presenter's film
 * on the story's road anyway (Agent on camera behind `AGENT_LIKE_STORY`, a
 * trial the client asked for on 10 October 2026): its remade scenes are told
 * to keep her lips moving with every word, and laid over her own sound.
 */
export function fixesByScene(skill: { speech: "presenter" | "voiceover" | "none" }, asStory = false): boolean {
  return skill.speech !== "presenter" || asStory;
}

/**
 * Something a check found wrong, located in the film. `pace` says whether
 * the scene's length is the fault: too slow (shorten it) or too little time
 * for what it shows (lengthen it). Everything else is fixed at the length it
 * has (the client, 7 October 2026).
 */
export type SceneProblem = {
  at: number;
  end?: number;
  what: string;
  fix: string;
  pace?: "slow" | "rushed" | null;
  /** A building that is not the project, or something that is not in it: fixed before anything else. */
  grave?: boolean;
  /** Graded serious by whoever found it (a buyer would notice and mind): only a grave or serious fault may cost a remake. */
  serious?: boolean;
};

/**
 * What may cost a remade scene (the client, 20 October 2026: two shots that
 * were fine were remade, and the remakes broke her lips and lost her
 * closing line). Only a grave or serious fault; light, pace, a still second
 * and taste are notes.
 */
export function remakeWorthy(p: SceneProblem): boolean {
  return !!(p.grave || p.serious);
}

/**
 * Why a cut scene may not be remade, or null when it may. Never a scene in
 * which she speaks on camera (a remake is filmed without her voice, so her
 * lips stop following it), and never one that holds more than one of the
 * script's shots (a soft cut the scene score missed made one "scene" of the
 * drone, the pool and her closing line, and all three were remade as one).
 */
export function remakeRefusal(
  scene: { start: number; end: number },
  shots: readonly { start: number; end: number; talks: boolean }[],
): string | null {
  const held = shots.filter((s) => {
    const mid = (s.start + s.end) / 2;
    return mid >= scene.start && mid < scene.end;
  });
  if (held.length > 1) return "it holds more than one shot";
  const talking = shots.some((s) => s.talks && Math.min(s.end, scene.end) - Math.max(s.start, scene.start) > TALK_OVERLAP);
  if (talking) return "she speaks in it";
  return null;
}

/** Faults confirmed by one more look before a round remakes anything; the rest wait for the next round. */
export const MAX_CONFIRMS = 6;

/** Seconds a talking shot must share with a scene before the scene counts as one she speaks in. */
export const TALK_OVERLAP = 0.5;

/**
 * The shots a fixed film no longer gets right that the film before it did,
 * by the context checker's shot numbers: any, and the fix is not kept.
 */
export function lostShots(before: readonly number[], after: readonly number[]): number[] {
  return [...new Set(after.filter((s) => !before.includes(s)))].sort((a, b) => a - b);
}

/**
 * The problems a next round may still pay to fix: not one inside a scene
 * every take of a round already failed to put right. Asked again, the same
 * scene failed the same way (18 October 2026, four takes a round, three
 * rounds, the same pool lounger), so a scene is given one round.
 */
export function stillWorthFixing(problems: readonly SceneProblem[], gaveUp: readonly { start: number; end: number }[]): SceneProblem[] {
  return problems.filter((p) => !gaveUp.some((g) => p.at >= g.start - 0.1 && p.at <= g.end + 0.1));
}

/** One scene of the film as it came back, between two cuts, in seconds and in frames. */
export type FilmCut = { index: number; start: number; end: number; startFrame: number; endFrame: number };

/**
 * The scenes of a film from where its picture cuts (`ffmpeg`'s scene score),
 * frame exact. Cuts closer than `MIN_SCENE_SECONDS` are one transition.
 */
export function scenesFromCuts(cuts: readonly number[], length: number, fps: number): FilmCut[] {
  const frames = Math.round(length * fps);
  const at = [...cuts]
    .filter((t) => t > MIN_SCENE_SECONDS && t < length - MIN_SCENE_SECONDS)
    .sort((a, b) => a - b)
    .reduce<number[]>((kept, t) => (kept.length && t - kept[kept.length - 1] < MIN_SCENE_SECONDS ? kept : [...kept, t]), []);
  const edges = [0, ...at.map((t) => Math.round(t * fps)), frames];
  return edges.slice(0, -1).map((f, i) => ({
    index: i,
    start: f / fps,
    end: edges[i + 1] / fps,
    startFrame: f,
    endFrame: edges[i + 1],
  }));
}

/** The scene a problem belongs to: the one holding most of its span, or its moment. */
export function sceneOf(scenes: readonly FilmCut[], p: { at: number; end?: number }): FilmCut | null {
  if (p.end !== undefined && p.end > p.at) {
    let best: FilmCut | null = null;
    let most = 0;
    for (const s of scenes) {
      const overlap = Math.min(s.end, p.end) - Math.max(s.start, p.at);
      if (overlap > most) [most, best] = [overlap, s];
    }
    return best;
  }
  // "At" is the second a thing starts, read off a frame half a second in.
  const t = p.at + 0.25;
  return scenes.find((s) => t >= s.start && t < s.end) ?? scenes.find((s) => p.at >= s.start && p.at < s.end) ?? null;
}

/**
 * The scenes to make again, and what each must put right: the worst first
 * (most problems), at most `MAX_SCENE_FIXES`, then in film order. A problem
 * that falls in no scene is left out: it is not a scene's to fix.
 */
const weight = (list: readonly SceneProblem[]) => list.reduce((n, p) => n + (p.grave ? 10 : p.pace === "slow" ? 0.5 : 1), 0);

export function scenesToFix(scenes: readonly FilmCut[], problems: readonly SceneProblem[]): { scene: FilmCut; problems: SceneProblem[] }[] {
  const by = new Map<number, SceneProblem[]>();
  for (const p of problems) {
    const s = sceneOf(scenes, p);
    if (!s) continue;
    const list = by.get(s.index) ?? [];
    if (!list.some((q) => q.what === p.what)) list.push(p);
    by.set(s.index, list);
  }
  return [...by.entries()]
    // A building that is not the project goes first, then the scenes with most wrong, a slow
    // shot last: the second Hindi test film had five scenes to fix and a wrong tower in two.
    .sort((a, b) => weight(b[1]) - weight(a[1]) || a[0] - b[0])
    .slice(0, MAX_SCENE_FIXES)
    .map(([i, list]) => ({ scene: scenes[i], problems: list }))
    .sort((a, b) => a.scene.start - b.scene.start);
}

/** Stretches of the scene where nobody speaks, from what was heard word by word. */
export function quietSpans(scene: { start: number; end: number }, words: readonly { start: number; end: number }[] | null): { start: number; end: number }[] {
  // Nothing heard is "do not know", unless the film says nothing at all (an empty list).
  if (!words) return [];
  const inside = words.filter((w) => w.end > scene.start && w.start < scene.end).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let from = scene.start;
  for (const w of inside) {
    if (w.start - 0.12 > from) out.push({ start: from, end: w.start - 0.12 });
    from = Math.max(from, w.end + 0.12);
  }
  if (scene.end > from) out.push({ start: from, end: scene.end });
  return out.filter((q) => q.end - q.start >= 0.3);
}

/** How the film's sound is changed for a scene that changes length: a quiet stretch cut out, or slowed. */
export type SoundEdit = { kind: "cut"; start: number; end: number } | { kind: "slow"; start: number; end: number; rate: number };

/**
 * How long the scene is in the fixed film. The same as it was, unless the
 * scene was too slow (shorter, by what stood still) or had too little time
 * for what it shows (longer, by up to `MOST_ADDED`) (the client, 7 October
 * 2026). Either change is made only in a stretch where nobody speaks, and
 * the music there is cut or slowed to match; with no such stretch the scene
 * keeps its length, because the voice is never moved.
 */
export function sceneLength(
  scene: FilmCut,
  problems: readonly SceneProblem[],
  quiet: readonly { start: number; end: number }[],
): { seconds: number; change: "same" | "shorter" | "longer"; sound: SoundEdit | null } {
  const was = scene.end - scene.start;
  const same = { seconds: was, change: "same" as const, sound: null };
  const longest = [...quiet].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  if (!longest) return same;
  const room = longest.end - longest.start;
  if (problems.some((p) => p.pace === "slow")) {
    const still = problems
      .filter((p) => p.pace === "slow")
      .reduce((n, p) => n + Math.max(0, Math.min(scene.end, p.end ?? p.at + 1.5) - Math.max(scene.start, p.at)), 0);
    const cut = Math.min(still || 1, room - 0.2, was - SHORTEST_SCENE);
    if (cut < 0.3) return same;
    const mid = (longest.start + longest.end) / 2;
    return { seconds: was - cut, change: "shorter", sound: { kind: "cut", start: mid - cut / 2, end: mid + cut / 2 } };
  }
  if (problems.some((p) => p.pace === "rushed")) {
    const add = Math.min(MOST_ADDED, room * (1 / SLOWEST_MUSIC - 1));
    if (add < 0.3) return same;
    return { seconds: was + add, change: "longer", sound: { kind: "slow", start: longest.start, end: longest.end, rate: room / (room + add) } };
  }
  return same;
}

/** The seconds to ask a provider for: room to cut a clean window from the scene's length. */
export function askSeconds(seconds: number, provider: SceneProvider): number {
  if (provider === "veo") return VEO_SECONDS;
  // "fresh" is Seedance too, and asks the same length.
  return Math.min(SEEDANCE_SECONDS.max, Math.max(SEEDANCE_SECONDS.min, Math.ceil(seconds + 0.5)));
}

/** What one take costs, in dollars. */
export function takeCost(seconds: number, provider: SceneProvider): number {
  // A take that sends the scene in is billed for that clip too: about 1.6 times
  // the price of one made from words, as OpenRouter billed on 8 October 2026.
  return askSeconds(seconds, provider) * (provider === "veo" ? VEO_USD_PER_SECOND : SEEDANCE_USD_PER_SECOND * (provider === "seedance" ? 1.6 : 1));
}

/** What a scene must change, as a list the prompt and the check both read. */
export function changeLines(problems: readonly SceneProblem[], still: readonly string[] = []): string[] {
  const lines = problems.map((p) => (p.fix.trim() ? `${p.what.trim().replace(/\.$/, "")}: ${p.fix.trim().replace(/\.$/, "")}.` : `${p.what.trim().replace(/\.$/, "")}.`));
  return [...new Set([...lines, ...still.map((s) => s.trim()).filter(Boolean)])];
}

/** How the take moves and what it may print: a scene with a card of the model's keeps that card, spelled out. */
function motionLine(card: string | null | undefined, talks = false, line?: string): string {
  // Spelled letter by letter only in Latin script: a Hindi or Marathi card
  // split by character would break its vowel signs apart.
  const latin = !!card && /^[\x20-\x7E₹]+$/.test(card);
  const words = card
    ? latin
      ? `The only text on screen is the card "${card.toUpperCase()}", drawn as in the original and spelled letter by letter: ` +
        `${card.toUpperCase().split(/\s+/).map((w) => w.split("").join("-")).join(" ")}. No other words, captions or logos.`
      : `The only text on screen is the card "${card}", drawn exactly as in the original, every letter and vowel sign as written. ` +
        "No other words, captions or logos."
    : "No words, captions, logos or text anywhere on screen.";
  return (
    "Everything moves at normal real-time speed from the first frame to the last: no slow motion, no pause, no freeze, " +
    "no held pose at the start or at the end. One continuous take with no cuts. Real footage of real-looking people and " +
    `places, natural skin texture, never CGI. ${words} ` +
    (talks
      ? (line
          ? `The presenter says to the camera, clearly and with energy: "${line}", lips moving with every word, eyes on the lens, ` +
            "never silent, never only smiling or gesturing; no sound is recorded, the presenter's own voice is laid over it."
          : "The presenter talks to the camera through the whole shot exactly as in the original, lips moving with every word at " +
            "the same moments, eyes on the lens; no sound is recorded, the presenter's own voice is laid back over it.")
      : "Nobody speaks.")
  );
}

/**
 * Seedance's prompt: a NEW shot that follows `@Video1` moment for moment,
 * with only the listed differences. Worded as a new shot from a reference,
 * because asked to "edit" it, Seedance takes it as video editing and wants a
 * length OpenRouter cannot send.
 */
export function seedancePrompt(input: { seconds: number; changes: readonly string[]; people: string; picture: boolean; card?: string | null; talks?: boolean; line?: string }): string {
  return [
    `Film a NEW ${input.seconds}-second shot that follows @Video1 moment for moment, at the same pace and timing, with the same ` +
      "people, the same place, the same light, the same colour grade and the same camera move." +
      (input.people ? ` The people are: ${input.people}` : "") +
      (input.picture ? " The building or room is exactly the one in @Image1." : ""),
    motionLine(input.card, input.talks, input.line),
    `The only differences from @Video1:\n${input.changes.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
  ].join("\n\n");
}

/**
 * Veo's prompt, when Seedance will not take the scene (a face it reads as a
 * real person's): the shot described from the right parts of the original,
 * which go in as its reference pictures.
 */
export function veoPrompt(input: { shot: string; changes: readonly string[]; people: string; vertical: boolean; card?: string | null; faces?: number; talks?: boolean; line?: string }): string {
  const faces = input.faces ?? 0;
  return [
    `A ${input.vertical ? "vertical 9:16" : "wide 16:9"} shot. The people, the place, the light and the colour are exactly those ` +
      "in the reference pictures." +
      (input.people ? ` The people are: ${input.people}` : "") +
      (faces
        ? ` ${faces === 1 ? "The first reference picture shows" : `The first ${faces} reference pictures show`} the film's people as ` +
          "they look in every other shot: the very same faces, hair, glasses, moustache, build and clothes. Nobody new, nobody " +
          "who only looks like them."
        : ""),
    `What happens: ${input.shot}`,
    motionLine(input.card, input.talks, input.line),
    `Make sure of this:\n${input.changes.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
  ].join("\n\n");
}

/** What the scene's check answers. */
export const SCENE_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fixed", "wrong"],
  properties: {
    fixed: { type: "boolean" },
    wrong: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "fix"],
        properties: { what: { type: "string" }, fix: { type: "string" } },
      },
    },
  },
} as const;

/** The check's answer, read: passed only when nothing is left wrong. */
export function sceneVerdict(value: unknown): { passed: boolean; wrong: string[] } {
  const v = (value ?? {}) as { fixed?: unknown; wrong?: { what?: unknown; fix?: unknown }[] };
  const wrong = (Array.isArray(v.wrong) ? v.wrong : [])
    .filter((w) => typeof w?.what === "string" && String(w.what).trim())
    .slice(0, 6)
    .map((w) => {
      const what = String(w.what).trim().replace(/\.$/, "");
      const fix = typeof w.fix === "string" ? w.fix.trim().replace(/\.$/, "") : "";
      return fix ? `${what}: ${fix}.` : `${what}.`;
    });
  return { passed: v.fixed === true && wrong.length === 0, wrong };
}

/**
 * Which provider the next take goes to: Seedance, until it refuses the scene
 * (a face it reads as a real person's), then Veo for the rest. Veo only when
 * it is configured; without it a refused scene is left as it was.
 */
export function nextProvider(refusedBySeedance: boolean, veoReady: boolean, freshRefused = false, tried = 0, people = false): SceneProvider | null {
  // A scene with people is never made from words while Veo can be shown them:
  // made from words, the door scene's father came back a different man, and
  // the take check passed him (9 October 2026). Seedance with the scene sent
  // in keeps their faces when it takes it; otherwise Veo, shown each person
  // as they look elsewhere in the film.
  if (people) {
    if (!refusedBySeedance && tried === 0) return "seedance";
    if (veoReady) return "veo";
  }
  // Each provider gets its turn, the strongest last: sent back as @Video1,
  // Seedance copies the scene it was given, laptop facing away and all (four
  // takes of the first full Hindi film's office came back the same), so it
  // gets one take; then two from words; then Veo, which handles a door and a
  // person's reach better (8 October 2026).
  if (tried >= 3 && veoReady) return "veo";
  if (!refusedBySeedance && tried === 0) return "seedance";
  if (!freshRefused) return "fresh";
  if (!refusedBySeedance) return "seedance";
  // Seedance refuses a scene of people sent back as @Video1 (a face it reads
  // as a real person's), but makes the same shot from words and the approved
  // room, as it made the film: both door scenes of the first full Hindi film
  // were refused, and Veo costs four times as much (8 October 2026).
  if (!freshRefused) return "fresh";
  return veoReady ? "veo" : null;
}

/**
 * Seedance's prompt for the shot made again from words, with no video sent in:
 * the shot as the script wrote it, the people as described, the room or the
 * building as its approved picture, and what must be different this time.
 */
export function freshPrompt(input: { seconds: number; shot: string; changes: readonly string[]; people: string; picture: boolean; vertical: boolean; card?: string | null; talks?: boolean; line?: string }): string {
  return [
    `A ${input.seconds}-second ${input.vertical ? "vertical 9:16" : "wide 16:9"} shot of ${input.talks ? "a real-estate creator's reel" : "a real Indian family film"}, photoreal, ` +
      "handheld and natural, warm evening light, the camera always moving." +
      (input.people ? ` The people are: ${input.people}` : "") +
      (input.picture ? " The room or building is exactly the one in @Image1: same layout, furniture, colours and windows." : ""),
    `What happens: ${input.shot}`,
    motionLine(input.card, input.talks, input.line),
    `Make sure of this:\n${input.changes.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    input.talks ? "No text, no logos, no watermarks." : "Nobody speaks and nobody looks into the lens. No text, no logos, no watermarks.",
  ].join("\n\n");
}

/** A refusal Seedance gives every time for this scene, whatever the words: a face it reads as a real person's. */
export function refusesScene(code: string, message: string): boolean {
  return code === "AI_DECLINED" || /sensitive|privacy/i.test(message);
}

/**
 * Of the takes a scene got, the one to splice in: one that passed, else the
 * one with fewest problems left, and only if that is fewer than the scene
 * had. None keeps the scene as it was.
 */
export function bestTake<T extends { passed: boolean; wrong: readonly string[] }>(takes: readonly T[], had: number): T | null {
  const passed = takes.find((t) => t.passed);
  if (passed) return passed;
  const best = [...takes].sort((a, b) => a.wrong.length - b.wrong.length)[0];
  return best && best.wrong.length < had ? best : null;
}

/** The film's word timings once scenes changed length: every word after a change moves with it. */
export function shiftWords<W extends { start: number; end: number }>(words: readonly W[], changes: readonly { at: number; by: number }[]): W[] {
  return words.map((w) => {
    const by = changes.filter((c) => w.start >= c.at).reduce((n, c) => n + c.by, 0);
    return by ? { ...w, start: w.start + by, end: w.end + by } : w;
  });
}

/**
 * Frames of the original scene to show Veo: the moments furthest from what
 * went wrong, so the reference holds the right people and place and not the
 * mistake. Up to `n`, as seconds into the film.
 */
export function referenceMoments(scene: { start: number; end: number }, problems: readonly { at: number; end?: number }[], n = 2): number[] {
  const len = scene.end - scene.start;
  const candidates = Array.from({ length: 9 }, (_, i) => scene.start + (len * (i + 0.5)) / 9);
  const distance = (t: number) =>
    Math.min(...problems.map((p) => (t >= p.at && t <= (p.end ?? p.at + 1) ? 0 : Math.min(Math.abs(t - p.at), Math.abs(t - (p.end ?? p.at + 1))))), len);
  const picked: number[] = [];
  for (const t of [...candidates].sort((a, b) => distance(b) - distance(a))) {
    if (picked.every((q) => Math.abs(q - t) >= len / 4)) picked.push(t);
    if (picked.length >= n) break;
  }
  return picked.sort((a, b) => a - b).map((t) => Math.round(t * 100) / 100);
}
