/**
 * Which Sarvam agent speaks in which voice.
 *
 * Sarvam fixes a voice on the agent: a call may override only its opening
 * line, state and language. So every job has one copy per voice, made by
 * cloning the job's own agent with another voice and that voice's name and
 * gender as the defaults of `agent_name` and `agent_gender`, which the
 * prompt and greeting read. `SARVAM_VOICE_APPS` maps a job's own agent to
 * its copies:
 *
 *   {"salesdesk--5ac68ad3-401d": {"priya": "Sales Desk--1234abcd-5678@1", ...}, ...}
 *
 * A voice with no copy listed calls on the job's own agent, which is why the
 * screen offers only the voices that resolve here.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { isVoiceKey, type VoiceKey } from "./agent-catalog.ts";

export type App = { id: string; version: number };
export type VoiceApps = Map<string, Map<VoiceKey, App>>;

/** `id@version`, as the map holds it. */
function readApp(raw: unknown): App | null {
  if (typeof raw !== "string") return null;
  const m = /^([A-Za-z0-9-]{4,80})@([1-9]\d{0,4})$/.exec(raw.trim());
  return m ? { id: m[1], version: Number(m[2]) } : null;
}

/** The map from its environment value; anything unreadable is left out, never guessed. */
export function readVoiceApps(raw: string | undefined | null): VoiceApps {
  const out: VoiceApps = new Map();
  if (!raw?.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [base, copies] of Object.entries(parsed as Record<string, unknown>)) {
    if (!copies || typeof copies !== "object") continue;
    const voices = new Map<VoiceKey, App>();
    for (const [voice, app] of Object.entries(copies as Record<string, unknown>)) {
      const a = readApp(app);
      if (isVoiceKey(voice) && a) voices.set(voice, a);
    }
    if (voices.size) out.set(base, voices);
  }
  return out;
}

/** The agent that speaks a job's call in a voice: its copy when there is one, else the job's own. */
export function voiceApp(map: VoiceApps, own: App, voice: VoiceKey | null): App {
  if (!voice) return own;
  return map.get(own.id)?.get(voice) ?? own;
}

/** The voices a job's agent can speak in: its own, and every copy. */
export function voicesReady(map: VoiceApps, ownId: string | null, ownVoice: VoiceKey | null): Set<VoiceKey> {
  const out = new Set<VoiceKey>(ownVoice ? [ownVoice] : []);
  if (ownId) for (const v of map.get(ownId)?.keys() ?? []) out.add(v);
  return out;
}
