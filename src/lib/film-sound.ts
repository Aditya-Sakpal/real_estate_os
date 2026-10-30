/**
 * A narrated film's music and background sound, made for it and mixed under
 * the narrator (`film-sound-rules.ts` says why and decides). Two paid calls
 * of ElevenLabs': Music for one cue cut to the film's sections, and Sound
 * Effects for one background sound per place. Each is checked before it is
 * used: the cue for a voice and for an early end, every background sound for
 * speech. Anything that fails leaves the film's own score in place.
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { elevenLabs } from "./elevenlabs.ts";
import {
  ambienceLufs,
  ambiencePrompt,
  ambienceSeconds,
  ambienceWindow,
  briefFor,
  cuePlan,
  duckVolume,
  fadedEarly,
  placesToAsk,
  SOUND,
  soundSeed,
  stretchesFor,
  type SoundPlace,
  type SoundScene,
  type timeOf,
} from "./film-sound-rules.ts";
import { scenesFromCuts } from "./scene-fix-rules.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const SCRIPT = join(process.cwd(), "scripts", "voicefix.py");
const API = "https://api.elevenlabs.io/v1";
const ffmpeg = (args: string[]) => run(FFMPEG, ["-v", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });

export type SoundReport = {
  /** The cue was composed and kept. */
  score: boolean;
  /** Background sounds laid. */
  places: number;
  requests: { music: number; sfx: number };
  /** Why the film's own score was kept instead, in our words. */
  fallback: string | null;
};

type Bed = {
  music: string;
  ambience: { file: string; at: number; seconds: number; fadeIn: number; fadeOut: number; gainDb: number }[];
};

export const filmSoundOn = (): boolean => (process.env.FILM_SOUND ?? "on").toLowerCase() !== "off";

async function seconds(path: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { windowsHide: true });
  return Number(String(stdout).trim()) || 0;
}

