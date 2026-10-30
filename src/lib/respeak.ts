import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { elevenLabs, type VoiceKit } from "./elevenlabs.ts";
import { spokenForm } from "./film-rules.ts";
import { listener } from "./listen.ts";
import { sameSound } from "./listen-rules.ts";
import { cartesia } from "./cartesia.ts";
import {
  RESPEAK,
  cloneText,
  planFixes,
  nextSpeed,
  stretchNeeded,
  takeSays,
  takeSpan,
  unsaidLines,
  lineWords,
  localNamesOnly,
  takeSaysLoosely,
  brokenFixes,
  UNSAID_MAX_TEMPO,
  type RespeakReport,
  type WordFix,
} from "./respeak-rules.ts";

/**
 * A film's wrong words said again in the presenter's own voice, and nothing
 * else changed (`respeak-rules.ts` decides; `scripts/voicefix.py` does the
 * sound). In order: hear every word with its time, decide what to fix, split
 * her voice from the music, clone her voice from the film, have the clone say
 * each line holding a fix until a take says it right, cut the word from the
 * take and set it into her voice, and put the sound back on the film.
 *
 * Never a reason to lose a film: anything that goes wrong returns the film as
 * it was, with the reason. The clone is deleted whatever happens.
 *
 * Imports are relative because the worker runs this straight from source.
 */

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const SCRIPT = join(process.cwd(), "scripts", "voicefix.py");

export type RespeakResult =
  | { ok: true; film: string | null; report: RespeakReport }
  | { ok: false; code: string; message: string; report?: RespeakReport };

export type RespeakDriver = (input: { raw: string; dir: string; lines: string[]; signal?: AbortSignal }) => Promise<RespeakResult>;

const emptyReport = (): RespeakReport => ({ fixed: [], skipped: [], chars: 0, takes: 0, heardSeconds: 0 });

/** Seconds of her own voice given to Cartesia either side of a word, the least worth giving, and tries a word. */
const JOIN_CONTEXT = 3;
const JOIN_CONTEXT_MIN = 0.25;
const JOIN_TRIES = 2;

async function ffmpeg(args: string[]) {
  await run(FFMPEG, ["-v", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });
}

async function seconds(path: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(String(stdout).trim()) || 0;
}

