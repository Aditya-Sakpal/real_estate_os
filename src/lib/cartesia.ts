/**
 * Cartesia (Sonic 3), for joining a word into a recorded line so it runs on
 * from the words before it and into the words after (`/infill/bytes`), in an
 * instant clone of the same voice made from the line itself. Used by the
 * presenter's voice track (`voice-track.ts`) when no ElevenLabs take of a
 * line says one of its words right. `CARTESIA_API_KEY`; `doc/pricing.md`
 * prices it. Every call is raced; nothing here is ever fatal.
 *
 * Imports are relative because the worker runs this straight from source.
 */

const API = "https://api.cartesia.ai";
const VERSION = process.env.CARTESIA_VERSION || "2026-08-14";
export const CARTESIA_MODEL = process.env.CARTESIA_MODEL || "sonic-3";

export type CartesiaKit = {
  /** A clone of the voice in a clip (10 to 60 seconds is best), or null. */
  clone(clip: Buffer, name: string, signal?: AbortSignal): Promise<string | null>;
  remove(voiceId: string): Promise<void>;
  /** The words between two clips, in the clone's voice, as WAV, or null. */
  infill(req: { voiceId: string; left: Buffer | null; right: Buffer | null; transcript: string }, signal?: AbortSignal): Promise<Buffer | null>;
};

function key(): string | null {
  return process.env.CARTESIA_API_KEY?.trim() || null;
}

async function call(path: string, init: RequestInit, ms: number, signal?: AbortSignal): Promise<Response | null> {
  const k = key();
  if (!k) return null;
  const timed = AbortSignal.timeout(ms);
  try {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${k}`, "cartesia-version": VERSION, ...(init.headers ?? {}) },
      signal: signal ? AbortSignal.any([signal, timed]) : timed,
    });
  } catch (e) {
    console.warn(`cartesia: ${path} not answered`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function failed(r: Response | null, what: string): Promise<null> {
  if (r) console.warn(`cartesia: ${what} answered ${r.status}`, (await r.text().catch(() => "")).slice(0, 300));
  return null;
}

const real: CartesiaKit = {
  async clone(clip, name, signal) {
    const form = new FormData();
    form.append("clip", new Blob([new Uint8Array(clip)], { type: "audio/wav" }), "clip.wav");
    form.append("name", name.slice(0, 60));
    form.append("language", "en");
    form.append("description", "Made from one film's voice to join a word into a line, and deleted after.");
    const r = await call("/voices/clone", { method: "POST", body: form }, 120_000, signal);
    if (!r?.ok) return failed(r, "clone");
    const j = (await r.json().catch(() => null)) as { id?: string } | null;
    return j?.id ?? null;
  },
  async remove(voiceId) {
    await call(`/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" }, 30_000).catch(() => null);
  },
  async infill(req, signal) {
    if (!req.left && !req.right) return null;
    const form = new FormData();
    if (req.left) form.append("left_audio", new Blob([new Uint8Array(req.left)], { type: "audio/wav" }), "left.wav");
    if (req.right) form.append("right_audio", new Blob([new Uint8Array(req.right)], { type: "audio/wav" }), "right.wav");
    form.append("model_id", CARTESIA_MODEL);
    form.append("language", "en");
    form.append("transcript", req.transcript);
    form.append("voice_id", req.voiceId);
    form.append("output_format[container]", "wav");
    form.append("output_format[encoding]", "pcm_s16le");
    form.append("output_format[sample_rate]", "44100");
    const r = await call("/infill/bytes", { method: "POST", body: form }, 90_000, signal);
    if (!r?.ok) return failed(r, "infill");
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 1000 ? b : null;
  },
};

let injected: CartesiaKit | null = null;
/** The checks' seam. */
export function useCartesia(k: CartesiaKit | null): void {
  injected = k;
}
/** Cartesia, or null when it is not set up (or `CARTESIA=off`). */
export function cartesia(): CartesiaKit | null {
  if (injected) return injected;
  if (process.env.CARTESIA === "off" || !key()) return null;
  return real;
}
