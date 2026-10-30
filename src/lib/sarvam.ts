/**
 * The one door to Sarvam's Voice Agents API.
 *
 * Every call goes through here so a check can inject a driver and place a
 * "call" without ringing anybody, the way `platform.ts` is the seam for Meta
 * and Google. An injected driver beats the real one.
 *
 * The workspace and the agents are the platform's: one Sarvam workspace and
 * one agent per job serve every tenant. The number a call goes out from is
 * the tenant's own (`calling_numbers`, `callerLineFor()`), with its own
 * Sarvam connection when it has one; `SARVAM_FROM_NUMBER` is only the shared
 * number a tenant with none uses while it is not billed LIVE, so it is
 * optional here. `sarvamConfig()` says plainly which piece is missing rather
 * than failing somewhere inside a request.
 */

import type { CallLanguage, RoleAgent } from "./call-rules.ts";
import { readVoiceApps, type VoiceApps } from "./voice-apps-rules.ts";

export type SarvamConfig = {
  apiKey: string;
  orgId: string;
  workspaceId: string;
  appId: string;
  appVersion: number;
  connectionId: string;
  /**
   * The number the call goes out from. The shared one from the environment
   * until `placeCall()` puts the tenant's own line in its place; null when
   * the environment names none.
   */
  fromNumber: string | null;
  /**
   * The goal agent: a copy of the qualifier that reads `call_goal`. Optional,
   * because the qualifier works without it; null until both are set.
   */
  goalApp: SarvamApp | null;
  /**
   * A tenant's own goal agent, in place of `goalApp` (`SARVAM_GOAL_APP_BY_ORG`,
   * `{"<org id>": "<agent>@<version>"}`). Its prompt carries every behaviour
   * rule, so `placeCall()` hands it the tower's facts alone (30 October 2026,
   * Northwind's trimmed prompt).
   */
  goalAppsByOrg?: Map<string, SarvamApp>;
  /** Each job's agent's copies in the other voices (`voice-apps-rules.ts`). */
  voiceApps: VoiceApps;
  /**
   * The other jobs' agents, each a copy of the qualifier with its own role in
   * the prompt: same voice, settings and hand-off. A job whose agent is not
   * set is absent, and `placeCall()` decides what that job does without it.
   */
  roleApps: Partial<Record<RoleAgent, SarvamApp>>;
  /**
   * The inbound receptionist: a copy of the qualifier bound to the
   * developers' numbers, which asks us at the start of each call who is
   * ringing (`/api/calls/inbound/start`). Null until both settings are set.
   */
  receptionistApp: SarvamApp | null;
};

export type SarvamApp = { id: string; version: number };

const ROLE_ENV: Record<RoleAgent, string> = {
  confirmer: "SARVAM_CONFIRMER_APP",
  reengager: "SARVAM_REENGAGER_APP",
  post_visit: "SARVAM_POSTVISIT_APP",
};

/** One agent's id and version, when both settings are there and make sense. */
function appOf(env: Record<string, string | undefined>, prefix: string): SarvamApp | null {
  const id = env[`${prefix}_ID`]?.trim();
  const version = Number(env[`${prefix}_VERSION`]?.trim());
  return id && Number.isInteger(version) && version >= 1 ? { id, version } : null;
}

/** The goal agent, when both of its settings are there and make sense. */
function goalAppOf(env: Record<string, string | undefined>): SarvamConfig["goalApp"] {
  return appOf(env, "SARVAM_GOAL_APP");
}

/** Each tenant's own goal agent; anything unreadable is left out, never guessed. */
export function goalAppsByOrgOf(raw: string | undefined | null): Map<string, SarvamApp> {
  const out = new Map<string, SarvamApp>();
  if (!raw?.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [org, app] of Object.entries(parsed as Record<string, unknown>)) {
    const m = typeof app === "string" ? /^([A-Za-z0-9-]{4,80})@([1-9]\d{0,4})$/.exec(app.trim()) : null;
    if (/^[0-9a-f-]{36}$/i.test(org) && m) out.set(org, { id: m[1], version: Number(m[2]) });
  }
  return out;
}