/** The integrated loudness of a file, in LUFS. */
async function lufs(path: string): Promise<number> {
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const m = [...String(stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > -70 ? v : -20;
}

async function python(args: string[], signal?: AbortSignal): Promise<string> {
  const py = process.env.VOICEFIX_PYTHON || "python";
  const { stdout } = await run(py, [SCRIPT, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000, signal, windowsHide: true });
  return String(stdout);
}

export function respeakWith(kit: VoiceKit): RespeakDriver {
  return async ({ raw, dir, lines, signal }) => {
    if (process.env.RESPEAK === "off") return { ok: false, code: "OFF", message: "Switched off on this machine." };
    if (!process.env.ELEVENLABS_API_KEY) return { ok: false, code: "NO_KEY", message: "The voice service is not set up." };
    const report = emptyReport();
    const work = join(dir, "respeak");
    await mkdir(work, { recursive: true });
    const orig = join(work, "orig.wav");
    await ffmpeg(["-i", raw, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", orig]);
    const length = await seconds(orig);

    // ---- what she said, word by word ------------------------------------------
    const mp3 = join(work, "heard.mp3");
    await ffmpeg(["-i", orig, "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3]);
    const heard = await kit.words({ bytes: await readFile(mp3), type: "audio/mpeg" }, signal);
    if (!heard.ok) return { ok: false, code: heard.code, message: heard.message };
    report.heardSeconds += length;
    report.words = heard.words;
    // A word she left out has nowhere to go; the film's own transcript check
    // names it. A whole line she never said is said in her voice where it
    // belongs, when there is room for it (`unsaidLines()`).
    // The listener hears the sound itself and decides which words were said
    // wrong (`listen-rules.ts`); the transcript only times them. With nobody
    // to listen, the transcript decides as before.
    const listen = listener();
    const listened = listen ? await listen.film(await readFile(mp3), lines.map(spokenForm), signal).catch(() => null) : null;
    if (listened) report.listened = listened;
    const { fixes } = planFixes(lines, heard.words, length, listened);
    const unsaid = unsaidLines(lines, heard.words, length);
    if (!fixes.length && !unsaid.length) return { ok: true, film: null, report };

    // ---- her voice apart from the music, and a clone of it --------------------
    const sep = join(work, "sep");
    // Asked twice: a separation that failed once on 2 October 2026 ran clean
    // the next time on the same file, and without it nothing is fixed.
    for (let attempt = 1; attempt <= 2 && !existsSync(join(sep, "vocals.wav")) && !signal?.aborted; attempt++) {
      try {
        await python(["separate", orig, sep], signal);
      } catch (e) {
        const x = e as { message?: string; stderr?: unknown };
        console.error(`respeak: separation failed (try ${attempt}):`, String(x.message ?? e).slice(0, 300), String(x.stderr ?? "").slice(-800));
      }
    }
    if (!existsSync(join(sep, "vocals.wav"))) {
      return { ok: false, code: "NO_SEPARATION", message: "Her voice could not be separated from the music on this machine.", report };
    }
    const sample = join(work, "sample.wav");
    await ffmpeg(["-i", join(sep, "vocals.wav"), "-ac", "1", "-af", "loudnorm=I=-18:TP=-2", "-ar", "44100", sample]);

    type Take = { wav: string; start: number; end: number };
    // Every take that said a fix right goes to the patch, which measures her
    // word and each take's the same way and keeps the nearest in length; the
    // timings here (the transcriber's and the voice's own) only steer the pace.
    const chosen: { fix: WordFix; id: string; takes: Take[] }[] = [];
    const added: { line: number; wav: string; start: number; tempo: number }[] = [];

    // ---- Cartesia first: the word joined in between her own words -------------
    // Her voice in the film is kept whole (the client, 20 October 2026: replace
    // only the words said wrong, never the voice). Cartesia's infill is given
    // her own voice just before and just after the word, in a clone of the
    // film's voice, so the word runs on from what she said and into what she
    // says next. A join is kept only when the transcriber hears the words in it
    // and the listener hears them said right in their place; anything else
    // falls back to the ElevenLabs clone below.
    const vocals = join(sep, "vocals.wav");
    const cart = cartesia();
    const cartFixed = new Set<WordFix>();
    const cartAdded = new Set<number>();
    if (cart && (fixes.length || unsaid.length)) {
      const cid = await cart.clone(await readFile(sample), `film-${Date.now().toString(36)}`, signal).catch(() => null);
      if (cid) {
        try {
          const cut = async (from: number, to: number, out: string): Promise<string | null> => {
            const a = Math.max(0, from);
            const b = Math.min(length, to);
            if (b - a < JOIN_CONTEXT_MIN) return null;
            await ffmpeg(["-ss", a.toFixed(3), "-t", (b - a).toFixed(3), "-i", vocals, "-ac", "1", "-ar", "44100", out]);
            return out;
          };
          /** The words between two stretches of her voice, as a trimmed 44.1 kHz take; null when it is not heard right. */
          // Each try is asked one way of writing the words: as said first, then
          // with a local name respelled the way a clone has said it right
          // (Cartesia said "Goregao" as "Gorigao"; it says "Goregaon" itself).
          const joinWords = async (o: { id: string; start: number; end: number; transcripts: string[]; line: number; from: number; to: number; words: string }): Promise<{ wav: string; len: number } | null> => {
            const left = await cut(o.start - JOIN_CONTEXT, o.start - 0.02, join(work, `cj-${o.id}-left.wav`));
            const right = await cut(o.end + 0.02, o.end + JOIN_CONTEXT, join(work, `cj-${o.id}-right.wav`));
            if (!left && !right) return null;
            for (let attempt = 1; attempt <= JOIN_TRIES; attempt++) {
              if (signal?.aborted) return null;
              const transcript = o.transcripts[Math.min(attempt, o.transcripts.length) - 1];
              const mid = await cart.infill(
                { voiceId: cid, left: left ? await readFile(left) : null, right: right ? await readFile(right) : null, transcript },
                signal,
              );
              report.takes++;
              report.chars += transcript.length;
              if (!mid) continue;
              const base = join(work, `cj-${o.id}-${attempt}`);
              await writeFile(`${base}-raw.wav`, mid);
              await ffmpeg([
                "-i", `${base}-raw.wav`, "-ac", "1", "-ar", "44100",
                "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse",
                `${base}.wav`,
              ]);
              const len = await seconds(`${base}.wav`).catch(() => 0);
              if (!len) continue;
              // The transcriber hears the words in the join on their own.
              const h = await kit.words({ bytes: await readFile(`${base}.wav`), type: "audio/wav" }, signal);
              report.heardSeconds += len;
              const says = h.ok && takeSays(lines[o.line], o.from, o.to, h.text);
              // The listener hears them in their place, between her own words.
              const joined = `${base}-joined.mp3`;
              const parts = [left, `${base}.wav`, right].filter((x): x is string => !!x);
              await ffmpeg([
                ...parts.flatMap((x) => ["-i", x]),
                "-filter_complex", `${parts.map((_, k) => `[${k}:a]`).join("")}concat=n=${parts.length}:v=0:a=1`,
                "-ac", "1", "-b:a", "96k", joined,
              ]);
              const ok = listen ? await listen.take(await readFile(joined), spokenForm(lines[o.line]), o.words, signal).catch(() => null) : null;
              console.log(`respeak: "${o.words}" joined by Cartesia, try ${attempt}: heard ${JSON.stringify(h.ok ? h.text : "")}, the listener says ${ok === null ? "nothing" : ok ? "right" : "wrong"}`);
              // A local name the transcriber spells its own way ("Pikroli") is the listener's to judge alone.
              // A local name the transcriber spells its own way passes when what it heard sounds like the name;
              // the listener's yes alone let "Abundant" stand for Bhandup (21 October 2026).
              const named = ok === true && h.ok && localNamesOnly(o.words.split(" ")) && sameSound(o.words, h.text);
              if ((says || named) && ok !== false) return { wav: `${base}.wav`, len };
            }
            return null;
          };
          for (const f of fixes) {
            const transcripts = [lineWords(lines[f.line]), lineWords(cloneText(lines[f.line]))].map((w) => w.slice(f.from, f.to).join(" "));
            const got = await joinWords({ id: `${f.line}-${f.from}`, start: f.start, end: f.end, transcripts, line: f.line, from: f.from, to: f.to, words: f.words.join(" ") });
            if (!got) continue;
            chosen.push({ fix: f, id: `${f.line}:${f.from}`, takes: [{ wav: got.wav, start: 0, end: got.len }] });
            cartFixed.add(f);
          }
          for (const u of unsaid) {
            const want = lineWords(lines[u.line]).length;
            const got = await joinWords({ id: `u${u.line}`, start: u.start, end: u.start + u.room, transcripts: [spokenForm(lines[u.line]), cloneText(lines[u.line])], line: u.line, from: 0, to: want, words: spokenForm(lines[u.line]) });
            if (!got) continue;
            const tempo = Math.max(1, got.len / u.room);
            if (tempo > UNSAID_MAX_TEMPO) continue;
            added.push({ line: u.line, wav: got.wav, start: u.start, tempo });
            cartAdded.add(u.line);
          }
        } finally {
          await cart.remove(cid);
        }
      }
    }
    const restFixes = fixes.filter((f) => !cartFixed.has(f));
    const restUnsaid = unsaid.filter((u) => !cartAdded.has(u.line));

    // ---- what Cartesia could not join, said by an ElevenLabs clone -------------
    const cloned = restFixes.length || restUnsaid.length
      ? await kit.clone(`film-${Date.now().toString(36)}`, { bytes: await readFile(sample), type: "audio/wav" }, signal)
      : null;
    const voice = cloned?.ok ? cloned : null;
    if (cloned && !cloned.ok) {
      for (const f of restFixes) report.skipped.push({ words: f.words.join(" "), heard: f.heard, at: f.start, why: "Her voice could not be made to say it right." });
      for (const u of restUnsaid) report.skipped.push({ words: lines[u.line], heard: "", at: u.start, why: "The film never said it, and her voice could not be made to say it." });
    }
    try {
      // ---- a line the film never said, said whole --------------------------------
      for (const u of voice ? restUnsaid : []) {
        const text = cloneText(lines[u.line]);
        const want = lineWords(lines[u.line]).length;
        const previous = lines.slice(Math.max(0, u.line - 2), u.line).map(cloneText).join(" ");
        const next = lines.slice(u.line + 1, u.line + 2).map(cloneText).join(" ");
        for (let seed = 1; seed <= RESPEAK.takesPerLine; seed++) {
          if (signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", report };
          const said = await kit.speak({ voiceId: voice!.voiceId, text, previous, next, seed, speed: RESPEAK.startSpeed }, signal);
          report.chars += text.length;
          report.takes++;
          if (!said.ok) continue;
          const base = join(work, `line-${u.line}-${seed}`);
          await writeFile(`${base}.mp3`, said.bytes);
          // Trimmed of the silence either side, so its length is the words'.
          await ffmpeg(["-i", `${base}.mp3`, "-ac", "1", "-ar", "44100", "-af", "silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.3", `${base}.wav`]);
          const h = await kit.words({ bytes: said.bytes, type: "audio/mpeg" }, signal);
          const len = await seconds(`${base}.wav`).catch(() => 0);
          report.heardSeconds += len;
          if (!h.ok || !takeSays(lines[u.line], 0, want, h.text) || !len) continue;
          // And heard by the listener saying every word right.
          if (listen && (await listen.take(said.bytes, spokenForm(lines[u.line]), undefined, signal).catch(() => null)) === false) continue;
          const tempo = Math.max(1, len / u.room);
          if (tempo > UNSAID_MAX_TEMPO) continue;
          added.push({ line: u.line, wav: `${base}.wav`, start: u.start, tempo });
          break;
        }
        if (!added.some((a) => a.line === u.line)) {
          report.skipped.push({ words: lines[u.line], heard: "", at: u.start, why: "The film never said it, and her voice could not be made to say it in the time there." });
        }
      }
      const byLine = new Map<number, WordFix[]>();
      for (const f of voice ? restFixes : []) byLine.set(f.line, [...(byLine.get(f.line) ?? []), f]);
      for (const [line, todo] of byLine) {
        const text = cloneText(lines[line]);
        const previous = lines.slice(Math.max(0, line - 2), line).map(cloneText).join(" ");
        const next = lines.slice(line + 1, line + 2).map(cloneText).join(" ");
        // Each fix keeps the take whose word is nearest her own word's length,
        // because a word stretched to fit sounds stretched: a Goregaon pulled out
        // by a fifth came back washed out ("Gorego") on 29 September 2026. The
        // takes stop once every fix has one within `RESPEAK.closeEnough`, and
        // each take after the first is asked at the pace her words need
        // (`nextSpeed()`): the clone said Goregaon a fifth quicker than she did
        // in two takes out of three.
        const best = new Map<WordFix, number>();
        const takes = new Map<WordFix, Take[]>();
        const settled = () => todo.every((f) => (best.get(f) ?? Infinity) <= RESPEAK.closeEnough);
        let speed: number = RESPEAK.startSpeed;
        for (let seed = 1; seed <= RESPEAK.takesPerLine && !settled(); seed++) {
          if (signal?.aborted) return { ok: false, code: "STOPPED", message: "Stopped.", report };
          const said = await kit.speak({ voiceId: voice!.voiceId, text, previous, next, seed, speed }, signal);
          report.chars += text.length;
          report.takes++;
          if (!said.ok) continue;
          const base = join(work, `take-${line}-${seed}`);
          await writeFile(`${base}.mp3`, said.bytes);
          await ffmpeg(["-i", `${base}.mp3`, "-ac", "1", "-ar", "44100", `${base}.wav`]);
          // A name is heard twice: the transcriber writes a name it knows whichever way it was said.
          const passes = todo.some((f) => f.reason === "name") ? 2 : 1;
          const heardTake: string[] = [];
          for (let p = 0; p < passes; p++) {
            const h = await kit.words({ bytes: said.bytes, type: "audio/mpeg" }, signal);
            heardTake.push(h.ok ? h.text : "");
            report.heardSeconds += await seconds(`${base}.wav`).catch(() => 0);
          }
          const ratios: number[] = [];
          for (const f of todo) {
            const span = takeSpan(said.alignment, f.from, f.to);
            // A name is never paced to a rushed slot: it is said at its own length.
            const name = f.reason === "name";
            if (span && !f.final && !name) ratios.push((f.end - f.start) / Math.max(0.05, span.end - span.start));
            // Why a take was turned down, so a word that is never fixed can be traced.
            console.log(
              `respeak: "${f.words.join(" ")}" take ${seed}: heard ${JSON.stringify(heardTake)}, ` +
                `${span ? `${(span.end - span.start).toFixed(2)} s` : "not found"}`,
            );
            if (!span) continue;
            const transcribed = heardTake.every((t) => takeSays(lines[line], f.from, f.to, t));
            // A local name the transcriber spells its own way is the listener's to judge alone.
            const loosely = !transcribed && !!listen && localNamesOnly(f.words) && heardTake.every((t) => takeSaysLoosely(lines[line], f.from, f.to, t));
            if (!transcribed && !loosely) continue;
            // The listener hears the take too: a take it hears saying these words wrong is never used.
            const listenedOk = listen ? await listen.take(said.bytes, spokenForm(lines[line]), f.words.join(" "), signal).catch(() => null) : null;
            console.log(`respeak: "${f.words.join(" ")}" take ${seed}: the listener says ${listenedOk === null ? "nothing" : listenedOk ? "right" : "wrong"}`);
            if (listenedOk === false || (!transcribed && listenedOk !== true)) continue;
            // A take heard saying the word right is right, however long it took to say it
            // (the client, 9 October 2026: a length floor threw away every correct Goregaon).
            const off = stretchNeeded(f.end - f.start, span.end - span.start);
            takes.set(f, [...(takes.get(f) ?? []), { wav: `${base}.wav`, ...span }]);
            best.set(f, Math.min(off, best.get(f) ?? Infinity));
          }
          speed = nextSpeed(speed, ratios);
        }
        for (const f of todo) {
          const t = takes.get(f);
          if (t?.length) chosen.push({ fix: f, id: `${line}:${f.from}`, takes: t });
          else report.skipped.push({ words: f.words.join(" "), heard: f.heard, at: f.start, why: "Her voice could not be made to say it right." });
        }
      }
    } finally {
      if (voice) await kit.remove(voice.voiceId);
    }
    if (!chosen.length && !added.length) return { ok: true, film: null, report };

    // ---- set into her voice, and back on the film -----------------------------
    const job = join(work, "job.json");
    let fixedWav = join(work, "fixed.wav");
    const patch = async (list: typeof chosen) => {
      await writeFile(
        job,
        JSON.stringify({
          orig,
          vocals: join(sep, "vocals.wav"),
          music: join(sep, "music.wav"),
          out: fixedWav,
          maxStretch: RESPEAK.maxStretch,
          fixes: list.map((c) => ({
            id: c.id,
            her: {
              start: c.fix.start,
              end: c.fix.end,
              final: c.fix.final,
              room: c.fix.room,
              // A name is said at its own length, her next words waiting for it;
              // so is a word that ends its sentence. Fitted to her slot, the
              // whispered "pause." of 17 October 2026 came back half a word.
              ...(c.fix.reason === "name" || c.fix.final ? { natural: true } : {}),
            },
            takes: c.takes,
          })),
        }),
      );
      await python(["patch", job], signal);
    };
    if (chosen.length) {
      try {
        // Heard back once patched: a fix that left a word twice, cut into the
        // word beside it or does not sound like the word is taken out and her
        // own sound kept there (21 October 2026: "Purulia East", "a, a minute").
        for (let pass = 0; chosen.length && pass < 3; pass++) {
          await patch(chosen);
          const back = join(work, `patched-${pass}.mp3`);
          await ffmpeg(["-i", fixedWav, "-ac", "1", "-ar", "16000", "-b:a", "48k", back]);
          const h = await kit.words({ bytes: await readFile(back), type: "audio/mpeg" }, signal);
          report.heardSeconds += length;
          if (!h.ok) break;
          const broken = new Set(brokenFixes(lines, h.words, chosen.map((c) => c.fix)));
          if (!broken.size) break;
          for (const c of chosen.filter((x) => broken.has(x.fix))) {
            console.log(`respeak: "${c.fix.words.join(" ")}" did not sound right in place; her own sound is kept`);
            report.skipped.push({ words: c.fix.words.join(" "), heard: c.fix.heard, at: c.fix.start, why: "The fix did not sound right in place, so her own voice is kept." });
          }
          const kept = chosen.filter((x) => !broken.has(x.fix));
          chosen.length = 0;
          // A third patch that still breaks something keeps her own sound throughout.
          if (pass === 2) {
            for (const c of kept) report.skipped.push({ words: c.fix.words.join(" "), heard: c.fix.heard, at: c.fix.start, why: "The fix did not sound right in place, so her own voice is kept." });
          } else chosen.push(...kept);
        }
        if (!chosen.length) fixedWav = orig;
      } catch {
        for (const c of chosen) report.skipped.push({ words: c.fix.words.join(" "), heard: c.fix.heard, at: c.fix.start, why: "The fix could not be set into the film." });
        chosen.length = 0;
        fixedWav = orig;
      }
      if (!chosen.length && !added.length) return { ok: true, film: null, report };
    } else fixedWav = orig;
    // A missing line laid over the sound at her own loudness.
    if (added.length) {
      const loud = await lufs(join(sep, "vocals.wav")).catch(() => -20);
      const withLines = join(work, "with-lines.wav");
      const inputs = added.flatMap((a) => ["-i", a.wav]);
      const chains = added.map((a, k) => {
        const ms = Math.round(a.start * 1000);
        return `[${k + 1}:a]${a.tempo > 1.001 ? `atempo=${a.tempo.toFixed(3)},` : ""}loudnorm=I=${loud.toFixed(1)}:TP=-2,aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[l${k}]`;
      });
      const mix = `[0:a]${added.map((_, k) => `[l${k}]`).join("")}amix=inputs=${added.length + 1}:normalize=0:duration=first[out]`;
      try {
        await ffmpeg(["-i", fixedWav, ...inputs, "-filter_complex", [...chains, mix].join(";"), "-map", "[out]", "-ar", "44100", "-c:a", "pcm_s16le", withLines]);
        fixedWav = withLines;
        for (const a of added) (report.added ??= []).push({ words: lines[a.line], at: a.start });
      } catch {
        for (const a of added) report.skipped.push({ words: lines[a.line], heard: "", at: a.start, why: "The film never said it, and her line could not be set into the film." });
        if (!chosen.length) return { ok: true, film: null, report };
      }
    }
    const film = join(dir, "film-voiced.mp4");
    await ffmpeg(["-i", raw, "-i", fixedWav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", film]);
    for (const c of chosen) report.fixed.push({ words: c.fix.words.join(" "), heard: c.fix.heard, at: c.fix.start, reason: c.fix.reason });
    return { ok: true, film, report };
  };
}

export const respeakFilm: RespeakDriver = respeakWith(elevenLabs);
