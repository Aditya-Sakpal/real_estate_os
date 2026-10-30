// The CRM worker, runnable.
//
//   node --experimental-strip-types --env-file=.env.local scripts/crm-run.mts
//
// One bounded pass over every organisation with a CRM connected: read what
// changed there (polling is the net under the webhooks), work what arrived,
// then send what changed here. Run it every two to five minutes. Two at once
// are safe: every write is claimed under a lease, and every event too.
//
// The same pass reads every live availability sheet that is due, CRM or no
// CRM, each under a lease of its own.
import { runCrmWork } from "../src/lib/crm-sync.ts";
import { runAvailabilityFeeds } from "../src/lib/inventory-feed.ts";
import { closeDb } from "../src/lib/db/index.ts";

const started = Date.now();
const reports = await runCrmWork();
const feeds = await runAvailabilityFeeds().catch((e: Error) => {
  console.error(`  live sheets: ${e.message.slice(0, 200)}`);
  return [];
});

console.log("");
if (!reports.length) console.log("  no CRM connected");
for (const r of reports) {
  console.log(`  ${r.orgId}  ${r.provider}`);
  console.log(`    polled           ${r.polled} changed`);
  console.log(`    in               ${r.inbound.done} done, ${r.inbound.waiting} waiting, ${r.inbound.failed} failed`);
  console.log(`    out              ${r.outbound.done} done, ${r.outbound.waiting} waiting, ${r.outbound.failed} failed`);
  if (r.error) console.log(`    error            ${r.error}`);
}
for (const f of feeds) {
  if (f.read) console.log(`  ${f.orgId}  live sheets: ${f.read} read, ${f.changed} changed, ${f.failed} failed`);
}
console.log(`\n  done in ${Date.now() - started}ms\n`);

await closeDb();
process.exitCode = 0;