function roleAppsOf(env: Record<string, string | undefined>): SarvamConfig["roleApps"] {
  const out: SarvamConfig["roleApps"] = {};
  for (const [role, prefix] of Object.entries(ROLE_ENV) as [RoleAgent, string][]) {
    const app = appOf(env, prefix);
    if (app) out[role] = app;
  }
  return out;
}

/** Whether a job's own agent is set up here. */
export function roleAgentOn(role: RoleAgent, env: Record<string, string | undefined> = process.env): boolean {
  const c = sarvamConfig(env);
  return c.ok && !!c.config.roleApps[role];
}

/**
 * Whether the agents carry `call_project` and `project_facts` in their
 * prompts, so a call is handed the tower's signed facts. Set once every
 * agent's prompt has the block in `doc/sarvam-qualifier-agent.md` section
 * 13. Until then the two are kept off the request: an agent that never
 * declared them has nothing to read them with, and Sarvam does not document
 * what it does with a variable an agent never declared.
 */
export function projectFactsOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.SARVAM_PROJECT_FACTS === "on";
}

/**
 * Whether calls carry `call_context` and `call_history`, why this call is
 * made and every call before it (`call-memory-rules.ts`). Off until every
 * agent declares both and its prompt reads them
 * (`doc/sarvam-qualifier-agent.md` section 18).
 */
export function callMemoryOn(agent: string, env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.SARVAM_CALL_MEMORY ?? "").trim();
  if (v === "on") return true;
  // A list names the agents whose prompts read it so far: "qualifier,goal".
  return v.split(",").map((x) => x.trim()).includes(agent);
}

/**
 * Whether calls carry `say_words`, how to say the tower's words. Off until
 * every agent declares the variable and its prompt says to copy the
 * spellings (`doc/sarvam-qualifier-agent.md` section 15).
 */
export function sayWordsOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.SARVAM_SAY_WORDS === "on";
}

/**
 * Whether a call may open in a southern or eastern state's language
 * (Kannada, Tamil, Telugu, Bengali, Gujarati; `openingLanguage()`). Off until
 * every agent lists those languages and its prompt has a line for them:
 * opening an agent in a language it was never set up for would be refused,
 * or worse, greet the buyer in one language and carry on in another.
 *
 * Off for good since 29 October 2026 (the client): every agent speaks only
 * Hindi, Marathi and English, after a test call slid into Gujarati, so the
 * switch is no longer read.
 */
export function regionalLanguagesOn(_env: Record<string, string | undefined> = process.env): boolean {
  return false;
}

/** Whether a call can be given a goal here. */
export function goalCallsOn(env: Record<string, string | undefined> = process.env): boolean {
  const c = sarvamConfig(env);
  return c.ok && c.config.goalApp !== null;
}

const ENV: [keyof SarvamConfig, string][] = [
  ["apiKey", "SARVAM_AGENTS_KEY"],
  ["orgId", "SARVAM_ORG_ID"],
  ["workspaceId", "SARVAM_WORKSPACE_ID"],
  ["appId", "SARVAM_APP_ID"],
  ["appVersion", "SARVAM_APP_VERSION"],
  ["connectionId", "SARVAM_CONNECTION_ID"],
];

export function sarvamConfig(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: SarvamConfig } | { ok: false; missing: string[] } {
  const missing = ENV.filter(([, name]) => !env[name]?.trim()).map(([, name]) => name);
  if (missing.length) return { ok: false, missing };
  const get = (name: string) => env[name]!.trim();
  const appVersion = Number(get("SARVAM_APP_VERSION"));
  if (!Number.isInteger(appVersion) || appVersion < 1) return { ok: false, missing: ["SARVAM_APP_VERSION"] };
  return {
    ok: true,
    config: {
      apiKey: get("SARVAM_AGENTS_KEY"),
      orgId: get("SARVAM_ORG_ID"),
      workspaceId: get("SARVAM_WORKSPACE_ID"),
      appId: get("SARVAM_APP_ID"),
      appVersion,
      connectionId: get("SARVAM_CONNECTION_ID"),
      fromNumber: env.SARVAM_FROM_NUMBER?.trim() || null,
      goalApp: goalAppOf(env),
      goalAppsByOrg: goalAppsByOrgOf(env.SARVAM_GOAL_APP_BY_ORG),
      roleApps: roleAppsOf(env),
      receptionistApp: appOf(env, "SARVAM_RECEPTIONIST_APP"),
      voiceApps: readVoiceApps(env.SARVAM_VOICE_APPS),
    },
  };
}

