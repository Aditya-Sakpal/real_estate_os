/**
 * The lines a buyer hears around a hand-off, in each agent's own voice
 * (Sarvam Bulbul v3; `AGENT_VOICE` says which agent speaks as whom), once per
 * language and voice: `busy-<lang>-<voice>.wav` when nobody on the team
 * picked up, and `connect-<lang>-<voice>.wav` before a long call is put
 * through. Vobiz's own text to speech has no Hindi or Marathi voice, so the
 * words are recorded here and played from `public/calls/`. It then rewrites
 * `src/lib/handoff-audio.ts`, the list the app plays from, so a line is never
 * played before it is recorded.
 *
 *   node --experimental-strip-types --env-file=.env.local scripts/make-handoff-audio.mts [--voice=priya]
 *
 * Uses the speech key, `SARVAM_API_KEY`. Run it again only when the words or
 * a voice change, and commit `public/calls/` with the list.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUSY_LINES, CONNECT_LINES, VOICES, type Voice } from "../src/lib/handoff-rules.ts";

const key = process.env.SARVAM_API_KEY;
if (!key) throw new Error("SARVAM_API_KEY (the speech key) is not set.");
const out = resolve("public/calls");
mkdirSync(out, { recursive: true });

const only = process.argv.find((a) => a.startsWith("--voice="))?.slice(8) as Voice | undefined;
if (only && !VOICES.includes(only)) throw new Error(`--voice must be one of ${VOICES.join(", ")}`);
const CODE = { hi: "hi-IN", mr: "mr-IN", en: "en-IN" } as const;

for (const voice of only ? [only] : VOICES) {
  const lines = [
    ...Object.entries(BUSY_LINES).map(([lang, text]) => ({ kind: "busy", lang, text })),
    ...Object.entries(CONNECT_LINES[voice]).map(([lang, text]) => ({ kind: "connect", lang, text })),
  ] as { kind: string; lang: keyof typeof CODE; text: string }[];
  for (const { kind, lang, text } of lines) {
    const r = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: { "api-subscription-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        target_language_code: CODE[lang],
        speaker: voice,
        model: process.env.SPEAK_MODEL || "bulbul:v3",
        pace: 1.0,
        speech_sample_rate: "8000",
        output_audio_codec: "wav",
      }),
    });
    if (!r.ok) throw new Error(`${kind} ${lang} ${voice}: ${r.status} ${await r.text()}`);
    const json = (await r.json()) as { audios?: string[] };
    const audio = json.audios?.[0];
    if (!audio) throw new Error(`${kind} ${lang} ${voice}: no audio`);
    const file = resolve(out, `${kind}-${lang}-${voice}.wav`);
    writeFileSync(file, Buffer.from(audio, "base64"));
    console.log(file);
  }
}

const recorded = existsSync(out) ? readdirSync(out).filter((f) => /^(busy|connect)-(hi|mr|en)-[a-z]+\.wav$/.test(f)).sort() : [];
writeFileSync(resolve("src/lib/handoff-audio.ts"), `/**
 * The hand-off recordings committed in \`public/calls/\`, named
 * \`<busy|connect>-<lang>-<voice>.wav\`. Written by
 * \`scripts/make-handoff-audio.mts\`; never edit by hand, or a line is played
 * that is not there.
 */
export const RECORDED: readonly string[] = [
${recorded.map((f) => `  "${f}",`).join("\n")}
];
`);
console.log(`src/lib/handoff-audio.ts lists ${recorded.length} recordings`);
