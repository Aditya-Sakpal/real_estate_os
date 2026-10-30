"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { withTenant } from "@/lib/db";
import { setAgentVoice, type PickResult } from "@/lib/agent-voices";
import { VOICE_JOBS, isVoiceKey } from "@/lib/agent-catalog";
import type { AgentJob } from "@/lib/billing-rules";

/**
 * Pick the voice an agent speaks in on one project. `org:manage` at that
 * project; the plan, the agent and whether that voice is set up to call are
 * asked again in `setAgentVoice()`, whatever the screen offered.
 */
export async function setAgentVoiceAction(input: { projectId: string; job: string; voice: string }): Promise<PickResult> {
  const { userId, orgId, authz } = await requirePermission("org:manage", "/dashboard/agents");
  const job = input?.job as AgentJob;
  if (!VOICE_JOBS.includes(job) || !isVoiceKey(input?.voice) || !/^[0-9a-f-]{36}$/i.test(String(input?.projectId ?? ""))) {
    return { ok: false, message: "That choice could not be read." };
  }
  const [node] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
    SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${input.projectId} AND kind = 'PROJECT'`);
  if (!node) return { ok: false, message: "That project was not found." };
  if (!authz.canAt("org:manage", node.path)) return { ok: false, message: "You cannot change this project's agents." };
  const r = await setAgentVoice({ orgId, userId, projectId: input.projectId, job, voice: input.voice });
  if (r.ok) revalidatePath("/dashboard/agents");
  return r;
}
