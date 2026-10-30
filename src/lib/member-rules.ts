/**
 * Changing or ending somebody's membership: the rules, with no database.
 *
 * Giving a role and taking one away are the same power seen from two sides,
 * so they answer to the same rule. You may change or remove a membership only
 * where you hold every permission its CURRENT role carries, and you may move
 * it only to a role you could have given in the first place. Without the
 * first half, a regional head could demote the national head sitting on
 * their region; without the second, a demotion could be a promotion.
 *
 * The founding role is left to its own controls (`admin.ts`), which carry the
 * work-account rule and the last-admin rule. And nobody changes their own
 * membership here, because the one mistake that cannot be undone from this
 * screen is removing the access you would need to undo it.
 *
 * Relative imports, like every `*-rules.ts`: `check:logic` loads this from
 * source.
 */

import { roleFitsScope, scopeCovers, missingToGrant } from "./rbac-rules.ts";
import { subsetRefusal } from "./invite-rules.ts";
import { permissionWords } from "./permissions.ts";
import { depthRefusal } from "./scope-rules.ts";
import { FOUNDING_ROLE, type ScopeKind } from "./roles.ts";

export type RoleShape = { key: string; label: string; minKind: ScopeKind; permissions: readonly string[] };

export type MemberChange = { kind: "ROLE"; next: RoleShape } | { kind: "REMOVE" };

export type MemberRefusal =
  | "SELF"
  | "ADMIN_ROLE"
  | "OUTSIDE_YOUR_SCOPE"
  | "NOT_YOURS_TO_CHANGE"
  | "SAME_ROLE"
  | "ROLE_TOO_DEEP"
  | "NOT_YOURS_TO_GIVE"
  | "ONLY_ADMIN_GRANTS_ADMIN";

export type MemberGate = { ok: true } | { ok: false; code: MemberRefusal; message: string };

export function checkMemberChange(opts: {
  /** Paths where the actor holds the key for this change (`member:role` or `member:remove`). */
  actorScopes: readonly string[];
  /** Everything the actor holds at the membership's node. */
  actorHeld: ReadonlySet<string>;
  isSelf: boolean;
  current: RoleShape;
  node: { path: string; kind: ScopeKind; name: string };
  change: MemberChange;
}): MemberGate {
  const { actorScopes, actorHeld, isSelf, current, node, change } = opts;
  const removing = change.kind === "REMOVE";

  if (isSelf) {
    return {
      ok: false,
      code: "SELF",
      message: removing ? "You cannot remove yourself." : "You cannot change your own role.",
    };
  }

  if (current.key === FOUNDING_ROLE || (!removing && change.next.key === FOUNDING_ROLE)) {
    return {
      ok: false,
      code: "ADMIN_ROLE",
      message: "The admin role is changed with Make admin, Remove as admin and Hand over admin.",
    };
  }

  if (!actorScopes.some((p) => scopeCovers(p, node.path))) {
    return {
      ok: false,
      code: "OUTSIDE_YOUR_SCOPE",
      message: "You can only change people within your own part of the organisation.",
    };
  }

  const above = missingToGrant(actorHeld, current.permissions);
  if (above.length) {
    const where = node.kind === "ORG" ? "" : ` on ${node.name}`;
    return {
      ok: false,
      code: "NOT_YOURS_TO_CHANGE",
      message: `${current.label}${where} includes access you do not have: ${permissionWords(above)}.`,
    };
  }

  if (removing) return { ok: true };

  const next = change.next;
  if (next.key === current.key) {
    return { ok: false, code: "SAME_ROLE", message: `They are already ${current.label}.` };
  }
  if (!roleFitsScope(next, node.kind)) {
    return { ok: false, code: "ROLE_TOO_DEEP", message: depthRefusal(next, node) };
  }
  const refused = subsetRefusal(actorHeld, next, node);
  return refused ? { ok: false, code: refused.code as MemberRefusal, message: refused.message } : { ok: true };
}
