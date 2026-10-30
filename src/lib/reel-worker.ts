import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { type JSONValue } from "postgres";
import { withTenant, audit } from "./db/index.ts";
import { meterVideo } from "./billing.ts";
import { isNodeId } from "./scope-rules.ts";
import { studioGround } from "./creative.ts";
import { fontFile, fontFor } from "./font-rules.ts";
import { adPrice, isLuxury, NO_LOCATION_MESSAGE, sellingPoints } from "./creative-rules.ts";
import { readAsset } from "./storage.ts";
import { bareLogo, frameExpect, loadMaterials, pixelContext, qrOnly, readQr, registrationGap, smallPrintFor, storePostFiles } from "./compose.ts";
import { auditPixel, gatePost, withHashes, type PixelReader } from "./pixel.ts";
import { sampleTimes, type PixelRecord } from "./pixel-rules.ts";
import { monthYear } from "./film-rules.ts";
import { PLACEMENT_SIZE, RERA_WEBSITE, designSizeExact, footLines, withAiLine } from "./compose-rules.ts";
import {
  animateFrame,
  openRouterVideoModel,
  askJson,
  designAd,
  DESIGN_MODEL,
  hear,
  imagineStill,
  speak,
  type AgentBrain,
  type AnimateDriver,
  type AskDriver,
  type DesignDriver,
  type HearDriver,
  type SpeakDriver,
} from "./generate.ts";
import {
  END_CARD_SECONDS,
  MAX_CLIP_SECONDS,
  PRESENTER_SCRIPT_SCHEMA,
  PRESENTER_TEMPLATE,
  PROPERTY_WORDS,
  REEL_FPS,
  REEL_MAX_SECONDS,
  REEL_MIN_SECONDS,
  REEL_MOODS,
  REVIEW_SCHEMA,
  SCRIPT_SCHEMA,
  STORY_TEMPLATE,
  beatGrid,
  chooseWindow,
  clipSeconds,
  duckSpans,
  forSpeech,
  frameFit,
  parseScript,
  pickTrack,
  presenterInstruction,
  reelBounds,
  scriptInstruction,
  scriptProblems,
  shotSeconds,
  snapCuts,
  spokenMatch,
  type ReelFormat,
  type ReelMood,
  type ReelScript,
  type ReelShot,
  type ReviewIssue,
  type Track,
} from "./reel-rules.ts";
import {
  GRADES,
  MAX_LOOKS,
  MAX_PUSH,
  MAX_RENDERS,
  MAX_SCRIPTS,
  MAX_TAKES_PER_SHOT,
  MAX_TRIMS_PER_SHOT,
  REEL_AGENT_BUDGET,
  TRANSITIONS,
  deliverGate,
  motionProfile,
  reelAgentInstructions,
  renderProblems,
  takeId,
  takeReport,
  validateTrim,
  type Grade,
  type RenderFindings,
  type Transition,
} from "./reel-agent-rules.ts";
import { argNumber, argString, guardAgentText } from "./agent-rules.ts";
import { runAgent, type AgentPicture, type AgentStep, type AgentTool, type ToolOutcome } from "./agent.ts";
import { isServiceDown } from "./service-rules.ts";
import { renderReel, serveFolder } from "./reel-render.ts";
import type { ReelProps } from "../../remotion/types.ts";

/**
 * A story reel, made by the video agent: a director and editor who writes
 * the script, has the narration recorded and every scene filmed, looks at
 * each clip, cuts it, reshoots what a client would reject, sets the grade and
 * the transitions, renders the edit, watches it and repairs it, and delivers
 * only when the render passes. `reel-agent-rules.ts` holds what it is told
 * and what it may deliver; `reel-rules.ts` holds every other decision a
 * function can make; this file holds the tools, the files and FFmpeg.
 *
 * The rules it cannot be trusted with are code, inside the tools: every
 * number in the script is a signed one, every building shot starts from an
 * approved picture, every paid clip is counted against `MAX_CLIP_SECONDS`
 * before it is asked for, the QR scans, the narration is the script, and an
 * independent reviewer's report of anything broken holds the reel back.
 *
 * Imports are relative because the worker runs this straight from source.
 */

const execOnce = promisify(execFile);
/**
 * FFmpeg, asked twice. A reel is fifteen minutes and several dollars of
 * clips by the time it is being reviewed, and one frame grab that failed
 * for a reason outside it (a console signal from another process, on
 * Windows) threw all of it away on the first live run.
 */
const exec = (async (cmd: string, args: string[], opts?: object) => {
  try {
    return await execOnce(cmd, args, opts as never);
  } catch {
    await new Promise((r) => setTimeout(r, 800));
    return await execOnce(cmd, args, opts as never);
  }
}) as unknown as typeof execOnce;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");

/** The director and editor. `REEL_AGENT_MODEL` overrides it; `doc/pricing.md` prices it. */
export const REEL_AGENT_MODEL = process.env.REEL_AGENT_MODEL || "gpt-5.5";
const REEL_AGENT_EFFORT = (process.env.REEL_AGENT_EFFORT || "low") as "none" | "low" | "medium" | "high";
export const REEL_EYE = process.env.REEL_EYE_MODEL || "gpt-5-mini";
export const REEL_REVIEWER = process.env.REEL_REVIEWER_MODEL || "gpt-5.5";
export const REEL_VIDEO_MODEL = openRouterVideoModel(process.env.REEL_VIDEO_MODEL) || "kwaivgi/kling-v3.0-pro";
/**
 * The model that makes a presenter speak: Wan 2.7 image-to-video, which takes
 * the line as audio and moves the lips to it. Kling makes its own voice or
 * none; nothing else on offer lip-syncs to a line we recorded, and
 * the presenter has to say the approved words in the reel's one voice.
 */
export const PRESENTER_VIDEO_MODEL = openRouterVideoModel(process.env.PRESENTER_VIDEO_MODEL) || "alibaba/wan-2.7";
/** Sarvam Bulbul v3 narrators. */
const VOICES = { female: "priya", male: "aditya" } as const;

export type ReelDrivers = {
  ask: AskDriver;
  speak: SpeakDriver;
  /** People keyframes, edited from the cast portrait. */
  still: DesignDriver;
  /** The cast portrait, from words. */
  imagine: DesignDriver;
  animate: AnimateDriver;
  hear: HearDriver;
  render: (props: ReelProps, out: string) => Promise<void>;
  /** The director's model, injected by the checks so a suite never pays for one. */
  brain?: AgentBrain;
  /** The pixel gate's reader, injected by a suite. */
  pixel?: PixelReader;
};

const DEFAULTS: ReelDrivers = {
  ask: askJson,
  speak,
  still: designAd,
  imagine: imagineStill,
  animate: animateFrame,
  hear,
  render: (props, out) => renderReel(props, out),
};

export type ReelOutcome =
  | { ok: true; postId: string; plan: ReelPlan }
  | { ok: false; code: string; message: string; plan?: ReelPlan };

/** An editor's eye on one cut: whether it is clean, and for a building shot whether the building still matches. */
type Eye = { clean: boolean; building: boolean | null; issue: string };
/** A check that could not run because the service behind it is down: the job stops rather than filming blind. */
type Down = { code: string; message: string };

/**
 * The agent's work so far, kept on the job so "Try again" picks up from it:
 * the takes it paid for, the cuts it made, its edit. Files are named, not
 * held: they live in the scratch folder.
 */
export type ReelMemory = {
  audio: { durations: number[]; spoken: (number | null)[]; voice: (string | null)[]; track: string | null; mood: ReelMood } | null;
  takes: { id: string; shot: string; raw: string; seconds: number }[];
  cuts: { shot: string; take: string; file: string; start: number; speed: number; eye: Eye | null }[];
  style: { grade: Grade; shots: Record<string, { transition: Transition; push: number }> };
  scripts: number;
  renders: number;
};

/** What a reel was made from, kept on its job. The copy lives on the card, not here. */
export type ReelPlan = {
  script?: ReelScript;
  music?: { file: string; title: string; artist: string };
  /**
   * The scratch folder of a reel that failed after its clips were paid for.
   * Trying the job again picks up from it: the script, the voice and every
   * clip already made are used again, and only what is missing is bought.
   */
  scratch?: string;
  /** Every render: what it found, and the shots the reviewer sent back. */
  rounds: { problems: string[]; redo: string[] }[];
  spend: { stills: number; clipSeconds: number; clips: number; asks: number };
  agent?: ReelMemory;
  /** The face a person chose for the captions and cards, by key. */
  font?: string;
  /** The director's own thinking: its model, turns and dollars. */
  director?: { model: string; turns: number; usd: number };
};

/** Told of every stage, with the plan so far, so a worker that dies mid-reel leaves it on the row. */
type Stage = (stage: string, progress: number, plan: ReelPlan) => Promise<void>;

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

async function probeSeconds(path: string): Promise<number> {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(String(stdout).trim()) || 0;
}

/** Mean frame-to-frame difference of a clip, `hz` values a second, on a tiny grey copy. */
async function motionCurve(path: string, hz = 10): Promise<number[]> {
  const w = 36;
  const h = 64;
  const { stdout } = await exec(
    FFMPEG,
    ["-v", "error", "-i", path, "-vf", `fps=${hz},scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const buf = stdout as unknown as Buffer;
  const size = w * h;
  const frames = Math.floor(buf.length / size);
  const out: number[] = [];
  for (let f = 1; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Math.abs(buf[f * size + i] - buf[(f - 1) * size + i]);
    out.push(sum / size);
  }
  return out;
}

/** A music track's loudness, `hz` values a second, for finding its beats. */
async function loudness(path: string, hz = 100): Promise<number[]> {
  const rate = 8000;
  const { stdout } = await exec(FFMPEG, ["-v", "error", "-i", path, "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  const buf = stdout as unknown as Buffer;
  const step = rate / hz;
  const out: number[] = [];
  for (let i = 0; i + step * 2 <= buf.length / 2; i += step) {
    let sum = 0;
    for (let j = 0; j < step; j++) {
      const v = buf.readInt16LE((i + j) * 2) / 32768;
      sum += v * v;
    }
    out.push(Math.sqrt(sum / step));
  }
  return out;
}

/** The used window of a clip, cut to the frame's size and rate, with no sound. */
async function cutWindow(src: string, out: string, start: number, seconds: number, w: number, h: number): Promise<void> {
  await exec(FFMPEG, [
    "-y", "-v", "error", "-ss", String(start), "-i", src, "-t", String(seconds),
    "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${REEL_FPS},setsar=1`,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", out,
  ]);
}

