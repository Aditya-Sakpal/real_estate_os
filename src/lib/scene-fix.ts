/**
 * A film's mistakes put right one scene at a time: cut the scene out to the
 * frame, ask Seedance for it again with only what to change (Veo when
 * Seedance will not take it), check the new take, and splice the one that
 * passed in mute over the film's own sound. `scene-fix-rules.ts` decides;
 * this file cuts, asks, checks and splices.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { type AskDriver, type AskPart, type FilmDriver, type FilmJob, type VeoDriver, type VeoJob } from "./generate.ts";
import { chooseWindow } from "./reel-rules.ts";
import {
  askSeconds,
  bestTake,
  changeLines,
  MAX_SCENE_FIX_USD,
  nextProvider,
  quietSpans,
  referenceMoments,
  refusesScene,
  SCENE_CHECK_SCHEMA,
  SCENE_FIX_ATTEMPTS,
  sceneLength,
  scenesFromCuts,
  scenesToFix,
  sceneVerdict,
  seedancePrompt,
  freshPrompt,
  takeCost,
  veoPrompt,
  type SceneProblem,
  type SceneProvider,
  type SoundEdit,
} from "./scene-fix-rules.ts";

const execOnce = promisify(execFile);
const exec = (cmd: string, args: string[], opts: Record<string, unknown> = {}) =>
  execOnce(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts } as never) as unknown as Promise<{ stdout: Buffer | string; stderr: Buffer | string }>;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");

/** The model that judges a new take of a scene against what it had to change. */
export const SCENE_CHECK_MODEL = process.env.FILM_STORY_MODEL || "gpt-5.5";

/** One take of a scene, kept on the job so a worker that dies collects it rather than paying again. */
export type SceneTake = {
  provider: SceneProvider;
  job: FilmJob | VeoJob | null;
  /** The take cut to the scene's frames, mute, ready to splice. */
  file: string | null;
  passed: boolean;
  wrong: string[];
  failed: string | null;
};

/** What the scene fix of one film keeps on its plan. */
export type SceneFixPlan = {
  usd: number;
  /** Every scene of the film as cut, so a remade scene is matched to its shot by order, and its people found elsewhere. */
  all?: { index: number; start: number; end: number }[];
  scenes: {
    index: number;
    start: number;
    end: number;
    startFrame: number;
    endFrame: number;
    problems: SceneProblem[];
    seconds: number;
    change: "same" | "shorter" | "longer";
    sound: SoundEdit | null;
    refused: boolean;
    /** Seedance would not make the shot from words either. */
    freshRefused?: boolean;
    takes: SceneTake[];
    chosen: string | null;
  }[];
};

/**
 * What a scene of the film is, from the script: the shot, its kind, its card,
 * its approved picture and who is in it. Matched by the scene's place among
 * the film's real cuts when they are as many as the script's shots, and by
 * time only when they are not: by planned time alone, the first story film's
 * "too still" tower shot was remade as the father at the door (9 October 2026).
 */
export type ShotAt = (
  t: number,
  scene?: { index: number; of: number },
) => { shot: string; kind: string; card: string | null; picture: { bytes: Buffer; type: string } | null; people?: string[]; talks?: boolean; line?: string; ours?: boolean };

export type SceneFixInput = {
  /** The model's own film, before our overlay. */
  raw: string;
  /** Its sound with the words said again, when there is such a file. */
  voiced: string | null;
  dir: string;
  problems: readonly SceneProblem[];
  /** What was heard, word by word; [] for a film nobody speaks in; null when not known. */
  words: readonly { start: number; end: number }[] | null;
  shotAt: ShotAt;
  people: string;
  aspect: "9:16" | "16:9";
  plan: { sceneFix?: SceneFixPlan };
  save: () => Promise<void>;
  stage: (progress: number) => Promise<void>;
  drivers: { film: FilmDriver; veo: VeoDriver; ask: AskDriver; veoReady: () => boolean };
  /** Why a cut scene may not be remade (`remakeRefusal()`), or null when it may. */
  refuse?: (scene: { index: number; start: number; end: number }, of: number) => string | null;
  signal?: AbortSignal;
};

