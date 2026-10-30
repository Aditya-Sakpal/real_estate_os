// Moves every sealed token onto its tenant's own data key under KMS, or
// rotates one tenant's key. Needs KMS_KEY_ARN (and AWS credentials, or
// KMS_DEV_KEY on a development machine) and still CONNECTOR_KEY, which opens
// the format 1 rows being moved.
//
//   npm run vault:reseal -- --dry-run      opens and seals again in memory, writes nothing
//   npm run vault:reseal                   re-seals row by row; running it twice moves nothing
//   npm run vault:reseal -- --org <id>     one tenant only
//   npm run vault:rotate -- --org <id>     a new data key for one tenant, the old one retired, its rows moved
//
// Prints counts per organisation and column, never a token. A row that
// opens for nobody is counted and left as it is.
import type { ResealCount } from "../src/lib/vault.ts";

const { resealOrg, rotateTenantKey } = await import("../src/lib/vault.ts");
const { closeDb } = await import("../src/lib/db/index.ts");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const rotate = args[0] === "rotate";
const dryRun = flag("dry-run");
const only = arg("org");

if (!process.env.KMS_KEY_ARN?.trim()) {
  console.error("KMS_KEY_ARN is not set. Sealing stays in format 1 and there is nothing to move.");
  process.exit(1);
}
if (only && !/^[0-9a-f-]{36}$/i.test(only)) {
  console.error("--org takes an organisation id.");
  process.exit(1);
}
if (rotate && !only) {
  console.error("vault:rotate needs --org <id>: a rotation is one tenant at a time.");
  process.exit(1);
}

function print(orgId: string, counts: ResealCount[]) {
  const total = counts.reduce((t, c) => ({ rows: t.rows + c.rows, moved: t.moved + c.moved, unopened: t.unopened + c.unopened }), { rows: 0, moved: 0, unopened: 0 });
  console.log(`${orgId}  ${total.rows} sealed, ${total.moved} ${dryRun ? "to move" : "moved"}, ${total.unopened} did not open`);
  for (const c of counts) {
    if (!c.rows) continue;
    console.log(`    ${c.label.padEnd(28)} ${c.rows} sealed, ${c.current} current, ${c.moved} ${dryRun ? "to move" : "moved"}, ${c.unopened} did not open`);
  }
}

// Which tenants exist is read here, on the owner's connection, the way the
// other workers read it; each tenant's rows are then read and written
// inside that tenant, under RLS.
let orgIds: string[];
if (only) {
  orgIds = [only];
} else {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  orgIds = (await sql<{ id: string }[]>`SELECT id FROM orgs ORDER BY created_at`).map((o) => o.id);
  await sql.end();
}

let failed = 0;
for (const orgId of orgIds) {
  try {
    if (rotate) {
      const r = await rotateTenantKey(orgId);
      console.log(`${orgId}  key ${r.from ?? "none"} retired, key ${r.to} sealing now`);
      print(orgId, r.resealed);
    } else {
      print(orgId, await resealOrg(orgId, { dryRun }));
    }
  } catch (e) {
    failed++;
    console.error(`${orgId}  stopped: ${(e as Error).message}`);
  }
}
if (dryRun) console.log("\nDry run: nothing was written.");
await closeDb();
process.exit(failed ? 1 : 0);
