/**
 * Records a presenter's lines before the film is made (`voice-track-rules.ts`
 * says why): ElevenLabs says each line in a fixed voice, the listener hears
 * each take, a line is said again until it is right, a word still wrong is
 * joined in by Cartesia, and the lines are laid end to end at the times the
 * scenes are planned from. The recording goes to Seedance as `@Audio1`, and
 * the same lines are laid back over the finished film (`localVoiceover()` with
 * `takes`). Never fatal: anything that fails returns null, and the film is
 * made speaking in its own voice as before.
 *
 * Imports are relative because the worker runs this straight from source.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { cartesia } from "./cartesia.ts";
import { listener } from "./listen.ts";
import { infillCut, TRACK, trackText, trackTiming, trackTooLong, trackVoice, wordSpan, type Alignment, type TrackTiming } from "./voice-track-rules.ts";
import { spokenForm, type TimedScene } from "./film-rules.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const ffmpeg = (args: string[]) => run(FFMPEG, ["-v", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
async function seconds(path: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { windowsHide: true });
  return Number(String(stdout).trim()) || 0;
}

export type VoiceTrack = {
  /** The recording sent to Seedance (MP3) and laid back after. */
  file: string;
  /** Each spoken line's take (WAV, trimmed, at the tempo the track uses), in the order said. */
  lines: string[];
  timing: TrackTiming;
  voice: string;
  /** Lines no take or join made right, with what was still heard wrong. */
  wrong: { line: number; words: string[] }[];
  /** Lines a word was joined into by Cartesia. */
  joined: number[];
  chars: number;
  takes: number;
  infills: number;
};

