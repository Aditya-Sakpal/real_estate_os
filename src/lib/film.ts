import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { type JSONValue } from "postgres";
import { withTenant, audit } from "./db/index.ts";
import { meterVideo } from "./billing.ts";
import { isNodeId } from "./scope-rules.ts";
import { studioGround } from "./creative.ts";
import { fontFor } from "./font-rules.ts";
import { adPrice, isLuxury, NO_LOCATION_MESSAGE, sellingKind, sellingPoints } from "./creative-rules.ts";
import { putAsset, readAsset } from "./storage.ts";
import { projectOfNode } from "./storage-place.ts";
import { filmCard, filmSubtitle, frameExpect, loadMaterials, pixelContext, qrOnly, readQr, registrationGap, renderFrame, smallPrintFor, storePostFiles, textStyleCard } from "./compose.ts";
import { auditPixel, gatePost, withHashes, type PixelReader } from "./pixel.ts";
import { sampleTimes, type PixelRecord } from "./pixel-rules.ts";
import { layoutFor, PLACEMENT_SIZE, withAiLine } from "./compose-rules.ts";
import {
  askJson,
  askSarvam,
  SARVAM_CHAT_MODEL,
  filmScenes,
  FILM_PROVIDER,
  hear,
  FILM_MODEL,
  FILM_RESOLUTION,
  type AskDriver,
  type AskPart,
  type FilmDriver,
  type FilmJob,
  type HearDriver,
  type VeoDriver,
  veoReady,
  veoScene,
} from "./generate.ts";
import { cutsOf, fixScenes, probe, type SceneFixPlan } from "./scene-fix.ts";
import { checkContext, confirmFault, reviewFilm, voicePitch } from "./film-review.ts";
import { voiceFromPitch } from "./film-review-rules.ts";
import { contextNote, shotJobs } from "./film-context-rules.ts";
import { audioFindings } from "./film-audio-rules.ts";
import { listener } from "./listen.ts";
import { listenNote } from "./listen-rules.ts";
import { filmLanguage, isDevanagari, localCard, localTidy, neverIn, spokenFormIn, voiceIn } from "./film-language-rules.ts";
import { hearLocal, localRespeak, localVoiceover } from "./local-voice.ts";
import { directFilm } from "./film-direction.ts";
import { buildStoryPrompt, type FilmDirection } from "./film-direction-rules.ts";
import { storyIn } from "./video-skills.ts";
import { fixesByScene, lostShots, MAX_CONFIRMS, remakeRefusal, remakeWorthy, SCENE_FIX_ROUNDS, scenesFromCuts, shiftWords, stillWorthFixing, type SceneProblem } from "./scene-fix-rules.ts";
import {
  AGENT_DESCRIBING_SKILL,
  FILM_EYE_SCHEMA,
  FILM_SCRIPT_SCHEMA,
  FILM_SWEEP_SCHEMA,
  FILM_STORY_SCHEMA,
  MAX_STORY_PROBLEMS,
  storyNote,
  FILM_UNITS,
  MAX_FILM_DRAFTS,
  MAX_SARVAM_DRAFTS,
  MAX_FILM_REQUESTS,
  retryFilm,
  MAX_FIX_REQUESTS,
  autoFixOn,
  betterFilm,
  filmPictures,
  filmFixes,
  filmProblems,
  filmFacts,
  filmPrompt,
  judgeFilm,
  monthYear,
  parseFilmScript,
  cardParts,
  spokenForm,
  spokenPlace,
  cardWindow,
  withoutPriceTerms,
  pricesIn,
  stillNote,
  stillStretches,
  isFactCard,
  ourCard,
  picturesUsed,
  planTiming,
  skillFor,
  skillRefusal,
  tidyScript,
  timeline,
  writerInstruction,
  type FilmFrameSeen,
  type FilmScript,
  type FilmStray,
  type FilmVerdict,
  ORDINARY_PLACE,
} from "./film-rules.ts";
import { approvedAssets, assetKeys } from "./asset.ts";
import { orderByLearning, pointAngle } from "./learning-rules.ts";
import { learningFor } from "./learning.ts";
import { constructionIsStale, looksBlank } from "./asset-rules.ts";
import { respeakFilm, type RespeakDriver, type RespeakResult } from "./respeak.ts";
import { syncLips, type LipSyncPlan } from "./lipsync.ts";
import { shiftSpans, talkingSpans, type LipSpan } from "./lipsync-rules.ts";
import { elevenLabs } from "./elevenlabs.ts";
import { linePauses, lineSpans, pauseNotes, respeakNotes, type RespeakReport } from "./respeak-rules.ts";
import { isServiceDown } from "./service-rules.ts";
import { BUILDINGS_SCHEMA, joinPlaceNames, MAP_READ_SCHEMA, mapProblems, nearbyBrief, nearbyPlaces, oneBuilding, oneBuildingWhy, placeOfScene, placeOnMap, readMapAnswer, samePlace, withNearbyCards, type MapRead, type NearbyPlace } from "./locality-rules.ts";
import { layMapShots, layPlacePhotos } from "./film-map.ts";
import { placeWindow } from "./locality-rules.ts";
import { recordTrack, type Take, type VoiceTrack } from "./voice-track.ts";
import { TRACK, usesTrack } from "./voice-track-rules.ts";

/**
 * A film made in ONE video generation: an agent on camera, written from the
 * skill, filmed by Seedance 2.5 with its own voice, music and big text,
 * stamped with the registration, checked, and saved. `film-rules.ts` holds
 * every decision a function can make; this file holds the calls and FFmpeg.
 *
 * The product never pays for a second film to fix the first. The checks after
 * it decide whether it may be published and tell the person what they found;
 * a new version is the person's choice, sends this film back in as the
 * starting point, and counts as two videos.
 *
 * Imports are relative because the worker runs this straight from source.
 */

const execOnce = promisify(execFile);
/** FFmpeg, asked twice: one grab that failed for a reason outside it should not lose a paid film. */
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

/** The writer of the scenes. `FILM_WRITER_MODEL` overrides it; `doc/pricing.md` prices it. */
export const FILM_WRITER_MODEL = process.env.FILM_WRITER_MODEL || "gpt-5.5";
/** The eye that reads the finished film's frames. */
export const FILM_EYE_MODEL = process.env.REEL_EYE_MODEL || "gpt-5-mini";
/** The viewer who watches a finished film's story for what makes no sense (`reviewStory()`). */
export const FILM_STORY_MODEL = process.env.FILM_STORY_MODEL || "gpt-5.5";

export type FilmDrivers = {
  ask: AskDriver;
  film: FilmDriver;
  hear: HearDriver;
  /** The pixel gate's reader, injected by a suite whose film draws no words. */
  pixel?: PixelReader;
  /** Re-says the words the film's voice got wrong; null leaves the sound as it came. */
  respeak?: RespeakDriver | null;
  /** Makes a scene Seedance will not take (`scene-fix.ts`), and whether it is configured. */
  veo?: VeoDriver;
  veoReady?: () => boolean;
};
const DEFAULTS: FilmDrivers = { ask: askJson, film: filmScenes, hear };

/**
 * What a film job keeps on its row, so a worker that dies picks up from it:
 * the script it paid a writer for, and the film it asked for, by its request,
 * so a film half made is waited for rather than bought again.
 */
export type FilmPlan = {
  engine: "film";
  /** The video template whose skill makes the film (`skillFor()`). */
  template?: string;
  font?: string;
  /** What this film counts as against the plan's videos. */
  units: number;
  /** A new version of an earlier film, and what the person asked to change. */
  revise?: { postId: string; note: string } | null;
  scratch?: string;
  script?: FilmScript;
  durations?: number[];
  prompt?: string;
  film?: { job: FilmJob | null; requests: number };
  /** What was said again in her voice, kept so a worker that dies does not pay for it twice. */
  respeak?: { report: RespeakReport | null; failed: string | null };
  /**
   * The film made once more to put right what the checks found: what was
   * wrong, its one request (remembered like the first film's), its voice
   * fix, and which of the two was delivered.
   */
  fix?: {
    problems: string[];
    /** Made fresh from the shot list rather than from the first film: the story was wrong. */
    fresh?: boolean;
    film: { job: FilmJob | null; requests: number };
    respeak?: { report: RespeakReport | null; failed: string | null };
    delivered?: "first" | "fixed";
    /** Fixed scene by scene (`scene-fix.ts`) rather than as a whole film. */
    byScene?: boolean;
  };
  /** The scenes made again, their takes and what each cost (`fixScenes()`). */
  sceneFix?: SceneFixPlan;
  /** The last few drafts the gate refused, with why, so a refusal can be read back. */
  refusedDrafts?: { draft: number; problems: string[]; scenes: { line: string; text: string; picture: number; kind: string }[] }[];
  /** A story's shots as directed before filming (`film-direction.ts`). */
  direction?: FilmDirection;
  /** Earlier rounds' scene fixes, the latest in `sceneFix`. */
  sceneFixRounds?: SceneFixPlan[];
  /** The voice laid on the film delivered, after its scenes were fixed (`voiceLast`). */
  voiceFinal?: { report: RespeakReport | null; failed: string | null };
  /** Her lips matched to her voice on the film delivered (`syncLips()`). */
  lipSync?: LipSyncPlan;
  /** Nearby places the film never showed, laid in from their own approved photos (`layPlacePhotos()`). */
  placesLaid?: { place: string; start: number; end: number }[];
  /**
   * Her lines recorded before filming and sent as @Audio1 (`voice-track.ts`),
   * null when they could not be; `refused` once the video service would not
   * film to it and the film was asked for with its own voice.
   */
  track?: (VoiceTrack & { refused?: boolean }) | null;
  spend: { drafts: number; asks: number };
};

export type FilmOutcome =
  | {
      ok: true;
      postId: string;
      plan: FilmPlan;
      /** A scheduled creative's film, handed back to be hung on the creative rather than saved as a post. */
      handed?: { media: unknown[]; pixel: PixelRecord; review: Record<string, unknown>; template: string };
    }
  | { ok: false; code: string; message: string; plan?: FilmPlan };

type Stage = (stage: string, progress: number, plan: FilmPlan) => Promise<void>;

async function jpeg(bytes: Buffer, max: number): Promise<{ bytes: Buffer; type: string }> {
  return {
    bytes: await sharp(bytes).rotate().resize(max, max, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer(),
    type: "image/jpeg",
  };
}

/**
 * The pictures that show something, read and measured (`looksBlank()`). A
 * picture that cannot be read is kept: the film reads it again and says so.
 */
async function withoutBlank<T extends { key: string }>(pictures: readonly T[]): Promise<T[]> {
  const blank = await Promise.all(
    pictures.map(async (p) => {
      const bytes = await readAsset(p.key).catch(() => null);
      if (!bytes) return false;
      const stats = await sharp(bytes).greyscale().resize(256, 256, { fit: "inside" }).stats().catch(() => null);
      return looksBlank(stats?.entropy);
    }),
  );
  return pictures.filter((_, i) => !blank[i]);
}

async function probeSeconds(path: string): Promise<number> {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(String(stdout).trim()) || 0;
}

async function frameAt(path: string, at: number): Promise<Buffer> {
  const { stdout } = await exec(
    FFMPEG,
    ["-v", "error", "-ss", Math.max(0, at).toFixed(2), "-i", path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 } as never,
  );
  return Buffer.from(stdout as unknown as Buffer);
}

/**
 * How much the picture moves, per half second: the mean difference between
 * one frame and the next, on frames 160 wide. Read off the film as it came
 * back, before our overlay, which never moves.
 */
async function motionOf(path: string): Promise<{ at: number; motion: number }[]> {
  const { stderr } = await exec(
    FFMPEG,
    ["-hide_banner", "-nostats", "-v", "info", "-i", path, "-an", "-vf",
      "scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"],
    { maxBuffer: 64 * 1024 * 1024 } as never,
  );
  const buckets = new Map<number, number[]>();
  let at: number | null = null;
  for (const line of String(stderr).split(/\r?\n/)) {
    const t = line.match(/pts_time:([\d.]+)/);
    if (t) at = Number(t[1]);
    const y = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (y && at !== null) {
      const k = Math.floor(at * 2) / 2;
      buckets.set(k, [...(buckets.get(k) ?? []), Number(y[1])]);
    }
  }
  return [...buckets.entries()].map(([k, v]) => ({ at: k, motion: v.reduce((a, b) => a + b, 0) / v.length }));
}

async function audioOf(path: string): Promise<Buffer> {
  const { stdout } = await exec(
    FFMPEG,
    ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 } as never,
  );
  return Buffer.from(stdout as unknown as Buffer);
}

/**
 * The registration over the film, the way it sits over every other video:
 * the QR, the number and the Authority's website in the upper-right quarter,
 * the contact line and the small print along the foot on a soft shade. The
 * film is scaled to the placement first, so the QR is drawn at full size and
 * scans. The cards we set ourselves (`isFactCard()`) go on under it, each
 * faded in and out over its own window.
 */
export async function stampFilm(
  raw: string,
  out: string,
  overlay: Buffer,
  W: number,
  H: number,
  dir: string,
  cards: readonly { png: Buffer; start: number; end: number }[] = [],
): Promise<void> {
  const png = join(dir, "overlay.png");
  await writeFile(png, overlay);
  const length = await probeSeconds(raw);
  const inputs: string[] = [];
  const chain: string[] = [`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1[v0]`];
  for (const [i, c] of cards.entries()) {
    const file = join(dir, `card-${i}.png`);
    await writeFile(file, c.png);
    inputs.push("-loop", "1", "-t", (length || 60).toFixed(2), "-i", file);
    const fade = Math.min(0.12, (c.end - c.start) / 4);
    chain.push(
      `[${i + 2}:v]format=rgba,fade=t=in:st=${c.start.toFixed(2)}:d=${fade.toFixed(2)}:alpha=1,` +
        `fade=t=out:st=${(c.end - fade).toFixed(2)}:d=${fade.toFixed(2)}:alpha=1[c${i}]`,
      `[v${i}][c${i}]overlay=0:0:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'[v${i + 1}]`,
    );
  }
  chain.push(`[v${cards.length}][1:v]overlay=0:0[o]`);
  await exec(FFMPEG, [
    "-v", "error", "-y", "-i", raw, "-i", png, ...inputs,
    "-filter_complex", chain.join(";"),
    "-map", "[o]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
  ]);
}

/**
 * What the eye reads on a film: the text on screen and whether the building
 * is the approved one, from the model's own frames (before our overlay, so
 * only what the model drew is read). A scene with a card is read twice, late
 * in the scene when the card is fully in, and closely; the eye spells what it
 * reads letter by letter, because asked for words it read "PODIOM" as
 * "PODIUM" on the first live film and the misspelling went unreported.
 */
