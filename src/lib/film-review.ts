/**
 * The film reviewer as an agent (`film-review-rules.ts` decides): a survey
 * of the whole film with the time on every frame, what was heard with its
 * times, the voice's pitch measured in code, and close looks the agent asks
 * for wherever something happens, then a report of what it saw.
 *
 * Imports are relative because the worker runs this straight from source.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { runAgent, type AgentPicture, type AgentTool } from "./agent.ts";
import type { AgentBrain, AskDriver } from "./generate.ts";
import { CONTEXT_INSTRUCTIONS, CONTEXT_SCHEMA, FILM_CONTEXT_MODEL, readContext, type ContextFinding } from "./film-context-rules.ts";
import type { FilmScript } from "./film-rules.ts";
import { scenesFromCuts } from "./scene-fix-rules.ts";
import {
  FILM_REVIEW_MODEL,
  heardLines,
  MAX_ZOOMS,
  NOTE_PARAMETERS,
  readNote,
  findingsFromNotes,
  type ReviewNote,
  readReport,
  REPORT_PARAMETERS,
  REVIEW_INSTRUCTIONS,
  REVIEW_PASSES,
  mergeFindings,
  REVIEW_MAX_USD,
  REVIEW_TURNS,
  unlooked,
  voiceFromPitch,
  ZOOM_PARAMETERS,
  zoomPlan,
  type ReviewFinding,
} from "./film-review-rules.ts";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const opts = { maxBuffer: 256 * 1024 * 1024, windowsHide: true } as const;

async function probe(path: string): Promise<{ seconds: number; fps: number }> {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate:format=duration", "-of", "json", path], opts);
  const j = JSON.parse(String(stdout)) as { streams?: { r_frame_rate?: string }[]; format?: { duration?: string } };
  const [n, d] = String(j.streams?.[0]?.r_frame_rate ?? "24/1").split("/").map(Number);
  return { seconds: Number(j.format?.duration) || 0, fps: d ? n / d : 24 };
}

async function cutsOf(path: string): Promise<number[]> {
  const { stderr } = await exec(FFMPEG, ["-hide_banner", "-nostats", "-i", path, "-an", "-vf", "select='gt(scene,0.2)',showinfo", "-f", "null", "-"], opts);
  return [...String(stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

/** The frames at these times, each `width` wide, in order. */
async function framesAt(path: string, times: readonly number[], width: number, dir: string): Promise<Buffer[]> {
  return Promise.all(
    times.map(async (t, i) => {
      const out = join(dir, `f-${width}-${i}-${Math.round(t * 1000)}.jpg`);
      await exec(FFMPEG, ["-v", "error", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", path, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", out], opts);
      return readFile(out);
    }),
  );
}

