import { getViewer } from "@/lib/console";
import { loadBrief } from "@/lib/campaign";
import { stopCopyRun } from "@/lib/creative";
import { audit } from "@/lib/db";

/**
 * Stop the copy being written for one brief.
 *
 * A route rather than a server action, and that is the whole reason this file
 * exists. Next queues a page's server actions one behind another, so a stop
 * sent as an action would wait for the very run it was meant to stop and
 * arrive after it had finished. An ordinary request is not queued.
 *
 * Same key as writing (`campaign:create`), checked at the brief's own node.
 * The origin is compared because a route, unlike a server action, gets no
 * check of its own; the session cookie is Lax, which already keeps a
 * cross-site POST from carrying it, and this is the second lock.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ briefId: string }> },
) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return new Response("Forbidden", { status: 403 });
  }

  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });

  const { briefId } = await params;
  const view = await loadBrief(viewer.state.org.id, briefId);
  if (!view || !viewer.authz.canAt("campaign:create", view.node.path)) {
    return new Response("Not found", { status: 404 });
  }

  const result = await stopCopyRun({
    orgId: viewer.state.org.id,
    actorUserId: viewer.userId,
    briefId,
  });
  if (result.ok) {
    await audit({
      orgId: viewer.state.org.id,
      actorUserId: viewer.userId,
      action: "creative.copy_stopped",
      targetType: "campaign_brief",
      targetId: briefId,
      metadata: {},
    });
  }
  // Nothing running is not an error from the person's side: the run finished
  // a moment before they pressed. The page learns the outcome from the run.
  return new Response(null, { status: 204 });
}
