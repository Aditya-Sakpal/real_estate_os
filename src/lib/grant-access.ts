import { cache } from "react";
import { controlDb, withTenant } from "@/lib/db";
import { buildAuthz, resolveAuthz, NO_ACCESS, type Authz, type Grant } from "@/lib/rbac";
import { resolvePhoneAuthz } from "@/lib/phone-session";
import { phoneMayUse, type SignInMethod } from "@/lib/phone-session-rules";
import { mandateGrants, throughGrant, type Desk } from "@/lib/grant-rules";
import type { ScopeKind } from "@/lib/roles";
import type { OrgState } from "@/lib/onboarding";
import { plainReason, type QueueItem } from "@/lib/queue";

/**
 * Working through a mandate (0060, 0065). A mandate firm's person opens a
 * developer's projects in the console: the data is the developer's, read
 * and written inside the developer's tenant; the reach is the live
 * MANDATE_FIRM grants, and what they may do there is `throughGrant()` of
 * their own role in their firm. Nothing here is a membership in the
 * developer: the day the mandate ends, the access ends with it.
 */

export type MandateContext = {
  devOrgId: string;
  devName: string;
  firmOrgId: string;
  firmName: string;
};

/**
 * Every developer this person may work for through a live mandate, as a
 * member of the firm holding it. Read on the control connection, as a
 * membership is: it decides which tenant the person is in.
 */
export const mandateContexts = cache(async (userId: string): Promise<MandateContext[]> => {
  const rows = await controlDb<{ dev_org_id: string; dev_name: string; firm_org_id: string; firm_name: string }[]>`
    SELECT DISTINCT d.id AS dev_org_id, d.display_name AS dev_name, f.id AS firm_org_id, f.display_name AS firm_name
    FROM memberships m
    JOIN orgs f ON f.id = m.org_id AND f.type = 'MANDATE_FIRM' AND f.status = 'ACTIVE'
    JOIN grants g ON g.grantee_org_id = f.id AND g.role = 'MANDATE_FIRM' AND g.status = 'ACTIVE'
                 AND now() >= g.valid_from AND now() < g.valid_to
    JOIN orgs d ON d.id = g.org_id AND d.status = 'ACTIVE'
    WHERE m.user_id = ${userId} AND m.status = 'ACTIVE'
    ORDER BY d.display_name`;
  return rows.map((r) => ({ devOrgId: r.dev_org_id, devName: r.dev_name, firmOrgId: r.firm_org_id, firmName: r.firm_name }));
});

/** What a firm's person may do on the developer's mandated projects, and where. */
export const grantAuthz = cache(async (userId: string, firmOrgId: string, devOrgId: string): Promise<Authz> => {
  const [own, nodes] = await Promise.all([
    resolveAuthz(userId, firmOrgId),
    controlDb<{ id: string; path: string; kind: ScopeKind; name: string }[]>`
      SELECT n.id, n.path::text AS path, n.kind, n.name
      FROM grants g JOIN scope_nodes n ON n.id = g.scope_node_id
      WHERE g.org_id = ${devOrgId} AND g.grantee_org_id = ${firmOrgId} AND g.role = 'MANDATE_FIRM'
        AND g.status = 'ACTIVE' AND now() >= g.valid_from AND now() < g.valid_to`,
  ]);
  const held = own.isAdmin ? new Set(["*"]) : own.permissions;
  return buildAuthz(mandateGrants(nodes, throughGrant(held)));
});

/** The live mandates a firm holds from a developer: the desk its people work from there. */
export const mandateDesk = cache(async (firmOrgId: string, devOrgId: string): Promise<Desk> => {
  const rows = await withTenant(devOrgId, (sql) => sql<{ id: string }[]>`
    SELECT id FROM mandates
    WHERE org_id = ${devOrgId} AND firm_org_id = ${firmOrgId} AND status = 'LIVE'
      AND now() >= valid_from AND now() < valid_to`);
  return { kind: "MANDATE", mandateIds: rows.map((r) => r.id) };
});

/** A mandate firm's own people, read in the firm's own tenant: who may look after a partner it empanels. */
export const firmPeople = cache(async (firmOrgId: string): Promise<{ id: string; name: string }[]> => {
  return withTenant(firmOrgId, (sql) => sql<{ id: string; name: string }[]>`
    SELECT DISTINCT u.id, coalesce(u.name, split_part(u.email::text, '@', 1)) AS name
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${firmOrgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL ORDER BY 2`);
});

/**
 * The one way a request's reach is resolved: a member's roles, or, working
 * through a mandate, the grant as far as their firm role reaches. The
 * guard and the console both ask here, so a screen and its action cannot
 * disagree about what a person may do.
 */
export async function authzFor(
  userId: string,
  state: Extract<OrgState, { kind: "MEMBER" }>,
  method: SignInMethod | undefined,
): Promise<{ authz: Authz; desk: Desk; stepUp: Grant[] }> {
  // A phone session: a channel partner's own console only, cut to the
  // in-session tier, never the wildcard. Anywhere else it holds nothing.
  if (method === "phone") {
    if (!phoneMayUse(state.orgType, state.via)) return { authz: NO_ACCESS, desk: { kind: "OWN" }, stepUp: [] };
    const { authz, stepUp } = await resolvePhoneAuthz(userId, state.orgId);
    return { authz, desk: { kind: "OWN" }, stepUp };
  }
  if (!state.via) return { authz: await resolveAuthz(userId, state.orgId), desk: { kind: "OWN" }, stepUp: [] };
  const [authz, desk] = await Promise.all([grantAuthz(userId, state.via.firmOrgId, state.orgId), mandateDesk(state.via.firmOrgId, state.orgId)]);
  return { authz, desk, stepUp: [] };
}

