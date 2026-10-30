/**
 * Learning what works, end to end, with the ad reader injected.
 *
 * The suite builds a tenant of its own with one project in Pune, saves
 * competitor ads through the real function (a picture, a video, one making
 * a claim, one the reader cannot read, one over the month's cap), gives the
 * project two ads of its own with spend and qualified buyers, works the
 * scores out, and reads them back the way the brief, the studio and a
 * schedule do. No model is paid: the reader answers from a queue.
 */
import postgres from "postgres";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { closeDb } from "../src/lib/db/index.ts";
import { addCompetitorAd, listCompetitorAds, readsThisMonth, removeCompetitorAd, useCompetitorReader } from "../src/lib/competitor.ts";
import { learningFor, refreshLearning, saveLearningSettings } from "../src/lib/learning.ts";
import { resolveTemplate } from "../src/lib/templates.ts";
import { seeded } from "../src/lib/learning-rules.ts";
import { COMPETITOR_CAPS } from "../src/lib/competitor-rules.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// The reader, from a queue
// ---------------------------------------------------------------------------

const answers: unknown[] = [];
const asked: { images: number; text: string }[] = [];
let heard = 0;
useCompetitorReader({
  async ask(req) {
    asked.push({ images: req.parts.filter((p) => "image" in p).length, text: req.parts.map((p) => ("text" in p ? p.text : "")).join(" ") });
    const next = answers.shift();
    return next === undefined ? { ok: false, code: "UNREACHABLE", message: "No answer queued." } as never : { ok: true, value: next };
  },
  async hear() {
    heard += 1;
    return { ok: true, text: "Thane station se sirf 8 minute" };
  },
});
const reading = (angle: string, extra: Record<string, unknown> = {}) => ({
  text_seen: "2 & 3 BHK", angle, hook: "BENEFIT", picture: "EXTERIOR", language: "en", price_shown: false,
  price_from_rupees: null, festive: false, design: "01-launch-announcement", locality: "Hinjewadi", risky_claims: [], ...extra,
});

