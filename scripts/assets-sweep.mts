// The orphan sweep: files in the store that no row points at.
//
//   npm run assets:sweep                  dry run, deletes nothing
//   npm run assets:sweep -- --apply       deletes what the dry run listed
//   npm run assets:sweep -- --claim       names this database as the store's owner
//   npm run assets:sweep -- --org <id>    one tenant only
//
// Run it against the database that owns the store it points at, and nothing
// else: the store's sweep-owner.json names that database, and every other
// one is refused. Development and production have separate buckets for this
// reason (28 September 2026).
import { claimStore, sweepAssets } from "../src/lib/asset-sweep.ts";
import { SWEEP_GRACE_HOURS, refusalWords } from "../src/lib/sweep-rules.ts";
import { closeDb } from "../src/lib/db/index.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--org");
const orgIds = at >= 0 && args[at + 1] ? [args[at + 1]] : undefined;
const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;

try {
  if (args.includes("--claim")) {
    const r = await claimStore();
    if (!r.ok) {
      console.log(`\n  ${r.message}\n`);
      process.exitCode = 1;
    } else {
      console.log(`\n  ${r.already ? "Already owned by" : "Now owned by"} ${r.database}\n`);
    }
  } else {
    const apply = args.includes("--apply");
    const r = await sweepAssets({ apply, orgIds });
    if (!r.ok) {
      console.log(`\n  ${r.message}\n`);
      process.exitCode = 1;
    } else {
      console.log(`\n  ${apply ? "APPLY" : "DRY RUN, nothing deleted"}  (store: ${r.store}, run ${r.runId})`);
      console.log(`  files younger than ${SWEEP_GRACE_HOURS} hours are never touched\n`);
      for (const t of r.tenants) {
        console.log(`  org ${t.orgId}`);
        console.log(`    files ${t.objects} (${mb(t.bytes)}), keys in rows ${t.referencedKeys}`);
        console.log(`    orphans ${t.orphans} (${mb(t.orphanBytes)}), too young ${t.young}`);
        const unknown = Object.entries(t.unknown);
        if (unknown.length) console.log(`    left alone, kind not read by the sweep: ${unknown.map(([k, n]) => `${k} ${n}`).join(", ")}`);
        if (t.refused) console.log(`    REFUSED: ${refusalWords(t.refused)}`);
        if (apply) console.log(`    deleted ${t.deleted} (${mb(t.deletedBytes)})${t.failed ? `, ${t.failed} could not be deleted` : ""}`);
      }
      for (const s of r.strangers) {
        console.log(`\n  org/${s.orgId}/ has ${s.objects} files (${mb(s.bytes)}) and no org in this database. Left alone.`);
      }
      console.log("");
    }
  }
} finally {
  await closeDb();
}
