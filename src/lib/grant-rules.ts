/**
 * Working through a grant: the rules, pure and database-free, covered by
 * `check:logic`.
 *
 * A mandate firm's people work inside the developer's tenant, on the
 * projects the live mandate names and nowhere else. What they may do there
 * is two things at once: the ceiling a mandate carries (the developer's
 * selling work, never the developer's controls), and what their own role in
 * their own firm allows. Both have to say yes.
 */

import type { Grant } from "./rbac-rules.ts";

/**
 * The most a mandate firm may do on a developer's project. Selling: leads,
 * calls, visits, availability, drafting a quote. Reading what the developer
 * signed: the facts, the registration, approved pictures and prices, the
 * brand. Making posts for the developer to approve. And its own channel
 * partners (the partner and payout keys reach only its own desk).
 *
 * Never: signing or editing facts, RERA, prices, approving a quote or a
 * post, publishing, budgets, the developer's own partners, its team,
 * settings, billing, reports of its spend, exporting its buyers.
 */
export const MANDATE_CEILING: readonly string[] = [
  "lead:read",
  "lead:create",
  "lead:update",
  "lead:assign",
  "lead:call",
  "lead.phone:unmask",
  "inventory:read",
  "quote:create",
  "loan:update",
  "visit:read",
  "visit:schedule",
  "visit:confirm",
  "visit:outcome",
  "project:read",
  "rera:read",
  "brain:read",
  "unit:read",
  "asset:read",
  "brand:read",
  "campaign:read",
  "campaign:create",
  "partner:read",
  "partner:empanel",
  "partner:suspend",
  "partner:register",
  "payout:read",
  "payout:approve",
  "payout:pay",
];

/** What a person may do through the grant: the ceiling, as far as their own role reaches. */
export function throughGrant(ownPermissions: ReadonlySet<string>, ceiling: readonly string[] = MANDATE_CEILING): Set<string> {
  if (ownPermissions.has("*")) return new Set(ceiling);
  return new Set(ceiling.filter((p) => ownPermissions.has(p)));
}

/** The grants a person holds through a live mandate: one per project, each the same permissions. */
export function mandateGrants(
  nodes: { id: string; path: string; kind: Grant["scopeKind"]; name: string }[],
  permissions: ReadonlySet<string>,
): Grant[] {
  if (!permissions.size) return [];
  return nodes.map((n) => ({
    role: "MANDATE_FIRM",
    roleLabel: "Mandate firm",
    scopeNodeId: n.id,
    scopePath: n.path,
    scopeKind: n.kind,
    scopeName: n.name,
    permissions,
  }));
}

/**
 * The roles a mandate firm gives its own people. A firm has no tree of its
 * own (its people's place is the developer's project the mandate names), so
 * each is held at the firm and reaches only as far as the mandate does.
 */
export const FIRM_ROLES: readonly string[] = [
  "ORG_ADMIN",
  "SALES_HEAD",
  "PROJECT_SALES_MANAGER",
  "CLOSING_MANAGER",
  "LOAN_EXECUTIVE",
  "PRESALES_MANAGER",
  "PRESALES_AGENT",
  "SITE_TEAM",
  "CP_RELATIONSHIP_MANAGER",
  "FINANCE_APPROVER",
  "MARKETING_EXEC",
];

/** A path in reach: one of the scopes covers it, or it covers one of them (a project above a tower). */
export function inReach(path: string, scopes: readonly string[]): boolean {
  return scopes.some((s) => path === s || path.startsWith(`${s}.`) || s.startsWith(`${path}.`));
}

/** Which desk a person works from: the developer's own, or their firm's mandates on this developer. */
export type Desk = { kind: "OWN" } | { kind: "MANDATE"; mandateIds: string[] };

export const deskOwns = (desk: Desk, mandateId: string | null) =>
  desk.kind === "OWN" ? mandateId === null : mandateId !== null && desk.mandateIds.includes(mandateId);

/** A channel partner's grant on one project, with the desk it came from (NULL is the developer's own). */
export type DeskGrant = { projectId: string; project: string; mandateId: string | null; status: "ACTIVE" | "SUSPENDED" | "ENDED"; validTo: string };

/**
 * The projects among `projectIds` a partner already sells through another
 * desk: a grant from a different desk that is not ended and has not run out.
 * A partner may sit on the developer's own desk for some projects and a
 * mandate firm's for others, but one project has it on one desk at a time,
 * so every buyer it registers there has one payer.
 */
export function onAnotherDesk(grants: readonly DeskGrant[], o: { projectIds: readonly string[]; mandateId: string | null; nowIso: string }): string[] {
  const now = Date.parse(o.nowIso);
  const names = grants
    .filter((g) => o.projectIds.includes(g.projectId) && g.status !== "ENDED" && g.mandateId !== o.mandateId && Date.parse(g.validTo) > now)
    .map((g) => g.project);
  return [...new Set(names)];
}
