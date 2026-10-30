import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { elevenLabs, type VoiceKit } from "./elevenlabs.ts";
import { spokenFormIn } from "./film-language-rules.ts";
import { bleedFilter, bleedSpans, fitTake, LOCAL_VOICE, linesToFix, localSpans, namesBroken, sayLine, strayHeard, takeWrong, VOICEOVER, voiceoverPlaces, voiceoverText, type Heard, type VoiceCode } from "./local-voice-rules.ts";
import type { RespeakDriver, RespeakResult } from "./respeak.ts";
import type { RespeakReport } from "./respeak-rules.ts";
import type { HearDriver } from "./generate.ts";
import { makeBed, mixBed } from "./film-sound.ts";
import type { SoundScene } from "./film-sound-rules.ts";

/**
 * The voice fix for a film in Hindi or Marathi (`local-voice-rules.ts` says
 * why and what). Demucs takes the narrator's voice apart from the music,
 * ElevenLabs Scribe hears it word by word in its own script, every line
 * holding a word heard wrong (or a name, or a price unit) is said again
 * whole by Sarvam's clone of the narrator's voice from the film itself,
 * Saaras hears each take back, and a take that is right goes in where the
 * line was. ElevenLabs' clone is the fall-back when Sarvam's never gets a
 * line right. `SARVAM_API_KEY`, `ELEVENLABS_API_KEY`, `VOICEFIX_PYTHON`;
 * `LOCAL_RESPEAK=off` switches it off. `doc/pricing.md` prices it.
 *
 * Imports are relative because the worker runs this straight from source.
 */

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const SCRIPT = join(process.cwd(), "scripts", "voicefix.py");
const SARVAM = "https://api.sarvam.ai";

const ffmpeg = (args: string[]) => run(FFMPEG, ["-v", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
async function seconds(path: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { windowsHide: true });
  return Number(String(stdout).trim()) || 0;
}
async function python(args: string[], signal?: AbortSignal): Promise<string> {
  const py = process.env.VOICEFIX_PYTHON || "python";
  const { stdout } = await run(py, [SCRIPT, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000, signal, windowsHide: true });
  return String(stdout);
}

const langCode = (code: VoiceCode) => (code === "mr" ? "mr-IN" : code === "en" ? "en-IN" : "hi-IN");
/** ElevenLabs Scribe's name for the language. */
const scribeCode = (code: VoiceCode) => (code === "mr" ? "mar" : code === "en" ? "en" : "hin");

/** A file's integrated loudness in LUFS, measured with FFmpeg's EBU R128 pass. */
async function loudness(path: string): Promise<number> {
  const r = await run(FFMPEG, ["-hide_banner", "-i", path, "-af", "ebur128", "-f", "null", "-"], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }).catch(
    (e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }),
  );
  // The summary's integrated loudness, the last "I:" the pass prints.
  const all = [...String(r.stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  const m = all[all.length - 1];
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > -70 ? v : -23;
}

/** What Sarvam's Saaras hears in a clip of up to 30 seconds, in Devanagari. */
export async function saarasHears(bytes: Buffer, code: VoiceCode, signal?: AbortSignal): Promise<string | null> {
  const key = process.env.SARVAM_API_KEY?.trim();
  if (!key) return null;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "clip.wav");
  form.append("model", process.env.STT_MODEL || "saaras:v3");
  form.append("mode", "transcribe");
  form.append("language_code", langCode(code));
  const r = await fetch(`${SARVAM}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as { transcript?: string } | null;
  return typeof j?.transcript === "string" ? j.transcript.trim() : null;
}

/** A line in Sarvam's clone of the voice in a reference clip, as WAV. */
async function sarvamSays(text: string, ref: { bytes: Buffer; text: string }, code: "hi" | "mr", signal?: AbortSignal): Promise<Buffer | null> {
  const key = process.env.SARVAM_API_KEY?.trim();
  if (!key) return null;
  const form = new FormData();
  form.append("ref_audio", new Blob([new Uint8Array(ref.bytes)], { type: "audio/wav" }), "ref.wav");
  if (ref.text) form.append("ref_text", ref.text);
  form.append("text", text);
  form.append("language_code", langCode(code));
  form.append("enable_qc", "true");
  const r = await fetch(`${SARVAM}/voices/clone`, {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  }).catch(() => null);
  if (!r?.ok) {
    if (r) console.warn(`local-voice: Sarvam's clone answered ${r.status}`, (await r.text().catch(() => "")).slice(0, 200));
    return null;
  }
  const j = (await r.json().catch(() => null)) as { audio?: string; audio_b64?: string } | null;
  const b64 = j?.audio ?? j?.audio_b64;
  return b64 ? Buffer.from(b64, "base64") : null;
}

