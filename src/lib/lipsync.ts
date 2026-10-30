import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  keepSynced,
  lipSyncNote,
  lipSyncUsd,
  spansToSync,
  watermarked,
  type LipScore,
  type LipSpan,
} from "./lipsync-rules.ts";
import { probe, splice } from "./scene-fix.ts";

/**
 * Lips matched to her voice, on the film about to be delivered.
 *
 * Every scene the presenter speaks in is scored by SyncNet on this machine
 * (`scripts/lipsync.py`, free, about a minute on the worker's CPU); a scene
 * the scene fix remade, and any other whose lips are found off, is sent to
 * Sync Labs (lipsync-2, `SYNC_API_KEY`) with her own voice for that stretch,
 * scored again, and spliced in only when it is better (`lipsync-rules.ts`).
 * At most `MAX_LIPSYNC_SECONDS` a film, priced at `SYNC_USD_PER_SECOND`
 * before it is asked. Nothing here ever costs the film: anything that fails
 * keeps the scenes as they were and says so in the notes.
 *
 * Sync Labs fetches its inputs from links, so each cut and its voice are put
 * in our bucket under `film-ref/`, handed over presigned for an hour, and
 * removed when the take is back. The Hobbyist plan runs one job at a time,
 * so the scenes go one after another. A request is remembered on the plan
 * (`LipSyncPlan`) the moment it is accepted, so a worker that dies collects
 * it rather than paying again. `LIPSYNC=off` switches it off.
 */

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SCRIPT = join(process.cwd(), "scripts", "lipsync.py");
const VOICEFIX = join(process.cwd(), "scripts", "voicefix.py");
const SYNC_API = process.env.SYNC_API_BASE || "https://api.sync.so/v2";
const SYNC_MODEL = process.env.SYNC_MODEL || "lipsync-2";
/** How long one lip sync may take before it is given up on. */
const SYNC_TIMEOUT_MS = 12 * 60_000;
const REF_SECONDS = 3600;

export type LipSyncPlan = {
  usd: number;
  spans: {
    start: number;
    end: number;
    why: "remade" | "off";
    before: LipScore | null;
    after: LipScore | null;
    kept: boolean;
    /** Sync Labs' generation, kept the moment it is accepted. */
    job: string | null;
    file: string | null;
    failed: string | null;
  }[];
};

export type SyncResult = { ok: true; bytes: Buffer } | { ok: false; code: string; message: string };

export type LipSyncDriver = {
  /** SyncNet's score per span, or null when the scorer is not installed. */
  score(job: { video: string; voice: string; spans: readonly LipSpan[] }, signal?: AbortSignal): Promise<LipScore[] | null>;
  /** Lips redrawn to the voice. `job` collects a request already accepted. */
  sync(
    input: { video: { bytes: Buffer; type: string }; voice: { bytes: Buffer; type: string } },
    opts: { signal?: AbortSignal; job: string | null; onSubmitted: (job: string) => Promise<void> },
  ): Promise<SyncResult>;
  /** Her voice alone (Demucs), written as a wav, or null. */
  voice(src: string, dir: string, signal?: AbortSignal): Promise<string | null>;
  /** The words read off a frame of a take, to find a service's watermark. */
  read(video: string): Promise<string[]>;
};

let injected: Partial<LipSyncDriver> | null = null;
/** The checks' seam: a scorer, a lip sync and a voice split that cost nothing. */
export function useLipSync(d: Partial<LipSyncDriver> | null): void {
  injected = d;
}

async function python(args: string[], signal?: AbortSignal): Promise<string> {
  const py = process.env.VOICEFIX_PYTHON || "python";
  const { stdout } = await run(py, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, signal, windowsHide: true });
  return String(stdout);
}

/** The scorer is installed: the models folder holds all three models. */
export function scorerReady(): boolean {
  const dir = process.env.LIPSYNC_MODELS;
  return !!dir && ["syncnet_v2.model", "face_landmarker.task", "pose.task"].every((f) => existsSync(join(dir, f)));
}

const syncNetScore: LipSyncDriver["score"] = async (job, signal) => {
  if (!scorerReady()) return null;
  const file = join(job.video + ".lipjob.json");
  await writeFile(file, JSON.stringify({ ...job, models: process.env.LIPSYNC_MODELS }));
  try {
    const out = await python([SCRIPT, "score", file], signal);
    const line = out.trim().split(/\r?\n/).pop() ?? "";
    const parsed = JSON.parse(line) as LipScore[];
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error("lipsync: scoring failed", e);
    return null;
  }
};

