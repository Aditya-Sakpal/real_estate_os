import { after } from "next/server";
import { getViewer } from "@/lib/console";
import { askJimmy } from "@/lib/ask";
import { MAX_QUESTION_CHARS } from "@/lib/ask-rules";
import { SETUP_MAX_FILES } from "@/lib/setup-file-rules";

/**
 * Ask Jimmy one question, and stream what happens.
 *
 * A route rather than a server action, because the answer takes several
 * seconds and the screen shows each step as it happens ("Checking AI calls"),
 * which an action cannot stream.
 *
 * The question does not depend on anybody reading the stream. Switching to
 * another chat, starting a new one or closing the tab leaves it running, and
 * its answer is recorded in its chat; `after()` keeps the function alive until
 * it is. Only Stop (`/dashboard/ask/stop`) ends it early.
 *
 * The body is one JSON object per line: `thread` once a chat exists, `step`
 * while Jimmy works, then `done` with both messages, or `error`.
 *
 * Every member may ask. What each is told is decided per question by the keys
 * they hold, inside `askJimmy()`. The origin is compared because a route,
 * unlike a server action, gets no check of its own.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return new Response("Forbidden", { status: 403 });
  }

  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });

  const body = (await request.json().catch(() => null)) as { question?: unknown; threadId?: unknown; files?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.slice(0, MAX_QUESTION_CHARS * 2) : "";
  const threadId = typeof body?.threadId === "string" && body.threadId ? body.threadId : null;
  const files = Array.isArray(body?.files) ? body.files.filter((f): f is string => typeof f === "string").slice(0, SETUP_MAX_FILES) : [];

  const encoder = new TextEncoder();
  let push: (line: Record<string, unknown>) => void = () => undefined;
  let finish: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      push = (line) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          open = false;
        }
      };
      finish = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by the browser going away.
        }
      };
    },
    cancel() {
      // The reader went away. The question carries on; only its stream stops.
      push = () => undefined;
    },
  });
  const send = (line: Record<string, unknown>) => push(line);

  const work = (async () => {
    try {
      const result = await askJimmy({
        orgId: viewer.state.org.id,
        orgName: viewer.state.org.displayName,
        orgType: viewer.orgType,
        userId: viewer.userId,
        personName: viewer.name,
        authz: viewer.authz,
        via: viewer.via,
        question,
        threadId,
        files,
        onStep: (text) => send({ type: "step", text }),
        onThread: (thread) => send({ type: "thread", thread }),
      });
      if (result.ok) {
        send({ type: "done", question: result.question, answer: result.answer, thread: result.thread, left: result.left });
        // The chat's summary is updated once the answer is on screen, so it never adds to the wait.
        await result.settle?.();
      } else {
        send({ type: "error", message: result.message });
      }
    } catch (e) {
      console.error("ask: the request failed", e);
      send({ type: "error", message: "Something went wrong. Try again." });
    } finally {
      finish();
    }
  })();
  after(work);

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
