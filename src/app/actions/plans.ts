"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { flash } from "@/lib/flash";
import { withTenant } from "@/lib/db";
import { confirmTopUp, type Checkout } from "@/lib/billing-pay";
import { orgTypeOf, setBillingState, startPlanPurchase } from "@/lib/plan-purchase";
import { afterPlanPaidQuietly } from "@/lib/plan-after";

/**
 * Buying a plan from the console: for one new project (a developer or a
 * mandate firm), or for the whole firm (a channel partner). Paying takes
 * `billing:manage`; a plan that creates a project takes `project:create` too.
 */

export type PlanStart = { ok: true; checkout: Checkout } | { ok: false; message: string };

export async function startPlanAction(input: {
  plan: string;
  entityId?: string;
  city?: string;
  name?: string;
  projectId?: string;
  state?: string;
}): Promise<PlanStart> {
  const g = await requirePermission("billing:manage", "/dashboard/projects");
  if (g.via) return { ok: false, message: "A plan is bought by the company that runs the project." };
  const withProject = !!(input?.name || input?.city || input?.entityId);
  if (withProject && !g.authz.can("project:create")) return { ok: false, message: "You can't add projects here." };
  if (input?.state) await setBillingState(g.orgId, g.userId, String(input.state).slice(0, 2));
  const [orgType, me] = await Promise.all([
    orgTypeOf(g.orgId),
    withTenant(g.orgId, (sql) => sql<{ email: string | null }[]>`SELECT email::text AS email FROM users WHERE id = ${g.userId}`),
  ]);
  return startPlanPurchase({
    orgId: g.orgId,
    userId: g.userId,
    userEmail: me[0]?.email ?? null,
    orgType,
    plan: String(input?.plan ?? ""),
    newProject: withProject ? { entityId: input.entityId, city: input.city, name: input.name } : null,
    projectId: input?.projectId ? String(input.projectId).slice(0, 40) : null,
  });
}

/** Checkout's answer for a plan. Settles now (the project and its plan), then rents its number after the answer. */
export async function confirmPlanAction(p: { orderId: string; paymentId: string; signature: string }): Promise<{ ok: true; next: string } | { ok: false; message: string }> {
  const g = await requirePermission("billing:manage", "/dashboard/projects");
  const r = await confirmTopUp({
    orgId: g.orgId,
    userId: g.userId,
    orderId: String(p?.orderId ?? "").slice(0, 100),
    paymentId: String(p?.paymentId ?? "").slice(0, 100),
    signature: String(p?.signature ?? "").slice(0, 200),
  });
  if (!r.ok) return r;
  if (r.plan) after(() => afterPlanPaidQuietly(g.orgId, r.plan));
  revalidatePath("/dashboard/projects");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/settings/billing");
  if (r.plan?.inserted) {
    return { ok: true, next: `/dashboard/projects?created=${encodeURIComponent(r.plan.inserted.path)}&${flash("saved", `${r.plan.inserted.name} is on its plan.`)}` };
  }
  if (r.plan?.scope === "ORG") {
    return { ok: true, next: `/dashboard/projects?new=1&${flash("saved", "Your plan is on. Add your projects.")}#new-project` };
  }
  return { ok: true, next: `/dashboard/projects?${flash("saved", "Paid. The plan is on.")}` };
}

const PROJECTS = "/dashboard/projects";

/** A channel partner asks to move its firm to a smaller plan, from the first of next month. */
export async function requestDowngradeAction(formData: FormData): Promise<void> {
  const g = await requirePermission("billing:manage", PROJECTS);
  const { requestDowngrade } = await import("@/lib/plan-renewal");
  const r = g.via
    ? { ok: false as const, message: "A plan is changed by the company that holds it." }
    : await requestDowngrade({ orgId: g.orgId, userId: g.userId, to: String(formData.get("to") ?? "") });
  revalidatePath(PROJECTS);
  if (!r.ok) redirect(`${PROJECTS}?${flash("error", r.message)}`);
  const day = new Date(`${r.effectiveOn}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" });
  redirect(`${PROJECTS}?${flash("saved", `Your firm moves to ${r.label} on ${day}. Until then nothing changes.`)}`);
}

/** Withdraw a move to a smaller plan that has not happened yet. */
export async function cancelDowngradeAction(formData: FormData): Promise<void> {
  const g = await requirePermission("billing:manage", PROJECTS);
  const { cancelDowngrade } = await import("@/lib/plan-renewal");
  const r = await cancelDowngrade({ orgId: g.orgId, userId: g.userId, changeId: String(formData.get("change") ?? "") });
  revalidatePath(PROJECTS);
  redirect(`${PROJECTS}?${r.ok ? flash("saved", "You stay on your plan.") : flash("error", r.message)}`);
}
