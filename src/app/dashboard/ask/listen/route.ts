import { getViewer } from "@/lib/console";
import { readAnswerAloud } from "@/lib/ask";

/**
 * One of Jimmy's answers, read aloud. The body is `{ messageId }`; the answer
 * is the sound itself, or `{ error }` in the person's words.
 *
 * The sound is made for this request and handed back; it is never stored or
 * cached. Every member may have their own answers read, as every member may
 * ask. The origin is compared because a route, unlike a server action, gets
 * no check of its own.
 */
export const dynamic = "force-dynamic";

const refuse = (error: string, status = 200) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return new Response("Forbidden", { status: 403 });
  }

  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });

  const body = (await request.json().catch(() => null)) as { messageId?: unknown } | null;
  const messageId = typeof body?.messageId === "string" ? body.messageId : "";

  const result = await readAnswerAloud({ orgId: viewer.state.org.id, billOrgId: viewer.via?.firmOrgId, userId: viewer.userId, messageId }).catch((e) => {
    console.error("ask listen:", (e as Error).message);
    return { ok: false as const, message: "That answer could not be read aloud. Try again." };
  });
  if (!result.ok) return refuse(result.message);
  return new Response(new Uint8Array(result.bytes), {
    headers: { "content-type": result.type, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
