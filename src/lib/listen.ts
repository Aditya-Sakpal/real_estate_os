/**
 * The listener (`listen-rules.ts` decides): OpenAI's audio models hear the
 * film's sound and say which words were said wrong. A whole film is listened
 * to once by each of `LISTEN_MODELS`, and a take of one line once by the
 * first. About 300 audio tokens a 30-second film, a cent or so a listen.
 *
 * Never fatal: no key, a refusal or an answer that cannot be read is null,
 * and the caller falls back to comparing the transcript as before.
 *
 * Imports are relative because the worker runs this straight from source.
 */
import { LISTEN_MODELS, listenPrompt, mergeListens, readListen, readTakeWords, takePrompt, type ListenProblem } from "./listen-rules.ts";

export type Listener = {
  /** The problems heard in a film's sound (an MP3), or null when nobody could listen. */
  film(mp3: Buffer, lines: readonly string[], signal?: AbortSignal): Promise<ListenProblem[] | null>;
  /** Whether a take (an MP3) of a line says `words` right (the whole line when not given), or null when nobody could listen. */
  take(mp3: Buffer, line: string, words?: string, signal?: AbortSignal): Promise<boolean | null>;
  /** The same, with the words heard wrong and what they sounded like. */
  heard(mp3: Buffer, line: string, signal?: AbortSignal): Promise<{ ok: boolean; wrong: { word: string; heard: string }[] } | null>;
};

let injected: Listener | null = null;
/** The checks' seam: a listener that costs nothing. */
export function useListener(l: Listener | null): void {
  injected = l;
}

const LISTEN_TIMEOUT_MS = 90_000;

async function ask(model: string, prompt: string, mp3: Buffer, signal?: AbortSignal): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const timeout = AbortSignal.timeout(LISTEN_TIMEOUT_MS);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({
      model,
      modalities: ["text"],
      messages: [
        // Without it, gpt-audio now and then answered that it could not play audio (19 October 2026).
        { role: "system", content: "You can hear the audio clip the user attaches. Listen to it and answer only in the JSON asked for." },
        { role: "user", content: [{ type: "text", text: prompt }, { type: "input_audio", input_audio: { data: mp3.toString("base64"), format: "mp3" } }] },
      ],
    }),
  }).catch((e) => {
    console.error(`listen: ${model} could not be asked`, e instanceof Error ? e.message : e);
    return null;
  });
  if (!res?.ok) {
    if (res) console.error(`listen: ${model} answered ${res.status}`, (await res.text().catch(() => "")).slice(0, 300));
    return null;
  }
  const j = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
  return j?.choices?.[0]?.message?.content ?? null;
}

/** One model's answer read, asked again once when it could not be read (a model saying it cannot hear the clip). */
async function twice<T>(model: string, prompt: string, mp3: Buffer, read: (text: string) => T | null, signal?: AbortSignal): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await ask(model, prompt, mp3, signal).catch(() => null);
    const got = text ? read(text) : null;
    if (got !== null) return got;
  }
  return null;
}

const openAiListener: Listener = {
  async film(mp3, lines, signal) {
    const runs = await Promise.all(LISTEN_MODELS.map((m) => twice(m, listenPrompt(lines), mp3, (t) => readListen(t, lines), signal)));
    return mergeListens(runs);
  },
  async take(mp3, line, words, signal) {
    for (const m of LISTEN_MODELS) {
      const got = await twice(m, takePrompt(line, words), mp3, readTakeWords, signal);
      if (got !== null) return got.ok;
    }
    return null;
  },
  async heard(mp3, line, signal) {
    for (const m of LISTEN_MODELS) {
      const got = await twice(m, takePrompt(line), mp3, readTakeWords, signal);
      if (got !== null) return got;
    }
    return null;
  },
};

/** The listener in use: the injected one, else OpenAI's, unless `FILM_LISTEN=off`. */
export function listener(): Listener | null {
  if (injected) return injected;
  if (process.env.FILM_LISTEN === "off" || !process.env.OPENAI_API_KEY) return null;
  return openAiListener;
}