const LANGUAGE_NAME: Record<CallLanguage, string> = {
  hi: "Hindi",
  mr: "Marathi",
  en: "English",
  kn: "Kannada",
  ta: "Tamil",
  te: "Telugu",
  bn: "Bengali",
  gu: "Gujarati",
};

export type OutboundRequest = {
  toNumber: string;
  variables: Record<string, string>;
  /** The agent's own greeting plays, in this language and the voice's gender. */
  language: CallLanguage;
  webhookUrl: string;
  metadata: Record<string, string>;
  /** Another agent in the same workspace (the goal agent, or a job's own). The qualifier when absent. */
  app?: SarvamApp;
};

/** One finished call as Sarvam's own log holds it, for a call whose webhook never came. */
export type SarvamAttempt = {
  attemptId: string;
  interactionId: string | null;
  connectivity: string;
  durationS: number | null;
  failureReason: string | null;
  /** The agent's variables at the end: what it heard, and ours. */
  variables: Record<string, unknown>;
};

export type SarvamTurn = { role: string; content: string };

export type SarvamDriver = {
  placeOutbound(config: SarvamConfig, req: OutboundRequest): Promise<{ attemptId: string }>;
  /** Finished calls of one agent between two instants. Absent on a driver that cannot ask. */
  listAttempts?(config: SarvamConfig, appId: string, from: Date, to: Date): Promise<SarvamAttempt[]>;
  /** What was said on one call, turn by turn. */
  getTranscript?(config: SarvamConfig, appId: string, interactionId: string): Promise<SarvamTurn[]>;
  /** The recording's bytes, or null when Sarvam kept none. Filed under the agent that made the call. */
  getRecording(config: SarvamConfig, interactionId: string, appId?: string): Promise<Response | null>;
  /**
   * One connection in our workspace, to check an id a person recorded
   * against a number: whether it exists, and the numbers it carries when
   * Sarvam lists them (null when it does not say). Absent on a driver that
   * cannot ask.
   */
  getConnection?(config: SarvamConfig, connectionId: string): Promise<{ exists: boolean; numbers: string[] | null }>;
};

const BASE = "https://apps.sarvam.ai/api";

/** Sarvam's refusal, trimmed to something a person can read. */
async function refusal(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  let detail = text;
  try {
    const j = JSON.parse(text) as { detail?: unknown; message?: unknown };
    detail = typeof j.detail === "string" ? j.detail : typeof j.message === "string" ? j.message : JSON.stringify(j.detail ?? j);
  } catch {
    /* not JSON */
  }
  return new Error(`Sarvam ${res.status}: ${detail.slice(0, 300)}`);
}

/** One request to Sarvam for one outbound call. */
async function postOutbound(
  c: Parameters<SarvamDriver["placeOutbound"]>[0],
  req: Parameters<SarvamDriver["placeOutbound"]>[1],
): Promise<{ attemptId: string }> {
  if (!c.fromNumber) throw new Error("No number to call from.");
  const res = await fetch(`${BASE}/outbounds/v1/orgs/${c.orgId}/workspaces/${c.workspaceId}/outbounds`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": c.apiKey },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      app_config: {
        app_id: req.app?.id ?? c.appId,
        app_version: req.app?.version ?? c.appVersion,
        connection_config: { connection_id: c.connectionId, agent_phone_number: c.fromNumber },
        agent_variables: req.variables,
        app_overrides: { initial_language_name: LANGUAGE_NAME[req.language] },
      },
      user_config: { user_phone_number: req.toNumber },
      webhook_config: { url: req.webhookUrl, metadata: req.metadata },
    }),
  });
  if (!res.ok) throw await refusal(res);
  const body = (await res.json()) as { attempt_id?: string };
  if (!body.attempt_id) throw new Error("Sarvam accepted the call but returned no attempt id.");
  return { attemptId: body.attempt_id };
}

