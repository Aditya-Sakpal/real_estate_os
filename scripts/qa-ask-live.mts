// Ask Jimmy, asked live: questions through the real /dashboard/ask routes as a
// signed-in person, with the real models. A QA harness, not a check suite.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/qa-ask-live.mts \
//     --as <email> [--thread <id>|new] "question" ["next question" ...]
//   ... --as <email> --action '{"op":"answer","id":"...","answers":[...]}'
//
// Each question in one invocation goes to the same chat. Every exchange is
// appended to $QA_LOG (JSON lines) for the report.
import { encode } from "next-auth/jwt";
import postgres from "postgres";
import { appendFileSync } from "node:fs";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";
const ORG = process.env.QA_ORG ?? "530f6ab3-274d-4d55-bc9a-98231b4bed01";
const LOG = process.env.QA_LOG ?? "";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const email = opt("--as") ?? "admin@billbay.co";
let thread = opt("--thread");
if (thread === "new") thread = null;
const actionBody = opt("--action");
const raw = opt("--raw");

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
await sql.end();
if (!u) throw new Error(`no user ${email}`);
const token = await encode({ token: { sub: u.id, userId: u.id, email }, secret: process.env.AUTH_SECRET!, salt: COOKIE, maxAge: 3600 });
const headers = {
  "content-type": "application/json",
  cookie: `${COOKIE}=${token}; salesdesk.org=${ORG}`,
  origin: BASE,
};

const log = (x: unknown) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), as: email, ...(x as object) })}\n`);
};

if (actionBody) {
  const res = await fetch(`${BASE}/dashboard/ask/action`, { method: "POST", headers, body: actionBody });
  const text = await res.text();
  log({ action: JSON.parse(actionBody), status: res.status, reply: text.slice(0, 4000) });
  console.log(res.status, text);
  process.exit(0);
}

for (const question of args) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/dashboard/ask/send`, { method: "POST", headers, body: JSON.stringify({ question, threadId: thread }) });
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { type: "raw", text: l };
    }
  });
  const steps = lines.filter((l) => l.type === "step").map((l) => l.text);
  const done = lines.find((l) => l.type === "done");
  const err = lines.find((l) => l.type === "error");
  const th = lines.find((l) => l.type === "thread")?.thread;
  if (th?.id) thread = th.id;
  if (done?.thread?.id) thread = done.thread.id;
  const a = done?.answer;
  const out = {
    q: question,
    ms: Date.now() - t0,
    status: res.status,
    thread,
    steps,
    error: err?.message ?? null,
    outcome: a?.outcome,
    body: a?.body,
    tables: a?.blocks?.tables?.map((t: { title?: string; columns?: unknown; rows?: unknown[]; total?: unknown }) => ({
      title: t.title, columns: t.columns, rows: t.rows?.slice(0, 12), n: t.rows?.length, total: t.total,
    })),
    links: a?.blocks?.links,
    followUps: a?.blocks?.followUps,
    notes: a?.blocks?.notes,
    clarify: a?.blocks?.clarify,
    action: a?.action ?? a?.actionView ?? a?.blocks?.action ?? null,
    left: done?.left,
  };
  log(out);
  console.log(raw ? JSON.stringify(lines, null, 1) : JSON.stringify(out, null, 1));
}
