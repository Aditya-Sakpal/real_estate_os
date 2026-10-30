"use client";

import { useRouter } from "next/navigation";

/**
 * Which version of the Brain is on screen.
 *
 * A select rather than a row of links, because the history grows without
 * limit and a project three years old should not push its own facts off the
 * page. Changing it navigates, so the choice survives a refresh and can be
 * linked to.
 */

export type VersionOption = {
  version: number;
  state: "DRAFT" | "PUBLISHED" | "SUPERSEDED";
  publishedAt: string | null;
};

function label(v: VersionOption): string {
  if (v.state === "PUBLISHED") return `Version ${v.version} (live)`;
  if (v.state === "DRAFT") return `Version ${v.version} (draft)`;
  return `Version ${v.version}`;
}

export function VersionPicker({
  nodeId,
  versions,
  current,
}: {
  nodeId: string;
  versions: VersionOption[];
  current: number;
}) {
  const router = useRouter();

  return (
    <label className="verpick">
      <span className="verpick__label">Showing</span>
      <select
        className="mini-select"
        aria-label="Which version to show"
        value={current}
        onChange={(e) => router.push(`/dashboard/brain/${nodeId}?v=${e.target.value}`)}
      >
        {versions.map((v) => (
          <option key={v.version} value={v.version}>
            {label(v)}
          </option>
        ))}
      </select>
    </label>
  );
}
