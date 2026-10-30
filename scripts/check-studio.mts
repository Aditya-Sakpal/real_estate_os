// Functional check of Campaign Studio, against the real database and the real
// bucket, with the models replaced by injected drivers.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-studio.mts
//
// The model is injected rather than called. A suite that asks a real model for
// copy asserts nothing repeatable: the interesting cases here are what happens
// when the copy comes back with a banned phrase, an invented price or a yield
// nobody signed, and waiting for a model to eventually produce one of those is
// not a test, it is a hope. The gate is what this suite is about, and the gate
// never cared where the sentences came from.
//
// The bucket is real, the way `check:assets` uses the real bucket: a storage
// layer nobody tests against the real store is one that breaks in production.
// Every object it writes is removed.
//
// The suite builds its own entity, project and phase and drops them at the end.
// It never touches the organisation's own projects, briefs or Brains.
import { existsSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import postgres from "postgres";
import {
  addBackdrop,
  generateBlocks,
  instructionFor,
  listBackdrops,
  listBlocks,
  openStudio,
  removeBackdrop,
  studioGround,
} from "../src/lib/creative.ts";
import { LANGUAGES } from "../src/lib/campaign-rules.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { readAsset, storageConfigured } from "../src/lib/storage.ts";
import type { CopyDriver, ImageDriver, ReadDriver } from "../src/lib/generate.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
/**
 * Compares, rather than asking whether the answer is truthy.
 *
 * This suite was written with a truthy-only helper first, and "one language
 * times four buyers is four blocks" passed because four is truthy: it would
 * have passed for forty. An assertion that cannot fail is worse than no
 * assertion, because it is counted.
 */
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

// Its own subtree, dropped at both ends, so a developer's own campaigns are
// never in reach of this suite.
const SLUGS = ["studio_entity", "studio_project", "studio_phase"];
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
const entity = await node(root.id, "ENTITY", "Studio Check SPV", "studio_entity",
  `${root.path}.studio_entity`);
const project = await node(entity.id, "PROJECT", "Studio Check Project", "studio_project",
  `${entity.path}.studio_project`);
const phase = await node(project.id, "PHASE", "Studio Check Tower", "studio_phase",
  `${project.path}.studio_phase`);

// A registration that is comfortably in date, so the expiry hold is something
// the suite turns on deliberately rather than something it trips over.
const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no,
                                    state_code, promoter_name, valid_to, verified_at)
  VALUES (${phase.id}, ${org.id}, 'VERIFIED', 'P51700099999', 'MH',
          'Studio Check SPV', ${FAR}, now())`;

// A published Brain, because a draft one is invisible and the gate would have
// nothing to measure against.
// Written as a draft and then published, because a published version refuses
// a field write by trigger. That refusal is the whole guarantee and this suite
// is not allowed an exception to it either.
const [version] = await sql<{ id: string }[]>`
  INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
  VALUES (${org.id}, ${project.id}, 1, 'DRAFT', ${admin.id})
  RETURNING id`;
const FACTS: [string, string][] = [
  ["claims.talking_points", "Nine minutes from the metro\nThree sided open plot"],
  ["claims.never_say", "guaranteed returns\nassured rental"],
  ["claims.possession_date", "2029-06-30"],
  ["price.booking_amount", "500000"],
];
for (const [key, value] of FACTS) {
  await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value)
            VALUES (${org.id}, ${version.id}, ${key}, ${value})`;
}