/** Tries at placing one call, and the waits between them. */
export const PLACE_ATTEMPTS = 3;
const PLACE_BACKOFF_MS = [2_000, 5_000];

/** Sarvam answered and said it failed: nothing was made. */
function sarvamSaidNo(err: unknown): boolean {
  return err instanceof Error && /^Sarvam (5\d\d|429):/.test(err.message);
}

/** Worth another try: Sarvam's own fault, a rate limit, or the line to it dropped. */
function retryable(err: unknown): boolean {
  if (sarvamSaidNo(err)) return true;
  if (!(err instanceof Error)) return false;
  if (/^Sarvam \d{3}:/.test(err.message)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError" || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket/i.test(err.message);
}

/** The attempt Sarvam made for this call after all, null for none, "unknown" when its log could not be read. */
async function madeAlready(
  c: Parameters<SarvamDriver["placeOutbound"]>[0],
  appId: string,
  callId: string,
  since: number,
): Promise<string | null | "unknown"> {
  try {
    const all = await realDriver.listAttempts!(c, appId, new Date(since - 60_000), new Date(Date.now() + 60_000));
    return all.find((a) => a.variables.salesdesk_call === callId)?.attemptId ?? null;
  } catch {
    return "unknown";
  }
}

const realDriver: SarvamDriver = {
  // A call that fails on Sarvam's side is tried again, up to
  // PLACE_ATTEMPTS in all, because a lost first call is a lost buyer (the
  // client, 23 October 2026). Retried: a 5xx, a 429, a timeout or a dropped
  // connection. Never retried: any other 4xx (a bad variable, a bad number),
  // which another try cannot fix. Before each retry Sarvam's attempts log is
  // asked whether this call (its own id) was made after all, so a buyer is
  // not rung twice; a timeout or dropped connection may have made one, so
  // there the log must be read before trying again.
  async placeOutbound(c, req) {
    const callId = req.variables.salesdesk_call;
    const appId = req.app?.id ?? c.appId;
    const started = Date.now();
    let last: unknown;
    for (let attempt = 1; attempt <= PLACE_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, PLACE_BACKOFF_MS[attempt - 2] ?? 5_000));
        const made = callId ? await madeAlready(c, appId, callId, started) : null;
        if (made === "unknown" && !sarvamSaidNo(last)) throw last;
        if (made && made !== "unknown") return { attemptId: made };
      }
      try {
        return await postOutbound(c, req);
      } catch (err) {
        last = err;
        if (!retryable(err)) throw err;
        console.warn(`sarvam: outbound try ${attempt} of ${PLACE_ATTEMPTS} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
    }
    throw last;
  },

  async listAttempts(c, appId, from, to) {
    const out: SarvamAttempt[] = [];
    const limit = 100;
    // Five pages at most: a window this narrow never holds five hundred calls,
    // and a loop that pages for ever on a misread reply is worse than a miss.
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({
        start_datetime: `${from.toISOString().slice(0, 19)}Z`,
        end_datetime: `${to.toISOString().slice(0, 19)}Z`,
        limit: String(limit),
        offset: String(page * limit),
      });
      const res = await fetch(`${BASE}/analytics/v1/${c.orgId}/${c.workspaceId}/${encodeURIComponent(appId)}/attempts?${q}`, {
        headers: { "X-API-Key": c.apiKey },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw await refusal(res);
      const body = (await res.json()) as { items?: Record<string, unknown>[] };
      const items = Array.isArray(body.items) ? body.items : [];
      for (const it of items) {
        if (typeof it.attempt_id !== "string") continue;
        out.push({
          attemptId: it.attempt_id,
          interactionId: typeof it.interaction_id === "string" ? it.interaction_id : null,
          connectivity: typeof it.connectivity_status === "string" ? it.connectivity_status : "",
          durationS: typeof it.duration_in_seconds === "number" ? Math.round(it.duration_in_seconds) : null,
          failureReason:
            typeof it.failure_reason === "string" && it.failure_reason !== "NO_FAILURE_REASON" ? it.failure_reason : null,
          variables: it.agent_variables && typeof it.agent_variables === "object" ? (it.agent_variables as Record<string, unknown>) : {},
        });
      }
      if (items.length < limit) break;
    }
    return out;
  },

  async getTranscript(c, appId, interactionId) {
    const res = await fetch(
      `${BASE}/analytics/v1/${c.orgId}/${c.workspaceId}/${encodeURIComponent(appId)}/transcripts/${encodeURIComponent(interactionId)}`,
      { headers: { "X-API-Key": c.apiKey }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) throw await refusal(res);
    const body = (await res.json()) as { messages?: { role?: unknown; content?: unknown }[] };
    return (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => typeof m.content === "string")
      .map((m) => ({ role: String(m.role ?? "user"), content: String(m.content) }));
  },

  async getRecording(c, interactionId, appId) {
    const res = await fetch(
      `${BASE}/analytics/v1/${c.orgId}/${c.workspaceId}/${encodeURIComponent(appId ?? c.appId)}/recordings/${encodeURIComponent(interactionId)}`,
      // The signal covers reading the body too, and Sarvam sends a few
      // megabytes of WAV slowly: 12 seconds for 400 KB was measured.
      { headers: { "X-API-Key": c.apiKey }, signal: AbortSignal.timeout(60_000) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await refusal(res);
    // Either the audio itself, or a JSON body naming where it is.
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      const j = (await res.json()) as Record<string, unknown>;
      const url = [j.url, j.recording_url, j.signed_url, j.presigned_url].find((v) => typeof v === "string") as
        | string
        | undefined;
      if (!url) return null;
      const audio = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      return audio.ok ? audio : null;
    }
    return res;
  },

  // Written to the shape of the outbounds endpoint and never yet called:
  // the first connection checked through it is a test.
  async getConnection(c, connectionId) {
    const res = await fetch(
      `${BASE}/connections/v1/orgs/${c.orgId}/workspaces/${c.workspaceId}/connections/${encodeURIComponent(connectionId)}`,
      { headers: { "X-API-Key": c.apiKey }, signal: AbortSignal.timeout(10_000) },
    );
    if (res.status === 404) {
      // A page, not an answer: Sarvam publishes no connection lookup at this
      // address (28 October 2026, a 404 page for our own live connection), so
      // the id is taken at its word rather than every id refused.
      if (/^\s*</.test(await res.clone().text().catch(() => ""))) return { exists: true, numbers: null };
      return { exists: false, numbers: null };
    }
    if (!res.ok) throw await refusal(res);
    const j = (await res.json()) as Record<string, unknown>;
    const raw = [j.phone_numbers, j.agent_phone_numbers, j.numbers].find(Array.isArray) as unknown[] | undefined;
    const numbers = raw
      ? raw
          .map((n) => (typeof n === "string" ? n : typeof (n as { phone_number?: unknown })?.phone_number === "string" ? (n as { phone_number: string }).phone_number : ""))
          .map((n) => (n.startsWith("+") ? n : n ? `+${n.replace(/[^0-9]/g, "")}` : ""))
          .filter(Boolean)
      : null;
    return { exists: true, numbers };
  },
};

let injected: SarvamDriver | null = null;

/** For checks: route every Sarvam request through `driver` until `restore()`. */
export function useSarvam(driver: SarvamDriver): { restore(): void } {
  injected = driver;
  return { restore: () => void (injected = null) };
}

export const sarvam = (): SarvamDriver => injected ?? realDriver;