/** Frames laid out in a grid, each with its time printed in its corner. */
async function sheet(frames: readonly Buffer[], times: readonly number[], cols: number): Promise<AgentPicture> {
  const meta = await sharp(frames[0]).metadata();
  const w = meta.width ?? 270;
  const h = meta.height ?? 480;
  const rows = Math.ceil(frames.length / cols);
  const label = (t: number) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="0" width="${Math.round(w * 0.42)}" height="${Math.round(h * 0.06)}" fill="#000"/>` +
        `<text x="6" y="${Math.round(h * 0.045)}" font-family="sans-serif" font-size="${Math.round(h * 0.04)}" font-weight="bold" fill="#ff0">${t.toFixed(2)} s</text></svg>`,
    );
  const bytes = await sharp({ create: { width: w * cols, height: h * rows, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(
      frames.flatMap((f, i) => [
        { input: f, left: (i % cols) * w, top: Math.floor(i / cols) * h },
        { input: label(times[i]), left: (i % cols) * w, top: Math.floor(i / cols) * h },
      ]),
    )
    .jpeg({ quality: 82 })
    .toBuffer();
  return { bytes, type: "image/jpeg", detail: "high" };
}

/**
 * The voice's pitch, the median over the loud stretches: autocorrelation on
 * 64 ms windows of the sound at 16 kHz. Music under a voice pulls it about,
 * which is why only a clear answer is used (`voiceFromPitch()`).
 */
export async function voicePitch(path: string): Promise<number | null> {
  const { stdout } = await exec(FFMPEG, ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { ...opts, encoding: "buffer" } as never);
  const buf = Buffer.from(stdout as unknown as Buffer);
  const a = new Float32Array(buf.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = buf.readInt16LE(i * 2) / 32768;
  const sr = 16000;
  const lo = Math.floor(sr / 400);
  const hi = Math.floor(sr / 70);
  const found: number[] = [];
  for (let i = 0; i + 1024 < a.length; i += 512) {
    let mean = 0;
    let energy = 0;
    for (let j = 0; j < 1024; j++) mean += a[i + j];
    mean /= 1024;
    for (let j = 0; j < 1024; j++) energy += (a[i + j] - mean) ** 2;
    if (Math.sqrt(energy / 1024) < 0.02) continue;
    let best = 0;
    let at = 0;
    for (let k = lo; k <= hi; k++) {
      let c = 0;
      for (let j = 0; j + k < 1024; j++) c += (a[i + j] - mean) * (a[i + j + k] - mean);
      if (c > best) [best, at] = [c, k];
    }
    if (at && best > 0.5 * energy) found.push(sr / at);
  }
  if (found.length < 20) return null;
  found.sort((x, y) => x - y);
  return Math.round(found[Math.floor(found.length / 2)]);
}

/**
 * The context checker (`film-context-rules.ts`): one look at the whole film,
 * a frame a second with its time, what was heard, and the script with each
 * shot's job, asking only whether each shot does its job where it is. Null
 * when it could not look.
 */
export async function checkContext(input: {
  ask: AskDriver;
  raw: string;
  script: FilmScript;
  jobs: readonly string[];
  words: readonly { text: string; start: number; end: number }[] | null;
  /** Scenes were remade over the film's own sound: a person's line is judged by their mouth, not by what is heard. */
  mouthOnly?: boolean;
  signal?: AbortSignal;
}): Promise<ContextFinding[] | null> {
  const dir = await mkdtemp(join(tmpdir(), "salesdesk-context-"));
  try {
    const film = await probe(input.raw);
    const times = Array.from({ length: Math.max(1, Math.floor(film.seconds)) }, (_, i) => Math.min(film.seconds - 0.1, i + 0.5));
    const frames = await framesAt(input.raw, times, 240, dir);
    const sheets: AgentPicture[] = [];
    for (let i = 0; i < frames.length; i += 10) sheets.push(await sheet(frames.slice(i, i + 10), times.slice(i, i + 10), 5));
    const heard = input.words?.length ? heardLines(input.words) : [];
    const shots = input.script.scenes.map(
      (s, i) => `Shot ${i + 1} (${s.kind}): ${s.shot}${s.line ? ` Says: "${s.line}"` : " No words."}\n   ITS JOB: ${input.jobs[i] || "carry the film on"}`,
    );
    const answer = await input.ask(
      {
        model: FILM_CONTEXT_MODEL,
        effort: "medium",
        system: CONTEXT_INSTRUCTIONS,
        parts: [
          {
            text:
              `THE FILM: ${film.seconds.toFixed(1)} seconds.\n` +
              `WHAT WAS HEARD, with its times:\n${heard.length ? heard.map((l) => `${l.start} to ${l.end} s: "${l.text}"`).join("\n") : "nothing heard, or not known"}\n` +
              (input.mouthOnly
                ? "SOME SHOTS WERE FILMED AGAIN over the film's first sound, and her voice is laid on last: in this film judge " +
                  "whether a person says their line by their mouth moving with it, not by whether it is heard.\n"
                : "") +
              `THE SCRIPT, shot by shot, with each shot's job (its timing is not the film's):\n${shots.join("\n")}\n\n` +
              "THE FILM, one frame a second, each labelled with its time:",
          },
          ...sheets.map((s) => ({ image: { bytes: s.bytes, type: s.type, detail: "high" as const } })),
        ],
        schema: CONTEXT_SCHEMA as unknown as Record<string, unknown>,
        name: "film_context",
        timeoutMs: 240_000,
      },
      { signal: input.signal },
    );
    return answer.ok ? readContext(answer.value, input.script.scenes.length, film.seconds) : null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One more look at a fault before anything is paid to remake it (20 October
 * 2026: two shots that were fine were remade, and the remakes broke her lips
 * and lost her closing line). Six frames over the moment and the approved
 * picture it should look like, and one question: is it really there, and
 * would a buyer notice it? Null when nobody could look; the caller then keeps
 * the film as it is.
 */
export async function confirmFault(input: {
  ask: AskDriver;
  raw: string;
  at: number;
  end: number;
  what: string;
  /** What the shot should look like, when there is an approved picture of it. */
  approved?: { bytes: Buffer; type: string } | null;
  signal?: AbortSignal;
}): Promise<{ real: boolean; why: string } | null> {
  const dir = await mkdtemp(join(tmpdir(), "salesdesk-confirm-"));
  try {
    const film = await probe(input.raw);
    const a = Math.max(0, input.at - 0.3);
    const b = Math.min(film.seconds - 0.05, Math.max(input.end, input.at + 1) + 0.3);
    const times = Array.from({ length: 6 }, (_, i) => Math.round((a + ((b - a) * i) / 5) * 100) / 100);
    const frames = await framesAt(input.raw, times, 360, dir);
    const picture = await sheet(frames, times, 3);
    const answer = await input.ask(
      {
        model: FILM_REVIEW_MODEL,
        effort: "low",
        system:
          "You double-check one fault another checker reported in a finished Indian real-estate video, before money is spent " +
          "filming that shot again. Filming it again can break what was right (her lips, her line, the shots around it), so " +
          "confirm only a fault that is plainly there in these frames and that an ordinary buyer would notice and mind. " +
          "Light, a pause, taste, or a fault you cannot see in these frames is not confirmed. Answer in JSON.",
        parts: [
          { text: `THE REPORTED FAULT, from ${input.at.toFixed(1)} to ${input.end.toFixed(1)} s: "${input.what}"\nTHE FRAMES, each labelled with its time:` },
          { image: picture },
          ...(input.approved ? [{ text: "THE APPROVED PICTURE this shot should look like:" }, { image: { ...input.approved, detail: "low" as const } }] : []),
        ],
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["real", "why"],
          properties: { real: { type: "boolean" }, why: { type: "string" } },
        } as unknown as Record<string, unknown>,
        name: "confirm_fault",
        timeoutMs: 90_000,
      },
      { signal: input.signal },
    );
    if (!answer.ok) return null;
    const v = answer.value as { real?: unknown; why?: unknown };
    return typeof v.real === "boolean" ? { real: v.real, why: typeof v.why === "string" ? v.why.slice(0, 240) : "" } : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type FilmReview = { findings: ReviewFinding[]; usd: number; looks: { start: number; end: number; fps: number }[]; notes: ReviewNote[]; pitch: number | null; ended: string };

/**
 * The review of one film. Never fatal: a review that could not finish
 * returns what it had (nothing), and the caller says so.
 */
/**
 * Two editors watch the film apart and their findings are put together
 * (`mergeFindings()`): one review of the first full Hindi film found the
 * laptop facing away from the father and missed his entry; the next found
 * the entry and missed the laptop (8 October 2026).
 */
export async function reviewFilm(input: Parameters<typeof reviewOnce>[0]): Promise<FilmReview> {
  const runs = await Promise.all(Array.from({ length: REVIEW_PASSES }, () => reviewOnce(input).catch(() => null)));
  const done = runs.filter((r): r is FilmReview => !!r);
  if (!done.length) throw new Error("No review finished.");
  return {
    findings: mergeFindings(done.map((r) => r.findings)),
    usd: done.reduce((n, r) => n + r.usd, 0),
    looks: done.flatMap((r) => r.looks),
    notes: done.flatMap((r) => r.notes),
    pitch: done[0].pitch,
    ended: done.some((r) => r.ended === "done") ? "done" : done[0].ended,
  };
}

async function reviewOnce(input: {
  raw: string;
  script: FilmScript;
  /** What was heard, word by word, when known. */
  words: readonly { text: string; start: number; end: number }[] | null;
  /** A film nobody speaks in: no voice to judge. */
  silent?: boolean;
  /** The approved pictures the film was made from, each named: the rooms and the building it must show. */
  approved?: readonly { title: string; image: { bytes: Buffer; type: string } }[];
  brain?: AgentBrain;
  signal?: AbortSignal;
}): Promise<FilmReview> {
  const dir = await mkdtemp(join(tmpdir(), "salesdesk-review-"));
  try {
    const film = await probe(input.raw);
    const scenes = scenesFromCuts(await cutsOf(input.raw).catch(() => []), film.seconds, film.fps);
    const surveyTimes = Array.from({ length: Math.max(1, Math.floor(film.seconds)) }, (_, i) => Math.min(film.seconds - 0.1, i + 0.5));
    const surveyFrames = await framesAt(input.raw, surveyTimes, 240, dir);
    const sheets: AgentPicture[] = [];
    for (let i = 0; i < surveyFrames.length; i += 10) sheets.push(await sheet(surveyFrames.slice(i, i + 10), surveyTimes.slice(i, i + 10), 5));
    const pitch = input.silent ? null : await voicePitch(input.raw).catch(() => null);
    const heard = input.words?.length ? heardLines(input.words) : [];

    const looks: { start: number; end: number; fps: number }[] = [];
    const notes: ReviewNote[] = [];
    let report: ReviewFinding[] | null = null;
    const tools: AgentTool[] = [
      {
        name: "zoom",
        description: "Look closely at a stretch of the film: frames at the rate asked (up to 6 a second, up to 16 frames), larger, each labelled with its time.",
        parameters: ZOOM_PARAMETERS as unknown as Record<string, unknown>,
        run: async (args) => {
          if (looks.length >= MAX_ZOOMS) return { text: `Refused: ${MAX_ZOOMS} close looks is the most. Report what you have seen.` };
          const a = args as { start?: number; end?: number; fps?: number };
          const plan = zoomPlan(Number(a.start), Number(a.end), Number(a.fps), film.seconds);
          if (!plan) return { text: "Refused: that is not a stretch of this film." };
          looks.push({ start: plan.start, end: plan.end, fps: plan.fps });
          const frames = await framesAt(input.raw, plan.times, 360, dir);
          // Three frames to a picture, so each keeps its full size: a sheet
          // of sixteen is shrunk to a few hundred pixels across before the
          // model sees it, and a person in a doorway becomes a smudge.
          const images: AgentPicture[] = [];
          for (let i = 0; i < frames.length; i += 3) images.push(await sheet(frames.slice(i, i + 3), plan.times.slice(i, i + 3), 3));
          return {
            text: `${plan.start} to ${plan.end} s at about ${plan.fps} frames a second (${plan.times.length} frames). Write a note on it now: the pictures leave your view after a few more looks.`,
            images,
          };
        },
      },
      {
        name: "note",
        description:
          "Write down what one close look showed, before its pictures leave your view: the span, who is where (inside or outside, which room, standing or sitting) and what each person holds at its start and at its end, and anything wrong in it.",
        parameters: NOTE_PARAMETERS as unknown as Record<string, unknown>,
        run: async (args) => {
          const n = readNote(args);
          if (!n) return { text: "Refused: a note needs a span (from, to) and what is seen at its start and at its end." };
          notes.push(n);
          return { text: `Noted ${n.from} to ${n.to} s.` };
        },
      },
      {
        name: "report",
        description: "Hand in what is wrong (an empty list when nothing is). Ends the review.",
        parameters: REPORT_PARAMETERS as unknown as Record<string, unknown>,
        exclusive: true,
        run: async (args) => {
          const left = unlooked(scenes, looks);
          if (left.length) {
            return { text: `Refused: look closely at every shot first. Not yet looked at: ${left.map((s) => `${s.start.toFixed(2)} to ${s.end.toFixed(2)} s`).join(", ")}.` };
          }
          const unnoted = unlooked(scenes, notes.map((x) => ({ start: x.from, end: x.to })));
          if (unnoted.length) {
            return { text: `Refused: write a note on every shot first. No note covers: ${unnoted.map((s) => `${s.start.toFixed(2)} to ${s.end.toFixed(2)} s`).join(", ")}.` };
          }
          const read = readReport(args, looks);
          if (!read.ok) return { text: read.why };
          report = read.findings;
          return { text: "Report taken.", end: { ok: true } };
        },
      },
    ];
    const plan = input.script.scenes.map(
      (s, i) => `Shot ${i + 1} (${s.kind}): ${s.shot}${s.line ? ` Says: "${s.line}"` : " No words."}${s.text ? ` Card: "${s.text}".` : ""}`,
    );
    const run = await runAgent({
      model: FILM_REVIEW_MODEL,
      effort: "medium",
      instructions: REVIEW_INSTRUCTIONS,
      task: [
        {
          text:
            `THE FILM: ${film.seconds.toFixed(1)} seconds. THE PICTURE CUTS AT: ${scenes.slice(1).map((s) => `${s.start.toFixed(2)} s`).join(", ") || "nowhere"} ` +
            `(a soft transition may not show as a cut).\n` +
            `THE PEOPLE, as written: ${input.script.presenter}\n` +
            (input.silent
              ? "NOBODY SPEAKS in this film.\n"
              : `WHAT WAS HEARD, with its times (to find each shot by; the sound is another checker's):\n${heard.length ? heard.map((l) => `${l.start} to ${l.end} s: "${l.text}"`).join("\n") : "not known"}\n`) +
            `THE SCRIPT, shot by shot (its timing is not the film's):\n${plan.join("\n")}\n\nTHE SURVEY, one frame a second, each labelled with its time:`,
          images: sheets,
        },
        ...(input.approved?.length
          ? [
              {
                text:
                  `THE APPROVED PICTURES, in this order: ${input.approved.map((a) => a.title).join("; ")}. Every room and building in ` +
                  "the film must be one of these, from any angle; a room or building unlike all of them is a fault.",
                images: await Promise.all(
                  input.approved.map(async (a) => ({ bytes: await sharp(a.image.bytes).resize(768, 768, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer(), type: "image/jpeg" })),
                ),
              },
            ]
          : []),
      ],
      tools,
      maxTurns: REVIEW_TURNS,
      maxUsd: REVIEW_MAX_USD,
      keepImages: 2,
      parallel: 3,
      brain: input.brain,
      signal: input.signal,
    });
    // A review that ran out of turns still hands over what its notes found.
    // The sound is the audio checker's (`audioFindings()`, measured in code):
    // what this one says about the voice is left out, since 19 October 2026.
    const findings: ReviewFinding[] = (report ?? findingsFromNotes(notes)).filter((f) => f.about !== "voice");
    return { findings, usd: run.usd, looks, notes, pitch, ended: report ? "done" : run.ended };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

