"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { withTenant } from "@/lib/db";
import { saveSmsSettings } from "@/lib/sms";
import { SMS_PURPOSES, SMS_TEMPLATES, pickEntityId, pickHeader, pickTemplateId } from "@/lib/sms-rules";
import { VOICES, VOICE_WORDS } from "@/lib/message-rules";
import type { FormResult } from "@/components/KeptForm";

/**
 * The developer's DLT registration for SMS: `integration:manage`, like
 * every other connection. Every value is read back through the pure
 * parsers, and anything that cannot be read is refused by name, with
 * nothing saved, so a typo never replaces a working id.
 */
export async function saveSmsAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("integration:manage", "/dashboard/settings/connections");
  const rawEntity = String(formData.get("entityId") ?? "");
  const rawHeader = String(formData.get("header") ?? "");
  const entityId = pickEntityId(rawEntity);
  const header = pickHeader(rawHeader);
  const problems: string[] = [];
  if (!entityId) problems.push(`DLT entity id: ${rawEntity.trim() || "empty"} is not 19 digits.`);
  if (!header) problems.push(`Header: ${rawHeader.trim() || "empty"} is not six letters.`);

  const templates = [];
  for (const purpose of SMS_PURPOSES) {
    for (const voice of VOICES) {
      const raw = String(formData.get(`t_${purpose}_${voice}`) ?? "").trim();
      const templateId = raw ? pickTemplateId(raw) : null;
      if (raw && !templateId) problems.push(`${SMS_TEMPLATES[purpose].label}, ${VOICE_WORDS[voice]}: ${raw} is not 19 digits.`);
      templates.push({ purpose, voice, templateId });
    }
  }
  if (problems.length) return { ok: false, message: problems.join(" ") };

  const [root] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`);
  if (!root) return { ok: false, message: "This organisation has no root." };
  await saveSmsSettings({ orgId, userId, nodeId: root.id, entityId: entityId!, header: header!, templates });
  revalidatePath("/dashboard/settings/connections/sms");
  redirect("/dashboard/settings/connections/sms?saved=1");
}