/**
 * The mix brought to a feed's loudness: the narrator over the music came out
 * at -12 LUFS with peaks past full scale on the first live reel. Instagram
 * and YouTube play at about -14, so a hotter reel is turned down by them and
 * its peaks crackle first. The picture is copied, not encoded again.
 */
async function levelAudio(path: string): Promise<void> {
  const tmp = path.replace(/\.mp4$/, "-level.mp4");
  await exec(FFMPEG, [
    "-y", "-v", "error", "-i", path, "-c:v", "copy",
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp,
  ]);
  await rename(tmp, path);
}

async function frameAt(path: string, at: number): Promise<Buffer> {
  const { stdout } = await exec(
    FFMPEG,
    ["-v", "error", "-ss", String(Math.max(0, at)), "-i", path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout as unknown as Buffer;
}

async function audioOf(path: string): Promise<Buffer> {
  const { stdout } = await exec(FFMPEG, ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-f", "mp3", "-"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout as unknown as Buffer;
}

const jpeg = async (bytes: Buffer, max = 1024) => ({
  bytes: await sharp(bytes).resize(max, max, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer(),
  type: "image/jpeg",
});

/** A model's sentence made safe to pass to another model: no digits, one line. */
const note = (s: string) => s.replace(/[0-9०-९]+/g, "").replace(/\s+/g, " ").trim().slice(0, 220);

const BOLD = join(process.cwd(), "assets", "fonts", "NotoSans-Bold.ttf");

/**
 * Frames laid out on one sheet, each with its label under it: what an editor
 * scrubs through, as one picture a model can look at. One picture of eight
 * frames costs the agent what one frame would.
 */
async function contactSheet(frames: { png: Buffer; label: string }[], cols: number, cellW: number): Promise<AgentPicture> {
  const first = await sharp(frames[0].png).metadata();
  const cellH = Math.round((cellW * (first.height ?? 16)) / (first.width ?? 9));
  const labelH = 26;
  const rows = Math.ceil(frames.length / cols);
  const layers: sharp.OverlayOptions[] = [];
  for (let i = 0; i < frames.length; i++) {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * (cellH + labelH);
    layers.push({ input: await sharp(frames[i].png).resize(cellW, cellH, { fit: "cover" }).png().toBuffer(), left: x, top: y });
    const text = await sharp({
      text: { text: `<span foreground="#ffffff">${frames[i].label.replace(/[<&>]/g, "")}</span>`, font: "Noto Sans Bold 15", fontfile: BOLD, rgba: true, dpi: 72 },
    })
      .png()
      .toBuffer()
      .catch(() => null);
    if (text) layers.push({ input: text, left: x + 6, top: y + cellH + 4 });
  }
  const bytes = await sharp({ create: { width: cols * cellW, height: rows * (cellH + labelH), channels: 3, background: "#111111" } })
    .composite(layers)
    .jpeg({ quality: 80 })
    .toBuffer();
  return { bytes, type: "image/jpeg", detail: "high" };
}

/** `count` frames of a file, evenly from `from` to `to` seconds, labelled with their time. */
async function sheetOf(path: string, from: number, to: number, count: number, cellW: number): Promise<AgentPicture> {
  const times = Array.from({ length: count }, (_, i) => from + ((to - from) * i) / Math.max(1, count - 1));
  const frames = await Promise.all(times.map(async (t) => ({ png: await frameAt(path, t), label: `${t.toFixed(1)} s` })));
  return contactSheet(frames, 4, cellW);
}

// ---------------------------------------------------------------------------
// The music library
// ---------------------------------------------------------------------------

const MUSIC = join(process.cwd(), "assets", "music");

/**
 * Every track in `assets/music/`: the ones `tracks.json` describes, and any
 * MP3 dropped into a mood folder without a description, whose mood is its
 * folder. Adding music is adding a file.
 */
async function loadTracks(): Promise<Track[]> {
  const described = existsSync(join(MUSIC, "tracks.json"))
    ? (JSON.parse(readFileSync(join(MUSIC, "tracks.json"), "utf8")) as Track[])
    : [];
  const known = new Set(described.map((t) => t.file));
  const extra: Track[] = [];
  for (const mood of existsSync(MUSIC) ? readdirSync(MUSIC, { withFileTypes: true }) : []) {
    if (!mood.isDirectory()) continue;
    for (const f of readdirSync(join(MUSIC, mood.name))) {
      const rel = `${mood.name}/${f}`;
      if (!/\.mp3$/i.test(f) || known.has(rel)) continue;
      extra.push({ file: rel, mood: mood.name, seconds: Math.round(await probeSeconds(join(MUSIC, rel))), title: f, artist: "" });
    }
  }
  return [...described, ...extra].filter((t) => existsSync(join(MUSIC, t.file)));
}

// ---------------------------------------------------------------------------
// The reel
// ---------------------------------------------------------------------------

export async function makeReel(input: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  copyId: string;
  placement: string;
  /** Which film: a narrated story, or an agent on camera. */
  /** A face from `font-rules.ts`; anything else sets the reel in Noto. */
  font?: string | null;
  format?: ReelFormat;
  drivers?: Partial<ReelDrivers>;
  signal?: AbortSignal;
  onStage?: Stage;
  /** Told of every step the director takes. */
  onStep?: (step: AgentStep) => void;
  /** Tracks the org used recently, so this reel's is a different one. */
  recentTracks?: string[];
  /** A failed attempt's folder, script and work, to pick up from. */
  resume?: { dir: string; script: ReelScript; music?: ReelPlan["music"]; spend?: ReelPlan["spend"]; agent?: ReelMemory | null } | null;
}): Promise<ReelOutcome> {
  const d: ReelDrivers = { ...DEFAULTS, ...input.drivers };
  const format: ReelFormat = input.format ?? "story";
  const presenting = format === "presenter";
  const bounds = reelBounds(format);
  // What earlier attempts spent carries over, so trying again does not reset the cap.
  const plan: ReelPlan = { rounds: [], spend: { stills: 0, clipSeconds: 0, clips: 0, asks: 0, ...input.resume?.spend } };
  // Kept on the plan, which is what every stage writes back to the job.
  const face = fontFor(input.font);
  if (face) plan.font = face.key;
  // The director may go back a step (a script rewritten after the audio ran
  // long); the bar on the screen never does.
  let furthest = 0;
  const stage = (name: string, progress: number) => {
    furthest = Math.max(furthest, progress);
    return (input.onStage ?? (async () => {}))(name, furthest, plan);
  };
  const size = PLACEMENT_SIZE[input.placement];
  if (!size) return { ok: false, code: "NO_PLACEMENT", message: "That is not a video size." };
  if (!isNodeId(input.briefId) || !isNodeId(input.copyId)) return { ok: false, code: "UNKNOWN", message: "That card is not in this campaign." };

  // ---- what may be said, and what may be shown -----------------------------
  const head = await withTenant(input.orgId, async (sql) => {
    const [row] = await sql<{ node_id: string; path: string; kind: string; name: string; audience: string | null }[]>`
      SELECT n.id AS node_id, n.path::text AS path, n.kind, n.name, b.audience
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${input.orgId} AND b.id = ${input.briefId}`;
    const [card] = await sql<{ id: string; language: string; segment: string; headline: string; body: string; cta: string }[]>`
      SELECT id, language, segment, headline, body, cta FROM campaign_copy
      WHERE org_id = ${input.orgId} AND brief_id = ${input.briefId} AND id = ${input.copyId} AND verdict = 'PASS'`;
    return row && card ? { ...row, card } : null;
  });
  if (!head) return { ok: false, code: "NOT_CLEARED", message: "That card is no longer cleared." };
  const node = { id: head.node_id, path: head.path, kind: head.kind };
  const { ground } = await studioGround(input.orgId, node);
  if (!ground.advertisable) return { ok: false, code: "NOT_ADVERTISABLE", message: "This cannot be advertised today, so no video can be made." };
  // Before anything is paid for: every ad names the exact locality.
  if (!ground.location) return { ok: false, code: "NO_LOCATION", message: NO_LOCATION_MESSAGE };
  const m = await loadMaterials(input.orgId, node);
  if (!m.backgrounds.length) return { ok: false, code: "NO_PICTURE", message: "There is no approved picture of the property to build a video from." };
  // Refused before a clip is paid for, the rule posts follow: a registered
  // tower's reel carries what its state asks on every frame (the QR where it
  // asks for one, Telangana's permit number), and without it the reel would
  // go out short of it. An exempt tower carries none of it.
  const gap = registrationGap(m);
  if (gap) return { ok: false, ...gap };

  const card = head.card;
  const facts = [
    // What an ad is built on, strongest first; the spec sheet is left out.
    ...sellingPoints(ground.talkingPoints, { luxury: isLuxury(ground.configurations) }),
    // Priced the way an ad prints it, so the narrator says "do crore unees
    // lakh" rather than reading out 2,18,24,000 digit group by digit group.
    ...ground.configurations.filter((c) => c.startingPrice !== null).map((c) => `${c.label} starting ${adPrice(c.startingPrice!)}`),
    // A date as an advertisement says it, so the narrator never reads out
    // 2030-09-30. The same form films use.
    ...(ground.possessionDate ? [`Possession: ${monthYear(ground.possessionDate)}`] : []),
  ];
  const cleared = [card.headline, card.body, card.cta, ...facts];
  const pictures = m.backgrounds.slice(0, 8);

  const resume = input.resume && existsSync(input.resume.dir) ? input.resume : null;
  const dir = resume ? resume.dir : await mkdtemp(join(tmpdir(), "salesdesk-reel-"));
  plan.scratch = dir;
  // Kept unless the reel was delivered: "Try again" picks up from it, so the
  // clips a stopped or failed attempt paid for are not paid for twice.
  let keep = true;
  const W = size.w;
  const H = size.h;
  const wide = W > H;
  const drawSize = designSizeExact(W, H);
  const lockupBytes = m.lockup ? await readAsset(m.lockup.key) : null;
  const expectedQr = lockupBytes ? await readQr(lockupBytes) : null;
  let server: Awaited<ReturnType<typeof serveFolder>> | null = null;

  try {
    // ---- the director's desk: what is made so far -----------------------------
    let script: ReelScript | null = resume?.script ?? null;
    const memory: ReelMemory = {
      audio: null,
      takes: [],
      cuts: [],
      style: { grade: "none", shots: {} },
      ...(resume?.agent ?? {}),
      // Trying again is a new attempt: its drafts and renders are counted
      // afresh. What was spent on video is not, and that is the real cap.
      scripts: 0,
      renders: 0,
    };
    // Only what is still on disk counts as made.
    memory.takes = memory.takes.filter((t) => existsSync(join(dir, t.raw)));
    memory.cuts = memory.cuts.filter((c) => existsSync(join(dir, c.file)) && memory.takes.some((t) => t.id === c.take));
    if (memory.audio && (memory.audio.voice.some((v) => v && !existsSync(join(dir, v))) || (memory.audio.track && !existsSync(join(dir, "music.mp3"))))) {
      memory.audio = null;
    }
    // Lines recorded from a different spoken form (before `forSpeech()`, or
    // under another voice) are recorded again: the name of each line is the
    // hash of exactly what was said.
    if (memory.audio && script) {
      const said = script.shots.map((x) =>
        x.narration ? `voice-${createHash("sha1").update(`${script!.voice}|${forSpeech(x.narration)}`).digest("hex").slice(0, 12)}.wav` : null,
      );
      if (said.some((v, i) => v !== memory.audio!.voice[i])) memory.audio = null;
    }
    // A job the earlier worker left behind has raw clips on disk and no
    // memory of them: they are takes all the same, already paid for.
    if (script && !resume?.agent) {
      for (const s of script.shots) {
        const raws = readdirSync(dir).filter((f) => new RegExp(`^${s.id}-raw-\\d+\\.mp4$`).test(f)).sort();
        for (const [k, f] of raws.entries()) {
          memory.takes.push({ id: takeId(s.id, k + 1), shot: s.id, raw: f, seconds: await probeSeconds(join(dir, f)) });
        }
      }
    }
    if (resume?.music) plan.music = resume.music;
    if (script) plan.script = script;
    let version = 1;
    let chosenTrack: { file: string; mood: ReelMood } | null = null;
    let looks = 0;
    let lastRender: (RenderFindings & { problems: string[] }) | null = null;
    // The pixel gate's verdict on that render, kept for the row it is delivered as.
    let lastPixel: PixelRecord | null = null;
    let delivered: string | null = null;
    const trims = new Map<string, number>();
    const eyes = new Map<string, Eye>();
    for (const c of memory.cuts) if (c.eye) eyes.set(c.shot, c.eye);
    const remember = () => {
      plan.agent = memory;
      plan.script = script ?? undefined;
    };
    remember();

    const shotOf = (id: string) => script?.shots.find((s) => s.id === id) ?? null;
    const slotOf = (id: string) => {
      const i = script?.shots.findIndex((s) => s.id === id) ?? -1;
      return i >= 0 && memory.audio ? memory.audio.durations[i] : null;
    };
    const cutOf = (id: string) => memory.cuts.find((c) => c.shot === id) ?? null;
    /** What is wrong with the timed length, or null: the voice decides it, and a story reel runs 22 to 30 seconds. */
    const lengthProblem = () => {
      if (!memory.audio) return null;
      const total = memory.audio.durations.reduce((a, b) => a + b, 0) + END_CARD_SECONDS;
      return total > bounds.max || total < bounds.min
        ? `As timed, the reel runs ${total.toFixed(1)} seconds and it must run ${bounds.min} to ${bounds.max}. ` +
            (total > bounds.max ? "Shorten the narration or drop a shot (write_script), then prepare_audio again." : "Add a line or a shot (write_script), then prepare_audio again.")
        : null;
    };
    const setCut = (c: ReelMemory["cuts"][number]) => {
      memory.cuts = [...memory.cuts.filter((x) => x.shot !== c.shot), c];
      if (c.eye) eyes.set(c.shot, c.eye);
      version++;
      remember();
    };
    const filmed = () => (script?.shots.filter((s) => s.kind !== "card" && cutOf(s.id)).length ?? 0);
    const toFilm = () => (script?.shots.filter((s) => s.kind !== "card").length ?? 1);

    // ---- pictures: the building from an approved one, the people from words ----
    const photo = new Map<number, { bytes: Buffer; type: string }>();
    const approved = async (i: number) => {
      if (!photo.has(i)) {
        const bytes = await readAsset(pictures[i].key);
        if (!bytes) throw new Error("PICTURE_UNREADABLE");
        photo.set(i, await jpeg(bytes, 1536));
      }
      return photo.get(i)!;
    };
    // A property shot starts from the approved picture itself, in the
    // placement's shape: cropped when it is near enough that shape, otherwise
    // extended with the building left as it is (`frameFit()`). The clip's
    // check compares it with the approved picture either way.
    const shaped = new Map<number, Buffer>();
    const shapedFrame = async (i: number): Promise<Buffer | { refused: string; code?: string }> => {
      if (shaped.has(i)) return shaped.get(i)!;
      const src = await approved(i);
      const meta = await sharp(src.bytes).metadata();
      let out: Buffer;
      if (frameFit({ w: meta.width ?? 1, h: meta.height ?? 1 }, { w: W, h: H }) === "crop") {
        out = await sharp(src.bytes).resize(W, H, { fit: "cover", position: "attention" }).jpeg({ quality: 92 }).toBuffer();
      } else {
        plan.spend.stills++;
        const made = await d.still(
          {
            prompt:
              (wide
                ? "Extend this approved architectural photograph into a wide 16:9 frame. Keep the photograph exactly as it " +
                  "is, whole and unchanged, in the middle of the frame; only continue the sky, trees, road and surroundings " +
                  "to its left and right, seamlessly, in the same light. "
                : "Extend this approved architectural photograph into a tall vertical 9:16 frame. Keep the photograph exactly as " +
                  "it is, whole and unchanged, across the middle of the frame; only continue the sky above it and the ground, " +
                  "lawn or foreground below it, seamlessly, in the same light. ") +
              "Do not change, redraw, add to or remove anything of the building. No text, no logos, no people.",
            images: [src],
            size: drawSize,
          },
          { signal: input.signal },
        );
        if (!made.ok) return { refused: made.message, code: made.code };
        out = await sharp(made.bytes).resize(W, H, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
      }
      shaped.set(i, out);
      return out;
    };
    // The cast portrait is made when the first people shot needs it, and kept
    // in the folder, so a job picked up again does not pay for it twice.
    let cast: Buffer | null = existsSync(join(dir, "cast.png")) ? readFileSync(join(dir, "cast.png")) : null;
    let casting: Promise<Buffer | { refused: string; code?: string }> | null = null;
    const castPortrait = (): Promise<Buffer | { refused: string; code?: string }> => {
      if (cast) return Promise.resolve(cast);
      casting ??= (async () => {
        plan.spend.stills++;
        const made = await d.imagine(
          {
            prompt:
              (presenting
                ? `A natural, realistic photograph of ${script?.cast || "an Indian real-estate advisor in her early thirties"}, ` +
                  "standing, facing the camera with a warm, confident expression, framed from head to waist, soft daylight, plain " +
                  "softly blurred background. Real skin, real hands, smart professional Indian clothes. No text, no logos, no buildings."
                : `A natural, warm, realistic photograph of ${script?.cast || "a young Indian couple in their early thirties"}, ` +
                  "standing together, framed from head to waist, soft daylight, plain softly blurred background. Real skin, real " +
                  "hands, contemporary Indian clothes. No text, no logos, no buildings."),
            images: [],
            size: "1024x1536",
          },
          { signal: input.signal },
        );
        if (!made.ok) {
          casting = null;
          return { refused: made.message, code: made.code };
        }
        cast = made.bytes;
        await writeFile(join(dir, "cast.png"), cast);
        return cast;
      })();
      return casting;
    };

    /** Shots whose picture is the approved one: the building is checked against it. */
    const behindIsBuilding = (s: ReelShot) => s.kind === "property" || s.kind === "presenter";

    /**
     * A presenter placed in front of the approved picture, checked BEFORE any
     * video is paid for: the image model redraws the whole frame to add a
     * person, and a building it tidied on the way is the one thing this
     * product may not advertise.
     */
    const presenterCheck = async (s: ReelShot, frame: Buffer): Promise<{ building: boolean; issue: string; down?: Down }> => {
      plan.spend.asks++;
      const verdict = await d.ask(
        {
          model: REEL_EYE,
          system:
            "You check a frame for a real-estate video: a presenter was added in front of an approved photograph of the " +
            "property. Compare the building in the frame with the approved picture: same outline, floors, windows, " +
            "balconies, materials and colours; the presenter may cover part of it. Also say whether the presenter looks " +
            "like a real, natural person. Answer in JSON.",
          parts: [
            { text: "The approved picture:" },
            { image: await approved(s.picture ?? 0) },
            { text: "The frame with the presenter:" },
            { image: await jpeg(frame, 768) },
          ],
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["building_matches", "person_natural", "issue"],
            properties: { building_matches: { type: "boolean" }, person_natural: { type: "boolean" }, issue: { type: "string" } },
          },
          name: "presenter_check",
        },
        { signal: input.signal },
      );
      const v = verdict.ok ? (verdict.value as { building_matches?: boolean; person_natural?: boolean; issue?: string }) : null;
      return {
        building: !!v?.building_matches && v.person_natural !== false,
        issue: v ? note(v.issue ?? "") : "The frame could not be checked.",
        down: !verdict.ok && isServiceDown(verdict.code) ? { code: verdict.code, message: verdict.message } : undefined,
      };
    };

    /** The editor's eye on a cut: artefacts, and for a building shot, the building. */
    const eyeOn = async (s: ReelShot, file: string, seconds: number): Promise<Eye & { down?: Down }> => {
      const look = await Promise.all([0.1, 0.5, 0.9].map((f) => frameAt(file, seconds * f)));
      plan.spend.asks++;
      const verdict = await d.ask(
        {
          model: REEL_EYE,
          system:
            "You are a film editor checking one shot of an advertisement before it is cut in. Look for AI artefacts " +
            "(distorted or melting faces, hands or limbs, objects morphing, garbled text, flicker, frozen frames) and, " +
            "for a building shot, whether the building still matches the approved picture. Answer in JSON.",
          parts: [
            {
              text: `Intended: ${
                s.kind === "property"
                  ? "the approved building, " + (s.scene || "a slow camera move")
                  : s.kind === "presenter"
                    ? "a presenter talking to camera in front of the approved building, " + s.action
                    : s.scene + ", " + s.action
              }.`,
            },
            ...(behindIsBuilding(s) ? [{ text: "The approved picture:" }, { image: await approved(s.picture ?? 0) }] : []),
            { text: "Three frames from the shot, start, middle and end:" },
            ...(await Promise.all(look.map(async (b) => ({ image: await jpeg(b, 768) })))),
          ],
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["clean", "building_matches", "issue"],
            properties: {
              clean: { type: "boolean" },
              building_matches: { type: ["boolean", "null"] },
              issue: { type: "string" },
            },
          },
          name: "shot_check",
        },
        { signal: input.signal },
      );
      const v = verdict.ok ? (verdict.value as { clean?: boolean; building_matches?: boolean | null; issue?: string }) : null;
      return {
        clean: !!v?.clean,
        building: behindIsBuilding(s) ? (v ? v.building_matches !== false : null) : null,
        issue: v ? note(v.issue ?? "") : "The shot could not be checked.",
        // On the first live agent on camera the OpenAI balance ran out mid-way,
        // every eye check came back "could not be checked", and the director
        // paid for three reshoots of shots nothing was wrong with.
        down: !verdict.ok && isServiceDown(verdict.code) ? { code: verdict.code, message: verdict.message } : undefined,
      };
    };

    // ---- the tools --------------------------------------------------------------
    const scriptSchema = presenting ? PRESENTER_SCRIPT_SCHEMA : SCRIPT_SCHEMA;
    const writeScript: AgentTool = {
      name: "write_script",
      exclusive: true,
      description:
        "Submit the whole script. A guard checks every number, phrase and shot; if it names problems, fix them and " +
        "submit again. Submitting again later replaces the script; shots whose picture, scene or action changed lose " +
        "their clips.",
      parameters: scriptSchema as unknown as Record<string, unknown>,
      async run(args) {
        if (memory.scripts >= MAX_SCRIPTS) return { text: `Refused: ${MAX_SCRIPTS} drafts is the limit. Carry on with the script you have, or give up.` };
        memory.scripts++;
        await stage("Writing the story", 5);
        const parsed = parseScript(args, pictures.length, format);
        const problems = parsed.script ? [...parsed.problems, ...scriptProblems(parsed.script, cleared, ground.neverSay)] : parsed.problems;
        if (!parsed.script || problems.length) {
          return { text: `Refused: the script needs fixing.\n${problems.map((p) => `- ${p}`).join("\n")}` };
        }
        const next = parsed.script;
        // Every clip already paid for follows the shot it shows, wherever that
        // shot now sits: a shot dropped from the middle renumbers the rest, and
        // matching by number threw away every take after it. A shot that now
        // shows something else, a presenter saying another line (the lips were
        // synced to the old one), or anyone filmed before the cast changed,
        // keeps nothing.
        const recast = !!script && script.cast !== next.cast;
        if (recast) {
          cast = null;
          await rm(join(dir, "cast.png"), { force: true });
        }
        const moved = new Map<string, string>();
        for (const n of next.shots) {
          const was = (script?.shots ?? []).find(
            (o) =>
              ![...moved.keys()].includes(o.id) &&
              o.kind === n.kind &&
              o.picture === n.picture &&
              // A take is what was filmed: a building shot is its picture, a
              // presenter its picture and the line the lips were synced to, a
              // people shot its scene. Rewording a description is not a
              // reason to pay for the shot again; the director reshoots when it
              // wants a different take.
              (n.kind !== "people" || (o.scene === n.scene && o.action === n.action)) &&
              (n.kind !== "presenter" || o.narration === n.narration) &&
              !(recast && (n.kind === "people" || n.kind === "presenter")),
          );
          if (was) moved.set(was.id, n.id);
        }
        const renamed = new Map<string, string>();
        const count = new Map<string, number>();
        memory.takes = memory.takes
          .filter((t) => moved.has(t.shot))
          .map((t) => {
            const shot = moved.get(t.shot)!;
            if (shot === t.shot) return t;
            const k = (count.get(shot) ?? 0) + 1;
            count.set(shot, k);
            const id = `${shot}r${k}`;
            renamed.set(t.id, id);
            return { ...t, id, shot };
          });
        memory.cuts = memory.cuts
          .filter((c) => moved.has(c.shot))
          .map((c) => ({ ...c, shot: moved.get(c.shot)!, take: renamed.get(c.take) ?? c.take }))
          .filter((c) => memory.takes.some((t) => t.id === c.take));
        memory.style.shots = Object.fromEntries(
          Object.entries(memory.style.shots).filter(([id]) => moved.has(id)).map(([id, v]) => [moved.get(id)!, v]),
        );
        eyes.clear();
        for (const c of memory.cuts) if (c.eye) eyes.set(c.shot, c.eye);
        script = next;
        // The music stays chosen across a rewrite: only the timing is redone.
        if (memory.audio?.track) chosenTrack = { file: memory.audio.track, mood: memory.audio.mood };
        memory.audio = null;
        version++;
        remember();
        return {
          text:
            `Script accepted: ${next.shots.length} shots, ${next.mood}, ${next.voice} narrator.\n` +
            next.shots
              .map((s) => `${s.id} ${s.kind}${s.kind === "property" ? ` (picture ${(s.picture ?? 0) + 1})` : ""}: ${s.narration || "(no narration)"}`)
              .join("\n") +
            "\nNext: prepare_audio.",
        };
      },
    };

    const prepareAudio: AgentTool = {
      name: "prepare_audio",
      exclusive: true,
      description:
        "Record the narration and choose the music, then time every shot: its line plus a breath, cut on the beat. " +
        "Give a mood to choose music of another mood than the script's, or null.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["mood"],
        properties: { mood: { type: ["string", "null"], enum: [...REEL_MOODS, null] } },
      },
      async run(args) {
        if (!script) return { text: "Refused: write the script first." };
        const shots = script.shots;
        await stage("Recording the narration", 12);
        const spoken: (number | null)[] = [];
        const voice: (string | null)[] = [];
        for (const s of shots) {
          if (!s.narration) {
            spoken.push(null);
            voice.push(null);
            continue;
          }
          // Named by what is said, so a line that did not change is never recorded twice.
          // Spoken as a narrator says it, not as the facts print it (`forSpeech()`).
          const spokenText = forSpeech(s.narration);
          const name = `voice-${createHash("sha1").update(`${script.voice}|${spokenText}`).digest("hex").slice(0, 12)}.wav`;
          if (!existsSync(join(dir, name))) {
            const said = await d.speak({ text: spokenText, voice: VOICES[script.voice], language: "hi-IN" }, { signal: input.signal });
            if (!said.ok) {
              return isServiceDown(said.code)
                ? { text: `The voice is unavailable: ${said.message}`, end: { ok: false, code: said.code, message: said.message } }
                : { text: `The voice failed: ${said.message}` };
            }
            await writeFile(join(dir, name), said.bytes);
          }
          spoken.push(await probeSeconds(join(dir, name)));
          voice.push(name);
        }

        await stage("Choosing the music", 16);
        const mood = (REEL_MOODS as readonly string[]).includes(argString(args, "mood")) ? (argString(args, "mood") as ReelMood) : script.mood;
        let durations = shotSeconds(shots, spoken);
        const total = durations.reduce((a, b) => a + b, 0) + END_CARD_SECONDS;
        const tracks = await loadTracks();
        const was = memory.audio?.track ? { file: memory.audio.track, mood: memory.audio.mood } : chosenTrack;
        const kept =
          was && was.mood === mood && existsSync(join(dir, "music.mp3"))
            ? tracks.find((t) => t.file === was.file && t.seconds >= total + 1)
            : resume?.music && !memory.audio && existsSync(join(dir, "music.mp3"))
              ? tracks.find((t) => t.file === resume.music!.file && t.seconds >= total + 1)
              : undefined;
        const track = kept ?? pickTrack(tracks, mood, total + 1, input.recentTracks ?? [], Date.now());
        let bpm = 0;
        if (track) {
          if (!kept) await copyFile(join(MUSIC, track.file), join(dir, "music.mp3"));
          const grid = beatGrid(await loudness(join(dir, "music.mp3")), 100);
          bpm = grid.bpm;
          durations = snapCuts(durations, grid.beats);
          plan.music = { file: track.file, title: track.title, artist: track.artist };
        }
        memory.audio = { durations, spoken, voice, track: track?.file ?? null, mood };

        // A cut made for the old length is cut again for the new one, from the
        // same place at the same speed, when the clip still has room.
        const dropped: string[] = [];
        for (const c of [...memory.cuts]) {
          const slot = slotOf(c.shot);
          const take = memory.takes.find((t) => t.id === c.take);
          if (slot === null || !take) continue;
          const fits = validateTrim({ clipSeconds: take.seconds, slot, start: c.start, speed: c.speed });
          if (!fits.ok) {
            memory.cuts = memory.cuts.filter((x) => x !== c);
            dropped.push(c.shot);
            continue;
          }
          await cutWindow(join(dir, take.raw), join(dir, c.file), fits.start, fits.takes, W, H);
        }
        version++;
        remember();
        let at = 0;
        const rows = shots.map((s, i) => {
          const row = `${s.id} ${s.kind}: ${durations[i].toFixed(2)} s, from ${at.toFixed(2)} s${spoken[i] ? ` (line ${spoken[i]!.toFixed(2)} s)` : ""}`;
          at += durations[i];
          return row;
        });
        return {
          text:
            `Audio ready. ${track ? `Music: "${track.title}", ${mood}, ${bpm} beats a minute; cuts moved onto the beat.` : "No music track was long enough; the reel has the voice alone."}\n` +
            rows.join("\n") +
            `\nEnd card ${END_CARD_SECONDS} s. Total ${(at + END_CARD_SECONDS).toFixed(1)} s.` +
            (lengthProblem() ? `\n${lengthProblem()}` : "") +
            (dropped.length ? `\nThese cuts no longer fit their new length and need trimming again: ${dropped.join(", ")}.` : ""),
        };
      },
    };

    // Takes of a shot asked for in this attempt, counted when asked for so the
    // cap holds for shots filmed at once. The per-shot cap is per attempt; the
    // seconds cap is not.
    const takesHere = new Map<string, number>();
    /** A shot whose first frame could not be made spent nothing on video. */
    const refundAnd = (seconds: number, r: { refused: string; code?: string }, shot?: string): ToolOutcome => {
      plan.spend.clipSeconds -= seconds;
      plan.spend.clips--;
      if (shot) takesHere.set(shot, Math.max(0, (takesHere.get(shot) ?? 1) - 1));
      return isServiceDown(r.code)
        ? { text: `The image model is unavailable: ${r.refused}`, end: { ok: false, code: r.code, message: r.refused } }
        : { text: `The first frame could not be made: ${r.refused}` };
    };

    const makeClip: AgentTool = {
      name: "make_clip",
      description:
        "Film one shot: its first frame (the approved picture, or the cast in the scene), brought to life by the video " +
        "model, a little longer than the shot so it can be cut. Returns the take, its motion, the cut applied and an " +
        "editor's eye check, with a contact sheet. Call it for several shots in one turn to film them at the same time.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["shot", "direction"],
        properties: {
          shot: { type: "string", description: "The shot id, such as s3." },
          direction: {
            type: "string",
            description: "What the camera and the people should do, or what to do differently from the last take. No numbers.",
          },
        },
      },
      async run(args): Promise<ToolOutcome> {
        const s = shotOf(argString(args, "shot"));
        if (!script || !s) return { text: "Refused: there is no such shot. Write the script first." };
        if (s.kind === "card") return { text: `Refused: ${s.id} is a card; it is set in type, not filmed.` };
        const slot = slotOf(s.id);
        if (slot === null) return { text: "Refused: prepare_audio first, so the shot's length is known." };
        // A reel that cannot pass on length is not filmed: that is money spent on a reel that will be refused.
        if (lengthProblem()) return { text: `Refused: ${lengthProblem()}` };
        if ((takesHere.get(s.id) ?? 0) >= MAX_TAKES_PER_SHOT) {
          return { text: `Refused: ${s.id} has had all ${MAX_TAKES_PER_SHOT} of its takes. Trim the best one, or give up.` };
        }
        const direction = argString(args, "direction").slice(0, 300);
        const guard = guardAgentText({
          texts: direction ? [direction] : [],
          cleared: [],
          neverSay: ground.neverSay,
          maxChars: 300,
          noProperty: s.kind === "people" ? PROPERTY_WORDS : null,
        });
        if (guard.length) return { text: `Refused, and nothing was filmed: ${guard.join(" ")}` };
        // A presenter's clip is exactly as long as the shot: it is never cut, because
        // the lips are synced from its first frame. Everything else gets room to cut.
        const seconds = s.kind === "presenter" ? Math.min(15, Math.max(2, Math.ceil(slot))) : clipSeconds(slot);
        const line = s.kind === "presenter" ? memory.audio?.voice[script.shots.indexOf(s)] ?? null : null;
        if (s.kind === "presenter" && !line) return { text: `Refused: ${s.id} is a presenter shot with no recorded line; give it narration.` };
        // Counted before it is asked for, so shots filmed at once cannot all
        // pass the cap before any of them is counted.
        if (plan.spend.clipSeconds + seconds > MAX_CLIP_SECONDS) {
          return {
            text:
              `Refused: this reel has used ${plan.spend.clipSeconds} of its ${MAX_CLIP_SECONDS} seconds of video, and this shot needs ${seconds}. ` +
              "Use the takes you have, or rewrite the script so this shot is a card (set in type, free) or is dropped: every shot you keep keeps its takes.",
          };
        }
        takesHere.set(s.id, (takesHere.get(s.id) ?? 0) + 1);
        plan.spend.clipSeconds += seconds;
        plan.spend.clips++;
        // The first frame: the approved picture, or the cast in the scene.
        let first: Buffer;
        if (s.kind === "presenter") {
          const behind = await shapedFrame(s.picture ?? 0);
          if (!Buffer.isBuffer(behind)) return refundAnd(seconds, behind, s.id);
          const portrait = await castPortrait();
          if (!Buffer.isBuffer(portrait)) return refundAnd(seconds, portrait, s.id);
          plan.spend.stills++;
          const kf = await d.still(
            {
              prompt:
                "Edit the first image, an approved photograph of the property, to add the person from the second image as a " +
                `real-estate presenter standing in the foreground: ${s.scene || "framed from the waist up, facing the camera"}. ` +
                `They face the camera, about to speak: ${s.action || "an open hand toward the building"}. The same person as in the ` +
                "second image: face, hair and clothes. Photorealistic, lit like the photograph. Keep the building and everything " +
                "behind the person exactly as in the first image: same outline, floors, windows, balconies, materials and colours; " +
                "the person covers as little of the building as possible, in the lower half of the frame. No text, no logos, no signs." +
                (direction ? ` Direction: ${direction}.` : ""),
              images: [
                { bytes: behind, type: "image/jpeg" },
                { bytes: portrait, type: "image/png" },
              ],
              size: drawSize,
            },
            { signal: input.signal },
          );
          if (!kf.ok) return refundAnd(seconds, { refused: kf.message, code: kf.code }, s.id);
          first = await sharp(kf.bytes).resize(W, H, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
          const look = await presenterCheck(s, first);
          if (look.down) return refundAnd(seconds, { refused: look.down.message, code: look.down.code }, s.id);
          if (!look.building) {
            plan.spend.clipSeconds -= seconds;
            plan.spend.clips--;
            return {
              text:
                `Nothing was filmed: the frame with the presenter did not keep the approved building, or the presenter did not ` +
                `look natural. ${look.issue} Make it again with a direction that keeps the presenter lower or to one side.`,
              images: [{ ...(await jpeg(first, 768)), detail: "low" }],
            };
          }
        } else if (s.kind === "property") {
          const f = await shapedFrame(s.picture ?? 0);
          if (!Buffer.isBuffer(f)) return refundAnd(seconds, f, s.id);
          first = f;
        } else {
          const portrait = await castPortrait();
          if (!Buffer.isBuffer(portrait)) return refundAnd(seconds, portrait, s.id);
          plan.spend.stills++;
          const kf = await d.still(
            {
              prompt:
                `A cinematic ${wide ? "wide 16:9" : "vertical 9:16"} photograph for a premium Indian brand film. The same people as in the reference ` +
                `image, looking exactly like them. Scene: ${s.scene}. The moment just before: ${s.action}. Natural light, ` +
                "shallow depth of field, realistic faces and hands, calm composition with room at the top. No text, no " +
                "logos, no signs, no buildings in focus." +
                (direction ? ` Direction: ${direction}.` : ""),
              images: [{ bytes: portrait, type: "image/png" }],
              size: drawSize,
            },
            { signal: input.signal },
          );
          if (!kf.ok) return refundAnd(seconds, { refused: kf.message, code: kf.code }, s.id);
          first = await sharp(kf.bytes).resize(W, H, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
        }

        const move =
          s.kind === "presenter"
            ? `The presenter speaks directly to the camera, with natural lip movement, expressions and small hand gestures; ${s.action}. ` +
              `${direction ? `${direction}. ` : ""}The camera is steady, at most a very slow push-in. The building behind stays exactly as it is.`
            : s.kind === "property"
            ? `${direction || s.scene || "A slow, steady camera push-in"}. The building stays exactly as it is: same floors, windows, ` +
              "balconies and materials; nothing is added, removed or reshaped. Gentle natural movement in the sky, light and trees."
            : `${s.action}. ${direction ? `${direction}. ` : ""}Natural, real-time speed; the action fills the whole shot, with no slow ` +
              "motion and no sudden jump. Subtle handheld camera. Faces and hands stay natural and consistent.";
        const clip = await d.animate(
          s.kind === "presenter"
            ? {
                image: { bytes: first, type: "image/jpeg" },
                prompt: `${move} No text, captions, logos or watermarks.`,
                negativePrompt: "distorted face, extra fingers, warped hands, changing building, extra floors, text, watermark, flicker",
                duration: seconds,
                cfgScale: 0.5,
                model: PRESENTER_VIDEO_MODEL,
                audio: { bytes: await readFile(join(dir, line!)), type: "audio/wav" },
                resolution: "1080p",
              }
            : {
                image: { bytes: first, type: "image/jpeg" },
                prompt: `${move} About ${Math.round(slot)} seconds of action. No text, captions, logos or watermarks; no distorted faces or hands, no morphing, no flicker.`,
                negativePrompt: "",
                duration: seconds,
                cfgScale: 0.5,
                model: REEL_VIDEO_MODEL,
                sound: "off",
              },
          { signal: input.signal },
        );
        if (!clip.ok) {
          if (isServiceDown(clip.code)) {
            return { text: `The video model is unavailable: ${clip.message}`, end: { ok: false, code: clip.code, message: clip.message } };
          }
          return { text: `The filming failed: ${clip.message}` };
        }
        // Numbered after every take already in the folder, so nothing paid for is written over.
        const n = readdirSync(dir).filter((f) => new RegExp(`^${s.id}-raw-\\d+\\.mp4$`).test(f)).length + 1;
        const raw = `${s.id}-raw-${n}.mp4`;
        await writeFile(join(dir, raw), clip.bytes);
        const rawSeconds = await probeSeconds(join(dir, raw));
        const id = takeId(s.id, n);
        memory.takes.push({ id, shot: s.id, raw, seconds: rawSeconds });

        // The editor's first pass: the usable window, applied, and an eye on it.
        const curve = await motionCurve(join(dir, raw));
        // A presenter is cut from the first frame, where the lips start with the line.
        const window =
          s.kind === "presenter"
            ? { start: 0, rate: Math.min(1, Math.max(0.85, Math.round((rawSeconds / slot) * 100) / 100)) }
            : chooseWindow(curve, 10, slot, s.kind);
        let eye: Eye | null = null;
        if (window) {
          const file = `${s.id}-cut-${n}.mp4`;
          await cutWindow(join(dir, raw), join(dir, file), window.start, slot * window.rate, W, H);
          const seen = await eyeOn(s, join(dir, file), slot * window.rate);
          // A check that could not run leaves the cut unchecked, and the job stops.
          eye = seen.down ? null : { clean: seen.clean, building: seen.building, issue: seen.issue };
          setCut({ shot: s.id, take: id, file, start: window.start, speed: window.rate, eye });
          if (seen.down) return { text: `The editor's eye is unavailable: ${seen.down.message}`, end: { ok: false, ...seen.down } };
        } else remember();
        await stage(`Shooting the scenes (${filmed()} of ${toFilm()})`, 25 + Math.round((filmed() / toFilm()) * 40));
        return {
          text: takeReport({
            id,
            shot: s.id,
            kind: s.kind,
            n,
            clipSeconds: rawSeconds,
            slot,
            motion: motionProfile(curve, 10),
            cut: window ? { start: window.start, speed: window.rate } : null,
            eye,
            spentSeconds: plan.spend.clipSeconds,
          }),
          images: [await sheetOf(join(dir, raw), 0.05, Math.max(0.1, rawSeconds - 0.15), 8, wide ? 256 : 200)],
        };
      },
    };

    const lookAt: AgentTool = {
      name: "look_at",
      description: "See part of a take closer: eight frames between two times, in seconds of the clip as filmed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["take", "from", "to"],
        properties: { take: { type: "string" }, from: { type: "number" }, to: { type: "number" } },
      },
      async run(args) {
        const t = memory.takes.find((x) => x.id === argString(args, "take"));
        if (!t) return { text: "Refused: there is no such take." };
        if (++looks > MAX_LOOKS) return { text: "Refused: enough looking. Decide." };
        const from = Math.max(0, Math.min(t.seconds - 0.2, argNumber(args, "from") ?? 0));
        const to = Math.max(from + 0.2, Math.min(t.seconds - 0.05, argNumber(args, "to") ?? t.seconds));
        return { text: `${t.id}, ${from.toFixed(1)} to ${to.toFixed(1)} s:`, images: [await sheetOf(join(dir, t.raw), from, to, 8, wide ? 256 : 200)] };
      },
    };

    const trimClip: AgentTool = {
      name: "trim_clip",
      description:
        "Cut a shot from one of its takes: where in the take it starts (seconds) and how fast it plays (one is real time). " +
        "The shot's length is fixed by its line. Returns the cut, an eye check and a contact sheet of it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["shot", "take", "start", "speed"],
        properties: { shot: { type: "string" }, take: { type: "string" }, start: { type: "number" }, speed: { type: "number" } },
      },
      async run(args) {
        const s = shotOf(argString(args, "shot"));
        const t = memory.takes.find((x) => x.id === argString(args, "take"));
        if (!s || !t || t.shot !== s.id) return { text: "Refused: that take is not of that shot." };
        if (s.kind === "presenter" && ((argNumber(args, "start") ?? 0) > 0.01 || Math.abs((argNumber(args, "speed") ?? 1) - 1) > 0.01)) {
          return { text: "Refused: a presenter shot is lip-synced from its first frame, so it is never trimmed or sped up. Make it again instead." };
        }
        const slot = slotOf(s.id);
        if (slot === null) return { text: "Refused: prepare_audio first." };
        const n = (trims.get(s.id) ?? 0) + 1;
        if (n > MAX_TRIMS_PER_SHOT) return { text: `Refused: ${s.id} has been trimmed ${MAX_TRIMS_PER_SHOT} times. Keep the best cut.` };
        const fits = validateTrim({ clipSeconds: t.seconds, slot, start: argNumber(args, "start") ?? 0, speed: argNumber(args, "speed") ?? 1 });
        if (!fits.ok) return { text: `Refused: ${fits.problem}` };
        trims.set(s.id, n);
        await stage("Editing the shots", 66);
        const file = `${s.id}-trim-${Date.now().toString(36)}.mp4`;
        await cutWindow(join(dir, t.raw), join(dir, file), fits.start, fits.takes, W, H);
        const seen = await eyeOn(s, join(dir, file), fits.takes);
        if (seen.down) return { text: `The editor's eye is unavailable: ${seen.down.message}`, end: { ok: false, ...seen.down } };
        const eye: Eye = { clean: seen.clean, building: seen.building, issue: seen.issue };
        setCut({ shot: s.id, take: t.id, file, start: fits.start, speed: fits.speed, eye });
        return {
          text:
            `${s.id} now cut from ${t.id}, ${fits.start.toFixed(2)} s at speed ${fits.speed.toFixed(2)}. ` +
            `Editor's eye: ${eye.clean ? "clean" : "not clean"}${behindIsBuilding(s) ? `; building ${eye.building === false ? "does NOT match" : "matches"}` : ""}${eye.issue ? `. ${eye.issue}` : "."}`,
          images: [await sheetOf(join(dir, file), 0.05, Math.max(0.1, slot - 0.1), 4, wide ? 256 : 200)],
        };
      },
    };

    const setStyle: AgentTool = {
      name: "set_style",
      description:
        "The finish of the edit: one colour grade for the whole reel, and for any shot how it comes in (cut, fade, dip, " +
        "flash) and a slow push-in (0 to 0.08 of the frame). Shots not named keep what they have.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["grade", "shots"],
        properties: {
          grade: { type: "string", enum: [...GRADES] },
          shots: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["shot", "transition", "push"],
              properties: { shot: { type: "string" }, transition: { type: "string", enum: [...TRANSITIONS] }, push: { type: "number" } },
            },
          },
        },
      },
      async run(args) {
        const grade = argString(args, "grade") as Grade;
        if (!GRADES.includes(grade)) return { text: `Refused: the grade is one of ${GRADES.join(", ")}.` };
        const shots = Array.isArray((args as { shots?: unknown }).shots) ? ((args as { shots: unknown[] }).shots as Record<string, unknown>[]) : [];
        for (const x of shots) {
          const id = String(x.shot ?? "");
          if (!shotOf(id)) return { text: `Refused: there is no shot ${id}.` };
          const tr = String(x.transition ?? "cut") as Transition;
          if (!TRANSITIONS.includes(tr)) return { text: `Refused: a transition is one of ${TRANSITIONS.join(", ")}.` };
          memory.style.shots[id] = { transition: tr, push: Math.min(MAX_PUSH, Math.max(0, Number(x.push) || 0)) };
        }
        memory.style.grade = grade;
        version++;
        remember();
        return { text: `Style set: ${grade} grade; ${Object.entries(memory.style.shots).map(([k, v]) => `${k} ${v.transition}${v.push ? ` push ${v.push}` : ""}`).join(", ") || "every shot a straight cut"}.` };
      },
    };

    // ---- the edit, rendered -------------------------------------------------------
    const frames = (sec: number) => Math.round(sec * REEL_FPS);
    const prepareBrand = async () => {
      if (lockupBytes) await writeFile(join(dir, "qr.png"), await sharp(await qrOnly(lockupBytes)).png().toBuffer());
      if (m.logo) await writeFile(join(dir, "logo.png"), (await bareLogo(m.logo.bytes, 600, 200, [20, 20, 20])).buf);
      // The chosen face sets every caption, card and the end card; Noto when none was chosen.
      await copyFile(join(process.cwd(), face ? fontFile(face.key, "Regular") : join("assets", "fonts", "NotoSans-Regular.ttf")), join(dir, "regular.ttf"));
      await copyFile(join(process.cwd(), face ? fontFile(face.key, "Bold") : join("assets", "fonts", "NotoSans-Bold.ttf")), join(dir, "bold.ttf"));
      server ??= await serveFolder(dir);
    };
    const foot = footLines({
      phone: m.phone,
      website: m.website,
      disclaimer: withAiLine(smallPrintFor(m, false, m.disclaimer)),
      isRender: true,
      ad: m.ad,
      promoter: m.promoter,
      officeAddress: m.officeAddress,
    });
    const host = m.website?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null;
    const propsFor = (): ReelProps => {
      const url = (f: string) => server!.base + encodeURIComponent(basename(f));
      const audio = memory.audio!;
      let at = 0;
      const voice: ReelProps["voice"] = [];
      const shots: ReelProps["shots"] = script!.shots.map((s, i) => {
        const f = frames(audio.durations[i]);
        // A presenter's line starts with the shot, because the lips do; a
        // voice-over breathes in a fifth of a second after the cut.
        if (audio.voice[i]) voice.push({ src: url(audio.voice[i]!), from: at + (s.kind === "presenter" ? 0 : 6) });
        const cut = cutOf(s.id);
        const style = memory.style.shots[s.id];
        at += f;
        return {
          id: s.id,
          kind: s.kind,
          src: cut ? url(cut.file) : null,
          trimBefore: 0,
          rate: cut?.speed ?? 1,
          frames: f,
          caption: s.caption,
          card: s.card,
          supers: s.supers ?? [],
          transition: style?.transition ?? "cut",
          push: style?.push ?? 0,
        };
      });
      const spans = duckSpans(voice.map((v, k) => ({ at: v.from, seconds: frames(audio.spoken.filter((x) => x !== null)[k] ?? 0) })));
      return {
        width: W,
        height: H,
        fps: REEL_FPS,
        shots,
        grade: memory.style.grade,
        end: { frames: frames(END_CARD_SECONDS), cta: script!.cta, phone: m.phone, website: host },
        voice,
        music: audio.track ? { src: url(join(dir, "music.mp3")), duck: spans } : null,
        brand: {
          colour: m.colour,
          logo: m.logo ? url(join(dir, "logo.png")) : null,
          qr: lockupBytes ? url(join(dir, "qr.png")) : null,
          registrationNo: m.registrationNo,
          reraWebsite: m.ad?.website ?? RERA_WEBSITE,
          reraLabel: m.ad?.label,
          permitNo: m.permitNo,
          reraPlace: m.ad?.placement,
          smallPrint: foot.small ?? "",
        },
        fonts: { regular: url(join(dir, "regular.ttf")), bold: url(join(dir, "bold.ttf")) },
      };
    };
    const out = join(dir, "reel.mp4");

    const renderAndReview: AgentTool = {
      name: "render_and_review",
      exclusive: true,
      description:
        "Render the edit as it stands, then check it: the QR on every shot, what the narration really says, the length, " +
        "and an independent reviewer who watches it. Returns what they found and a contact sheet of the reel.",
      parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
      async run() {
        if (!script || !memory.audio) return { text: "Refused: write the script and prepare the audio first." };
        const missing = script.shots.filter((s) => s.kind !== "card" && !cutOf(s.id)).map((s) => s.id);
        if (missing.length) return { text: `Refused: these shots have no cut yet: ${missing.join(", ")}.` };
        if (memory.renders >= MAX_RENDERS) return { text: `Refused: the reel has been rendered ${MAX_RENDERS} times. Deliver it or give up.` };
        memory.renders++;
        const round = memory.renders;
        await stage(round === 1 ? "Editing the video" : `Repairing, round ${round}`, 68 + (round - 1) * 5);
        await prepareBrand();
        const props = propsFor();
        await d.render(props, out);
        await levelAudio(out);

        await stage(round === 1 ? "Reviewing the video" : `Reviewing again, round ${round}`, 70 + (round - 1) * 5);
        const seconds = await probeSeconds(out);
        const starts: number[] = [];
        props.shots.reduce((a, s) => (starts.push(a), a + s.frames), 0);
        const samples = await Promise.all(
          props.shots.flatMap((s, i) => [0.3, 0.85].map(async (f) => ({ id: s.id, f, png: await frameAt(out, (starts[i] + s.frames * f) / REEL_FPS) }))),
        );
        const endFrame = await frameAt(out, seconds - 1.2);
        // The pixel gate, on the render: the first, middle and last frame of
        // every shot and the end card. The overlay is ours, so what fails
        // here is ours too, and the director is told it stops delivery.
        const spans = props.shots.map((s, i) => ({ start: starts[i] / REEL_FPS, end: (starts[i] + s.frames) / REEL_FPS }));
        const lastEnd = spans.length ? spans[spans.length - 1].end : 0;
        const endCard = seconds - lastEnd > 0.5 ? { start: lastEnd, end: seconds } : null;
        const pixel = await gatePost({
          files: [{ bytes: await readFile(out), type: "video/mp4" }],
          // The phone is on the end card only; every other frame carries the block and the foot.
          expect: (_f, at) => frameExpect(m, expectedQr, pixelContext(ground), { render: true, contact: !!endCard && at !== undefined && at >= endCard.start }),
          times: () => sampleTimes(spans, endCard),
          registrationNo: m.registrationNo,
          reader: d.pixel,
        });
        lastPixel = pixel;
        // The upper-right corner where the registration block sits, sized by
        // the short side so a wide film's block is not cut off.
        const qrRegion = { x: W * 0.55, y: 0, w: W * 0.45, h: Math.min(H, Math.min(W, H) * 0.36) };
        const qrReads = lockupBytes
          ? await Promise.all([samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]].map((x) => readQr(x.png, qrRegion)))
          : [];
        const heard = await d.hear({ audio: { bytes: await audioOf(out), type: "audio/mpeg" }, language: "hi" }, { signal: input.signal });
        const transcript = heard.ok ? heard.text : "";
        plan.spend.asks++;
        const review = await d.ask(
          {
            model: REEL_REVIEWER,
            system:
              "You are the strict creative director of an Indian advertising agency, reviewing a finished real-estate " +
              (presenting ? "'agent on camera' reel, in which a presenter talks to camera, " : "story reel ") +
              "before it goes to the client. You see two frames from every shot and the end card, the script, and " +
              "what the audio actually says. Mark a blocker only for what a client would reject: " +
              (presenting
                ? "a presenter who looks like a different person from one shot to the next, a mouth that does not move with the " +
                  "words or a face frozen while speaking, large on-screen text that is wrong or unreadable, "
                : "") +
              "visible AI artefacts " +
              "(distorted or melting faces, hands or limbs, morphing objects, garbled text), a building that warps, bends or " +
              "gains or loses floors within its shot, a shot that contradicts its narration, a jarring or broken edit, " +
              "captions that are wrong or unreadable, or a story that does not hang together. Building shots are made from " +
              "pictures a person approved, each already compared with its own picture: they may show different towers, " +
              "angles or amenities of the project, and a building shot looking unlike another is never a blocker. For a " +
              "bad shot say regenerate; for a shot that starts or ends badly say retrim. Minor taste notes are not " +
              "blockers. Answer in JSON.",
            parts: [
              {
                text:
                  `SCRIPT (${script.title}; mood ${script.mood}):\n` +
                  script.shots.map((s) => `${s.id} [${s.kind === "property" ? `property, approved picture ${(s.picture ?? 0) + 1}` : s.kind}] narration: ${s.narration || "(none)"} | caption: ${s.caption || "(none)"} | ${s.kind === "card" ? `card: ${s.card}` : `shows: ${s.scene}; ${s.action}`}`).join("\n") +
                  `\nEND CARD: ${script.cta}\n\nWHAT THE AUDIO SAYS: ${transcript || "(no transcript)"}`,
              },
              ...(
                await Promise.all(samples.map(async (x) => [{ text: `Shot ${x.id}, ${x.f < 0.5 ? "early" : "late"}:` }, { image: await jpeg(x.png, 512) }] as const))
              ).flat(),
              { text: "End card:" },
              { image: await jpeg(endFrame, 512) },
            ],
            schema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
            name: "reel_review",
          },
          { signal: input.signal },
        );
        const issues = review.ok ? ((review.value as { issues?: ReviewIssue[] }).issues ?? []) : [];
        const findings: RenderFindings = {
          version,
          hard: {
            qrScans: !lockupBytes || (expectedQr !== null && qrReads.every((q) => q === expectedQr)),
            spokenMatch: heard.ok ? spokenMatch(script.shots.map((s) => s.narration), transcript) : 1,
            seconds,
            buildingDrift: [],
            pixel: pixel.findings.filter((f) => f.verdict === "FAIL").map((f) => f.text),
          },
          issues,
          reviewed: review.ok,
          bounds,
        };
        const buildings = script.shots.filter(behindIsBuilding).map((s) => ({ shot: s.id, matches: eyes.get(s.id)?.building ?? null }));
        const gate = deliverGate({ version, render: findings, buildings });
        lastRender = { ...findings, problems: gate };
        plan.rounds.push({
          problems: renderProblems(findings),
          redo: issues.filter((i) => i.blocker && i.shot && (i.fix === "regenerate" || i.fix === "retrim")).map((i) => `${i.shot}:${i.fix}`),
        });
        remember();
        const sheet = await contactSheet(
          [...samples.map((x) => ({ png: x.png, label: `${x.id} ${x.f < 0.5 ? "early" : "late"}` })), { png: endFrame, label: "end card" }],
          wide ? 4 : 6,
          wide ? 256 : 170,
        );
        return {
          text: [
            `Render ${round} of ${MAX_RENDERS} · ${gate.length ? "NOT YET DELIVERABLE" : "DELIVERABLE"} · ${seconds.toFixed(1)} s`,
            `QR scans on every shot: ${findings.hard.qrScans ? "yes" : "NO"}. Narration matches the script: ${Math.round(findings.hard.spokenMatch * 100)}%.`,
            gate.length ? `What stops it:\n${gate.map((g) => `- ${g}`).join("\n")}` : "Nothing stops it.",
            issues.length
              ? `The reviewer's notes:\n${issues.map((i) => `- ${i.shot ?? "reel"} ${i.kind}${i.blocker ? " BLOCKER" : ""} (${i.fix}): ${i.note}`).join("\n")}`
              : review.ok
                ? "The reviewer had no notes."
                : "The reviewer could not be reached.",
            `What the audio says: ${transcript.slice(0, 400) || "(no transcript)"}`,
            "The contact sheet below is two frames of every shot and the end card, from the render.",
          ].join("\n"),
          images: [sheet],
        };
      },
    };

    /**
     * Save the reel as it was last rendered. The director saves it when it
     * passed; after its last round the job saves it anyway, with what was
     * still wrong kept on the review rather than shown as an error (the
     * client, 5 October 2026: a reel worked on is shown). The pixel gate
     * still decides whether it may be published.
     */
    const saveReel = async (problems: string[]) => {
      if (!script) return { ok: false as const, text: "Refused: there is no reel yet." };
      await stage("Saving the video", 96);
      const bytes = await readFile(out);
      if (!lastPixel) return { ok: false as const, text: "Refused: render and review the reel first." };
      const pixel: PixelRecord = lastPixel;
      const postId = randomUUID();
      const stored = await storePostFiles(input.orgId, node.id, postId, [{ bytes, type: "video/mp4", w: W, h: H }]);
      if (!stored) return { ok: false as const, text: "The video could not be saved." };
      const media = withHashes(stored, pixel);
      const used = [...new Set(script.shots.filter(behindIsBuilding).map((s) => s.picture ?? 0))].map((i) => ({
        assetId: pictures[i].assetId,
        sha256: pictures[i].sha256,
      }));
      await withTenant(input.orgId, async (sql) => {
        await sql`
          INSERT INTO rendered_posts (id, org_id, brief_id, scope_node_id, copy_id, kind, placement,
                                      language, segment, headline, body, cta, media, inputs, review, pixel, created_by)
          VALUES (${postId}, ${input.orgId}, ${input.briefId}, ${node.id}, ${card.id}, 'VIDEO', ${input.placement},
                  ${card.language}, ${card.segment}, ${card.headline}, ${card.body}, ${card.cta},
                  ${sql.json(media as unknown as JSONValue)},
                  ${sql.json({
                    format: presenting ? "presenter" : "story",
                    pictures: used,
                    lockup: m.lockup ? { assetId: m.lockup.assetId, sha256: m.lockup.sha256 } : null,
                    logo: m.logo ? { role: m.logo.role, fileId: m.logo.fileId, at: m.logo.at } : null,
                    registrationNo: m.registrationNo,
                    agentNo: m.agentNo ?? null,
                    template: { key: presenting ? PRESENTER_TEMPLATE.key : STORY_TEMPLATE.key, by: "person" },
                    music: plan.music ?? null,
                    font: face?.key ?? null,
                  } as unknown as JSONValue)},
                  ${sql.json({
                    passed: true,
                    attempts: plan.spend.stills,
                    // Shaped as every post's review is: what was still wrong after the last round.
                    problems: problems.map((text) => ({ code: "UNRESOLVED", text })),
                    model: DESIGN_MODEL,
                    motion: { model: REEL_VIDEO_MODEL, attempts: plan.spend.clips },
                    rounds: memory.renders,
                  } as unknown as JSONValue)},
                  ${sql.json(pixel as unknown as JSONValue)},
                  ${input.actorUserId})`;
      });
      await auditPixel({ orgId: input.orgId, actorUserId: input.actorUserId, targetType: "rendered_post", targetId: postId, record: pixel });
      await meterVideo({ orgId: input.orgId, nodeId: node.id, postId, kind: presenting ? "FILM" : "STORY_REEL", units: 1, passed: true });
      // Counts and codes only: the script can quote the copy.
      await audit({
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        action: "creative.reel_made",
        targetType: "rendered_post",
        targetId: postId,
        metadata: { format, rounds: memory.renders, unresolved: problems.length, shots: script.shots.length, clips: plan.spend.clips, stills: plan.spend.stills },
      });
      delivered = postId;
      return { ok: true as const, postId };
    };

    const deliver: AgentTool = {
      name: "deliver",
      exclusive: true,
      description: "Hand the reel over as it was last rendered. Refused unless that render is of the edit as it stands and passed.",
      parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
      async run() {
        if (!script) return { text: "Refused: there is no reel yet." };
        const buildings = script.shots.filter(behindIsBuilding).map((s) => ({ shot: s.id, matches: eyes.get(s.id)?.building ?? null }));
        const gate = deliverGate({ version, render: lastRender, buildings });
        if (gate.length) return { text: `Refused: ${gate.join(" ")}` };
        const saved = await saveReel([]);
        if (!saved.ok) {
          return saved.text === "The video could not be saved."
            ? { text: saved.text, end: { ok: false, code: "STORE_FAILED", message: saved.text } }
            : { text: saved.text };
        }
        return { text: "Delivered.", end: { ok: true } };
      },
    };

    const giveUp: AgentTool = {
      name: "give_up",
      exclusive: true,
      description: "Stop without a reel, when it cannot pass within its budget. Say why in one sentence.",
      parameters: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" } } },
      async run(args) {
        return { text: "Stopped.", end: { ok: false, code: "GAVE_UP", message: argString(args, "reason").slice(0, 200) } };
      },
    };

    // ---- the job, as the director first sees it -----------------------------------
    const brief = (presenting ? presenterInstruction : scriptInstruction)({
      project: head.name,
      city: ground.location ?? null,
      headline: card.headline,
      body: card.body,
      cta: card.cta,
      facts,
      pictures: pictures.map((p) => ({ category: p.category, title: p.title })),
      audience: head.audience,
      fixes: [],
      placement: input.placement,
    });
    const picked = memory.takes.length || memory.cuts.length || script;
    const already = picked
      ? [
          "",
          "THIS REEL WAS STARTED BEFORE AND STOPPED. Carry on from what exists; do not film again what already works.",
          script ? `The accepted script:\n${JSON.stringify({ ...script, shots: script.shots.map(({ id, ...s }) => ({ id, ...s })) })}` : "",
          memory.audio ? "The audio is prepared." : script ? "The audio needs preparing." : "",
          memory.takes.length ? `Takes already filmed: ${memory.takes.map((t) => `${t.id} (${t.seconds.toFixed(1)} s)`).join(", ")}.` : "",
          memory.cuts.length ? `Shots already cut: ${memory.cuts.map((c) => `${c.shot} from ${c.take}`).join(", ")}.` : "",
          // A cut whose check never ran (a service was down) is re-checked by
          // trimming it again, which is free, rather than filmed again.
          (() => {
            const unchecked = memory.cuts.filter(
              (c) => !c.eye || c.eye.issue === "The shot could not be checked." || (behindIsBuilding(shotOf(c.shot)!) && c.eye.building !== true),
            );
            return unchecked.length
              ? `These cuts were never checked, because a service was down: ${unchecked.map((c) => `${c.shot} (${c.take}, from ${c.start} s at speed ${c.speed})`).join(", ")}. Trim each again at the same start and speed to have it checked; do not film them again unless the check finds a fault.`
              : "";
          })(),
          `Video already spent: ${plan.spend.clipSeconds} of ${MAX_CLIP_SECONDS} seconds.`,
        ].filter(Boolean)
      : [];
    const thumbs = await Promise.all(pictures.map(async (_, i) => ({ ...(await jpeg((await approved(i)).bytes, 512)), detail: "low" as const })));

    await stage(resume ? "Picking up where it stopped" : "Writing the story", 5);
    const run = await runAgent({
      model: REEL_AGENT_MODEL,
      effort: REEL_AGENT_EFFORT,
      instructions: reelAgentInstructions(format),
      task: [
        {
          text: [
            `THE JOB: ${presenting ? "an agent on camera" : "a narrated story"}, a ${wide ? "wide 16:9 film for YouTube" : "vertical 9:16 reel for Instagram and Facebook"}, ${W} by ${H}.`,
            "",
            brief.system.replace(" Return JSON only.", ""),
            "",
            brief.text,
            "",
            presenting
              ? "The approved pictures are attached in order, picture index 0 first. The property shots bring them to life, and the presenter stands in front of one."
              : "The approved pictures are attached in order, picture index 0 first. They are what the property shots bring to life.",
            ...already,
          ].join("\n"),
          images: thumbs,
        },
      ],
      tools: [writeScript, prepareAudio, makeClip, lookAt, trimClip, setStyle, renderAndReview, deliver, giveUp],
      maxTurns: REEL_AGENT_BUDGET.turns,
      maxUsd: REEL_AGENT_BUDGET.usd,
      keepImages: 6,
      parallel: 3,
      maxIdle: 5,
      brain: d.brain,
      signal: input.signal,
      onStep: input.onStep,
    });
    plan.director = { model: REEL_AGENT_MODEL, turns: run.usage.turns, usd: run.usd };
    remember();

    if (delivered) {
      keep = false;
      return { ok: true, postId: delivered, plan };
    }
    if (input.signal?.aborted || run.ended === "stopped") return { ok: false, code: "STOPPED", message: "Stopped.", plan };
    // Out of rounds or out of budget with a render in hand: the reel is
    // shown as it stands, never an error (the client, 5 October 2026).
    // Read through a cast: both are set inside the tools, which the compiler does not follow.
    const rendered = lastRender as (RenderFindings & { problems: string[] }) | null;
    if (rendered && (lastPixel as PixelRecord | null)) {
      const saved = await saveReel(rendered.problems).catch(() => null);
      if (saved?.ok) {
        keep = false;
        remember();
        return { ok: true, postId: saved.postId, plan };
      }
    }
    if (run.end && !run.end.ok && run.end.code && run.end.code !== "GAVE_UP") {
      return { ok: false, code: run.end.code, message: run.end.message ?? "The video could not be made. Try again.", plan };
    }
    const renders = memory.renders;
    const last = lastRender as (RenderFindings & { problems: string[] }) | null;
    return {
      ok: false,
      code: "DID_NOT_PASS",
      message: renders
        ? `Not delivered: after ${renders} ${renders === 1 ? "review" : "reviews"} it still had problems. ${(last?.problems ?? []).slice(0, 2).join(" ")}`.trim()
        : `Not delivered: ${run.end?.message || "the reel was never finished."}`,
      plan,
    };
  } catch (e) {
    // The plan survives a failure, so what was spent and what the review
    // said are still on the job; the scratch folder is kept to look at.
    console.error("reel: failed, scratch kept at", dir, e);
    return { ok: false, code: "FAILED", message: "The video could not be made. Try again.", plan };
  } finally {
    if (server) await (server as { close: () => Promise<void> }).close();
    if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
