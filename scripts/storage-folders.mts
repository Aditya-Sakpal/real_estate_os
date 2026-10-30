// Move every file into its project's folder (0084, decided 4 October 2026).
//
//   npm run storage:folders                     dry run: counts per tenant, writes nothing
//   npm run storage:folders -- --apply          copy each file to its new key, then point every row at it
//   npm run storage:folders -- --apply --delete-old   and remove the old copies no row points at any more
//   npm run storage:folders -- --org <id>       one tenant only
//
// Every key used to be flat: org/<org>/<kind>/<id>. Now a file lives under
// the project it belongs to, org/<org>/project/<project>/<kind>/<id>, or
// under org/<org>/shared/ when it belongs to the organisation or an entity.
//
// Run on the owner's connection, because it reads and writes every tenant.
// Safe to run twice: a key already in a folder is left alone, a copy is
// asked of the store again only for a key not yet moved, and rows are
// updated only from the old key to the new one. A key nothing tells the
// project of (a post removed, leaving only its frozen publication) moves to
// `shared`. The old copy is removed only with --delete-old, only after every
// row is rewritten, and only when a fresh read finds no row still naming it.
import { controlDb, closeDb } from "../src/lib/db/index.ts";
import { assetKey, storage } from "../src/lib/storage.ts";
import { KEY_COLUMNS, keyParts } from "../src/lib/sweep-rules.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const deleteOld = args.includes("--delete-old");
const at = args.indexOf("--org");
const onlyOrg = at >= 0 ? args[at + 1] : null;
const sql = controlDb;

type Col = { table: string; column: string; json: boolean; type: string };

/** The key columns that exist in this database, with their real type. */
async function columns(): Promise<Col[]> {
  const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public'`;
  const have = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));
  return KEY_COLUMNS.filter((c) => have.has(`${c.table}.${c.column}`)).map((c) => ({ ...c, type: have.get(`${c.table}.${c.column}`)! }));
}

/** Every key a column holds for one tenant, at any depth of a JSON column. */
async function keysIn(c: Col, orgId: string): Promise<string[]> {
  const prefix = `org/${orgId}/`;
  const rows = c.json
    ? await sql.unsafe<{ k: string }[]>(
        `SELECT DISTINCT v #>> '{}' AS k FROM ${c.table}, jsonb_path_query(${c.column}::jsonb, 'strict $.**') AS v
         WHERE ${c.table}.org_id = $1 AND jsonb_typeof(v) = 'string' AND starts_with(v #>> '{}', $2)`,
        [orgId, prefix],
      )
    : await sql.unsafe<{ k: string }[]>(`SELECT DISTINCT ${c.column} AS k FROM ${c.table} WHERE org_id = $1 AND starts_with(${c.column}, $2)`, [orgId, prefix]);
  return rows.map((r) => r.k);
}

/**
 * The node each flat key belongs to, read from the rows that own the files.
 * Copies (a publication, a broadcast) follow the post they came from.
 */
async function ownersOf(orgId: string): Promise<Map<string, string>> {
  const owner = new Map<string, string>();
  const put = (rows: { k: string | null; node: string | null }[]) => {
    for (const r of rows) if (r.k && r.node && !owner.has(r.k)) owner.set(r.k, r.node);
  };
  put(await sql`SELECT av.storage_key AS k, a.scope_node_id AS node FROM asset_versions av JOIN assets a ON a.id = av.asset_id WHERE av.org_id = ${orgId}`);
  put(await sql`SELECT storage_key AS k, scope_node_id AS node FROM generated_media WHERE org_id = ${orgId}`);
  put(await sql`SELECT storage_key AS k, scope_node_id AS node FROM visit_notes WHERE org_id = ${orgId}`);
  put(await sql`SELECT storage_key AS k, scope_node_id AS node FROM brain_documents WHERE org_id = ${orgId}`);
  put(await sql`
    SELECT v #>> '{}' AS k, d.scope_node_id AS node
    FROM brain_documents d, jsonb_path_query(d.previews::jsonb, 'strict $.**') v
    WHERE d.org_id = ${orgId} AND jsonb_typeof(v) = 'string'`);
  put(await sql`
    SELECT v #>> '{}' AS k, r.scope_node_id AS node
    FROM rendered_posts r, jsonb_path_query(r.media::jsonb || jsonb_build_array(r.inputs::jsonb), 'strict $.**') v
    WHERE r.org_id = ${orgId} AND jsonb_typeof(v) = 'string'`);
  put(await sql`
    SELECT v #>> '{}' AS k, b.scope_node_id AS node
    FROM post_creatives c JOIN post_runs r ON r.id = c.run_id JOIN post_schedules s ON s.id = r.schedule_id
    JOIN campaign_briefs b ON b.id = s.brief_id,
    jsonb_path_query(coalesce(c.media::jsonb, '[]'::jsonb), 'strict $.**') v
    WHERE c.org_id = ${orgId} AND jsonb_typeof(v) = 'string'`);
  put(await sql`
    SELECT i.storage_key AS k, p.scope_node_id AS node
    FROM partner_invoices i JOIN payout_milestones m ON m.id = i.milestone_id JOIN partner_payouts p ON p.id = m.payout_id
    WHERE i.org_id = ${orgId}`);
  return owner;
}

