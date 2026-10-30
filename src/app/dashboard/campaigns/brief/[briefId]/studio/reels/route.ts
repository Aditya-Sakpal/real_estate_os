import { getViewer } from "@/lib/console";
import { campaignPath } from "@/lib/campaign-reach";
import { listReels } from "@/lib/reel";

/**
 * The brief's story reels and how far along each is, for the studio to poll
 * while one is being made. Read inside the viewer's tenant, behind
 * `campaign:read`, like the page it serves.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ briefId: string }> }) {
  const viewer = await getViewer();
  if (!viewer || !viewer.authz.can("campaign:read")) return new Response("Not found", { status: 404 });
  const { briefId } = await params;
  // Held where the campaign sits, not merely somewhere.
  const reach = await campaignPath(viewer.state.org.id, "brief", briefId);
  if (!reach || !viewer.authz.canAt("campaign:read", reach)) return new Response("Not found", { status: 404 });
  const reels = await listReels(viewer.state.org.id, briefId);
  return Response.json({ reels }, { headers: { "cache-control": "no-store" } });
}
