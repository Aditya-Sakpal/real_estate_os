import { type HeardWord } from "./respeak-rules.ts";

/**
 * ElevenLabs, for re-saying a word a film's voice got wrong: Scribe hears the
 * film word by word, an instant clone is made of the presenter's voice from
 * the film itself, the clone says the line again, and the clone is deleted.
 * `ELEVENLABS_API_KEY`; `doc/pricing.md` prices it. Every call is raced.
 *
 * Imports are relative because the worker runs this straight from source.
 */

const API = "https://api.elevenlabs.io/v1";
export const SCRIBE_MODEL = process.env.RESPEAK_STT_MODEL || "scribe_v1";
export const CLONE_TTS_MODEL = process.env.RESPEAK_TTS_MODEL || "eleven_multilingual_v2";
/** Close to her voice, as tested on 29 September 2026. The pace is the caller's (`speed`, 0.7 to 1.2). */
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.9, style: 0.35, use_speaker_boost: true };

type Fail = { ok: false; code: string; message: string };
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

function key(): string | null {
  return process.env.ELEVENLABS_API_KEY?.trim() || null;
}

async function call(path: string, init: RequestInit, ms: number, signal?: AbortSignal): Promise<Response | Fail> {
  const k = key();
  if (!k) return fail("NO_KEY", "The voice service is not set up.");
  const timed = AbortSignal.timeout(ms);
  try {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: { "xi-api-key": k, ...(init.headers ?? {}) },
      signal: signal ? AbortSignal.any([signal, timed]) : timed,
    });
  } catch {
    return signal?.aborted ? fail("STOPPED", "Stopped.") : fail("UNREACHABLE", "The voice service did not answer in time.");
  }
}

async function refused(r: Response): Promise<Fail> {
  const body = (await r.text().catch(() => "")).slice(0, 300);
  return fail(r.status === 401 ? "NO_KEY" : r.status === 429 ? "BUSY" : "REFUSED", `The voice service refused (${r.status}). ${body}`.trim());
}

export type VoiceKit = {
  /** Every word said in some audio, with when. */
  words(audio: { bytes: Buffer; type: string }, signal?: AbortSignal, language?: string): Promise<{ ok: true; words: HeardWord[]; text: string } | Fail>;
  /** A clone of the voice in a sample. */
  clone(name: string, sample: { bytes: Buffer; type: string }, signal?: AbortSignal): Promise<{ ok: true; voiceId: string } | Fail>;
  remove(voiceId: string): Promise<void>;
  /** A line in the clone's voice, with when each character is said. */
  speak(
    req: { voiceId: string; text: string; previous: string; next: string; seed: number; speed?: number },
    signal?: AbortSignal,
  ): Promise<{ ok: true; bytes: Buffer; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } } | Fail>;
};

export const elevenLabs: VoiceKit = {
  async words(audio, signal, language = "en") {
    const form = new FormData();
    form.append("model_id", SCRIBE_MODEL);
    form.append("language_code", language);
    form.append("timestamps_granularity", "word");
    form.append("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.type }), "audio");
    const r = await call("/speech-to-text", { method: "POST", body: form }, 120_000, signal);
    if (!(r instanceof Response)) return r;
    if (!r.ok) return refused(r);
    const d = (await r.json().catch(() => null)) as { text?: string; words?: { text: string; start: number; end: number; type?: string }[] } | null;
    if (!d?.words) return fail("EMPTY", "Nothing was heard.");
    return {
      ok: true,
      text: d.text ?? "",
      words: d.words.filter((w) => (w.type ?? "word") === "word").map((w) => ({ text: w.text, start: w.start, end: w.end })),
    };
  },

  async clone(name, sample, signal) {
    const form = new FormData();
    form.append("name", name);
    form.append("description", "Made from one film to re-say a word, and deleted after.");
    form.append("remove_background_noise", "false");
    form.append("files", new Blob([new Uint8Array(sample.bytes)], { type: sample.type }), "sample.wav");
    const r = await call("/voices/add", { method: "POST", body: form }, 120_000, signal);
    if (!(r instanceof Response)) return r;
    if (!r.ok) return refused(r);
    const d = (await r.json().catch(() => null)) as { voice_id?: string } | null;
    return d?.voice_id ? { ok: true, voiceId: d.voice_id } : fail("EMPTY", "The voice service made no voice.");
  },

  async remove(voiceId) {
    await call(`/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" }, 30_000).catch(() => null);
  },

  async speak(req, signal) {
    const r = await call(
      `/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_192`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: req.text,
          model_id: CLONE_TTS_MODEL,
          voice_settings: { ...VOICE_SETTINGS, speed: Math.min(1.2, Math.max(0.7, req.speed ?? 1.05)) },
          seed: req.seed,
          previous_text: req.previous,
          next_text: req.next,
        }),
      },
      90_000,
      signal,
    );
    if (!(r instanceof Response)) return r;
    if (!r.ok) return refused(r);
    const d = (await r.json().catch(() => null)) as {
      audio_base64?: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    } | null;
    if (!d?.audio_base64 || !d.alignment) return fail("EMPTY", "The voice said nothing.");
    return { ok: true, bytes: Buffer.from(d.audio_base64, "base64"), alignment: d.alignment };
  },
};
