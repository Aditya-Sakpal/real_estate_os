import { getViewer } from "@/lib/console";
import { hearQuestion } from "@/lib/ask";
import { saidSeconds, VOICE_MAX_BYTES, voiceSeconds } from "@/lib/ask-voice-rules";

/**
 * A spoken question, written down. The body is the recorder's audio as it
 * came, its type in `content-type` and its length in `x-voice-seconds`; the
 * answer is `{ text }` for the box, or `{ error }` in the person's words.
 *
 * Nothing is asked here: the person reads the words and sends them. The audio
 * is held in this request only and never stored or logged. Every member may
 * speak a question, as every member may type one. The origin is compared
 * because a route, unlike a server action, gets no check of its own.
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

  // Refused on its declared size before the body is read.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > VOICE_MAX_BYTES) return refuse("Keep it under 30 seconds.");
  const bytes = Buffer.from(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));

  const result = await hearQuestion({
    orgId: viewer.state.org.id,
    billOrgId: viewer.via?.firmOrgId,
    userId: viewer.userId,
    bytes,
    contentType: request.headers.get("content-type"),
    seconds: voiceSeconds(request.headers.get("x-voice-seconds")),
    said: saidSeconds(request.headers.get("x-voice-seconds")),
  }).catch((e) => {
    console.error("ask voice:", (e as Error).message);
    return { ok: false as const, message: "Your question could not be written down. Try again, or type it." };
  });
  return result.ok ? Response.json({ text: result.text }) : refuse(result.message);
}
