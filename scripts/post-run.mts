// The scheduled-post worker, runnable.
//
//   node --experimental-strip-types --env-file=.env.local scripts/post-run.mts
//
// One bounded pass: create the run rows whose generation is due, claim and
// execute them, then tidy up behind. It exits when it is done, so it sits
// behind a cron entry, a scheduled container task or a queue consumer without
// caring which of those the deployment happens to be.
//
// Run it every five to fifteen minutes. More often is harmless and does
// nothing extra: a slot is identified by its computed instant, so a second
// pass over the same minute inserts nothing and claims nothing.
//
// It is safe to run two of these at once. Each run is claimed with a lease
// before any work begins, so two workers that both saw the same due run
// resolve it in the database rather than by both calling the model.
import { runWatchdog } from "../src/lib/watchdog.ts";
import { runDue } from "../src/lib/post.ts";
import { publishDue } from "../src/lib/publish.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { stopOcr } from "../src/lib/ocr.ts";
import { warmVideos } from "../src/lib/media-variants.ts";

const started = Date.now();
const max = Number(process.argv.find((a) => a.startsWith("--max="))?.slice(6) ?? "25");

const report = await runDue({ maxRuns: Number.isFinite(max) ? max : 25 });
// Then what goes out: approved posts whose time has come, publications still
// processing, and the kill switch for anything on a phase that stopped being
// advertisable. The kill switch runs first inside it.
const published = await publishDue({ max: Number.isFinite(max) ? max : 25 });

// Then the lighter copies the console shows: a still and a 720p preview of
// each recent video, a few a pass, so a slow connection never waits on the
// full film to see a tile or start playing.
const warmed = await warmVideos({ limit: 4 }).catch(() => ({ checked: 0, made: 0, failed: 0 }));

console.log("");
console.log(`  orgs scanned       ${report.orgsScanned}`);
console.log(`  runs created       ${report.created}`);
console.log(`  runs generated     ${report.executed}`);
console.log(`  runs refused       ${report.refused}`);
console.log(`  runs failed        ${report.failed}`);
console.log(`  creatives expired  ${report.expiredCreatives}`);
console.log(`  runs closed        ${report.closedRuns}`);

console.log(`  posts handed out   ${published.enqueued}`);
console.log(`  went live          ${published.live}`);
console.log(`  ads created        ${published.adsCreated}`);
console.log(`  still processing   ${published.waiting}`);
console.log(`  failed to publish  ${published.failed}`);
console.log(`  ads paused (RERA)  ${published.halted.paused}${published.halted.couldNotPause ? ` (${published.halted.couldNotPause} could not be reached)` : ""}`);
console.log(`  posts to take down ${published.halted.flagged}`);
console.log(`  connections checked ${published.checked}`);
console.log(`  video copies made  ${warmed.made}${warmed.failed ? ` (${warmed.failed} failed)` : ""}`);

for (const note of [...new Set(report.notes)]) {
  console.log(`  note               ${note}`);
}

if (report.refused > 0) {
  console.log("");
  console.log("  A refusal is the product working, not the product breaking.");
  console.log("  Each one is recorded on its run with a reason a person can");
  console.log("  act on, and it is visible on the campaign's own screen.");
}

console.log(`\n  done in ${Date.now() - started}ms\n`);

// The pools are module-level singletons, so without this the worker finishes
// its work and then holds the event loop open forever. For a scheduled task
// that means a process that never reaps. The pixel gate's reader is a
// worker thread, which holds it open the same way.
// Read the other jobs' logs as lead:run does, so one of the two stopping
// is still told.
const watch = await runWatchdog();
if (!watch.skipped) console.log(`  watchdog: alerts ${watch.alerts.join(", ") || "none"}, ${watch.sent} sent`);

await closeDb();
await stopOcr();
process.exitCode = 0;
