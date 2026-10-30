// The orphan sweep, end to end against a local file store.
//
//   npm run check:sweep
//
// It points the store at a temporary folder (ASSETS_DIR), builds three
// tenants of its own with a row in every table that holds a storage key,
// plants orphans beside them, and drives the real sweep: the owner marker,
// the dry run, the floor, the grace period, --apply and the audit rows. It
// then scans every text and JSON column in the database for a storage key,
// which is the check that fails when a new table starts holding keys the
// sweep does not read.
//
// It touches no bucket: it refuses to start unless the store is the local
// folder, because a sweep run against a real bucket from here would be a
// real sweep.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

if (!existsSync(".env.local")) throw new Error("run with --env-file=.env.local");
const STORE = mkdtempSync(join(tmpdir(), "salesdesk-sweep-"));
process.env.ASSETS_DIR = STORE;

const { storage, readAsset } = await import("../src/lib/storage.ts");
const { sweepAssets, claimStore, currentDatabaseId, referencedKeys, presentColumns } = await import("../src/lib/asset-sweep.ts");
const { KEY_COLUMNS, OWNER_KEY, ownerMarker, databaseId } = await import("../src/lib/sweep-rules.ts");
const { removePost } = await import("../src/lib/compose.ts");
const { closeDb } = await import("../src/lib/db/index.ts");

if (storage().name !== "local") throw new Error("check:sweep must run against a local store, never a bucket");

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
  ok ? pass++ : fail++;
}

const DAY = 86_400_000;
const OLD = new Date(Date.now() - 3 * DAY);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const exists = async (key: string) => (await readAsset(key)) !== null;

/** Put a file in the store, dated as `modified`. */
async function file(key: string, modified: Date, bytes = 100) {
  await storage().put(key, Buffer.alloc(bytes, 7), "application/octet-stream");
  utimesSync(join(STORE, key), modified, modified);
}

// ---------------------------------------------------------------------------
// Three tenants of its own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const [founder] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`sweep@sweep${tag}.example`}, ${`sweep${tag}.example`}, 'Sweep Check') RETURNING id`;

async function tenant(name: string, slug: string) {
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, 'AAPFU0939F', ${`${slug}.example`}, ${founder.id}) RETURNING id`;
  const [root] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, NULL, 'ORG', ${name}, ${slug}, ${slug}::ltree) RETURNING id, path::text AS path`;
  const node = async (parent: { id: string; path: string }, kind: string, n: string, s: string) => {
    const [row] = await sql<{ id: string; path: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${org.id}, ${parent.id}, ${kind}, ${n}, ${s}, ${`${parent.path}.${s}`}::ltree) RETURNING id, path::text AS path`;
    return row;
  };
  const entity = await node(root, "ENTITY", `${name} LLP`, "llp");
  const region = await node(entity, "REGION", "Pune", "pune");
  const project = await node(region, "PROJECT", "Sweep Heights", "sweep_heights");
  const phase = await node(project, "PHASE", "Tower C", "tower_c");
  return { orgId: org.id, project, phase, key: (kind: string, id: string) => `org/${org.id}/${kind}/${id}` };
}

async function assetRow(t: Awaited<ReturnType<typeof tenant>>, id: string, key: string) {
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO assets (id, org_id, scope_node_id, category) VALUES (${id}, ${t.orgId}, ${t.phase.id}, 'EXTERIOR') RETURNING id`;
  await sql`
    INSERT INTO asset_versions (org_id, asset_id, version, storage_key, media_type, media_bytes, sha256)
    VALUES (${t.orgId}, ${a.id}, 1, ${key}, 'image/png', 100, ${hash(key)})`;
}

const A = await tenant("Sweep Group", `sweep_a_${tag}`);
const B = await tenant("Sweep Other", `sweep_b_${tag}`);
const C = await tenant("Sweep Empty", `sweep_c_${tag}`);
const fixtureOrgs = [A.orgId, B.orgId, C.orgId];
const stranger = randomUUID();

