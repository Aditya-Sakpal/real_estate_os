import { getViewer } from "@/lib/console";
import { requestStop } from "@/lib/ask";

/**
 * Stop the question running in one chat.
 *
 * A question keeps running when its screen goes away, so Stop is a request of
 * its own rather than the browser dropping the answer's stream. It marks the
 * chat; the running question sees the mark within a second or two, ends, and
 * records "Stopped." in the chat. Only the chat's owner can mark it:
 * `requestStop()` reads it back through `withPerson()`.
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return new Response("Forbidden", { status: 403 });
  }
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  const body = (await request.json().catch(() => null)) as { threadId?: unknown } | null;
  const threadId = typeof body?.threadId === "string" ? body.threadId : "";
  await requestStop(viewer.state.org.id, viewer.userId, threadId);
  return new Response(null, { status: 204 });
}