const demucsVoice: LipSyncDriver["voice"] = async (src, dir, signal) => {
  const wav = join(dir, "sound.wav");
  await run(FFMPEG, ["-v", "error", "-y", "-i", src, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav], { maxBuffer: 64 * 1024 * 1024 });
  const out = join(dir, "voice");
  try {
    await python([VOICEFIX, "separate", wav, out], signal);
    return existsSync(join(out, "vocals.wav")) ? join(out, "vocals.wav") : null;
  } catch (e) {
    console.error("lipsync: the voice could not be taken apart", e);
    return null;
  }
};

/** The words on three frames of a take, read by the pixel gate's own OCR, as light and as dark type. */
const readTake: LipSyncDriver["read"] = async (video) => {
  const { readLines } = await import("./ocr.ts");
  const len = (await probe(video)).seconds;
  const texts: string[] = [];
  for (const at of [0.2, 0.5, 0.8]) {
    const { stdout } = await run(FFMPEG, ["-v", "error", "-ss", (len * at).toFixed(2), "-i", video, "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    const png = stdout as unknown as Buffer;
    for (const invert of [false, true]) texts.push(...(await readLines(png, null, 1.5, ["0"], invert)).map((l) => l.text));
  }
  return texts;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Sync Labs' lipsync-2: the cut and her voice by presigned link, polled until done. */
const syncLabs: LipSyncDriver["sync"] = async (input, opts) => {
  const key = process.env.SYNC_API_KEY;
  if (!key) return { ok: false, code: "NO_KEY", message: "Lip sync is not set up." };
  const { storage } = await import("./storage.ts");
  const { createHash } = await import("node:crypto");
  const placed: string[] = [];
  const cleanUp = () => Promise.all(placed.map((k) => storage().remove(k).catch(() => {})));
  const headers = { "x-api-key": key, "content-type": "application/json" };
  try {
    let id = opts.job;
    if (!id) {
      const place = async (f: { bytes: Buffer; type: string }, ext: string) => {
        const k = `film-ref/${createHash("sha256").update(f.bytes).digest("hex").slice(0, 32)}.${ext}`;
        await storage().put(k, f.bytes, f.type);
        placed.push(k);
        return storage().signedUrl(k, REF_SECONDS, f.type);
      };
      const video = await place(input.video, "mp4");
      const voice = await place(input.voice, "wav");
      const res = await fetch(`${SYNC_API}/generate`, {
        method: "POST",
        headers,
        signal: opts.signal,
        body: JSON.stringify({
          model: SYNC_MODEL,
          input: [{ type: "video", url: video }, { type: "audio", url: voice }],
          options: { sync_mode: "cut_off" },
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: string; message?: string; error?: string };
      if (!res.ok || !j.id) {
        await cleanUp();
        const code = res.status === 402 ? "OUT_OF_CREDITS" : res.status === 401 ? "NO_KEY" : "REFUSED";
        return { ok: false, code, message: j.message || j.error || `Sync Labs answered ${res.status}.` };
      }
      id = j.id;
      await opts.onSubmitted(id);
    }
    const until = Date.now() + SYNC_TIMEOUT_MS;
    while (Date.now() < until) {
      if (opts.signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped." };
      const r = await fetch(`${SYNC_API}/generate/${id}`, { headers, signal: opts.signal }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => null)) as { status?: string; outputUrl?: string; error?: string } | null) : null;
      if (j?.status === "COMPLETED" && j.outputUrl) {
        const file = await fetch(j.outputUrl, { signal: opts.signal });
        if (!file.ok) return { ok: false, code: "LOST", message: "The lip-synced take could not be fetched." };
        return { ok: true, bytes: Buffer.from(await file.arrayBuffer()) };
      }
      if (j && ["FAILED", "REJECTED", "CANCELED"].includes(j.status ?? "")) {
        return { ok: false, code: j.status!, message: j.error || "Sync Labs could not match the lips." };
      }
      await sleep(8_000, opts.signal);
    }
    return { ok: false, code: "TIMEOUT", message: "Sync Labs took too long." };
  } finally {
    await cleanUp();
  }
};

const ffmpeg = (args: string[]) => run(FFMPEG, ["-v", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });

/**
 * The film with the lips of the scenes that need it matched to her voice.
 * `video` is the film as it will be stamped (its picture is what changes),
 * `sounds` the files whose sound each new film must carry (the model's own,
 * and the one with her words said again). Null when nothing was changed.
 */
export async function syncLips(input: {
  video: string;
  /** The sound the film goes out with: what her lips must follow. */
  voiceOf: string;
  sounds: readonly string[];
  talking: readonly LipSpan[];
  remade: readonly LipSpan[];
  dir: string;
  plan: { lipSync?: LipSyncPlan };
  save: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ files: string[]; notes: string[] } | null> {
  if (process.env.LIPSYNC === "off" || !input.talking.length) return null;
  const d: LipSyncDriver = { score: syncNetScore, sync: syncLabs, voice: demucsVoice, read: readTake, ...(injected ?? {}) };
  if (!process.env.SYNC_API_KEY && !injected?.sync) return null;
  await mkdir(input.dir, { recursive: true });
  const film = await probe(input.video);
  const voice = await d.voice(input.voiceOf, input.dir, input.signal);
  if (!voice) return { files: [], notes: ["Her lips could not be checked: her voice could not be taken apart from the music."] };

  // ---- which scenes ------------------------------------------------------------
  let plan = input.plan.lipSync;
  if (!plan) {
    const scores = await d.score({ video: input.video, voice, spans: input.talking }, input.signal);
    // Nothing scored, nothing sent: an unscored take could never be shown to be better.
    if (!scores) return null;
    const picked = spansToSync(input.talking, input.remade, scores);
    plan = {
      usd: lipSyncUsd(picked.map((p) => p.span)),
      spans: picked.map((p) => ({ ...p.span, why: p.why, before: p.before, after: null, kept: false, job: null, file: null, failed: null })),
    };
    input.plan.lipSync = plan;
    await input.save();
  }
  if (!plan.spans.length) return null;

  // ---- one scene after another, as the plan allows ------------------------------
  for (const [n, sp] of plan.spans.entries()) {
    if (input.signal?.aborted) return null;
    const out = join(input.dir, `lips-${n}.mp4`);
    if (sp.file && existsSync(sp.file)) continue;
    if (sp.failed) continue;
    const startFrame = Math.round(sp.start * film.fps);
    const endFrame = Math.round(sp.end * film.fps);
    const cut = join(input.dir, `cut-${n}.mp4`);
    const said = join(input.dir, `said-${n}.wav`);
    await ffmpeg(["-i", input.video, "-an", "-vf", `trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS`, "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", cut]);
    await ffmpeg(["-ss", (startFrame / film.fps).toFixed(3), "-t", ((endFrame - startFrame) / film.fps).toFixed(3), "-i", voice, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", said]);
    const r = await d.sync(
      { video: { bytes: await readFile(cut), type: "video/mp4" }, voice: { bytes: await readFile(said), type: "audio/wav" } },
      {
        signal: input.signal,
        job: sp.job,
        onSubmitted: async (job) => {
          sp.job = job;
          await input.save();
        },
      },
    ).catch((e): SyncResult => ({ ok: false, code: "FAILED", message: e instanceof Error ? e.message : String(e) }));
    if (!r.ok) {
      if (r.code === "STOPPED") return null;
      sp.failed = r.message;
      await input.save();
      continue;
    }
    // At the film's size and rate, exactly the scene's frames: the last held if it came back short.
    const got = join(input.dir, `got-${n}.mp4`);
    await writeFile(got, r.bytes);
    const frames = endFrame - startFrame;
    await ffmpeg([
      "-i", got, "-an", "-vf",
      `fps=${film.fps},scale=${film.w}:${film.h},setsar=1,tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames},setpts=PTS-STARTPTS`,
      "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out,
    ]);
    // A take stamped with the service's mark is never used.
    if (watermarked(await d.read(out).catch(() => []))) {
      sp.failed = "it came back with Sync Labs' watermark on it";
      await input.save();
      continue;
    }
    sp.file = out;
    sp.start = startFrame / film.fps;
    sp.end = endFrame / film.fps;
    await input.save();
  }

  // ---- scored again, and kept only when better ---------------------------------
  const tried = plan.spans.filter((sp) => sp.file && existsSync(sp.file));
  if (tried.length) {
    const trial = join(input.dir, "trial.mp4");
    await splice(
      input.video,
      tried.map((sp) => ({ startFrame: Math.round(sp.start * film.fps), endFrame: Math.round(sp.end * film.fps), file: sp.file! })),
      input.voiceOf,
      trial,
    );
    const after = (await d.score({ video: trial, voice, spans: tried.map((sp) => ({ start: sp.start, end: sp.end })) }, input.signal)) ?? [];
    for (const sp of tried) {
      sp.after = after.find((a) => Math.abs(a.start - sp.start) < 0.05) ?? null;
      sp.kept = keepSynced(sp.before, sp.after, sp.why);
    }
    await input.save();
  }
  const notes = plan.spans.map((sp) => lipSyncNote({ span: sp, kept: sp.kept, before: sp.before, after: sp.after, failed: sp.failed }));
  const kept = plan.spans.filter((sp) => sp.kept && sp.file && existsSync(sp.file));
  if (!kept.length) return { files: [], notes };
  const pieces = kept.map((sp) => ({ startFrame: Math.round(sp.start * film.fps), endFrame: Math.round(sp.end * film.fps), file: sp.file! }));
  const files: string[] = [];
  for (const [i, sound] of input.sounds.entries()) {
    const out = join(input.dir, `film-lips-${i}.mp4`);
    await splice(input.video, pieces, sound, out);
    files.push(out);
  }
  return { files, notes };
}
