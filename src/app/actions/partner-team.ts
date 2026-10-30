"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { invitePhonePerson, removePhonePerson } from "@/lib/partner-team";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/**
 * A channel partner firm's owner adding and removing its own people by
 * phone. The firm, the giving rule and the number are all decided in
 * `partner-team.ts`; nothing here believes the form beyond the name and the
 * number typed.
 */

const TEAM = "/dashboard/team";

export async function invitePhoneAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("member:invite", TEAM);
  const r = await invitePhonePerson({
    orgId,
    actorUserId: userId,
    authz,
    name: String(formData.get("name") ?? ""),
    phone: String(formData.get("phone") ?? ""),
  });
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath(TEAM);
  redirect(`${TEAM}?${flash("phoneAdded", r.message)}#by-phone`);
}

export async function removePhonePersonAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("member:remove", TEAM);
  const r = await removePhonePerson({ orgId, actorUserId: userId, authz, membershipId: String(formData.get("membershipId") ?? "") });
  revalidatePath(TEAM);
  redirect(`${TEAM}?${flash(r.ok ? "phoneAdded" : "error", r.message)}#by-phone`);
}
