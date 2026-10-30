import { withTenant } from "@/lib/db";

/**
 * Where a campaign's file sits, for the routes that hand one over: the brief
 * it was made for, or the node a publication went out for. Asked so a
 * person holding `campaign:read` on one project cannot fetch another
 * project's post by its id, the same rule every screen already keeps.
 */
export type CampaignThing = "brief" | "post" | "backdrop" | "target" | "creative";

const isId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export async function campaignPath(orgId: string, kind: CampaignThing, id: string): Promise<string | null> {
  if (!isId(id)) return null;
  const rows = await withTenant(orgId, (sql) => {
    switch (kind) {
      case "brief":
        return sql<{ path: string }[]>`
          SELECT n.path::text AS path FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
          WHERE b.org_id = ${orgId} AND b.id = ${id}`;
      case "post":
        return sql<{ path: string }[]>`
          SELECT n.path::text AS path FROM rendered_posts p JOIN campaign_briefs b ON b.id = p.brief_id
          JOIN scope_nodes n ON n.id = b.scope_node_id WHERE p.org_id = ${orgId} AND p.id = ${id}`;
      case "backdrop":
        return sql<{ path: string }[]>`
          SELECT n.path::text AS path FROM generated_media g JOIN campaign_briefs b ON b.id = g.brief_id
          JOIN scope_nodes n ON n.id = b.scope_node_id WHERE g.org_id = ${orgId} AND g.id = ${id}`;
      case "target":
        return sql<{ path: string }[]>`
          SELECT n.path::text AS path FROM publish_targets t JOIN scope_nodes n ON n.id = t.scope_node_id
          WHERE t.org_id = ${orgId} AND t.id = ${id}`;
      case "creative":
        return sql<{ path: string }[]>`
          SELECT n.path::text AS path FROM post_creatives c JOIN post_runs r ON r.id = c.run_id
          JOIN post_schedules s ON s.id = r.schedule_id JOIN campaign_briefs b ON b.id = s.brief_id
          JOIN scope_nodes n ON n.id = b.scope_node_id WHERE c.org_id = ${orgId} AND c.id = ${id}`;
    }
  });
  return rows[0]?.path ?? null;
}
