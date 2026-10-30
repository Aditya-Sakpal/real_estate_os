/**
 * The AI agents as the console shows them: what each one does, when it
 * acts, the voices it may speak in, and the plan that first carries it.
 *
 * Which plan carries which agent is `PLANS` in `billing-rules.ts`, read here
 * rather than restated. Which plan opens which voice is `VOICE_PLAN` (the
 * client, 4 October 2026: a voice a plan does not open is locked, and cannot
 * even be heard). A client picks each agent's voice per project
 * (`agent-voices.ts`); the call then goes to that voice's copy of the agent
 * on Sarvam (`voice-apps-rules.ts`). The samples are made by
 * `scripts/make-voice-samples.mjs`.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { PLANS, PLAN_KEYS, type AgentJob, type PlanKey } from "./billing-rules.ts";

export type VoiceKey =
  | "zarina" | "advait" | "priya"
  | "mohit" | "kavya" | "ishita" | "shubh"
  | "ritu" | "roopa" | "shreya" | "suchitra" | "bhavik" | "deven";
/** In the order the screen lists them: by the plan that opens them, the recommended one first. */
export const VOICE_KEYS: readonly VoiceKey[] = [
  "zarina", "advait", "priya",
  "mohit", "kavya", "ishita", "shubh",
  "ritu", "roopa", "shreya", "suchitra", "bhavik", "deven",
];
export const isVoiceKey = (v: unknown): v is VoiceKey => typeof v === "string" && (VOICE_KEYS as readonly string[]).includes(v);

export type VoiceCard = {
  key: VoiceKey;
  name: string;
  gender: "male" | "female";
  /** Who it sounds like, in a few words. */
  sound: string;
  sample: string;
  recommended?: boolean;
};

const card = (key: VoiceKey, name: string, gender: "male" | "female", sound: string, recommended = false): VoiceCard => ({
  key, name, gender, sound, sample: `/voices/voice-${key}.mp3`, ...(recommended ? { recommended: true } : {}),
});

/**
 * Sarvam's conversational voices where it has one (the client, 27 October
 * 2026). Each is a copy of every calling agent, listed in `SARVAM_VOICE_APPS`.
 */
export const VOICE_CARDS: readonly VoiceCard[] = [
  card("zarina", "Zarina", "female", "Female, deep and flowing", true),
  card("advait", "Advait", "male", "Male, calm and clear"),
  card("priya", "Priya", "female", "Female, warm"),
  card("mohit", "Mohit", "male", "Male, friendly and lively"),
  card("kavya", "Kavya", "female", "Female, friendly and expressive"),
  card("ishita", "Ishita", "female", "Female, friendly, best in Marathi"),
  card("shubh", "Shubh", "male", "Male, quick and bright"),
  card("ritu", "Ritu", "female", "Female, steady"),
  card("roopa", "Roopa", "female", "Female, soft and friendly"),
  card("shreya", "Shreya", "female", "Female, soft and flowing"),
  card("suchitra", "Suchitra", "female", "Female, low and brisk"),
  card("bhavik", "Bhavik", "male", "Male, calm, best in Gujarati"),
  card("deven", "Deven", "male", "Male, brisk, best in English"),
];

/** The first plan that opens each voice. */
export const VOICE_PLAN: Record<VoiceKey, PlanKey> = {
  zarina: "LAUNCH",
  advait: "LAUNCH",
  priya: "LAUNCH",
  mohit: "GROWTH",
  kavya: "GROWTH",
  ishita: "GROWTH",
  shubh: "GROWTH",
  ritu: "SCALE",
  roopa: "SCALE",
  shreya: "SCALE",
  suchitra: "SCALE",
  bhavik: "SCALE",
  deven: "SCALE",
};

const RANK: Record<PlanKey, number> = { LAUNCH: 0, GROWTH: 1, SCALE: 2 };

/**
 * Whether a voice is open on a project. `billed` false is an organisation
 * no plan was ever sold to, which billing never refuses, so every voice is
 * open there; billed with no plan opens none.
 */
export function voiceOpen(voice: VoiceKey, plan: PlanKey | null, billed: boolean): boolean {
  if (!billed) return true;
  if (!plan) return false;
  return RANK[VOICE_PLAN[voice]] <= RANK[plan];
}

export type AgentCard = {
  job: AgentJob;
  name: string;
  /** When it acts, in the words a sales head uses. */
  when: string;
  /** What it does, one sentence. */
  does: string;
  /** How it reaches the buyer or partner. */
  channel: "call" | "whatsapp";
  /** The voice it speaks in until somebody picks another. */
  voice: VoiceKey | null;
  /** Whether a client may pick its voice. */
  choosable: boolean;
  /** What it says, as the sample plays it. */
  line: string;
  /** The sample's file name before the voice: `/voices/<slug>-<voice>.mp3`. */
  slug: string | null;
};

