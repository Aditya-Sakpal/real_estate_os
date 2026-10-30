import { getViewer } from "@/lib/console";
import { SectionFrame, type SectionGroup } from "@/components/shell/SectionFrame";
import { projectItems } from "@/lib/section-nav";
import { reviewQueue } from "@/lib/post";
import { awaitingReview } from "@/lib/post-rules";

/**
 * Campaigns' screens side by side with the list of them: the overview, what
 * waits for a person, what went out, the occasions, and each project's
 * campaigns. A campaign's own brief, studio and schedule take the whole width.
 */
export default async function CampaignsLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer || !viewer.authz.can("campaign:read")) return children;

  const reach = viewer.authz.scopesFor("campaign:read");
  const waiting = awaitingReview(
    await reviewQueue(viewer.state.org.id, { limit: 200, scopes: reach }).catch(() => []),
  );
  const projects = projectItems(viewer, "campaign:read", "/dashboard/campaigns");

  const groups: SectionGroup[] = [
    {
      key: "home",
      items: [
        { key: "overview", label: "Overview", href: "/dashboard/campaigns", icon: "Campaign" },
        { key: "queue", label: "Waiting on you", href: "/dashboard/campaigns/queue", icon: "Inbox", count: waiting },
        { key: "live", label: "Published", href: "/dashboard/campaigns/live", icon: "Play" },
        { key: "occasions", label: "Occasions", href: "/dashboard/campaigns/occasions", icon: "Visit" },
      ],
    },
    ...(projects.length ? [{ key: "projects", label: "Projects", items: projects }] : []),
  ];

  return (
    <SectionFrame
      label="Campaigns"
      groups={groups}
      skip={["/dashboard/campaigns/brief", "/dashboard/campaigns/templates", "/dashboard/campaigns/fonts"]}
    >
      {children}
    </SectionFrame>
  );
}