export async function lookAtFilm(
  ask: AskDriver,
  raw: string,
  script: FilmScript,
  durations: readonly number[],
  approved: { bytes: Buffer; type: string }[],
  signal?: AbortSignal,
  /**
   * Scenes whose building is not judged, their text still read: a building
   * still assembling, or an ordinary place a story opens in, where the
   * office or the station is not the project and was never meant to be.
   */
  unjudged: (scene: number) => boolean = () => false,
  /** Scenes whose printed words are the picture's own (an approved map's labels), never read as text nobody asked for. */
  ownWords: (scene: number) => boolean = () => false,
): Promise<FilmFrameSeen[] | null> {
  const seconds = await probeSeconds(raw);
  const scale = seconds ? seconds / durations.reduce((a, b) => a + b, 0) : 1;
  const at = timeline(durations).flatMap((s, i) =>
    (script.scenes[i]?.text ? [0.6, 0.92] : [0.5]).map((f) => ({ t: (s.start + (s.end - s.start) * f) * scale, scene: i })),
  );
  // Never past the last frame: a grab at the very end comes back empty.
  const grabs = await Promise.all(at.map((a) => frameAt(raw, Math.max(0, Math.min(a.t, seconds - 0.25))).catch(() => Buffer.alloc(0))));
  const kept = at.filter((_, i) => grabs[i].length > 0);
  const frames = await Promise.all(
    grabs.filter((g) => g.length > 0).map(async (g) => ({ ...(await jpeg(g, 768)), detail: "high" as const })),
  );
  const seen = await ask(
    {
      model: FILM_EYE_MODEL,
      system:
        "You read the frames of a finished real-estate video, for a checker. For every frame, list each piece of text on " +
        "screen SPELLED OUT letter by letter, with a hyphen between letters and a space between words (C-E-N-T-R-A-L " +
        "P-O-D-I-U-M), exactly as the letters are drawn: correct nothing, and a word popping in part way is listed as far " +
        "as it shows. Then judge the building: 'differs' only when a building, room or pool is clearly unlike every approved " +
        "picture (a different shape, extra or missing floors or towers, a different facade or space); 'matches' when it is " +
        "plausibly one of them from another angle; 'none' when no property is in the frame. Answer in JSON.",
      parts: [
        { text: "APPROVED PICTURES:" },
        ...approved.flatMap((p, i) => [{ text: `Approved picture ${i + 1}:` }, { image: p }] as AskPart[]),
        { text: "FRAMES OF THE VIDEO, numbered from 0:" },
        ...frames.flatMap((f, i) => [{ text: `Frame ${i}:` }, { image: f }] as AskPart[]),
      ],
      schema: FILM_EYE_SCHEMA as unknown as Record<string, unknown>,
      name: "film_frames",
    },
    { signal },
  );
  if (!seen.ok) return null;
  const got = (seen.value as { frames?: { texts?: string[]; building?: FilmFrameSeen["building"] }[] }).frames ?? [];
  // Spelled back into words: "P-O-D-I-O-M" is "PODIOM".
  const word = (t: string) => t.split(/\s+/).map((w) => (/^(\S-)+\S$/.test(w) ? w.replace(/-/g, "") : w)).join(" ");
  return got.map((f, i) => ({
    ...(kept[i] ? { at: Math.max(0, Math.min(kept[i].t, seconds - 0.25)) } : {}),
    texts: kept[i] && ownWords(kept[i].scene) ? [] : (f.texts ?? []).map((t) => word(String(t))),
    // A building caught half assembled is the format, not a different building.
    building: kept[i] && unjudged(kept[i].scene) ? "none" : f.building ?? "none",
  }));
}

/** The model that judges a film's building against its own approved picture. */
export const FILM_BUILDING_MODEL = process.env.FILM_BUILDING_MODEL || "gpt-5.5";

/**
 * Every shot of the building put beside the approved picture it was made
 * from, one pair at a time, and judged by its shape before anything else: its
 * outline and top, its facade's colour and material, its balconies and its
 * window grid. The frame check asks one question of every frame at once and
 * calls a building "plausibly one of them from another angle", and it passed
 * the second Hindi test film's curved, stepped tower as the approved square
 * one with an open frame on top (8 October 2026). Returns the times of the
 * shots whose building is not the approved one; null when it could not look.
 */
/**
 * Whether each scene meant to show a nearby place shows it: the approved
 * photo of the place beside a frame of the film. The presenter may stand in
 * front of it; what matters is that the place itself, as the photo shows it,
 * is in the frame. Returns the pairs it is missing from, or null when it
 * could not look.
 */
export async function checkPlaces(
  ask: AskDriver,
  raw: string,
  shots: readonly { at: number; place: string; picture: { bytes: Buffer; type: string } }[],
  signal?: AbortSignal,
): Promise<number[] | null> {
  if (!shots.length) return [];
  const seconds = await probeSeconds(raw);
  const frames = await Promise.all(
    shots.map(async (s) => ({ ...(await jpeg(await frameAt(raw, Math.max(0, Math.min(s.at, seconds - 0.25))), 1024)), detail: "high" as const })),
  );
  const answer = await ask(
    {
      model: FILM_BUILDING_MODEL,
      effort: "low",
      system:
        "You check whether a video shows the real place it names. For each pair, the first image is the approved photo of a " +
        "place near a housing project (a station, a road, a mall, a school, an office park) and the second is a frame of the " +
        "video. Say what the frame shows, then judge: 'shown' when that same place is clearly in the frame (its building, " +
        "entrance, platform or road as in the photo), even with a person standing in front of it or from another angle; " +
        "'missing' when the frame shows somewhere else (a balcony, a room, a pool, another building or street). Answer in JSON.",
      parts: shots.flatMap((s, i) => [
        { text: `Pair ${i}: the approved photo of ${s.place}, then the video's frame.` },
        { image: { ...s.picture, detail: "high" as const } },
        { image: frames[i] },
      ] as AskPart[]),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["pairs"],
        properties: {
          pairs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["pair", "frame", "verdict"],
              properties: { pair: { type: "integer" }, frame: { type: "string" }, verdict: { type: "string", enum: ["shown", "missing"] } },
            },
          },
        },
      },
      name: "film_places",
    },
    { signal },
  );
  if (!answer.ok) return null;
  const pairs = (answer.value as { pairs?: { pair?: number; verdict?: string }[] }).pairs ?? [];
  return [...new Set(pairs.filter((p) => p.verdict === "missing" && Number.isInteger(p.pair) && shots[p.pair!]).map((p) => p.pair!))];
}

export async function checkBuildings(
  ask: AskDriver,
  raw: string,
  shots: readonly { at: number; picture: { bytes: Buffer; type: string } }[],
  signal?: AbortSignal,
): Promise<{ at: number; why: string }[] | null> {
  if (!shots.length) return [];
  const seconds = await probeSeconds(raw);
  const frames = await Promise.all(
    shots.map(async (s) => ({ ...(await jpeg(await frameAt(raw, Math.max(0, Math.min(s.at, seconds - 0.25))), 1024)), detail: "high" as const })),
  );
  const answer = await ask(
    {
      model: FILM_BUILDING_MODEL,
      effort: "low",
      system:
        "You check whether a video shows the real building it was made from. For each pair, the first image is the approved " +
        "picture of the building and the second is a frame of the video. Describe each building's outline and top (square, " +
        "curved, stepped, an open frame on the roof), its facade colour and material, its balconies and its window grid, then " +
        "judge: 'same' when it is that building, from another angle, height or light; 'different' when its shape, top, facade " +
        "or windows are not that building's (a curved tower for a square one, a glass tower for a stone one, a different crown); " +
        "'none' when the frame shows no building. Night or dusk light changes colours, not shapes. Answer in JSON.",
      parts: shots.flatMap((_, i) => [
        { text: `Pair ${i}: the approved picture, then the video's frame.` },
        { image: { ...shots[i].picture, detail: "high" as const } },
        { image: frames[i] },
      ] as AskPart[]),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["pairs"],
        properties: {
          pairs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["pair", "approved", "video", "verdict"],
              properties: {
                pair: { type: "integer" },
                approved: { type: "string" },
                video: { type: "string" },
                verdict: { type: "string", enum: ["same", "different", "none"] },
              },
            },
          },
        },
      },
      name: "film_buildings",
    },
    { signal },
  );
  if (!answer.ok) return null;
  const pairs = (answer.value as { pairs?: { pair?: number; approved?: string; video?: string; verdict?: string }[] }).pairs ?? [];
  return pairs
    .filter((p) => p.verdict === "different" && Number.isInteger(p.pair) && shots[p.pair!])
    .map((p) => ({ at: shots[p.pair!].at, why: `the approved building is ${String(p.approved ?? "").slice(0, 160)}; the video shows ${String(p.video ?? "").slice(0, 160)}` }));
}

/** The model that reads a Hindi or Marathi film's lines back into English for the checks. */
export const FILM_READER_MODEL = process.env.FILM_READER_MODEL || "gpt-5-mini";

/**
 * A Hindi or Marathi film's lines read back into English, one for each
 * scene (empty where the scene says nothing), correcting nothing: what the
 * English checks read (claims, never-say, whose story it is), the way the
 * studio reads a Hindi card back. The writer writes each line once, in the
 * film's language. Null when the reading could not be had.
 */
export async function readLinesBack(ask: AskDriver, script: FilmScript, signal?: AbortSignal): Promise<string[] | null> {
  const lines = script.scenes.map((s) => s.line);
  const answer = await ask(
    {
      model: FILM_READER_MODEL,
      effort: "low",
      system:
        "You translate the lines of a video script from Hindi or Marathi into plain English, literally, one for one. Correct " +
        "nothing, add nothing, leave nothing out, and keep every number as the digits it is written in (₹1.45 करोड़ is ₹1.45 Cr). " +
        "An empty line stays empty. Answer in JSON.",
      parts: [{ text: `THE LINES, in order:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}` }],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["lines"],
        properties: { lines: { type: "array", items: { type: "string" } } },
      },
      name: "film_lines_read",
    },
    { signal },
  );
  if (!answer.ok) return null;
  const read = (answer.value as { lines?: unknown }).lines;
  if (!Array.isArray(read) || read.length !== lines.length) return null;
  return read.map((r, i) => (lines[i] ? String(r ?? "").trim().slice(0, 300) : ""));
}

/**
 * A frame a second of the whole film, cuts and transitions included, looked
 * at for anything that is not the project or its presenter. The per-shot
 * frames above sit in the middle of each shot; the film of 30 September 2026
 * cut a sports car and another developer's house into a whip pan between two
 * of them. Small frames, since a car filling the screen needs no detail.
 */
export async function sweepFilm(
  ask: AskDriver,
  raw: string,
  approved: { bytes: Buffer; type: string }[],
  presenter: string,
  signal?: AbortSignal,
  assembles = false,
  ordinaryPlaces = false,
  builds = false,
  maps = false,
): Promise<FilmStray[] | null> {
  const seconds = await probeSeconds(raw);
  const at = Array.from({ length: Math.max(1, Math.floor(seconds)) }, (_, i) => Math.max(0, Math.min(seconds - 0.25, i + 0.5)));
  const grabs = await Promise.all(at.map((t) => frameAt(raw, t).catch(() => Buffer.alloc(0))));
  const kept = grabs.map((g, i) => ({ g, t: at[i] })).filter((x) => x.g.length > 0);
  if (!kept.length) return null;
  const frames = await Promise.all(kept.map(async (x) => ({ ...(await jpeg(x.g, 512)), detail: "low" as const })));
  const seen = await ask(
    {
      model: FILM_EYE_MODEL,
      system:
        "You check a finished real-estate video, one frame a second, for anything it must not show. It may show only the " +
        "approved project (the approved pictures, from any angle), its one presenter, and plain motion blur, sky, trees, roads " +
        "and light between shots. For each frame answer kind 'property' for a building, house, room or pool that is in none of " +
        "the approved pictures; 'vehicle' for a car or other vehicle that is in none of them; 'person' for anyone who is not the " +
        "presenter; 'other' for anything else clearly out of place; 'none' otherwise. A car parked where an approved picture " +
        "shows parked cars is 'none', and a frame too blurred to tell is 'none'. 'what' names it in a few plain words (\"a " +
        "turquoise sports car\", \"a white house with a pool\"), or \"\" for none. Answer in JSON." +
        (assembles
          ? " This film assembles the approved building on its own ground: bare earth where it will stand, its frame, floors " +
            "and facade pieces flying in and locking together, and dust and sparks while they do, are all 'none'."
          : "") +
        (maps
          ? " This film may show the project's approved location map, and real photographs of places near the project (a " +
            "station, a road, a mall, a school) among the approved pictures: the map, those places and anybody or anything " +
            "in them are 'none'."
          : "") +
        (builds
          ? " This film is a sped-up timelapse of the approved building being built on its own plot: the empty plot, lines " +
            "drawn on it, digging, foundations, columns, slabs, brick walls, scaffolding, a crane, site floodlights, the half-built " +
            "building, and the small workers, excavators, mixers and trucks doing it are all 'none'."
          : "") +
        (ordinaryPlaces
          ? " This film opens on its people in ordinary places away from the project (an office, a railway station, a street, a " +
            "car): those places, their buildings and anybody passing in them are 'none'. Only another housing tower or home " +
            "shown as if it were the project counts. Its people are a family, described below: each of them, in any shot, " +
            "alone or together, is 'none' (the second Hindi test film had its own daughter and mother called strays six times)."
          : ""),
      parts: [
        { text: `${ordinaryPlaces ? "THE PEOPLE OF THIS FILM" : "THE PRESENTER"}: ${presenter}` },
        { text: "APPROVED PICTURES:" },
        ...approved.flatMap((p, i) => [{ text: `Approved picture ${i + 1}:` }, { image: p }] as AskPart[]),
        { text: "FRAMES OF THE VIDEO, one a second, numbered from 0:" },
        ...frames.flatMap((f, i) => [{ text: `Frame ${i}:` }, { image: f }] as AskPart[]),
      ],
      schema: FILM_SWEEP_SCHEMA as unknown as Record<string, unknown>,
      name: "film_sweep",
    },
    { signal },
  );
  if (!seen.ok) return null;
  const got = (seen.value as { frames?: { frame?: number; kind?: string; what?: string }[] }).frames ?? [];
  return got
    .filter((f) => f.kind && f.kind !== "none" && Number.isInteger(f.frame) && kept[f.frame!])
    .map((f) => ({ at: kept[f.frame!].t, kind: f.kind as FilmStray["kind"], what: String(f.what ?? "").slice(0, 120) }));
}

/**
 * A person watching the finished film: one frame a second, the script and
 * what was heard, and the question a client asks, "does this make sense?".
 * The first family story (6 October 2026) passed every other check with a
 * woman's voice telling a father's story, the father opening his own front
 * door from inside to come home, the family back on the sofa after bedtime,
 * and five seconds of building with nothing happening. What it finds goes to
 * the one fix like any other finding, located, so a scene fix knows which
 * scene. Never fatal: no answer is none.
 */
export type StoryFinding = { at: number; what: string; fix: string; about: "picture" | "slow" | "rushed" | "voice"; note: string };
export async function reviewStory(
  ask: AskDriver,
  raw: string,
  script: FilmScript,
  durations: readonly number[],
  heard: string | null,
  signal?: AbortSignal,
): Promise<StoryFinding[]> {
  const seconds = await probeSeconds(raw).catch(() => 0);
  if (!seconds) return [];
  const at = Array.from({ length: Math.max(1, Math.floor(seconds)) }, (_, i) => Math.max(0, Math.min(seconds - 0.25, i + 0.5)));
  const grabs = await Promise.all(at.map((t) => frameAt(raw, t).catch(() => Buffer.alloc(0))));
  const kept = grabs.map((g, i) => ({ g, t: at[i] })).filter((x) => x.g.length > 0);
  if (!kept.length) return [];
  const frames = await Promise.all(kept.map(async (x) => ({ ...(await jpeg(x.g, 512)), detail: "low" as const })));
  let start = 0;
  const plan = script.scenes.map((s, i) => {
    const from = start;
    start += durations[i] ?? 0;
    return `Shot ${i + 1} (${from.toFixed(1)} to ${start.toFixed(1)} s, ${s.kind}): ${s.shot}${s.line ? ` Says: "${s.line}"` : ""}`;
  });
  const seen = await ask(
    {
      model: FILM_STORY_MODEL,
      system:
        "You watch a finished 30-second Indian real-estate video as the client who ordered it, one frame a second, with its " +
        "script and the words that were heard. Name only what a viewer would notice and find wrong, worst first, at most six: " +
        "the voice is not the person whose story it is (a woman's voice telling a man's story, or a line about \"him\" " +
        "beside lines said as \"I\"); an action that makes no physical sense (someone coming home opens the front door from " +
        "inside, a thing appears from nowhere, a person is in two places, a person walks through a lounger, a table, a railing " +
        "or a wall); the story jumping back in time or place, or two " +
        "shots that contradict each other; a person whose face, hair or clothes change between shots; one view held for more " +
        "than about three seconds with nothing new happening; a moment a viewer cannot follow. Never the registration block, " +
        "the price card or the footer, which are added later, never the music, and never taste a client would not raise. " +
        "\"at\" is the second it starts, \"what\" says it in a few plain words, \"fix\" says what the shot should show " +
        "instead, in a few plain words and no numbers. \"about\" is 'voice' for anything about who speaks or how, 'slow' for a " +
        "shot held too long or moving in slow motion, 'rushed' for a shot given too little time for what it shows (an action " +
        "skipped, a thing appearing from nowhere because there was no time to show it), and 'picture' for everything else. An " +
        "empty list when nothing is wrong. Answer in JSON.",
      parts: [
        { text: `THE VOICE: ${script.voice}. THE PEOPLE: ${script.presenter}` },
        { text: `THE SCRIPT, AS PLANNED:\n${plan.join("\n")}` },
        { text: heard ? `WHAT WAS HEARD: ${heard}` : "WHAT WAS HEARD: not checked." },
        { text: "FRAMES, one a second, numbered from 0 (frame n is at about n seconds):" },
        ...frames.flatMap((f, i) => [{ text: `Frame ${i}:` }, { image: f }] as AskPart[]),
      ],
      schema: FILM_STORY_SCHEMA as unknown as Record<string, unknown>,
      name: "film_story",
    },
    { signal },
  );
  if (!seen.ok) return [];
  const got = (seen.value as { problems?: { at?: number; what?: string; fix?: string; about?: string }[] }).problems ?? [];
  return got
    .filter((p) => typeof p.what === "string" && p.what.trim())
    .slice(0, MAX_STORY_PROBLEMS)
    .map((p) => {
      const f = { at: Number(p.at) || 0, what: String(p.what).slice(0, 200), fix: String(p.fix ?? "").slice(0, 200) };
      const about = (["picture", "slow", "rushed", "voice"] as const).find((a) => a === p.about) ?? "picture";
      return { ...f, about, note: storyNote(f) };
    });
}

