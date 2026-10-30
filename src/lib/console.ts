import { cache } from "react";
import type { SignInMethod } from "@/lib/phone-session-rules";
import { auth } from "@/lib/auth";
import { controlDb } from "@/lib/db";
import { getUserOrgState, listUserOrgs, type OrgOption } from "@/lib/onboarding";
import { loadConsoleState, type ConsoleState } from "@/lib/queue";
import { navFor, roleLabel, type NavItem } from "@/lib/nav";
import { listOrgRoles, type Authz } from "@/lib/rbac";
import { authzFor, mandateQueue } from "@/lib/grant-access";
import { inReach, type Desk } from "@/lib/grant-rules";
import { hasConsole } from "@/lib/mandate-rules";
import { NOT_THROUGH_MANDATE_SCREENS } from "@/lib/ask-help";

export type Viewer = {
  userId: string;
  email: string;
  name: string | null;
  initials: string;
  /** What this person may do in the active org, and where. */
  authz: Authz;
  /** Every role key held here, across all scope nodes. */
  roles: string[];
  primaryRole: string;
  primaryRoleLabel: string;
  nav: NavItem[];
  state: ConsoleState;
  /** Every org this person can switch into, including the current one. */
  orgs: OrgOption[];
  /** The desk this person works from: the developer's own, or their firm's mandates. */
  desk: Desk;
  /** Set when working a developer's projects through a firm's mandate. */
  via?: { firmOrgId: string; firmName: string };
  /** What kind of company this is: a developer, or a mandate firm selling developers' projects. */
  orgType: string;
  /** How the session was started. A phone session holds the in-session tier only. */
  method: SignInMethod;
  /** A phone session only: whether a fresh code for this one action would open it (at this place). */
  stepUpAt: (permission: string, scopePath?: string) => boolean;
};

/** What a firm working through a mandate never sees in the developer's console. */
const NOT_THROUGH_MANDATE = new Set<string>(NOT_THROUGH_MANDATE_SCREENS);

function initialsOf(name: string | null, email: string): string {
  const source = (name ?? "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase() || "CP";
}

/**
 * Resolved once per request and shared by the shell and the page, so the rail,
 * the top bar and the queue do not each re-query. React's cache() dedupes
 * within a single render pass.
 *
 * Returns null when the viewer has no org yet -- callers redirect.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;

  const orgState = await getUserOrgState(session.user.id);
  if (orgState.kind !== "MEMBER") return null;
  // The console is a developer's and a mandate firm's. A channel partner is
  // sent to its workspace by the root page.
  if (!hasConsole(orgState.orgType)) return null;

  // Every page runs this, so the five reads go out together rather than one
  // after another. In series they were most of a navigation's wait, and on a
  // database a continent away each one was a full round trip.
  const method = session.method ?? "oauth";
  const [loaded, [me], { authz, desk }, roles, orgs] = await Promise.all([
    loadConsoleState(orgState.orgId),
    // Control-plane read: identity and membership are not tenant-scoped rows.
    controlDb<{ email: string; name: string | null }[]>`
      SELECT email, name FROM users WHERE id = ${session.user.id}
    `,
    // Roles, their permissions and the scope each is held at, resolved
    // together. This is the only place the three are joined, so a screen can
    // never draw a rail from one source while an action checks another.
    authzFor(session.user.id, orgState, method),
    listOrgRoles(orgState.orgId),
    listUserOrgs(session.user.id),
  ]);
  if (!loaded) return null;

  // Through a mandate, the console is the mandated projects and nothing else
  // of the developer's: their other towers, their own queue and their
  // setup steps are none of the firm's business.
  let state = loaded;
  if (orgState.via) {
    const scopes = authz.grants.map((g) => g.scopePath);
    state = {
      ...loaded,
      org: { ...loaded.org, gstin: null, pan: "", primaryDomain: null },
      entityCount: 0,
      adminCount: 0,
      memberCount: 0,
      isFreshTenant: false,
      projects: loaded.projects.filter((p) => inReach(p.path, scopes)),
      places: loaded.places.filter((p) => loaded.projects.some((q) => inReach(q.path, scopes) && (q.id === p.id || p.href.includes(q.id)))),
      readiness: loaded.readiness.filter((r) => inReach(r.path, scopes)),
      queue: await mandateQueue(orgState.orgId, scopes, desk),
    };
  }

  const primaryLabel =
    roles.find((r) => r.key === orgState.role)?.label ?? roleLabel(orgState.role);

  const email = me?.email ?? session.user.email ?? "";

  return {
    userId: session.user.id,
    email,
    name: me?.name ?? null,
    initials: initialsOf(me?.name ?? null, email),
    authz,
    roles: authz.roleKeys,
    primaryRole: orgState.role,
    primaryRoleLabel: orgState.via ? `${orgState.via.firmName}, mandate` : primaryLabel,
    nav: orgState.via ? navFor(authz).filter((n) => !NOT_THROUGH_MANDATE.has(n.key)) : navFor(authz, orgState.orgType),
    state,
    orgs,
    desk,
    via: orgState.via,
    orgType: orgState.orgType,
    method,
    stepUpAt: (p, path) => Boolean(authz.stepUpAt?.(p, path)),
  };
});
