"use client";

import { useMemo, useState } from "react";
import { depthOf, nodesForRole, type ScopeNode } from "@/lib/scope-rules";
import type { ScopeKind } from "@/lib/roles";

/**
 * Picking a role and the place it is held.
 *
 * A membership is always held AT a node, so these two controls are one
 * decision. The role list is complete and stays put; the place list narrows
 * to the nodes deep enough to carry whatever is chosen, because Site Team on
 * a region is not a thing anybody can be.
 *
 * This is presentation and nothing more. The server reads the node back
 * inside the tenant and runs the same depth, containment and rank rules on
 * it, so a crafted post that names a node this list never offered is refused
 * there rather than here.
 */

/** `at`, when present, is the nodes this person may give the role at. */
export type PickRole = { key: string; label: string; minKind: ScopeKind; at?: string[] };

/**
 * The only whitespace an option element will not collapse. Built from its code
 * point rather than typed, because a literal one is invisible in source and the
 * next person to touch this line would delete it without seeing it.
 */
export const NBSP = String.fromCharCode(160);

/** Indented by depth, so the tree reads as a tree inside a flat select. */
function indent(node: ScopeNode, base: number): string {
  return NBSP.repeat((depthOf(node.path) - base) * 3) + node.name;
}

export function ScopedRole({
  roles,
  nodes,
  defaultRoleKey,
  size = "field",
}: {
  roles: PickRole[];
  nodes: ScopeNode[];
  defaultRoleKey: string;
  /** `field` in the invite form, `mini` on a join-request row. */
  size?: "field" | "mini";
}) {
  const [roleKey, setRoleKey] = useState(
    () => roles.find((r) => r.key === defaultRoleKey)?.key ?? roles[0]?.key ?? "",
  );

  const role = roles.find((r) => r.key === roleKey) ?? roles[0];
  const places = useMemo(
    () => (role ? nodesForRole(nodes, role) : nodes),
    [nodes, role],
  );

  // Where the previous choice no longer fits, fall to the shallowest place
  // that does rather than holding a selection the server would refuse.
  const [wanted, setWanted] = useState("");
  const nodeId = places.some((n) => n.id === wanted) ? wanted : (places[0]?.id ?? "");

  // Measured against the list actually shown, not the whole tree. A role that
  // narrows the places to one level has nothing to indent, and an indent with
  // nothing to sit under just reads as a control that is out of line.
  const shallowest = places.length ? Math.min(...places.map((n) => depthOf(n.path))) : 0;
  const cls = size === "mini" ? "mini-select" : "select-field";

  return (
    <>
      <select
        name="role"
        className={cls}
        aria-label="Role"
        value={roleKey}
        onChange={(e) => setRoleKey(e.target.value)}
      >
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>

      {/* Shown whenever the tenant has a tree, even where one role narrows it
          to a single place: "Site Team" without "on Tower C" is half an
          answer, and a control that disappears as you use it reads as a bug.
          A tenant that is still only its root gets no control at all. */}
      {nodes.length > 1 ? (
        <select
          name="scopeNodeId"
          className={cls}
          aria-label="Where they hold it"
          value={nodeId}
          onChange={(e) => setWanted(e.target.value)}
        >
          {places.map((n) => (
            <option key={n.id} value={n.id}>
              {indent(n, shallowest)}
            </option>
          ))}
        </select>
      ) : (
        <input type="hidden" name="scopeNodeId" value={nodeId} />
      )}
    </>
  );
}