/** In the order a buyer meets them. */
export const AGENT_CARDS: readonly AgentCard[] = [
  {
    job: "QUALIFIER",
    name: "Lead Qualifier",
    when: "Within a minute of every enquiry",
    does: "Calls each new lead, learns budget, size, area and timeline, answers from your signed facts and books the site visit.",
    channel: "call",
    voice: "advait",
    choosable: true,
    line: "Namaste sir, aapne hamare project ke liye enquiry ki thi. Aap 1 BHK dekh rahe hain ya 2 BHK?",
    slug: "agent-qualifier",
  },
  {
    job: "CONFIRMER",
    name: "Visit Confirmer",
    when: "The day before a visit, and after a no-show",
    does: "Confirms the visit, moves it if the buyer asks, and rings back a buyer who did not turn up to fix a new time.",
    channel: "call",
    voice: "advait",
    choosable: true,
    line: "Namaste sir, kal shaam chaar baje aapki site visit hai. Kya aap us samay aa payenge?",
    slug: "agent-confirmer",
  },
  {
    job: "REENGAGER",
    name: "Re-engager",
    when: "When a warm lead goes quiet",
    does: "Picks up where the last call left off, without asking again what the buyer already said, and invites them to see the site.",
    channel: "call",
    voice: "shubh",
    choosable: true,
    line: "Namaste sir, pichhli baar aapne kaha tha ki ghar par baat karke batayenge. Is weekend ek baar aakar dekhna chahenge?",
    slug: "agent-reengager",
  },
  {
    job: "POST_VISIT",
    name: "Post-visit Follow-up",
    when: "The day after a site visit",
    does: "Asks how the visit went, hears the objection, and hands a ready buyer to your sales manager.",
    channel: "call",
    voice: "shubh",
    choosable: true,
    line: "Namaste sir, kal aap site par aaye the. Aapko flat kaisa laga? Koi sawaal ho toh bataiye.",
    slug: "agent-postvisit",
  },
  {
    job: "RECEPTIONIST",
    name: "Inbound Receptionist",
    when: "Whenever a buyer rings your number",
    does: "Answers the number on your ads at any hour, knows a returning buyer by name, and puts a ready one through to your team.",
    channel: "call",
    voice: "advait",
    choosable: false,
    line: "Namaste, main Advait, reception se bol raha hoon. Bataiye, main aapki kaise madad kar sakta hoon?",
    slug: "agent-receptionist",
  },
  {
    job: "CP_DESK",
    name: "CP Desk",
    when: "Whenever a channel partner messages",
    does: "Registers partners' buyers, books their visits, shares approved posts and tells them where each payout stands, on WhatsApp.",
    channel: "whatsapp",
    voice: null,
    choosable: false,
    line: "Register 98XXXXXX21 for Sath Heights. Done: registered for 30 days.",
    slug: null,
  },
];

/** The jobs whose voice a client may pick. */
export const VOICE_JOBS: readonly AgentJob[] = AGENT_CARDS.filter((a) => a.choosable).map((a) => a.job);

export const agentCard = (job: AgentJob): AgentCard | undefined => AGENT_CARDS.find((a) => a.job === job);

/** The first plan that carries an agent. */
export function unlockPlan(job: AgentJob): PlanKey {
  return PLAN_KEYS.find((p) => PLANS[p].agents.includes(job)) ?? "SCALE";
}

export const voiceCard = (key: VoiceKey | null): VoiceCard | null => VOICE_CARDS.find((v) => v.key === key) ?? null;

/** An agent's line in one voice, or null when that agent has no recording in it. */
export function sampleFor(agent: AgentCard, voice: VoiceKey): string | null {
  if (!agent.slug) return null;
  if (!agent.choosable && voice !== agent.voice) return null;
  return `/voices/${agent.slug}-${voice}.mp3`;
}

/** What one agent speaks in on a project: what was picked, else its own voice. */
export function voiceIn(agent: AgentCard, picked: Partial<Record<AgentJob, VoiceKey>>): VoiceKey | null {
  if (!agent.voice) return null;
  return (agent.choosable ? picked[agent.job] : undefined) ?? agent.voice;
}

/**
 * Why a voice cannot be picked for an agent on a project, or null when it
 * can. Asked by the screen and again by the server before it saves.
 */
export function voicePickProblem(o: {
  job: AgentJob;
  voice: VoiceKey;
  plan: PlanKey | null;
  billed: boolean;
  /** Whether a copy of this agent in this voice is set up to call. */
  ready: boolean;
}): string | null {
  const agent = agentCard(o.job);
  if (!agent?.choosable) return "This agent's voice cannot be changed.";
  if (o.billed && !(o.plan && PLANS[o.plan].agents.includes(o.job))) return `${agent.name} is not on this project's plan.`;
  if (!voiceOpen(o.voice, o.plan, o.billed)) return `${voiceCard(o.voice)!.name} unlocks on ${PLANS[VOICE_PLAN[o.voice]].label}.`;
  if (!o.ready && o.voice !== agent.voice) return `${voiceCard(o.voice)!.name} is not ready for the ${agent.name} yet.`;
  return null;
}