/**
 * The approved construction photographs a film may show, newest first: dated,
 * taken inside `CONSTRUCTION_FRESH_DAYS`, and each titled with its date, so
 * the writer and the video model know what day it shows. Kept apart from the
 * backgrounds every other video uses, which leave construction out.
 */
async function constructionPictures(orgId: string, nodeId: string): Promise<{ assetId: string; sha256: string; category: string; isRender: boolean; title: string | null; key: string }[]> {
  const site = (await approvedAssets(orgId, nodeId)).filter((a) => a.category === "CONSTRUCTION" && !constructionIsStale(a.capturedOn));
  if (!site.length) return [];
  const keys = await assetKeys(orgId, site);
  return site
    .sort((a, b) => (b.capturedOn ?? "").localeCompare(a.capturedOn ?? ""))
    .flatMap((a) => {
      const key = keys.find((k) => k.asset_id === a.id && k.sha256 === a.sha256)?.storage_key;
      const day = a.capturedOn ? monthYear(a.capturedOn) : "";
      return key ? [{ assetId: a.id, sha256: a.sha256, category: "CONSTRUCTION", isRender: false, title: `${a.title || "Site progress"}${day ? `, ${day}` : ""}`, key }] : [];
    });
}

/**
 * The approved location maps a skill that shows one may film (`usesMap`),
 * shaped as a film picture. A map never sits behind copy on a post; a
 * locality guide shows it, with a pin and a line and nothing written on it.
 */
async function mapPictures(orgId: string, nodeId: string): Promise<{ assetId: string; sha256: string; category: string; isRender: boolean; title: string | null; key: string }[]> {
  const maps = (await approvedAssets(orgId, nodeId)).filter((a) => a.category === "LOCATION_MAP");
  if (!maps.length) return [];
  const keys = await assetKeys(orgId, maps);
  return maps.slice(0, 1).flatMap((a) => {
    const key = keys.find((k) => k.asset_id === a.id && k.sha256 === a.sha256)?.storage_key;
    return key ? [{ assetId: a.id, sha256: a.sha256, category: "LOCATION_MAP", isRender: false, title: "Location map", key }] : [];
  });
}

/**
 * The approved photos of places near the project (NEARBY_PLACE), each titled
 * with its place, shaped as film pictures. A location film shows a nearby
 * place only on one of these. Pictures only: a clip is not a reference.
 */
/** The most nearby places' photos a location film is given: the places a film may name, the locality aside. */
const NEARBY_PHOTOS = 5;

async function nearbyPictures(orgId: string, nodeId: string): Promise<{ assetId: string; sha256: string; category: string; isRender: boolean; title: string | null; key: string }[]> {
  const shots = (await approvedAssets(orgId, nodeId)).filter((a) => a.category === "NEARBY_PLACE" && a.mediaType.startsWith("image/") && a.title?.trim());
  if (!shots.length) return [];
  const keys = await assetKeys(orgId, shots);
  return shots.flatMap((a) => {
    const key = keys.find((k) => k.asset_id === a.id && k.sha256 === a.sha256)?.storage_key;
    return key ? [{ assetId: a.id, sha256: a.sha256, category: "NEARBY_PLACE", isRender: false, title: a.title!.trim(), key }] : [];
  });
}

/**
 * The signed places near the project a location film can say: every signed
 * nearby place, and every selling point about how the project connects, that
 * reads as a place with its own time or distance (`readNearby()`), one per
 * place.
 */
function areaPlaces(ground: { nearby?: string[] }, points: readonly string[]): NearbyPlace[] {
  const all = nearbyPlaces([...(ground.nearby ?? []), ...points.filter((p) => sellingKind(p) === 0)]);
  return all.filter((n, i) => !all.slice(0, i).some((m) => samePlace(m.place, n.place)));
}

/**
 * Each scene's length as the film really cut it, when it cut as many times as
 * the script has shots; the plan stretched to the film's length otherwise.
 * The checks look at a scene where it really is: by the plan, a frame meant
 * for the tower landed on the map after it, and its labels were read as text
 * nobody asked for (13 October 2026).
 */
async function sceneLengths(raw: string, planned: readonly number[]): Promise<number[]> {
  const film = await probe(raw).catch(() => null);
  if (!film) return [...planned];
  const cut = scenesFromCuts(await cutsOf(raw).catch(() => []), film.seconds, film.fps);
  if (cut.length === planned.length) return cut.map((c) => c.end - c.start);
  const total = planned.reduce((a, b) => a + b, 0) || film.seconds;
  return planned.map((d) => (d * film.seconds) / total);
}

/** The model that reads a location map and groups the building's pictures before a film is paid for. */
export const FILM_INPUT_MODEL = process.env.FILM_INPUT_MODEL || "gpt-5.5";

/**
 * What the approved location map prints, read before a film is paid for:
 * its heading, every place with a time or distance beside it, and where the
 * project's pin is. Tesseract read the first map's "8 min" as "5 min", so a
 * model reads it and code compares. Null when it could not look.
 */
export async function readMap(ask: AskDriver, map: Buffer, project: string, signal?: AbortSignal): Promise<MapRead | null> {
  const answer = await ask(
    {
      model: FILM_INPUT_MODEL,
      effort: "low",
      system:
        "You read a real-estate location map exactly as it is printed, correcting nothing. 'area' is the locality the map is " +
        "headed with or names as the project's area, as printed (\"Goregaon East, Mumbai\"), or \"\" when it names none. " +
        "'labels' lists every place the map marks (a station, a road, a mall, a school, a hospital, an office park), with the " +
        "travel time or distance printed beside it and its unit as printed (min for minutes, km, m for metres), or null and " +
        "\"none\" when it prints none; leave out street names and areas. For each, 'x' and 'y' are where the place itself is " +
        "on the map (its dot, pin or icon, else the middle of its label), as fractions of the map's width and height from the " +
        "top left, measured carefully; 0 and 0 when you cannot tell. 'pin_found' is true when the map marks the project itself " +
        "(its pin or a label with its name), and 'pin_x' and 'pin_y' are where that mark points, the same way; 0 and 0 when " +
        "there is none. Answer in JSON.",
      parts: [{ text: `THE PROJECT: ${project}` }, { image: { ...(await jpeg(map, 2048)), detail: "high" } }],
      schema: MAP_READ_SCHEMA as unknown as Record<string, unknown>,
      name: "film_map_read",
    },
    { signal },
  );
  return answer.ok ? readMapAnswer(answer.value) : null;
}

/**
 * The building's approved pictures grouped by the building each shows, so a
 * film is made from one building. Tower C's library held four renders of
 * different towers, and its location film changed tower from shot to shot
 * (12 October 2026). Null when it could not look.
 */
export async function groupBuildings(ask: AskDriver, shots: readonly Buffer[], signal?: AbortSignal): Promise<unknown> {
  const answer = await ask(
    {
      model: FILM_INPUT_MODEL,
      effort: "low",
      system:
        "You sort a developer's approved pictures of its building by which building each one shows. For each picture, describe " +
        "the building in 'looks' (its outline and top, facade colour and material, balconies and window grid), then give it a " +
        "'building' number: the same number for pictures of the same building from any angle, height or light, a new number " +
        "for a different building. Day, dusk and night change colours, never shapes. Answer in JSON.",
      parts: (
        await Promise.all(shots.map(async (b, i) => [{ text: `Picture ${i}:` }, { image: { ...(await jpeg(b, 1024)), detail: "high" as const } }]))
      ).flat() as AskPart[],
      schema: BUILDINGS_SCHEMA as unknown as Record<string, unknown>,
      name: "film_buildings_group",
    },
    { signal },
  );
  return answer.ok ? answer.value : null;
}

/**
 * Why each video template's film cannot be made for this node today, by
 * template key, from the same pictures and facts `makeFilm()` asks: the
 * studio greys the template with the reason, instead of offering a film the
 * worker would refuse twenty seconds after the press.
 */
export async function filmGaps(orgId: string, node: { id: string; path: string; kind: string }, keys: readonly string[]): Promise<Record<string, string>> {
  const skills = keys.map((k) => skillFor(k)).filter((s): s is NonNullable<typeof s> => !!s && !!s.needs);
  if (!skills.length) return {};
  const [{ ground }, m] = await Promise.all([studioGround(orgId, node), loadMaterials(orgId, node)]);
  const anySite = skills.some((s) => s.needs!.categories.includes("CONSTRUCTION"));
  const site = anySite ? await constructionPictures(orgId, node.id) : [];
  const maps = skills.some((s) => s.usesMap) ? await mapPictures(orgId, node.id) : [];
  const points = sellingPoints(ground.talkingPoints, { luxury: isLuxury(ground.configurations) });
  const facts = {
    points: points.length,
    connectivity: points.filter((p) => sellingKind(p) === 0).length,
    offers: ground.talkingPoints.filter((p) => pointAngle(p) === "OFFER").length,
    configurations: ground.configurations.filter((c) => c.startingPrice !== null).length,
    area: areaPlaces(ground, points).length,
  };
  const out: Record<string, string> = {};
  for (const skill of skills) {
    const siteOnly = skill.needs!.categories.length === 1 && skill.needs!.categories[0] === "CONSTRUCTION";
    const pictures = filmPictures(siteOnly ? site : [...site, ...(skill.usesMap ? maps : []), ...m.backgrounds], []);
    const refused = skillRefusal(skill, pictures, facts);
    if (refused) out[skill.key] = refused;
  }
  return out;
}

