// Runs db/migrations/*.sql in filename order, once each, as the OWNER role.
// Deliberately tiny: migrations are plain SQL so that the RLS policies and
// ltree definitions stay readable to anyone auditing the isolation model.
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "db", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (expected in .env.local)");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

await sql`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

const applied = new Set(
  (await sql`SELECT filename FROM _migrations`).map((r) => r.filename),
);
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

let ran = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`  skip  ${file}`);
    continue;
  }
  const body = await readFile(join(dir, file), "utf8");
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(body).simple();
      await tx`INSERT INTO _migrations (filename) VALUES (${file})`;
    });
    console.log(`  ok    ${file}`);
    ran++;
  } catch (err) {
    console.error(`  FAIL  ${file}\n`, err.message);
    await sql.end();
    process.exit(1);
  }
}

console.log(ran === 0 ? "nothing to apply" : `applied ${ran} migration(s)`);
await sql.end();
