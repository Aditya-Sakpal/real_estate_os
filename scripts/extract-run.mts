// The Brain document reader's worker, and Ask Jimmy's project setups. Reads whatever is due, a bounded
// number, and exits, so it can sit behind a cron entry: a reading the console
// started and could not finish (the request that started it timed out, or
// the server restarted) is picked up here once its lease runs out.
//
//   node --experimental-strip-types --env-file=.env.local scripts/extract-run.mts [--org <id> --run <id>]
const { runDueExtractions, runExtraction } = await import("../src/lib/extract.ts");
const { closeDb } = await import("../src/lib/db/index.ts");
const { stopOcr } = await import("../src/lib/ocr.ts");

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const org = arg("org");
const run = arg("run");
const started = Date.now();
if (org && run) {
  const r = await runExtraction(org, run);
  console.log(new Date().toISOString(), "extract", run, r.ok ? `found ${r.found}` : r.message, `${Math.round((Date.now() - started) / 1000)}s`);
} else {
  // Which tenants exist is read here, on the owner's connection the way the
  // other workers read it; the library never reads across tenants.
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const orgs = await sql<{ id: string }[]>`
    SELECT DISTINCT e.org_id AS id FROM brain_extractions e
    JOIN orgs o ON o.id = e.org_id AND o.status <> 'SUSPENDED'
    WHERE e.state = 'QUEUED' OR (e.state = 'RUNNING' AND e.lease_until < now())`;
  // Projects being set up from files in Ask Jimmy that a process left part
  // way, and the setups and files that have lived their time.
  const setups = await sql<{ id: string; org_id: string; user_id: string; state: string }[]>`
    SELECT s.id, s.org_id, s.user_id, s.state FROM project_setups s
    JOIN orgs o ON o.id = s.org_id AND o.status <> 'SUSPENDED'
    WHERE s.state IN ('READING', 'CREATING') AND (s.lease_until IS NULL OR s.lease_until < now())
      AND s.attempts < 6 AND s.updated_at < now() - interval '2 minutes'
    ORDER BY s.updated_at LIMIT 5`;
  await sql`
    UPDATE project_setups SET state = 'FAILED', finished_at = now(), updated_at = now(),
      result = '{"message": "Those files could not be read. Try attaching them again, or one at a time.", "lines": [], "links": []}'::jsonb
    WHERE state = 'READING' AND attempts >= 3 AND (lease_until IS NULL OR lease_until < now())`;
  await sql`
    UPDATE project_setups SET state = 'EXPIRED', finished_at = now(), updated_at = now(),
      result = '{"message": "This expired. Attach the files again to set the project up.", "lines": [], "links": []}'::jsonb
    WHERE state IN ('ASKING', 'READY') AND updated_at < now() - interval '7 days'`;
  await sql`DELETE FROM project_setups WHERE state IN ('DONE', 'FAILED', 'CANCELLED', 'EXPIRED') AND updated_at < now() - interval '14 days'`;
  await sql`DELETE FROM ask_files WHERE setup_id IS NULL AND created_at < now() - interval '48 hours'`;
  await sql.end();
  const done = await runDueExtractions({ orgIds: orgs.map((o) => o.id) });
  console.log(new Date().toISOString(), "documents read:", done);
  if (setups.length) {
    const { runDueSetups } = await import("../src/lib/setup.ts");
    console.log(new Date().toISOString(), "setups worked:", await runDueSetups(setups));
  }
}
await stopOcr();
await closeDb();
process.exit(0);
