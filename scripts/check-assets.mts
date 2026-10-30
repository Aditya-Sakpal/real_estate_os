// Functional check of the Approved Asset Library, driven through the real
// console and the real bucket.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-assets.mts
//
// This one talks to S3 rather than a fixture, which is a deliberate exception
// to how `check:rera` works. That suite reads a government server, so it is
// rude and slow to ask it on every run. This is our own bucket, it costs
// fractions of a cent, and storage is the riskiest new thing here: a layer
// nobody tests against the real store is a layer that breaks in production.
// Every object it writes is removed before it exits.
//
// It builds its own project and phase and touches nothing that was here.
// A failure part way still closes the browser, removes what it wrote and
// ends the process: an open pool or browser once held a failed run for 25
// minutes.
import { encode } from "next-auth/jwt";
import puppeteer, { type Browser } from "puppeteer-core";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import postgres from "postgres";
import {
  addAsset,
  approveAsset,
  assetLink,
  approvedAssets,
  loadLibrary,
  removeAssetRow,
  replaceAsset,
  listVersions,
  copyAssetsTo,
} from "../src/lib/asset.ts";
import { readAsset, removeAsset, storage } from "../src/lib/storage.ts";
import { closeDb } from "../src/lib/db/index.ts";

// The whole run takes about two minutes. Past ten something is stuck, and
// waiting longer only hides it. Unref'd, so it never keeps a finished run alive.
setTimeout(() => {
  console.error("\ncheck:assets took over 10 minutes; cleaning up and stopping");
  setTimeout(() => process.exit(1), 60_000).unref();
  void cleanup().finally(() => process.exit(1));
}, 10 * 60_000).unref();