async function projectsOf(orgId: string): Promise<Map<string, string | null>> {
  const rows = await sql<{ id: string; project: string | null }[]>`
    SELECT n.id, (SELECT p.id FROM scope_nodes p WHERE p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project
    FROM scope_nodes n WHERE n.org_id = ${orgId}`;
  return new Map(rows.map((r) => [r.id, r.project]));
}

async function rewrite(db: typeof sql, c: Col, orgId: string, from: string, to: string): Promise<number> {
  if (!c.json) {
    const r = await db.unsafe(`UPDATE ${c.table} SET ${c.column} = $1 WHERE org_id = $2 AND ${c.column} = $3`, [to, orgId, from]);
    return r.count;
  }
  // A key is letters, digits, dots, dashes and slashes, so it is the same
  // inside JSON as outside it, and the quotes make the match exact.
  const cast = c.type === "json" ? "json" : "jsonb";
  const r = await db.unsafe(
    `UPDATE ${c.table} SET ${c.column} = replace(${c.column}::text, $1, $2)::${cast}
     WHERE org_id = $3 AND strpos(${c.column}::text, $1) > 0`,
    [JSON.stringify(from), JSON.stringify(to), orgId],
  );
  return r.count;
}

try {
  const cols = await columns();
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, display_name AS name FROM orgs ${onlyOrg ? sql`WHERE id = ${onlyOrg}` : sql``} ORDER BY display_name`;
  const store = storage();
  console.log(`\n  ${apply ? "APPLY" : "DRY RUN, nothing written"}${deleteOld ? ", old copies removed" : ""}\n`);
  let total = 0;
  for (const org of orgs) {
    const keys = new Set<string>();
    for (const c of cols) for (const k of await keysIn(c, org.id)) keys.add(k);
    const flat = [...keys].filter((k) => keyParts(k, org.id)?.flat);
    if (!flat.length) continue;
    const [owner, projects] = await Promise.all([ownersOf(org.id), projectsOf(org.id)]);
    const moves: { from: string; to: string }[] = [];
    let shared = 0;
    for (const k of flat) {
      const p = keyParts(k, org.id)!;
      const node = owner.get(k);
      const project = node ? (projects.get(node) ?? null) : null;
      if (!project) shared++;
      const to = assetKey({ orgId: org.id, project, kind: p.kind, id: p.id });
      if (to && to !== k) moves.push({ from: k, to });
    }
    total += moves.length;
    console.log(`  ${org.name} (${org.id}): ${moves.length} files, ${moves.length - shared} into project folders, ${shared} into shared`);
    if (!apply) continue;

    // Copy first. A file the store does not hold (gone already) keeps its
    // row as it is: pointing a row at a copy that does not exist would turn
    // a missing file into a broken one.
    const copied: { from: string; to: string }[] = [];
    let missing = 0;
    for (const m of moves) {
      try {
        await store.copy(m.from, m.to);
        copied.push(m);
      } catch {
        missing++;
      }
    }
    // Then every row, in one transaction per tenant.
    let rows = 0;
    await sql.begin(async (tx) => {
      for (const m of copied) for (const c of cols) rows += await rewrite(tx as unknown as typeof sql, c, org.id, m.from, m.to);
    });
    console.log(`    copied ${copied.length}, ${missing} not in the store, ${rows} row values rewritten`);

    if (deleteOld) {
      let removed = 0;
      const still = new Set<string>();
      for (const c of cols) for (const k of await keysIn(c, org.id)) still.add(k);
      for (const m of copied) {
        if (still.has(m.from)) continue;
        await store.remove(m.from).catch(() => {});
        removed++;
      }
      console.log(`    removed ${removed} old copies`);
    }
  }
  console.log(`\n  ${total} files in all\n`);
} finally {
  await closeDb();
}