export type SceneFixOutcome =
  | {
      ok: true;
      raw: string;
      voiced: string | null;
      changes: { at: number; by: number }[];
      fixed: number;
      /** The scenes replaced in which the presenter speaks, in the new film's time: their lips were not made for her voice (`lipsync.ts`). */
      talked: { start: number; end: number }[];
    }
  | { ok: false; code: "NOTHING" | "STOPPED" };

export async function probe(path: string): Promise<{ seconds: number; fps: number; w: number; h: number }> {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", path,
  ]);
  const j = JSON.parse(String(stdout)) as { streams?: { width?: number; height?: number; r_frame_rate?: string }[]; format?: { duration?: string } };
  const [n, d] = String(j.streams?.[0]?.r_frame_rate ?? "24/1").split("/").map(Number);
  return { seconds: Number(j.format?.duration) || 0, fps: d ? n / d : 24, w: j.streams?.[0]?.width ?? 720, h: j.streams?.[0]?.height ?? 1280 };
}

/** Where the picture cuts, by ffmpeg's scene score. */
export async function cutsOf(path: string): Promise<number[]> {
  const { stderr } = await exec(FFMPEG, ["-hide_banner", "-nostats", "-i", path, "-an", "-vf", "select='gt(scene,0.25)',showinfo", "-f", "null", "-"]);
  return [...String(stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

async function frameAt(path: string, at: number): Promise<Buffer> {
  const { stdout } = await exec(
    FFMPEG,
    ["-v", "error", "-ss", Math.max(0, at).toFixed(3), "-i", path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
    { encoding: "buffer" },
  );
  return Buffer.from(stdout as Buffer);
}

const jpeg = async (bytes: Buffer, max: number) => ({
  bytes: await sharp(bytes).resize(max, max, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer(),
  type: "image/jpeg",
});

/** How much the picture moves, `hz` values a second (mean frame difference, frames 160 wide). */
async function motionCurve(path: string, hz: number): Promise<number[]> {
  const { stderr } = await exec(FFMPEG, [
    "-hide_banner", "-nostats", "-v", "info", "-i", path, "-an", "-vf",
    "scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-",
  ]);
  const buckets: number[][] = [];
  let at: number | null = null;
  for (const line of String(stderr).split(/\r?\n/)) {
    const t = line.match(/pts_time:([\d.]+)/);
    if (t) at = Number(t[1]);
    const y = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (y && at !== null) (buckets[Math.floor(at * hz)] ??= []).push(Number(y[1]));
  }
  return Array.from(buckets, (b) => (b?.length ? b.reduce((a, c) => a + c, 0) / b.length : 0));
}

/** The original scene, mute, frame exact. */
async function cutScene(raw: string, startFrame: number, endFrame: number, out: string): Promise<void> {
  await exec(FFMPEG, [
    "-v", "error", "-y", "-i", raw, "-an", "-vf", `trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS`,
    "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out,
  ]);
}

/**
 * A new take cut to the scene: its slow start and its tail left out
 * (`chooseWindow()`), at the film's size and frame rate, exactly `frames`
 * long, mute. Null when the take is too short to give that.
 */
async function windowOf(take: string, frames: number, film: { fps: number; w: number; h: number }, out: string): Promise<string | null> {
  const need = frames / film.fps;
  const hz = 8;
  const curve = await motionCurve(take, hz).catch(() => []);
  const w = chooseWindow(curve, hz, need, "property") ?? { start: 0, rate: 1 };
  const slow = w.rate < 1 ? `setpts=(PTS-STARTPTS)/${w.rate.toFixed(4)},` : "setpts=PTS-STARTPTS,";
  await exec(FFMPEG, [
    "-v", "error", "-y", "-ss", w.start.toFixed(3), "-i", take, "-an", "-vf",
    `${slow}scale=${film.w}:${film.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${film.w}:${film.h},setsar=1,fps=${film.fps}`,
    "-frames:v", String(frames), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out,
  ]);
  const got = await probe(out).catch(() => null);
  return got && Math.round(got.seconds * film.fps) >= frames - 1 ? out : null;
}

/**
 * The new take against the scene it replaces: a person who saw the original,
 * the list of what had to change and the new take, asked whether every
 * change was made and anything new went wrong.
 */
async function checkTake(
  ask: AskDriver,
  original: string,
  take: string,
  changes: readonly string[],
  shot: string,
  people: string,
  picture: { bytes: Buffer; type: string } | null,
  signal?: AbortSignal,
  /** The film's frames just before and just after the scene: the new shot must follow the one and lead into the other. */
  around?: { before: Buffer | null; after: Buffer | null },
  /** The film's people as they look in its other shots: a take whose person is anybody else fails. */
  faces: readonly Buffer[] = [],
): Promise<{ passed: boolean; wrong: string[] } | null> {
  const grab = async (path: string, n: number) => {
    const p = await probe(path);
    const at = Array.from({ length: n }, (_, i) => Math.min(p.seconds - 0.05, (p.seconds * (i + 0.5)) / n));
    const frames = await Promise.all(at.map((t) => frameAt(path, t).catch(() => Buffer.alloc(0))));
    return Promise.all(frames.filter((f) => f.length).map(async (f) => ({ ...(await jpeg(f, 768)), detail: "high" as const })));
  };
  const [was, now] = await Promise.all([grab(original, 3), grab(take, Math.min(12, Math.max(6, Math.round((await probe(take)).seconds * 2))))]);
  if (!now.length) return null;
  const answer = await ask(
    {
      model: SCENE_CHECK_MODEL,
      system:
        "You check one re-made shot of a real-estate video for the client who ordered it. You see three frames of the ORIGINAL " +
        "shot, the list of what had to change, and the NEW shot, frame by frame in order. 'fixed' is true only when every change " +
        "on the list was made and nothing new is wrong. In 'wrong', list what a viewer would still notice: a change not made, the " +
        "people, place or light no longer matching the original, anything that makes no physical sense, a moment held still or in " +
        "slow motion, a smile or pose held at the end, text that should not be there. 'fix' says what the shot should show instead, " +
        "in a few plain words, no numbers. An empty list when nothing is wrong. Judge it as an ordinary viewer would, with " +
        "common sense, and hold it to what the film's editor holds every shot to: an object facing or working the wrong way (a " +
        "laptop's screen away from its user), a bell rung and the door opened by the one ringing, a front door opening onto a " +
        "bedroom, a room unlike the approved picture, a place that is not the same place as the shot before it, someone who " +
        "appears without being seen arriving, a person walking through or standing inside something solid (a lounger, a " +
        "table, a railing, a wall, the water), a floating or impossible object, a warped hand or face. Each of these is wrong " +
        "even when the list did not ask about it. When you are shown THE PEOPLE AS THEY LOOK IN THE REST OF THE FILM, compare " +
        "every person in the new shot with them, face first: the same face shape, age, hair, glasses, moustache or beard, build " +
        "and clothes. A person who is somebody else, or only looks a bit like them, is wrong, and so is a new person who is in " +
        "none of those pictures. Answer in JSON.",
      parts: [
        { text: `WHAT THE SHOT IS: ${shot}${people ? `\nTHE PEOPLE: ${people}` : ""}` },
        { text: `WHAT HAD TO CHANGE:\n${changes.map((c, i) => `${i + 1}. ${c}`).join("\n")}` },
        ...(picture ? ([{ text: "THE APPROVED PICTURE OF THE BUILDING OR ROOM:" }, { image: { ...(await jpeg(picture.bytes, 768)), detail: "low" } }] as AskPart[]) : []),
        ...(around?.before ? ([{ text: "THE LAST FRAME OF THE SHOT BEFORE IT (the new shot must follow on from this):" }, { image: { ...(await jpeg(around.before, 768)), detail: "high" } }] as AskPart[]) : []),
        ...(around?.after ? ([{ text: "THE FIRST FRAME OF THE SHOT AFTER IT (the new shot must lead into this):" }, { image: { ...(await jpeg(around.after, 768)), detail: "high" } }] as AskPart[]) : []),
        ...(faces.length
          ? ([
              { text: "THE PEOPLE AS THEY LOOK IN THE REST OF THE FILM (the new shot's people must be these very people):" },
              ...(await Promise.all(faces.map(async (f) => ({ image: { ...(await jpeg(f, 768)), detail: "high" as const } })))),
            ] as AskPart[])
          : []),
        { text: "THE ORIGINAL SHOT:" },
        ...was.map((image) => ({ image }) as AskPart),
        { text: "THE NEW SHOT, frame by frame:" },
        ...now.map((image) => ({ image }) as AskPart),
      ],
      schema: SCENE_CHECK_SCHEMA as unknown as Record<string, unknown>,
      name: "scene_check",
    },
    { signal },
  );
  return answer.ok ? sceneVerdict(answer.value) : null;
}

/**
 * The film's sound, its quiet stretches cut or slowed where scenes changed
 * length (`sceneLength()`), the voice never moved. No edit copies it as is.
 */
async function editSound(src: string, edits: readonly SoundEdit[], length: number, out: string): Promise<void> {
  if (!edits.length) {
    await exec(FFMPEG, ["-v", "error", "-y", "-i", src, "-vn", "-c:a", "aac", "-b:a", "192k", out]);
    return;
  }
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  const labels: string[] = [];
  let from = 0;
  const fade = (l: string, d: number) => `afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, d - 0.03).toFixed(3)}:d=0.03[${l}]`;
  for (const [i, e] of sorted.entries()) {
    parts.push(`[0:a]atrim=${from.toFixed(3)}:${e.start.toFixed(3)},asetpts=PTS-STARTPTS,${fade(`k${i}`, e.start - from)}`);
    labels.push(`[k${i}]`);
    if (e.kind === "slow") {
      const d = (e.end - e.start) / e.rate;
      parts.push(`[0:a]atrim=${e.start.toFixed(3)}:${e.end.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${e.rate.toFixed(4)},${fade(`s${i}`, d)}`);
      labels.push(`[s${i}]`);
    }
    from = e.end;
  }
  parts.push(`[0:a]atrim=${from.toFixed(3)}:${length.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.03[tail]`);
  labels.push("[tail]");
  parts.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[a]`);
  await exec(FFMPEG, ["-v", "error", "-y", "-i", src, "-filter_complex", parts.join(";"), "-map", "[a]", "-c:a", "aac", "-b:a", "192k", out]);
}

/** The film with its fixed scenes in place of the old ones, frame exact, over the given sound. */
export async function splice(raw: string, swaps: readonly { startFrame: number; endFrame: number; file: string }[], sound: string, out: string): Promise<void> {
  const sorted = [...swaps].sort((a, b) => a.startFrame - b.startFrame);
  const inputs: string[] = ["-i", raw, ...sorted.flatMap((s) => ["-i", s.file]), "-i", sound];
  const parts: string[] = [];
  const labels: string[] = [];
  let from = 0;
  for (const [i, s] of sorted.entries()) {
    if (s.startFrame > from) {
      parts.push(`[0:v]trim=start_frame=${from}:end_frame=${s.startFrame},setpts=PTS-STARTPTS[o${i}]`);
      labels.push(`[o${i}]`);
    }
    parts.push(`[${i + 1}:v]setpts=PTS-STARTPTS[n${i}]`);
    labels.push(`[n${i}]`);
    from = s.endFrame;
  }
  parts.push(`[0:v]trim=start_frame=${from},setpts=PTS-STARTPTS[tail]`);
  labels.push("[tail]");
  parts.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[v]`);
  await exec(FFMPEG, [
    "-v", "error", "-y", ...inputs, "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", `${sorted.length + 1}:a`, "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "copy", out,
  ]);
}

/**
 * Every scene the checks named made again, each up to `SCENE_FIX_ATTEMPTS`
 * takes inside `MAX_SCENE_FIX_USD`, counted before each request, and the
 * film spliced from the takes that passed. Nothing to splice is "NOTHING":
 * the first film is delivered.
 */
export async function fixScenes(input: SceneFixInput): Promise<SceneFixOutcome> {
  const d = input.drivers;
  const film = await probe(input.raw);
  if (!input.plan.sceneFix) {
    const scenes = scenesFromCuts(await cutsOf(input.raw).catch(() => []), film.seconds, film.fps);
    // A scene we set ourselves (the approved map) is never remade: the
    // locality film of 13 October 2026 had its map scene remade from a
    // problem a frame early, and went out with the video model's own map.
    const chosen = scenesToFix(scenes, input.problems).filter((c) => {
      if (input.shotAt((c.scene.start + c.scene.end) / 2, { index: c.scene.index, of: scenes.length }).ours) return false;
      const why = input.refuse?.(c.scene, scenes.length) ?? null;
      if (why) console.log(`scene-fix: ${c.scene.start.toFixed(2)} to ${c.scene.end.toFixed(2)} s is not remade: ${why}`);
      return !why;
    });
    // A dry run says what it would remake and remakes nothing: how the checks are tuned against a film already judged.
    if (process.env.SCENE_FIX_DRY === "on") {
      for (const c of chosen) console.log(`scene-fix (dry): would remake ${c.scene.start.toFixed(2)} to ${c.scene.end.toFixed(2)} s for: ${c.problems.map((p) => p.what).join("; ")}`);
      return { ok: false, code: "NOTHING" };
    }
    if (!chosen.length) return { ok: false, code: "NOTHING" };
    input.plan.sceneFix = {
      usd: 0,
      all: scenes.map((sc) => ({ index: sc.index, start: sc.start, end: sc.end })),
      scenes: chosen.map(({ scene, problems }) => {
        const len = sceneLength(scene, problems, quietSpans(scene, input.words));
        return { ...scene, problems, seconds: len.seconds, change: len.change, sound: len.sound, refused: false, takes: [], chosen: null };
      }),
    };
    await input.save();
  }
  const fix = input.plan.sceneFix;
  let done = 0;
  const all = fix.all ?? [];
  const placeOf = (index: number) => (all.length ? { index, of: all.length } : undefined);
  const fixing = new Set(fix.scenes.map((sc) => sc.index));
  /**
   * The film's people as they look in its other scenes: the middle of up to
   * two scenes nobody is remaking that show the same people (any people scene
   * when the shots do not name them). Veo is shown them, and every take is
   * checked against them.
   */
  const facesFor = async (sc: SceneFixPlan["scenes"][number], want: readonly string[]): Promise<Buffer[]> => {
    const pool = all
      .filter((o) => !fixing.has(o.index))
      .map((o) => ({ o, what: input.shotAt((o.start + o.end) / 2, placeOf(o.index)) }))
      .filter((x) => x.what.kind === "people" || x.what.kind === "presenter");
    const shares = (x: (typeof pool)[number]) => (want.length && x.what.people?.length ? want.filter((p) => x.what.people!.includes(p)).length : 0);
    const ranked = pool.sort((a, b) => shares(b) - shares(a) || Math.abs(a.o.start - sc.start) - Math.abs(b.o.start - sc.start));
    const out: Buffer[] = [];
    for (const x of ranked.slice(0, 2)) {
      const f = await frameAt(input.raw, (x.o.start + x.o.end) / 2).catch(() => null);
      if (f?.length) out.push(f);
    }
    return out;
  };

  const one = async (sc: SceneFixPlan["scenes"][number], n: number): Promise<"STOPPED" | void> => {
    const original = join(input.dir, `scene-${sc.index}-was.mp4`);
    if (!existsSync(original)) await cutScene(input.raw, sc.startFrame, sc.endFrame, original);
    const what = input.shotAt((sc.start + sc.end) / 2, placeOf(sc.index));
    const hasPeople = what.kind === "people" || what.kind === "presenter" || !!what.people?.length;
    // A presenter speaking on camera: the take keeps her lips moving with her words.
    const talks = !!what.talks;
    const faces = hasPeople ? await facesFor(sc, what.people ?? []) : [];
    const frames = Math.round(sc.seconds * film.fps);
    // A refusal before anything was made is free and is not a take.
    const takes = () => sc.takes.filter((t) => t.failed !== "REFUSED").length;
    while (takes() < SCENE_FIX_ATTEMPTS && !sc.takes.some((t) => t.passed)) {
      if (input.signal?.aborted) return "STOPPED";
      const provider = nextProvider(sc.refused, d.veoReady(), !!sc.freshRefused, takes(), hasPeople && faces.length > 0);
      if (!provider) break;
      // A take already asked for and not yet collected is collected, never asked again.
      const pending = sc.takes.find((t) => t.job && !t.file && !t.failed);
      const take: SceneTake = pending ?? { provider, job: null, file: null, passed: false, wrong: [], failed: null };
      if (!pending) {
        const cost = takeCost(sc.seconds, provider);
        if (fix.usd + cost > MAX_SCENE_FIX_USD) break;
        fix.usd += cost;
        sc.takes.push(take);
        await input.save();
      }
      const still = sc.takes.filter((t) => t !== take).flatMap((t) => t.wrong);
      const changes = changeLines(sc.problems, still);
      const seconds = askSeconds(sc.seconds, take.provider);
      let submitted = !!take.job;
      const onSubmitted = async (job: FilmJob | VeoJob) => {
        submitted = true;
        take.job = job;
        await input.save();
      };
      const made =
        take.provider === "fresh"
          ? await d.film(
              {
                prompt: freshPrompt({ seconds, shot: what.shot, changes, people: input.people, picture: !!what.picture, vertical: input.aspect === "9:16", card: what.card, talks, line: what.line }),
                images: what.picture ? [what.picture] : [],
                seconds,
                aspect: input.aspect,
                resolution: "720p",
                audio: false,
              },
              { signal: input.signal, job: take.job as FilmJob | null, onSubmitted, onWait: async () => {} },
            )
          : take.provider === "seedance"
          ? await d.film(
              {
                prompt: seedancePrompt({ seconds, changes, people: input.people, picture: !!what.picture, card: what.card, talks, line: what.line }),
                images: what.picture ? [what.picture] : [],
                videos: [{ bytes: await readFile(original), type: "video/mp4" }],
                seconds,
                aspect: input.aspect,
                resolution: "720p",
                audio: false,
              },
              { signal: input.signal, job: take.job as FilmJob | null, onSubmitted, onWait: async () => {} },
            )
          : await d.veo(
              {
                prompt: veoPrompt({
                  shot: what.shot,
                  changes,
                  people: input.people,
                  vertical: input.aspect === "9:16",
                  card: what.card,
                  faces: Math.min(faces.length, what.picture ? 2 : 3),
                  talks,
                  line: what.line,
                }),
                // The people first, as they look in the rest of the film, then the
                // room; with nobody in the scene, frames of the scene itself.
                images: (faces.length
                  ? [
                      ...(await Promise.all(
                        faces.slice(0, what.picture ? 2 : 3).map(async (f) => ({
                          bytes: await sharp(f).resize(720, 720, { fit: "outside", withoutEnlargement: false }).jpeg({ quality: 90 }).toBuffer(),
                          type: "image/jpeg",
                        })),
                      )),
                      ...(what.picture ? [what.picture] : []),
                    ]
                  : [
                      ...(await Promise.all(
                        referenceMoments(sc, sc.problems).map(async (t) => ({
                          bytes: await sharp(await frameAt(input.raw, t)).resize(720, 720, { fit: "outside", withoutEnlargement: false }).jpeg({ quality: 90 }).toBuffer(),
                          type: "image/jpeg",
                        })),
                      )),
                      ...(what.picture ? [what.picture] : []),
                    ]
                ).slice(0, 3),
                aspect: input.aspect,
              },
              { signal: input.signal, job: take.job as VeoJob | null, onSubmitted },
            );
      if (!made.ok) {
        if (made.code === "STOPPED") return "STOPPED";
        // Refused before it was made: nothing paid, and Seedance will refuse this scene every time.
        if (!submitted) fix.usd = Math.max(0, fix.usd - takeCost(sc.seconds, take.provider));
        if (take.provider === "seedance" && refusesScene(made.code, made.message)) {
          sc.refused = true;
          take.failed = submitted ? made.code : "REFUSED";
        } else if (take.provider === "fresh" && refusesScene(made.code, made.message)) {
          sc.freshRefused = true;
          take.failed = submitted ? made.code : "REFUSED";
        } else {
          take.failed = made.code;
        }
        if (made.code === "OUT_OF_CREDITS" || made.code === "NO_KEY") sc.refused = true;
        await input.save();
        continue;
      }
      const k = sc.takes.indexOf(take);
      const rawTake = join(input.dir, `scene-${sc.index}-take-${k}.mp4`);
      await writeFile(rawTake, made.bytes);
      const cut = await windowOf(rawTake, frames, film, join(input.dir, `scene-${sc.index}-cut-${k}.mp4`)).catch(() => null);
      if (!cut) {
        take.failed = "TOO_SHORT";
        await input.save();
        continue;
      }
      take.file = cut;
      const around = {
        before: sc.start > 0.2 ? await frameAt(input.raw, sc.start - 0.12).catch(() => null) : null,
        after: sc.end < film.seconds - 0.2 ? await frameAt(input.raw, sc.end + 0.12).catch(() => null) : null,
      };
      const verdict = await checkTake(d.ask, original, cut, changeLines(sc.problems), what.shot, input.people, what.picture, input.signal, around, faces);
      take.passed = verdict?.passed ?? false;
      take.wrong = verdict?.wrong ?? ["The new take could not be checked."];
      await input.save();
      await input.stage(80 + Math.round((14 * (n + 1)) / fix.scenes.length));
    }
    sc.chosen = bestTake(sc.takes.filter((t) => t.file), sc.problems.length)?.file ?? null;
    if (sc.chosen) done++;
    await input.save();
  };

  const results = await Promise.all(fix.scenes.map((sc, n) => one(sc, n)));
  if (results.includes("STOPPED")) return { ok: false, code: "STOPPED" };
  const swaps = fix.scenes.filter((sc) => sc.chosen && existsSync(sc.chosen));
  if (!swaps.length) return { ok: false, code: "NOTHING" };

  // The sound is the film's own; a scene that changed length moves it only where nobody speaks.
  const edits = swaps.flatMap((sc) => (sc.change !== "same" && sc.sound ? [sc.sound] : []));
  const changes = swaps.filter((sc) => sc.change !== "same").map((sc) => ({ at: sc.end, by: sc.seconds - (sc.end - sc.start) }));
  const pieces = swaps.map((sc) => ({ startFrame: sc.startFrame, endFrame: sc.endFrame, file: sc.chosen! }));
  const rawSound = join(input.dir, "sound-raw.m4a");
  await editSound(input.raw, edits, film.seconds, rawSound);
  const outRaw = join(input.dir, "film-raw.mp4");
  await splice(input.raw, pieces, rawSound, outRaw);
  let outVoiced: string | null = null;
  if (input.voiced && existsSync(input.voiced)) {
    const voicedSound = join(input.dir, "sound-voiced.m4a");
    await editSound(input.voiced, edits, film.seconds, voicedSound);
    outVoiced = join(input.dir, "film-voiced.mp4");
    await splice(input.raw, pieces, voicedSound, outVoiced);
  }
  // Where each replaced scene she speaks in now sits: a scene made longer moves those after it.
  let moved = 0;
  const talked: { start: number; end: number }[] = [];
  for (const sc of [...swaps].sort((x, y) => x.start - y.start)) {
    const len = sc.change === "same" ? sc.end - sc.start : sc.seconds;
    if (input.shotAt((sc.start + sc.end) / 2, placeOf(sc.index)).talks) talked.push({ start: sc.start + moved, end: sc.start + moved + len });
    if (sc.change !== "same") moved += sc.seconds - (sc.end - sc.start);
  }
  return { ok: true, raw: outRaw, voiced: outVoiced, changes, fixed: done, talked };
}
