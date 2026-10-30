"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { deleteThread } from "@/lib/ask";
import { setActionsOn } from "@/lib/ask-actions";
import { requirePermission } from "@/lib/guard";

/**
 * Deleting a chat. Only its owner can: the row is read back through
 * `withPerson()`, so an id belonging to somebody else deletes nothing.
 */
export async function deleteChatAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  const id = String(formData.get("threadId") ?? "");
  await deleteThread(viewer.state.org.id, viewer.userId, id);
  redirect("/dashboard/ask");
}

/**
 * Whether Jimmy may take actions in this organisation at all. `org:manage`,
 * because it is a decision about the whole organisation, not about one
 * person's reach: each action still needs its own key, held where it acts.
 */
export async function setJimmyActionsAction(formData: FormData): Promise<void> {
  const g = await requirePermission("org:manage");
  await setActionsOn(g.orgId, g.userId, formData.get("on") === "true");
  revalidatePath("/dashboard/settings");
}