/**
 * Today, for somebody working through a mandate: only what is on the
 * mandated projects. The developer's own queue (its connections, its plan,
 * its other towers, its team) is none of the firm's business.
 */
export async function mandateQueue(devOrgId: string, scopes: string[], desk: Desk): Promise<QueueItem[]> {
  if (!scopes.length) return [];
  const mandateIds = desk.kind === "MANDATE" ? desk.mandateIds : [];
  const [row] = await withTenant(devOrgId, (sql) => sql<{
    needs: number; first_need: string | null; visits: number; no_shows: number; invoices: number;
    ending: { project: string; last: Date; tail: number }[] | null;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
        WHERE l.org_id = ${devOrgId} AND l.needs_person IS NOT NULL AND n.path <@ ANY(${scopes}::ltree[])) AS needs,
      (SELECT l.needs_person FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
        WHERE l.org_id = ${devOrgId} AND l.needs_person IS NOT NULL AND n.path <@ ANY(${scopes}::ltree[])
        ORDER BY l.last_activity_at LIMIT 1) AS first_need,
      (SELECT count(*)::int FROM site_visits v JOIN scope_nodes n ON n.id = v.scope_node_id
        WHERE v.org_id = ${devOrgId} AND v.status IN ('REQUESTED', 'CONFIRMED') AND n.path <@ ANY(${scopes}::ltree[])
          AND (v.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS visits,
      (SELECT count(*)::int FROM site_visits v JOIN scope_nodes n ON n.id = v.scope_node_id
        WHERE v.org_id = ${devOrgId} AND v.status = 'NO_SHOW' AND n.path <@ ANY(${scopes}::ltree[])
          AND (v.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS no_shows,
      (SELECT count(*)::int FROM payout_milestones ms JOIN partner_payouts p ON p.id = ms.payout_id
        WHERE ms.org_id = ${devOrgId} AND ms.stage = 'INVOICED' AND p.cancelled_at IS NULL
          AND p.payer_mandate_id = ANY(${mandateIds}::uuid[])) AS invoices,
      (SELECT json_agg(json_build_object('project', mp.project_name, 'last', m.valid_to, 'tail', m.tail_days))
        FROM mandates m JOIN mandate_projects mp ON mp.mandate_id = m.id
        WHERE m.org_id = ${devOrgId} AND m.id = ANY(${mandateIds}::uuid[]) AND m.valid_to < now() + interval '30 days') AS ending`);
  const out: QueueItem[] = [];
  if (row?.needs) {
    out.push({
      id: "mandate-needs",
      severity: "warn",
      title: `${row.needs} ${row.needs === 1 ? "lead needs" : "leads need"} a person`,
      why: plainReason(row.first_need),
      action: "Open leads",
      href: "/dashboard/leads",
      tag: null,
      resolvers: ["lead:update"],
    });
  }
  if (row?.no_shows) {
    out.push({
      id: "mandate-no-shows",
      severity: "warn",
      title: `${row.no_shows} ${row.no_shows === 1 ? "buyer" : "buyers"} did not come today`,
      why: "Call them back and offer another time.",
      action: "Open site visits",
      href: "/dashboard/visits",
      tag: null,
      resolvers: ["visit:schedule"],
    });
  }
  if (row?.visits) {
    out.push({
      id: "mandate-visits",
      severity: "info",
      title: `${row.visits} site ${row.visits === 1 ? "visit" : "visits"} today`,
      why: "Check each buyer in when they arrive.",
      action: "Open site visits",
      href: "/dashboard/visits",
      tag: null,
      resolvers: ["visit:confirm"],
    });
  }
  if (row?.invoices) {
    out.push({
      id: "mandate-invoices",
      severity: "info",
      title: `${row.invoices} partner ${row.invoices === 1 ? "invoice" : "invoices"} to check`,
      why: "Verify each against what the booking owes, then approve it for payment.",
      action: "Open payouts",
      href: "/dashboard/partners?view=payouts",
      tag: null,
      resolvers: ["payout:approve"],
    });
  }
  for (const e of row?.ending ?? []) {
    const last = new Date(e.last);
    const days = Math.max(0, Math.floor((last.getTime() - Date.now()) / 86_400_000));
    out.push({
      id: `mandate-ending-${e.project}`,
      severity: days <= 7 ? "risk" : "warn",
      title: `Your mandate on ${e.project} ends ${days === 0 ? "today" : `in ${days} ${days === 1 ? "day" : "days"}`}`,
      why: e.tail
        ? `After its last day only buyers who came during it earn, for ${e.tail} days. Ask the developer to run it longer.`
        : "Bookings after its last day earn nothing. Ask the developer to run it longer.",
      action: "See your mandate",
      href: "/dashboard#your-mandate",
      tag: { text: days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"} left`, tone: days <= 7 ? "risk" : "warn" },
      // Only opens the card above the queue, where the request is made.
      resolvers: [],
    });
  }
  return out;
}