await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now()
          WHERE id = ${version.id}`;

const [brief] = await sql<{ id: string }[]>`
  INSERT INTO campaign_briefs (org_id, scope_node_id, name, status, objective,
                               languages, formats, cta, updated_by)
  VALUES (${org.id}, ${project.id}, 'Studio Check Push', 'READY', 'SITE_VISIT',
          ${["English"]}, ${["Meta feed 1:1"]}, 'Book a site visit', ${admin.id})
  RETURNING id`;

// ---------------------------------------------------------------------------
console.log("\nwhat the copy is held to");

const { ground } = await studioGround(org.id, {
  id: project.id,
  path: project.path,
  kind: "PROJECT",
});
check("the registration is resolved from the phase underneath",
  ground.registrationNo, "P51700099999");
check("and the project is advertisable because that phase is", ground.advertisable, true);
check("the signed talking points are read", ground.talkingPoints.length, 2);
check("so is the never-say list", ground.neverSay, ["guaranteed returns", "assured rental"]);
check("and the approved possession date", ground.possessionDate, "2029-06-30");
// Handed to a writer as a bare number it comes back printed as a bare number.
check("a published amount arrives labelled",
  ground.money.some((m) => m.includes("Rs 5,00,000")), true);

const view = await openStudio(org.id, brief.id);
check("the studio opens on the brief", view?.briefName, "Studio Check Push");
check("one language times four buyers is four blocks", view?.planned.filter((p) => (p.angle ?? "GENERAL") === "GENERAL").length, 4);
check("and the placement it must fit is named",
  view?.budget.bodyFrom, "Meta feed 1:1");

// Every template has a card: the studio also writes one card per language for
// each angle the project supports. The checks below are about the general
// cards, so they write and read those alone; the angle cards have their own.
const GENERAL = ["English", "Hindi"].flatMap((language) =>
  (["END_USER", "UPGRADER", "INVESTOR", "NRI"] as const).map((segment) => ({ language, segment })));
const write = (o: Parameters<typeof generateBlocks>[0]) => generateBlocks({ only: GENERAL, ...o });
const listGeneral = async (orgId: string, briefId: string) =>
  (await listBlocks(orgId, briefId)).filter((b) => b.angle === "GENERAL");

// The prompt carries only published facts.
const asked = instructionFor({
  spec: { language: "English", segment: "INVESTOR" },
  ground,
  budget: view!.budget,
  brief: { objective: null, audience: null, cta: "Book a site visit", hook: null, offers: null },
  project: "Studio Check Project",
});
check("the writer is given the approved facts",
  asked.instruction.includes("Nine minutes from the metro"), true);
check("and told what it may never say",
  asked.instruction.includes("guaranteed returns"), true);

// ---------------------------------------------------------------------------
console.log("\nthe gate runs on what came back, not on what was asked for");

/** A model that ignores every instruction it was given, which is the case. */
const saying = (copy: Record<string, string>): CopyDriver => async () => ({ ok: true, copy });

const CLEAN = {
  headline: "Nine minutes from the metro",
  body: "A three sided open plot, and a home to grow into.",
  cta: "Book a site visit",
};

await write({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: saying(CLEAN) });
let blocks = await listGeneral(org.id, brief.id);
check("a block is written for every buyer", blocks.length, 4);
check("copy that says only what was signed clears",
  blocks.map((b) => b.verdict), ["PASS", "PASS", "PASS", "PASS"]);
check("and the verdict is stored with it",
  blocks.every((b) => b.reasons.length === 0), true);

// The prompt told it not to. The prompt is not a control.
await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  driver: saying({ ...CLEAN, body: "Guaranteed returns on every unit." }),
});
blocks = await listGeneral(org.id, brief.id);
check("a banned phrase is refused however it was asked for",
  blocks.map((b) => b.verdict), ["FAIL", "FAIL", "FAIL", "FAIL"]);
check("and the refusal quotes the phrase",
  blocks[0]?.reasons.some((r) => /guaranteed returns/i.test(r.detail)), true);

await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  driver: saying({ ...CLEAN, body: "Homes from Rs 45,00,000, ready 2027." }),
});
blocks = await listGeneral(org.id, brief.id);
const codes = new Set(blocks[0]?.reasons.map((r) => r.code));
check("a price nobody published is refused", codes.has("UNGROUNDED_MONEY"), true);
check("and a possession year nobody approved with it", codes.has("POSSESSION_MISMATCH"), true);

// Rewriting replaces rather than piles up: two headlines for one buyer is two
// answers to one question and the screen would have to pick one anyway.
check("rewriting replaces the block", blocks.length, 4);

// The amount that was actually signed passes, and it passes in every spelling.
await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  driver: saying({ ...CLEAN, body: "Book at ₹5 Lakh today." }),
});
check("the published amount is not refused",
  (await listGeneral(org.id, brief.id)).every((b) => b.verdict === "PASS"), true);
// Written out in full it is still the published amount, and is sent back
// only for how it is written: no ad in the trade prints Rs 5,00,000.
await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  driver: saying({ ...CLEAN, body: "Book at Rs 5,00,000 today." }),
});
check("written out in full, it is refused for the format and nothing else",
  [...new Set((await listGeneral(org.id, brief.id)).flatMap((b) => b.reasons.map((r) => r.code)))], ["PRICE_FORMAT"]);
await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  driver: saying({ ...CLEAN, body: "Book at 5 lakh today." }),
});
check("and neither is the same amount written as lakh",
  (await listGeneral(org.id, brief.id)).every((b) => b.verdict === "PASS"), true);

// A number is a number in every script, which is the half of the gate that
// still works when the words cannot be read.
await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  driver: saying({ headline: "मेट्रो से नौ मिनट", body: "कीमत Rs ४५,००,०००।", cta: "बुक करें" }),
});
const vernacular = await listGeneral(org.id, brief.id);
check("a price in Devanagari numerals is still found",
  vernacular[0]?.reasons.some((r) => r.code === "UNGROUNDED_MONEY"), true);
check("and copy the word checks cannot read says so",
  vernacular[0]?.reasons.some((r) => r.code === "UNCHECKED_WORDING"), true);

// ---------------------------------------------------------------------------
console.log("\na Hindi card is all Hindi, and is read back before it clears");

// An image ad is all English or all Hindi (the client, 1 October 2026). A
// Hindi card is written with the approved points in Hindi too, read back
// into English by a second model, and the gate reads that reading.
//
// English only for now (the client, 9 October 2026): while Hindi is out of
// the catalog a Hindi brief is read as English and no Hindi card is written,
// so these checks run only while the catalog offers Hindi.
if (!(LANGUAGES as readonly string[]).includes("Hindi")) {
  console.log("  SKIP  Hindi is not in LANGUAGES (English only for now), so no Hindi card is written");
} else {
  await sql`UPDATE campaign_briefs SET languages = ${["Hindi"]} WHERE id = ${brief.id}`;
  // The developer's typeface sets Hindi, so the typeface is not what holds a card here.
  await sql`INSERT INTO brand_kits (scope_node_id, org_id, typeface_languages)
            VALUES (${entity.id}, ${org.id}, ${["English", "Hindi"]})`;
  const HINDI = {
    headline: "मेट्रो से 9 मिनट", body: "तीन तरफ़ से खुला प्लॉट।", cta: "साइट विज़िट बुक करें",
    place: "", points: ["मेट्रो से 9 मिनट", "तीन तरफ़ से खुला प्लॉट"],
  };
  const READ = {
    headline: "9 minutes from the metro", body: "A plot open on three sides.", cta: "Book a site visit",
    place: null, points: ["Nine minutes from the metro", "Plot open on three sides"],
  };
  let askedLocal = 0;
  let reads = 0;
  const hindiWriter: CopyDriver = async (req) => {
    if (req.local) askedLocal += 1;
    return { ok: true, copy: HINDI };
  };
  const reading = (r: typeof READ): ReadDriver => async () => {
    reads += 1;
    return { ok: true, reading: r };
  };
  await write({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: hindiWriter, reader: reading(READ) });
  const hindiBlocks = (await listGeneral(org.id, brief.id)).filter((b) => b.language === "Hindi");
  check("a Hindi card is asked for the points in Hindi too", askedLocal, 4);
  check("and is read back once a card", reads, 4);
  check("read back true, it clears", hindiBlocks.map((b) => b.verdict), ["PASS", "PASS", "PASS", "PASS"]);
  check("and keeps its points and its reading",
    [hindiBlocks[0]?.local?.points.map((p) => p.source), hindiBlocks[0]?.local?.reading?.headline],
    [["Nine minutes from the metro", "Three sided open plot"], "9 minutes from the metro"]);
  await write({
    orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: hindiWriter,
    reader: reading({ ...READ, body: "Guaranteed returns on a plot open on three sides." }),
  });
  check("a banned phrase its reading carries is refused",
    (await listGeneral(org.id, brief.id)).filter((b) => b.language === "Hindi")
      .every((b) => b.verdict === "FAIL" && b.reasons.some((r) => r.code === "NEVER_SAY")), true);
  reads = 0;
  await write({
    orgId: org.id, actorUserId: admin.id, briefId: brief.id,
    driver: saying({ ...HINDI, headline: "मेट्रो से 9 मिनट, 2 BHK" } as never), reader: reading(READ),
  });
  check("an English word in a Hindi card is sent back, three times at most",
    [(await listGeneral(org.id, brief.id)).filter((b) => b.language === "Hindi")
      .every((b) => b.reasons.some((r) => r.code === "MIXED_SCRIPT")), reads], [true, 12]);
  await sql`DELETE FROM campaign_copy WHERE brief_id = ${brief.id} AND language = 'Hindi'`;
  await sql`UPDATE campaign_briefs SET languages = ${["English"]} WHERE id = ${brief.id}`;
}

// ---------------------------------------------------------------------------
console.log("\na phase nobody may advertise has nothing to write");

await sql`UPDATE registration_records SET status = 'BLOCKED', registration_no = NULL,
          valid_to = NULL WHERE scope_node_id = ${phase.id}`;
const refused = await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: saying(CLEAN),
});
check("generation is refused outright", refused.ok, false);
check("and it says why",
  refused.ok ? null : refused.code, "NOT_ADVERTISABLE");
// The blocks written while it was advertisable are left alone: a lapse is a
// reason to stop publishing, not to destroy the record of what was cleared.
check("what was already written is left where it is",
  (await listGeneral(org.id, brief.id)).length, 4);
await sql`UPDATE registration_records SET status = 'VERIFIED',
          registration_no = 'P51700099999', valid_to = ${FAR}
          WHERE scope_node_id = ${phase.id}`;

// ---------------------------------------------------------------------------
console.log("\nwhat a model may draw");

// A real PNG with valid chunk CRCs, because a hand-typed literal carries bad
// ones and the bucket would be storing something no browser could decode.
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 120)]);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

let sent = "";
const drawing: ImageDriver = async (req) => {
  sent = req.prompt;
  return { ok: true, bytes: png, type: "image/png" };
};

const drawn = await addBackdrop({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  role: "BACKDROP", prompt: "warm evening light into amber", driver: drawing,
});
check("a backdrop is drawn and kept", drawn.ok, true);
check("and the exclusions ride on the prompt every driver is handed",
  /no buildings/i.test(sent), true);

const kept = await listBackdrops(org.id, brief.id);
check("it comes back on the brief", kept.length, 1);
check("carrying what was asked for, not what was sent",
  kept[0]?.prompt, "warm evening light into amber");

// The row holds a key and the bucket holds the bytes, the same bargain every
// stored object gets.
const [stored] = await sql<{ storage_key: string; sha256: string }[]>`
  SELECT storage_key, sha256 FROM generated_media WHERE id = ${(drawn as { id: string }).id}`;
// A file lives in its project's folder (4 October 2026).
check("the row holds a key, never a URL",
  stored.storage_key, `org/${org.id}/project/${project.id}/backdrop/${(drawn as { id: string }).id}`);
if (storageConfigured()) {
  const bytes = await readAsset(stored.storage_key);
  check("and the bucket holds the bytes", bytes?.equals(png), true);
}

// The Approved Asset Library exists because every pixel of the building traces
// to a file a named human approved. A model drawing the tower ends that.
const tower = await addBackdrop({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  role: "BACKDROP", prompt: "a glass tower at dusk", driver: drawing,
});
check("a prompt asking for the building is refused", tower.ok, false);
check("before the model is ever called",
  tower.ok ? null : tower.code, "DEPICTS_PROPERTY");
check("and nothing was stored", (await listBackdrops(org.id, brief.id)).length, 1);

const hero = await addBackdrop({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  role: "HERO", prompt: "soft light", driver: drawing,
});
check("a role nobody ships is refused too", hero.ok, false);

// Removing takes the object out with the row.
await removeBackdrop({ orgId: org.id, actorUserId: admin.id, id: (drawn as { id: string }).id });
check("removing takes the row", (await listBackdrops(org.id, brief.id)).length, 0);
if (storageConfigured()) {
  check("and the object with it", (await readAsset(stored.storage_key)) === null, true);
}

// ---------------------------------------------------------------------------
// The client was asked to press "write it again" until the model got it
// right. That is our job: a card refused for the model's own mistake is
// rewritten with the refusal spelled out, before anybody sees it.
console.log("\nthe model's mistakes are corrected before anybody sees them");

// Wrong first, right when told what was wrong.
let tries = 0;
let told = "";
const learns: CopyDriver = async (req) => {
  tries += 1;
  if (req.instruction.includes("Your last attempt was refused")) {
    told = req.instruction;
    return { ok: true, copy: CLEAN };
  }
  return { ok: true, copy: { ...CLEAN, body: "Guaranteed returns on every unit." } };
};
const healed = await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: learns,
});
check("every card clears after one correction",
  healed.ok ? [healed.passed, healed.failed] : null, [4, 0]);
check("each card took exactly two attempts", tries, 8);
check("and the second attempt was told what was wrong with the first",
  told.includes("guaranteed returns"), true);

// Never right. It stops at three, and the card says why.
tries = 0;
const stubborn: CopyDriver = async () => {
  tries += 1;
  return { ok: true, copy: { ...CLEAN, body: "Guaranteed returns on every unit." } };
};
await write({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: stubborn });
check("a model that never gets it right is stopped at three attempts a card", tries, 12);
check("and the card keeps its reason",
  (await listGeneral(org.id, brief.id)).every((b) =>
    b.verdict === "FAIL" && b.reasons.some((r) => r.code === "NEVER_SAY")), true);

// A dropped call is an attempt too, and the next one can still land.
// Per card, not a shared counter: four cards are written at once, and a
// counter shared between them hands one card three failures in a row.
const dropped = new Set<string>();
const flaky: CopyDriver = async (req) => {
  const buyer = /Buyer: (.*)/.exec(req.instruction)?.[1] ?? "";
  if (!dropped.has(buyer)) {
    dropped.add(buyer);
    return { ok: false, code: "UNREACHABLE", message: "" };
  }
  return { ok: true, copy: CLEAN };
};
const survived = await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: flaky,
});
check("a call that did not come back is retried rather than leaving the card out",
  survived.ok ? survived.written : null, 4);

// Out of credits, every call after the first is refused the same way. The run
// stops and says so in words for the person, not the provider's billing page.
let billed = 0;
const broke: CopyDriver = async () => {
  billed++;
  return { ok: false, code: "OUT_OF_CREDITS", message: "AI generation is paused because our usage limit has been reached. Please try again later." };
};
const paused = await write({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: broke });
check("a service out of credits ends the run with its own reason",
  [paused.ok ? null : paused.code, paused.ok ? null : paused.message.includes("usage limit")], ["OUT_OF_CREDITS", true]);
check("after one refusal per card in flight, not three for every card", billed <= 4, true);

// One card, and only that card.
const before = new Map((await listGeneral(org.id, brief.id)).map((b) => [b.segment, b.generatedAt]));
await new Promise((r) => setTimeout(r, 20));
const one = await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: saying(CLEAN),
  only: [{ language: "English", segment: "INVESTOR" }],
});
const after = await listGeneral(org.id, brief.id);
check("rewriting one card writes one card", one.ok ? one.written : null, 1);
check("that card is new",
  after.find((b) => b.segment === "INVESTOR")?.generatedAt !== before.get("INVESTOR"), true);
check("and the other three are untouched",
  after.filter((b) => b.segment !== "INVESTOR").every((b) => b.generatedAt === before.get(b.segment)),
  true);
check("a card the brief no longer asks for is not written",
  (await write({
    orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: saying(CLEAN),
    only: [{ language: "Tamil", segment: "INVESTOR" }],
  })).ok, false);

// The writer is never told to lead with a hook nobody approved.
await sql`UPDATE campaign_briefs SET hook = 'Metro and connectivity' WHERE id = ${brief.id}`;
let asked2 = "";
await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  driver: async (req) => { asked2 = req.instruction; return { ok: true, copy: CLEAN }; },
  only: [{ language: "English", segment: "NRI" }],
});
check("an unapproved hook is not passed to the writer", asked2.includes("Metro"), false);
// With something learnt in the organisation (the fixture project inherits the
// organisation's scores), the writer is told which approved fact to lead with;
// without, to lead with one of them. Either way it is an approved fact.
check("which leads on the approved facts instead",
  asked2.includes("Lead the headline with one of the approved facts") ||
    ground.talkingPoints.some((p) => asked2.includes(`Lead with: ${p}`)), true);
await sql`UPDATE campaign_briefs SET hook = NULL WHERE id = ${brief.id}`;

// ---------------------------------------------------------------------------
// A run could not be stopped: the button said "Writing" and offered no way
// out, so a wrong hook noticed ten seconds in was paid for in full.
console.log("\nwriting can be stopped, and cannot run twice");

// The first block answers at once and the rest take long enough to be
// stopped, so the stop has something written to keep and something in flight
// to abort. The driver honours the signal the way the real one does.
let calls = 0;
let aborted = 0;
const slow: CopyDriver = (_req, o) =>
  new Promise((resolve) => {
    calls += 1;
    if (calls === 1) return resolve({ ok: true, copy: CLEAN });
    const t = setTimeout(() => resolve({ ok: true, copy: CLEAN }), 8000);
    o?.signal?.addEventListener("abort", () => {
      clearTimeout(t);
      aborted += 1;
      resolve({ ok: false, code: "STOPPED", message: "" });
    });
  });

const running = write({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: slow });
// Wait for the run to exist rather than for a number of milliseconds.
for (let i = 0; i < 50; i++) {
  const [live] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM copy_runs WHERE brief_id = ${brief.id} AND finished_at IS NULL`;
  if (live.n) break;
  await new Promise((r) => setTimeout(r, 100));
}

