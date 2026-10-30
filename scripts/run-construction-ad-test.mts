/**
 * End-to-end: seed brand + construction photo + lockup, write copy, make one
 * Construction update image (Meta feed 1:1) with the real models.
 *
 *   node --import ./scripts/lib/next-resolve.mjs --experimental-strip-types --env-file=.env.local scripts/run-construction-ad-test.mts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import QRCode from "qrcode";
import sharp from "sharp";
import { closeDb } from "../src/lib/db/index.ts";
import { putAsset } from "../src/lib/storage.ts";
import { generateBlocks } from "../src/lib/creative.ts";
import { makeOnePost, listPosts, postMedia } from "../src/lib/compose.ts";
import { resolveBrain } from "../src/lib/brain.ts";

const ORG = process.env.DEV_LOGIN_ORG!;
const BRIEF = "Diwali 2026";
const PHASE = "Tower C";
const TEMPLATE = "10-construction-update";
const PLACEMENT = "Meta feed 1:1";
const OUT = "tmp/ui-verify";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

const [admin] = await sql<{ id: string }[]>`
  SELECT u.id FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.org_id = ${ORG}
    AND m.role = 'ORG_ADMIN' AND m.status = 'ACTIVE'
  ORDER BY u.created_at LIMIT 1`;
if (!admin) throw new Error("No ORG_ADMIN");

const [phase] = await sql<{ id: string; path: string; project_id: string; entity_id: string; registration_no: string | null }[]>`
  SELECT ph.id, ph.path::text AS path, p.id AS project_id, e.id AS entity_id, r.registration_no
  FROM scope_nodes ph
  JOIN scope_nodes p ON p.id = ph.parent_id
  JOIN scope_nodes rg ON rg.id = p.parent_id
  JOIN scope_nodes e ON e.id = rg.parent_id
  LEFT JOIN registration_records r ON r.scope_node_id = ph.id
  WHERE ph.org_id = ${ORG} AND ph.kind = 'PHASE' AND ph.name = ${PHASE}
  LIMIT 1`;
if (!phase) throw new Error("Tower C missing");
if (!phase.registration_no) throw new Error("Tower C not registered — run npm run seed:tower-c");

const brain = await resolveBrain(ORG, phase.id);
if (!brain || !String(brain.values["claims.talking_points"] ?? "").trim()) {
  throw new Error("No talking points — run npm run seed:tower-c-brain");
}

const [brief] = await sql<{ id: string; formats: string[] }[]>`
  SELECT id, formats FROM campaign_briefs
  WHERE org_id = ${ORG} AND scope_node_id = ${phase.id} AND name = ${BRIEF}`;
if (!brief) throw new Error("Diwali brief missing");

console.log("\n1. Brand kit + logo");
const logo = await sharp({
  create: { width: 400, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([
    {
      input: await sharp({
        create: { width: 160, height: 60, channels: 3, background: { r: 20, g: 60, b: 160 } },
      })
        .png()
        .toBuffer(),
      left: 40,
      top: 30,
    },
  ])
  .png()
  .toBuffer();

await sql`
  INSERT INTO brand_kits (org_id, scope_node_id, sales_phone, website, colour_primary, disclaimer, updated_by)
  VALUES (${ORG}, ${phase.entity_id}, '+919876543210', 'https://sathheights.example', '#1b3a86',
          'Prices valid for 30 days. T&C apply.', ${admin.id})
  ON CONFLICT (scope_node_id) DO UPDATE SET
    sales_phone = EXCLUDED.sales_phone, website = EXCLUDED.website,
    colour_primary = EXCLUDED.colour_primary, disclaimer = EXCLUDED.disclaimer,
    updated_by = EXCLUDED.updated_by, updated_at = now()`;
await sql`DELETE FROM brand_files WHERE org_id = ${ORG} AND scope_node_id = ${phase.entity_id} AND role = 'LOGO_HORIZONTAL'`;
await sql`
  INSERT INTO brand_files (org_id, scope_node_id, role, media, media_type, media_name, uploaded_by)
  VALUES (${ORG}, ${phase.entity_id}, 'LOGO_HORIZONTAL', ${logo}, 'image/png', 'logo.png', ${admin.id})`;
console.log("  brand kit ready");

console.log("\n2. Approved construction photo + RERA lockup QR");
const construction = await sharp({
  create: { width: 1200, height: 1500, channels: 3, background: { r: 120, g: 118, b: 110 } },
})
  .composite([
    // Bare concrete slab bands
    {
      input: await sharp({
        create: { width: 900, height: 180, channels: 3, background: { r: 160, g: 155, b: 145 } },
      })
        .png()
        .toBuffer(),
      left: 150,
      top: 200,
    },
    {
      input: await sharp({
        create: { width: 900, height: 180, channels: 3, background: { r: 140, g: 135, b: 125 } },
      })
        .png()
        .toBuffer(),
      left: 150,
      top: 420,
    },
    {
      input: await sharp({
        create: { width: 900, height: 180, channels: 3, background: { r: 150, g: 148, b: 138 } },
      })
        .png()
        .toBuffer(),
      left: 150,
      top: 640,
    },
    // Scaffold / hazard yellow stripe
    {
      input: await sharp({
        create: { width: 80, height: 1100, channels: 3, background: { r: 230, g: 190, b: 40 } },
      })
        .png()
        .toBuffer(),
      left: 80,
      top: 180,
    },
    {
      input: await sharp({
        create: { width: 80, height: 1100, channels: 3, background: { r: 30, g: 30, b: 30 } },
      })
        .png()
        .toBuffer(),
      left: 1040,
      top: 180,
    },
  ])
  .jpeg({ quality: 88 })
  .toBuffer();

const qrUrl = `https://maharera.maharashtra.gov.in/${phase.registration_no}`;
const lockup = await QRCode.toBuffer(qrUrl, { width: 600, margin: 2, type: "png" });

async function approveAsset(category: string, bytes: Buffer, isRender: boolean, title: string) {
  const [existing] = await sql<{ id: string }[]>`
    SELECT a.id FROM assets a
    JOIN asset_versions v ON v.asset_id = a.id
    JOIN asset_approvals ap ON ap.asset_id = a.id AND ap.sha256 = v.sha256
    WHERE a.org_id = ${ORG} AND a.scope_node_id = ${phase.id} AND a.category = ${category}
    LIMIT 1`;
  if (existing) {
    console.log(`  reuse approved ${category}`);
    return existing.id;
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO assets (org_id, scope_node_id, category, title, is_render, captured_on, uploaded_by)
    VALUES (${ORG}, ${phase.id}, ${category}, ${title}, ${isRender},
            ${category === "CONSTRUCTION" ? today : null}, ${admin.id})
    RETURNING id`;
  const put = await putAsset({
    orgId: ORG,
    kind: "asset",
    id: a.id,
    bytes,
    contentType: bytes[0] === 0xff ? "image/jpeg" : "image/png",
  });
  if (!put.ok) throw new Error(`store ${category}: ${"message" in put ? put.message : "failed"}`);
  const sha = createHash("sha256").update(bytes).digest("hex");
  await sql`
    INSERT INTO asset_versions (org_id, asset_id, version, storage_key, media_type, media_bytes, sha256, uploaded_by)
    VALUES (${ORG}, ${a.id}, 1, ${put.key}, ${bytes[0] === 0xff ? "image/jpeg" : "image/png"}, ${bytes.byteLength}, ${sha}, ${admin.id})`;
  await sql`INSERT INTO asset_approvals (org_id, asset_id, sha256, approved_by)
            VALUES (${ORG}, ${a.id}, ${sha}, ${admin.id})`;
  console.log(`  approved ${category}`);
  return a.id;
}

await approveAsset("CONSTRUCTION", construction, false, "Tower C site progress");
await approveAsset("RERA_LOCKUP", lockup, true, "MahaRERA lockup");
// No exterior is made here: a flat colour approved as "the building" was
// handed to a land to home film on 6 October 2026, and the model invented a
// tower for it. The tower's real renders are already in the library.

console.log("\n3. Write cleared copy (real model)");
let cards = await sql<{ id: string; headline: string; verdict: string; segment: string }[]>`
  SELECT id, headline, verdict, segment FROM campaign_copy
  WHERE org_id = ${ORG} AND brief_id = ${brief.id} AND verdict = 'PASS'
  ORDER BY segment`;
if (cards.length) {
  console.log(`  skip write — ${cards.length} PASS card(s) already exist`);
} else {
  const wrote = await generateBlocks({
    orgId: ORG,
    actorUserId: admin.id,
    briefId: brief.id,
  });
  if (!wrote.ok) throw new Error(`write copy: ${wrote.message}`);
  console.log(`  wrote ${wrote.written} card(s), held ${wrote.held}, failed ${wrote.failed}`);
  cards = await sql<{ id: string; headline: string; verdict: string; segment: string }[]>`
    SELECT id, headline, verdict, segment FROM campaign_copy
    WHERE org_id = ${ORG} AND brief_id = ${brief.id} AND verdict = 'PASS'
    ORDER BY segment`;
}
if (!cards.length) throw new Error("No PASS cards");
const card = cards[0]!;
console.log(`  using card (${card.segment}): ${card.headline}`);

console.log("\n4. Make ONE Construction update image (Meta feed 1:1)");
const started = Date.now();
const made = await makeOnePost({
  orgId: ORG,
  actorUserId: admin.id,
  briefId: brief.id,
  kind: "IMAGE",
  copyId: card.id,
  placement: PLACEMENT,
  template: TEMPLATE,
});
console.log(`  elapsed ${Math.round((Date.now() - started) / 1000)}s`);
mkdirSync(OUT, { recursive: true });

if (!made.ok) {
  console.error(`\nFAIL  make post: [${made.code}] ${made.message}`);
  writeFileSync(join(OUT, "construction-update-error.json"), JSON.stringify(made, null, 2));
  await sql.end();
  await closeDb();
  process.exit(1);
}

console.log(`  post ${made.postId} passed=${made.passed}`);

const [row] = await sql<{ id: string; review: unknown; inputs: unknown; media: unknown }[]>`
  SELECT id, review, inputs, media FROM rendered_posts WHERE id = ${made.postId}`;
writeFileSync(join(OUT, "construction-update-post.json"), JSON.stringify(row ?? null, null, 2));

const media = await postMedia(ORG, made.postId, 0);
if (media?.bytes) {
  const path = join(OUT, "construction-update-meta.jpg");
  writeFileSync(path, media.bytes);
  console.log(`  saved ${path} (${media.bytes.byteLength} bytes)`);
}

const inputs = (row?.inputs ?? {}) as {
  template?: { key?: string; by?: string };
  pictures?: { assetId?: string; sha256?: string }[];
};
const review = row?.review as { passed?: boolean; problems?: { code?: string; text?: string }[] } | null;
const picIds = (inputs.pictures ?? []).map((p) => p.assetId).filter(Boolean) as string[];
const picCats = picIds.length
  ? await sql<{ id: string; category: string }[]>`
      SELECT id, category FROM assets WHERE org_id = ${ORG} AND id = ANY(${picIds})`
  : [];
const usedConstruction = picCats.some((p) => p.category === "CONSTRUCTION");

console.log("\n5. Result vs manager bug");
const tpl = inputs.template?.key ?? "";
console.log(`  template key: ${tpl || "(missing)"}`);
console.log(`  picture categories: ${picCats.map((p) => p.category).join(", ") || "(none)"}`);
console.log(`  used CONSTRUCTION photo: ${usedConstruction}`);
console.log(`  passed checks: ${review?.passed ?? made.passed}`);
if (review?.problems?.length) {
  for (const p of review.problems) console.log(`  note: ${p.code ?? ""} ${p.text ?? ""}`);
}

const ok =
  tpl === TEMPLATE &&
  usedConstruction &&
  (review?.passed ?? made.passed) === true;
console.log(`\n${ok ? "PASS" : "FAIL"}  Construction update ad matches template photo pool and passed.`);
console.log(`  meta ${join(OUT, "construction-update-post.json")}`);
console.log("Done.\n");

await sql.end();
await closeDb();
process.exit(ok ? 0 : 1);