try {
  // --- A: one live file behind every kind of row, and three kinds of orphan
  const assetId = randomUUID();
  await assetRow(A, assetId, A.key("asset", assetId));

  const backdrop = randomUUID();
  await sql`
    INSERT INTO generated_media (org_id, scope_node_id, role, prompt, model, storage_key, media_type, media_bytes, sha256)
    VALUES (${A.orgId}, ${A.project.id}, 'BACKDROP', 'warm light', 'fixture', ${A.key("backdrop", backdrop)}, 'image/png', 100, ${hash(backdrop)})`;

  const [brief] = await sql<{ id: string }[]>`
    INSERT INTO campaign_briefs (org_id, scope_node_id, name) VALUES (${A.orgId}, ${A.phase.id}, 'Sweep brief') RETURNING id`;
  const postRow = async (id: string, media: object[], inputs: object = {}) => {
    await sql`
      INSERT INTO rendered_posts (id, org_id, brief_id, scope_node_id, kind, placement, language, segment, headline, body, cta, media, inputs)
      VALUES (${id}, ${A.orgId}, ${brief.id}, ${A.phase.id}, 'IMAGE', 'Meta feed 1:1', 'English', 'END_USER', 'H', 'B', 'C',
              ${sql.json(media as never)}, ${sql.json(inputs as never)})`;
  };
  // A film: its frame in media, its own unstamped copy deep inside inputs.
  const film = randomUUID();
  await postRow(film, [{ key: A.key("post", `${film}-0`), type: "video/mp4" }], { film: { raw: A.key("post", `${film}-raw`), note: null } });
  // A post that went out, and one that did not, for removePost below.
  const published = randomUUID();
  await postRow(published, [{ key: A.key("post", `${published}-0`), type: "image/jpeg" }]);
  const unpublished = randomUUID();
  await postRow(unpublished, [{ key: A.key("post", `${unpublished}-0`), type: "image/jpeg" }]);

  const [schedule] = await sql<{ id: string }[]>`
    INSERT INTO post_schedules (org_id, brief_id, scope_node_id, name, days_of_week, at_minute)
    VALUES (${A.orgId}, ${brief.id}, ${A.phase.id}, 'Sweep weekly', ARRAY[1]::smallint[], 600) RETURNING id`;
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at)
    VALUES (${A.orgId}, ${schedule.id}, now(), now(), now()) RETURNING id`;
  const creative = randomUUID();
  await sql`
    INSERT INTO post_creatives (id, org_id, run_id, language, segment, headline, body, cta, verdict, model, template, content_sha256, media)
    VALUES (${creative}, ${A.orgId}, ${run.id}, 'English', 'END_USER', 'H', 'B', 'C', 'PASS', 'fixture', 'fixture', ${hash(creative)},
            ${sql.json([{ key: A.key("post", `${creative}-0`), type: "image/jpeg" }] as never)})`;

  const [conn] = await sql<{ id: string }[]>`
    INSERT INTO connections (org_id, provider) VALUES (${A.orgId}, 'META') RETURNING id`;
  const [account] = await sql<{ id: string }[]>`
    INSERT INTO connection_accounts (org_id, connection_id, kind, external_id, name, scope_node_id)
    VALUES (${A.orgId}, ${conn.id}, 'FACEBOOK_PAGE', ${`page-${tag}`}, 'Sweep Page', ${A.project.id}) RETURNING id`;
  await sql`
    INSERT INTO publish_targets (org_id, source, destination, account_id, kind, headline, caption, content_sha256,
                                 scope_node_id, phase_id, idempotency_key, rendered_post_id, media)
    VALUES (${A.orgId}, 'STUDIO', 'FACEBOOK_PAGE', ${account.id}, 'IMAGE', 'H', 'caption', ${hash("c")},
            ${A.phase.id}, ${A.phase.id}, ${hash(`idem-${tag}`)}, ${published},
            ${sql.json([{ key: A.key("post", `${published}-0`), type: "image/jpeg" }] as never)})`;

  const live = [
    A.key("asset", assetId),
    A.key("backdrop", backdrop),
    A.key("post", `${film}-0`),
    A.key("post", `${film}-raw`),
    A.key("post", `${published}-0`),
    A.key("post", `${unpublished}-0`),
    A.key("post", `${creative}-0`),
  ];
  for (const k of live) await file(k, OLD);
  const orphanAsset = A.key("asset", randomUUID());
  const orphanPost = A.key("post", `${randomUUID()}-0`);
  const young = A.key("backdrop", randomUUID());
  const unknownKind = A.key("brochure", randomUUID());
  await file(orphanAsset, OLD, 300);
  await file(orphanPost, OLD, 500);
  await file(young, new Date());
  await file(unknownKind, OLD);

  // --- B: one live file and a dozen orphans, which is a broken read
  const bAsset = randomUUID();
  await assetRow(B, bAsset, B.key("asset", bAsset));
  await file(B.key("asset", bAsset), OLD);
  const bOrphans = Array.from({ length: 12 }, () => B.key("asset", randomUUID()));
  for (const k of bOrphans) await file(k, OLD);

  // --- C: files and no rows at all
  const cFiles = [C.key("asset", randomUUID()), C.key("asset", randomUUID())];
  for (const k of cFiles) await file(k, OLD);

  // --- an org that no longer exists
  const strangerKey = `org/${stranger}/asset/${randomUUID()}`;
  await file(strangerKey, OLD);

  // -------------------------------------------------------------------------
  console.log("\nwhich database owns the store");
  // -------------------------------------------------------------------------
  const me = await currentDatabaseId();
  check("this database has an identity", typeof me === "string" && me.startsWith("pg:"), true);

  const unclaimed = await sweepAssets({ apply: true });
  check("a store nobody claimed is not swept", unclaimed.ok ? "swept" : unclaimed.code, "UNCLAIMED");

  await storage().put(OWNER_KEY, Buffer.from(ownerMarker(databaseId("1", "elsewhere"), new Date())), "application/json");
  const other = await sweepAssets({ apply: true });
  check("a store another database claimed is not swept", other.ok ? "swept" : other.code, "OTHER_DATABASE");
  const steal = await claimStore();
  check("and cannot be claimed from here", steal.ok, false);
  check("so every orphan is still there", await exists(orphanAsset), true);

  await storage().remove(OWNER_KEY);
  const claimed = await claimStore();
  check("an unclaimed store can be claimed", claimed.ok && !claimed.already, true);
  const again = await claimStore();
  check("and claiming it twice changes nothing", again.ok && again.already, true);

  // -------------------------------------------------------------------------
  console.log("\nevery row that holds a key is read");
  // -------------------------------------------------------------------------
  const refs = await referencedKeys(A.orgId, await presentColumns());
  check("every live file of A is referenced", live.every((k) => refs.has(k)), true);
  check("including the film's copy deep in inputs", refs.has(A.key("post", `${film}-raw`)), true);
  check("and nothing of B's", [...refs].some((k) => k.includes(B.orgId)), false);

  // -------------------------------------------------------------------------
  console.log("\nthe dry run");
  // -------------------------------------------------------------------------
  const auditBefore = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE org_id = ANY(${fixtureOrgs})`;
  const dry = await sweepAssets({});
  if (!dry.ok) throw new Error(`dry run refused: ${dry.message}`);
  const ta = dry.tenants.find((t) => t.orgId === A.orgId)!;
  const tb = dry.tenants.find((t) => t.orgId === B.orgId)!;
  const tc = dry.tenants.find((t) => t.orgId === C.orgId)!;
  check("A: two old orphans found", [ta.orphans, ta.orphanBytes], [2, 800]);
  check("A: the new file is too young to judge", ta.young, 1);
  check("A: a kind the sweep does not read is left alone", ta.unknown, { brochure: 1 });
  check("A: nothing refused", ta.refused, null);
  check("B: a dozen orphans beside one live file is refused", tb.refused, "TOO_MANY");
  check("C: files with no rows at all is refused", tc.refused, "NOTHING_REFERENCED");
  check("a folder for an org that no longer exists is reported", dry.strangers.map((s) => s.orgId).includes(stranger), true);
  check("a dry run deletes nothing", [ta.deleted, await exists(orphanAsset), await exists(orphanPost)], [0, true, true]);
  const auditDry = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE org_id = ANY(${fixtureOrgs})`;
  check("and writes no audit row", auditDry[0].n, auditBefore[0].n);

  // -------------------------------------------------------------------------
  console.log("\nremoving a post that went out");
  // -------------------------------------------------------------------------
  await removePost({ orgId: A.orgId, actorUserId: founder.id, postId: published });
  const [gone] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rendered_posts WHERE id = ${published}`;
  check("the post is removed", gone.n, 0);
  check("but its file stays, because the publication still shows it", await exists(A.key("post", `${published}-0`)), true);
  await removePost({ orgId: A.orgId, actorUserId: founder.id, postId: unpublished });
  check("a post that never went out takes its file with it", await exists(A.key("post", `${unpublished}-0`)), false);

  // -------------------------------------------------------------------------
  console.log("\n--apply");
  // -------------------------------------------------------------------------
  const applied = await sweepAssets({ apply: true });
  if (!applied.ok) throw new Error(`apply refused: ${applied.message}`);
  const aa = applied.tenants.find((t) => t.orgId === A.orgId)!;
  check("A: the two orphans are deleted", [aa.deleted, aa.deletedBytes, aa.failed], [2, 800, 0]);
  check("and they are gone", [await exists(orphanAsset), await exists(orphanPost)], [false, false]);
  const stillLive = await Promise.all(live.filter((k) => !k.includes(unpublished)).map(exists));
  check("every file a row points at is still there", stillLive.every(Boolean), true);
  check("the young file is still there", await exists(young), true);
  check("the unknown kind is still there", await exists(unknownKind), true);
  check("B: refused, so all thirteen files are still there",
    (await Promise.all([B.key("asset", bAsset), ...bOrphans].map(exists))).every(Boolean), true);
  check("C: refused, so both files are still there", (await Promise.all(cFiles.map(exists))).every(Boolean), true);
  check("the stranger's folder is untouched", await exists(strangerKey), true);
  check("the marker is untouched", await exists(OWNER_KEY), true);

  const rows = await sql<{ org_id: string; metadata: Record<string, unknown>; target_id: string | null }[]>`
    SELECT org_id, metadata, target_id FROM audit_log WHERE org_id = ANY(${fixtureOrgs}) AND action = 'storage.swept'`;
  check("one audit row per tenant the run acted on", rows.map((r) => r.org_id).sort(), [...fixtureOrgs].sort());
  const aRow = rows.find((r) => r.org_id === A.orgId)!;
  check("with the counts and bytes", [aRow.metadata.deleted, aRow.metadata.deleted_bytes, aRow.metadata.run], [2, 800, applied.runId]);
  check("and a refusal where there was one", rows.find((r) => r.org_id === B.orgId)!.metadata.refused, "TOO_MANY");
  check("and no key anywhere in it", rows.some((r) => JSON.stringify(r).includes("org/")), false);

  const twice = await sweepAssets({ apply: true, orgIds: [A.orgId] });
  check("a second run finds nothing more to delete", twice.ok && twice.tenants[0].deleted, 0);

  // -------------------------------------------------------------------------
  console.log("\nno table holds a key the sweep does not read");
  // -------------------------------------------------------------------------
  // Every text, JSON and array column in the database, every tenant. A key
  // turning up anywhere not on the list is a table whose files the sweep
  // would delete as orphans.
  const cols = await sql<{ table_name: string; column_name: string }[]>`
    SELECT c.table_name, c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.data_type IN ('text', 'jsonb', 'json', 'ARRAY', 'character varying')`;
  // Every shape a key has: project/<project>/<kind>/<id>, shared/<kind>/<id>, and the flat <kind>/<id>.
  const KEY = "org/[0-9a-f-]{36}/(?:project/[A-Za-z0-9._-]+/|shared/)?[A-Za-z0-9._-]+/[A-Za-z0-9._-]+";
  const registered = new Set(KEY_COLUMNS.map((c) => `${c.table}.${c.column}`));
  const holding: string[] = [];
  const found = new Map<string, Set<string>>();
  for (const c of cols) {
    const hits = await sql<{ k: string }[]>`
      SELECT DISTINCT m[1] AS k
      FROM ${sql(c.table_name)} t, regexp_matches(t.${sql(c.column_name)}::text, ${KEY}, 'g') m
      WHERE t.${sql(c.column_name)}::text ~ ${KEY}`;
    if (hits.length === 0) continue;
    holding.push(`${c.table_name}.${c.column_name}`);
    for (const h of hits) {
      const org = h.k.split("/")[1];
      if (!found.has(org)) found.set(org, new Set());
      found.get(org)!.add(h.k);
    }
  }
  const unregistered = holding.filter((c) => !registered.has(c));
  check("every column holding a key is on the sweep's list", unregistered, []);

  // And the reader agrees with the scan, for every tenant in the database:
  // a key the scan found in a row is a key the sweep reads.
  const orgIds = new Set((await sql<{ id: string }[]>`SELECT id::text AS id FROM orgs`).map((r) => r.id));
  const missed: string[] = [];
  for (const [org, keys] of found) {
    if (!orgIds.has(org)) continue;
    const read = await referencedKeys(org, await presentColumns());
    for (const k of keys) if (!read.has(k)) missed.push(k.replace(/[0-9a-f-]{36}/g, "…"));
  }
  check("the sweep reads every key the scan found, in every tenant", missed, []);
} finally {
  await sql`DELETE FROM publish_targets WHERE org_id = ANY(${fixtureOrgs})`;
  await sql`DELETE FROM audit_log WHERE org_id = ANY(${fixtureOrgs})`;
  await sql`DELETE FROM orgs WHERE id = ANY(${fixtureOrgs})`;
  await sql`DELETE FROM users WHERE id = ${founder.id}`;
  await sql.end();
  await closeDb();
  rmSync(STORE, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
