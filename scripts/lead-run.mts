// The lead worker, runnable.
//
//   node --experimental-strip-types --env-file=.env.local scripts/lead-run.mts
//
// One bounded pass over every tenant: finish capture events that did not
// finish, close calls the calling service never reported back on, run every
// call, WhatsApp and visit check that has fallen due, and once a day read
// each live ad's figures and move budget where an ad account allows it.
//
// Run it every two to five minutes. A lead captured inside calling hours is
// called by the capture route itself; this is what calls it at ten the next
// morning, sends the reminder a day before the visit, and notices the
// no-show. Two of these at once are safe: every task is claimed under a
// lease before it runs.
import { runLeadWork } from "../src/lib/lead-engine.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { runWatchdog } from "../src/lib/watchdog.ts";
import { archiveDueRecordings, hearSilentCalls } from "../src/lib/recordings.ts";

const started = Date.now();
const max = Number(process.argv.find((a) => a.startsWith("--max="))?.slice(6) ?? "50");
const report = await runLeadWork({ max: Number.isFinite(max) ? max : 50 });
// Then each finished call's recording, copied from Sarvam to our bucket.
const recorded = await archiveDueRecordings({ limit: 20 }).catch(() => ({ stored: 0, missing: 0, failed: 0 }));
// Then the calls the agent heard nobody on: a screener the agent could not hear is named.
const silent = await hearSilentCalls({ limit: 20 }).catch(() => ({ heard: 0, screened: 0 }));

console.log("");
console.log(`  orgs scanned       ${report.orgsScanned}`);
console.log(`  capture events     ${report.events}`);
console.log(`  silent calls closed ${report.silentCalls}`);
console.log(`  partner claims released ${report.released}`);
console.log(`  tasks run          ${report.tasks.ran}`);
console.log(`    done             ${report.tasks.done}`);
console.log(`    skipped          ${report.tasks.skipped}`);
console.log(`    waiting          ${report.tasks.deferred}`);
console.log(`    failed           ${report.tasks.failed}`);
console.log(`  ads read           ${report.budget.ads}`);
console.log(`  budget moves       ${report.budget.shifts}`);
console.log(`  outcomes sent      ${report.outcomes.sent}`);
console.log(`    waiting          ${report.outcomes.waiting}`);
console.log(`    not sent         ${report.outcomes.notSent}`);
console.log(`    failed           ${report.outcomes.failed}`);
console.log(`  WhatsApp accounts checked ${report.whatsapp.checked}`);
console.log(`    broken           ${report.whatsapp.broken}`);
console.log(`  broadcasts built from schedules ${report.broadcasts.scheduled}`);
console.log(`  broadcasts worked  ${report.broadcasts.worked}`);
console.log(`    sent ${report.broadcasts.sent}, refused ${report.broadcasts.refused}, failed ${report.broadcasts.failed}, halted ${report.broadcasts.halted}`);
console.log(`  voice notes read   ${report.notes}`);
console.log(`  recordings kept    ${recorded.stored}${recorded.missing ? `, ${recorded.missing} not at Sarvam` : ""}${recorded.failed ? `, ${recorded.failed} failed` : ""}`);
console.log(`  silent calls heard ${silent.heard}${silent.screened ? `, ${silent.screened} were a call screener` : ""}`);
console.log(`  portal accounts asked ${report.portals.asked}, leads ${report.portals.leads}, broken ${report.portals.broken}`);
console.log(`\n  done in ${Date.now() - started}ms\n`);

// The other jobs' logs are read here too, so a failed or stopped job is
// emailed without anything new installed on the worker.
const watch = await runWatchdog();
if (!watch.skipped) console.log(`  watchdog: alerts ${watch.alerts.join(", ") || "none"}, ${watch.sent} sent\n`);

await closeDb();
process.exitCode = 0;