export async function makeFilm(input: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  copyId: string;
  placement: string;
  /**
   * `copyId` names a scheduled run's creative (`post_creatives`) rather than
   * a studio card, and the finished film is handed back to be hung on it,
   * not saved as a post: a schedule's video is a Seedance film too since 5
   * October 2026.
   */
  creative?: boolean;
  font?: string | null;
  /** What the job carries: its units and any revision, and whatever an earlier attempt kept. */
  plan?: Partial<FilmPlan> | null;
  drivers?: Partial<FilmDrivers>;
  signal?: AbortSignal;
  onStage?: Stage;
}): Promise<FilmOutcome> {
  const d: FilmDrivers = { ...DEFAULTS, ...input.drivers };
  // The template's own skill: its length, shots, speech, moves and prompt.
  // A job queued before templates had their own is Agent on camera.
  let skill = skillFor(input.plan?.template) ?? AGENT_DESCRIBING_SKILL;
  /**
   * A presenter's film (Agent on camera) made the story's
   * way (`AGENT_LIKE_STORY=on`): directed, fixed scene by scene, its voice
   * fixed last. Off, it is made as before. Every other template goes this way
   * always (10 October 2026).
   */
  const agentLikeStory = skill.speech === "presenter" && process.env.AGENT_LIKE_STORY === "on";
  const revise = input.plan?.revise ?? null;
  const plan: FilmPlan = {
    engine: "film",
    template: skill.key,
    units: revise ? FILM_UNITS.revision : FILM_UNITS.first,
    revise,
    ...(input.plan?.script ? { script: input.plan.script } : {}),
    ...(input.plan?.film ? { film: input.plan.film } : {}),
    ...(input.plan?.scratch ? { scratch: input.plan.scratch } : {}),
    ...(input.plan?.respeak ? { respeak: input.plan.respeak } : {}),
    ...(input.plan?.fix ? { fix: input.plan.fix } : {}),
    spend: { drafts: 0, asks: 0, ...input.plan?.spend },
  };
  const face = fontFor(input.font ?? input.plan?.font ?? null);
  if (face) plan.font = face.key;
  let furthest = 0;
  const stage = (name: string, progress: number) => {
    furthest = Math.max(furthest, progress);
    return (input.onStage ?? (async () => {}))(name, furthest, plan);
  };
  const size = PLACEMENT_SIZE[input.placement];
  if (!size) return { ok: false, code: "NO_PLACEMENT", message: "That is not a video size." };
  if (!isNodeId(input.briefId) || !isNodeId(input.copyId)) return { ok: false, code: "UNKNOWN", message: "That card is not in this campaign." };
  const W = size.w;
  const H = size.h;
  const wide = W > H;

  // ---- what may be said, and what may be shown -----------------------------
  const head = await withTenant(input.orgId, async (sql) => {
    const [row] = await sql<{ node_id: string; path: string; kind: string; name: string }[]>`
      SELECT n.id AS node_id, n.path::text AS path, n.kind, n.name
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${input.orgId} AND b.id = ${input.briefId}`;
    const [card] = input.creative
      ? await sql<{ id: string; language: string; segment: string; headline: string; body: string; cta: string }[]>`
          SELECT c.id, c.language, c.segment, c.headline, c.body, c.cta FROM post_creatives c
          JOIN post_runs r ON r.id = c.run_id JOIN post_schedules s ON s.id = r.schedule_id
          WHERE c.org_id = ${input.orgId} AND c.id = ${input.copyId} AND s.brief_id = ${input.briefId} AND c.verdict <> 'FAIL'`
      : await sql<{ id: string; language: string; segment: string; headline: string; body: string; cta: string }[]>`
          SELECT id, language, segment, headline, body, cta FROM campaign_copy
          WHERE org_id = ${input.orgId} AND brief_id = ${input.briefId} AND id = ${input.copyId} AND verdict = 'PASS'`;
    return row && card ? { ...row, card } : null;
  });
  if (!head) return { ok: false, code: "NOT_CLEARED", message: "That card is no longer cleared." };
  const node = { id: head.node_id, path: head.path, kind: head.kind };
  const { ground } = await studioGround(input.orgId, node);
  if (!ground.advertisable) return { ok: false, code: "NOT_ADVERTISABLE", message: "This cannot be advertised today, so no video can be made." };
  if (!ground.location) return { ok: false, code: "NO_LOCATION", message: NO_LOCATION_MESSAGE };
  const m = await loadMaterials(input.orgId, node);
  if (!m.backgrounds.length) return { ok: false, code: "NO_PICTURE", message: "There is no approved picture of the property to build a video from." };
  // Refused before a film is paid for, the rule posts follow: a registered
  // tower's film carries what its state asks on every frame (the QR where it
  // asks for one, Telangana's permit number), and without it the film would
  // go out short of it. An exempt tower carries none of it.
  const gap = registrationGap(m);
  if (gap) return { ok: false, ...gap };
  // A construction film is made only from dated photographs still fresh: a
  // render filmed as "progress" is a promise, not an update.
  const site = skill.needs?.categories.includes("CONSTRUCTION") ? await constructionPictures(input.orgId, node.id) : [];
  // A format that films only the site (a construction update) shows no render beside it.
  const siteOnly = skill.needs?.categories.length === 1 && skill.needs.categories[0] === "CONSTRUCTION";
  // A new version keeps the pictures its film was made from.
  const keepAssets = revise
    ? await withTenant(input.orgId, async (sql) => {
        const [r] = await sql<{ ids: string[] | null }[]>`
          SELECT ARRAY(SELECT p->>'assetId' FROM jsonb_array_elements(COALESCE(inputs->'film'->'pictures', '[]'::jsonb)) p) AS ids
          FROM rendered_posts WHERE org_id = ${input.orgId} AND id = ${revise.postId} AND brief_id = ${input.briefId}`;
        return r?.ids ?? [];
      })
    : [];
  // The rooms of the sample flat are always offered (`filmPictures()`). A
  // picture that shows nothing (a flat colour, a placeholder) is never
  // offered: handed one as "the building", the model invents a building.
  const maps = skill.usesMap && !siteOnly ? await mapPictures(input.orgId, node.id) : [];
  // A location film shows a nearby place only on its own approved photo, one
  // per signed place, placed after the building's (13 October 2026), in the
  // order the facts list the places, up to the six a film may name. It took
  // the first four the library listed until 18 October 2026: a fifth photo
  // (Mindspace) pushed Goregaon station out, and the station was said on
  // the balcony.
  const places = skill.areaLines ? areaPlaces(ground, sellingPoints(ground.talkingPoints, { luxury: isLuxury(ground.configurations) })) : [];
  const placeRank = (title: string | null) => places.findIndex((n) => samePlace(n.place, title ?? ""));
  const localPhotos = (skill.usesMap || skill.areaLines) && !siteOnly
    ? (await nearbyPictures(input.orgId, node.id))
        .filter((p, i, all) => placeRank(p.title) >= 0 && all.findIndex((q) => samePlace(q.title ?? "", p.title ?? "")) === i)
        .sort((a, b) => placeRank(a.title) - placeRank(b.title))
        .slice(0, NEARBY_PHOTOS)
    : [];
  // Before the backgrounds: placed after them, ten pictures of the building
  // and its rooms filled the writer's list and no photo of a place reached it.
  let pictures = filmPictures(await withoutBlank(siteOnly ? site : [...site, ...maps, ...localPhotos, ...m.backgrounds]), keepAssets);
  const points = sellingPoints(ground.talkingPoints, { luxury: isLuxury(ground.configurations) });
  const pictureFacts = {
    points: points.length,
    connectivity: points.filter((p) => sellingKind(p) === 0).length,
    offers: ground.talkingPoints.filter((p) => pointAngle(p) === "OFFER").length,
    configurations: ground.configurations.filter((c) => c.startingPrice !== null).length,
    area: places.length,
  };
  const refused = skillRefusal(skill, pictures, pictureFacts);
  if (refused) return { ok: false, code: "SKILL_NEEDS", message: refused };
  // What the map prints is held to the signed facts before anything is paid
  // for: it goes on the film exactly as approved (`layMapShots()`), so a
  // time on it nobody signed is a claim nobody signed. A suite that injects
  // a brain asks neither read.
  let mapPin: { x: number; y: number } | null = null;
  let mapRead: MapRead | null = null;
  let mapAt = pictures.findIndex((p) => p.category === "LOCATION_MAP");
  if (mapAt >= 0 && !input.drivers?.ask) {
    const bytes = await readAsset(pictures[mapAt].key);
    plan.spend.asks++;
    const read = bytes ? await readMap(d.ask, bytes, head.name, input.signal).catch(() => null) : null;
    if (read) {
      const wrong = mapProblems(read, places, ground.location);
      if (wrong.length) return { ok: false, code: "MAP_MISMATCH", message: wrong.join(" ") };
      mapPin = read.pin;
      mapRead = read;
    }
  }
  // One building: pictures of another tower are left out, and a film with
  // too few of this one left is refused before it is paid for. Never on a
  // new version, which keeps its own pictures.
  const exteriors = pictures.flatMap((p, i) => (p.category === "EXTERIOR_RENDER" ? [i] : []));
  if (exteriors.length >= 2 && !revise && !input.drivers?.ask) {
    const bytes = await Promise.all(exteriors.map((i) => readAsset(pictures[i].key)));
    if (bytes.every((b): b is Buffer => !!b)) {
      plan.spend.asks++;
      const grouped = oneBuilding(exteriors.length, await groupBuildings(d.ask, bytes, input.signal).catch(() => null));
      if (grouped.dropped.length) {
        const drop = new Set(grouped.dropped.map((k) => pictures[exteriors[k]].assetId));
        console.log(`film: left out ${drop.size} picture(s) of another building: ${grouped.dropped.map((k) => pictures[exteriors[k]].title).join(", ")}`);
        pictures = pictures.filter((p) => !drop.has(p.assetId));
        if (skillRefusal(skill, pictures, pictureFacts)) {
          return { ok: false, code: "SKILL_NEEDS", message: oneBuildingWhy(grouped.keep.length, skill.needs?.count ?? 2) };
        }
      }
    }
  }
  mapAt = pictures.findIndex((p) => p.category === "LOCATION_MAP");
  const area = places.map((n) => n.line);
  const card = head.card;
  // The film speaks the card's language: a Hindi card makes a Hindi film
  // (pure Hindi for the narrated story, Hinglish for the rest), a Marathi
  // card a Marathi one (`film-language-rules.ts`, the client, 7 October 2026).
  const lang = filmLanguage(card.language, skill.key);
  // A Hindi or Marathi story is told the way those films are: a few short lines like verse, never a plot in dialogue.
  skill = storyIn(skill, lang);
  if (lang.code !== "en") skill = { ...skill, voice: voiceIn(skill.voice, lang), never: neverIn(skill.never, lang) };
  // A Hindi or Marathi film is written, and read back, by Sarvam's own model,
  // so its lines read the way people in Mumbai and Pune say them (the client,
  // 8 October 2026). `FILM_LOCAL_WRITER=openai` puts the usual writer back;
  // a suite that injects a brain keeps it.
  const sarvamWrites = lang.code !== "en" && process.env.FILM_LOCAL_WRITER !== "openai" && !input.drivers?.ask;
  const writerAsk: AskDriver = sarvamWrites ? askSarvam : d.ask;
  const writerModel = sarvamWrites ? SARVAM_CHAT_MODEL : FILM_WRITER_MODEL;
  // A Hindi or Marathi story's narration is recorded on its own, in the voice
  // the client chose, and the film is made with no voice (8 October 2026).
  // `LOCAL_VOICEOVER=off` lets the video model speak it again.
  // An English story is narrated the same way since 9 October 2026: said by
  // the video model, its narration came back "Goremad West" and "two point
  // one nine krong".
  // Every narrated template since 10 October 2026 (the launch film, the
  // construction update): the video model's own narrator mispronounced the
  // place and the unit the way the story's did.
  const narratedLater =
    skill.speech === "voiceover" && process.env.LOCAL_VOICEOVER !== "off" && (lang.code !== "en" || process.env.EN_VOICEOVER !== "off");
  const facts = [
    ...sellingPoints(ground.talkingPoints, { luxury: isLuxury(ground.configurations) }),
    // The places near the project, said only by a film about the area.
    ...(skill.areaLines ? (ground.nearby ?? []).map((n) => `Nearby: ${n}`) : []),
    ...ground.configurations.filter((c) => c.startingPrice !== null).map((c) => `${c.label} starting ${adPrice(c.startingPrice!)}`),
    // A date as an advertisement says it, so the writer does not read out 2030-09-30.
    ...(ground.possessionDate ? [`Possession: ${monthYear(ground.possessionDate)}`] : []),
    // A construction film says what day its photographs show, and only that.
    ...site.map((p) => `Construction photo: ${p.title}`),
  ];
  // What the writer is handed: only what this format says, selling points in
  // the order our ads and the market say work (`filmFacts()`). The gate
  // still clears against every signed fact.
  const learnt = await learningFor(input.orgId, node.id).catch(() => null);
  const ordered = orderByLearning(sellingPoints(ground.talkingPoints, { luxury: isLuxury(ground.configurations) }), learnt?.scores ?? []);
  const given = filmFacts(skill, {
    points: ordered,
    prices: [...ground.configurations]
      .filter((c) => c.startingPrice !== null)
      .sort((a, b) => a.startingPrice! - b.startingPrice!)
      .map((c) => `${c.label} starting ${adPrice(c.startingPrice!)}`),
    possession: ground.possessionDate ? `Possession: ${monthYear(ground.possessionDate)}` : null,
    construction: site.map((p) => `Construction photo: ${p.title}`),
    // Each place with the card we will set for it, exactly as signed, and
    // where it is filmed: on its own photo when there is one, else the map.
    nearby: places.map((n) => {
      const photo = pictures.findIndex((p) => p.category === "NEARBY_PLACE" && samePlace(n.place, p.title ?? ""));
      return `${nearbyBrief(n)}${photo >= 0 ? `; film its scene on picture ${photo}, its own photo` : skill.usesMap ? "; no photo: film its scene on the map" : ""}`;
    }),
  });
  // The project's name may go on a card (we set that card ourselves).
  const cleared = [card.headline, card.body, card.cta, ground.location, head.name, ...facts];
  const titles = pictures.map((p) => p.title ?? "").filter(Boolean);
  const placePhotos = places.flatMap((n) => {
    const picture = pictures.findIndex((p) => p.category === "NEARBY_PLACE" && samePlace(n.place, p.title ?? ""));
    return picture >= 0 ? [{ place: n.place, picture }] : [];
  });
  const gateCtx = { skill, cleared, neverSay: ground.neverSay, pictures: pictures.length, titles, categories: pictures.map((p) => p.category), area, language: lang, placePhotos };
  // A Hindi or Marathi film's lines are read back into English first, and the
  // English checks read that; its own checks read the Devanagari.
  const checkScript = async (sc: FilmScript): Promise<string[]> => {
    if (lang.code === "en" || !sc.scenes.some((x) => x.line)) return filmProblems(sc, gateCtx);
    plan.spend.asks++;
    const reading = await readLinesBack(writerAsk, sc, input.signal);
    if (!reading) return ["The lines could not be read back to be checked. Write them again, plainly."];
    return filmProblems(sc, { ...gateCtx, reading });
  };

  // ---- a new version: the earlier film, its script, and what was wrong ------
  let previous: { raw: Buffer; problems: string[]; postId: string } | null = null;
  if (revise) {
    const prev = await withTenant(input.orgId, async (sql) => {
      const [r] = await sql<{ inputs: { film?: { script?: FilmScript; raw?: string | null; pictures?: { assetId: string }[] } }; review: { problems?: { text: string }[]; notes?: string[] } | null }[]>`
        SELECT inputs, review FROM rendered_posts
        WHERE org_id = ${input.orgId} AND id = ${revise.postId} AND brief_id = ${input.briefId} AND inputs ? 'film'`;
      return r ?? null;
    });
    const film = prev?.inputs.film;
    if (!prev || !film?.script || !film.raw) return { ok: false, code: "NO_FILM", message: "That video can no longer be made again. Make a new one instead." };
    // The same pictures, by asset, each still approved; the script re-read
    // against today's facts, which may have moved since.
    const byAsset = (film.pictures ?? []).map((p) => pictures.findIndex((q) => q.assetId === p.assetId));
    if (byAsset.some((i) => i < 0)) return { ok: false, code: "PICTURE_GONE", message: "A picture this video used is no longer approved. Make a new video instead." };
    const oldRefs = picturesUsed(film.script);
    const script: FilmScript = { ...film.script, scenes: film.script.scenes.map((s) => ({ ...s, picture: s.picture < 0 ? s.picture : byAsset[oldRefs.indexOf(s.picture)] })) };
    if ((await checkScript(script)).length) {
      return { ok: false, code: "FACTS_CHANGED", message: "The approved facts have changed since this video was made. Make a new video instead." };
    }
    const raw = await readAsset(film.raw);
    if (!raw) return { ok: false, code: "NO_FILM", message: "That video can no longer be made again. Make a new one instead." };
    plan.script = script;
    previous = {
      raw,
      postId: revise.postId,
      problems: [...(prev.review?.problems ?? []).map((p) => p.text), ...(prev.review?.notes ?? [])],
    };
  }

  const dir = plan.scratch && existsSync(plan.scratch) ? plan.scratch : await mkdtemp(join(tmpdir(), "salesdesk-film-"));
  plan.scratch = dir;
  let keep = true;

  try {
    // ---- the scenes, written and checked before anything is filmed ----------
    const thumbs = await Promise.all(
      pictures.map(async (p) => {
        const bytes = await readAsset(p.key);
        if (!bytes) throw new Error("PICTURE_UNREADABLE");
        return bytes;
      }),
    );
    // A presenter's lines are recorded in one fixed voice before anything is
    // filmed, every line heard right, and the film is made to that recording
    // (`voice-track.ts`, 19 October 2026). Recorded with each draft that
    // passes, so a script too long as really said goes back to the writer
    // with the seconds and words to cut, and the last line always fits.
    const trackOn =
      usesTrack({ speech: skill.speech, language: lang.code, revision: !!revise, injected: !!input.drivers }) && (FILM_PROVIDER === "openrouter" || !!plan.film?.job);
    const takeCache = new Map<string, Take>();
    const record = (sc: FilmScript, fastest?: number) =>
      recordTrack({ scenes: sc.scenes, seconds: skill.seconds, silent: skill.shotSeconds, male: sc.voice === "male", dir, signal: input.signal, fastest, cache: takeCache });
    if (!plan.script) {
      await stage("Writing the script", 5);
      const brief = writerInstruction(skill, {
        project: head.name,
        locality: ground.location,
        headline: card.headline,
        body: card.body,
        cta: card.cta,
        facts: given,
        neverSay: ground.neverSay,
        pictures: pictures.map((p) => ({ category: p.category, title: p.title })),
        wide,
        language: lang,
      });
      const images: AskPart[] = (
        await Promise.all(thumbs.map(async (b, i) => [{ text: `Picture ${i}:` }, { image: await jpeg(b, 512) }] as AskPart[]))
      ).flat();
      let fixes: string[] = [];
      // The draft sent back goes back with its fixes, to be edited rather
      // than written afresh: shown only the list, the writer wrote a new
      // script each time with new mistakes in it, and three Hindi drafts in a
      // row came back over the word count by different lines (7 October 2026).
      let lastDraft: FilmScript | null = null;
      for (let draft = 0; draft < (sarvamWrites ? MAX_SARVAM_DRAFTS : MAX_FILM_DRAFTS) && !plan.script; draft++) {
        if (input.signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", plan };
        plan.spend.drafts++;
        const answer = await writerAsk(
          {
            model: writerModel,
            system: brief.system,
            parts: [
              {
                text:
                  brief.text +
                  (fixes.length
                    ? `\n\nYOUR LAST DRAFT WAS SENT BACK. Fix exactly this:\n${fixes.map((f) => `- ${f}`).join("\n")}` +
                      (lastDraft
                        ? `\n\nHERE IS THAT DRAFT. Edit it: change only what the fixes ask for and keep everything else as it is.\n${JSON.stringify(lastDraft)}`
                        : "")
                    : ""),
              },
              ...images,
            ],
            schema: FILM_SCRIPT_SCHEMA as unknown as Record<string, unknown>,
            name: "film_script",
            // Sarvam writes its first draft straight off, and thinks over one sent back.
            ...(sarvamWrites && fixes.length ? { effort: "low" as const } : {}),
            timeoutMs: sarvamWrites && fixes.length ? 480_000 : 240_000,
          },
          { signal: input.signal },
        );
        if (!answer.ok) {
          if (isServiceDown(answer.code)) return { ok: false, code: answer.code, message: answer.message, plan };
          console.log(`film: draft ${draft + 1} not answered: ${answer.code} ${answer.message.slice(0, 300)}`);
          fixes = ["Answer in the agreed JSON shape."];
          continue;
        }
        const read = parseFilmScript(answer.value);
        // A word the video's voice mistakes for an English one is swapped for one it says right.
        const parsed = read && lang.code !== "en" ? { ...read, scenes: read.scenes.map((x) => ({ ...x, line: x.line ? localTidy(x.line) : x.line, text: x.text ? localCard(x.text) : x.text })) } : read;
        const tidied = parsed ? tidyScript(parsed, skill) : null;
        // A card for a nearby place is that place's own card, as signed.
        // A place's name is said whole, as signed: "Mindspace. Malad" was said as two things.
        const script =
          tidied && skill.ourCards && places.length
            ? { ...tidied, scenes: withNearbyCards(tidied.scenes, places).map((x) => (x.line ? { ...x, line: joinPlaceNames(x.line, places) } : x)) }
            : tidied;
        if (!script) console.log(`film: draft ${draft + 1} was not a script: ${JSON.stringify(answer.value).slice(0, 400)}`);
        const problems = script ? await checkScript(script) : ["Answer in the agreed JSON shape."];
        await stage("Checking the script", 8 + draft * 2);
        if (script && !problems.length && trackOn) {
          await stage("Recording her voice", 9 + draft * 2);
          const last = draft === (sarvamWrites ? MAX_SARVAM_DRAFTS : MAX_FILM_DRAFTS) - 1;
          const rec = await record(script, last ? TRACK.lastFastest : undefined);
          if (input.signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", plan };
          // Too long as said goes back to the writer; on the last draft the
          // film keeps its own voice rather than nothing being filmed, as
          // does a voice that could not be made.
          if (rec && !rec.ok && !last) problems.push(rec.long);
          else plan.track = rec?.ok ? rec.track : null;
        }
        if (script && !problems.length) plan.script = script;
        else {
          fixes = problems;
          lastDraft = script;
          // Every refused draft and why, in the worker's log: the card shows only the last reason.
          console.log(`film: draft ${draft + 1} refused: ${problems.join(" | ")}`);
          // And on the job, so a refusal can be read back afterwards: each
          // scene's line, card and picture, and the reasons (21 October 2026).
          if (script) {
            plan.refusedDrafts = [
              ...(plan.refusedDrafts ?? []),
              { draft: draft + 1, problems: problems.slice(0, 12), scenes: script.scenes.map((sc) => ({ line: sc.line, text: sc.text, picture: sc.picture, kind: sc.kind })) },
            ].slice(-5);
          }
        }
      }
      if (!plan.script) {
        return {
          ok: false,
          code: "SCRIPT_REFUSED",
          message: `The script could not be kept to the approved facts, so nothing was filmed. ${fixes[0] ?? ""}`.trim(),
          plan,
        };
      }
      await stage("Script ready", 12);
    }
    const script = plan.script;
    const plannedDurations = planTiming(script.scenes, skill.seconds, skill.wordsPerSecond, skill.shotSeconds);
    if (!plannedDurations) return { ok: false, code: "SCRIPT_REFUSED", message: `The script does not fit in ${skill.seconds} seconds.`, plan };
    let durations: number[] = plannedDurations;
    // A presenter's lines are recorded first, in one fixed voice, every line
    // heard right, and the film is made to that recording (`voice-track.ts`,
    // 19 October 2026). The scenes are timed from it, so the last line fits.
    // A script kept from before (a worker that died) is recorded here, never sent back.
    if (trackOn && (plan.track === undefined || (plan.track && !plan.track.refused && !existsSync(plan.track.file) && !plan.film?.job))) {
      await stage("Recording her voice", 13);
      const rec = await record(script, TRACK.lastFastest);
      if (input.signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", plan };
      plan.track = rec?.ok ? rec.track : null;
    }
    let track = trackOn && plan.track && !plan.track.refused && existsSync(plan.track.file) ? plan.track : null;
    if (track) durations = track.timing.durations;
    plan.durations = durations;
    const refs = picturesUsed(script);
    // Style first, as in the prompt that made the near-perfect film: the
    // template's own frames if it has any (Agent on camera no longer does,
    // see `VideoSkill.styleFrames`), then a card showing the big text's look
    // in this film's own first words, then the real project. A person's
    // chosen typeface is not passed on: the format's text style is part of
    // the skill, and "a face like Cormorant Garamond" beside "a heavy
    // sans-serif" gave the app's first film thin, uncertain text.
    const styles = (
      await Promise.all(skill.styleFrames.map((f) => readFile(join(process.cwd(), f)).then((b) => jpeg(b, 1280)).catch(() => null)))
    ).filter((x): x is { bytes: Buffer; type: string } => !!x);
    // The model's own first card: a price card is ours, and shown to the
    // model as the look to copy it would invite the model to draw it.
    const firstCard = script.scenes.find((s) => s.text && !ourCard(skill, s.text, [head.name]))?.text ?? "";
    const textCard = firstCard ? { bytes: await textStyleCard(cardParts(firstCard), thumbs[refs[0]], wide ? 1280 : 720, wide ? 720 : 1280, skill.cardAccent), type: "image/jpeg" } : null;
    // A story is directed before it is filmed (`film-direction.ts`): every
    // shot given its blocking, one action, a lens and a move, every place a
    // fixed layout, and the prompt built in the sections Seedance 2.5's
    // prompting guide sets out (9 October 2026). Every other format, a
    // revision, and a suite with an injected brain keep the prompt as it was.
    // Agent on camera goes the story's way too behind `AGENT_LIKE_STORY=on`
    // (the client, 10 October 2026, a trial): directed, its scenes fixed one
    // at a time, its voice fixed last. Its own prompt stays, with the
    // director's framing, blocking and layouts added to it.
    // Since 10 October 2026 every template is directed (the client: the same
    // pipeline for every video), a presenter's only behind `AGENT_LIKE_STORY`.
    // The story keeps its sectioned prompt; every other template keeps its own
    // skill's prompt with the director's framing, blocking and layouts added.
    const directs = (skill.speech !== "presenter" || agentLikeStory) && !revise && !input.drivers?.ask && process.env.FILM_DIRECTED !== "off";
    if (directs && !plan.direction) {
      await stage("Directing the shots", 13);
      plan.spend.asks++;
      const directed = await directFilm(
        askJson,
        script,
        pictures.map((p) => ({ category: p.category, title: p.title })),
        input.signal,
        skill.speech === "presenter" ? "presenter" : skill.key === "story" ? "story" : "property",
      );
      if (directed) plan.direction = directed.direction;
    }
    const lead = styles.length + (textCard ? 1 : 0);
    const locality: string = ground.location ?? "";
    const promptFor = (durations: number[], voiceTrack: boolean) =>
      directs && plan.direction && skill.key === "story"
        ? buildStoryPrompt({
            direction: plan.direction,
            seconds: skill.seconds,
            wide,
            times: timeline(durations),
            refTag: (i) => (refs.includes(i) ? `@Image${lead + refs.indexOf(i) + 1}` : null),
            lines: script.scenes.map((sc) => ({
              text: !sc.line ? "" : lang.code !== "en" && isDevanagari(sc.line) ? spokenFormIn(sc.line, lang.code) : spokenForm(sc.line),
              delivery: sc.delivery ?? "",
            })),
            cards: script.scenes.map((sc) => (sc.text && !ourCard(skill, sc.text, [head.name]) ? cardParts(sc.text).map((t) => t.toUpperCase()).join(" over ") : null)),
            ourCard: script.scenes.map((sc) => ourCard(skill, sc.text, [head.name])),
            voice: { male: script.voice !== "female", language: lang.code === "en" ? "clear Indian English" : `natural spoken ${lang.name}` },
            project: head.name,
            locality: spokenPlace(locality),
          })
        : filmPrompt({
            skill,
            script,
            durations,
            pictures: pictures.map((p) => ({ category: p.category, title: p.title })),
            wide,
            project: head.name,
            locality,
            styleFrames: styles.length,
            textCard: !!textCard,
            language: lang,
            // The film still says the lines, as a guide track: asked for no voice,
            // the second test film followed none of its story (8 October 2026).
            revision: revise ? { note: revise.note, problems: previous?.problems ?? [] } : null,
            direction: directs ? plan.direction ?? null : null,
            voiceTrack,
          });
    plan.prompt = promptFor(durations, !!track);

    // ---- one film ------------------------------------------------------------
    const filmImages = [...styles, ...(textCard ? [textCard] : []), ...(await Promise.all(refs.map((i) => jpeg(thumbs[i], 1600))))];
    const raw = join(dir, "film-raw.mp4");
    // A film the service refused or lost is asked for again here, at once and
    // inside `MAX_FILM_REQUESTS`, with the card still loading: a person was
    // otherwise shown a failure and asked to press Try again for what the job
    // could do itself.
    let again = false;
    while (!existsSync(raw)) {
      plan.film ??= { job: null, requests: 0 };
      if (!plan.film.job && plan.film.requests >= MAX_FILM_REQUESTS) {
        return { ok: false, code: "FILM_FAILED", message: "The video service could not make this video. Nothing more will be spent on it.", plan };
      }
      const started = Date.now();
      const filming = again ? "The first try did not come back, so it is being made again, about twenty minutes" : "Filming, about twenty minutes";
      await stage(plan.film.job ? "Waiting for the video" : filming, 15);
      const made = await d.film(
        {
          prompt: plan.prompt,
          images: filmImages,
          videos: previous ? [{ bytes: previous.raw, type: "video/mp4" }] : undefined,
          audios: track ? [{ bytes: await readFile(track.file), type: "audio/mpeg" }] : undefined,
          seconds: skill.seconds,
          aspect: wide ? "16:9" : "9:16",
          resolution: FILM_RESOLUTION,
        },
        {
          signal: input.signal,
          job: plan.film.job,
          onSubmitted: async (job) => {
            plan.film = { job, requests: (plan.film?.requests ?? 0) + 1 };
            await stage(filming, 16);
          },
          onWait: async () => {
            const minutes = (Date.now() - started) / 60_000;
            await stage(filming, 16 + Math.min(54, (minutes / 25) * 54));
          },
        },
      );
      if (!made.ok) {
        // Stopped while the film was being made: the service goes on making
        // it (only a queued film can be cancelled), and it is paid for, so
        // the request is kept and "Try again" collects that film rather than
        // buying another.
        if (made.code === "STOPPED") return { ok: false, code: "STOPPED", message: "Stopped.", plan };
        // A film the service refused, cancelled or lost is asked for afresh
        // next time; one refused for our balance or cancelled was never made
        // and is not counted.
        // A request the service refused before accepting it has no job and
        // was never counted by `onSubmitted`; it counts now, or a refusal no
        // retry can fix (a picture of the wrong shape) is asked for forever.
        const job = plan.film.job;
        const refusedAtDoor = !job && made.code !== "OUT_OF_CREDITS" && made.code !== "NO_KEY";
        plan.film = {
          job: null,
          requests: plan.film.requests + (refusedAtDoor ? 1 : 0) - ((made.code === "OUT_OF_CREDITS" || made.code === "CANCELED") && job ? 1 : 0),
        };
        // Not made to her recorded voice: asked again at once with the film's
        // own voice, planned as before, rather than lost.
        if (track && plan.track && made.code !== "OUT_OF_CREDITS" && made.code !== "NO_KEY" && !input.signal?.aborted && plan.film.requests < MAX_FILM_REQUESTS) {
          console.log(`Film not made to her recorded voice (${made.code}: ${made.message}); asking again with the film's own voice.`);
          plan.track.refused = true;
          track = null;
          durations = plannedDurations;
          plan.durations = durations;
          plan.prompt = promptFor(durations, false);
          again = true;
          continue;
        }
        if (retryFilm(made.code) && plan.film.requests < MAX_FILM_REQUESTS && !input.signal?.aborted) {
          console.log(`Film not made (${made.code}); asking again, request ${plan.film.requests + 1} of ${MAX_FILM_REQUESTS}.`);
          again = true;
          continue;
        }
        return { ok: false, code: made.code, message: made.message, plan };
      }
      await writeFile(raw, made.bytes);
      // The film exactly as the video model made it, kept beside the post: the
      // service's own copy is gone within a day, and it is what a person
      // compares every fix against (the client, 20 October 2026).
      await writeFile(join(dir, "film-original.mp4"), made.bytes);
      plan.film = { job: made.job, requests: plan.film.requests };
    }
    // The map scenes are the approved map itself, laid in by us once.
    // A scene that says one place shows the route to it on the map: the whole
    // scene on the map, the head of it on the place's photo or the building.
    const routeTo = script.scenes.map((sc) => {
      const p = mapAt >= 0 ? placeOfScene(sc, places) : null;
      return p ? placeOnMap(p, mapRead) : null;
    });
    // As `voiceLast` below decides it: scenes fixed one by one, the voice after.
    const routesLater =
      skill.speech !== "none" &&
      !(input.drivers && "respeak" in input.drivers && !input.drivers.respeak) &&
      !previous &&
      autoFixOn() &&
      fixesByScene(skill, agentLikeStory) &&
      process.env.VOICE_LAST !== "off";
    const mapLaid = join(dir, "map-laid");
    if (skill.usesMap && mapAt >= 0 && !existsSync(mapLaid) && (script.scenes.some((sc) => sc.picture === mapAt) || (!routesLater && routeTo.some(Boolean)))) {
      await stage("Setting the location map", 70);
      const laid = await layMapShots({
        raw,
        dir,
        map: thumbs[mapAt],
        pin: mapPin,
        isMap: script.scenes.map((sc) => sc.picture === mapAt),
        planned: timeline(durations),
        routes: routeTo,
        // Routes at the head of a scene add a cut inside it, which would put
        // the scene fix's scenes out of step with the script: they are laid
        // once every scene is settled, when scenes are fixed one by one.
        parts: routesLater ? "maps" : "both",
      }).catch((e) => {
        console.error("film: the map could not be laid in", e);
        return null;
      });
      if (laid) await copyFile(laid.file, raw);
      await writeFile(mapLaid, String(laid?.laid ?? 0));
    }

    // ---- what is the same for every film of this script ----------------------
    const lockupBytes = m.lockup ? await readAsset(m.lockup.key) : null;
    const expectedQr = lockupBytes ? await readQr(lockupBytes) : null;
    const lockupQr = lockupBytes ? await qrOnly(lockupBytes) : null;
    const used = refs.map((i) => pictures[i]);
    const refPictures = await Promise.all(refs.map((i) => jpeg(thumbs[i], 512)));
    const spoken = script.scenes.map((sc) => sc.line).filter(Boolean);
    const lineOf = script.scenes.map((sc, i) => (sc.line ? script.scenes.slice(0, i).filter((x) => x.line).length : -1));
    const plannedShots = timeline(durations);
    // Nothing said, nothing to say again: a music-only film skips the voice fix.
    // A Hindi or Marathi film's lines are heard in their own script and said
    // again whole in the narrator's cloned voice (`local-voice.ts`).
    // A film made to her recorded voice keeps the voice the film came back
    // with, which its lips follow; only a word still said wrong is said again
    // (the client, 20 October 2026, after laying the recording back over the
    // film put every line 0.1 to 0.4 s off her lips).
    const respeak =
      skill.speech === "none"
        ? null
        : input.drivers && "respeak" in input.drivers
          ? input.drivers.respeak
          : narratedLater
            ? localVoiceover(lang.code, {
                scenes: script.scenes.map((sc, i) => ({ line: sc.line, delivery: sc.delivery, start: plannedShots[i].start, end: plannedShots[i].end })),
                male: script.voice !== "female",
                guide: true,
                sound: {
                  template: skill.key,
                  scenes: script.scenes.map((sc, i) => ({
                    kind: sc.kind,
                    shot: sc.shot,
                    picture: sc.picture >= 0 ? (pictures[sc.picture] ?? null) : null,
                    start: plannedShots[i].start,
                    end: plannedShots[i].end,
                  })),
                  seed: raw,
                },
              })
            : lang.code !== "en"
              ? localRespeak(lang.code)
              : respeakFilm;
    const hearIt: HearDriver = lang.code !== "en" && !input.drivers?.hear ? hearLocal(lang.code) : d.hear;
    // The scenes are fixed first and the voice after (the client, 9 October
    // 2026): a voice fixed first was thrown away when a scene was spliced in
    // over the film's own sound, and the story film went out saying
    // "Goremad" and "krong" although both had been said again. So the films
    // checked and fixed carry the video model's own sound, and the voice is
    // fixed once, on the film delivered. Agent on camera and the locality
    // guide take no scene fix, and keep the voice fixed before the checks.
    const voiceLast = respeak !== null && !previous && autoFixOn() && fixesByScene(skill, agentLikeStory) && process.env.VOICE_LAST !== "off";
    /** The film's words with their times, heard on its own sound: what a scene fix keeps clear of. */
    const wordsOf = async (filmRaw: string): Promise<{ text: string; start: number; end: number }[] | null> => {
      if (skill.speech === "none") return [];
      if (input.drivers) return null;
      const r = await elevenLabs
        .words({ bytes: await audioOf(filmRaw), type: "audio/mpeg" }, input.signal, lang.code === "hi" ? "hin" : lang.code === "mr" ? "mar" : "en")
        .catch(() => null);
      return r && r.ok ? r.words.map((w) => ({ text: w.text, start: w.start, end: w.end })) : null;
    };

    type Voice = { report: RespeakReport | null; failed: string | null };
    /** What `showEveryPlace()` laid in, said on the film delivered. */
    let placeNotes: string[] = [];
    type Checked = {
      raw: string;
      bytes: Buffer;
      pixel: Awaited<ReturnType<typeof gatePost>>;
      problems: { code: string; text: string }[];
      notes: string[];
      fixes: string[];
      /** What the story review found: when anything, the fix is a fresh film. */
      story: string[];
      /** What was found in the picture, located in the film, for a fix scene by scene. */
      located: SceneProblem[];
      /** The story review found the voice wrong, which no scene can put right. */
      voiceWrong: boolean;
      verdict: FilmVerdict;
      qrScans: boolean | null;
      heard: string | null;
      framesRead: boolean;
      /** What was said, word by word with its times, on the sound this film was checked with. */
      words: { text: string; start: number; end: number }[] | null;
      /** The shots the context checker found not doing their job, by number; null when it did not look. */
      missedJobs: number[] | null;
    };

    /**
     * One film made finished and checked: the words its voice got wrong said
     * again in her voice, the registration and our cards laid on, then every
     * check. Never buys anything but the checks' own reads.
     */
    const finish = async (
      filmDir: string,
      rawIn: string,
      voice: Voice | undefined,
      keepVoice: (v: Voice) => void,
      at: number,
      first = false,
      withVoice = !voiceLast,
      /** The scenes a scene fix remade in which she speaks; given, her lips are checked and matched to her voice. */
      lips: readonly LipSpan[] | null = null,
    ): Promise<Checked | "STOPPED"> => {
      let filmRaw = rawIn;
      // ---- the words it got wrong, said again in her own voice ---------------
      // Only those words change; her whole performance stays. Anything that
      // goes wrong keeps the film as it came and says so in the findings.
      const voiced = join(filmDir, "film-voiced.mp4");
      // A voice fix kept on the plan whose file is gone (the scratch folder of
      // a film made again was cleaned away) is made again: without it the
      // film went out with the video model's guide voice (8 October 2026).
      let v = withVoice && voice && (existsSync(voiced) || !voice.report?.fixed.length && !voice.report?.spans) ? voice : undefined;
      if (respeak && !v && withVoice) {
        await stage("Checking how every word was said", at);
        const r: RespeakResult = await respeak({ raw: filmRaw, dir: filmDir, lines: spoken, signal: input.signal }).catch((e): RespeakResult => {
          console.error("film: respeak failed", e);
          return { ok: false, code: "FAILED", message: "Something went wrong while fixing it." };
        });
        if (r.ok && r.film && r.film !== voiced) await copyFile(r.film, voiced);
        if (!r.ok && r.code === "STOPPED") return "STOPPED";
        v = r.ok ? { report: r.report, failed: null } : { report: r.report ?? null, failed: r.code === "OFF" || r.code === "NO_KEY" ? null : r.message };
        keepVoice(v);
      }
      let sound = withVoice && existsSync(voiced) ? voiced : filmRaw;
      const words = v?.report?.words ?? (withVoice ? null : await wordsOf(filmRaw));

      // ---- her lips, on the film about to be delivered -------------------------
      // A scene remade over her own sound has a mouth made without her voice:
      // it, and any scene SyncNet finds off, is lip-synced to her voice and
      // kept only when it scores better (`syncLips()`).
      let lipNotes: string[] = [];
      if (lips && skill.speech === "presenter" && !input.drivers?.film) {
        const talking = talkingSpans(script.scenes, timeline(await sceneLengths(filmRaw, durations)));
        if (talking.length) {
          await stage("Matching her lips to her voice", at);
          const synced = await syncLips({
            video: filmRaw,
            voiceOf: sound,
            sounds: sound === filmRaw ? [filmRaw] : [filmRaw, sound],
            talking,
            remade: lips,
            dir: join(filmDir, "lips"),
            plan,
            save: () => stage("Matching her lips to her voice", at),
            signal: input.signal,
          }).catch((e) => {
            console.error("film: matching her lips failed, keeping the scenes as they are", e);
            return null;
          });
          if (synced?.files.length) {
            sound = synced.files[synced.files.length - 1];
            filmRaw = synced.files[0];
          }
          lipNotes = synced?.notes ?? [];
        }
      }

      // ---- the registration on every frame -----------------------------------
      await stage("Adding the RERA details", at + 1);
      // A film that shows or says no price carries no price terms in its small print.
      const shownPrice = pricesIn(script.scenes.flatMap((sc) => [sc.line, sc.text])).length > 0 || script.scenes.some((sc) => /₹/.test(sc.text));
      const seconds = await probeSeconds(filmRaw);
      const firstFrame = await frameAt(filmRaw, Math.min(1, seconds / 2));
      const layers = await renderFrame({
        w: W,
        h: H,
        picture: firstFrame,
        isRender: used.some((p) => p.isRender),
        slide: { role: "photo", title: "", sub: null, cta: null },
        lockup: lockupQr,
        logo: m.logo?.bytes ?? null,
        colour: m.colour,
        registrationNo: m.registrationNo,
        ad: m.ad,
        permitNo: m.permitNo,
        promoter: m.promoter,
        officeAddress: m.officeAddress,
        phone: m.phone,
        website: m.website,
        disclaimer: withAiLine(
          smallPrintFor(m, false, [shownPrice ? m.disclaimer : withoutPriceTerms(m.disclaimer), skill.areaLines && ground.nearbyMeasured ? `Travel times as per ${ground.nearbyMeasured.replace(/[.\s]+$/, "")}.` : null].filter(Boolean).join(" ") || null),
        ),
        copy: false,
        scrim: "foot",
        moving: true,
      });
      // The foot's shade rides on the overlay, since the film moves under it.
      // It holds 0.64 over the contact line and the small print: a lighter one
      // let a pale wall behind them read at 3.7 to 1, where the gate asks 4.5.
      const foot = layoutFor(W, H).foot;
      const from = Math.max(0, Math.round(foot.y - foot.h * 2));
      const hold = (Math.max(from + 1, foot.y - foot.h * 0.3) - from) / (H - from);
      const shade = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="${hold.toFixed(3)}" stop-color="#000" stop-opacity="0.64"/>` +
          `<stop offset="1" stop-color="#000" stop-opacity="0.74"/></linearGradient></defs>` +
          `<rect x="0" y="${from}" width="${W}" height="${H - from}" fill="url(#f)"/></svg>`,
      );
      const overlay = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: shade }, { input: layers.overlay }])
        .png()
        .toBuffer();
      // The price and the configuration, set by us exactly as the facts write
      // them, while she says them: timed by what was heard, or by the plan.
      const spans = v?.report?.spans ?? (v?.report?.words?.length && lang.code === "en" ? lineSpans(spoken, v.report.words) : null);
      const stretchTo = seconds / (durations.reduce((a, b) => a + b, 0) || seconds || 1);
      const cutShots = timeline(await sceneLengths(filmRaw, durations).catch(() => durations.map((d) => d * stretchTo)));
      const cards = await Promise.all(
        script.scenes.flatMap((sc, i) => {
          if (!sc.text || !ourCard(skill, sc.text, [head.name])) return [];
          const line = lineOf[i];
          const said = line >= 0 ? spans?.[line] ?? null : null;
          const nextSaid = line >= 0 ? spans?.slice(line + 1).find((x) => x)?.start ?? null : null;
          const when = cardWindow({
            said,
            nextSaid,
            planned: { start: plannedShots[i].start * stretchTo, end: plannedShots[i].end * stretchTo },
            length: seconds,
            sceneEnd: cutShots[i]?.end ?? null,
          });
          return [filmCard(cardParts(sc.text), W, H, skill.cardAccent, skill.cardStyle).then((png) => ({ png, ...when }))];
        }),
      );
      // Every line said, set small at the foot while it is said, for a
      // format whose reference films print theirs (the launch film).
      if (skill.subtitles) {
        const subs = await Promise.all(
          script.scenes.flatMap((sc, i) => {
            const line = lineOf[i];
            if (line < 0 || !sc.line || isDevanagari(sc.line)) return [];
            const said = spans?.[line] ?? null;
            const nextSaid = spans?.slice(line + 1).find((x) => x)?.start ?? null;
            const when = cardWindow({
              said,
              nextSaid,
              planned: { start: plannedShots[i].start * stretchTo, end: plannedShots[i].end * stretchTo },
              length: seconds,
            });
            return [filmSubtitle(sc.line, W, H).then((png) => ({ png, ...when }))];
          }),
        );
        cards.push(...subs);
      }
      const out = join(filmDir, "film.mp4");
      await stampFilm(sound, out, overlay, W, H, filmDir, cards.filter((c) => c.end - c.start > 0.3));

      // ---- the checks -----------------------------------------------------------
      await stage("Checking the video", at + 2);
      const length = await probeSeconds(out);
      const qrRegion = { x: W * 0.5, y: 0, w: W * 0.5, h: Math.min(H, Math.min(W, H) * 0.4) };
      // Null only where there is nothing to scan: an exempt tower. A registered
      // one whose approved lockup holds no readable QR has a code that does not
      // scan.
      const qrScans = !m.registrationNo
        ? null
        : expectedQr
          ? (await Promise.all([0.15, 0.5, 0.9].map(async (f) => readQr(await frameAt(out, length * f), qrRegion)))).every((q) => q === expectedQr)
          : false;
      const real = await sceneLengths(filmRaw, durations);
      const realShots = timeline(real);
      const look = () => {
        plan.spend.asks++;
        return lookAtFilm(d.ask, filmRaw, script, real, refPictures, input.signal, (i) =>
          ((skill.assembles || skill.builds) && i < script.scenes.length - 2) || script.scenes[i]?.picture === ORDINARY_PLACE ||
          ["LOCATION_MAP", "NEARBY_PLACE"].includes(pictures[script.scenes[i]?.picture ?? -1]?.category ?? ""),
          (i) => ["LOCATION_MAP", "NEARBY_PLACE"].includes(pictures[script.scenes[i]?.picture ?? -1]?.category ?? ""),
        );
      };
      const looked = (await look()) ?? (await look());
      // Every building shot beside its own approved picture, judged by its
      // shape (`checkBuildings()`): a shot found not to be it is marked so,
      // and goes first to the scene fix.
      const filmLength = await probeSeconds(filmRaw);
      const plannedTotal = durations.reduce((a, b) => a + b, 0) || filmLength;
      const buildingShots = await Promise.all(
        script.scenes.flatMap((sc, i) =>
          sc.kind === "property" && sc.picture >= 0 && thumbs[sc.picture] && !skill.assembles && !skill.builds &&
          !["LOCATION_MAP", "CONSTRUCTION", "NEARBY_PLACE"].includes(pictures[sc.picture]?.category ?? "")
            ? [{ i, pic: sc.picture }]
            : [],
        ).map(async ({ i, pic }) => ({
          at: (realShots[i].start + realShots[i].end) / 2,
          picture: await jpeg(thumbs[pic], 1024),
        })),
      );
      if (buildingShots.length) plan.spend.asks++;
      const unlike = buildingShots.length ? await checkBuildings(d.ask, filmRaw, buildingShots, input.signal).catch(() => null) : [];
      const seen = looked
        ? [...looked, ...(unlike ?? []).map((u) => ({ at: u.at, texts: [] as string[], building: "differs" as const }))]
        : looked;
      plan.spend.asks++;
      const strays = await sweepFilm(d.ask, filmRaw, refPictures, script.presenter, input.signal, !!skill.assembles, !!skill.ordinaryPlaces, !!skill.builds, !!(skill.usesMap || skill.areaLines));
      // A shot held still reads as a frozen frame; the fix film is told where.
      const stillSpans = stillStretches(await motionOf(filmRaw).catch(() => []));
      const stills = stillSpans.map(stillNote);
      const heard =
        skill.speech === "none"
          ? ({ ok: false } as const)
          : await hearIt({ audio: { bytes: await audioOf(out), type: "audio/mpeg" }, language: lang.code }, { signal: input.signal });
      // A film with people in it is watched for whether its story makes sense.
      // Every film since 10 October 2026, people or none: the editors also
      // catch a building that drifts, a shot held still, words on screen.
      const watchStory = skill.peopleScenes.max > 0 || skill.presenterScenes.max > 0 || process.env.FILM_REVIEW_ALL !== "off";
      if (watchStory) plan.spend.asks++;
      // Watched like an editor (`reviewFilm()`): a survey with the time on
      // every frame, a close look and a note on every shot. The one-look
      // review is the fallback when the agent could not finish, and the
      // suites' injected brain answers the one look.
      // The first film only: a fixed one is checked scene by scene as it is
      // made, and once more by the one look, which keeps the cost priced.
      const editor = first && watchStory && !input.drivers?.ask
        ? await reviewFilm({
            raw: filmRaw,
            script,
            words: words ?? null,
            silent: skill.speech === "none",
            // The rooms and the building the film must show, so a room unlike all of them is a fault.
            approved: refs.map((i) => ({ title: `${pictures[i]?.title || pictures[i]?.category.toLowerCase().replace(/_/g, " ")} (picture ${i})`, image: { bytes: thumbs[i], type: "image/jpeg" } })),
            signal: input.signal,
          }).catch((e) => {
            console.error("film: the editor's review failed", e);
            return null;
          })
        : null;
      const storyFound = editor && editor.ended === "done"
        ? editor.findings.map((f) => ({ at: f.at, end: f.end, what: f.what, fix: f.fix, about: f.about, note: storyNote(f) }))
        : watchStory
          ? await reviewStory(d.ask, filmRaw, script, durations, heard.ok ? heard.text : null, input.signal)
          : [];
      const story = storyFound.map((f) => f.note);
      const verdict: FilmVerdict = judgeFilm({
        // Only what the model drew: the eye reads its film before our cards go on.
        cards: script.scenes.flatMap((s) => (s.text && !ourCard(skill, s.text, [head.name]) ? cardParts(s.text) : [])),
        lines: spoken,
        cleared,
        seen,
        transcript: heard.ok ? heard.text : null,
        qrScans,
        strays,
        silent: skill.speech === "none",
        local: lang.code !== "en",
      });
      // How every word was said, heard by the listener on the film as it goes
      // out (`listen-rules.ts`). It replaces the transcript's "Listen for"
      // notes, which a tidy transcript could never raise: "three km" said
      // "k-meter" was written "km" and matched the script (19 October 2026).
      const listen = lang.code === "en" && skill.speech !== "none" && !input.drivers ? listener() : null;
      const listened = listen ? await listen.film(await audioOf(out), spoken.map(spokenForm), input.signal).catch(() => null) : null;
      if (listen) plan.spend.asks++;
      const saidAt = words?.length ? lineSpans(spoken, words) : [];
      const listenNotes = (listened ?? []).map((p) => listenNote(p, spoken[p.line], saidAt[p.line]?.start ?? null));
      const verdictNotes = listened ? verdict.notes.filter((n) => !n.startsWith("Listen for ")) : verdict.notes;
      // The pixel gate, on the stamped film: the first, middle and last of
      // every scene as planned, stretched to the length it came back at.
      const bytes = await readFile(out);
      const planned = durations.reduce((a, b) => a + b, 0) || length;
      const stretch = length / planned;
      const pixel = await gatePost({
        files: [{ bytes, type: "video/mp4" }],
        expect: () => frameExpect(m, expectedQr, pixelContext(ground), { render: used.some((p) => p.isRender) }),
        times: () => sampleTimes(timeline(durations).map((t) => ({ start: t.start * stretch, end: Math.min(length, t.end * stretch) }))),
        registrationNo: m.registrationNo,
        reader: d.pixel,
      });
      const pixelFails = pixel.findings.filter((f) => f.verdict === "FAIL").map((f) => f.text);
      const pauses = v?.report?.words?.length && lang.code === "en" ? pauseNotes(spoken, linePauses(spoken, v.report.words)) : [];
      const voiceNotes = respeakNotes(v?.report ?? null, v?.failed ?? null);
      // Where each thing seen wrong is, so a fix makes only those scenes again.
      // The voice and the QR are no scene's to fix.
      const textAt = (t: string) => seen?.find((f) => f.texts.includes(t))?.at;
      const found: SceneProblem[] = [
        // Graded (20 October 2026): only a grave or serious fault may cost a
        // remade scene (`remakeWorthy()`); the editors grade their own, and
        // the one-look review that stands in for them keeps its old weight.
        ...storyFound
          .filter((f) => f.about !== "voice")
          .map((f) => ({
            at: f.at,
            ...("end" in f && typeof f.end === "number" ? { end: f.end } : {}),
            what: f.what,
            fix: f.fix,
            pace: f.about === "slow" ? ("slow" as const) : f.about === "rushed" ? ("rushed" as const) : null,
            serious: editor && editor.ended === "done" ? !!(f as { serious?: boolean }).serious : f.about === "picture",
          })),
        ...stillSpans.map((s) => ({ at: s.start, end: s.end, what: "The picture stands still", fix: "the camera keeps moving and something in the frame moves", pace: "slow" as const, serious: false })),
        ...(strays ?? []).map((s) => ({ at: s.at, what: `It shows ${s.what || "something"}, which is not in the project`, fix: "show only the approved project and the people of this film", grave: s.kind === "property", serious: s.kind === "property" })),
        ...(seen ?? [])
          .filter((f) => f.building === "differs" && f.at !== undefined)
          .map((f) => ({ at: f.at!, what: "The building does not look like its approved picture", fix: "show the building exactly as in its approved picture", grave: true })),
        ...[...verdict.problems, ...verdict.notes].flatMap((p) => {
          const t = /"([^"]+)"/.exec(p)?.[1];
          const at = t ? textAt(t) : undefined;
          if (at === undefined) return [];
          const should = /should read "([^"]+)"/.exec(p)?.[1];
          return [{ at, what: `The text on screen reads "${t}"`, fix: should ? `it must read exactly "${should}"` : "no text on screen but the shot's own card", serious: true }];
        }),
      ];
      // ---- the three checkers (19 October 2026, the client) ---------------------
      // What is broken in the picture is the editors' (above). The sound is
      // measured in code (`audioFindings()`): a line she never says on camera
      // is a scene to film again, on the first film only, because a remade
      // take is laid over the same sound and the line is then said in her
      // voice last (`unsaidLines()`); a voice of the other gender is the
      // sound's to put right. Whether each shot does its job in the film is
      // the context checker's (`checkContext()`), on every film a scene fix
      // is made from.
      const measured = first && skill.speech !== "none" ? voiceFromPitch(await voicePitch(filmRaw).catch(() => null)) : null;
      const audio = audioFindings({
        scenes: script.scenes,
        lineOf,
        lines: spoken,
        shots: realShots,
        words: words ?? null,
        length,
        speech: skill.speech,
        voice: script.voice === "male" ? "male" : "female",
        measured,
        english: lang.code === "en",
      });
      // A line she never says is the voice's to put right (`unsaidLines()`): a
      // scene she talks in is never remade, so it is a note here.
      for (const a of audio) if (a.route === "scene" && first) found.push({ at: a.at, end: a.end, what: a.what, fix: a.fix, grave: false, serious: false });
      const audioNotes = audio.filter((a) => a.route !== "scene").map((a) => `Listen: ${a.what}.`);
      const runContext = watchStory && (first || !(voiceLast && withVoice));
      if (runContext) plan.spend.asks++;
      const context = runContext
        ? await checkContext({
            ask: d.ask,
            raw: filmRaw,
            script,
            jobs: shotJobs(script, pictures),
            words: words ?? null,
            // A remade scene is laid over the film's sound, so a line in it is judged by her mouth.
            mouthOnly: !first,
            signal: input.signal,
          }).catch((e) => {
            console.error("film: the context check failed", e);
            return null;
          })
        : null;
      for (const c of context ?? []) found.push({ at: c.at, end: c.end, what: c.what, fix: c.fix, grave: false, serious: input.drivers?.ask ? true : !!c.serious });
      const contextNotes = (context ?? []).map(contextNote);
      // A map scene is the approved map, laid in by us: nothing in it is a scene's to remake.
      const mapSpans = script.scenes.flatMap((sc, i) => (sc.picture === mapAt && mapAt >= 0 ? [realShots[i]] : []));
      const located = found.filter((p) => !mapSpans.some((s) => p.at + 0.25 >= s.start && p.at + 0.25 < s.end));
      return {
        raw: filmRaw,
        bytes,
        pixel,
        problems: [...verdict.problems.map((text) => ({ code: "FILM", text })), ...pixelFails.map((text) => ({ code: "PIXEL", text }))],
        notes: [...story, ...contextNotes, ...audioNotes, ...listenNotes, ...voiceNotes, ...pauses, ...stills, ...verdictNotes, ...lipNotes, ...placeNotes],
        fixes: filmFixes([...verdict.problems, ...story, ...contextNotes, ...listenNotes, ...verdictNotes, ...stills, ...pauses, ...voiceNotes]),
        story,
        located,
        voiceWrong: storyFound.some((f) => f.about === "voice") || audio.some((a) => a.route === "voice" && a.what.startsWith("The voice is")),
        verdict,
        qrScans,
        heard: heard.ok ? heard.text : null,
        framesRead: seen !== null,
        words,
        missedJobs: context ? context.map((c) => c.shot) : null,
      };
    };

    const firstFilm = await finish(dir, raw, plan.respeak, (v) => (plan.respeak = v), 72, true);
    if (firstFilm === "STOPPED") return { ok: false, code: "STOPPED", message: "Stopped.", plan };
    let delivered: Checked = firstFilm;

    // ---- a mistake in the picture is put right scene by scene -----------------
    // Every template but those where a presenter speaks on camera (whose lips
    // follow her own voice): only the scenes the checks named are made again,
    // each sent back as the reference with what to change (Veo when Seedance
    // will not take it), checked, and spliced in mute over the film's own
    // sound (the client, 7 October 2026). A whole new film to fix two scenes
    // copied the first film's faults back, or brought new ones. A voice that
    // is wrong is no scene's to fix, and goes to a fresh film below.
    const sceneFirst = fixesByScene(skill, agentLikeStory) && !firstFilm.voiceWrong && (plan.fix?.byScene ?? true);
    /** The scenes remade in which she speaks, in the delivered film's time. */
    let remadeTalk: LipSpan[] = [];
    const canFixScenes = !previous && autoFixOn() && sceneFirst;
    // Only a fault worth a remade scene is remade (the client, 20 October
    // 2026: a ledge, a change of light and a still second cost two remakes
    // that broke her lips and lost her closing line). Graded serious by whoever
    // found it (`remakeWorthy()`), then confirmed by one more look at that
    // moment beside the shot's approved picture (`confirmFault()`); anything
    // else stays a note. A suite's injected brain is taken at its word.
    const worthRemaking = async (list: readonly SceneProblem[], filmRaw: string): Promise<SceneProblem[]> => {
      for (const p of list) if (!remakeWorthy(p)) console.log(`film: a note, not remade: ${p.what} (${p.at.toFixed(1)} s)`);
      const worthy = list.filter(remakeWorthy);
      if (input.drivers?.ask || !worthy.length) return worthy;
      const length = await probeSeconds(filmRaw);
      const k = length / (durations.reduce((a, b) => a + b, 0) || length || 1);
      const shots = timeline(durations).map((t) => ({ start: t.start * k, end: t.end * k }));
      const out: SceneProblem[] = [];
      for (const p of worthy.slice(0, MAX_CONFIRMS)) {
        const i = shots.findIndex((sh) => p.at + 0.25 >= sh.start && p.at + 0.25 < sh.end);
        const pic = i >= 0 ? script.scenes[i]?.picture ?? -1 : -1;
        plan.spend.asks++;
        const c = await confirmFault({
          ask: d.ask,
          raw: filmRaw,
          at: p.at,
          end: p.end ?? p.at + 1,
          what: p.what,
          approved: pic >= 0 && thumbs[pic] ? await jpeg(thumbs[pic], 768) : null,
          signal: input.signal,
        });
        console.log(`film: "${p.what}" at ${p.at.toFixed(1)} s ${c?.real ? "confirmed" : "not confirmed"}${c?.why ? `: ${c.why}` : ""}`);
        if (c?.real) out.push(p);
      }
      return out;
    };
    const firstWorth = canFixScenes && firstFilm.located.length ? await worthRemaking(firstFilm.located, raw) : [];
    if (canFixScenes && firstWorth.length) {
      plan.fix ??= { problems: firstFilm.fixes, byScene: true, film: { job: null, requests: 0 } };
      const fixDir = join(dir, "scenes");
      await mkdir(fixDir, { recursive: true });
      await stage("Fixing what the checks found", 76);
      const filmSeconds = await probeSeconds(raw);
      const scale = filmSeconds / (durations.reduce((a, b) => a + b, 0) || filmSeconds || 1);
      const spans = timeline(durations).map((t) => ({ start: t.start * scale, end: t.end * scale }));
      const talkSpans = spans.map((sp, i) => ({ ...sp, talks: script.scenes[i]?.kind === "presenter" && !!script.scenes[i]?.line }));
      // The approved picture a building or room shot was made from goes back in with it.
      const pictureOf = new Map<number, { bytes: Buffer; type: string }>();
      for (const sc of script.scenes) if (sc.picture >= 0 && thumbs[sc.picture] && !pictureOf.has(sc.picture)) pictureOf.set(sc.picture, await jpeg(thumbs[sc.picture], 1280));
      // A scene is the script's shot of the same place among the cuts when the
      // film came back with as many cuts as shots; by time only otherwise.
      const shotAt = (t: number, place?: { index: number; of: number }) => {
        const byTime = spans.findIndex((s) => t >= s.start && t < s.end);
        const i = place && place.of === script.scenes.length ? place.index : byTime < 0 ? script.scenes.length - 1 : byTime;
        const sc = script.scenes[i];
        return {
          shot: plan.direction?.shots[i] ? `${sc.shot} ${plan.direction.shots[i].blocking} ${plan.direction.shots[i].action}`.trim() : sc.shot,
          kind: sc.kind,
          card: sc.text && !ourCard(skill, sc.text, [head.name]) ? sc.text : null,
          // A people scene inside the flat takes its room too: made again from words, it needs the room.
          picture: sc.picture >= 0 ? pictureOf.get(sc.picture) ?? null : null,
          people: plan.direction?.shots[i]?.people ?? [],
          // A presenter speaking on camera: the remade take keeps her lips moving with her words.
          talks: sc.kind === "presenter" && !!sc.line,
          // And says her line in it, as she says it: a take told only to talk "as in the original" stays silent where the original was.
          line: sc.kind === "presenter" && sc.line && lang.code === "en" ? spokenForm(sc.line) : undefined,
          // The approved map is laid in by us and never remade.
          ours: mapAt >= 0 && sc.picture === mapAt,
        };
      };
      const voicedFirst = join(dir, "film-voiced.mp4");
      const fix = plan.fix;
      // Round after round until the editor finds nothing a scene can fix, or
      // a round makes the film no better (the client, 8 October 2026: "go as
      // much as reviews are required"). Each round's film is watched again by
      // the editor, and what it still finds is the next round's work.
      const shifted = (v: Voice | undefined, changes: readonly { at: number; by: number }[]): Voice | undefined => {
        const report = v?.report ?? null;
        if (!v) return undefined;
        return {
          ...v,
          report: report
            ? {
                ...report,
                ...(report.words ? { words: shiftWords(report.words, changes) } : {}),
                // A narration's lines move with the scenes the same way, and the price card with them.
                ...(report.spans
                  ? { spans: report.spans.map((sp) => (sp ? shiftWords([{ text: "", start: sp.start, end: sp.end }], changes)[0] ?? sp : null)) }
                  : {}),
              }
            : null,
        };
      };
      let current = {
        raw,
        voiced: !voiceLast && existsSync(voicedFirst) ? voicedFirst : null,
        checked: firstFilm,
        voice: voiceLast ? undefined : (plan.respeak as Voice | undefined),
      };
      fix.delivered = "first";
      // Scenes every take of a round failed to put right are not paid for again.
      let gaveUp: { start: number; end: number }[] = [];
      for (let round = 1; round <= SCENE_FIX_ROUNDS && current.checked.located.length; round++) {
        if (input.signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", plan };
        const toFix = stillWorthFixing(round === 1 ? firstWorth : await worthRemaking(current.checked.located, current.raw), gaveUp);
        if (!toFix.length) {
          console.log(`film: round ${round} skipped: what is left is in scenes a round could not fix`);
          break;
        }
        const roundDir = round === 1 ? fixDir : join(dir, `scenes-${round}`);
        await mkdir(roundDir, { recursive: true });
        // A round's own state, so the next one starts clean; the earlier ones are kept for the record.
        if (round > 1 && plan.sceneFix) {
          plan.sceneFixRounds = [...(plan.sceneFixRounds ?? []), plan.sceneFix];
          plan.sceneFix = undefined;
        }
        await stage(`Fixing what the checks found${round > 1 ? ` (round ${round})` : ""}`, 76);
        // A fix that breaks (the network dropped, a service ran out) never
        // costs the film already made: the best film so far is delivered
        // (9 October 2026, a dropped connection failed a finished film).
        try {
        const r = await fixScenes({
          raw: current.raw,
          voiced: current.voiced,
          dir: roundDir,
          problems: toFix,
          words: skill.speech === "none" ? [] : current.voice?.report?.words ?? current.checked.words ?? null,
          shotAt,
          people: script.presenter,
          aspect: wide ? "16:9" : "9:16",
          plan,
          save: () => stage("Fixing what the checks found", 78),
          stage: (p) => stage("Fixing what the checks found", p),
          drivers: { film: d.film, veo: d.veo ?? veoScene, ask: d.ask, veoReady: d.veoReady ?? veoReady },
          // Never a scene she speaks in, never one holding more than one shot (`remakeRefusal()`).
          refuse: (scene, of) =>
            shotAt((scene.start + scene.end) / 2, { index: scene.index, of }).talks ? "she speaks in it" : remakeRefusal(scene, talkSpans),
          signal: input.signal,
        });
        if (!r.ok && r.code === "STOPPED") return { ok: false, code: "STOPPED", message: "Stopped.", plan };
        fix.film.requests += plan.sceneFix?.scenes.reduce((n, sc) => n + sc.takes.filter((t) => t.job).length, 0) ?? 0;
        if (!r.ok) break;
        gaveUp = shiftSpans(
          [...gaveUp, ...(plan.sceneFix?.scenes ?? []).filter((sc) => sc.takes.length && !sc.chosen).map((sc) => ({ start: sc.start, end: sc.end }))],
          r.changes,
        );
        const voice = shifted(current.voice, r.changes);
        if (round === 1) fix.respeak = voice;
        const fixed = await finish(roundDir, r.raw, voice, (v) => {
          if (round === 1) fix.respeak = v;
        }, 94, true);
        if (fixed === "STOPPED") return { ok: false, code: "STOPPED", message: "Stopped.", plan };
        const score = (c: Checked) => ({ problems: c.problems.length, fixes: c.fixes.length + c.located.length });
        // A fix that loses a shot that worked is never kept: the first fix of
        // 20 October 2026 counted fewer problems and had lost her closing line.
        const lost = current.checked.missedJobs && fixed.missedJobs ? lostShots(current.checked.missedJobs, fixed.missedJobs) : [];
        if (lost.length) {
          console.log(`film: round ${round} not kept: shot ${lost.join(", ")} stopped doing its job`);
          break;
        }
        if (betterFilm(score(current.checked), score(fixed)) !== "fixed") break;
        current = { raw: r.raw, voiced: r.voiced, checked: fixed, voice };
        remadeTalk = [...shiftSpans(remadeTalk, r.changes), ...r.talked];
        fix.respeak = voice;
        fix.delivered = "fixed";
        delivered = fixed;
        } catch (e) {
          if (input.signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", plan };
          console.error(`film: scene fix round ${round} broke, delivering the best film so far:`, e);
          break;
        }
      }
    }

    // ---- a mistake found is put right before anybody sees it ------------------
    // Once, by itself, never for a person's own new version: the first film
    // goes back in as @Video1 with what was wrong, and the better of the two
    // is delivered. A fix the service could not make delivers the first.
    // Agent on camera, and a film whose voice is wrong.
    else if (!previous && autoFixOn() && !sceneFirst && firstFilm.fixes.length) {
      // A story that went wrong (whose voice, the order, an action that made
      // no sense) is filmed fresh: sent in as @Video1, the first film was
      // copied, its voice and its door included (6 October 2026).
      plan.fix ??= { problems: firstFilm.fixes, fresh: firstFilm.story.length > 0, film: { job: null, requests: 0 } };
      const fixDir = join(dir, "fix");
      await mkdir(fixDir, { recursive: true });
      const fixRaw = join(fixDir, "film-raw.mp4");
      if (!existsSync(fixRaw) && (plan.fix.film.job || plan.fix.film.requests < MAX_FIX_REQUESTS)) {
        if (input.signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", plan };
        const started = Date.now();
        await stage("Fixing what the checks found", 76);
        const fixPrompt = filmPrompt({
          skill,
          script,
          durations,
          pictures: pictures.map((p) => ({ category: p.category, title: p.title })),
          wide,
          project: head.name,
          locality: ground.location,
          styleFrames: styles.length,
          textCard: !!textCard,
          language: lang,
          revision: { note: "", problems: plan.fix.problems, fresh: !!plan.fix.fresh },
          direction: skill.speech !== "presenter" || agentLikeStory ? plan.direction ?? null : null,
        });
        const fix = plan.fix;
        const made = await d.film(
          {
            prompt: fixPrompt,
            images: filmImages,
            videos: fix.fresh ? undefined : [{ bytes: await readFile(raw), type: "video/mp4" }],
            seconds: skill.seconds,
            aspect: wide ? "16:9" : "9:16",
            resolution: FILM_RESOLUTION,
          },
          {
            signal: input.signal,
            job: fix.film.job,
            onSubmitted: async (job) => {
              fix.film = { job, requests: fix.film.requests + 1 };
              await stage("Fixing what the checks found", 77);
            },
            onWait: async () => {
              const minutes = (Date.now() - started) / 60_000;
              await stage("Fixing what the checks found", 77 + Math.min(16, (minutes / 25) * 16));
            },
          },
        );
        if (made.ok) await writeFile(fixRaw, made.bytes);
        else if (made.code === "STOPPED") return { ok: false, code: "STOPPED", message: "Stopped.", plan };
        else {
          // Never asked again: the first film is delivered as it is.
          console.error("film: the fix was not made:", made.code, made.message);
          fix.film = { job: null, requests: Math.max(fix.film.requests, MAX_FIX_REQUESTS) };
        }
      }
      if (existsSync(fixRaw)) {
        const fixed = await finish(fixDir, fixRaw, plan.fix.respeak, (v) => (plan.fix!.respeak = v), 94).catch((e) => {
          if (input.signal?.aborted) return "STOPPED" as const;
          console.error("film: checking the fix film broke, delivering the first:", e);
          return firstFilm;
        });
        if (fixed === "STOPPED") return { ok: false, code: "STOPPED", message: "Stopped.", plan };
        const pick = betterFilm({ problems: firstFilm.problems.length, fixes: firstFilm.fixes.length }, { problems: fixed.problems.length, fixes: fixed.fixes.length });
        plan.fix.delivered = pick;
        if (pick === "fixed") delivered = fixed;
      } else {
        plan.fix.delivered = "first";
      }
    }

    // ---- the voice, fixed once, on the film delivered ---------------------------
    // After every scene is settled (`voiceLast`): the words it got wrong said
    // again, or a Hindi or Marathi story's narration laid on, then the film is
    // stamped and checked once more as delivered.
    const fixedOne = delivered !== firstFilm;
    /**
     * Each scene filmed on a nearby place's approved photo, checked on the
     * film for whether that place is really in it (`checkPlaces()`), and each
     * one missing laid in from the photo itself over her words for it. On 18
     * October 2026 Seedance skipped the station shot and kept her on the
     * balcony, and nothing put it back.
     */
    const showEveryPlace = async (raw: string, at: string): Promise<string | null> => {
      const wanted = script.scenes.flatMap((sc, i) =>
        pictures[sc.picture]?.category === "NEARBY_PLACE" && sc.line && lineOf[i] >= 0 && thumbs[sc.picture] ? [{ i, sc, place: pictures[sc.picture].title ?? "" }] : [],
      );
      if (!wanted.length) return null;
      const words = await wordsOf(raw);
      if (!words?.length) return null;
      const spans = lineSpans(spoken, words);
      const length = await probeSeconds(raw);
      const cuts = await cutsOf(raw).catch(() => [] as number[]);
      const windows = wanted.flatMap((w) => {
        const line = lineOf[w.i];
        const when = placeWindow(spans[line] ?? null, spans.slice(line + 1).find((x) => x)?.start ?? null, cuts, length);
        return when ? [{ ...w, when }] : [];
      });
      if (!windows.length) return null;
      plan.spend.asks++;
      const missing = await checkPlaces(
        d.ask,
        raw,
        await Promise.all(windows.map(async (w) => ({ at: (w.when.start + w.when.end) / 2, place: w.place, picture: await jpeg(thumbs[w.sc.picture], 1024) }))),
        input.signal,
      );
      if (!missing?.length) return null;
      const lay = windows.filter((_, k) => missing.includes(k));
      const laid = await layPlacePhotos({
        raw,
        dir: at,
        places: lay.map((w) => ({ photo: thumbs[w.sc.picture], start: w.when.start, end: w.when.end })),
        out: join(at, "film-raw-places.mp4"),
      });
      if (!laid) return null;
      plan.placesLaid = lay.map((w) => ({ place: w.place, ...w.when }));
      const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
      placeNotes = lay.map((w) => `${w.place} was not shown, so its approved photo was laid in at ${mmss(w.when.start)}.`);
      return laid.file;
    };
    if (voiceLast) {
      const finalDir = join(dir, "final");
      await mkdir(finalDir, { recursive: true });
      let finalRaw = delivered.raw;
      if (skill.usesMap && mapAt >= 0 && routesLater && routeTo.some((r, i) => r && script.scenes[i].picture !== mapAt)) {
        await stage("Showing each route on the map", 95);
        const routed = await layMapShots({
          raw: delivered.raw,
          dir: finalDir,
          map: thumbs[mapAt],
          pin: mapPin,
          isMap: script.scenes.map((sc) => sc.picture === mapAt),
          planned: timeline(durations),
          routes: routeTo,
          parts: "routes",
          out: join(finalDir, "film-raw-routed.mp4"),
        }).catch((e) => {
          console.error("film: the routes could not be laid in", e);
          return null;
        });
        if (routed) finalRaw = routed.file;
      }
      // Every nearby place said is seen: one the film never showed is laid in
      // from its own approved photo while she says it.
      if (skill.areaLines && !input.drivers?.film) {
        await stage("Making sure every place is shown", 95);
        const placed = await showEveryPlace(finalRaw, finalDir).catch((e) => {
          console.error("film: the places could not be checked, keeping the film as it is", e);
          return null;
        });
        if (placed) finalRaw = placed;
      }
      const voiced = await finish(
        finalDir,
        finalRaw,
        plan.voiceFinal,
        (v) => {
          plan.voiceFinal = v;
          if (fixedOne && plan.fix) plan.fix.respeak = v;
          else plan.respeak = v;
        },
        96,
        false,
        true,
        remadeTalk,
      ).catch((e) => {
        if (input.signal?.aborted) return "STOPPED" as const;
        console.error("film: the voice on the delivered film broke, delivering it as it is:", e);
        return null;
      });
      if (voiced === "STOPPED") return { ok: false, code: "STOPPED", message: "Stopped.", plan };
      if (voiced) delivered = voiced;
    }

    // ---- saved, and handed over -----------------------------------------------
    // Delivered as made: the client ruled on 2 October 2026 that a film the
    // product hands over is finished, never marked as not cleared. What the
    // checks found stays on the record for us. The pixel gate's own verdict
    // still governs publishing (`prepare()`), because that is the
    // registration block the authority reads.
    const passed = true;
    await stage("Saving the video", 98);
    // A scheduled creative keeps its film under its own id.
    const postId = input.creative ? input.copyId : randomUUID();
    const stored = await storePostFiles(input.orgId, node.id, postId, [{ bytes: delivered.bytes, type: "video/mp4", w: W, h: H }]);
    if (!stored) return { ok: false, code: "STORE_FAILED", message: "The video could not be saved.", plan };
    const media = withHashes(stored, delivered.pixel);
    // The model's own film, without our overlay, is what a new version is
    // made from; the stamped one would come back with a second badge drawn in.
    const kept = await putAsset({ orgId: input.orgId, project: await projectOfNode(input.orgId, node.id), kind: "post", id: `${postId}-raw`, bytes: await readFile(delivered.raw), contentType: "video/mp4" });
    // The video model's film as it came, for a person to compare every fix against.
    const originalFile = join(dir, "film-original.mp4");
    const original = !input.creative && existsSync(originalFile)
      ? await putAsset({ orgId: input.orgId, project: await projectOfNode(input.orgId, node.id), kind: "post", id: `${postId}-original`, bytes: await readFile(originalFile), contentType: "video/mp4" }).catch(() => null)
      : null;
    const usedRefs = used.map((p) => ({ assetId: p.assetId, sha256: p.sha256 }));
    const fixRecord = plan.fix
      ? {
          problems: plan.fix.problems,
          made: plan.fix.film.requests > 0 || !!plan.fix.film.job,
          delivered: plan.fix.delivered ?? "first",
          request: plan.fix.film.job?.requestId ?? null,
          firstProblems: firstFilm.problems.map((p) => p.text),
        }
      : null;
    if (input.creative) {
      keep = false;
      return {
        ok: true,
        postId,
        plan,
        handed: {
          media,
          pixel: delivered.pixel,
          review: {
            passed,
            attempts: fixedOne || fixRecord?.made ? 2 : 1,
            problems: delivered.problems,
            notes: delivered.notes,
            model: FILM_MODEL,
            film: { skill: skill.key, request: plan.film?.job?.requestId ?? null, fix: fixRecord },
          },
          template: skill.key,
        },
      };
    }
    await withTenant(input.orgId, async (sql) => {
      await sql`
        INSERT INTO rendered_posts (id, org_id, brief_id, scope_node_id, copy_id, kind, placement,
                                    language, segment, headline, body, cta, media, inputs, review, pixel, created_by)
        VALUES (${postId}, ${input.orgId}, ${input.briefId}, ${node.id}, ${card.id}, 'VIDEO', ${input.placement},
                ${card.language}, ${card.segment}, ${card.headline}, ${card.body}, ${card.cta},
                ${sql.json(media as unknown as JSONValue)},
                ${sql.json({
                  format: "presenter",
                  film: {
                    model: FILM_MODEL,
                    resolution: FILM_RESOLUTION,
                    skill: skill.key,
                    units: plan.units,
                    revisionOf: previous?.postId ?? null,
                    note: revise?.note ?? null,
                    script,
                    durations,
                    prompt: plan.prompt,
                    raw: kept.ok ? kept.key : null,
                    original: original?.ok ? original.key : null,
                    pictures: usedRefs,
                    request: plan.film?.job?.requestId ?? null,
                    respeak: (fixedOne ? plan.fix?.respeak : plan.respeak) ?? null,
                    fix: fixRecord,
                    lipsync: plan.lipSync ?? null,
                  },
                  pictures: usedRefs,
                  lockup: m.lockup ? { assetId: m.lockup.assetId, sha256: m.lockup.sha256 } : null,
                  logo: m.logo ? { role: m.logo.role, fileId: m.logo.fileId, at: m.logo.at } : null,
                  registrationNo: m.registrationNo,
                  agentNo: m.agentNo ?? null,
                  template: { key: skill.key, by: "person" },
                  font: face?.key ?? null,
                } as unknown as JSONValue)},
                ${sql.json({
                  passed,
                  attempts: fixedOne || fixRecord?.made ? 2 : 1,
                  problems: delivered.problems,
                  notes: delivered.notes,
                  model: FILM_MODEL,
                  checks: { qrScans: delivered.qrScans, heard: delivered.heard?.slice(0, 800) ?? null, framesRead: delivered.framesRead },
                } as unknown as JSONValue)},
                ${sql.json(delivered.pixel as unknown as JSONValue)},
                ${input.actorUserId})`;
    });
    await auditPixel({ orgId: input.orgId, actorUserId: input.actorUserId, targetType: "rendered_post", targetId: postId, record: delivered.pixel });
    // One video, or two for a person's new version. The fix is ours: never counted.
    await meterVideo({ orgId: input.orgId, nodeId: node.id, postId, kind: previous ? "FILM_VERSION" : "FILM", units: plan.units, passed });
    // Counts and codes only: the script can quote the copy.
    await audit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "creative.reel_made",
      targetType: "rendered_post",
      targetId: postId,
      metadata: {
        format: "presenter",
        engine: "film",
        units: plan.units,
        revision: !!previous,
        passed,
        problems: delivered.verdict.problems.length,
        notes: delivered.verdict.notes.length,
        drafts: plan.spend.drafts,
        fixed: fixRecord ? fixRecord.delivered : null,
      },
    });
    keep = false;
    return { ok: true, postId, plan };
  } catch (e) {
    console.error("film: failed, scratch kept at", dir, e);
    return { ok: false, code: "FAILED", message: "The video could not be made. Try again.", plan };
  } finally {
    if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
