// The long-call watcher, runnable.
//
//   node --experimental-strip-types --env-file=.env.local scripts/call-watch.mts [--seconds=170]
//
// Looks at every call still with the AI every WATCH_SECONDS for a bounded
// while, then exits, and the worker's timer starts it again at once. A call
// that has run past five minutes goes to whoever on the sales team is free
// (`handOffLongCalls()`). Bounded rather than for ever, so a new release is
// picked up within minutes and a stuck pass cannot hold the job. Two at once
// are safe: `requestHandoff()` ignores a call already being handed over.
// Each look also places the call backs that have come due
// (`runDueCallbacks()`), so "call me in five minutes" rings at five, and
// rings the next people on each running call list (`runCallLists()`).
import { handOffLongCalls } from "../src/lib/handoff.ts";
import { runDueCallbacks } from "../src/lib/lead-engine.ts";
import { runCallLists } from "../src/lib/call-lists.ts";
import { WATCH_SECONDS } from "../src/lib/handoff-rules.ts";
import { closeDb } from "../src/lib/db/index.ts";

const seconds = Number(process.argv.find((a) => a.startsWith("--seconds="))?.slice(10) ?? "170");
const until = Date.now() + (Number.isFinite(seconds) ? seconds : 170) * 1000;
const total = { passes: 0, handedOver: 0, nobodyFree: 0, callbacks: 0, failed: 0 };

// The receptionist's start check is asked before the AI says hello, and
// Sarvam does not wait long: a function that has gone cold answered in about
// three seconds on 9 October 2026, after Sarvam had given up, and the buyer
// who rang back got "receptionist at us". A request with no token is turned
// away at once, touches nothing, and keeps the function warm.
const appBase = (process.env.CALLS_WEBHOOK_BASE ?? process.env.CONNECT_BASE_URL ?? process.env.AUTH_URL ?? "").replace(/\/+$/, "");
const WARM_EVERY_MS = 60_000;
let warmedAt = 0;
async function keepReceptionistWarm(): Promise<void> {
  if (!appBase.startsWith("https://") || Date.now() - warmedAt < WARM_EVERY_MS) return;
  warmedAt = Date.now();
  await fetch(`${appBase}/api/calls/inbound/start`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
}

while (Date.now() < until) {
  const started = Date.now();
  await keepReceptionistWarm();
  try {
    const r = await handOffLongCalls();
    total.passes += 1;
    total.handedOver += r.handedOver;
    total.nobodyFree += r.nobodyFree;
    total.failed += r.failed;
    if (r.handedOver || r.failed) console.log(`  with AI ${r.withAi}, live ${r.seenLive}, handed over ${r.handedOver}, nobody free ${r.nobodyFree}, failed ${r.failed}`);
  } catch (e) {
    total.failed += 1;
    console.error(e instanceof Error ? e.message : e);
  }
  try {
    total.callbacks += await runDueCallbacks();
  } catch (e) {
    total.failed += 1;
    console.error(e instanceof Error ? e.message : e);
  }
  // The next people on every running call list, a few at a time.
  try {
    const l = await runCallLists();
    if (l.placed) console.log(`  call lists: rang ${l.placed}, settled ${l.settled}`);
  } catch (e) {
    total.failed += 1;
    console.error(e instanceof Error ? e.message : e);
  }
  const wait = WATCH_SECONDS * 1000 - (Date.now() - started);
  if (wait > 0 && Date.now() + wait < until) await new Promise((r) => setTimeout(r, wait));
  else if (wait > 0) break;
}

console.log(`  passes ${total.passes}, handed over ${total.handedOver}, nobody free ${total.nobodyFree}, call backs ${total.callbacks}, failed ${total.failed}`);
await closeDb();
process.exitCode = 0;