async function loudness(path: string, upTo?: number): Promise<number | null> {
  const r = await run(
    FFMPEG,
    ["-hide_banner", "-i", path, ...(upTo ? ["-t", upTo.toFixed(3)] : []), "-af", "ebur128", "-f", "null", "-"],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  ).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const all = [...String(r.stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  const v = all.length ? Number(all[all.length - 1][1]) : NaN;
  return Number.isFinite(v) && v > -70 ? v : null;
}

/** RMS in dB per `step` seconds of a file, mono. */
async function profile(path: string, step = 0.5): Promise<number[]> {
  const sr = 16000;
  const { stdout } = await run(FFMPEG, ["-v", "error", "-i", path, "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  const buf = stdout as unknown as Buffer;
  const a = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const n = Math.round(sr * step);
  const out: number[] = [];
  for (let i = 0; i + n <= a.length; i += n) {
    let sum = 0;
    for (let j = i; j < i + n; j++) sum += a[j] * a[j];
    out.push(10 * Math.log10(sum / n + 1e-12));
  }
  return out;
}

async function cutsOf(path: string): Promise<number[]> {
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", path, "-an", "-vf", "select='gt(scene,0.25)',showinfo", "-f", "null", "-"], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return [...String(stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

async function ask(path: string, body: unknown, ms: number, signal?: AbortSignal): Promise<Buffer | null> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) return null;
  const timeout = AbortSignal.timeout(ms);
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => null);
  if (!r?.ok) {
    if (r) console.warn(`film-sound: ElevenLabs answered ${r.status}`, (await r.text().catch(() => "")).slice(0, 200));
    return null;
  }
  return Buffer.from(await r.arrayBuffer());
}

/** Is there a voice in the cue? Demucs takes it apart and the vocal stem is measured. */
async function hasVoice(file: string, dir: string, signal?: AbortSignal): Promise<boolean> {
  const py = process.env.VOICEFIX_PYTHON || "python";
  const out = join(dir, "cue-sep");
  const ok = await run(py, [SCRIPT, "separate", file, out], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, signal, windowsHide: true })
    .then(() => true)
    .catch(() => false);
  if (!ok) return false;
  const level = await loudness(join(out, "vocals.wav"));
  return level !== null && level > -40;
}

/**
 * The music and background sound for one narrated film: asked, checked and
 * returned as files with their places. Nothing paid is asked past its cap.
 */
export async function makeBed(input: {
  raw: string;
  dir: string;
  template: string | null;
  scenes: readonly SoundScene[];
  seed: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; bed: Bed; report: SoundReport } | { ok: false; report: SoundReport }> {
  const report: SoundReport = { score: false, places: 0, requests: { music: 0, sfx: 0 }, fallback: null };
  const P = (f: string) => join(input.dir, `snd-${f}`);
  if (!filmSoundOn()) return { ok: false, report: { ...report, fallback: "switched off" } };
  if (!process.env.ELEVENLABS_API_KEY?.trim()) return { ok: false, report: { ...report, fallback: "no ElevenLabs key" } };
  const length = await seconds(input.raw);
  const cuts = scenesFromCuts(await cutsOf(input.raw), length, 24).map((c) => ({ start: c.start, end: c.end }));
  const stretches = stretchesFor(cuts, input.scenes, length);
  if (!stretches.length) return { ok: false, report: { ...report, fallback: "no scenes" } };

  // ---- the cue, and the background sounds, asked at once -------------------
  const plan = cuePlan(briefFor(input.template), stretches, length, soundSeed(input.seed));
  const cue = (async (): Promise<string | null> => {
    for (let k = 0; k < SOUND.maxScoreRequests; k++) {
      if (input.signal?.aborted) return null;
      report.requests.music++;
      const bytes = await ask("/music?output_format=mp3_44100_192", { model_id: SOUND.musicModel, composition_plan: plan }, 240_000, input.signal);
      if (!bytes) continue;
      const file = P(`cue${k}.mp3`);
      await writeFile(file, bytes);
      if ((await seconds(file)) < length - 0.5) continue;
      if (fadedEarly(await profile(file), 0.5, length)) {
        console.warn("film-sound: the cue ended early; asking again");
        continue;
      }
      if (await hasVoice(file, input.dir, input.signal)) {
        console.warn("film-sound: the cue has a voice; asking again");
        continue;
      }
      return file;
    }
    return null;
  })();

  type Key = `${SoundPlace}:${ReturnType<typeof timeOf>}`;
  const wanted = placesToAsk(stretches);
  let sfxLeft = SOUND.maxAmbienceRequests;
  const sounds = new Map<Key, string>();
  const ambience = Promise.all(
    wanted.map(async (w, i) => {
      for (let k = 0; k < 2 && sfxLeft > 0; k++) {
        if (input.signal?.aborted) return;
        sfxLeft--;
        report.requests.sfx++;
        const bytes = await ask(
          "/sound-generation?output_format=mp3_44100_192",
          { text: ambiencePrompt(w.place, w.time), duration_seconds: ambienceSeconds(w.seconds), prompt_influence: 0.6, loop: true, model_id: SOUND.sfxModel },
          90_000,
          input.signal,
        );
        if (!bytes) continue;
        // A background sound with anybody speaking in it is never laid.
        const heard = await elevenLabs.words({ bytes, type: "audio/mpeg" }, input.signal, "en");
        if (!heard.ok || heard.words.length) continue;
        const file = P(`amb${i}-${k}.mp3`);
        await writeFile(file, bytes);
        sounds.set(`${w.place}:${w.time}`, file);
        return;
      }
    }),
  );
  const [music] = await Promise.all([cue, ambience]);
  if (!music) return { ok: false, report: { ...report, fallback: "the music could not be made" } };
  report.score = true;

  const levels = new Map<string, number | null>();
  const laid: Bed["ambience"] = [];
  for (const s of stretches) {
    if (!s.place) continue;
    const file = sounds.get(`${s.place}:${s.time}`);
    if (!file) continue;
    if (!levels.has(file)) levels.set(file, await loudness(file));
    const level = levels.get(file);
    if (level === null || level === undefined) continue;
    const win = ambienceWindow(s, length);
    laid.push({ file, ...win, gainDb: Math.min(SOUND.maxAmbienceGainDb, ambienceLufs(s.place) - level) });
  }
  report.places = new Set(laid.map((a) => a.file)).size;
  return { ok: true, bed: { music, ambience: laid }, report };
}

/**
 * The narration over the composed cue and the background sounds: the music
 * dips a little under each line, the background a little less, both fade at
 * the end, and nothing is normalised inside the mix (a loudnorm there once
 * lost a film's last line).
 */
export async function mixBed(input: {
  voice: string;
  voiceGainDb: number;
  bed: Bed;
  spans: readonly ({ start: number; end: number } | null)[];
  length: number;
  out: string;
}): Promise<void> {
  const L = input.length;
  const musicLevel = (await loudness(input.bed.music, L)) ?? SOUND.musicLufs;
  const musicGain = SOUND.musicLufs - musicLevel;
  const fadeAt = Math.max(0, L - SOUND.fadeOut).toFixed(3);
  const musicDuck = duckVolume(input.spans, SOUND.musicDuckDb, 0.25, 0.35, 0.4);
  const ambDuck = duckVolume(input.spans, SOUND.ambienceDuckDb, 0.2, 0.3, 0.3);
  const files = [input.voice, input.bed.music, ...input.bed.ambience.map((a) => a.file)];
  const parts: string[] = [
    `[0:a]aformat=channel_layouts=stereo,volume=${input.voiceGainDb.toFixed(2)}dB[voice]`,
    `[1:a]aformat=channel_layouts=stereo,atrim=0:${L.toFixed(3)},volume=${musicGain.toFixed(2)}dB,volume='${musicDuck}':eval=frame,` +
      `afade=t=in:d=${SOUND.fadeIn},afade=t=out:st=${fadeAt}:d=${SOUND.fadeOut}[music]`,
  ];
  input.bed.ambience.forEach((a, k) => {
    const ms = Math.round(a.at * 1000);
    parts.push(
      `[${k + 2}:a]aformat=channel_layouts=stereo,atrim=0:${a.seconds.toFixed(3)},asetpts=PTS-STARTPTS,volume=${a.gainDb.toFixed(2)}dB,` +
        `afade=t=in:d=${a.fadeIn.toFixed(2)},afade=t=out:st=${Math.max(0, a.seconds - a.fadeOut).toFixed(3)}:d=${a.fadeOut.toFixed(2)},adelay=${ms}|${ms}[a${k}]`,
    );
  });
  const amb = input.bed.ambience.length;
  if (amb) parts.push(`${input.bed.ambience.map((_, k) => `[a${k}]`).join("")}amix=inputs=${amb}:normalize=0,apad,atrim=0:${L.toFixed(3)},volume='${ambDuck}':eval=frame[bg]`);
  parts.push(`[voice][music]${amb ? "[bg]" : ""}amix=inputs=${amb ? 3 : 2}:normalize=0:duration=first,apad,atrim=0:${L.toFixed(3)},alimiter=limit=0.89:level=disabled[mix]`);
  const first = `${input.out}.pre.wav`;
  await ffmpeg([...files.flatMap((f) => ["-i", f]), "-filter_complex", parts.join(";"), "-map", "[mix]", "-ar", "44100", first]);
  // The whole film brought to one loudness, measured and set as a fixed gain.
  const whole = (await loudness(first)) ?? SOUND.filmLufs;
  await ffmpeg(["-i", first, "-af", `volume=${(SOUND.filmLufs - whole).toFixed(2)}dB,alimiter=limit=0.89:level=disabled`, "-ar", "44100", input.out]);
}
