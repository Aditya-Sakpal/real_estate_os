import { getViewer } from "@/lib/console";
import { noteLink } from "@/lib/visit-notes";

/**
 * Play a voice note: a five-minute link to the recording, for somebody who
 * may read visits at its tower. The store's address is never on a page.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ noteId: string }> }) {
  const { noteId } = await params;
  const viewer = await getViewer();
  if (!viewer || !/^[0-9a-f-]{36}$/i.test(noteId)) return new Response("Not found", { status: 404 });
  const url = await noteLink(viewer.state.org.id, viewer.authz, noteId);
  if (!url) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
}
