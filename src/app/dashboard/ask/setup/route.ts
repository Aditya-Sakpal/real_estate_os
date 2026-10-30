import { after } from "next/server";
import { getViewer } from "@/lib/console";
import { answerSetup, cancelSetup, confirmSetup, editSetup, setupStatus, type SetupCtx } from "@/lib/setup";
import type { Answer } from "@/lib/ask-actions-rules";

/**
 * A project setup card's buttons: read how it is doing, answer its
 * questions, open every answer again, confirm, or cancel.
 *
 * Every call reads the setup back through `withPerson()`, so only its owner
 * can press it, and a confirm reads the person's keys as they stand now.
 * Making the project takes a while, so a confirm answers at once and the
 * making runs after it; the card reads `status` until it lands.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Forbidden", { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  const body = ((await request.json().catch(() => null)) ?? {}) as { op?: string; id?: string; answers?: Answer[]; skip?: unknown[] };
  const c: SetupCtx = { orgId: viewer.state.org.id, userId: viewer.userId, authz: viewer.authz, orgType: viewer.orgType, via: viewer.via ?? null };
  const id = typeof body.id === "string" ? body.id : "";
  const json = (x: unknown) => Response.json(x);
  const out = (r: Awaited<ReturnType<typeof setupStatus>>) => (r.ok ? json({ ok: true, view: r.view }) : json({ ok: false, message: r.message }));
  switch (body.op) {
    case "status":
      return out(await setupStatus(c, id));
    case "answer": {
      const answers = Array.isArray(body.answers)
        ? body.answers.slice(0, 8).map((a) => ({
            input: String(a?.input ?? ""),
            values: Array.isArray(a?.values) ? a.values.map(String).slice(0, 20) : [],
            other: typeof a?.other === "string" ? a.other.slice(0, 1000) : null,
          }))
        : [];
      return out(await answerSetup(c, id, answers));
    }
    case "edit":
      return out(await editSetup(c, id));
    case "cancel":
      return out(await cancelSetup(c, id));
    case "confirm": {
      const skip = Array.isArray(body.skip) ? body.skip.map(Number).filter(Number.isInteger).slice(0, 200) : [];
      const r = await confirmSetup(c, id, skip);
      if (r.ok && r.later) after(r.later);
      return out(r);
    }
    default:
      return Response.json({ ok: false, message: "Unknown request." }, { status: 400 });
  }
}
