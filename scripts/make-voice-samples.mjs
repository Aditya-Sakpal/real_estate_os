// Makes the short listen-to samples on the AI agents screen
// (public/voices/*.mp3), each agent's line in each voice a client may pick, and one per
// voice in the voices list. Run again only when a voice, a pace or a line
// changes: node --env-file=.env.local scripts/make-voice-samples.mjs
//
// Sarvam Bulbul, about Rs 0.90 a line at list price; one per agent and voice, and one per voice.
// A regex as the argument makes only the files it matches.
import { mkdir, writeFile } from "node:fs/promises";

const key = process.env.SARVAM_API_KEY;
if (!key) throw new Error("SARVAM_API_KEY is not set");

// Each voice as the agents speak it: the four first ones on Bulbul v3, the
// rest on Sarvam's conversational v4 voices (the client, 27 October 2026).
const VOICES = [
  { key: "advait", speaker: "advait", model: "bulbul:v3", pace: 1.3, gender: "male" },
  { key: "priya", speaker: "priya", model: "bulbul:v3", pace: 1.15, gender: "female" },
  { key: "shubh", speaker: "shubh", model: "bulbul:v3", pace: 1.25, gender: "male" },
  { key: "ritu", speaker: "ritu", model: "bulbul:v3", pace: 1.15, gender: "female" },
  { key: "zarina", speaker: "zarina_en_conversation", model: "bulbul:v4-flash", pace: 1.15, gender: "female" },
  { key: "mohit", speaker: "mohit_hi_conversational", model: "bulbul:v4-flash", pace: 1.2, gender: "male" },
  { key: "kavya", speaker: "kavya_hi_conversational", model: "bulbul:v4-flash", pace: 1.15, gender: "female" },
  { key: "ishita", speaker: "ishita_mr_conversational", model: "bulbul:v4-flash", pace: 1.15, gender: "female" },
  { key: "roopa", speaker: "roopa_hi_conversational", model: "bulbul:v4-flash", pace: 1.15, gender: "female" },
  { key: "shreya", speaker: "shreya_hi_conversational", model: "bulbul:v4-flash", pace: 1.15, gender: "female" },
  { key: "suchitra", speaker: "suchitra_hi_ecomm", model: "bulbul:v4-flash", pace: 1.15, gender: "female" },
  { key: "bhavik", speaker: "bhavik_gu_conversation", model: "bulbul:v4-flash", pace: 1.2, gender: "male" },
  { key: "deven", speaker: "deven_en_conversation", model: "bulbul:v4-flash", pace: 1.2, gender: "male" },
];

// What each agent says, in every voice a client may pick for it
// (agent-catalog.ts: /voices/<slug>-<voice>.mp3). None speaks of itself, so
// the words are the same in a man's voice and a woman's.
const AGENT_LINES = [
  { slug: "agent-qualifier", text: "नमस्ते सर, आपने हमारे project के लिए enquiry की थी। आप वन बीएचके देख रहे हैं या टू बीएचके?" },
  { slug: "agent-confirmer", text: "नमस्ते सर, कल शाम चार बजे आपकी site visit है। क्या आप उस समय आ पाएँगे?" },
  { slug: "agent-reengager", text: "नमस्ते सर, पिछली बार आपने कहा था कि घर पर बात करके बताएँगे। इस weekend एक बार आकर देखना चाहेंगे?" },
  { slug: "agent-postvisit", text: "नमस्ते सर, कल आप site पर आए थे। आपको flat कैसा लगा? कोई सवाल हो तो बताइए।" },
];

const ABOUT = {
  male: "नमस्ते, मैं आपकी property enquiry के बारे में बात कर रहा हूँ। क्या अभी दो मिनट बात हो सकती है?",
  female: "नमस्ते, मैं आपकी property enquiry के बारे में बात कर रही हूँ। क्या अभी दो मिनट बात हो सकती है?",
};
const LINES = [
  ...AGENT_LINES.flatMap((a) => VOICES.map((v) => ({ file: `${a.slug}-${v.key}`, ...v, text: a.text }))),
  // The receptionist keeps its own voice.
  { file: "agent-receptionist-advait", ...VOICES[0], text: "नमस्ते, मैं अद्वैत, reception से बोल रहा हूँ। बताइए, मैं आपकी कैसे मदद कर सकता हूँ?" },
  // The voices.
  ...VOICES.map((v) => ({ file: `voice-${v.key}`, ...v, text: ABOUT[v.gender] })),
];

await mkdir("public/voices", { recursive: true });
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
for (const l of LINES) {
  if (only && !only.test(l.file)) continue;
  const r = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: l.text, language_code: "hi-IN", speaker: l.speaker, model: l.model, pace: l.pace, speech_sample_rate: "24000", output_audio_codec: "mp3" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`${l.file}: ${r.status} ${await r.text()}`);
  const audio = (await r.json()).audios?.[0];
  if (!audio) throw new Error(`${l.file}: no audio`);
  await writeFile(`public/voices/${l.file}.mp3`, Buffer.from(audio, "base64"));
  console.log("made", l.file);
}
