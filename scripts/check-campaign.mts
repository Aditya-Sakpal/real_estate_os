// Functional check of campaign briefs, driven through the real console.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-campaign.mts
//
// Writing, editing and handing over a brief go through the browser and the
// real server actions. What the tenant modules refuse is asked of the real
// functions, loaded straight from source, because "the form is never
// believed" is a claim about those and not about the page.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { deflateSync, crc32 } from "node:zlib";
import {
  addReference,
  createBrief,
  listReferences,
  loadBrief,
  readReferenceMedia,
  removeReference,
  saveBrief,
  setBriefStatus,
} from "../src/lib/campaign.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { LANGUAGES } from "../src/lib/campaign-rules.ts";

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

const READER = "campaign-reader@example-tenant.test";
const SEEDED = [READER];

const wipe = async () => {
  await sql`DELETE FROM memberships m USING users u
            WHERE m.user_id = u.id AND u.email = ANY(${SEEDED})`;
  await sql`DELETE FROM users WHERE email = ANY(${SEEDED})`;
};
await wipe();

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
  WHERE org_id = ${org.id} AND kind = 'ORG' LIMIT 1`;
const [region] = await sql<Node[]>`
  SELECT id, name, kind, path::text AS path FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'REGION' ORDER BY path LIMIT 1`;
if (!root || !region) throw new Error("No root and region to hang a brief off");

/**
 * The suite builds its own project and phase, and takes nothing that was
 * already here.
 *
 * It used to grab whichever project and phase came first and delete every
 * brief in the organisation at both ends. That is fine on a throwaway
 * database and destructive on the one somebody is using, where the first
 * sign of it is a 404 where their campaign used to be.
 */
const FIXTURE_SLUGS = ["campaign_check_project", "campaign_check_phase"];

const dropFixtures = async () => {
  await sql`DELETE FROM scope_nodes
            WHERE org_id = ${org.id} AND slug = ANY(${FIXTURE_SLUGS})`;
};
await dropFixtures();

const [project] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${region.id}, 'PROJECT', 'Campaign Check Project', 'campaign_check_project',
          ${`${region.path}.campaign_check_project`}::ltree)
  RETURNING id, name, kind, path::text AS path`;
const [phase] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Campaign Check Phase', 'campaign_check_phase',
          ${`${region.path}.campaign_check_project.campaign_check_phase`}::ltree)
  RETURNING id, name, kind, path::text AS path`;

/**
 * Every brief this suite made, gathered before anything deletes them.
 *
 * The audit cleanup needs the ids, and the briefs are gone by then: the
 * fixture nodes cascade. So the ids are noted at each point a brief is about
 * to be removed, and the cleanup deletes those and nothing else.
 */
const fixtureBriefIds = new Set<string>();
const noteFixtureBriefs = async () => {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM campaign_briefs
    WHERE org_id = ${org.id} AND scope_node_id = ANY(${[project.id, phase.id]})`;
  for (const r of rows) fixtureBriefIds.add(r.id);
};

