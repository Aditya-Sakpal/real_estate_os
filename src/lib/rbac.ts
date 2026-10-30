import { cache } from "react";
import { withTenant } from "@/lib/db";
import {
  buildAuthz,
  mergeRoles,
  type Authz,
  type Grant,
  type ResolvedRole,
  type RoleRow,
} from "@/lib/rbac-rules";
import type { ScopeKind } from "@/lib/roles";

/**
 * Resolution: turning "who is this person" into "what may they do, and where".
 *
 * Two merges happen, and only here.
 *
 *   1. Role definitions. The 14 shipped templates are merged with this
 *      tenant's org_roles rows. An OVERRIDE row replaces its template; a
 *      CUSTOM row is a role the tenant invented. A template with no row is
 *      used as shipped, which is how an untouched role keeps improving.
 *
 *   2. Grants. One person can hold several memberships in one org at
 *      different scope nodes. Each membership resolves to a role, the role to
 *      a permission set, and the pair is kept TOGETHER, because "Project
 *      Sales Manager" is only ever true at a particular subtree.
 *
 * The flat `permissions` union answers "may this person ever do X", which is
 * what a nav rail needs. `canAt` and `scopesFor` answer "here, on this row",
 * which is what every read of tenant data will need the moment lead data
 * exists.
 *
 * The rules themselves live in `rbac-rules.ts`, database-free and directly
 * testable. This file is only the reading.
 */

/** Every role this tenant can grant, shipped and invented, with usage counts. */
export const listOrgRoles = cache(async (orgId: string): Promise<ResolvedRole[]> => {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<RoleRow[]>`
      SELECT key, label, description, min_kind, can_delegate, source, permissions
      FROM org_roles
      WHERE org_id = ${orgId}
    `;
    const countRows = await sql<{ role: string; n: string }[]>`
      SELECT role, count(*)::text AS n
      FROM memberships
      WHERE org_id = ${orgId} AND status <> 'REVOKED'
      GROUP BY role
    `;
    return mergeRoles(rows, new Map(countRows.map((r) => [r.role, Number(r.n)])));
  });
});

export function roleFrom(roles: ResolvedRole[], key: string): ResolvedRole | undefined {
  return roles.find((r) => r.key === key);
}

export const resolveAuthz = cache(
  async (userId: string, orgId: string): Promise<Authz> => {
    const [roles, rows] = await Promise.all([
      listOrgRoles(orgId),
      withTenant(orgId, async (sql) => {
        return sql<
          {
            role: string;
            scope_node_id: string;
            path: string;
            kind: ScopeKind;
            name: string;
          }[]
        >`
          SELECT m.role, m.scope_node_id, s.path::text AS path, s.kind, s.name
          FROM memberships m
          JOIN scope_nodes s ON s.id = m.scope_node_id
          WHERE m.user_id = ${userId}
            AND m.org_id = ${orgId}
            AND m.status = 'ACTIVE'
        `;
      }),
    ]);
    const byKey = new Map(roles.map((r) => [r.key, r]));

    const grants: Grant[] = [];
    for (const r of rows) {
      const role = byKey.get(r.role);
      // A membership naming a role that no longer exists grants nothing. It
      // must not become an open door: a deleted role failing open would be
      // the worst possible way to find out the role was deleted.
      if (!role) continue;
      grants.push({
        role: r.role,
        roleLabel: role.label,
        scopeNodeId: r.scope_node_id,
        scopePath: r.path,
        scopeKind: r.kind,
        scopeName: r.name,
        permissions: new Set(role.permissions),
      });
    }

    return buildAuthz(grants);
  },
);

export {
  buildAuthz,
  customRoleKey,
  heldAtPath,
  mergeRoles,
  minimalScopes,
  missingToGrant,
  rootOf,
  NO_ACCESS,
  roleFitsScope,
  scopeCovers,
  validateRoleInput,
} from "@/lib/rbac-rules";

export type {
  Authz,
  Grant,
  ResolvedRole,
  RoleInput,
  RoleRow,
  RoleSource,
} from "@/lib/rbac-rules";
