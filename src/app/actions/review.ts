"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAnyPermission } from "@/lib/guard";
import { approveShown } from "@/lib/review";
import { isNodeId } from "@/lib/scope-rules";
import { flash } from "@/lib/flash";
import type { ReviewKind } from "@/lib/review-rules";

const KINDS: ReviewKind[] = ["VALUES", "PICTURES", "FLATS"];

/** Accept or approve every row of one kind the review screen showed. */
export async function approveShownAction(formData: FormData): Promise<void> {
  const g = await requireAnyPermission(["brain:edit", "asset:approve", "brain.price:approve"], "/dashboard/projects");
  const projectId = String(formData.get("projectId") ?? "");
  const kind = KINDS.find((k) => k === formData.get("kind"));
  if (!isNodeId(projectId) || !kind) redirect("/dashboard/projects");
  const r = await approveShown({ orgId: g.orgId, userId: g.userId, projectId, authz: g.authz, kind, ids: formData.getAll("id") });
  revalidatePath(`/dashboard/projects/${projectId}`);
  revalidatePath(`/dashboard/projects/${projectId}/review`);
  revalidatePath("/dashboard");
  redirect(`/dashboard/projects/${projectId}/review?${flash(r.done > 0 ? "done" : "error", r.message)}`);
}
