// The worker's watchdog, runnable alone. It also runs at the end of lead:run
// and post:run. See src/lib/watchdog.ts.
//
//   node --experimental-strip-types --env-file=.env.local scripts/watchdog.mts
import { runWatchdog } from "../src/lib/watchdog.ts";

const r = await runWatchdog();
console.log(r.skipped ? `  watchdog skipped: ${r.skipped}` : `  watchdog: ${r.checked} logs read, alerts ${r.alerts.join(", ") || "none"}, ${r.sent} sent`);