/** Scoped to the fixtures, so the developer's own briefs and history stay. */
const clearBriefs = async () => {
  await sql`DELETE FROM campaign_briefs
            WHERE org_id = ${org.id} AND scope_node_id = ANY(${[project.id, phase.id]})`;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const openAs = async (id: string, email: string, name: string | null) => {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  // A cold route can outlast puppeteer's 30s default, and a navigation that
  // times out fails the suite for a reason unrelated to the rule in hand.
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

/**
 * A note once it is actually there. Waiting on the REDIRECT rather than the
 * element: a refusal from the previous action is still on screen when the
 * next one is clicked, so waiting on the selector reads the stale message.
 */
const note = async (param = "error", selector = ".note--risk") => {
  // A redirect carries its message in the address; a kept form shows its
  // refusal in place with no redirect at all. Either one means it answered.
  await page
    .waitForFunction(
      (p: string, s: string) => new URL(location.href).searchParams.has(p) || !!document.querySelector(s)?.textContent?.trim(),
      { timeout: 30000 },
      param,
      selector,
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

/**
 * Click, and wait for where it was supposed to take you.
 *
 * A click on a route Next has not finished compiling lands on nothing: the
 * element is in the DOM, the handler is not attached yet, and network idle
 * then returns immediately because nothing was ever requested. The assertion
 * after it reads an unchanged page and fails for a reason that has nothing to
 * do with the rule being checked. Waiting for the outcome rather than for a
 * duration is the same rule the screen reads follow.
 */
const clickTo = async (selector: string, wanted: string) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await clickIn(selector);
    try {
      await page.waitForFunction(
        (w: string) => location.href.includes(w),
        { timeout: 20000 },
        wanted,
      );
      return;
    } catch {
      if (page.url().includes(wanted)) return;
      // Still here. Reload and try again: a cold route is ready by now.
      await page.reload({ waitUntil: "networkidle0" }).catch(() => {});
    }
  }
  throw new Error(`clicking ${selector} never reached ${wanted}; at ${page.url()}`);
};

const setField = async (name: string, value: string) => {
  const sel = `#briefform [name="${name}"]`;
  await page.waitForSelector(sel, { timeout: 30000 });
  await page.$eval(
    sel,
    (el, v) => {
      (el as HTMLInputElement | HTMLTextAreaElement).value = v;
    },
    value,
  );
};

const tick = async (name: string, value: string) => {
  await page.evaluate(
    (n: string, v: string) => {
      const box = document.querySelector(
        `#briefform [name="${n}"][value="${v}"]`,
      ) as HTMLInputElement | null;
      if (box) box.checked = true;
    },
    name,
    value,
  );
};

const saveBriefForm = () => clickIn('button[form="briefform"]');

// ---------------------------------------------------------------------------
console.log("\nstarting a brief");

await go(`/dashboard/campaigns/${phase.id}`);
check("the node's campaigns screen opens", page.url().includes(phase.id), page.url());
const nodeHeading = await page.$eval("h1", (h) => h.textContent!.trim()).catch(() => "");
check("and names the place it is for", nodeHeading.includes(phase.name), nodeHeading);

await page.$eval('.briefstart [name="name"]', (el) => {
  (el as HTMLInputElement).value = "Diwali 2026";
});
await clickTo(".briefstart button", "/brief/");

const [created] = await sql<{ id: string; name: string; status: string }[]>`
  SELECT id, name, status FROM campaign_briefs
  WHERE org_id = ${org.id} AND scope_node_id = ${phase.id}`;
check("the brief is written", !!created, "nothing in campaign_briefs");
check("under the name that was typed", created?.name === "Diwali 2026", created?.name);
check("and it starts as a draft", created?.status === "DRAFT", created?.status);
check("landing in the editor, not on the list",
  page.url().includes(`/brief/${created.id}`) && page.url().includes("edit=1"), page.url());

const [createAudit] = await sql<{ action: string }[]>`
  SELECT action FROM audit_log WHERE org_id = ${org.id} AND action = 'campaign.brief_created'`;
check("and it is audited", !!createAudit);

// A second campaign of the same name on one tower is a naming accident.
await go(`/dashboard/campaigns/${phase.id}`);
await page.$eval('.briefstart [name="name"]', (el) => {
  (el as HTMLInputElement).value = "diwali 2026";
});
await clickIn(".briefstart button");
const dupeNote = await note();
check("the same name twice on one node is refused",
  /already a campaign called/i.test(dupeNote), dupeNote.slice(0, 90));
// Scoped to the fixture node, not the organisation. Counting every brief in
// the tenant made this pass only on a database with nothing else in it.
const [{ n: briefCount }] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM campaign_briefs
  WHERE org_id = ${org.id} AND scope_node_id = ${phase.id}`;
check("and nothing is written", briefCount === 1, `${briefCount}`);

// ---------------------------------------------------------------------------
console.log("\na brief opens read-only, and editing is a decision");

await go(`/dashboard/campaigns/brief/${created.id}`);
const readOnlyForm = await page.$("#briefform");
check("arriving at a brief shows no form over its values", readOnlyForm === null);
check("and offers to edit it", !!(await page.$("[data-edit]")));

await go(`/dashboard/campaigns/brief/${created.id}?edit=1`);
check("asking to edit gives the form", !!(await page.$("#briefform")));

// ---------------------------------------------------------------------------
console.log("\nfilling it in");

await setField("audience", "First time buyers, 30 to 42, working in BKC");
await setField("microMarkets", "Goregaon East\n\n Malad West \n");
await setField("cta", "Book a site visit this weekend");
await setField("hook", "Metro and connectivity");
await tick("objective", "SITE_VISIT");
await tick("languages", "English");
await tick("languages", "Marathi");
await tick("formats", "Meta feed 1:1");
await saveBriefForm();

const [saved] = await sql<{
  objective: string;
  audience: string;
  micro_markets: string[];
  languages: string[];
  formats: string[];
  cta: string;
  hook: string;
}[]>`
  SELECT objective, audience, micro_markets, languages, formats, cta, hook
  FROM campaign_briefs WHERE id = ${created.id}`;
check("the objective is stored", saved?.objective === "SITE_VISIT", saved?.objective);
check("the audience is stored", saved?.audience?.startsWith("First time buyers"), saved?.audience);
// Marathi is ticked too, and is kept only while the catalog offers it (English
// only since 9 October 2026): the catalog is the filter, not the form.
const wantLanguages = ["English", "Marathi"].filter((l) => (LANGUAGES as readonly string[]).includes(l)).join(",");
check("the languages are stored", saved?.languages?.join(",") === wantLanguages,
  saved?.languages?.join(","));
check("the formats are stored", saved?.formats?.join(",") === "Meta feed 1:1",
  saved?.formats?.join(","));
check("micro-markets split on lines, blanks dropped",
  saved?.micro_markets?.join("|") === "Goregaon East|Malad West",
  saved?.micro_markets?.join("|"));

await go(`/dashboard/campaigns/brief/${created.id}`);
const shown = await page.$eval("body", (b) => b.textContent ?? "");
check("and the read-only view shows what was saved",
  shown.includes("Site visit booking") && shown.includes("Goregaon East"),
  shown.slice(0, 120));

// ---------------------------------------------------------------------------
console.log("\nthe form is never believed");

// Posted straight at the tenant module, because this is a claim about that
// function and not about the page: the browser's checkbox list is only ever
// what the page happened to render.
await saveBrief({
  orgId: org.id,
  actorUserId: admin.id,
  briefId: created.id,
  input: {
    name: "Diwali 2026",
    objective: "SELL_HARDER",
    audience: "First time buyers, 30 to 42, working in BKC",
    microMarkets: "Goregaon East\nMalad West",
    languages: ["English", "Klingon"],
    formats: ["Meta feed 1:1", "Skywriting"],
    // No configuration on this node is any of these, and one of them is not
    // even a uuid. The catalog for these is the tenant's own towers, so the
    // filtering happens in the statement rather than against a list in code.
    unitTypeIds: ["not-a-uuid", "00000000-0000-4000-8000-000000000000"],
    cta: "Book a site visit this weekend",
    hook: null,
    offers: null,
  },
});
const [crafted] = await sql<
  { objective: string | null; languages: string[]; formats: string[]; unit_type_ids: string[] }[]
>`
  SELECT objective, languages, formats, unit_type_ids
  FROM campaign_briefs WHERE id = ${created.id}`;
check("an objective outside the catalog is dropped, not stored",
  crafted?.objective === null, String(crafted?.objective));
check("a language outside the catalog is dropped",
  crafted?.languages?.join(",") === "English", crafted?.languages?.join(","));
check("and so is a format", crafted?.formats?.join(",") === "Meta feed 1:1",
  crafted?.formats?.join(","));
check("a configuration id that resolves to nothing here writes nothing",
  crafted?.unit_type_ids?.length === 0, String(crafted?.unit_type_ids));

// A brief belongs to a PROJECT or a PHASE. The organisation carries no Brain
// and no registration, so it carries no campaign either.
const atRoot = await createBrief({
  orgId: org.id,
  actorUserId: admin.id,
  nodeId: root.id,
  name: "Org wide",
});
check("a brief cannot be written against the organisation", atRoot.ok === false);
check("and the refusal says where one belongs",
  /project or a phase/i.test((atRoot as { message: string }).message ?? ""),
  (atRoot as { message: string }).message);

const ghost = await loadBrief(org.id, "00000000-0000-0000-0000-000000000000");
check("a brief id naming nothing resolves to nothing", ghost === null);
const malformed = await loadBrief(org.id, "not-a-uuid");
check("and a malformed one is refused before the query", malformed === null);

// ---------------------------------------------------------------------------
console.log("\nhanding it over");

// Put the objective back: the crafted post above cleared it.
await go(`/dashboard/campaigns/brief/${created.id}?edit=1`);
await tick("objective", "SITE_VISIT");
await saveBriefForm();

await go(`/dashboard/campaigns/brief/${created.id}`);
await clickIn("[data-status]");
const [ready] = await sql<{ status: string }[]>`
  SELECT status FROM campaign_briefs WHERE id = ${created.id}`;
check("a complete brief can be marked ready", ready?.status === "READY", ready?.status);

const [readyAudit] = await sql<{ action: string }[]>`
  SELECT action FROM audit_log WHERE org_id = ${org.id} AND action = 'campaign.brief_ready'`;
check("and that is audited", !!readyAudit);

await go(`/dashboard/campaigns/brief/${created.id}`);
await clickIn("[data-status]");
const [reopened] = await sql<{ status: string }[]>`
  SELECT status FROM campaign_briefs WHERE id = ${created.id}`;
check("and it can come back for a rewrite", reopened?.status === "DRAFT", reopened?.status);

// An incomplete brief cannot claim to be ready. Asked of the real function,
// because the screen's disabled state is presentation.
const halfDone = await createBrief({
  orgId: org.id,
  actorUserId: admin.id,
  nodeId: project.id,
  name: "Launch",
});
if (!halfDone.ok) throw new Error("could not seed the half-written brief");
const refused = await setBriefStatus({
  orgId: org.id,
  actorUserId: admin.id,
  briefId: halfDone.briefId,
  status: "READY",
});
check("a half-written brief cannot be marked ready", refused.ok === false);
check("and the refusal names the fields",
  /Objective.*Audience.*Languages.*Formats.*Call to action/.test(
    (refused as { message: string }).message ?? ""),
  (refused as { message: string }).message);
const [stillDraft] = await sql<{ status: string }[]>`
  SELECT status FROM campaign_briefs WHERE id = ${halfDone.briefId}`;
check("so it stays a draft", stillDraft?.status === "DRAFT", stillDraft?.status);

// ---------------------------------------------------------------------------
console.log("\nreferences: uploads, not links");

// A real PNG, built here rather than pasted as base64. A hand-typed literal
// carries bad chunk CRCs, which a browser refuses to decode, and the suite
// would then assert against an image no screen could ever show.
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 60)]);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

const worked = await addReference({
  orgId: org.id, actorUserId: admin.id, briefId: created.id, kind: "WORKED",
  note: "Carousel, the third card did the work",
  media: { bytes: png, type: "image/png", name: "carousel.png" },
});
check("an image can be filed as a reference", worked.ok === true,
  (worked as { message?: string }).message);

// Video is uploaded, not linked, which is the whole point of this change.
const clip = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42", "ascii"),
  Buffer.alloc(4), Buffer.from("mp42isom", "ascii"),
  Buffer.alloc(64 * 1024, 7),
]);
const video = await addReference({
  orgId: org.id, actorUserId: admin.id, briefId: created.id, kind: "WORKED",
  note: "The reel our agency cut in March",
  media: { bytes: clip, type: "video/mp4", name: "reel.mp4" },
});
check("and so can a video", video.ok === true, (video as { message?: string }).message);

const filed = await listReferences(org.id, created.id);
check("both come back on the brief", filed.length === 2, `${filed.length}`);
check("the list carries the type and the size, never the bytes",
  filed[0]?.mediaType === "image/png" &&
    filed[0]?.mediaBytes === png.byteLength &&
    !("media" in (filed[0] as object)),
  JSON.stringify(filed[0]));

const back = await readReferenceMedia(org.id, created.id, filed[0].id);
check("the file round-trips byte for byte",
  back?.bytes.equals(png) === true, `${back?.bytes.byteLength} of ${png.byteLength}`);

// The route is what a browser actually asks for.
const imgUrl = `${BASE}/dashboard/campaigns/brief/${created.id}/reference/${filed[0].id}`;
const served = await page.evaluate(async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  return { status: r.status, type: r.headers.get("content-type"),
           sniff: r.headers.get("x-content-type-options") };
}, imgUrl);
check("the route serves it to a signed-in reader", served.status === 200, String(served.status));
check("as the type it was stored as", served.type === "image/png", String(served.type));
check("and pins that type against sniffing", served.sniff === "nosniff", String(served.sniff));

// A <video> asks for `bytes=0-` and then seeks by asking for a later window.
// Answering every one of those with the whole file makes scrubbing
// re-download the clip, and Safari will not play without a 206.
const videoRow = filed.find((r) => r.mediaType === "video/mp4")!;
const vidUrl = `${BASE}/dashboard/campaigns/brief/${created.id}/reference/${videoRow.id}`;
const ranged = await page.evaluate(async (u: string) => {
  const r = await fetch(u, { cache: "no-store", headers: { range: "bytes=100-199" } });
  return { status: r.status, range: r.headers.get("content-range"),
           len: r.headers.get("content-length") };
}, vidUrl);
check("a range request on a video is answered with 206", ranged.status === 206, String(ranged.status));
check("naming the window and the whole length",
  ranged.range === `bytes 100-199/${clip.byteLength}`, String(ranged.range));
check("and exactly that many bytes", ranged.len === "100", String(ranged.len));
check("the full response advertises ranges", (await page.evaluate(async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  return r.headers.get("accept-ranges");
}, vidUrl)) === "bytes");
// A range past the end is a client bug, and the answer is the length.
check("a range past the end is refused with the length", (await page.evaluate(async (u: string) => {
  const r = await fetch(u, { cache: "no-store", headers: { range: "bytes=99999999-" } });
  return r.status;
}, vidUrl)) === 416);

// A 404 rather than a redirect: telling a crafted request that the id exists
// is the whole thing worth withholding.
const anon = await fetch(imgUrl, { redirect: "manual" });
check("a request with no session gets nothing", anon.status === 404, String(anon.status));

// A reference IS its media. There is no link and no note-only reference,
// because a reference to a page nothing can read is not a reference.
check("a reference with no file is refused", (await addReference({
  orgId: org.id, actorUserId: admin.id, briefId: created.id, kind: "WORKED",
  note: "the one from last year", media: null,
})).ok === false);
check("an SVG is refused", (await addReference({
  orgId: org.id, actorUserId: admin.id, briefId: created.id, kind: "WORKED", note: null,
  media: { bytes: Buffer.from("<svg/>"), type: "image/svg+xml", name: "x.svg" },
})).ok === false);
check("a PDF is refused", (await addReference({
  orgId: org.id, actorUserId: admin.id, briefId: created.id, kind: "AVOID", note: null,
  media: { bytes: Buffer.alloc(64), type: "application/pdf", name: "deck.pdf" },
})).ok === false);
check("a file over 25 MB is refused", (await addReference({
  orgId: org.id, actorUserId: admin.id, briefId: created.id, kind: "AVOID", note: null,
  media: { bytes: Buffer.alloc(25 * 1024 * 1024 + 1), type: "video/mp4", name: "huge.mp4" },
})).ok === false);

check("none of those were written",
  (await listReferences(org.id, created.id)).length === 2,
  `${(await listReferences(org.id, created.id)).length}`);

check("a file id naming nothing resolves to nothing",
  (await readReferenceMedia(org.id, created.id, "00000000-0000-0000-0000-000000000000")) === null);
check("and a real file asked for under another brief's address is not served",
  (await readReferenceMedia(org.id, "00000000-0000-0000-0000-000000000000", filed[1].id)) === null);
check("and a malformed one is refused before the query",
  (await readReferenceMedia(org.id, created.id, "not-a-uuid")) === null);

await removeReference({ orgId: org.id, actorUserId: admin.id, referenceId: filed[0].id });
check("a reference can be taken off the brief",
  (await listReferences(org.id, created.id)).length === 1);
check("and its bytes go with it",
  (await readReferenceMedia(org.id, created.id, filed[0].id)) === null);

// ---------------------------------------------------------------------------
// The references sit BESIDE the brief form rather than inside it, and filing
// one used to redirect. That re-rendered the brief from the database, so
// everything typed into it and not yet saved was thrown away: somebody
// uploading the video that worked lost the audience, the micro-markets and
// the hook they had just written, and the only sign of it was the page
// blanking and coming back emptier.
//
// Driven through the real picker, because the bug was never in `addReference()`
// and a check that calls it directly would have passed throughout.
console.log("\nfiling a reference does not take the page away");

const pngPath = join(tmpdir(), "salesdesk-check-reference.png");
writeFileSync(pngPath, png);

await go(`/dashboard/campaigns/brief/${created.id}?edit=1`);

const TYPED = "Typed and not yet saved";
await setField("audience", TYPED);

const before = page.url();
const tilesBefore = await page.$$eval(".reftile", (els) => els.length);

const picker = await page.waitForSelector('[data-add="WORKED"]')
  .then(() => page.$('form.refupload input[type="file"]'));
await picker!.uploadFile(pngPath);
await page.$eval('form.refupload [name="note"]', (el) => {
  (el as HTMLInputElement).value = "Filed without leaving the page";
});

// Wait for the tile to arrive rather than for a duration: the upload and the
// revalidation are two round trips and a read that lands between them reports
// the screen said nothing.
await clickIn('[data-add="WORKED"]');
await page
  .waitForFunction(
    (n: number) => document.querySelectorAll(".reftile").length > n,
    { timeout: 30000 },
    tilesBefore,
  )
  .catch(() => {});

const tilesAfter = await page.$$eval(".reftile", (els) => els.length);
check("the reference appears in place", tilesAfter === tilesBefore + 1,
  `${tilesBefore} -> ${tilesAfter}`);
check("without taking the page anywhere", page.url() === before, page.url());

// The assertion the whole change exists for.
const stillThere = await page
  .$eval('#briefform [name="audience"]', (el) => (el as HTMLTextAreaElement).value)
  .catch(() => "");
check("and what was typed into the brief is still there", stillThere === TYPED,
  JSON.stringify(stillThere));

// A picker still holding last time's file uploads it again on the next press,
// which is the rule the brand kit already learned.
const pickerLeft = await page
  .$eval('form.refupload input[type="file"]', (el) => (el as HTMLInputElement).value)
  .catch(() => "unread");
check("the picker is emptied by a save that lands", pickerLeft === "", pickerLeft);

// Removing is the same bargain in reverse.
const beforeRemove = page.url();
// Removing asks first; the dialog's own button does it.
await clickIn('.reftile [data-confirm^="remove-ref-"]');
await clickIn('dialog[open] [data-confirmed^="remove-ref-"]');
await page
  .waitForFunction(
    (n: number) => document.querySelectorAll(".reftile").length < n,
    { timeout: 30000 },
    tilesAfter,
  )
  .catch(() => {});
check("removing one also stays put", page.url() === beforeRemove, page.url());
check("and it goes",
  (await page.$$eval(".reftile", (els) => els.length)) === tilesAfter - 1);

rmSync(pngPath, { force: true });

const [refMeta] = await sql<{ metadata: Record<string, unknown> }[]>`
  SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'campaign.reference_added'
  ORDER BY id DESC LIMIT 1`;
check("filing a reference is audited", !!refMeta);
// audit_log is the one table that must carry no free text somebody typed.
check("and the audit row carries no note and no file name",
  !JSON.stringify(refMeta?.metadata ?? {}).includes("reel.mp4") &&
    !JSON.stringify(refMeta?.metadata ?? {}).includes("agency"),
  JSON.stringify(refMeta?.metadata));

// ---------------------------------------------------------------------------
console.log("\nreading is not writing");

// A role that may see campaigns and not write them. Code checks a permission,
// never a role name, so a tenant's own invented role works exactly as a
// shipped one would.
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_CAMPAIGN_READER'`;
await sql`
  INSERT INTO org_roles (org_id, key, label, description, min_kind, can_delegate,
                         source, permissions)
  VALUES (${org.id}, 'C_CAMPAIGN_READER', 'Campaign reader', 'Sees briefs, writes none.',
          'ORG', false, 'CUSTOM', ${["campaign:read", "member:read"]})`;

const [reader] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name)
  VALUES (${READER}, 'example-tenant.test', 'Campaign Reader')
  RETURNING id`;
await sql`
  INSERT INTO memberships (user_id, org_id, scope_node_id, role, status)
  VALUES (${reader.id}, ${org.id}, ${root.id}, 'C_CAMPAIGN_READER', 'ACTIVE')`;

const { ctx: readerCtx, page: readerPage } = await openAs(reader.id, READER, "Campaign Reader");
await readerPage.goto(`${BASE}/dashboard/campaigns/brief/${created.id}`, {
  waitUntil: "networkidle0",
});
check("a reader can open a brief",
  readerPage.url().includes(created.id), readerPage.url());
check("but is not offered the edit control", (await readerPage.$("[data-edit]")) === null);
check("nor the one that hands it over", (await readerPage.$("[data-status]")) === null);
check("and no list offers them a new campaign",
  await readerPage.goto(`${BASE}/dashboard/campaigns/${phase.id}`, { waitUntil: "networkidle0" })
    .then(() => readerPage.$(".briefstart"))
    .then((el) => el === null));

// The screen is presentation. The action is the gate, so the same request is
// posted with the reader's own session.
const forced = await readerPage.evaluate(
  async (base: string, id: string) => {
    const body = new URLSearchParams({ briefId: id, name: "Hijacked" });
    const r = await fetch(`${base}/dashboard/campaigns/brief/${id}?edit=1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    return r.status;
  },
  BASE,
  created.id,
);
const [unchanged] = await sql<{ name: string }[]>`
  SELECT name FROM campaign_briefs WHERE id = ${created.id}`;
