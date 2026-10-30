// Functional check of posts: approved pictures and cleared copy into images,
// carousels and videos, against the real database and the real compositor,
// with the file store pointed at a local folder.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-compose.mts
//
// The store is local rather than the bucket because this suite writes dozens
// of frames and clips, and what it is about is the composition and the rules
// around it, not S3; `check:assets` already proves the bucket. `ASSETS_DIR`
// is set here, in the process, before anything asks for the store, which is
// the seam `storage.ts` provides for exactly this.
//
// It builds its own entity, project and phase, with its own approved
// pictures, lockup, logo and brand kit, and drops them at the end. Nothing
// belonging to the organisation is read or touched.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import postgres from "postgres";
import QRCode from "qrcode";

if (!existsSync(".env.local")) throw new Error("run with --env-file=.env.local");
const STORE = mkdtempSync(join(tmpdir(), "salesdesk-compose-"));
process.env.ASSETS_DIR = STORE;

const { makePosts, makeOnePost, listPosts, removePost, postMedia, readQr } = await import("../src/lib/compose.ts");
const { layoutFor } = await import("../src/lib/compose-rules.ts");
const { cleanReading } = await import("../src/lib/pixel-rules.ts");
const { termsFor, istDate } = await import("../src/lib/billing-rules.ts");
const { putAsset, readAsset } = await import("../src/lib/storage.ts");
const { createSchedule, loadSchedule, executeRun, listCreatives } = await import("../src/lib/post.ts");
const { closeDb } = await import("../src/lib/db/index.ts");

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

const [admin] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string }[]>`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  LIMIT 1`;
const [root] = await sql<{ id: string; path: string }[]>`
  SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG'`;

const SLUGS = ["compose_entity", "compose_project", "compose_phase"];
const SUITE_SLIDES = 997;
const dropFixtures = async () => {
  // A project's partner terms and its plan point at its node and hold it in place.
  await sql`DELETE FROM commission_terms WHERE scope_node_id IN (SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS}))`;
  await sql`DELETE FROM subscriptions WHERE project_id IN (SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS}))`;
  // The suite's own extra slides, a test lot of a quantity nothing else grants; what was drawn from it goes with it.
  await sql`DELETE FROM wallet_entries WHERE org_id = ${org.id} AND kind = 'CREDIT' AND source = 'GRANT' AND unit = 'SLIDE' AND test AND qty = ${SUITE_SLIDES}`;
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
const entity = await node(root.id, "ENTITY", "Compose Check SPV", "compose_entity", `${root.path}.compose_entity`);
const project = await node(entity.id, "PROJECT", "Compose Check Project", "compose_project", `${entity.path}.compose_project`);
const phase = await node(project.id, "PHASE", "Compose Check Tower", "compose_phase", `${project.path}.compose_phase`);

// An organisation with a billing account runs nothing that costs money on a
// project without a plan, so the fixture project is sold one, the way the
// operator's tool does, with room for everything the suite makes.
const [billed] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM billing_accounts WHERE org_id = ${org.id}`;
if (billed.n) {
  const terms = termsFor("SCALE");
  await sql`
    INSERT INTO subscriptions (org_id, project_id, plan, status, cycle, starts_on, terms)
    VALUES (${org.id}, ${project.id}, 'SCALE', 'ACTIVE', 'MONTHLY', ${istDate(new Date().toISOString())},
            ${sql.json({ ...terms, allowance: { ...terms.allowance, IMAGE: 1000, CAROUSEL: 1000, VIDEO: 1000 } } as never)})`;
  // A carousel past five slides draws extra slides, which only a top-up holds.
  await sql`
    INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source, test)
    VALUES (${org.id}, 'CREDIT', 'SLIDE', ${SUITE_SLIDES}, now() + interval '1 day', 'GRANT', true)`;
}

const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no,
                                    state_code, promoter_name, valid_to, verified_at)
  VALUES (${phase.id}, ${org.id}, 'VERIFIED', 'P51700055555', 'MH', 'Compose Check SPV', ${FAR}, now())`;

const [bv] = await sql<{ id: string }[]>`
  INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
  VALUES (${org.id}, ${phase.id}, 1, 'DRAFT', ${admin.id}) RETURNING id`;
for (const [k, v] of [
  ["claims.talking_points", "Sea facing from the 18th floor up\nEight minutes from the metro\nA podium garden"],
  ["claims.never_say", "guaranteed returns"],
  ["claims.location", "Nahur West, Mumbai"],
] as const) {
  await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value)
            VALUES (${org.id}, ${bv.id}, ${k}, ${v})`;
}
await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${bv.id}`;

// A picture that is recognisably itself, so the suite can tell which one a
// frame was built from: a flat colour.
const solid = (r: number, g: number, b: number, w = 1200, h = 900) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();

// A logo the way designers save one: the mark in the middle of a wide
// transparent margin, which is what came out small on a white chip.
const logo = await sharp({ create: { width: 400, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await solid(20, 60, 160, 160, 60), left: 40, top: 30 }])
  .png()
  .toBuffer();
await sql`
  INSERT INTO brand_kits (org_id, scope_node_id, sales_phone, website, colour_primary, disclaimer, updated_by)
  VALUES (${org.id}, ${entity.id}, '+919876500000', 'https://compose.example', '#1b3a86',
          'Prices valid for 30 days.', ${admin.id})`;
await sql`
  INSERT INTO brand_files (org_id, scope_node_id, role, media, media_type, media_name, uploaded_by)
  VALUES (${org.id}, ${entity.id}, 'LOGO_HORIZONTAL', ${logo}, 'image/png', 'logo.png', ${admin.id})`;

