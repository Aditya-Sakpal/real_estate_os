import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Speech to text, for a host's voice note: the one seam every piece of a
 * note goes through.
 *
 * Sarvam's Saaras v3 in `transcribe` mode, which reads Hindi, Marathi and
 * English and says which it heard, on the speech key (`SARVAM_API_KEY`),
 * never the calling one. Its REST endpoint takes thirty seconds of audio at
 * most, which is why a note is cut into pieces before it gets here. Billed
 * per second, Rs 30 an hour at September 2026 prices.
 *
 * `STT_FIXTURE_DIR` is a dev and test seam, never set in production: a
 * folder of `<sha256 of the piece>.txt` files, each the transcript of that
 * piece. A piece with no file falls through to Sarvam. An injected driver
 * beats both.
 */

/**
 * `transcribe` writes Hindi and Marathi in their own script (a host's note);
 * `translit` writes everything in Roman letters, which is how a question
 * typed into Ask Jimmy reads ("Tower C mein kitne visits hue").
 */
export type SttMode = "transcribe" | "translit";
export type Piece = { bytes: Buffer; contentType: string; mode?: SttMode; fileName?: string };
export type Heard = { ok: true; text: string; language: string | null } | { ok: false; message: string };
export type Transcriber = (piece: Piece, signal?: AbortSignal) => Promise<Heard>;

export const STT_MODEL = process.env.STT_MODEL || "saaras:v3";
/** A piece that takes longer than this is abandoned, and the note fails rather than waits. */
export const STT_TIMEOUT_MS = 30_000;
/** Rs 30 an hour. */
export const STT_PAISE_PER_SECOND = 3000 / 3600;

let injected: Transcriber | null = null;

/** For the checks: a transcriber that never leaves the machine. */
export function useTranscriber(t: Transcriber | null): void {
  injected = t;
}

export async function transcribe(piece: Piece): Promise<Heard> {
  const driver = injected ?? fixtureOrSarvam;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Heard>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve({ ok: false, message: "The transcriber did not answer in time." });
    }, STT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([driver(piece, ctrl.signal), timeout]);
  } catch {
    return { ok: false, message: "The transcriber could not be reached." };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fixtureOrSarvam(piece: Piece, signal?: AbortSignal): Promise<Heard> {
  const dir = process.env.STT_FIXTURE_DIR;
  if (dir && process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    const name = createHash("sha256").update(piece.bytes).digest("hex");
    const text = await readFile(join(dir, `${name}.txt`), "utf8").catch(() => null);
    if (text !== null) return { ok: true, text: text.trim(), language: null };
  }
  return sarvam(piece, signal);
}

async function sarvam(piece: Piece, signal?: AbortSignal): Promise<Heard> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return { ok: false, message: "Speech to text is not switched on." };
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(piece.bytes)], { type: piece.contentType }), piece.fileName ?? "piece.wav");
  form.append("model", STT_MODEL);
  form.append("mode", piece.mode ?? "transcribe");
  form.append("language_code", "unknown");
  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
    signal,
  });
  if (!res.ok) {
    console.warn(`stt: Sarvam answered ${res.status}`, (await res.text().catch(() => "")).slice(0, 300));
    return { ok: false, message: "The transcriber refused the note." };
  }
  const body = (await res.json().catch(() => null)) as { transcript?: unknown; language_code?: unknown } | null;
  if (!body || typeof body.transcript !== "string") return { ok: false, message: "The transcriber sent back nothing." };
  return { ok: true, text: body.transcript.trim(), language: typeof body.language_code === "string" ? body.language_code.slice(0, 12) : null };
}