check("and a posted write from a reader changes nothing",
  unchanged?.name === "Diwali 2026", `${unchanged?.name} (status ${forced})`);

// ---------------------------------------------------------------------------
console.log("\nthe campaigns screen counts what exists");

await go("/dashboard/campaigns");
const withBriefs = await page.$eval("body", (b) => b.textContent ?? "");
// Both nodes carry a draft by now, so the count is what has to reach the
// screen. "No brief" below proves the other side of the same read.
check("the index carries each node's brief count",
  withBriefs.includes("1 draft"), withBriefs.slice(-260));

await noteFixtureBriefs();
await sql`DELETE FROM campaign_briefs WHERE org_id = ${org.id} AND scope_node_id = ${phase.id}`;
await go("/dashboard/campaigns");
const withoutBriefs = await page.$eval("body", (b) => b.textContent ?? "");
check("and says so when a node has none",
  withoutBriefs.includes("No brief"), withoutBriefs.slice(-260));

await readerCtx.close();
await adminCtx.close();
await browser.close();
// The fixture subtree goes, and campaign_briefs and campaign_references go
// with it: both are ON DELETE CASCADE from scope_nodes.
await noteFixtureBriefs();
await clearBriefs();
// Only the rows about briefs THIS suite made. It used to take every
// `campaign.%` row on any brief in the organisation, which erased the
// developer's own history: a real brief's "created" and "reference added"
// rows vanished on every run, so the trail could no longer say whether that
// brief had ever been saved.
await sql`DELETE FROM audit_log
          WHERE org_id = ${org.id} AND action LIKE 'campaign.%'
            AND target_id = ANY(${[...fixtureBriefIds]})`;
await dropFixtures();
await sql`DELETE FROM memberships m USING users u
          WHERE m.user_id = u.id AND u.email = ANY(${SEEDED})`;
await sql`DELETE FROM users WHERE email = ANY(${SEEDED})`;
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_CAMPAIGN_READER'`;
await sql.end();
await closeDb();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
