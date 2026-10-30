/**
 * The call backs a buyer asked for, placed on time by the dev server itself.
 *
 * On the worker the call watcher places them every 15 seconds. A development
 * machine runs no worker, so a buyer who said "call me in five minutes" was
 * never rung. Here the dev server does the same two things every 15 seconds:
 * reads any call whose result never arrived (a tunnel that dropped), and
 * places the call backs that are due, and the next people on any call list a
 * person started. Nothing else: a full lead pass would also ring the demo
 * leads, whose numbers could be strangers'.
 *
 * Never on Vercel or in production, where the worker does it, and off unless
 * `CALL_TICKER=on`: a development machine shares the production database,
 * and on 28 October 2026 a dev server started that morning kept placing
 * Harbour View's call-list calls beside the worker with the code it loaded at
 * start, so half a batch went out without the rules shipped that afternoon.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VERCEL || process.env.NODE_ENV === "production" || process.env.CALL_TICKER !== "on") return;
  const g = globalThis as { __callTicker?: ReturnType<typeof setInterval> };
  if (g.__callTicker) return;
  let busy = false;
  g.__callTicker = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { controlDb } = await import("./lib/db/index.ts");
      const { runDueCallbacks, settleCalls } = await import("./lib/lead-engine.ts");
      // Listing tenants is the worker's control-plane act; each is read inside its own.
      const orgs = await controlDb<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED'`;
      for (const o of orgs) await settleCalls(o.id, new Date(), { runNow: false }).catch(() => 0);
      const ran = await runDueCallbacks();
      if (ran) console.log(`call ticker: placed ${ran} call back${ran === 1 ? "" : "s"}`);
      // A call list a person started rings here too, a few at a time.
      const { runCallLists } = await import("./lib/call-lists.ts");
      const lists = await runCallLists();
      if (lists.placed) console.log(`call ticker: rang ${lists.placed} from call lists`);
    } catch (e) {
      console.warn("call ticker:", e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }, 15_000);
}