/** One approved asset: a row, a version with its bytes in the store, an approval. */
const approved = async (category: string, bytes: Buffer, isRender: boolean) => {
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO assets (org_id, scope_node_id, category, title, is_render, uploaded_by)
    VALUES (${org.id}, ${phase.id}, ${category}, ${category.toLowerCase()}, ${isRender}, ${admin.id})
    RETURNING id`;
  const put = await putAsset({ orgId: org.id, project: null, kind: "asset", id: a.id, bytes, contentType: "image/png" });
  if (!put.ok) throw new Error("could not store a fixture picture");
  const sha = createHash("sha256").update(bytes).digest("hex");
  await sql`
    INSERT INTO asset_versions (org_id, asset_id, version, storage_key, media_type, media_bytes, sha256, uploaded_by)
    VALUES (${org.id}, ${a.id}, 1, ${put.key}, 'image/png', ${bytes.byteLength}, ${sha}, ${admin.id})`;
  await sql`INSERT INTO asset_approvals (org_id, asset_id, sha256, approved_by)
            VALUES (${org.id}, ${a.id}, ${sha}, ${admin.id})`;
  return a.id;
};
const exterior = await approved("EXTERIOR_RENDER", await solid(200, 40, 40), true);
await approved("AMENITY", await solid(40, 160, 60), true);
await approved("SAMPLE_FLAT", await solid(40, 60, 200), false);
const plan = await approved("FLOOR_PLAN", await solid(250, 250, 250), true);
// A real QR, because the check scans the finished post for it.
const QR_TEXT = "https://maharera.maharashtra.gov.in/P51700055555";
const lockupId = await approved("RERA_LOCKUP", await QRCode.toBuffer(QR_TEXT, { width: 600, margin: 2 }), true);

// ---------------------------------------------------------------------------
// The image model and the checker, injected. The design model hands back the
// picture it was given; the checker reads back every line any instruction
// asked for, unless the script below says otherwise for that call.
// ---------------------------------------------------------------------------
type Review = {
  texts: string[]; registration: string; phone: string; textCutOff: boolean;
  buildingMatches: boolean; buildingIssues: string; looksLikeAd: boolean; designIssues: string;
};
const designCalls: { prompt: string; images: number; first: string; second: string | null }[] = [];
// How the fake model misbehaves next: forget the QR, or put it bottom left.
let fakeQr: ("skip" | "low")[] = [];
const hashOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let chooseCalls = 0;
const asked = new Set<string>();
let reviewScript: Partial<Review>[] = [];
let reviewCalls = 0;
// The video model, faked: the frame it is handed, held still for five
// seconds, or with a stripe painted across it when told to drift.
const animateCalls: { prompt: string; cfg: number }[] = [];
let fakeDrift: boolean[] = [];
const animate = async (req: { image: { bytes: Buffer }; prompt: string; cfgScale: number }) => {
  animateCalls.push({ prompt: req.prompt, cfg: req.cfgScale });
  const dir = mkdtempSync(join(tmpdir(), "salesdesk-fake-clip-"));
  try {
    let still = req.image.bytes;
    if (fakeDrift.shift()) {
      const meta = await sharp(still).metadata();
      const band = await sharp({ create: { width: meta.width!, height: 120, channels: 3, background: "#222222" } }).png().toBuffer();
      still = await sharp(still).composite([{ input: band, left: 0, top: Math.round(meta.height! * 0.3) }]).jpeg().toBuffer();
    }
    writeFileSync(join(dir, "in.jpg"), still);
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-i", join(dir, "in.jpg"),
      "-t", "5", "-r", "24", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libx264", join(dir, "out.mp4")]);
    return { ok: true as const, bytes: readFileSync(join(dir, "out.mp4")), type: "video/mp4" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// The art director, scripted. By default it directs the way the loop it
// replaced did: the cover first, then every other slide at once; a slide that
// failed for something the designer can fix is drawn again from the photo,
// shown the failed attempt; and it finishes when every slide passed, or
// gives up when none can. `brainPlan` overrides a turn with exact calls.
type Call = { name: string; args: Record<string, unknown> };
let brainPlan: Call[][] = [];
const brainTurns: { calls: Call[]; outputs: string[] }[] = [];
let callNo = 0;
const outputsOf = (input: Record<string, unknown>[]) => {
  const names = new Map<string, string>();
  for (const it of input) if (it.type === "function_call") names.set(String(it.call_id), String(it.name));
  return input
    .filter((it) => it.type === "function_call_output")
    .map((it) => ({
      name: names.get(String(it.call_id)) ?? "",
      text: typeof it.output === "string" ? it.output : String((it.output as { text?: string }[])[0]?.text ?? ""),
    }));
};
const scriptedTurn = (input: Record<string, unknown>[]): Call[] => {
  const task = String(((input[0] as { content: { text?: string }[] }).content[0]).text ?? "");
  const slides = (task.match(/^Slide \d+ \(/gm) ?? []).length;
  const outs = outputsOf(input);
  const last = outs[outs.length - 1];
  if (last?.name === "finish" && last.text.startsWith("Refused")) return [{ name: "give_up", args: { reason: "It cannot pass." } }];
  type A = { id: string; slide: number; passed: boolean; fixable: boolean; left: number };
  const attempts: A[] = outs
    .filter((o) => o.name === "design_slide" && /^s\d+a\d+ · /.test(o.text))
    .map((o) => {
      const m = /^(s(\d+)a\d+) · slide \d+ of \d+ \(\w+\) · (PASSED|FAILED) · (\d+)/.exec(o.text)!;
      return { id: m[1], slide: Number(m[2]), passed: m[3] === "PASSED", fixable: o.text.includes("(the designer can fix it)"), left: Number(m[4]) };
    });
  const latest = new Map<number, A>();
  for (const a of attempts) latest.set(a.slide, a);
  const failedDrawing = outs.some((o) => o.name === "design_slide" && o.text.startsWith("The drawing failed"));
  const design = (slide: number, attempt: string | null = null): Call => ({ name: "design_slide", args: { slide, start: "photo", attempt, changes: [] } });
  if (!latest.size) return [design(1)];
  const coverA = latest.get(1)!;
  if (slides > 1 && !coverA.passed && coverA.fixable && coverA.left > 0 && !failedDrawing) return [design(1, coverA.id)];
  const missing = Array.from({ length: slides }, (_, i) => i + 1).filter((s) => !latest.has(s));
  if (missing.length) return missing.map((s) => design(s));
  const again = [...latest.values()].filter((a) => !a.passed && a.fixable && a.left > 0 && !failedDrawing);
  if (again.length) return again.map((a) => design(a.slide, a.id));
  const best = Array.from({ length: slides }, (_, i) => attempts.filter((a) => a.slide === i + 1 && a.passed).pop()?.id ?? latest.get(i + 1)!.id);
  return [{ name: "finish", args: { attempts: best } }];
};
const brain = async (req: { input: Record<string, unknown>[] }) => {
  const calls = brainPlan.shift() ?? scriptedTurn(req.input);
  brainTurns.push({ calls, outputs: outputsOf(req.input).map((o) => o.text) });
  return {
    ok: true as const,
    output: calls.map((c) => ({ type: "function_call", call_id: `call_${++callNo}`, name: c.name, arguments: JSON.stringify(c.args) })),
    usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 },
  };
};

const FAKE = {
  brain,
  animate,
  design: async (req: { prompt: string; images: { bytes: Buffer; type: string }[] }) => {
    designCalls.push({
      prompt: req.prompt,
      images: req.images.length,
      first: hashOf(req.images[0].bytes),
      second: req.images[1] ? hashOf(req.images[1].bytes) : null,
    });
    for (const m of req.prompt.matchAll(/"([^"]+)"/g)) asked.add(m[1]);
    // A whole-ad design: the fake draws what the real model draws, the QR it
    // was handed (or a magenta square) in the upper-right quarter and a green
    // slot for the logo, on the photograph at the size asked for.
    if (req.prompt.includes("UPPER-RIGHT QUARTER")) {
      const [W, H] = String((req as { size?: string }).size ?? "1024x1024").split("x").map(Number);
      const side = Math.round(W * 0.16);
      const how = fakeQr.shift();
      const x = how === "low" ? Math.round(W * 0.06) : Math.round(W * 0.74);
      const y = how === "low" ? Math.round(H * 0.7) : Math.round(H * 0.08);
      const layers: sharp.OverlayOptions[] = [];
      if (how !== "skip") {
        // The QR is the second image of a design and the third of an edit.
        const qrAt = req.prompt.includes("The second image is the project's MahaRERA QR code") ? 1
          : req.prompt.includes("The third image is the project's MahaRERA QR code") ? 2 : -1;
        const mark = qrAt > 0
          ? await sharp(req.images[qrAt].bytes).resize(side, side).png().toBuffer()
          : await sharp({ create: { width: side, height: side, channels: 3, background: "#ff00ff" } }).png().toBuffer();
        layers.push({ input: mark, left: x, top: y });
      }
      if (req.prompt.includes("#00FF00")) {
        layers.push({
          input: await sharp({ create: { width: Math.round(W * 0.24), height: Math.round(H * 0.08), channels: 3, background: "#00ff00" } }).png().toBuffer(),
          left: Math.round(W * 0.05),
          top: Math.round(H * 0.05),
        });
      }
      const bytes = await sharp(req.images[0].bytes).resize(W, H, { fit: "cover" }).composite(layers).png().toBuffer();
      return { ok: true as const, bytes, type: "image/png" };
    }
    return { ok: true as const, bytes: req.images[0].bytes, type: req.images[0].type };
  },
  review: async () => {
    reviewCalls++;
    const base: Review = {
      texts: [...asked, "Artist's impression."], registration: "MahaRERA No. P51700055555", phone: "+91 98765 00000",
      textCutOff: false, buildingMatches: true, buildingIssues: "", looksLikeAd: true, designIssues: "",
      reraWebsite: "maharera.maharashtra.gov.in", reraTopRight: true, reraTextLargeEnough: true,
    };
    return { ok: true as const, review: { ...base, ...(reviewScript.shift() ?? {}) } };
  },
  choose: async (ask: { keys: string[] }) => {
    chooseCalls++;
    return { ok: true as const, key: ask.keys.includes("09-key-highlights") ? "09-key-highlights" : ask.keys[0] };
  },
};
// The pixel gate's reader, faked: the fake model draws a QR and a logo slot
// and no words, so there is nothing for OCR to read. A frame reads as one
// carrying everything, unless the script below says otherwise for that read.
// The rules that judge the reading are the real ones; `check:pixel` reads
// real pictures with the real reader.
type Reading = ReturnType<typeof cleanReading>;
type FrameExpectation = Parameters<typeof cleanReading>[0];
let pixelScript: ((e: FrameExpectation) => Reading)[] = [];
let pixelReads = 0;
const fakePixel = async (_bytes: Buffer, e: FrameExpectation) => {
  pixelReads++;
  return (pixelScript.shift() ?? cleanReading)(e);
};
(FAKE as Record<string, unknown>).pixel = fakePixel;

const resetFakes = () => {
  asked.clear(); designCalls.length = 0; reviewCalls = 0; chooseCalls = 0; reviewScript = []; fakeQr = [];
  animateCalls.length = 0; fakeDrift = []; brainPlan = []; brainTurns.length = 0; pixelScript = []; pixelReads = 0;
};

const [brief] = await sql<{ id: string }[]>`
  INSERT INTO campaign_briefs (org_id, scope_node_id, name, status, objective, languages,
                               formats, cta, audience, updated_by)
  VALUES (${org.id}, ${phase.id}, 'Compose Check Push', 'READY', 'SITE_VISIT', ${["English"]},
          ${["Meta feed 1:1", "Meta reel 9:16", "Google display"]}, 'Book a site visit',
          'First time buyers', ${admin.id})
  RETURNING id`;

const card = async (segment: string, verdict: string, headline: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO campaign_copy (org_id, brief_id, scope_node_id, language, segment, headline, body,
                               cta, verdict, model, generated_by)
    VALUES (${org.id}, ${brief.id}, ${phase.id}, 'English', ${segment}, ${headline},
            'Sea facing from the 18th floor up.', 'Book a site visit', ${verdict}, 'fixture', ${admin.id})
    RETURNING id`;
  return row.id;
};
const cardA = await card("END_USER", "PASS", "Sea facing homes");
const cardB = await card("INVESTOR", "PASS", "Eight minutes from the metro");
const blockedCard = await card("NRI", "FAIL", "Guaranteed returns");

