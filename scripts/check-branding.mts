// Functional check of the brand kit, driven through the real console.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-branding.mts
//
// The suite builds its own entity and project and works only inside them. It
// deliberately never writes to the ORG root, because that is where a real
// developer's kit lives and a check that eats it is a check nobody can leave
// in `npm run check`.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import postgres from "postgres";
import { loadBrand, putBrandFile, readBrandFile, saveBrandKit } from "../src/lib/brand.ts";
import { BRAND_FILE_ROLES } from "../src/lib/brand-rules.ts";
import { closeDb } from "../src/lib/db/index.ts";

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

const READER = "brand-reader@example-tenant.test";
const SEEDED = [READER];

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

type Node = { id: string; name: string; path: string };
const [root] = await sql<Node[]>`
  SELECT id, name, path::text AS path FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'ORG'`;

// Its own subtree, and the ORG root is never written to.
const FIXTURE_SLUGS = ["brand_check_entity", "brand_check_project"];
const dropFixtures = async () => {
  await sql`DELETE FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${FIXTURE_SLUGS})`;
};
await dropFixtures();

const [entity] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${root.id}, 'ENTITY', 'Brand Check SPV', 'brand_check_entity',
          ${`${root.path}.brand_check_entity`}::ltree)
  RETURNING id, name, path::text AS path`;
const [project] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${entity.id}, 'PROJECT', 'Brand Check Project', 'brand_check_project',
          ${`${root.path}.brand_check_entity.brand_check_project`}::ltree)
  RETURNING id, name, path::text AS path`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const openAs = async (id: string, email: string, name: string | null) => {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.setDefaultNavigationTimeout(90000);
  await p.setViewport({ width: 1440, height: 1200 });
  await p.setCookie({
    name: COOKIE,
    value: await encode({
      token: { sub: id, userId: id, email, name },
      secret: process.env.AUTH_SECRET!,
      salt: COOKIE,
      maxAge: 900,
    }),
    domain: "localhost",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  // The organisation this suite seeded, not whichever one the account opens first.
  await p.setCookie({ name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" });
  return { ctx, page: p };
};

const { ctx: adminCtx, page } = await openAs(admin.id, admin.email, admin.name);
const go = (path: string) => page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" });

const note = async (param = "error", selector = ".note--risk") => {
  await page
    .waitForFunction(
      (p: string) => new URL(location.href).searchParams.has(p),
      { timeout: 30000 },
      param,
    )
    .catch(() => {});
  // And then for the note itself to have rendered. Waiting only on the
  // redirect leaves a gap: the parameter is in the URL a beat before React
  // has put the text on screen, and a read that lands in it reports "the
  // screen said nothing" when the screen simply had not painted yet.
  await page
    .waitForFunction(
      (s: string) => !!document.querySelector(s)?.textContent?.trim(),
      { timeout: 15000 },
      selector,
    )
    .catch(() => {});
  return page.$eval(selector, (el) => el.textContent!.trim()).catch(() => "");
};

const clickIn = async (selector: string) => {
  await page.waitForSelector(selector, { timeout: 20000 });
  await page.evaluate((s: string) => {
    (document.querySelector(s) as HTMLElement | null)?.click();
  }, selector);
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
};

const setField = async (name: string, value: string) => {
  const sel = `#brandform [name="${name}"]`;
  await page.waitForSelector(sel, { timeout: 30000 });
  await page.$eval(
    sel,
    (el, v) => {
      (el as HTMLInputElement | HTMLTextAreaElement).value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
};

// A real PNG with valid chunk CRCs. A hand-typed base64 literal carries bad
// ones, which a browser refuses to decode, and the suite would then assert
// against an image no screen could ever show.
const pngOf = (rgb: number[]) => {
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
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: 8 }, () => Buffer.from(rgb))]);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
const png = pngOf([90, 90, 90]);
const REPLACEMENT = pngOf([20, 20, 220]);

// ---------------------------------------------------------------------------
console.log("\nthe screen, and what it stores");

await go(`/dashboard/library/branding?node=${entity.id}&edit=1`);
const heading = await page.$eval("h1", (h) => h.textContent!.trim()).catch(() => "");
check("branding opens for a node", heading.includes(entity.name), heading);
check("and gives the form when asked to edit", !!(await page.$("#brandform")));

check("an untouched form offers nothing to save",
  (await page.$("[data-save]")) === null);

await setField("tagline", "Homes that hold their value");
check("and typing brings the control into existence",
  (await page.$("[data-save]")) !== null);

await setField("colourPrimary", "1B3A86");
await setField("salesPhone", "098765 43210");
await setField("salesEmail", "Sales@BrandCheck.com");
await setField("website", "brandcheck.example");
await setField("instagram", "@brandcheck");
await setField("disclaimer", "All images are artist's impressions.");
await clickIn('button[form="brandform"]');
await page.waitForFunction(() => !!document.querySelector("[data-saved]"), { timeout: 30000 })
  .catch(() => {});
check("the header says it saved rather than offering again",
  (await page.$("[data-saved]")) !== null && (await page.$("[data-save]")) === null);
// Nothing is left to save, so there is nothing to press. Saying "Saved." in
// the body as well would be furniture.
check("and does not repeat itself in the page",
  (await page.$("[data-result]")) === null);

const [kit] = await sql<{
  tagline: string;
  colour_primary: string;
  sales_phone: string;
  sales_email: string;
  website: string;
  instagram_url: string;
}[]>`
  SELECT tagline, colour_primary, sales_phone, sales_email, website, instagram_url
  FROM brand_kits WHERE scope_node_id = ${entity.id}`;
check("the kit is written", !!kit, "nothing in brand_kits");
check("the colour gains its hash and loses its case", kit?.colour_primary === "#1b3a86",
  kit?.colour_primary);
// One shape stored, because it is printed on hoardings and dialled by the
// call bench, and neither should have to work out that two spellings match.
check("the phone is stored in E.164", kit?.sales_phone === "+919876543210", kit?.sales_phone);
check("the email is lowercased", kit?.sales_email === "sales@brandcheck.com", kit?.sales_email);
check("a bare host becomes a real address",
  kit?.website === "https://brandcheck.example/", kit?.website);
// A handle has to become a link before it can be printed or clicked.
check("an at-handle becomes a link",
  kit?.instagram_url === "https://www.instagram.com/brandcheck", kit?.instagram_url);

await go(`/dashboard/library/branding?node=${entity.id}`);
const shown = await page.$eval("body", (b) => b.textContent ?? "");
check("and the read-only view groups the number for reading",
  shown.includes("+91 98765 43210"), shown.slice(0, 120));

// ---------------------------------------------------------------------------
console.log("\nthe marks");

const uploaded = await putBrandFile({
  orgId: org.id, actorUserId: admin.id, nodeId: entity.id, role: "LOGO_HORIZONTAL",
  media: { bytes: png, type: "image/png", name: "wide.png" },
});
check("a logo is stored", uploaded.ok === true, (uploaded as { message?: string }).message);

const view = await loadBrand(org.id, entity.id);
const file = view?.ownFiles.find((f) => f.role === "LOGO_HORIZONTAL");
check("it comes back on the node", !!file);
check("carrying its type and size, never its bytes",
  file?.mediaType === "image/png" && file?.mediaBytes === png.byteLength &&
    !("media" in (file as object)),
  JSON.stringify(file));

const bytes = await readBrandFile(org.id, file!.id);
check("the file round-trips byte for byte", bytes?.bytes.equals(png) === true);

const url = `${BASE}/dashboard/library/branding/file/${file!.id}`;
const served = await page.evaluate(async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  return { status: r.status, type: r.headers.get("content-type"),
           sniff: r.headers.get("x-content-type-options") };
}, url);
check("the route serves it to a signed-in reader", served.status === 200, String(served.status));
check("as the type it was stored as", served.type === "image/png", String(served.type));
check("and pins that type against sniffing", served.sniff === "nosniff", String(served.sniff));

const anon = await fetch(url, { redirect: "manual" });
check("a request with no session gets nothing", anon.status === 404, String(anon.status));

// One file per role. Two horizontal logos on one node is two answers to
// which mark is ours, so uploading again replaces.
await putBrandFile({
  orgId: org.id, actorUserId: admin.id, nodeId: entity.id, role: "LOGO_HORIZONTAL",
  media: { bytes: png, type: "image/webp", name: "wide-2.webp" },
});
const [{ n: slots }] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM brand_files
  WHERE scope_node_id = ${entity.id} AND role = 'LOGO_HORIZONTAL'`;
check("uploading again replaces rather than piles up", slots === 1, `${slots}`);

// A font is not a logo, and a logo is not a font.
check("a font in a logo slot is refused", (await putBrandFile({
  orgId: org.id, actorUserId: admin.id, nodeId: entity.id, role: "LOGO_MONO",
  media: { bytes: png, type: "font/woff2", name: "x.woff2" },
})).ok === false);
check("an SVG is refused", (await putBrandFile({
  orgId: org.id, actorUserId: admin.id, nodeId: entity.id, role: "LOGO_STACKED",
  media: { bytes: Buffer.from("<svg/>"), type: "image/svg+xml", name: "x.svg" },
})).ok === false);
check("a file over 5 MB is refused", (await putBrandFile({
  orgId: org.id, actorUserId: admin.id, nodeId: entity.id, role: "LOGO_STACKED",
  media: { bytes: Buffer.alloc(5 * 1024 * 1024 + 1), type: "image/png", name: "huge.png" },
})).ok === false);

check("a file id naming nothing resolves to nothing",
  (await readBrandFile(org.id, "00000000-0000-0000-0000-000000000000")) === null);
check("and a malformed one is refused before the query",
  (await readBrandFile(org.id, "not-a-uuid")) === null);

// ---------------------------------------------------------------------------
console.log("\none form, one press");

// There were five forms on this screen, one per mark and one for the text.
// Choosing three logos, typing a tagline and pressing one slot's Upload
// submitted that form and discarded the other four, and the re-render cleared
// what was left. It read as the page eating the work.
await go(`/dashboard/library/branding?node=${entity.id}&edit=1`);
const pickers = await page.$$eval("[data-pick]", (els) =>
  els.map((el) => ({
    role: el.getAttribute("data-pick"),
    form: (el as HTMLInputElement).form?.id ?? null,
    accept: (el as HTMLInputElement).accept,
  })),
);
check("every mark has a picker", pickers.length === BRAND_FILE_ROLES.length, `${pickers.length}`);
check("and all of them belong to the one form",
  pickers.every((pick) => pick.form === "brandform"),
  JSON.stringify(pickers.map((pick) => pick.form)));
// Windows resolves a media type in `accept` through the registry and fonts
// are usually not in it, so a type-only filter quietly offers every file on
// the machine to somebody looking for a typeface.
check("the typeface picker names the font extensions",
  pickers.find((pick) => pick.role === "TYPEFACE")?.accept.includes(".woff2"), true);
check("and a logo picker never offers a font",
  pickers.filter((pick) => pick.role !== "TYPEFACE").every((pick) => !pick.accept.includes("woff")),
  true);

const before = await page.$$eval(".brandfile__shot img", (els) =>
  els.map((el) => (el as HTMLImageElement).getAttribute("src") ?? ""));

const tmp = mkdtempSync(join(tmpdir(), "brandcheck-"));
for (const role of ["LOGO_HORIZONTAL", "LOGO_STACKED", "LOGO_MONO"]) {
  const chosen = join(tmp, `${role}.png`);
  writeFileSync(chosen, REPLACEMENT);
  const input = await page.$(`[data-pick="${role}"]`);
  await input!.uploadFile(chosen);
}
await page.evaluate(() => (document.querySelector("[data-save]") as HTMLElement).click());
await page
  .waitForFunction(() => !!document.querySelector("[data-result]")?.textContent?.trim(),
    { timeout: 60000 })
  .catch(() => {});
const said = await page.$eval("[data-result]", (el) => el.textContent!.trim()).catch(() => "");
check("one press saves every mark that was chosen", /3 files uploaded/.test(said), said);

const landed = await sql<{ role: string }[]>`
  SELECT role FROM brand_files WHERE scope_node_id = ${entity.id} ORDER BY role`;
check("and all three are on the node",
  landed.length === 3, landed.map((row) => row.role).join(","));

// The row id survives a replacement, because one mark per role per node is an
// upsert rather than a second row. So the address of the old bytes is the
// address of the new ones, and the browser serves what it already has: a
// replaced logo looked for five minutes like an upload that never happened,
// which is what made three marks chosen at once read as one.
await page
  .waitForFunction(() =>
    [...document.querySelectorAll(".brandfile__shot img")].every(
      (img) => (img as HTMLImageElement).complete &&
        (img as HTMLImageElement).naturalWidth > 0),
    { timeout: 30000 })
  .catch(() => {});
const after = await page.$$eval(".brandfile__shot img", (els) =>
  els.map((el) => (el as HTMLImageElement).getAttribute("src") ?? ""));
const wideBefore = before.find((u) => u.includes(file!.id)) ?? "";
const wideAfter = after.find((u) => u.includes(file!.id)) ?? "";
check("the mark keeps its id across a replacement", !!wideBefore && !!wideAfter,
  `${wideBefore} -> ${wideAfter}`);
check("but its address changes with the bytes", wideBefore !== wideAfter,
  `${wideBefore} -> ${wideAfter}`);

const painted = await page.evaluate(() =>
  ([...document.querySelectorAll(".brandfile__shot img")] as HTMLImageElement[]).map((img) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx2d = canvas.getContext("2d")!;
    ctx2d.drawImage(img, 0, 0, 1, 1);
    const [red, , blue] = ctx2d.getImageData(0, 0, 1, 1).data;
    return blue > red;
  }));
check("so every tile shows what was just uploaded",
  painted.length === 3 && painted.every(Boolean), JSON.stringify(painted));
rmSync(tmp, { recursive: true, force: true });

// A picker still holding last time's file would upload it again the next time
// somebody corrected a phone number, and the message would say so.
check("the pickers are emptied by a save that landed",
  await page.$$eval("[data-pick]", (els) =>
    els.every((el) => ((el as HTMLInputElement).files?.length ?? 0) === 0)), true);
check("so there is nothing left to save",
  (await page.$("[data-save]")) === null);
await setField("typefaceName", "Figtree");
check("until the next edit", (await page.$("[data-save]")) !== null);
await clickIn('button[form="brandform"]');

// Number("") is 0, and 0 sits inside a 0 to 4 bounds check, so a field nobody
// touched became "no clear space at all" rather than "not set".
const [blank] = await sql<{ ratio: string | null; floor: number | null }[]>`
  SELECT logo_clear_ratio::text AS ratio, logo_min_px AS floor
  FROM brand_kits WHERE scope_node_id = ${entity.id}`;
check("a bounded field left blank stays unset", blank?.ratio === null, String(blank?.ratio));
check("and so does a bounded whole number", blank?.floor === null, String(blank?.floor));

// ---------------------------------------------------------------------------
console.log("\nsaid once, and inherited down");

const child = await loadBrand(org.id, project.id);
check("a project with no kit of its own has none", !child?.own.tagline);
check("but resolves the one above it",
  child?.resolved.tagline === "Homes that hold their value", child?.resolved.tagline);
check("and the phone with it",
  child?.resolved.salesPhone === "+919876543210", child?.resolved.salesPhone);
check("the logo reaches it too",
  child?.resolvedFiles.some((f) => f.role === "LOGO_HORIZONTAL"), true);
check("and says which node it came from",
  child?.resolvedFiles.find((f) => f.role === "LOGO_HORIZONTAL")?.nodeName === entity.name,
  child?.resolvedFiles.find((f) => f.role === "LOGO_HORIZONTAL")?.nodeName);

await go(`/dashboard/library/branding?node=${project.id}`);
const inherited = await page.$eval("body", (b) => b.textContent ?? "");
// A project that takes the whole kit from above used to open into a blank
// override form, which reads as "nothing is set here" when everything is.
check("the screen opens read-only rather than over a blank form",
  (await page.$("#brandform")) === null);
check("and marks the inherited values with where they came from",
  inherited.includes(`From ${entity.name}`) || inherited.includes(`from ${entity.name}`),
  inherited.slice(0, 160));

// Setting its own overrides, and only what it sets.
await saveBrandKit({
  orgId: org.id, actorUserId: admin.id, nodeId: project.id,
  input: {
    tagline: "A tower of its own", colourPrimary: null, colourAccent: null,
    typefaceName: null, typefaceLanguages: [], logoMinPx: null, logoClearRatio: null,
    salesPhone: null, salesEmail: null, website: null, officeAddress: null,
    instagram: null, facebook: null, youtube: null, disclaimer: null,
  },
});
const overridden = await loadBrand(org.id, project.id);
check("a value set here wins", overridden?.resolved.tagline === "A tower of its own",
  overridden?.resolved.tagline);
// The same rule the Brain follows: a field nobody filled in is not an
// instruction to forget the one above it.
check("and the ones it left blank still inherit",
  overridden?.resolved.salesPhone === "+919876543210", overridden?.resolved.salesPhone);

// ---------------------------------------------------------------------------
console.log("\nreading is not writing");

await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_BRAND_READER'`;
await sql`
  INSERT INTO org_roles (org_id, key, label, description, min_kind, can_delegate,
                         source, permissions)
  VALUES (${org.id}, 'C_BRAND_READER', 'Brand reader', 'Sees the kit, changes none of it.',
          'ORG', false, 'CUSTOM', ${["brand:read", "member:read"]})`;

const [reader] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name)
  VALUES (${READER}, 'example-tenant.test', 'Brand Reader')
  RETURNING id`;
await sql`
  INSERT INTO memberships (user_id, org_id, scope_node_id, role, status)
  VALUES (${reader.id}, ${org.id}, ${root.id}, 'C_BRAND_READER', 'ACTIVE')`;

const { ctx: readerCtx, page: readerPage } = await openAs(reader.id, READER, "Brand Reader");
await readerPage.goto(`${BASE}/dashboard/library/branding?node=${entity.id}`, {
  waitUntil: "networkidle0",
});
check("a reader can open the kit",
  (await readerPage.$eval("h1", (h) => h.textContent ?? "")).includes(entity.name));
check("but is not offered the edit control", (await readerPage.$("[data-edit]")) === null);
check("and no way to choose a file either", (await readerPage.$("[data-pick]")) === null);
check("the file route still serves them the logo", (await readerPage.evaluate(
  async (u: string) => (await fetch(u, { cache: "no-store" })).status, url)) === 200);

// The screen is presentation. The action is the gate.
await readerPage.evaluate(
  async (base: string, id: string) => {
    await fetch(`${base}/dashboard/library/branding?node=${id}&edit=1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nodeId: id, tagline: "Hijacked" }).toString(),
      redirect: "manual",
    });
  },
  BASE,
  entity.id,
);
const [stillOurs] = await sql<{ tagline: string }[]>`
  SELECT tagline FROM brand_kits WHERE scope_node_id = ${entity.id}`;
check("and a posted write from a reader changes nothing",
  stillOurs?.tagline === "Homes that hold their value", stillOurs?.tagline);

// ---------------------------------------------------------------------------
await readerCtx.close();
await adminCtx.close();
await browser.close();

// The fixture subtree goes, and brand_kits and brand_files go with it: both
// are ON DELETE CASCADE from scope_nodes. The ORG root was never touched.
await sql`DELETE FROM audit_log
          WHERE org_id = ${org.id} AND action LIKE 'brand.%'
            AND target_id = ANY(${[entity.id, project.id]})`;
await dropFixtures();
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_BRAND_READER'`;
await wipeUsers();
await sql.end();
await closeDb();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