/** A line in the voice, with when each character is said; null when the voice service refused. */
async function say(voice: string, text: string, previous: string, next: string, seed: number, signal?: AbortSignal): Promise<{ bytes: Buffer; alignment: Alignment | null } | null> {
  const k = process.env.ELEVENLABS_API_KEY?.trim();
  if (!k) return null;
  const timed = AbortSignal.timeout(90_000);
  const body = JSON.stringify({
    text,
    model_id: TRACK.model,
    seed,
    voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: TRACK.speed },
    ...(TRACK.model === "eleven_v3" ? {} : { previous_text: previous, next_text: next }),
  });
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_192`, {
    method: "POST",
    headers: { "xi-api-key": k, "content-type": "application/json" },
    body,
    signal: signal ? AbortSignal.any([signal, timed]) : timed,
  }).catch(() => null);
  if (!r?.ok) {
    if (r) console.warn(`voice-track: ElevenLabs answered ${r.status}`, (await r.text().catch(() => "")).slice(0, 200));
    return null;
  }
  const j = (await r.json().catch(() => null)) as { audio_base64?: string; alignment?: Alignment } | null;
  return j?.audio_base64 ? { bytes: Buffer.from(j.audio_base64, "base64"), alignment: j.alignment ?? null } : null;
}

/** A clip as the listener takes it. */
async function mp3Of(wav: string, out: string): Promise<Buffer> {
  await ffmpeg(["-i", wav, "-ac", "1", "-b:a", "96k", out]);
  return readFile(out);
}

export type Take = { file: string; len: number; alignment: Alignment | null; trimmed: number; wrong: { word: string; heard: string }[] | null; joined?: boolean };

export type TrackResult =
  | { ok: true; track: VoiceTrack }
  /** The lines, as said, do not fit the film even sped up: what to tell the writer. */
  | { ok: false; long: string }
  | null;

/**
 * Records every line and lays them out. Too long for the film even sped up
 * as far as `fastest`, it says by how much, for the writer; null when the
 * voice could not be made (the film is then made as before). A line said
 * before with the same words and delivery is taken from `cache`, so a draft
 * sent back pays only for the lines it changed.
 */
export async function recordTrack(o: {
  scenes: readonly (TimedScene & { delivery?: string | null })[];
  seconds: number;
  silent: { min: number; max: number };
  male: boolean;
  dir: string;
  signal?: AbortSignal;
  fastest?: number;
  cache?: Map<string, Take>;
}): Promise<TrackResult> {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  const voice = trackVoice(o.male);
  const ear = listener();
  const spoken = o.scenes.filter((s) => s.line?.trim());
  if (!spoken.length) return null;
  const stamp = Date.now().toString(36);
  const P = (f: string) => join(o.dir, `track-${stamp}-${f}`);
  const out: VoiceTrack = { file: P("voice.mp3"), lines: [], timing: { durations: [], starts: [], tempo: 1 }, voice, wrong: [], joined: [], chars: 0, takes: 0, infills: 0 };
  const best: Take[] = [];
  let cloneId: string | null = null;
  const cart = cartesia();
  try {
    for (let i = 0; i < spoken.length; i++) {
      const line = spoken[i].line;
      const text = trackText(line, spoken[i].delivery);
      const said = spokenForm(line);
      const cacheKey = `${voice}|${text}`;
      const cached = o.cache?.get(cacheKey);
      if (cached) {
        if (cached.wrong?.length) out.wrong.push({ line: i, words: cached.wrong.map((w) => w.word) });
        if (cached.joined) out.joined.push(i);
        best.push(cached);
        continue;
      }
      let keep: Take | null = null;
      // A line holding a local name the voice says wrong as written is asked
      // respelled first ("Goregao"): Seedance copies the recording's Goregaon,
      // and the plain spelling came back "Gore-ga-awn" (20 October 2026).
      const respelled = trackText(line, spoken[i].delivery, TRACK.model, true);
      const nameFirst = respelled !== text;
      for (let t = 0; t < TRACK.takes; t++) {
        if (o.signal?.aborted) return null;
        const asked = nameFirst ? (t === 1 ? text : respelled) : t === 1 ? respelled : text;
        const got = await say(voice, asked, i ? spokenForm(spoken[i - 1].line) : "", spoken[i + 1] ? spokenForm(spoken[i + 1].line) : "", 7 + t * 41 + i, o.signal);
        out.takes++;
        out.chars += text.length;
        if (!got) continue;
        const raw = P(`l${i}-t${t}.mp3`);
        await writeFile(raw, got.bytes);
        // The silence the voice leaves at either end is cut, and how much was cut
        // from the head is kept, so the character times still find the words.
        const file = P(`l${i}-t${t}.wav`);
        await ffmpeg([
          "-i", raw,
          "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse",
          "-ac", "1", "-ar", "44100", file,
        ]);
        const len = await seconds(file);
        const whole = await seconds(raw);
        // The first letter said, past the delivery tag ("[excited]"), which the voice does not say.
        const chars = got.alignment?.characters ?? [];
        const tagEnd = chars[0] === "[" ? chars.indexOf("]") + 1 : 0;
        const first = chars.findIndex((c, k) => k >= tagEnd && /[a-z0-9]/i.test(c));
        const head = first >= 0 ? got.alignment!.character_start_times_seconds[first] : 0;
        const trimmed = Math.max(0, Math.min(head, whole - len));
        const heard = ear ? await ear.heard(await mp3Of(file, P(`l${i}-t${t}-ear.mp3`)), said, o.signal) : null;
        const take: Take = { file, len, alignment: got.alignment, trimmed, wrong: heard ? heard.wrong : null };
        console.log(`voice-track: line ${i + 1} take ${t + 1}: ${heard ? (heard.ok ? "heard right" : `heard wrong (${heard.wrong.map((w) => `${w.word} as ${w.heard}`).join(", ")})`) : "not heard"}`);
        const score = (x: Take) => (x.wrong === null ? 50 : x.wrong.length);
        if (!keep || score(take) < score(keep)) keep = take;
        if (heard?.ok) break;
      }
      if (!keep) return null;
      // A word no take says right is joined in by Cartesia, between the words around it, in a clone of this voice.
      if (keep.wrong?.length && keep.wrong.length <= TRACK.infillWords && cart && keep.alignment && ear) {
        if (!cloneId) {
          const sample = P("clone.wav");
          const done = best.length ? best.map((b) => b.file) : [keep.file];
          await ffmpeg([...done.flatMap((f) => ["-i", f]), "-filter_complex", `${done.map((_, k) => `[${k}:a]`).join("")}concat=n=${done.length}:v=0:a=1`, "-t", "40", sample]);
          cloneId = await cart.clone(await readFile(sample), `salesdesk-track-${Date.now()}`, o.signal);
        }
        if (cloneId) {
          let file = keep.file;
          let len = keep.len;
          let ok = true;
          for (const w of keep.wrong) {
            const sp = wordSpan(keep.alignment, w.word);
            if (!sp) { ok = false; break; }
            const cut = infillCut({ start: sp.start - keep.trimmed, end: sp.end - keep.trimmed }, len);
            const left = cut.left > 0.05 ? P(`l${i}-left.wav`) : null;
            const right = len - cut.right > 0.05 ? P(`l${i}-right.wav`) : null;
            if (left) await ffmpeg(["-i", file, "-t", cut.left.toFixed(3), left]);
            if (right) await ffmpeg(["-ss", cut.right.toFixed(3), "-i", file, right]);
            const mid = await cart.infill(
              { voiceId: cloneId, left: left ? await readFile(left) : null, right: right ? await readFile(right) : null, transcript: spokenForm(w.word) },
              o.signal,
            );
            out.infills++;
            if (!mid) { ok = false; break; }
            const midFile = P(`l${i}-mid.wav`);
            await writeFile(midFile, mid);
            const joinedFile = P(`l${i}-joined-${out.infills}.wav`);
            const parts = [left, midFile, right].filter((x): x is string => !!x);
            await ffmpeg([
              ...parts.flatMap((f) => ["-i", f]),
              "-filter_complex", `${parts.map((_, k) => `[${k}:a]aresample=44100,aformat=channel_layouts=mono[a${k}]`).join(";")};${parts.map((_, k) => `[a${k}]`).join("")}concat=n=${parts.length}:v=0:a=1`,
              joinedFile,
            ]);
            file = joinedFile;
            len = await seconds(file);
          }
          if (ok) {
            const heard = await ear.heard(await mp3Of(file, P(`l${i}-joined-ear.mp3`)), said, o.signal);
            console.log(`voice-track: line ${i + 1} joined by Cartesia: ${heard ? (heard.ok ? "heard right" : "still heard wrong") : "not heard"}`);
            if (heard && heard.wrong.length < keep.wrong.length) {
              keep = { ...keep, file, len, wrong: heard.wrong, alignment: null, joined: true };
              out.joined.push(i);
            }
          }
        }
      }
      if (keep.wrong?.length) out.wrong.push({ line: i, words: keep.wrong.map((w) => w.word) });
      o.cache?.set(cacheKey, keep);
      best.push(keep);
    }
    const lens = best.map((b) => b.len);
    const timing = trackTiming(o.scenes, lens, o.seconds, o.silent, o.fastest ?? TRACK.fastest);
    if (!timing) {
      console.log(`voice-track: the lines (${lens.map((x) => x.toFixed(1)).join(" + ")} s) do not fit ${o.seconds} s`);
      return { ok: false, long: trackTooLong(o.scenes, lens, o.seconds, o.silent) };
    }
    out.timing = timing;
    // Each line at its tempo, as a file of its own (laid back over the film after) and in the track.
    for (let i = 0; i < best.length; i++) {
      const f = P(`line${i}.wav`);
      await ffmpeg(["-i", best[i].file, "-af", timing.tempo > 1.001 ? `atempo=${timing.tempo.toFixed(4)}` : "anull", "-ac", "1", "-ar", "44100", f]);
      out.lines.push(f);
    }
    const ms = (s: number) => Math.round(s * 1000);
    await ffmpeg([
      ...out.lines.flatMap((f) => ["-i", f]),
      "-filter_complex",
      `${out.lines.map((_, k) => `[${k}:a]adelay=${ms(timing.starts[k])}[v${k}]`).join(";")};${out.lines.map((_, k) => `[v${k}]`).join("")}amix=inputs=${out.lines.length}:normalize=0,apad,atrim=0:${o.seconds.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
      "-map", "[out]", "-ar", "44100", "-ac", "1", "-b:a", "128k", out.file,
    ]);
    return { ok: true, track: out };
  } catch (e) {
    if (!o.signal?.aborted) console.error("voice-track: the recording failed", e);
    return null;
  } finally {
    if (cloneId && cart) await cart.remove(cloneId);
  }
}
