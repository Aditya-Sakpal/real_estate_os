import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrgState } from "@/lib/onboarding";
import type { Authz, Grant } from "@/lib/rbac";
import type { SignInMethod } from "@/lib/phone-session-rules";
import { authzFor } from "@/lib/grant-access";
import type { Desk } from "@/lib/grant-rules";
import { hasConsole } from "@/lib/mandate-rules";

/**
 * The one gate every server action passes through.
 *
 * It asks for a PERMISSION, never a role name, so a tenant that renamed Sales
 * Head, retuned it, or wrote a role of its own does not break a single call
 * site. Nothing here trusts the request: the org comes from the viewer's own
 * resolved state rather than the form, and the permission is checked against
 * memberships read inside the tenant.
 */

export type Guarded = {
  userId: string;
  orgId: string;
  authz: Authz;
  /** The desk the person works from: the developer's own, or their firm's mandates. */
  desk: Desk;
  /** Set when working a developer's projects through a firm's mandate. */
  via?: { firmOrgId: string; firmName: string };
  /** How the session was started. A phone session holds the in-session tier only. */
  method: SignInMethod;
  /** A phone session only: what a fresh code for one action would open. */
  stepUp: Grant[];
};

export async function requirePermission(
  permission: string,
  fallback = "/dashboard",
): Promise<Guarded> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const state = await getUserOrgState(session.user.id);
  if (state.kind !== "MEMBER") redirect("/");
  if (!hasConsole(state.orgType)) redirect("/workspace");

  const method = session.method ?? "oauth";
  const { authz, desk, stepUp } = await authzFor(session.user.id, state, method);
  if (!authz.can(permission)) redirect(fallback);

  return { userId: session.user.id, orgId: state.orgId, authz, desk, via: state.via, method, stepUp };
}

/**
 * Any one of several permissions opens it. For a control whose bar is
 * deliberately lower than the power it limits: stopping an ad is open to
 * whoever may approve creative, publish, or manage budget.
 */
export async function requireAnyPermission(
  permissions: string[],
  fallback = "/dashboard",
): Promise<Guarded> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const state = await getUserOrgState(session.user.id);
  if (state.kind !== "MEMBER") redirect("/");
  if (!hasConsole(state.orgType)) redirect("/workspace");

  const method = session.method ?? "oauth";
  const { authz, desk, stepUp } = await authzFor(session.user.id, state, method);
  if (!permissions.some((p) => authz.can(p))) redirect(fallback);

  return { userId: session.user.id, orgId: state.orgId, authz, desk, via: state.via, method, stepUp };
}

/**
 * Same, but for an action that touches one node of the scope tree. Holding a
 * permission somewhere is not the same as holding it here: a Project Sales
 * Manager on Tower C may assign a lead on Tower C and nowhere else.
 */
export async function requirePermissionAt(
  permission: string,
  scopePath: string,
  fallback = "/dashboard",
): Promise<Guarded> {
  const guarded = await requirePermission(permission, fallback);
  if (!guarded.authz.canAt(permission, scopePath)) redirect(fallback);
  return guarded;
}

/**
 * A file route's gate: who is asking and what they hold, without the
 * console's state. `getViewer()` also loads Today, the projects and the
 * readiness, about 35 reads, and a template picker of forty tiles ran it
 * forty times, which on a database in another city was most of the wait.
 * Null where `getViewer()` would be null.
 */
export async function fileReader(): Promise<{ userId: string; orgId: string; authz: Authz } | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const state = await getUserOrgState(session.user.id);
  if (state.kind !== "MEMBER" || !hasConsole(state.orgType)) return null;
  const { authz } = await authzFor(session.user.id, state, session.method ?? "oauth");
  return { userId: session.user.id, orgId: state.orgId, authz };
}
