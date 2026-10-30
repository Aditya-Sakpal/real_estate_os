import { getViewer } from "@/lib/console";
import { beginFile, finishFile, maySetUp, removeFile } from "@/lib/setup";

/**
 * A file attached to a question in Ask Jimmy: begin (checked, then a link
 * to PUT it to), finish (its bytes checked once they land), or remove (taken
 * off before it was sent). The bytes go straight to the store, because a
 * brochure is far larger than a request should carry.
 *
 * Only somebody who could set a project up, or add to one, may attach. The
 * origin is compared because a route, unlike a server action, gets no check
 * of its own.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Forbidden", { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  const json = (x: unknown, status = 200) => Response.json(x, { status });
  if (viewer.via || !maySetUp(viewer.authz)) return json({ ok: false, message: "You can't attach files here." });
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const o = { orgId: viewer.state.org.id, userId: viewer.userId };
  switch (body.op) {
    case "begin": {
      const base = origin ?? `${new URL(request.url).protocol}//${host}`;
      return json(await beginFile({ ...o, name: body.name, type: body.type, size: body.size, sha256: body.sha256, origin: base }));
    }
    case "finish":
      return json(await finishFile({ ...o, id: String(body.id ?? "") }));
    case "remove":
      return json({ ok: await removeFile({ ...o, id: String(body.id ?? "") }) });
    default:
      return json({ ok: false, message: "Unknown request." }, 400);
  }
}
