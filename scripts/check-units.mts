// Functional check of unit types, against the real database and the real
// bucket.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-units.mts
//
// What this is about: a developer sells a 1 BHK and a 2 BHK in one tower at
// different prices, and until this table existed the product could not say so.
// Two failures followed, and both are here. A picture of the 2 BHK bedroom
// could be pulled into a 1 BHK advertisement, and the copy gate cleared
// "2 BHK from Rs 48 lakh" whenever Rs 48 lakh was a signed price anywhere on
// that tower, including when it was the 1 BHK's.
//
// The bucket is real, the way `check:assets` and `check:studio` use it: a
// storage layer nobody tests against the real store is one that breaks in
// production. Every object written here is removed.
//
// The suite builds its own entity, project and two towers and drops them at
// both ends. It never touches the organisation's own projects or libraries.
import { existsSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import postgres from "postgres";
import {
  addUnitType,
  approvedUnits,
  approveUnitType,
  copyUnitTypesTo,
  loadUnits,
  listUnitVersions,
  removeUnitType,
  reviseUnitType,
  tagAsset,
} from "../src/lib/unit.ts";
import {
  bedCountsIn,
  configsNamedIn,
  priceFor,
  unitHash,
  unitLabel,
  unitState,
} from "../src/lib/unit-rules.ts";
import { addAsset, loadLibrary } from "../src/lib/asset.ts";
import { generateBlocks, listBlocks, studioGround } from "../src/lib/creative.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { removeAsset, storageConfigured } from "../src/lib/storage.ts";
import type { CopyDriver } from "../src/lib/generate.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
/** Compares, rather than asking whether the answer is truthy. */
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  ok ? pass++ : fail++;
}

if (!existsSync(".env.local")) throw new Error("run with --env-file=.env.local");

const [admin] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string }[]>`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");

const [root] = await sql<{ id: string; path: string }[]>`
  SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG'`;

const SLUGS = ["unit_entity", "unit_project", "unit_tower_a", "unit_tower_b"];
const dropFixtures = async () => {
  await sql`DELETE FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS})`;
};
await dropFixtures();

