// The daily re-verification, runnable.
//
//   node --experimental-strip-types --env-file=.env.local scripts/rera-sweep.mts
//
// Put this on a schedule once deployed. It is idempotent: running it twice in
// a row changes nothing the second time, because everything it does is driven
// by dates that have already passed.
import { sweep } from "../src/lib/rera-sweep.ts";
import { closeDb } from "../src/lib/db/index.ts";

const started = Date.now();
const report = await sweep();

console.log("");
console.log(`  orgs scanned      ${report.orgsScanned}`);
console.log(`  records scanned   ${report.recordsScanned}`);
console.log(`  extended          ${report.extended.length}`);
console.log(`  lapsed            ${report.lapsed.length}`);
console.log(`  exemptions lapsed ${report.exemptionsLapsed.length}`);
console.log(`  revoked           ${report.revoked.length}`);
console.log(`  unregistered      ${report.unregistered.length}`);
console.log(`  another promoter  ${report.promoterMismatch.length}`);
console.log(
  `  revocation list   ${report.blocklistSize ?? "unread"}${report.blocklistError ? ` (${report.blocklistError})` : " projects"}`,
);
console.log(
  `  register          ${report.registerSize ?? "unread"}${report.registerError ? ` (${report.registerError})` : " projects"}`,
);

for (const [state, r] of Object.entries(report.states)) {
  console.log(
    `  ${state.padEnd(18)}${r.ok ? `register ${r.registerSize ?? "none published"}, listed ${r.blockedSize}, ${r.requests} requests` : `unread (${r.reason})`}`,
  );
}
console.log(
  `  ads paused        ${report.halted.paused}${report.halted.couldNotPause ? ` (${report.halted.couldNotPause} could not be reached, tried again next pass)` : ""}`,
);
console.log(`  posts to take down ${report.halted.flagged}`);

for (const c of [
  ...report.extended,
  ...report.lapsed,
  ...report.exemptionsLapsed,
  ...report.revoked,
  ...report.unregistered,
  ...report.promoterMismatch,
]) {
  console.log(`\n  ${c.phasePath}`);
  console.log(`    ${c.from} -> ${c.to}: ${c.why}`);
}

if (report.blocklistError || report.registerError || Object.values(report.states).some((r) => !r.ok)) {
  console.log("");
  console.log("  A published list could not be read, so nothing was blocked on");
  console.log("  its account. That is deliberate: an unreadable page is an");
  console.log("  unknown, not a finding. Expiry enforcement needs no portal and");
  console.log("  ran normally.");
}

console.log(`\n  done in ${Date.now() - started}ms\n`);
// The pools are module-level singletons, so without this the job finishes
// its work and then holds the event loop open forever. For a scheduled
// task that means a process that never reaps.
await closeDb();
process.exitCode = 0;
