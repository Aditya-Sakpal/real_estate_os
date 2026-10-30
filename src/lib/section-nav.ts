import { inReach } from "@/lib/grant-rules";
import type { SectionItem } from "@/components/shell/SectionFrame";
import type { getViewer } from "@/lib/console";

type Viewer = NonNullable<Awaited<ReturnType<typeof getViewer>>>;

/**
 * Each project this person reaches under `perm`, as a side-list item opening
 * `${base}/<project>`, with its towers as items of their own beneath it, so a
 * tower's page lights the tower and never reads as its project's.
 */
export function projectItems(viewer: Viewer, perm: string, base: string): SectionItem[] {
  const scopes = viewer.authz.scopesFor(perm) ?? [];
  return viewer.state.projects
    .filter((p) => inReach(p.path, scopes))
    .map((p) => ({
      key: `p-${p.id}`,
      label: p.name,
      href: `${base}/${p.id}`,
      icon: "Project" as const,
      children: viewer.state.places
        .filter((pl) => pl.kind === "PHASE" && pl.href.includes(`/projects/${p.id}`))
        .map((pl) => ({ key: `t-${pl.id}`, label: pl.name, href: `${base}/${pl.id}` })),
    }));
}