// ---------------------------------------------------------------------------
// A tenant of its own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const [admin] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`admin@learn${tag}.example`}, ${`learn${tag}.example`}, 'Learning Admin') RETURNING id`;
const [org] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Sath Group', 'Sath Group', 'AAPFU0939F', ${`learn${tag}.example`}, ${admin.id}) RETURNING id`;
const orgId = org.id;
const [root] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${orgId}, NULL, 'ORG', 'Sath Group', ${`learn_${tag}`}, ${`learn_${tag}`}::ltree) RETURNING id, path::text AS path`;
const node = async (parent: { id: string; path: string }, kind: string, name: string, slug: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${orgId}, ${parent.id}, ${kind}, ${name}, ${slug}, ${`${parent.path}.${slug}`}::ltree) RETURNING id, path::text AS path`;
  return row;
};
const entity = await node(root, "ENTITY", "Sath Heights LLP", "sath_llp");
const region = await node(entity, "REGION", "Pune", "pune");
const project = await node(region, "PROJECT", "Sath Heights", "sath_heights");
const tower = await node(project, "PHASE", "Tower C", "tower_c");
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${orgId}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const daysAgo = (n: number) => new Date(Date.now() + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
const png = await sharp({ create: { width: 400, height: 500, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer();
const form = (competitor: string, since: string | null) => ({ competitor, projectName: "Rival Towers", locality: "Hinjewadi", platform: "META", runningSince: since ?? "" });
const add = (competitor: string, since: string | null, file = { bytes: png, type: "image/png" }) =>
  addCompetitorAd({ orgId, userId: admin.id, nodeId: tower.id, file, carousel: false, form: form(competitor, since), today });
let marketId: string | null = null;

try {
  console.log("\nSaving a competitor's ad");
  answers.push(reading("CONNECTIVITY"), reading("CONNECTIVITY"), reading("CONNECTIVITY"), reading("VIEW"));
  const first = await add("Kolte Patil", daysAgo(70));
  check("a picture is read and saved", first.ok && first.read, JSON.stringify(first));
  for (const since of [daysAgo(65), daysAgo(90)]) await add("Kolte Patil", since);
  await add("Godrej", daysAgo(3));
  const [row] = await sql<{ tags: Record<string, string>; poster: Buffer; poster_type: string; flags: string[] }[]>`
    SELECT tags, poster, poster_type, flags FROM competitor_ads WHERE id = ${first.ok ? first.id : ""}`;
  check("its ingredients are in our vocabulary", row.tags.angle === "CONNECTIVITY" && row.tags.template === "IMAGE:01-launch-announcement");
  check("the picture kept is a JPEG", row.poster_type === "image/jpeg" && row.poster[0] === 0xff && row.poster[1] === 0xd8);
  const [trail] = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'competitor.ad_added' LIMIT 1`;
  check("the audit row names the kind and where it was seen, never whose ad", !JSON.stringify(trail.metadata).includes("Kolte") && trail.metadata.platform === "META");

  answers.push(reading("PRICE", { text_seen: "Assured returns of 12% a year" }));
  const risky = await add("Shady Builders", daysAgo(120));
  check("an ad with a claim we may not make is saved and flagged", risky.ok && risky.flagged);

  answers.push({ angle: "VIBES" });
  const unread = await add("Unreadable", null);
  check("an ad the reader answered wrongly is kept as not read", unread.ok && !unread.read);

  // A two-second video with sound, made here.
  const dir = await mkdtemp(join(tmpdir(), "learn-"));
  const mp4 = join(dir, "ad.mp4");
  await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-pix_fmt", "yuv420p", mp4]);
  answers.push(reading("CONNECTIVITY"));
  const before = asked.length;
  const video = await add("Kolte Patil", daysAgo(40), { bytes: await readFile(mp4), type: "video/mp4" });
  await rm(dir, { recursive: true, force: true });
  check("a video is read from three frames and what it says", video.ok && video.read && asked[before]?.images === 3 && heard === 1 && asked[before].text.includes("Thane station"));

  // A file that only says it is a picture is refused before the reader is paid.
  const askedBefore = asked.length;
  const notPicture = await add("Not a picture", null, { bytes: Buffer.from("this is not a picture at all, just words"), type: "image/jpeg" });
  check("a file that is not a picture is refused before the reader", !notPicture.ok && asked.length === askedBefore, JSON.stringify(notPicture));

  // The month's cap is asked before the reader is paid.
  await sql`
    INSERT INTO competitor_ads (org_id, scope_node_id, competitor, platform, kind, read_state, created_at)
    SELECT ${orgId}, ${tower.id}, 'Filler', 'META', 'IMAGE', 'READ', now() FROM generate_series(1, ${COMPETITOR_CAPS.pictures - 6})`;
  const calls = asked.length;
  const capped = await add("One too many", null);
  check("past the month's pictures, nothing is read", !capped.ok && asked.length === calls, JSON.stringify(capped));
  await sql`DELETE FROM competitor_ads WHERE org_id = ${orgId} AND competitor = 'Filler'`;

  console.log("\nOur own ads, with money behind them");
  const [conn] = await sql<{ id: string }[]>`INSERT INTO connections (org_id, provider, status, scopes) VALUES (${orgId}, 'META', 'CONNECTED', ${["ads_management"]}) RETURNING id`;
  const [acct] = await sql<{ id: string }[]>`
    INSERT INTO connection_accounts (org_id, connection_id, kind, external_id, name, detail, scope_node_id, daily_cap)
    VALUES (${orgId}, ${conn.id}, 'META_AD_ACCOUNT', 'act_learn', 'Sath ads', ${sql.json({ currency: "INR" })}, ${project.id}, 5000) RETURNING id`;
  const [brief] = await sql<{ id: string }[]>`INSERT INTO campaign_briefs (org_id, scope_node_id, name) VALUES (${orgId}, ${project.id}, 'Launch') RETURNING id`;
  const ownAd = async (kind: string, headline: string, template: string, spendRs: number, qualified: number) => {
    const [post] = await sql<{ id: string }[]>`
      INSERT INTO rendered_posts (org_id, brief_id, scope_node_id, kind, placement, language, segment, headline, body, cta, media, inputs)
      VALUES (${orgId}, ${brief.id}, ${tower.id}, ${kind}, 'Meta feed 1:1', 'en', 'END_USER', ${headline}, 'x', 'Book a visit', '[]'::jsonb,
              ${sql.json({ template: { key: template, by: "person" } })}) RETURNING id`;
    const key = createHash("sha256").update(`${tag}${headline}`).digest("hex");
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO publish_targets (org_id, source, destination, account_id, kind, headline, caption, content_sha256, scope_node_id, phase_id,
                                   idempotency_key, state, daily_budget, rendered_post_id, activated_at, steps)
      VALUES (${orgId}, 'STUDIO', 'META_AD', ${acct.id}, ${kind}, ${headline}, 'x', ${key}, ${tower.id}, ${tower.id}, ${key}, 'ACTIVE', 1000,
              ${post.id}, now(), ${sql.json({ campaign_id: `c_${tag}_${kind}` })}) RETURNING id`;
    await sql`INSERT INTO ad_stats (org_id, publish_target_id, day, spend_paise) VALUES (${orgId}, ${t.id}, ${today}, ${spendRs * 100})`;
    for (let n = 0; n < qualified; n++) {
      await sql`
        INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, publish_target_id, stage, path_stage)
        VALUES (${orgId}, ${tower.id}, 'Buyer', ${`+9198${kind === "CAROUSEL" ? "1" : "2"}${String(n).padStart(7, "0")}`}, 'Meta ad', 'WEBSITE', ${t.id}, 'qualified', 'qualified')`;
    }
  };
  await ownAd("CAROUSEL", "8 min from Hinjewadi metro", "05-reasons-to-buy", 10_000, 24);
  await ownAd("IMAGE", "Sea facing homes", "01-launch-announcement", 10_000, 6);

  const done = await refreshLearning(orgId);
  check("the organisation and the project are scored", done.places === 2, JSON.stringify(done));
  const learnt = await learningFor(orgId, tower.id);
  check("a tower reads its project's scores", learnt.place === "PROJECT" && learnt.scopeNodeId === project.id);
  const car = learnt.scores.find((s) => s.dim === "format" && s.value === "CAROUSEL")!;
  const img = learnt.scores.find((s) => s.dim === "format" && s.value === "IMAGE")!;
  check("carousels brought more qualified buyers for the money here", car.own!.score > 1 && img.own!.score < 1, JSON.stringify({ car, img }));
  const conn2 = learnt.scores.find((s) => s.dim === "angle" && s.value === "CONNECTIVITY")!;
  check("the market leans on connectivity too, and the flagged ad is not counted", conn2.market !== null && !learnt.scores.some((s) => s.dim === "angle" && s.value === "PRICE" && s.market));
  check("against 24 qualified buyers of ours the market counts 20 in 44", Math.abs(conn2.marketWeight - 20 / 44) < 0.01, String(conn2.marketWeight));
  const doLine = learnt.playbook.find((l) => l.tone === "do" && l.dim === "format");
  const pct = Math.round((car.own!.score - 1) * 100);
  check("the playbook says so, with the scores' own number", !!doLine && doLine.text.includes(`${pct}% more qualified buyers`), doLine?.text);

  console.log("\nThe next creative leans on it");
  const picks = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    resolveTemplate({
      picked: null,
      kind: "IMAGE",
      context: { headline: "Sea facing homes", body: "", cta: "", objective: null, hook: null, offers: null, campaign: "Launch", placement: "Meta feed 1:1" },
      driver: async () => ({ ok: true, key: "09-key-highlights" }) as never,
      learned: { scores: learnt.scores, explore: learnt.settings.explore, rand: seeded(`t${i}`) },
    })));
  const byLearning = picks.filter((p) => p.by === "learnt");
  check("most designs are chosen from what has worked, the rest by the model as before",
    byLearning.length >= 18 && picks.some((p) => p.by === "ai"), `${byLearning.length} learnt of 30`);
  check("and the design that has worked is the one most often chosen",
    byLearning.filter((p) => p.key === "01-launch-announcement").length > byLearning.length / 2);

  console.log("\nThe weight, and the shared library");
  await saveLearningSettings({ orgId, userId: admin.id, marketWeight: 0 });
  const ours = (await learningFor(orgId, tower.id)).scores.find((s) => s.dim === "angle" && s.value === "CONNECTIVITY")!;
  check("with the market weighted at nothing, our own results alone decide", ours.marketWeight === 0 && ours.score === ours.own!.score);
  const [lib] = await sql<{ id: string }[]>`
    INSERT INTO market_ads (developer, city, platform, kind, tags, running_since, seen_on)
    VALUES ('Library fixture', 'Pune', 'META', 'IMAGE', '{"angle":"AMENITY","format":"IMAGE"}'::jsonb, ${daysAgo(80)}, ${today}) RETURNING id`;
  marketId = lib.id;
  const listed = await listCompetitorAds(orgId, [root.path]);
  check("Sales Desk's library for the tenant's city is listed beside its own", listed.market.some((m) => m.id === lib.id) && listed.ours.length === 7);
  await refreshLearning(orgId);
  check("and counted in the project's scores", (await learningFor(orgId, tower.id)).scores.some((s) => s.dim === "angle" && s.value === "AMENITY" && s.market));

  console.log("\nRemoving one");
  const readBefore = await readsThisMonth(orgId, project.path);
  const removed = await removeCompetitorAd({ orgId, userId: admin.id, id: risky.ok ? risky.id : "", scopes: [root.path] });
  check("a saved ad can be removed where the person may", removed);
  const readAfter = await readsThisMonth(orgId, project.path);
  check("and the read it cost still counts against the month", readAfter.pictures === readBefore.pictures && readBefore.pictures === 6, JSON.stringify({ readBefore, readAfter }));
  const outside = await removeCompetitorAd({ orgId, userId: admin.id, id: first.ok ? first.id : "", scopes: ["nowhere_else"] });
  check("and not from outside where they may", !outside);
} finally {
  useCompetitorReader(null);
  if (marketId) await sql`DELETE FROM market_ads WHERE id = ${marketId}`;
  await sql`DELETE FROM leads WHERE org_id = ${orgId}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  await sql`DELETE FROM orgs WHERE id = ${orgId}`;
  await sql`DELETE FROM users WHERE id = ${admin.id}`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