const twice = await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: saying(CLEAN),
});
check("a second run on the same brief is refused while one is live",
  twice.ok ? null : twice.code, "ALREADY_WRITING");

const { stopCopyRun } = await import("../src/lib/creative.ts");
check("the stop is taken", (await stopCopyRun({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
})).ok, true);

const started = Date.now();
const stoppedRun = await running;
check("the run returns long before its slow blocks would have",
  Date.now() - started < 6000, true);
check("and says it was stopped", stoppedRun.ok ? stoppedRun.stopped : null, true);
check("keeping the block that was already written", stoppedRun.ok ? stoppedRun.written : null, 1);
check("the calls in flight were aborted, not waited for", aborted > 0, true);

// A run whose server died leaves a live row behind. It must not lock the
// brief forever.
await sql`INSERT INTO copy_runs (org_id, brief_id, started_at)
          VALUES (${org.id}, ${brief.id}, now() - interval '40 minutes')`;
const afterDead = await write({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, driver: saying(CLEAN),
});
check("a run left behind by a dead server does not lock the brief", afterDead.ok, true);
check("and a stop with nothing running is not an error",
  (await stopCopyRun({ orgId: org.id, actorUserId: admin.id, briefId: brief.id })).ok, false);

// ---------------------------------------------------------------------------
console.log("\nevery template has a card: one per angle the project supports");

