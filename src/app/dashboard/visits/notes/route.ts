import { after } from "next/server";
import { getViewer } from "@/lib/console";
import { canProcessHere, processNote, saveNote } from "@/lib/visit-notes";
import { NOTE_MAX_BYTES } from "@/lib/visit-note-rules";

/**
 * A host's voice note arriving from the visits screen, now or from the
 * phone's queue once it has a signal. Stored as recorded; transcribed and
 * read after the answer, here when this machine has FFmpeg and otherwise by
 * the lead worker.
 *
 * A route rather than a server action, because a recording is a file and a
 * queued one is sent by the phone when the signal returns. The origin is
 * compared because a route, unlike a server action, gets no check of its own.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Forbidden", { status: 403 });
  const size = Number(request.headers.get("content-length") ?? "0");
  if (size > NOTE_MAX_BYTES + 64 * 1024) return Response.json({ ok: false, message: "The recording is too large." }, { status: 413 });

  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  if (!viewer.authz.can("visit:outcome")) return new Response("Forbidden", { status: 403 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("note");
  const visitId = String(form?.get("visitId") ?? "");
  if (!(file instanceof Blob) || !/^[0-9a-f-]{36}$/i.test(visitId)) {
    return Response.json({ ok: false, message: "No recording arrived." }, { status: 400 });
  }
  const r = await saveNote({
    orgId: viewer.state.org.id,
    userId: viewer.userId,
    authz: viewer.authz,
    visitId,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    durationMs: Number(form?.get("durationMs") ?? NaN),
  });
  if (r.ok && canProcessHere()) {
    const orgId = viewer.state.org.id;
    after(() => processNote(orgId, r.noteId).catch((e) => console.error("visit note:", e)));
  }
  return Response.json(r, { status: r.ok ? 200 : 422 });
}