const BASE = process.env.AUTH_URL ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";
const CHROME = [
  process.env.CHROME_PATH ?? "", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const APPROVER = "asset-approver@example-tenant.test";
const UPLOADER = "asset-uploader@example-tenant.test";
const SEEDED = [APPROVER, UPLOADER];
const wipeUsers = async () => {
  await sql`DELETE FROM memberships m USING users u
            WHERE m.user_id = u.id AND u.email = ANY(${SEEDED})`;
  await sql`DELETE FROM users WHERE email = ANY(${SEEDED})`;
};
await wipeUsers();

const [admin] = await sql<{ id: string; email: string; name: string | null }[]>`
  SELECT id, email::text AS email, name FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string }[]>`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY m.created_at
  LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");

type Node = { id: string; name: string; kind: string; path: string };
const [root] = await sql<Node[]>`
  SELECT id, name, kind, path::text AS path FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'ORG'`;
const [region] = await sql<Node[]>`
  SELECT id, name, kind, path::text AS path FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'REGION' ORDER BY path LIMIT 1`;
if (!root || !region) throw new Error("No root and region to hang the fixtures off");

const FIXTURE_SLUGS = ["asset_check_project", "asset_check_phase"];
const dropFixtures = async () => {
  await sql`DELETE FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${FIXTURE_SLUGS})`;
};
await dropFixtures();

// Everything the run made, so a failure part way can still take it back out.
let browser: Browser | null = null;
let sampleFile = "";
const assetIds = new Set<string>();
const track = (o: { ok: boolean; assetId?: string }) => {
  if (o.ok && o.assetId) assetIds.add(o.assetId);
};

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const step = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      console.error(`  cleanup: ${what} failed: ${(e as Error).message}`);
    }
  };
  await step("close the browser", async () => browser?.close());
  if (sampleFile) rmSync(sampleFile, { force: true });
  // Every object this run wrote, gone from the bucket as well as the
  // database, its lighter copies included. Only keys of rows on this run's
  // own nodes, so nothing another row points at is touched.
  await step("remove the objects", async () => {
    const rows = await sql<{ asset_id: string; storage_key: string }[]>`
      SELECT av.asset_id, av.storage_key FROM asset_versions av
      JOIN assets a ON a.id = av.asset_id
      JOIN scope_nodes n ON n.id = a.scope_node_id
      WHERE av.org_id = ${org.id} AND n.org_id = ${org.id} AND n.slug = ANY(${FIXTURE_SLUGS})`;
    for (const r of rows) {
      assetIds.add(r.asset_id);
      await removeAsset(r.storage_key);
    }
  });
  await step("remove the audit rows", async () => {
    const nodes = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${FIXTURE_SLUGS})`;
    const targets = [...nodes.map((n) => n.id), ...assetIds];
    if (targets.length) {
      await sql`DELETE FROM audit_log
                WHERE org_id = ${org.id} AND action LIKE 'asset.%'
                  AND target_id = ANY(${targets})`;
    }
  });
  await step("drop the fixtures", dropFixtures);
  await step("drop the roles", () => sql`DELETE FROM org_roles WHERE org_id = ${org.id}
          AND key = ANY(${["C_ASSET_APPROVER", "C_ASSET_UPLOADER"]})`);
  await step("drop the users", wipeUsers);
  await step("close the pool", () => sql.end({ timeout: 5 }));
  await step("close the app pool", closeDb);
}

try {
const [project] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${region.id}, 'PROJECT', 'Asset Check Project', 'asset_check_project',
          ${`${region.path}.asset_check_project`}::ltree)
  RETURNING id, name, kind, path::text AS path`;
const [phase] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Asset Check Phase', 'asset_check_phase',
          ${`${region.path}.asset_check_project.asset_check_phase`}::ltree)
  RETURNING id, name, kind, path::text AS path`;

// Real PNGs with valid chunk CRCs. A hand-typed base64 literal carries bad
// ones, which a browser refuses to decode.
const png = (shade: number) => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(48, shade)]);
  const raw = Buffer.concat(Array.from({ length: 16 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

// ---------------------------------------------------------------------------
console.log(`\nfiling assets (store: ${storage().name})`);

const sitePlan = await addAsset({
  orgId: org.id, actorUserId: admin.id, nodeId: project.id, category: "SITE_PLAN",
  title: "Nine towers on 12 acres", isRender: true, capturedOn: null,
  media: { bytes: png(120), type: "image/png", name: "site.png" },
});
track(sitePlan);
check("a site plan is filed on the project", sitePlan.ok === true,
  (sitePlan as { message?: string }).message);

const floorPlan = await addAsset({
  orgId: org.id, actorUserId: admin.id, nodeId: phase.id, category: "FLOOR_PLAN",
  title: "3 BHK", isRender: true, capturedOn: null,
  media: { bytes: png(60), type: "image/png", name: "floor.png" },
});
track(floorPlan);
check("a floor plan is filed on the phase", floorPlan.ok === true,
  (floorPlan as { message?: string }).message);

// Filing either at the wrong level is not untidiness, it is the wrong building.
const wrongLevel = await addAsset({
  orgId: org.id, actorUserId: admin.id, nodeId: phase.id, category: "SITE_PLAN",
  title: "Wrong", isRender: true, capturedOn: null,
  media: { bytes: png(10), type: "image/png", name: "x.png" },
});
check("a site plan on a phase is refused", wrongLevel.ok === false);
const lockupUp = await addAsset({
  orgId: org.id, actorUserId: admin.id, nodeId: project.id, category: "RERA_LOCKUP",
  title: "Wrong", isRender: true, capturedOn: null,
  media: { bytes: png(10), type: "image/png", name: "x.png" },
});
check("a RERA lockup on a project is refused", lockupUp.ok === false);
check("and says it belongs to one registration",
  /one registration/i.test((lockupUp as { message: string }).message ?? ""),
  (lockupUp as { message: string }).message);

// A progress photo of an unknown day is the one thing it must never be.
const undated = await addAsset({
  orgId: org.id, actorUserId: admin.id, nodeId: phase.id, category: "CONSTRUCTION",
  title: "Slab", isRender: false, capturedOn: null,
  media: { bytes: png(30), type: "image/png", name: "p.png" },
});
check("a construction photo with no date is refused", undated.ok === false);

check("a PDF is not an asset", (await addAsset({
  orgId: org.id, actorUserId: admin.id, nodeId: project.id, category: "AMENITY",
  title: null, isRender: true, capturedOn: null,
  media: { bytes: Buffer.alloc(64), type: "application/pdf", name: "deck.pdf" },
})).ok === false);
check("and neither is an SVG", (await addAsset({
  orgId: org.id, actorUserId: admin.id, nodeId: project.id, category: "AMENITY",
  title: null, isRender: true, capturedOn: null,
  media: { bytes: Buffer.from("<svg/>"), type: "image/svg+xml", name: "x.svg" },
})).ok === false);

// ---------------------------------------------------------------------------
console.log("\nthe bytes are in the bucket, not the row");

if (!sitePlan.ok || !floorPlan.ok) throw new Error("could not seed the library");

// The bytes live on the version now, not on the asset: an asset is a thing
// with a history rather than a file.
const [stored] = await sql<{ storage_key: string; sha256: string; media_bytes: string }[]>`
  SELECT storage_key, sha256, media_bytes FROM asset_versions
  WHERE asset_id = ${sitePlan.assetId} ORDER BY version DESC LIMIT 1`;
check("the row holds a key in its project's folder, never a URL",
  stored.storage_key.startsWith(`org/${org.id}/project/${project.id}/asset/`) && !stored.storage_key.includes("://"),
  stored.storage_key);
check("and the key carries the tenant as its prefix",
  stored.storage_key.split("/")[1] === org.id, stored.storage_key);

const bytes = await readAsset(stored.storage_key);
check("the object is in the store", bytes?.equals(png(120)) === true,
  `${bytes?.byteLength} of ${png(120).byteLength}`);
check("and the row records what was stored",
  Number(stored.media_bytes) === png(120).byteLength, stored.media_bytes);

// The orphan sweep reads the store by listing it, so the listing is asserted
// against the real store too: the fixture suite only ever sees a folder.
const listed = (await storage().list?.(`org/${org.id}/project/${project.id}/asset/`)) ?? [];
const mine = listed.find((o) => o.key === stored.storage_key);
check("the store lists the object under its tenant's prefix, with its size",
  mine?.bytes === png(120).byteLength, `${listed.length} listed, ${mine?.bytes ?? "not found"}`);
check("and its age", !!mine && Date.now() - mine.modified.getTime() < 3_600_000, String(mine?.modified));
check("the tenant's folder is listed",
  ((await storage().folders?.("org/")) ?? []).includes(`org/${org.id}/`));

const link = await assetLink(org.id, sitePlan.assetId);
check("a link is signed for it", !!link?.url);
if (link?.url.startsWith("http")) {
  const r = await fetch(link.url);
  check("and it serves the file", r.status === 200, String(r.status));
  check("as the type it was stored as", r.headers.get("content-type") === "image/png",
    String(r.headers.get("content-type")));
  // The bucket is private. Without the signature there is nothing to fetch.
  check("the same object without the signature is refused",
    (await fetch(link.url.split("?")[0])).status === 403);
}

check("an asset id naming nothing signs no link",
  (await assetLink(org.id, "00000000-0000-0000-0000-000000000000")) === null);
check("and a malformed one is refused before the query",
  (await assetLink(org.id, "not-a-uuid")) === null);

// ---------------------------------------------------------------------------
console.log("\nno approval, no render");

check("nothing is available to build from yet",
  (await approvedAssets(org.id, phase.id)).length === 0);

await approveAsset({ orgId: org.id, actorUserId: admin.id, assetId: sitePlan.assetId });
const afterOne = await approvedAssets(org.id, phase.id);
check("an approved asset becomes available", afterOne.length === 1, `${afterOne.length}`);
check("and it is the one that was approved", afterOne[0]?.id === sitePlan.assetId);

const [ap] = await sql<{ sha256: string; approved_by: string }[]>`
  SELECT sha256, approved_by FROM asset_approvals WHERE asset_id = ${sitePlan.assetId}`;
check("the approval pins the bytes, not the asset", ap?.sha256 === stored.sha256, ap?.sha256);
check("and records who gave it", ap?.approved_by === admin.id);

// Append only, in the database and not by convention.
let edited = false;
try {
  await sql.begin(async (tx) => {
    await tx`UPDATE asset_approvals SET sha256 = repeat('f', 64)
             WHERE asset_id = ${sitePlan.assetId}`;
  });
  edited = true;
} catch {
  edited = false;
}
check("an approval cannot be edited afterwards", !edited);

// Replace the file and the approval is left behind. This is the whole of
// "every pixel traces to an approval".
const v2 = await replaceAsset({
  orgId: org.id, actorUserId: admin.id, assetId: sitePlan.assetId,
  media: { bytes: png(200), type: "image/png", name: "site-v2.png" },
});
check("a new version can be put behind an asset", v2.ok === true,
  (v2 as { message?: string }).message);
check("changing the file drops it out of what may be built from",
  (await approvedAssets(org.id, phase.id)).length === 0);
// The old version stays, with its approval attached, so what the approver
// actually saw is still answerable.
const history = await listVersions(org.id, sitePlan.assetId);
check("and the version it replaced is still there", history.length === 2, `${history.length}`);
check("newest first", history[0]?.version === 2 && history[1]?.version === 1,
  history.map((h) => h.version).join(","));
check("the old bytes are still in the store",
  (await readAsset(stored.storage_key))?.equals(png(120)) === true);
const swapped = await loadLibrary(org.id, phase.id);
const swappedRow = swapped?.resolved.find((a) => a.id === sitePlan.assetId);
check("and the screen says it changed rather than was never approved",
  swappedRow ? swapped!.approvals.some((x) => x.assetId === swappedRow.id) : false, "no approval row");
// Rolling back is another version, and its hash is the one that was
// approved, so the original approval applies again. The same behaviour the
// Brain's signatures have when a group's values are put back.
await replaceAsset({
  orgId: org.id, actorUserId: admin.id, assetId: sitePlan.assetId,
  media: { bytes: png(120), type: "image/png", name: "site-v3.png" },
});
check("putting the bytes back restores the approval",
  (await approvedAssets(org.id, phase.id)).length === 1);

// ---------------------------------------------------------------------------
console.log("\na library is a union down the tree");

const atPhase = await loadLibrary(org.id, phase.id);
const ids = atPhase?.resolved.map((a) => a.category) ?? [];
check("the tower keeps its own floor plan", ids.includes("FLOOR_PLAN"), ids.join(","));
// The one place this differs from the Brain: its own asset must not hide the
// project's.
check("and still sees the project's site plan", ids.includes("SITE_PLAN"), ids.join(","));
check("the most specific comes first", atPhase?.resolved[0]?.category === "FLOOR_PLAN",
  atPhase?.resolved[0]?.category);

const atProject = await loadLibrary(org.id, project.id);
check("the project does not see down into the tower",
  atProject?.resolved.some((a) => a.category === "FLOOR_PLAN") === false);

// A file on disk, because a browser file picker takes a path rather than
// bytes. Written into this run's temp and removed with it.
sampleFile = join(tmpdir(), `salesdesk-check-${process.pid}.png`);
writeFileSync(sampleFile, png(180));

// ---------------------------------------------------------------------------
console.log("\ncopying, so nothing is uploaded twice");

const amenity = await addAsset({
  orgId: org.id, actorUserId: admin.id, nodeId: project.id, category: "AMENITY",
  title: "Clubhouse", isRender: true, capturedOn: null,
  media: { bytes: png(90), type: "image/png", name: "club.png" },
});
track(amenity);
if (!amenity.ok) throw new Error("could not seed the asset to copy");
await approveAsset({ orgId: org.id, actorUserId: admin.id, assetId: amenity.assetId });

const copied = await copyAssetsTo({
  orgId: org.id, actorUserId: admin.id,
  assetIds: [amenity.assetId], toNodeId: phase.id,
});
check("an asset copies to another node", copied.ok === true,
  (copied as { message?: string }).message);

const atTowerNow = await loadLibrary(org.id, phase.id);
const theCopy = atTowerNow?.own.find((a) => a.category === "AMENITY");
check("and lands as that node's own", !!theCopy);
check("carrying the same bytes", theCopy?.sha256 === (await listVersions(org.id, amenity.assetId))[0].sha256,
  theCopy?.sha256);
check("as version 1 of something new", theCopy?.version === 1 && theCopy?.id !== amenity.assetId);

// THE rule. A clubhouse render approved for one project is not thereby
// approved for another project's clubhouse, and an approval that survived a
// copy would make "every pixel traces to a named human who approved it here"
// false the first time anybody copied anything.
check("the approval does not come with it",
  (await approvedAssets(org.id, phase.id)).some((a) => a.id === theCopy?.id) === false);
check("but where it came from is recorded", theCopy?.copiedFrom === amenity.assetId,
  String(theCopy?.copiedFrom));

// Two rows never share one object: deleting either would take the other's
// bytes, and ref-counting that is a bug waiting to be written.
const originalKey = (await sql<{ storage_key: string }[]>`
  SELECT storage_key FROM asset_versions WHERE asset_id = ${amenity.assetId}`)[0].storage_key;
const copyKey = (await sql<{ storage_key: string }[]>`
  SELECT storage_key FROM asset_versions WHERE asset_id = ${theCopy!.id}`)[0].storage_key;
check("the copy has an object of its own", originalKey !== copyKey);
await removeAssetRow({ orgId: org.id, actorUserId: admin.id, assetId: amenity.assetId });
check("so removing the original leaves the copy readable",
  (await readAsset(copyKey)) !== null);

// The level rule is about what a category means, not about the file: a site
// plan is one per project, and a copy of one onto a tower is still wrong.
const wrongWay = await copyAssetsTo({
  orgId: org.id, actorUserId: admin.id,
  assetIds: [floorPlan.assetId], toNodeId: project.id,
});
check("a floor plan cannot be copied up to the project", wrongWay.ok === false);
check("and the refusal names the asset and the place",
  /cannot go on/i.test((wrongWay as { message: string }).message ?? ""),
  (wrongWay as { message: string }).message);

check("copying onto the node it already sits on is refused",
  (await copyAssetsTo({
    orgId: org.id, actorUserId: admin.id,
    assetIds: [floorPlan.assetId], toNodeId: phase.id,
  })).ok === false);
check("and copying nothing is refused",
  (await copyAssetsTo({
    orgId: org.id, actorUserId: admin.id, assetIds: [], toNodeId: phase.id,
  })).ok === false);
check("an asset id from nowhere copies nothing",
  (await copyAssetsTo({
    orgId: org.id, actorUserId: admin.id,
    assetIds: ["00000000-0000-0000-0000-000000000000"], toNodeId: phase.id,
  })).ok === false);

// ---------------------------------------------------------------------------
console.log("\nuploading is not approving");

// Two roles, because the split is the point and the founding admin holds
// `*`, which makes it the wrong subject to prove a separation with.
const seedRole = async (key: string, label: string, perms: string[], email: string, name: string) => {
  await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = ${key}`;
  await sql`
    INSERT INTO org_roles (org_id, key, label, description, min_kind, can_delegate,
                           source, permissions)
    VALUES (${org.id}, ${key}, ${label}, ${label}, 'ORG', false, 'CUSTOM', ${perms})`;
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name)
    VALUES (${email}, 'example-tenant.test', ${name}) RETURNING id`;
  await sql`
    INSERT INTO memberships (user_id, org_id, scope_node_id, role, status)
    VALUES (${u.id}, ${org.id}, ${root.id}, ${key}, 'ACTIVE')`;
  return u;
};

const approver = await seedRole(
  "C_ASSET_APPROVER", "Asset approver",
  ["asset:read", "asset:approve", "member:read"], APPROVER, "Asset Approver",
);
const uploader = await seedRole(
  "C_ASSET_UPLOADER", "Asset uploader",
  ["asset:read", "asset:manage", "member:read"], UPLOADER, "Asset Uploader",
);

browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-gpu"],
});
const openAs = async (id: string, email: string, name: string | null) => {
  const ctx = await browser!.createBrowserContext();
  const p = await ctx.newPage();
  p.setDefaultNavigationTimeout(90000);
  await p.setViewport({ width: 1440, height: 1200 });
  await p.setCookie({
    name: COOKIE,
    value: await encode({
      token: { sub: id, userId: id, email, name },
      secret: process.env.AUTH_SECRET!, salt: COOKIE, maxAge: 900,
    }),
    domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax",
  });
  // The organisation this suite seeded, not whichever one the account opens first.
  await p.setCookie({ name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" });
  return { ctx, page: p };
};

const { ctx: adminCtx, page } = await openAs(admin.id, admin.email, admin.name);
await page.goto(`${BASE}/dashboard/library/${phase.id}`, { waitUntil: "networkidle0" });
// The heading names the node, because the hub above it is what says what
// the section is.
check("the library opens on the node it is for",
  (await page.$eval("h1", (h) => h.textContent ?? "")).includes(phase.name),
  await page.$eval("h1", (h) => h.textContent ?? ""));
// The founding role holds `*`, so it is offered both. That is the admin
// working, and it is why the split below is proven with two other roles.
check("the founding admin is offered both",
  !!(await page.$("[data-add]")) && !!(await page.$("[data-approve]")));
check("the images actually decode through the signed link",
  (await page.evaluate(() =>
    [...document.querySelectorAll(".reftile__media img")]
      .every((i) => (i as HTMLImageElement).naturalWidth > 0))) === true);

// The split the whole thing exists for: whoever uploads a render must not
// thereby be able to declare it fit to advertise.
const { ctx: uploaderCtx, page: uploaderPage } = await openAs(uploader.id, UPLOADER, "Asset Uploader");
await uploaderPage.goto(`${BASE}/dashboard/library/${phase.id}`, { waitUntil: "networkidle0" });
check("an uploader is offered one upload panel", !!(await uploaderPage.$("[data-add]")));
// One picker on the page. Nine of them is how a filled-in form got lost.
check("and exactly one file picker on the page",
  (await uploaderPage.$$("input[type=file]")).length === 1,
  String((await uploaderPage.$$("input[type=file]")).length));

// Uploading must not navigate. A redirect to the same URL is a full document
// teardown, and on an upload that takes seconds it reads as the page dying
// and coming back. A marker set before the click survives only if it did not.
await uploaderPage.evaluate(() => {
  (window as unknown as { __alive: number }).__alive = Date.now();
});
const tilesBefore = await uploaderPage.evaluate(() => document.querySelectorAll(".reftile").length);
const picker = await uploaderPage.$("input[type=file]");
await picker!.uploadFile(sampleFile);
await uploaderPage.select('select[name="category"]', "AMENITY");
await uploaderPage.click("[data-add]");
await uploaderPage.waitForSelector("[data-result]", { timeout: 120000 });

check("uploading says what happened",
  /uploaded/i.test(await uploaderPage.$eval("[data-result]", (el) => el.textContent ?? "")),
  await uploaderPage.$eval("[data-result]", (el) => el.textContent ?? ""));
check("and the page was never torn down",
  (await uploaderPage.evaluate(() => (window as unknown as { __alive?: number }).__alive ?? null)) !== null);
check("the url is unchanged", !uploaderPage.url().includes("?"), uploaderPage.url());
// The file goes straight to the store, and the library's refreshed tree can
// land a moment after the message does, so wait for the tile, not a duration.
await uploaderPage.waitForFunction(
  (n: number) => document.querySelectorAll(".reftile").length === n, { timeout: 30000 }, tilesBefore + 1,
).catch(() => {});
check("and the new tile is simply there",
  (await uploaderPage.evaluate(() => document.querySelectorAll(".reftile").length)) === tilesBefore + 1,
  `${tilesBefore} before`);
check("with the picker cleared, so the same batch cannot be sent twice",
  await uploaderPage.$eval("input[type=file]", (el) => (el as HTMLInputElement).files?.length === 0));
check("but never approve", (await uploaderPage.$("[data-approve]")) === null);

// The screen is presentation. The action is the gate.
await uploaderPage.evaluate(
  async (base: string, node: string, asset: string) => {
    await fetch(`${base}/dashboard/library/${node}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nodeId: node, assetId: asset }).toString(),
      redirect: "manual",
    });
  },
  BASE, phase.id, floorPlan.assetId,
);
const [{ n: approvals }] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM asset_approvals WHERE asset_id = ${floorPlan.assetId}`;
check("and a posted approve from an uploader records nothing", approvals === 0, `${approvals}`);

const { ctx: approverCtx, page: approverPage } = await openAs(approver.id, APPROVER, "Asset Approver");
await approverPage.goto(`${BASE}/dashboard/library/${phase.id}`, { waitUntil: "networkidle0" });
check("an approver is offered approve", !!(await approverPage.$("[data-approve]")));
check("but never upload", (await approverPage.$("[data-add]")) === null);

// The screen is presentation. The action is the gate.
await approverPage.evaluate(
  async (base: string, node: string, asset: string) => {
    await fetch(`${base}/dashboard/library/${node}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nodeId: node, assetId: asset }).toString(),
      redirect: "manual",
    });
  },
  BASE, phase.id, floorPlan.assetId,
);
const [{ n: stillThere }] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM assets WHERE id = ${floorPlan.assetId}`;
check("and a posted remove from an approver deletes nothing", stillThere === 1, `${stillThere}`);

// ---------------------------------------------------------------------------
console.log("\ntaking one back out");

const keys = (await sql<{ storage_key: string }[]>`
  SELECT storage_key FROM asset_versions WHERE asset_id = ${sitePlan.assetId}`)
  .map((r) => r.storage_key);
await removeAssetRow({ orgId: org.id, actorUserId: admin.id, assetId: sitePlan.assetId });
check("the row goes", (await sql`SELECT id FROM assets WHERE id = ${sitePlan.assetId}`).length === 0);
// An object with no row is a byte nobody can see and nobody will delete.
// Every version's object, not only the newest: the others would be orphans
// nobody can name.
const stillThereAfter = await Promise.all(keys.map((k) => readAsset(k)));
check("and every version's object goes with it",
  stillThereAfter.every((b) => b === null), `${stillThereAfter.filter(Boolean).length} left`);

// ---------------------------------------------------------------------------
} catch (e) {
  check("the run finished", false, (e as Error).stack ?? String(e));
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