const askedFor: string[] = [];
await generateBlocks({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  driver: async (req) => { askedFor.push(req.instruction); return { ok: true, copy: CLEAN }; },
});
const allCards = await listBlocks(org.id, brief.id);
const anglesNow = new Set<string>(allCards.map((b) => b.angle));
check("beside the general cards, a card for the location, a site visit, a festival greeting and the NRI buyer",
  ["GENERAL", "LOCATION", "VISIT", "GREETING", "NRI"].filter((a) => !anglesNow.has(a)), []);
check("and none for what the project cannot show: no dated site photo, no possession yet",
  [anglesNow.has("CONSTRUCTION"), anglesNow.has("POSSESSION")], [false, false]);
check("the NRI card is written for the NRI buyer", allCards.find((b) => b.angle === "NRI")?.segment, "NRI");
check("the greeting card is told it sells nothing, and is not handed the campaign's call to buy",
  askedFor.some((i) => i.includes("festival greeting") && !i.includes("Call to action: Book a site visit")), true);
check("given copy that sells anyway, the greeting is refused for it",
  allCards.find((b) => b.angle === "GREETING")?.reasons.some((r) => r.code === "OFF_ANGLE"), true);
check("the location card is told the approved fact to lead on",
  askedFor.some((i) => i.includes("location ad") && i.includes("Nine minutes from the metro")), true);