const probe = (file: string) =>
  execFileSync(process.env.FFMPEG_PATH ? process.env.FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/, "ffprobe$1") : "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=width,height,codec_name", "-of", "json", file]).toString();

// ---------------------------------------------------------------------------
console.log("\nan image");

const images = await makePosts({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE" });
// Two cleared cards, two still formats in the brief. The blocked card is
// never laid over a picture: laying it out only makes it look finished.
check("one post per cleared card per still format", images.ok ? images.made : images, 4);
let posts = await listPosts(org.id, brief.id);
check("the blocked card made nothing",
  posts.some((p) => p.headline === "Guaranteed returns"), false);
const square = posts.find((p) => p.kind === "IMAGE" && p.placement === "Meta feed 1:1")!;
const banner = posts.find((p) => p.kind === "IMAGE" && p.placement === "Google display")!;
check("a feed post is 1080 square", [square.media[0].width, square.media[0].height], [1080, 1080]);
// These four were read by the real reader: OCR and the QR, off the file.
check("each was read by the pixel gate and passed", posts.filter((p) => p.kind === "IMAGE").map((p) => p.pixel?.verdict), ["PASS", "PASS", "PASS", "PASS"]);
const [squareRow] = await sql<{ media: { sha256?: string }[]; pixel: { files: { sha256: string }[] } }[]>`
  SELECT media, pixel FROM rendered_posts WHERE id = ${square.id}`;
check("and the verdict names the file it read, which the media says too",
  squareRow.pixel.files[0].sha256 === squareRow.media[0].sha256 && squareRow.media[0].sha256 === createHash("sha256").update((await readAsset(square.media[0].key))!).digest("hex"), true);
check("the check is in the audit log by its hash",
  (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${org.id} AND action = 'creative.pixel_checked'
      AND target_id = ${square.id} AND metadata -> 'sha256' ->> 0 = ${squareRow.media[0].sha256!}`)[0].n, 1);
check("a display banner is 1200 by 628", [banner.media[0].width, banner.media[0].height], [1200, 628]);

const squareBytes = (await readAsset(square.media[0].key))!;
const meta = await sharp(squareBytes).metadata();
check("and the file is what it says", [meta.width, meta.height, meta.format], [1080, 1080, "jpeg"]);

// The registration block sits top right, which is where MahaRERA's order
// puts it (with no white panel since 30 September 2026). Read the QR off the
// file, because asserting the layout numbers only asserts the half that was
// never going to be wrong.
const px = async (bytes: Buffer, x: number, y: number) => {
  const { data } = await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
};
check("the lockup's QR is there, top right, and scans", await readQr(squareBytes, { x: 700, y: 0, w: 380, h: 300 }), QR_TEXT);

// Every pixel of the building traces to an approval: the post names them.
const [rec] = await sql<{ inputs: { pictures: { assetId: string }[]; lockup: { assetId: string } | null } }[]>`
  SELECT inputs FROM rendered_posts WHERE id = ${square.id}`;
check("the post records the approved picture it was built from",
  rec.inputs.pictures.length > 0, true);
check("and the lockup", rec.inputs.lockup?.assetId, lockupId);
check("a floor plan is never used as a background",
  (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rendered_posts
    WHERE brief_id = ${brief.id} AND inputs::text LIKE ${"%" + plan + "%"}`)[0].n, 0);
check("the cover is the exterior",
  (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rendered_posts
    WHERE brief_id = ${brief.id} AND inputs::text LIKE ${"%" + exterior + "%"}`)[0].n > 0, true);

// ---------------------------------------------------------------------------
console.log("\na carousel");

const carousels = await makePosts({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "CAROUSEL", copyIds: [cardA, blockedCard], reader: fakePixel,
});
// Only the one cleared card that was asked for; the blocked one named in the
// same request is ignored rather than laid out.
check("one carousel from the one cleared card asked for", carousels.ok ? carousels.made : carousels, 1);
posts = await listPosts(org.id, brief.id);
const carousel = posts.find((p) => p.kind === "CAROUSEL")!;
check("a cover, one slide per talking point, and a close", carousel.media.length, 5);
check("every slide is square",
  carousel.media.every((m) => m.width === 1080 && m.height === 1080), true);
const slide2 = (await readAsset(carousel.media[2].key))!;
check("and every slide carries the lockup, not only the cover", await readQr(slide2, { x: 700, y: 0, w: 380, h: 300 }), QR_TEXT);

// ---------------------------------------------------------------------------
console.log("\na video");

const videos = await makePosts({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "VIDEO", copyIds: [cardB], reader: fakePixel,
});
check("one clip per card per moving format", videos.ok ? videos.made : videos, 1);
posts = await listPosts(org.id, brief.id);
const video = posts.find((p) => p.kind === "VIDEO")!;
check("it is a vertical reel", [video.media[0].width, video.media[0].height, video.media[0].type],
  [1080, 1920, "video/mp4"]);
const clipPath = join(STORE, "clip.mp4");
writeFileSync(clipPath, (await readAsset(video.media[0].key))!);
const info = JSON.parse(probe(clipPath)) as { format: { duration: string }; streams: { codec_name: string }[] };
check("in H.264, which every platform plays", info.streams[0]?.codec_name, "h264");
// Five slides at three seconds each, less a frame or two at the joins.
check("three seconds a slide", Math.abs(Number(info.format.duration) - 15) < 0.5, true);

// ---------------------------------------------------------------------------
console.log("\none post at a time, which the screen's placeholders fill from");

const before = (await listPosts(org.id, brief.id)).length;
const v1 = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE,
});
const v2 = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE,
});
check("each call makes exactly one post", (await listPosts(org.id, brief.id)).length - before, 2);
const picOf = async (id: string) =>
  (await sql<{ p: string }[]>`
    SELECT inputs->'pictures'->0->>'assetId' AS p FROM rendered_posts WHERE id = ${id}`)[0]?.p;
check("and a second version of the same card and size uses a different picture",
  v1.ok && v2.ok ? (await picOf(v1.postId)) !== (await picOf(v2.postId)) : null, true);
const wrongSize = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "CAROUSEL",
  copyId: cardA, placement: "Google display", drivers: FAKE,
});
check("a size this kind is not made in is refused", wrongSize.ok ? null : wrongSize.code, "NO_PLACEMENT");
const notCleared = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: blockedCard, placement: "Meta feed 1:1", drivers: FAKE,
});
check("and so is a card that is not cleared", notCleared.ok ? null : notCleared.code, "NOT_CLEARED");


// ---------------------------------------------------------------------------
console.log("\ndesigned by the image model, and checked");

resetFakes();
reviewScript = [{ buildingMatches: false, buildingIssues: "It has 2 extra floors on top." }];
const designed = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE,
});
check("a post whose building was changed is designed again", designCalls.length, 2);
check("and it passes the second time", designed.ok ? designed.passed : designed, true);
check("the first instruction carries the headline to set", designCalls[0].prompt.includes('"Sea facing homes"'), true);
check("an image post is designed whole, its registration quarter named", designCalls[0].prompt.includes("UPPER-RIGHT QUARTER"), true);
// The block is ours since 21 October 2026: the model was asked to draw it and
// set it on a white card every time, so it is told to leave the quarter empty.
check("which the model leaves empty, for us to set", [designCalls[0].prompt.includes("set there by us afterwards"),
  designCalls[0].prompt.includes("maharera.maharashtra.gov.in")], [true, false]);
check("with no template picked, one is chosen for the card", chooseCalls, 1);
check("the photo and two of the template's designs go to the model, and no QR to draw", designCalls[0].images, 3);
// A building that changed is drawn again from the photograph alone: the
// failed attempt and the references are what changed it (6 October 2026).
check("a changed building is drawn again from the photograph alone, without the failed attempt or the references", designCalls[1].images, 1);
check("with what was wrong", designCalls[1].prompt.includes("The building was altered"), true);
check("and never the checker's own words about the building, which carried a number",
  designCalls.some((c) => /extra floors|\b2\b/.test(c.prompt)), false);
// Where the project is, on a line of its own: the first live ad never said.
check("the location is set on a line of its own, near the headline",
  designCalls[0].prompt.includes('close to the headline, in spaced capitals, small but clearly readable: "Nahur West, Mumbai"'), true);

const designedPost = (await listPosts(org.id, brief.id)).find((p) => designed.ok && p.id === designed.postId)!;
check("the post records the template and that the AI chose it",
  [designedPost.template?.key, designedPost.template?.by], ["09-key-highlights", "ai"]);
check("the check is stored with the post", [designedPost.review?.passed, designedPost.review?.attempts], [true, 2]);
const [designedRow] = await sql<{ facts: { location: string | null } | null }[]>`
  SELECT inputs -> 'facts' AS facts FROM rendered_posts WHERE id = ${designedPost.id}`;
check("and so is the location it printed, to be checked again when it is published",
  designedRow?.facts?.location, "Nahur West, Mumbai");
const designedBytes = (await readAsset(designedPost.media[0].key))!;
check("the QR the model drew was swapped for the real one, and scans",
  await readQr(designedBytes, { x: 540, y: 0, w: 540, h: 540 }), QR_TEXT);
// The fake leaves the slot at 5% in and 24% by 8% of the design: about 54
// to 313 across and 54 to 140 down here. The mark is cut to what is drawn
// and centred in it, so the slot's left end is picture, not chip.
const edgePx = await px(designedBytes, 62, 97);
check("the green slot is painted out from the picture around it, with no chip",
  [edgePx[0] > 150 && edgePx[1] < 90 && edgePx[2] < 90], [true]);
const markPx = await px(designedBytes, 184, 97);
// The logo keeps its own brand colours, never recoloured (6 October 2026).
check("and a navy logo is set in its own colours, straight on the picture",
  markPx[2] > 120 && markPx[0] < 80 && markPx[1] < 110, true);

// Every ad names the exact locality. A brief on the project reads the
// project's facts, which sign none, so nothing is designed or paid for.
resetFakes();
const [unplaced] = await sql<{ id: string }[]>`
  INSERT INTO campaign_briefs (org_id, scope_node_id, name, status, objective, languages, formats, cta, audience, updated_by)
  VALUES (${org.id}, ${project.id}, 'Compose Check Unplaced', 'READY', 'SITE_VISIT', ${["English"]},
          ${["Meta feed 1:1"]}, 'Book a site visit', 'First time buyers', ${admin.id})
  RETURNING id`;
const [unplacedCard] = await sql<{ id: string }[]>`
  INSERT INTO campaign_copy (org_id, brief_id, scope_node_id, language, segment, headline, body, cta, verdict, model, generated_by)
  VALUES (${org.id}, ${unplaced.id}, ${project.id}, 'English', 'END_USER', 'Sea facing homes',
          'Sea facing from the 18th floor up.', 'Book a site visit', 'PASS', 'fixture', ${admin.id})
  RETURNING id`;
const noPlace = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: unplaced.id, kind: "IMAGE",
  copyId: unplacedCard.id, placement: "Meta feed 1:1", drivers: FAKE,
});
check("an ad with no exact location signed is refused before anything is designed",
  [noPlace.ok ? null : noPlace.code, designCalls.length], ["NO_LOCATION", 0]);

// A face a person chose: named for every word, shown as a specimen after the
// QR, and recorded on the post.
resetFakes();
const inFace = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement", font: "cinzel",
});
check("a chosen face is named in the instruction",
  designCalls[0]?.prompt.includes("set in Cinzel, classical Roman inscriptional capitals"), true);
check("and its specimen goes to the model after the photograph",
  [designCalls[0]?.images, designCalls[0]?.prompt.includes("specimen of the typeface")], [4, true]);
const [faceRow] = inFace.ok
  ? await sql<{ font: string | null }[]>`SELECT inputs ->> 'font' AS font FROM rendered_posts WHERE id = ${inFace.postId}`
  : [];
check("and the post records which face it was set in", faceRow?.font, "cinzel");

// A model that forgets the QR is not paid for again: the real QR is set in
// the upper-right quarter where the order puts it (6 October 2026).
resetFakes();
fakeQr = ["skip"];
const forgot = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("a design that forgot the QR is not designed again", designCalls.length, 1);
check("and the real QR is set for it, so it passes", forgot.ok ? forgot.passed : forgot, true);
const forgotPost = (await listPosts(org.id, brief.id)).find((p) => forgot.ok && p.id === forgot.postId)!;
check("which scans", await readQr((await readAsset(forgotPost.media[0].key))!, { x: 540, y: 0, w: 540, h: 540 }), QR_TEXT);

// A QR drawn outside the upper-right quarter would break the order: it is
// painted out and the real one set where the order puts it, without paying
// for another drawing (6 October 2026).
resetFakes();
fakeQr = ["low", "low", "low"];
const low = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("a QR drawn bottom left is not drawn again", designCalls.length, 1);
const lowPost = (await listPosts(org.id, brief.id)).find((p) => low.ok && p.id === low.postId);
const lowBytes = lowPost ? (await readAsset(lowPost.media[0].key))! : null;
check("the real QR is set in the upper-right quarter, and scans", lowBytes ? await readQr(lowBytes, { x: 540, y: 0, w: 540, h: 540 }) : null, QR_TEXT);
// Read the corner alone: readQr falls back to the whole frame, where ours is.
const lowCorner = lowBytes ? await sharp(lowBytes).extract({ left: 0, top: 540, width: 540, height: 540 }).png().toBuffer() : null;
check("and the drawn one is painted out, so the ad carries one QR", lowCorner ? await readQr(lowCorner) : "unread", null);

// The number and the website are ours to set, so a reading of them that
// looks wrong is not paid for again: another drawing cannot change our stamp.
// The pixel gate still reads them off the finished file.
resetFakes();
reviewScript = [{ reraWebsite: "" }, { registration: "MahaRERA No. P51700099999" }];
await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("a misread website or number on our own block is not drawn again", designCalls.length, 1);

resetFakes();
const invented = { texts: ["Sea facing homes", "Only Rs 45 lakh"] };
reviewScript = [invented, invented, invented];
const shownBefore = (await listPosts(org.id, brief.id)).length;
const stubborn = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE,
});
check("a model that keeps adding words is tried three times and no more", designCalls.length, 3);
// A post that failed a check after every attempt is not saved and never
// shown: "Did not pass" beside a post was one click from using it.
check("a post that never passes is not saved", [stubborn.ok ? stubborn.postId : stubborn.code,
  (await listPosts(org.id, brief.id)).length - shownBefore], ["DID_NOT_PASS", 0]);
check("and the screen is told why", !stubborn.ok && stubborn.message.includes("added words nobody cleared"), true);
check("and the failure is audited by its codes, never its words",
  (await sql<{ m: { problems: string[] } }[]>`
    SELECT metadata AS m FROM audit_log WHERE org_id = ${org.id} AND action = 'creative.post_failed'
      AND target_id = ${brief.id} ORDER BY created_at DESC LIMIT 1`)[0]?.m.problems, ["TEXT_WRONG", "EXTRA_TEXT"]);
check("the invented price never reaches the model that draws", designCalls.some((c) => c.prompt.includes("45")), false);

// ---------------------------------------------------------------------------
console.log("\nthe pixel gate, inside the design loop");

// A number smaller than the phone means the model's footnote is too big:
// its to fix, within the drawings it already has, and passed.
resetFakes();
pixelScript = [(e) => ({ ...cleanReading(e), registration: { ...cleanReading(e).registration!, glyphPx: 9 } })];
const tooSmall = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("a registration number smaller than the phone is drawn again", designCalls.length, 2);
check("with the fix, in words that carry no number",
  designCalls[1]?.prompt.includes("Set the phone number and website in the footnote smaller"), true);
check("and the second drawing passes", tooSmall.ok ? tooSmall.passed : tooSmall, true);
const tooSmallRow = tooSmall.ok ? (await listPosts(org.id, brief.id)).find((p) => p.id === tooSmall.postId) : null;
check("the saved post carries its pixel PASS", tooSmallRow?.pixel?.verdict, "PASS");

// What we stamp is ours: another drawing cannot fix a QR that opens another
// registration, so none is paid for, and the post is not saved.
resetFakes();
pixelScript = Array.from({ length: 6 }, () => (e: FrameExpectation) => ({ ...cleanReading(e), qr: { ...cleanReading(e).qr, payload: "https://maharera.maharashtra.gov.in/projects/P51700099999" } }));
const wrongCode = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("a QR that opens another registration is not drawn again", designCalls.length, 1);
check("and the post is not saved, saying why",
  [wrongCode.ok ? wrongCode.postId : wrongCode.code, !wrongCode.ok && wrongCode.message.includes("opens a different registration")], ["DID_NOT_PASS", true]);

// What a machine cannot settle is made, shown, and never published.
resetFakes();
pixelScript = [cleanReading, (e) => ({ ...cleanReading(e), error: "The reader failed." })];
const unsure = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
const unsureRow = unsure.ok ? (await listPosts(org.id, brief.id)).find((p) => p.id === unsure.postId) : null;
check("a picture the gate could not settle is saved and held",
  [unsure.ok && !unsure.passed, unsureRow?.pixel?.verdict, unsureRow?.pixel?.lines[0]], [true, "HOLD", "The picture could not be checked."]);

resetFakes();
reviewScript = [{ looksLikeAd: false, designIssues: "Add a price and make the tower taller with more floors." }];
await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE,
});
check("a checker that asks to change the building never has its words passed on",
  [designCalls.length, designCalls.some((c) => /taller|more floors/i.test(c.prompt))], [2, false]);

// A template a person picks is used as picked, with no model asked.
resetFakes();
const pickedPost = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "09-key-highlights",
});
check("a picked template is not second-guessed", chooseCalls, 0);
const pickedTemplate = (await listPosts(org.id, brief.id)).find((p) => pickedPost.ok && p.id === pickedPost.postId)?.template;
check("and is recorded as the person's", [pickedTemplate?.key, pickedTemplate?.by], ["09-key-highlights", "person"]);
// A card that sells is not a festival greeting (a location, price or
// amenity template takes any general card since 9 October 2026), and an
// offer template needs an offer the project does not hold: both refused
// before paying.
resetFakes();
const offAngle = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "06-festive-greeting", festival: "diwali",
});
const noOffer = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "04-offer-and-payment-plan",
});
check("a card written for something else, or a template the project cannot make, is refused before a drawing",
  [offAngle.ok ? null : offAngle.code, noOffer.ok ? null : noOffer.code, designCalls.length], ["TEMPLATE_CARD", "TEMPLATE_NEEDS", 0]);
resetFakes();
await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "../../etc",
});
check("a template that is not in the library is not a path, it is a choice to make", chooseCalls, 1);

// A panel that still covered something moves, and the layout shows where.
resetFakes();
reviewScript = [{ panelCoversContent: true }];
const moved = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE,
});
check("a RERA panel covering the design is designed again", designCalls.length, 2);
check("with what to fix", designCalls[1].prompt.includes("Keep that quarter calm and empty"), true);
check("and then passes", moved.ok ? moved.passed : moved, true);

// A phrase on the never-say list is refused before the image model is asked.
resetFakes();
const risky = await card("UPGRADER", "PASS", "Guaranteed returns by the sea");
const refusedPost = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: risky, placement: "Meta feed 1:1", drivers: FAKE,
});
check("an instruction carrying a never-say phrase is refused", refusedPost.ok ? null : refusedPost.code, "DESIGN_REFUSED");
check("before anything is drawn", designCalls.length, 0);
await sql`DELETE FROM campaign_copy WHERE id = ${risky}`;

// Hindi is set by us, not by the model, because the model cannot shape it.
resetFakes();
// A brief that asks for Hindi: a card in a language the brief does not ask
// for is never offered or drawn.
await sql`UPDATE campaign_briefs SET languages = ${["English", "Hindi"]} WHERE id = ${brief.id}`;
const hindi = await card("UPGRADER", "PASS", "समुद्र की ओर घर");
await sql`UPDATE campaign_copy SET language = 'Hindi', body = ${"हर मंज़िल से समुद्र"},
          cta = ${"साइट विज़िट"} WHERE id = ${hindi}`;
const hindiPost = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: hindi, placement: "Meta feed 1:1", drivers: FAKE,
});
// English only for now (the client, 9 October 2026): a Hindi card is never
// drawn, even on a brief that once asked for Hindi. The Hindi path's own
// checks come back with the language.
check("while posts are English only, a Hindi card is refused before a drawing",
  [hindiPost.ok ? hindiPost.postId : hindiPost.code, designCalls.length], ["NOT_CLEARED", 0]);

// Back to English only, so the scheduled runs below write no Hindi card,
// whose reading would call the real reader.
await sql`UPDATE campaign_briefs SET languages = ${["English"]} WHERE id = ${brief.id}`;

resetFakes();
const designedCarousel = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "CAROUSEL",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE,
});
check("every slide of a carousel is designed whole and checked", [designCalls.length, reviewCalls], [5, 5]);
check("each with the registration block", designCalls.every((c) => c.prompt.includes("UPPER-RIGHT QUARTER")), true);
check("with none picked, a carousel template is chosen for the card", chooseCalls, 1);
check("the cover gets the photo, the QR and its page of the design", designCalls[0]?.images, 3);
check("every later slide is also shown the finished cover, to match it",
  designCalls.slice(1).map((c) => [c.images, c.prompt.includes("first slide of this same carousel")]),
  [[4, true], [4, true], [4, true], [4, true]]);
check("and the carousel passes", designedCarousel.ok ? designedCarousel.passed : designedCarousel, true);
check("a slide on an amenity or a room is told to keep that space, not a building",
  [designCalls.every((c) => c.prompt.includes("THE SPACE") !== c.prompt.includes("THE BUILDING")),
    designCalls.some((c) => c.prompt.includes("THE SPACE"))], [true, true]);
const deckPost = (await listPosts(org.id, brief.id)).find((p) => designedCarousel.ok && p.id === designedCarousel.postId)!;
check("it records the carousel template, who chose it and which of its designs",
  [deckPost.template?.key, deckPost.template?.by, typeof deckPost.template?.design], ["01-project-tour", "ai", "number"]);
check("every slide's QR scans",
  await Promise.all(deckPost.media.map(async (m) => readQr((await readAsset(m.key))!, { x: 540, y: 0, w: 540, h: 540 }))),
  deckPost.media.map(() => QR_TEXT));

// Every video is one Seedance film since 5 October 2026, made by the worker
// (check:reel drives it); the three frames brought to life are refused here
// before a picture or a clip is paid for.
resetFakes();
const clipPost = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "VIDEO",
  copyId: cardA, placement: "Meta reel 9:16", drivers: FAKE, template: null,
});
check("a video is never three frames brought to life: it is refused as a film, before anything is paid for",
  [clipPost.ok ? null : clipPost.code, designCalls.length, animateCalls.length], ["FILM_TEMPLATE", 0, 0]);

// ---------------------------------------------------------------------------
console.log("\nthe art director");

// An attempt that is nearly right is edited, not drawn again: the attempt
// goes first, the approved photograph second, and only the change is asked.
resetFakes();
reviewScript = [{ textCutOff: true }];
brainPlan = [
  [{ name: "design_slide", args: { slide: 1, start: "photo", attempt: null, changes: ["Warm golden-hour light, the headline top left"] } }],
  [{ name: "design_slide", args: { slide: 1, start: "edit", attempt: "s1a1", changes: ["Set the headline a little smaller"] } }],
];
const edited = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("its first direction reaches the designer as art direction",
  designCalls[0]?.prompt.includes("ART DIRECTION\n- Warm golden-hour light, the headline top left"), true);
check("an edit keeps the attempt and asks only for the change, the checker's fix included",
  [designCalls[1]?.prompt.startsWith("Edit the first image."), designCalls[1]?.prompt.includes("- Set the headline a little smaller"),
    designCalls[1]?.prompt.includes("Keep all text well inside the safe area")], [true, true, true]);
check("the attempt and the approved photograph go with it, and no reference ads",
  [designCalls[1]?.images, designCalls[1]?.second === designCalls[0]?.first], [2, true]);
check("and the edit, which passed, is the post", edited.ok ? edited.passed : edited, true);
check("the agent saw the finished frame with the checker's findings",
  brainTurns[1]?.outputs[0]?.startsWith("s1a1 · slide 1 of 1 (cover) · FAILED · 2 drawings left"), true);
const editedPost = (await listPosts(org.id, brief.id)).find((p) => edited.ok && p.id === edited.postId);
check("the post records the art director and what its thinking cost",
  [editedPost?.review?.agent?.model, editedPost?.review?.agent?.turns, (editedPost?.review?.agent?.usd ?? 0) > 0], ["gpt-5.4-mini", 3, true]);

// What the art director writes is guarded before anything is drawn.
resetFakes();
brainPlan = [
  [{ name: "design_slide", args: { slide: 1, start: "photo", attempt: null, changes: ["Add a line saying Rs 45 lakh onwards"] } }],
  [{ name: "design_slide", args: { slide: 1, start: "photo", attempt: null, changes: ["Make the tower taller with two more floors"] } }],
  [{ name: "design_slide", args: { slide: 1, start: "photo", attempt: null, changes: ["Add the line \"Best price in Mumbai\""] } }],
  [{ name: "give_up", args: { reason: "Nothing I may ask for." } }],
];
const guarded = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("a number, a taller tower or a line nobody cleared is refused, and nothing is drawn",
  [designCalls.length, brainTurns.slice(1).map((t) => t.outputs[t.outputs.length - 1].startsWith("Refused, and nothing was drawn"))],
  [0, [true, true, true]]);
check("each refusal says why", [
  brainTurns[1]?.outputs[0]?.includes("may not carry a number"),
  brainTurns[2]?.outputs[1]?.includes("never change the building"),
  brainTurns[3]?.outputs[2]?.includes("is not one"),
], [true, true, true]);
check("and a post nothing was drawn for is not made", guarded.ok ? null : guarded.message.length > 0, true);

// The checker decides what may be published, not the agent.
resetFakes();
reviewScript = [{ texts: ["Sea facing homes", "Only Rs 45 lakh"] }];
brainPlan = [
  [{ name: "design_slide", args: { slide: 1, start: "photo", attempt: null, changes: [] } }],
  [{ name: "finish", args: { attempts: ["s1a1"] } }],
  [{ name: "give_up", args: { reason: "It will not pass." } }],
];
const overruled = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("the agent cannot finish with an attempt that failed the check",
  [brainTurns[2]?.outputs[1]?.startsWith("Refused: s1a1 failed the check ("), overruled.ok ? null : overruled.code],
  [true, "DID_NOT_PASS"]);

// The drawings are capped per slide in code, whatever the agent asks for.
resetFakes();
reviewScript = [{ looksLikeAd: false }, { looksLikeAd: false }, { looksLikeAd: false }];
brainPlan = [1, 2, 3, 4].map(() => [{ name: "design_slide", args: { slide: 1, start: "photo", attempt: null, changes: [] } }]);
await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "01-launch-announcement",
});
check("a fourth drawing of one slide is refused", [designCalls.length, brainTurns[4]?.outputs[3]?.includes("has had all 3 of its drawings")], [3, true]);

// A carousel's later slides are matched to its cover, so the cover comes first.
resetFakes();
brainPlan = [[
  { name: "design_slide", args: { slide: 2, start: "photo", attempt: null, changes: [] } },
  { name: "design_slide", args: { slide: 1, start: "photo", attempt: null, changes: [] } },
]];
const coverFirst = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "CAROUSEL",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, template: "05-reasons-to-buy",
});
// Asked in the same turn as the cover, a later slide waits for the cover
// rather than being refused (6 October 2026), and is matched to it.
check("a slide asked for in the same turn as the cover waits for it, and the cover is drawn first",
  [designCalls[0]?.prompt.startsWith("Create slide two") === false, brainTurns[1]?.outputs.some((o) => o.startsWith("s1a1"))], [true, true]);
check("then every slide is matched to it and the carousel is made", [designCalls.length, coverFirst.ok ? coverFirst.passed : coverFirst], [5, true]);

// A photograph that does not suit its slide is swapped, like a person would,
// and the post records the picture its frame was really drawn from.
resetFakes();
const photoList = (task: string) =>
  [...task.slice(task.indexOf("APPROVED PHOTOGRAPHS")).matchAll(/^(\d+)\. ([a-z ]+)/gm)].map((m) => ({ n: Number(m[1]), category: m[2] }));
const coverPhoto = (task: string) => Number(/^Slide 1 \(cover\), from photograph (\d+)/m.exec(task)?.[1]);
let swapTask = "";
brainPlan = [];
const swapBrain = async (req: { input: Record<string, unknown>[] }) => {
  swapTask = String(((req.input[0] as { content: { text?: string }[] }).content[0]).text ?? "");
  if (!brainTurns.length) {
    const list = photoList(swapTask);
    const notExterior = list.find((p) => p.category !== "exterior render" && p.n !== coverPhoto(swapTask))!;
    brainPlan = [
      [{ name: "design_slide", args: { slide: 1, start: "photo", attempt: null, photo: notExterior.n, changes: [] } }],
      [{ name: "design_slide", args: { slide: 1, start: "photo", attempt: null, photo: null, changes: [] } }],
      [{ name: "design_slide", args: { slide: 2, start: "photo", attempt: null, photo: list.find((p) => p.category === "exterior render")!.n, changes: [] } }],
    ];
  }
  return brain(req);
};
const swapped = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "CAROUSEL",
  copyId: cardA, placement: "Meta feed 1:1", drivers: { ...FAKE, brain: swapBrain }, template: "05-reasons-to-buy",
});
check("the agent is shown every approved background, and never a floor plan", [photoList(swapTask).length, swapTask.includes("floor plan")], [3, false]);
check("a cover drawn from anything but an exterior, when there is one, is refused",
  brainTurns[1]?.outputs[0], "Refused: the cover is drawn from an exterior photograph.");
check("a later slide may take another photograph",
  /^s2a1 · .*\nThis is drawn from photograph \d+\./.test(brainTurns[3]?.outputs[2] ?? ""), true);
const [swappedRow] = swapped.ok ? await sql<{ pictures: { assetId: string }[] }[]>`
  SELECT inputs->'pictures' AS pictures FROM rendered_posts WHERE id = ${swapped.postId}` : [];
const exteriorSent = hashOf(await sharp(await solid(200, 40, 40)).resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
  .flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer());
check("the designer really was handed the exterior for that slide",
  designCalls.find((c) => c.prompt.startsWith("Create slide two of five"))?.first, exteriorSent);
check("and the post records the pictures its frames were drawn from", swappedRow?.pictures.some((p) => p.assetId === exterior), true);

// A person chooses the length. Three signed points and seven slides is a
// cover, three points, two photo slides and a close.
resetFakes();
const seven = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "CAROUSEL",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, slides: 7, template: "05-reasons-to-buy",
});
const sevenPost = (await listPosts(org.id, brief.id)).find((p) => seven.ok && p.id === seven.postId)!;
check("a carousel is as long as asked", sevenPost?.media.length, 7);
check("a picked carousel template is not second-guessed", [chooseCalls, sevenPost?.template?.key, sevenPost?.template?.by],
  [0, "05-reasons-to-buy", "person"]);
// Slides after the cover are designed two at a time, so their calls land in
// either order: counted, not sequenced.
check("the slides past the signed points are photo slides, with no headline",
  [designCalls.filter((c) => c.prompt.includes("This is a photo slide")).length,
    designCalls.filter((c) => c.prompt.includes("This is a photo slide")).every((c) => !c.prompt.includes("- Headline:"))], [2, true]);
resetFakes();
const long = await makeOnePost({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "CAROUSEL",
  copyId: cardA, placement: "Meta feed 1:1", drivers: FAKE, slides: 40,
});
check("and never longer than ten", long.ok ? (await listPosts(org.id, brief.id)).find((p) => p.id === long.postId)?.media.length : long, 10);

// ---------------------------------------------------------------------------
console.log("\nwhat is refused");

await sql`UPDATE campaign_briefs SET formats = ${["Google display"]} WHERE id = ${brief.id}`;
const noSquare = await makePosts({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "CAROUSEL" });
check("a carousel on a brief with no square format is refused",
  noSquare.ok ? null : noSquare.code, "NO_PLACEMENT");
await sql`UPDATE campaign_briefs SET formats = ${["Meta feed 1:1", "Meta reel 9:16", "Google display"]}
          WHERE id = ${brief.id}`;

// A post is an advertisement. A phase that stopped being advertisable since
// its copy cleared has nothing lawful to put on a picture.
await sql`UPDATE registration_records SET status = 'BLOCKED', registration_no = NULL, valid_to = NULL
          WHERE scope_node_id = ${phase.id}`;
const blocked = await makePosts({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE" });
check("an unregistered phase makes no post", blocked.ok ? null : blocked.code, "NOT_ADVERTISABLE");
await sql`UPDATE registration_records SET status = 'VERIFIED', registration_no = 'P51700055555', valid_to = ${FAR}
          WHERE scope_node_id = ${phase.id}`;

await sql`UPDATE campaign_copy SET verdict = 'HOLD' WHERE brief_id = ${brief.id}`;
const nothing = await makePosts({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, kind: "IMAGE" });
check("with nothing cleared there is nothing to make", nothing.ok ? null : nothing.code, "NOTHING_CLEARED");
await sql`UPDATE campaign_copy SET verdict = 'PASS' WHERE id = ANY(${[cardA, cardB]})`;

// ---------------------------------------------------------------------------
console.log("\nremoving, and other tenants");

const gone = square.media[0].key;
await removePost({ orgId: org.id, actorUserId: admin.id, postId: square.id });
check("removing takes the row", (await listPosts(org.id, brief.id)).some((p) => p.id === square.id), false);
check("and the file with it", (await readAsset(gone)) === null, true);

const [other] = await sql<{ id: string }[]>`SELECT id FROM orgs WHERE id <> ${org.id} LIMIT 1`;
if (other) {
  check("another tenant sees no posts", (await listPosts(other.id, brief.id)).length, 0);
  check("and cannot fetch one", await postMedia(other.id, carousel.id, 0), null);
}
check("a malformed post id is refused before the query", await postMedia(org.id, "nope", 0), null);

// ---------------------------------------------------------------------------
console.log("\na schedule's week plan makes the day's kind");

const week = [null, "IMAGE", null, "CAROUSEL", null, "VIDEO", null] as const;
const made = await createSchedule({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  input: {
    name: "Compose check week", mode: "REVIEW", daysOfWeek: [], atMinute: 600,
    leadMinutes: 1440, maxRunsPerDay: 24, startsOn: null, endsOn: null, dayKinds: [...week],
  },
});
check("a week plan is saved", made.ok, true);
const sched = made.ok ? await loadSchedule(org.id, made.scheduleId) : null;
check("and read back day by day", sched?.dayKinds, [...week]);
check("its days are the days with something on them", sched?.daysOfWeek, [1, 3, 5]);

// A Wednesday slot, 10:00 IST, makes a carousel.
const wednesday = new Date("2026-09-30T04:30:00.000Z");
const [run] = await sql<{ id: string }[]>`
  INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at)
  VALUES (${org.id}, ${made.ok ? made.scheduleId : null}, ${wednesday}, ${new Date()}, ${wednesday})
  RETURNING id`;
const CLEAN = { headline: "Sea facing homes", body: "Sea facing from the 18th floor up.", cta: "Book a visit" };
await executeRun({
  orgId: org.id, runId: run.id, actorUserId: admin.id,
  driver: async () => ({ ok: true, copy: CLEAN }), designers: FAKE,
});
const creatives = await listCreatives(org.id, run.id);
check("Wednesday's run made carousels", [...new Set(creatives.map((c) => c.kind))], ["CAROUSEL"]);
check("each with all its slides, for the person approving it",
  creatives.every((c) => c.media.length === 5), true);
check("and each picture carries its pixel PASS", creatives.map((c) => c.pixel?.verdict), creatives.map(() => "PASS"));

// The schedule's carousel style, the studio's choices kept on it: investors
// only, four slides, a template picked rather than chosen, and Cinzel.
const { templateCatalog } = await import("../src/lib/template-rules.ts");
const carouselKey = templateCatalog("CAROUSEL").find((c) => !c.story)!.key;
await sql`
  UPDATE post_schedules
  SET styles = ${sql.json({ CAROUSEL: { buyers: ["INVESTOR"], slides: 4, font: "cinzel", template: carouselKey } })}
  WHERE id = ${made.ok ? made.scheduleId : null}`;
resetFakes();
const [styledRun] = await sql<{ id: string }[]>`
  INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at)
  VALUES (${org.id}, ${made.ok ? made.scheduleId : null}, ${new Date(wednesday.getTime() + 7 * 86_400_000)}, ${new Date()},
          ${new Date(wednesday.getTime() + 7 * 86_400_000)})
  RETURNING id`;
await executeRun({
  orgId: org.id, runId: styledRun.id, actorUserId: admin.id,
  driver: async () => ({ ok: true, copy: CLEAN }), designers: FAKE,
});
const styledCreatives = await listCreatives(org.id, styledRun.id);
check("a schedule's carousel style is what its run makes: those buyers, that many slides",
  [[...new Set(styledCreatives.map((c) => c.segment))], styledCreatives.every((c) => c.media.length === 4)],
  [["INVESTOR"], true]);
check("its template picked, so nothing is asked of the chooser", chooseCalls, 0);
check("and its font named to the designer", designCalls.some((d) => /Cinzel/.test(d.prompt)), true);

// ---------------------------------------------------------------------------
console.log("\nAUTO publishes what passed, the picture included");

const autoMade = await createSchedule({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  input: {
    name: "Compose check auto", mode: "AUTO", destinations: ["INSTAGRAM"], daysOfWeek: [], atMinute: 600,
    leadMinutes: 1440, maxRunsPerDay: 24, startsOn: null, endsOn: null, dayKinds: ["IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE"],
  },
});
check("an AUTO schedule is saved", autoMade.ok, true);
const autoRun = async (slot: string) => {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at)
    VALUES (${org.id}, ${autoMade.ok ? autoMade.scheduleId : null}, ${new Date(slot)}, ${new Date()}, ${new Date(slot)})
    RETURNING id`;
  await executeRun({ orgId: org.id, runId: r.id, actorUserId: admin.id, driver: async () => ({ ok: true, copy: CLEAN }), designers: FAKE });
  return listCreatives(org.id, r.id);
};
resetFakes();
const passedAuto = await autoRun("2026-10-01T04:30:00.000Z");
check("a picture that passed is released by AUTO", passedAuto.map((c) => [c.state, c.pixel?.verdict]), passedAuto.map(() => ["APPROVED", "PASS"]));
resetFakes();
// Every read fails for a reason no drawing can fix: a QR that opens another registration.
pixelScript = Array.from({ length: 40 }, () => (e: FrameExpectation) => ({ ...cleanReading(e), qr: { ...cleanReading(e).qr, payload: "https://maharera.maharashtra.gov.in/projects/P51700099999" } }));
const failedAuto = await autoRun("2026-10-02T04:30:00.000Z");
check("a creative whose picture failed waits for a person, in AUTO too",
  failedAuto.map((c) => [c.state, c.media.length, c.postReview?.problems.some((p) => p.code === "PX_QR_WRONG")]),
  failedAuto.map(() => ["DRAFT", 0, true]));

// ---------------------------------------------------------------------------
await sql`DELETE FROM audit_log WHERE org_id = ${org.id}
            AND target_id = ANY(${[brief.id, square.id, made.ok ? made.scheduleId : brief.id, autoMade.ok ? autoMade.scheduleId : brief.id, run.id,
                                   ...(v1.ok ? [v1.postId] : []), ...(v2.ok ? [v2.postId] : [])]})`;
await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND action = 'creative.post_made'
            AND target_id IN (SELECT id::text FROM rendered_posts WHERE brief_id = ${brief.id})`;
await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND action = 'creative.pixel_checked'
            AND (target_id IN (SELECT id::text FROM rendered_posts WHERE brief_id = ${brief.id})
              OR target_id IN (SELECT c.id::text FROM post_creatives c JOIN post_runs r ON r.id = c.run_id
                               JOIN post_schedules s ON s.id = r.schedule_id WHERE s.brief_id = ${brief.id}))`;
await dropFixtures();
rmSync(STORE, { recursive: true, force: true });
await sql.end();
await closeDb();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
