import { audit, withTenant } from "./db/index.ts";
import { planAt } from "./billing.ts";
import type { AgentJob } from "./billing-rules.ts";
import { agentCard, isVoiceKey, voiceIn, voiceOpen, voicePickProblem, type VoiceKey } from "./agent-catalog.ts";
import { voicesReady, type VoiceApps } from "./voice-apps-rules.ts";
import { sarvamConfig } from "./sarvam.ts";
import { agentJobFor } from "./billing-rules.ts";

/**
 * The voice each calling agent speaks in, per project. A client picks it on
 * the AI agents screen, from the voices the project's plan opens; a call
 * reads it just before it is placed, and a voice the plan no longer opens
 * falls back to the agent's own.
 */

/** The jobs' own Sarvam agents, by job, for which voices each can speak. */
function ownApps(): { map: VoiceApps; own: Partial<Record<AgentJob, string>> } {
  const cfg = sarvamConfig();
  if (!cfg.ok) return { map: new Map(), own: {} };
  const c = cfg.config;
  return {
    map: c.voiceApps,
    own: {
      QUALIFIER: c.appId,
      CONFIRMER: c.roleApps.confirmer?.id,
      REENGAGER: c.roleApps.reengager?.id,
      POST_VISIT: c.roleApps.post_visit?.id,
    },
  };
}

/** Which voices each job can speak in today, given the copies set up on Sarvam. */
export function readyVoices(): Partial<Record<AgentJob, Set<VoiceKey>>> {
  const { map, own } = ownApps();
  const out: Partial<Record<AgentJob, Set<VoiceKey>>> = {};
  for (const job of ["QUALIFIER", "CONFIRMER", "REENGAGER", "POST_VISIT"] as AgentJob[]) {
    out[job] = voicesReady(map, own[job] ?? null, agentCard(job)?.voice ?? null);
  }
  return out;
}

/** The voices picked on one project, by job. */
export async function pickedVoices(orgId: string, projectId: string): Promise<Partial<Record<AgentJob, VoiceKey>>> {
  const rows = await withTenant(orgId, (sql) => sql<{ job: AgentJob; voice: string }[]>`
    SELECT job, voice FROM agent_voices WHERE org_id = ${orgId} AND project_id = ${projectId}`);
  const out: Partial<Record<AgentJob, VoiceKey>> = {};
  for (const r of rows) if (isVoiceKey(r.voice)) out[r.job] = r.voice;
  return out;
}

export type PickResult = { ok: true; voice: VoiceKey } | { ok: false; message: string };

/** Pick an agent's voice on a project, asking the plan and the copies first. */
export async function setAgentVoice(o: { orgId: string; userId: string; projectId: string; job: AgentJob; voice: VoiceKey }): Promise<PickResult> {
  const where = await planAt(o.orgId, o.projectId);
  if (where.projectId !== o.projectId) return { ok: false, message: "That project was not found." };
  const ready = readyVoices()[o.job]?.has(o.voice) ?? false;
  const plan = where.plan;
  const problem = voicePickProblem({ job: o.job, voice: o.voice, plan, billed: where.billed, ready });
  if (problem) return { ok: false, message: problem };
  const own = agentCard(o.job)?.voice;
  await withTenant(o.orgId, async (sql) => {
    if (o.voice === own) {
      await sql`DELETE FROM agent_voices WHERE org_id = ${o.orgId} AND project_id = ${o.projectId} AND job = ${o.job}`;
    } else {
      await sql`
        INSERT INTO agent_voices (org_id, project_id, job, voice, set_by)
        VALUES (${o.orgId}, ${o.projectId}, ${o.job}, ${o.voice}, ${o.userId})
        ON CONFLICT (org_id, project_id, job) DO UPDATE SET voice = EXCLUDED.voice, set_by = EXCLUDED.set_by, set_at = now()`;
    }
  });
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "agent.voice_set",
    targetType: "scope_node",
    targetId: o.projectId,
    metadata: { job: o.job, voice: o.voice },
  });
  return { ok: true, voice: o.voice };
}

/**
 * The voice a call speaks in: what was picked on the node's project, while
 * the plan still opens it, else the agent's own. Null for an agent with no
 * voice to pick.
 */
export async function voiceForCall(orgId: string, nodeId: string, agent: string): Promise<VoiceKey | null> {
  const job = agentJobFor(agent);
  const card = agentCard(job);
  if (!card?.choosable) return card?.voice ?? null;
  const where = await planAt(orgId, nodeId).catch(() => null);
  if (!where?.projectId) return card.voice;
  const picked = await pickedVoices(orgId, where.projectId).catch(() => ({}) as Partial<Record<AgentJob, VoiceKey>>);
  const voice = voiceIn(card, picked);
  return voice && voiceOpen(voice, where.plan, where.billed) ? voice : card.voice;
}
