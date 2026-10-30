import { after } from "next/server";
import { getViewer } from "@/lib/console";
import { withPerson } from "@/lib/db";
import { answerAction, actionStatus, cancelAction, confirmAction, startAction, type ActionCtx } from "@/lib/ask-actions";
import type { Answer } from "@/lib/ask-actions-rules";
import { remember } from "@/lib/ask-memory";

/**
 * An action card's buttons: answer its questions, confirm, cancel, read how
 * a running one is doing, or start the next step a finished one offers.
 *
 * Every call reads the card back through `withPerson()`, so only its owner
 * can press it, and every confirm re-reads the target and the keys held at
 * it as they stand now: what the card said ten minutes ago is not a
 * permission. A long action (a post, a reel, a copy run) answers at once and
 * carries on under `after()`; the card polls `status` until it lands.
 */
export const dynamic = "force-dynamic";

type Body = {
  op?: string;
  id?: string;
  answers?: Answer[];
  threadId?: string;
  kind?: string;
  label?: string;
  inputs?: Record<string, string>;
};

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Forbidden", { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  const body = ((await request.json().catch(() => null)) ?? {}) as Body;
  const ctx: ActionCtx = { orgId: viewer.state.org.id, userId: viewer.userId, authz: viewer.authz, now: new Date(), via: viewer.via ?? null };
  const id = typeof body.id === "string" ? body.id : "";
  const json = (x: unknown, status = 200) => Response.json(x, { status });

  switch (body.op) {
    case "answer": {
      const answers = Array.isArray(body.answers)
        ? body.answers.slice(0, 5).map((a) => ({
            input: String(a?.input ?? ""),
            values: Array.isArray(a?.values) ? a.values.map(String).slice(0, 12) : [],
            other: typeof a?.other === "string" ? a.other.slice(0, 1000) : null,
          }))
        : [];
      const r = await answerAction(ctx, id, answers);
      return r.ok ? json({ ok: true, view: r.view }) : json({ ok: false, message: r.message });
    }
    case "confirm": {
      const r = await confirmAction(ctx, id);
      if (!r.ok) return json({ ok: false, message: r.message });
      if (r.later) after(r.later);
      return json({ ok: true, view: r.view });
    }
    case "cancel": {
      const r = await cancelAction(ctx, id);
      return r.ok ? json({ ok: true, view: r.view }) : json({ ok: false, message: r.message });
    }
    case "status": {
      const r = await actionStatus(ctx, id);
      return r.ok ? json({ ok: true, view: r.view }) : json({ ok: false, message: r.message });
    }
    case "next": {
      // The next step a finished card offered: a new card in the same chat,
      // with the person's press written into the chat as their words.
      const threadId = typeof body.threadId === "string" ? body.threadId : "";
      const kind = typeof body.kind === "string" ? body.kind : "";
      const label = (typeof body.label === "string" ? body.label : kind).slice(0, 120) || "Next";
      const inputs = body.inputs && typeof body.inputs === "object" ? body.inputs : {};
      // The chat first: a card is never started in a chat that is not this person's.
      const mine = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
        ? await withPerson(ctx.orgId, ctx.userId, (sql) => sql`SELECT id FROM ask_threads WHERE id = ${threadId}`)
        : [];
      if (!mine.length) return json({ ok: false, message: "That chat is gone." });
      const started = await startAction(ctx, threadId, kind, Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)])));
      const bodyText = !started.ok
        ? started.message
        : started.view.state === "ASKING"
          ? started.view.questions[0]?.title ?? "I need a little more first."
          : started.view.state === "PROPOSED"
            ? "Here it is. Check it, then confirm."
            : started.view.result?.message ?? "I could not get that ready.";
      const messages = await withPerson(ctx.orgId, ctx.userId, async (sql) => {
        const [t] = await sql`SELECT id FROM ask_threads WHERE id = ${threadId}`;
        if (!t) return null;
        const [q] = await sql<{ id: string; created_at: Date }[]>`
          INSERT INTO ask_messages (org_id, thread_id, user_id, role, body)
          VALUES (${ctx.orgId}, ${threadId}, ${ctx.userId}, 'PERSON', ${label})
          RETURNING id, created_at`;
        const blocks = { tables: [], links: [], followUps: [], notes: [], action: started.ok ? { id: started.view.id } : null, clarify: null };
        const [a] = await sql<{ id: string; created_at: Date }[]>`
          INSERT INTO ask_messages (org_id, thread_id, user_id, role, body, blocks, outcome)
          VALUES (${ctx.orgId}, ${threadId}, ${ctx.userId}, 'JIMMY', ${bodyText}, ${sql.json(blocks as never)},
                  ${started.ok ? "ANSWERED" : "REFUSED"})
          RETURNING id, created_at`;
        await sql`UPDATE ask_threads SET updated_at = now() WHERE id = ${threadId}`;
        return [
          { id: q.id, role: "PERSON", body: label, blocks: { tables: [], links: [], followUps: [], notes: [], action: null, clarify: null }, outcome: null, createdAt: new Date(q.created_at).toISOString() },
          {
            id: a.id,
            role: "JIMMY",
            body: bodyText,
            blocks,
            outcome: started.ok ? "ANSWERED" : "REFUSED",
            createdAt: new Date(a.created_at).toISOString(),
            action: started.ok ? started.view : null,
          },
        ];
      });
      if (!messages) return json({ ok: false, message: "That chat is gone." });
      await remember({ orgId: ctx.orgId, userId: ctx.userId, threadId }, [
        { role: "PERSON", body: label, actionId: null },
        { role: "JIMMY", body: bodyText, actionId: started.ok ? started.view.id : null },
      ]);
      return json({ ok: true, messages });
    }
    default:
      return json({ ok: false, message: "Unknown request." }, 400);
  }
}