// ---------------------------------------------------------------------------
console.log("\nanother tenant's brief is not a brief");

const [other] = await sql<{ id: string }[]>`
  SELECT id FROM orgs WHERE id <> ${org.id} LIMIT 1`;
if (other) {
  check("it does not open", (await openStudio(other.id, brief.id)) === null, true);
  check("and generating against it is refused",
    (await write({
      orgId: other.id, actorUserId: admin.id, briefId: brief.id, driver: saying(CLEAN),
    })).ok, false);
}
// ---------------------------------------------------------------------------
console.log("\none press puts an approved point in the hook");

const { setBriefHook } = await import("../src/lib/campaign.ts");
const swapped = await setBriefHook({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, hook: "Nine minutes from the metro",
});
check("the hook is changed", swapped.ok, true);
const [afterHook] = await sql<{ hook: string | null; name: string; cta: string | null }[]>`
  SELECT hook, name, cta FROM campaign_briefs WHERE id = ${brief.id}`;
check("to the point that was chosen", afterHook.hook, "Nine minutes from the metro");
check("and nothing else on the brief moves",
  [afterHook.name, afterHook.cta], ["Studio Check Push", "Book a site visit"]);
if (other) {
  check("another tenant's brief cannot have its hook changed",
    (await setBriefHook({ orgId: other.id, actorUserId: admin.id, briefId: brief.id, hook: "x" })).ok,
    false);
}

check("a malformed brief id is refused before the query",
  (await openStudio(org.id, "not-a-uuid")) === null, true);

// ---------------------------------------------------------------------------
// The fixture subtree goes and the brief, the Brain and the copy go with it:
// all of them are ON DELETE CASCADE from scope_nodes. The audit rows are
// scoped to the fixture rather than to the action, because `creative.%` would
// take the developer's own history with it.
await sql`DELETE FROM audit_log
          WHERE org_id = ${org.id} AND action LIKE 'creative.%'
            AND target_id = ANY(${[brief.id, (drawn as { id?: string }).id ?? brief.id]})`;
await dropFixtures();
await sql.end();
await closeDb();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
