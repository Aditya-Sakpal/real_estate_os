import { getViewer } from "@/lib/console";
import { SectionFrame, type SectionGroup, type SectionItem } from "@/components/shell/SectionFrame";
import { projectItems } from "@/lib/section-nav";

/**
 * The library's screens beside the list of them: the overview, the brand
 * kit, competitors' ads, and each project's pictures and flats.
 */
export default async function LibraryLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer) return children;
  const can = (p: string) => viewer.authz.can(p);

  const home: SectionItem[] = [{ key: "overview", label: "Overview", href: "/dashboard/library", icon: "Library" }];
  if (can("brand:read")) home.push({ key: "branding", label: "Branding", href: "/dashboard/library/branding", icon: "Mark" });
  if (can("campaign:read")) home.push({ key: "market", label: "Competitor ads", href: "/dashboard/library/market", icon: "Campaign" });

  const projects = can("asset:read")
    ? projectItems(viewer, "asset:read", "/dashboard/library")
    : can("unit:read")
      ? projectItems(viewer, "unit:read", "/dashboard/library")
      : [];

  const groups: SectionGroup[] = [
    { key: "home", items: home },
    ...(projects.length ? [{ key: "projects", label: "Projects", items: projects }] : []),
  ];
  return (
    <SectionFrame label="Library" groups={groups}>
      {children}
    </SectionFrame>
  );
}