/** What a Hindi or Marathi film's voice says, for the checks: heard in its own script, a half at a time. */
export function hearLocal(code: "hi" | "mr"): HearDriver {
  return async (req, opts) => {
    const dir = await mkdtemp(join(tmpdir(), "salesdesk-hear-"));
    try {
      const src = join(dir, "in.mp3");
      await writeFile(src, req.audio.bytes);
      const total = await seconds(src);
      const parts: string[] = [];
      // Saaras takes 30 seconds at most.
      for (let at = 0; at < total; at += 25) {
        const piece = join(dir, `p${at}.wav`);
        await ffmpeg(["-ss", String(at), "-t", "25", "-i", src, "-ac", "1", "-ar", "16000", piece]);
        const h = await saarasHears(await readFile(piece), code, opts?.signal);
        if (h === null) return { ok: false, code: "UNREACHABLE", message: "The transcriber did not answer." };
        parts.push(h);
      }
      return { ok: true, text: parts.join(" ") };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  };
}

/** The voice fix for a film in `code`, in the shape the film worker takes (`RespeakDriver`). */
export function localRespeak(code: "hi" | "mr", kit: VoiceKit = elevenLabs): RespeakDriver {
  return async ({ raw, dir, lines, signal }): Promise<RespeakResult> => {
    const report: RespeakReport = { fixed: [], skipped: [], chars: 0, takes: 0, heardSeconds: 0 };
    if (process.env.LOCAL_RESPEAK === "off") return { ok: false, code: "OFF", message: "The voice fix is switched off." };
    if (!process.env.SARVAM_API_KEY) return { ok: false, code: "NO_KEY", message: "Sarvam is not set up." };
    const P = (f: string) => join(dir, `local-${f}`);
    try {
      // ---- her voice apart from the music --------------------------------------
      await ffmpeg(["-i", raw, "-vn", "-ac", "2", "-ar", "44100", P("audio.wav")]);
      await python(["separate", P("audio.wav"), P("sep")], signal);
      const vocals = join(P("sep"), "vocals.wav");
      const length = await seconds(P("audio.wav"));

      // ---- every word heard, in its own script ----------------------------------
      await ffmpeg(["-i", vocals, "-ac", "1", "-ar", "16000", P("vocals16.wav")]);
      const scribe = await kit.words({ bytes: await readFile(P("vocals16.wav")), type: "audio/wav" }, signal, code === "mr" ? "mar" : "hin");
      if (!scribe.ok) return { ok: false, code: scribe.code, message: scribe.message, report };
      report.heardSeconds += length;
      const heard: Heard[] = scribe.words;
      report.words = heard;
      const spans = localSpans(lines, heard, code);
      report.spans = spans;
      // Each line heard again on its own by Saaras, in Devanagari, which is
      // what decides whether it was said right: Scribe writes an English word
      // in English letters, and only times the words.
      const lineHeard: (string | null)[] = [];
      for (const [i, sp] of spans.entries()) {
        if (!sp) {
          lineHeard.push(null);
          continue;
        }
        const cut = P(`said-${i}.wav`);
        await ffmpeg(["-ss", Math.max(0, sp.start - 0.1).toFixed(2), "-to", Math.min(length, sp.end + 0.15).toFixed(2), "-i", vocals, "-ac", "1", "-ar", "16000", cut]);
        lineHeard.push(await saarasHears(await readFile(cut), code, signal));
        report.heardSeconds += sp.end - sp.start;
      }
      const todo = linesToFix(lines, lineHeard, code);
      // Words nobody wrote, said between the lines, are taken out of the voice.
      const strays = strayHeard(lines, heard, code);
      for (const w of strays) report.skipped.push({ words: w.text, heard: w.text, at: w.start, why: "Said by the video's voice but in no line, so it was taken out." });
      if (!todo.length && !strays.length) return { ok: true, film: null, report };

      // ---- the narrator's own voice, as the clone's reference --------------------
      await ffmpeg([
        "-i", vocals, "-af", "silenceremove=stop_periods=-1:stop_duration=0.25:stop_threshold=-38dB,highpass=f=70",
        "-t", String(LOCAL_VOICE.refSeconds), "-ac", "1", "-ar", "24000", P("ref.wav"),
      ]);
      const refBytes = await readFile(P("ref.wav"));
      const refText = (await saarasHears(refBytes, code, signal)) ?? "";
      report.heardSeconds += LOCAL_VOICE.refSeconds;
      let elevenVoice: string | null = null;

      const swaps: { take: string; start: number; end: number }[] = [];
      for (const fix of todo) {
        if (signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", report };
        const line = lines[fix.line];
        const place = spans[fix.line];
        if (!place) {
          report.skipped.push({ words: line, heard: "", at: 0, why: "This line was not heard, so it could not be put back in its place." });
          continue;
        }
        const next = spans.slice(fix.line + 1).find((s) => s)?.start ?? length;
        const text = spokenFormIn(line, code);
        let kept: { file: string; fit: { tempo: number; end: number } } | null = null;
        let lastHeard = "";
        for (let t = 0; t < LOCAL_VOICE.sarvamTakes + LOCAL_VOICE.elevenTakes && !kept; t++) {
          const sarvam = t < LOCAL_VOICE.sarvamTakes;
          let bytes: Buffer | null = null;
          if (sarvam) bytes = await sarvamSays(text, { bytes: refBytes, text: refText }, code, signal);
          else {
            if (!elevenVoice) {
              const c = await kit.clone(`salesdesk-local-${Date.now()}`, { bytes: refBytes, type: "audio/wav" }, signal);
              elevenVoice = c.ok ? c.voiceId : "";
            }
            if (elevenVoice) {
              const s = await kit.speak({ voiceId: elevenVoice, text, previous: "", next: "", seed: 7 + t }, signal);
              bytes = s.ok ? s.bytes : null;
            }
          }
          report.takes++;
          report.chars += text.length;
          if (!bytes) continue;
          const take = P(`l${fix.line}-t${t}.wav`);
          await writeFile(P(`l${fix.line}-t${t}.raw`), bytes);
          // Its own silence off both ends.
          await ffmpeg([
            "-i", P(`l${fix.line}-t${t}.raw`),
            "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse",
            "-ac", "1", "-ar", "44100", take,
          ]);
          lastHeard = (await saarasHears(await readFile(take), code, signal)) ?? "";
          report.heardSeconds += 5;
          if (!lastHeard || takeWrong(line, lastHeard, code).length) continue;
          const fit = fitTake(await seconds(take), place, next);
          if (!fit) continue;
          kept = { file: take, fit };
        }
        if (!kept) {
          report.skipped.push({ words: line, heard: lastHeard || fix.heard, at: place.start, why: "No take of it in the narrator's voice was heard right." });
          continue;
        }
        const fitted = P(`l${fix.line}-fit.wav`);
        await ffmpeg(["-i", kept.file, "-af", `atempo=${kept.fit.tempo.toFixed(4)}`, fitted]);
        swaps.push({ take: fitted, start: place.start, end: place.end });
        spans[fix.line] = { start: place.start, end: kept.fit.end };
        report.fixed.push({ words: line, heard: fix.heard, at: place.start, reason: fix.reason === "misheard" ? "misheard" : "name" });
      }
      if (elevenVoice) await kit.remove(elevenVoice).catch(() => null);
      if (!swaps.length && !strays.length) return { ok: true, film: null, report };

      // ---- the lines put in, and the film's sound otherwise as it came ----------
      const mutes = strays.map((w) => ({ start: w.start, end: w.end }));
      await writeFile(P("job.json"), JSON.stringify({ audio: P("audio.wav"), vocals, out: P("fixed.wav"), swaps, mutes }));
      await python(["lines", P("job.json")], signal);
      const film = join(dir, "film-voiced.mp4");
      await ffmpeg(["-i", raw, "-i", P("fixed.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", film]);
      report.spans = spans;
      return { ok: true, film, report };
    } catch (e) {
      if (signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", report };
      console.error("local-voice: failed", e);
      return { ok: false, code: "FAILED", message: "The voice could not be checked.", report };
    }
  };
}

/** A line in an ElevenLabs v3 library voice, as MP3. */
async function elevenSays(voiceId: string, text: string, code: VoiceCode, seed: number, signal?: AbortSignal): Promise<Buffer | null> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) return null;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_192`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: process.env.LOCAL_VO_MODEL || VOICEOVER.model, language_code: code, seed, voice_settings: { stability: 0.5 } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  }).catch(() => null);
  if (!r?.ok) {
    if (r) console.warn(`local-voice: ElevenLabs answered ${r.status}`, (await r.text().catch(() => "")).slice(0, 200));
    return null;
  }
  return Buffer.from(await r.arrayBuffer());
}

/**
 * A Hindi or Marathi story's narration, recorded on its own and laid over the
 * film (`VOICEOVER` says why). The film comes with its score and no voice;
 * any voice it made anyway is taken out (Demucs), each line is said by the
 * narrator's voice with its delivery, heard back by Saaras and kept when
 * every word is right, placed where its shot is, and the score ducks under it.
 */
export function localVoiceover(
  code: VoiceCode,
  story: {
    scenes: { line: string; delivery?: string; start: number; end: number }[];
    male: boolean;
    /** The film was made speaking the lines: its voice places the narration, and is taken out. */
    guide?: boolean;
    /** Music and background sound made for the film, in place of its own score (`film-sound.ts`). */
    sound?: { template: string | null; scenes: SoundScene[]; seed: string };
    /**
     * The lines already recorded, in the order said (a presenter's voice
     * track, `voice-track.ts`): laid as they are, never said again, at
     * `at` where the film's own voice cannot place them.
     */
    takes?: readonly string[];
    at?: readonly number[];
    /** The voice the takes are in, for the report. */
    voiceName?: string;
  },
): RespeakDriver {
  return async ({ raw, dir, signal }): Promise<RespeakResult> => {
    const report: RespeakReport = { fixed: [], skipped: [], chars: 0, takes: 0, heardSeconds: 0 };
    if (!process.env.ELEVENLABS_API_KEY && !story.takes) return { ok: false, code: "NO_KEY", message: "The narrator's voice is not set up." };
    const P = (f: string) => join(dir, `vo-${f}`);
    const voice =
      code === "en"
        ? story.male
          ? process.env.EN_VO_MALE || process.env.LOCAL_VO_MALE || VOICEOVER.male
          : process.env.EN_VO_FEMALE || process.env.LOCAL_VO_FEMALE || VOICEOVER.female
        : story.male
          ? process.env.LOCAL_VO_MALE || VOICEOVER.male
          : process.env.LOCAL_VO_FEMALE || VOICEOVER.female;
    try {
      await ffmpeg(["-i", raw, "-vn", "-ac", "2", "-ar", "44100", P("audio.wav")]);
      await python(["separate", P("audio.wav"), P("sep")], signal);
      const music = join(P("sep"), "music.wav");
      const length = await seconds(P("audio.wav"));
      // The film's own music has holes wherever the video model spoke, so its
      // music and background sound are made for it, while the narration is
      // recorded (11 October 2026). Anything that fails keeps the old score.
      const bedMade = story.sound
        ? makeBed({ raw, dir, template: story.sound.template, scenes: story.sound.scenes, seed: story.sound.seed, signal }).catch((e) => {
            console.error("film-sound: failed", e);
            return null;
          })
        : null;
      const spoken = story.scenes.filter((s) => s.line.trim());
      // Where the video model said each line is where the picture shows it:
      // its own voice is a guide track, heard (words wrong or not) and taken
      // out. A line it never said goes where its shot was planned.
      const planned = voiceoverPlaces(story.scenes, length).map((p, i) => (story.at?.[i] !== undefined ? { ...p, at: story.at[i] } : p));
      let guide: ({ start: number; end: number } | null)[] = planned.map(() => null);
      // Every word the video model said, wherever: its leftover in the score is hidden there (`bleedSpans()`).
      let modelWords: { start: number; end: number }[] = [];
      if (story.guide) {
        await ffmpeg(["-i", join(P("sep"), "vocals.wav"), "-ac", "1", "-ar", "16000", P("vocals16.wav")]);
        const heard = await elevenLabs.words({ bytes: await readFile(P("vocals16.wav")), type: "audio/wav" }, signal, scribeCode(code));
        report.heardSeconds += length;
        if (heard.ok) {
          guide = localSpans(spoken.map((x) => x.line), heard.words, code);
          modelWords = heard.words.map((w) => ({ start: w.start, end: w.end }));
        }
      }
      // The first line never waits: the video model's guide began 3.7 s in on
      // a test film, and the hook went by in silence (8 October 2026).
      const starts = planned.map((p, i) => (i === 0 ? Math.min(guide[0]?.start ?? p.at, 0.8) : guide[i]?.start ?? p.at));
      const places = planned.map((p, i) => {
        const next = starts.slice(i + 1).find((x) => x > starts[i]) ?? length - 0.1;
        return { ...p, at: starts[i], room: Math.max(0.6, next - starts[i] - 0.15) };
      });
      const spans: ({ start: number; end: number } | null)[] = places.map(() => null);
      const laid: { file: string; at: number; tempo: number }[] = [];
      for (const place of places) {
        if (signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", report };
        const said = sayLine(place.text, code);
        let best: { file: string; len: number; wrong: number; heard: string } | null = null;
        const recorded = story.takes?.[place.line];
        if (recorded) best = { file: recorded, len: await seconds(recorded), wrong: 0, heard: "" };
        for (let t = 0; !recorded && t < VOICEOVER.takes; t++) {
          const bytes = await elevenSays(voice, voiceoverText(said, spoken[place.line]?.delivery), code, 17 + t * 31 + place.line, signal);
          report.takes++;
          report.chars += said.length;
          if (!bytes) continue;
          const take = P(`l${place.line}-t${t}.wav`);
          await writeFile(P(`l${place.line}-t${t}.mp3`), bytes);
          await ffmpeg([
            "-i", P(`l${place.line}-t${t}.mp3`),
            "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse",
            "-ac", "1", "-ar", "44100", take,
          ]);
          const heard = (await saarasHears(await readFile(take), code, signal)) ?? "";
          report.heardSeconds += 4;
          // A name said in two pieces is a word said wrong, in English.
          const wrong = heard ? takeWrong(place.text, heard, code).length + (code === "en" ? namesBroken(place.text, heard).length : 0) : 99;
          const len = await seconds(take);
          const fits = len <= place.room * VOICEOVER.fastest;
          if (!best || wrong < best.wrong || (wrong === best.wrong && fits && best.len > place.room * VOICEOVER.fastest)) best = { file: take, len, wrong, heard };
          if (!wrong && fits) break;
        }
        if (!best) {
          report.skipped.push({ words: place.text, heard: "", at: place.at, why: "The narrator's voice could not be made for this line." });
          continue;
        }
        if (best.wrong) report.skipped.push({ words: place.text, heard: best.heard, at: place.at, why: "No take of it was heard exactly right." });
        // A line that does not fit even sped up starts earlier, into the quiet
        // after the line before it: the film often comes back shorter than
        // planned, and the last line was cut off at its end (8 October 2026).
        const prevEnd = laid.length ? spans.filter((x): x is { start: number; end: number } => !!x).pop()?.end ?? 0 : 0;
        const short = best.len / VOICEOVER.fastest - place.room;
        const at = short > 0 ? Math.max(prevEnd + 0.3, place.at - short) : place.at;
        const room = place.room + (place.at - at);
        const tempo = Math.min(VOICEOVER.fastest, Math.max(1, best.len / room));
        laid.push({ file: best.file, at, tempo });
        spans[place.line] = { start: at, end: at + best.len / tempo };
      }
      if (!laid.length) return { ok: false, code: "FAILED", message: "The narration could not be made.", report };

      // ---- the narration over the score, the score ducking under it -------------
      // Levels are measured first and set as fixed gains: a loudnorm inside
      // the mix holds three seconds back, and the film's last line was lost
      // with them (8 October 2026).
      const inputs = laid.flatMap((x) => ["-i", x.file]);
      const parts = laid.map(
        (x, k) => `[${k}:a]atempo=${x.tempo.toFixed(4)},aformat=channel_layouts=stereo,adelay=${Math.round(x.at * 1000)}|${Math.round(x.at * 1000)}[v${k}]`,
      );
      parts.push(`${laid.map((_, k) => `[v${k}]`).join("")}amix=inputs=${laid.length}:normalize=0,apad,atrim=0:${length.toFixed(3)}[out]`);
      await ffmpeg([...inputs, "-filter_complex", parts.join(";"), "-map", "[out]", "-ar", "44100", P("voice.wav")]);
      const voiceGain = -16 - (await loudness(P("voice.wav")));
      const bed = bedMade ? await bedMade : null;
      if (bed) report.sound = bed.report;
      if (bed?.ok) {
        await mixBed({ voice: P("voice.wav"), voiceGainDb: voiceGain, bed: bed.bed, spans, length, out: P("mix.wav") });
        const film = join(dir, "film-voiced.mp4");
        await ffmpeg(["-i", raw, "-i", P("mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", film]);
        report.spans = spans;
        report.words = spans.flatMap((sp, i) => (sp ? [{ text: places[i]?.text ?? "", start: sp.start, end: sp.end }] : []));
        return { ok: true, film, report };
      }
      if (bed && !bed.ok) console.warn(`film-sound: the film's own score is kept (${bed.report.fallback})`);
      const scoreGain = -24 - (await loudness(music));
      // Where the video model spoke and our narrator does not, its leftover
      // voice in the score is taken out (11 October 2026).
      const bleed = bleedFilter(bleedSpans(modelWords, spans));
      await ffmpeg([
        "-i", music, "-i", P("voice.wav"),
        "-filter_complex",
        `[1:a]volume=${voiceGain.toFixed(2)}dB,asplit=2[voice][key];[0:a]volume=${scoreGain.toFixed(2)}dB${bleed ? `,${bleed}` : ""}[score];` +
          `[score][key]sidechaincompress=threshold=0.04:ratio=4:attack=30:release=400[ducked];` +
          `[ducked][voice]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[mix]`,
        "-map", "[mix]", "-ar", "44100", P("mix.wav"),
      ]);
      const film = join(dir, "film-voiced.mp4");
      await ffmpeg(["-i", raw, "-i", P("mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", film]);
      report.spans = spans;
      // Each line as one heard "word" at its place: what the scene fix keeps clear of, and moves with a scene.
      report.words = spans.flatMap((sp, i) => (sp ? [{ text: places[i]?.text ?? "", start: sp.start, end: sp.end }] : []));
      return { ok: true, film, report };
    } catch (e) {
      if (signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", report };
      console.error("local-voice: the narration failed", e);
      return { ok: false, code: "FAILED", message: "The narration could not be made.", report };
    }
  };
}
