"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export type NodeGroup = { label: string; nodes: { id: string; name: string }[] };

/**
 * Which node's kit is on screen: the organisation, a company, a project or a
 * tower. One select, grouped by kind, in place of a wall of a pill per node.
 */
export function NodePicker({ groups, current }: { groups: NodeGroup[]; current: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className="bk-node" data-pending={pending || undefined}>
      <span className="bk-node__label">Kit for</span>
      <select
        value={current}
        onChange={(e) => {
          const id = e.target.value;
          start(() => router.push(`/dashboard/library/branding?node=${id}`));
        }}
      >
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