const node = async (parent: string, kind: string, name: string, slug: string, path: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, ${parent}, ${kind}, ${name}, ${slug}, ${path}::ltree)
    RETURNING id, path::text AS path`;
  return row;
};
const entity = await node(root.id, "ENTITY", "Unit Check SPV", "unit_entity",
  `${root.path}.unit_entity`);
const project = await node(entity.id, "PROJECT", "Unit Check Project", "unit_project",
  `${entity.path}.unit_project`);
const towerA = await node(project.id, "PHASE", "Unit Check Tower A", "unit_tower_a",
  `${project.path}.unit_tower_a`);
const towerB = await node(project.id, "PHASE", "Unit Check Tower B", "unit_tower_b",
  `${project.path}.unit_tower_b`);

const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
// A number of its own per tower: each phase is a standalone registration
// under the explanation to Section 3, and the unique index says so.
const REGISTRATIONS: [{ id: string }, string][] = [
  [towerA, "P51700088881"],
  [towerB, "P51700088882"],
];
for (const [phase, number] of REGISTRATIONS) {
  await sql`
    INSERT INTO registration_records (scope_node_id, org_id, status, registration_no,
                                      state_code, promoter_name, valid_to, verified_at)
    VALUES (${phase.id}, ${org.id}, 'VERIFIED', ${number}, 'MH',
            'Unit Check SPV', ${FAR}, now())`;
}

// A published Brain carrying the rate per sq ft, so a configuration with no
// price of its own has something signed to compute one from.
const [version] = await sql<{ id: string }[]>`
  INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
  VALUES (${org.id}, ${project.id}, 1, 'DRAFT', ${admin.id})
  RETURNING id`;
const FACTS: [string, string][] = [
  ["claims.talking_points", "Nine minutes from the metro\nThree sided open plot"],
  ["claims.never_say", "guaranteed returns"],
  ["price.base_psf", "10000"],
];
for (const [key, value] of FACTS) {
  await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value)
            VALUES (${org.id}, ${version.id}, ${key}, ${value})`;
}
await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now()
          WHERE id = ${version.id}`;

// ---------------------------------------------------------------------------
console.log("\nreading a configuration out of a line of copy");

check("a plain one is found", bedCountsIn("2 BHK homes from Rs 76 lakh"), [2]);
// The ordinary way an Indian launch advertisement is written. Reading only
// the 2 out of this would refuse a lawful headline for quoting the 1 BHK.
check("so are both halves of an ampersand", bedCountsIn("1 & 2 BHK from Rs 48 lakh"), [1, 2]);
check("and of the word and", bedCountsIn("1 and 2 BHK available"), [1, 2]);
check("and of a slash", bedCountsIn("2/3 BHK"), [2, 3]);
check("a half is a configuration", bedCountsIn("2.5 BHK"), [2.5]);
// Digits, spaces and commas are exactly what separates "1, 2" from a phone
// number, so the parser reaches one and the bound is what stops it mattering.
check("a phone number beside one is not a bedroom count",
  bedCountsIn("Call 9876543210, 2 BHK ready"), [2]);
check("a configuration with no number is found by name",
  configsNamedIn("Spacious villas at the edge of the plot", ["VILLA", "2BHK"]), ["VILLA"]);
check("and copy naming none says so", configsNamedIn("Homes that grow with you", ["2BHK"]), []);

// ---------------------------------------------------------------------------
console.log("\nrecording what a tower sells");

const onProject = await addUnitType({
  orgId: org.id, actorUserId: admin.id, nodeId: project.id,
  config: "2BHK", variant: null, carpetAreaSqft: 682,
  balconyAreaSqft: null, startingPrice: null,
});
check("a configuration cannot hang off a project", onProject.ok, false);
check("because it belongs to one tower",
  onProject.ok ? null : onProject.code, "WRONG_LEVEL");

const silly = await addUnitType({
  orgId: org.id, actorUserId: admin.id, nodeId: towerA.id,
  config: "2BHK", variant: null, carpetAreaSqft: 4,
  balconyAreaSqft: null, startingPrice: null,
});
check("a carpet area nobody sells is refused", silly.ok ? null : silly.code, "CARPET");

const one = await addUnitType({
  orgId: org.id, actorUserId: admin.id, nodeId: towerA.id,
  config: "1BHK", variant: null, carpetAreaSqft: 452,
  balconyAreaSqft: 40, startingPrice: null,
});
const two = await addUnitType({
  orgId: org.id, actorUserId: admin.id, nodeId: towerA.id,
  config: "2BHK", variant: null, carpetAreaSqft: 682,
  balconyAreaSqft: 58, startingPrice: null,
});
check("the 1 BHK is recorded", one.ok, true);
check("and the 2 BHK", two.ok, true);

const twice = await addUnitType({
  orgId: org.id, actorUserId: admin.id, nodeId: towerA.id,
  config: "2BHK", variant: null, carpetAreaSqft: 690,
  balconyAreaSqft: null, startingPrice: null,
});
check("the same one twice is refused", twice.ok ? null : twice.code, "DUPLICATE");

const variant = await addUnitType({
  orgId: org.id, actorUserId: admin.id, nodeId: towerA.id,
  config: "2BHK", variant: "Optima", carpetAreaSqft: 744,
  balconyAreaSqft: null, startingPrice: 8_500_000,
});
check("but a second 2 BHK with a name of its own is not", variant.ok, true);

let view = (await loadUnits(org.id, towerA.id))!;
check("the tower holds three", view.units.length, 3);
check("the signed rate comes with them", view.basePsf, 10_000);
// Neither number was typed twice: the rate is signed once in the Brain and
// the area is approved once here.
check("a price with none set is the area times the rate",
  priceFor(view.units.find((u) => u.config === "1BHK")!, view.basePsf), 4_520_000);
check("and one set by hand wins",
  priceFor(view.units.find((u) => u.variant === "Optima")!, view.basePsf), 8_500_000);
check("a named 2 BHK reads as one", unitLabel({ config: "2BHK", variant: "Optima" }),
  "2 BHK Optima");

// ---------------------------------------------------------------------------
console.log("\nan approval pins the numbers, not the row");

const oneId = (one as { unitTypeId: string }).unitTypeId;
const twoId = (two as { unitTypeId: string }).unitTypeId;

check("nothing is approved on arrival",
  (await approvedUnits(org.id, towerA.id)).units.length, 0);

for (const id of [oneId, twoId, (variant as { unitTypeId: string }).unitTypeId]) {
  await approveUnitType({ orgId: org.id, actorUserId: admin.id, unitTypeId: id });
}
check("approving makes them available", (await approvedUnits(org.id, towerA.id)).units.length, 3);

const same = await reviseUnitType({
  orgId: org.id, actorUserId: admin.id, unitTypeId: twoId,
  carpetAreaSqft: 682, balconyAreaSqft: 58, startingPrice: null,
});
check("rewriting the same numbers is not a revision",
  same.ok ? null : same.code, "UNCHANGED");

await reviseUnitType({
  orgId: org.id, actorUserId: admin.id, unitTypeId: twoId,
  carpetAreaSqft: 682, balconyAreaSqft: 58, startingPrice: 7_900_000,
});
view = (await loadUnits(org.id, towerA.id))!;
const twoNow = view.units.find((u) => u.id === twoId)!;
check("a price change is a version", twoNow.version, 2);
check("and the one before it is still there", (await listUnitVersions(org.id, twoId)).length, 2);
check("the approval does not carry forward",
  unitState(twoNow, view.approvals).approved, false);
check("and the screen says it was approved once",
  unitState(twoNow, view.approvals).stale, true);
check("so the studio cannot quote it",
  (await approvedUnits(org.id, towerA.id)).units.some((u) => u.id === twoId), false);

// Putting the numbers back produces the same hash, so the person who approved
// exactly those numbers really did approve what is on screen again.
await reviseUnitType({
  orgId: org.id, actorUserId: admin.id, unitTypeId: twoId,
  carpetAreaSqft: 682, balconyAreaSqft: 58, startingPrice: null,
});
view = (await loadUnits(org.id, towerA.id))!;
check("putting them back restores the original approval",
  unitState(view.units.find((u) => u.id === twoId)!, view.approvals).approved, true);
check("through the hash rather than the version",
  unitHash({ config: "2BHK", variant: null, carpetAreaSqft: 682,
             balconyAreaSqft: 58, startingPrice: null }),
  view.units.find((u) => u.id === twoId)!.sha256);

const [appendOnly] = await sql<{ n: string }[]>`
  SELECT count(*) AS n FROM unit_type_approvals WHERE unit_type_id = ${twoId}`;
check("and no approval row was rewritten to do it", Number(appendOnly.n), 1);

// ---------------------------------------------------------------------------
console.log("\na picture belongs to a configuration");

const png = (() => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 90)]);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

let bedroomId = "";
if (storageConfigured()) {
  const bedroom = await addAsset({
    orgId: org.id, actorUserId: admin.id, nodeId: towerA.id,
    category: "SAMPLE_FLAT", title: "Bedroom", isRender: true, capturedOn: null,
    media: { bytes: png, type: "image/png", name: "bedroom.png" },
  });
  check("a sample flat picture is filed", bedroom.ok, true);
  bedroomId = (bedroom as { assetId: string }).assetId;

  const tagged = await tagAsset({
    orgId: org.id, actorUserId: admin.id, assetId: bedroomId,
    unitTypeId: twoId, room: "Bedroom",
  });
  check("it can be pointed at the 2 BHK", tagged.ok, true);

  const library = await loadLibrary(org.id, towerA.id);
  const shown = library?.own.find((a) => a.id === bedroomId);
  check("and the library reads it back", shown?.unitLabel, "2 BHK");
  check("with the room", shown?.room, "Bedroom");

  // A configuration belongs to one tower, so an id naming another tower's is
  // the same class of bug as an invite naming another tenant's node.
  const strayUnit = await addUnitType({
    orgId: org.id, actorUserId: admin.id, nodeId: towerB.id,
    config: "3BHK", variant: null, carpetAreaSqft: 980,
    balconyAreaSqft: null, startingPrice: null,
  });
  const crossed = await tagAsset({
    orgId: org.id, actorUserId: admin.id, assetId: bedroomId,
    unitTypeId: (strayUnit as { unitTypeId: string }).unitTypeId, room: "Bedroom",
  });
  check("a configuration from another tower is refused", crossed.ok, false);
  await sql`DELETE FROM unit_types WHERE id = ${(strayUnit as { unitTypeId: string }).unitTypeId}`;

  // Nulling it would silently turn "the 2 BHK bedroom" into "some bedroom in
  // this tower", which is the confusion the table exists to end.
  const held = await removeUnitType({ orgId: org.id, actorUserId: admin.id, unitTypeId: twoId });
  check("a configuration with pictures on it cannot be removed", held.ok, false);
  check("and it says how many are in the way",
    /One picture/.test(held.message ?? ""), true);
} else {
  console.log("  SKIP  the bucket is not configured");
}

// ---------------------------------------------------------------------------
console.log("\ncopying a tower's configurations to the next one");

const copied = await copyUnitTypesTo({
  orgId: org.id, actorUserId: admin.id,
  unitTypeIds: [oneId, twoId], toNodeId: towerB.id, withAssets: true,
});
check("both go across", copied.ok && copied.copied, 2);
check("with the picture filed under one of them",
  copied.ok && copied.assets, storageConfigured() ? 1 : 0);

const bView = (await loadUnits(org.id, towerB.id))!;
check("Tower B now sells two", bView.units.length, 2);
check("the numbers came with them",
  bView.units.find((u) => u.config === "2BHK")?.carpetAreaSqft, 682);
// A price approved for Tower A is a person saying it is right for Tower A.
check("and not one of them is approved",
  bView.units.filter((u) => unitState(u, bView.approvals).approved).length, 0);
check("the lineage is recorded instead",
  bView.units.every((u) => u.copiedFrom !== null), true);

if (storageConfigured()) {
  const bLibrary = await loadLibrary(org.id, towerB.id);
  const bBedroom = bLibrary?.own.find((a) => a.room === "Bedroom");
  check("the copied picture points at Tower B's own 2 BHK",
    bBedroom?.unitTypeId, bView.units.find((u) => u.config === "2BHK")?.id);
  const [keys] = await sql<{ n: string }[]>`
    SELECT count(DISTINCT storage_key) AS n FROM asset_versions
    WHERE org_id = ${org.id} AND asset_id IN (${bBedroom!.id}, ${bedroomId})`;
  // Two rows sharing one key means deleting either takes the other's bytes.
  check("and it has an object of its own", Number(keys.n), 2);
}

const again = await copyUnitTypesTo({
  orgId: org.id, actorUserId: admin.id,
  unitTypeIds: [oneId, twoId], toNodeId: towerB.id, withAssets: false,
});
check("copying what is already there is refused", again.ok, false);
check("naming which", again.ok ? null : again.code, "ALL_PRESENT");

const upward = await copyUnitTypesTo({
  orgId: org.id, actorUserId: admin.id,
  unitTypeIds: [oneId], toNodeId: project.id, withAssets: false,
});
check("and a project is not somewhere a configuration can land",
  upward.ok ? null : upward.code, "WRONG_LEVEL");

// ---------------------------------------------------------------------------
console.log("\nthe price has to belong to the configuration named");

const [brief] = await sql<{ id: string }[]>`
  INSERT INTO campaign_briefs (org_id, scope_node_id, name, status, objective,
                               languages, formats, cta, updated_by)
  VALUES (${org.id}, ${towerA.id}, 'Unit Check Push', 'READY', 'SITE_VISIT',
          ${["English"]}, ${["Meta feed 1:1"]}, 'Book a site visit', ${admin.id})
  RETURNING id`;

const { ground } = await studioGround(
  org.id, { id: towerA.id, path: towerA.path, kind: "PHASE" },
);
check("only approved configurations reach the gate", ground.configurations.length, 3);
check("each carrying its own price",
  ground.configurations.find((c) => c.config === "1BHK")?.startingPrice, 4_520_000);

const saying = (copy: Record<string, string>): CopyDriver => async () => ({ ok: true, copy });
const CLEAN = { headline: "Nine minutes from the metro", body: "", cta: "Book a site visit" };
const run = async (body: string) => {
  await generateBlocks({
    orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: saying({ ...CLEAN, body }),
  });
  const blocks = await listBlocks(org.id, brief.id);
  return {
    verdict: blocks[0]?.verdict,
    codes: new Set(blocks[0]?.reasons.map((r) => r.code)),
  };
};

const right = await run("2 BHK of 682 sq ft carpet, from Rs 68.2 lakh.");
check("a configuration quoted with its own price clears", right.verdict, "PASS");

// The failure this whole table exists to catch. Rs 45,20,000 is a real
// approved price on this tower, and it is the 1 BHK's.
const wrong = await run("2 BHK homes from Rs 45.2 lakh.");
check("its neighbour's price is refused", wrong.verdict, "FAIL");
check("and the refusal names whose it is", wrong.codes.has("PRICE_NOT_FOR_CONFIG"), true);

// Naming the 1 BHK makes the same number the right one to lead on, which is
// how every launch advertisement in the country is written.
const both = await run("1 & 2 BHK homes from Rs 45.2 lakh.");
check("naming both makes the cheaper price lawful", both.verdict, "PASS");

const rounded = await run("2 BHK homes from Rs 68.2 lakh.");
check("the ordinary rounding is not a different number", rounded.verdict, "PASS");

const invented = await run("4 BHK homes from Rs 68.2 lakh.");
check("a configuration nobody recorded holds rather than passing",
  invented.verdict, "HOLD");
check("and says which", invented.codes.has("CONFIG_NOT_RECORDED"), true);

// The number half of the gate has to work in every script, which is the half
// that carries Section 12.
// Words around it: a line that is only a configuration and a price is the
// picture's price line, and the gate strips it from the copy before reading.
const devanagari = await run("२ BHK homes from Rs ४५,२०,०००.");
check("a price in Devanagari numerals is read as a price",
  devanagari.codes.has("PRICE_NOT_FOR_CONFIG"), true);

// ---------------------------------------------------------------------------
console.log("\na brief narrows which configurations are in play");

await sql`UPDATE campaign_briefs SET unit_type_ids = ${[oneId]}::uuid[]
          WHERE id = ${brief.id}`;
const narrowed = await run("2 BHK homes from Rs 45.2 lakh.");
check("a brief for the 1 BHK does not measure against the 2 BHK's price",
  narrowed.codes.has("PRICE_NOT_FOR_CONFIG"), false);
check("and naming a configuration it is not for holds",
  narrowed.codes.has("CONFIG_NOT_RECORDED"), true);

// An id naming a configuration under another project is filtered by the path,
// and one naming another tenant's is invisible to RLS. Both write nothing.
const [stray] = await sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
await sql`UPDATE campaign_briefs SET unit_type_ids = ${[stray.id]}::uuid[]
          WHERE id = ${brief.id}`;
const { ground: strayGround } = await studioGround(
  org.id, { id: towerA.id, path: towerA.path, kind: "PHASE" }, new Date(), [stray.id],
);
check("an id that resolves to nothing simply drops out",
  strayGround.configurations.length, 0);

// ---------------------------------------------------------------------------
// Dropping the nodes cascades the rows and leaves the objects behind, which
// is the orphan case `removeAssetRow()` exists to avoid on the ordinary path.
// A suite is not allowed to create the thing nothing collects, so the keys are
// read before the rows go.
const objects = await sql<{ storage_key: string }[]>`
  SELECT av.storage_key FROM asset_versions av
  JOIN assets a ON a.id = av.asset_id
  JOIN scope_nodes n ON n.id = a.scope_node_id
  WHERE n.org_id = ${org.id} AND n.slug = ANY(${SLUGS})`;
for (const o of objects) await removeAsset(o.storage_key);
check("every object this suite wrote is taken back out",
  objects.length, storageConfigured() ? 2 : 0);

await dropFixtures();
const [left] = await sql<{ n: string }[]>`
  SELECT count(*) AS n FROM unit_types WHERE scope_node_id IN
    (SELECT id FROM scope_nodes WHERE slug = ANY(${SLUGS}))`;
check("the fixtures are gone", Number(left.n), 0);

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end();
await closeDb();
process.exit(fail ? 1 : 0);
