// Functional check of WhatsApp broadcasts, against the real database, with
// Meta replaced by a fake that answers at the same URLs.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/check-broadcast.mts
//
// Nothing here reaches Meta. The fake takes the picture upload and the
// sends, records every request, and can lose an answer, which is where the
// interesting rules live: a broadcast reaches only the leads the rules
// allow and says why for the rest, every message is a row before it is a
// request, a lost answer is never sent twice, a buyer who says STOP between
// approval and their turn gets nothing, a phase that stops being
// advertisable halts what is left, and the caps hold across the drip.
//
// It builds its own organisation and deletes only that.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import postgres from "postgres";

if (!existsSync(".env.local")) throw new Error("run with --env-file=.env.local");

process.env.META_APP_ID = "4242424242";
process.env.META_APP_SECRET = "check-broadcast-app-secret";
delete process.env.CONNECTOR_KEY;
const STORE = mkdtempSync(join(tmpdir(), "salesdesk-broadcast-"));
process.env.ASSETS_DIR = STORE;

const { useVaultKey } = await import("../src/lib/vault.ts");
const { usePlatform, META_GRAPH_VERSION } = await import("../src/lib/platform.ts");
const { putAsset } = await import("../src/lib/storage.ts");
const BC = await import("../src/lib/broadcast.ts");
const { haltBlocked } = await import("../src/lib/publish.ts");
const { sendMessage, ingestWhatsApp } = await import("../src/lib/messaging.ts");
const SMS = await import("../src/lib/sms.ts");
const { closeDb } = await import("../src/lib/db/index.ts");
const { connectFixtureNumber, dropFixtureNumbers } = await import("./whatsapp-fixture.mts");

useVaultKey(randomBytes(32));
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
const sorted = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

// ---------------------------------------------------------------------------
// The fake Meta
// ---------------------------------------------------------------------------

type Sent = { to: string; template: string; header: string | null; params: string[]; buttons: string[] };
const sent: Sent[] = [];
const uploads: string[] = [];
let loseNext = 0;
let seq = 1;

usePlatform(async (url, init) => {
  const u = new URL(url);
  const path = u.pathname.replace(`/${META_GRAPH_VERSION}/`, "");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (/^\d+\/media$/.test(path)) {
    uploads.push(path);
    return json({ id: `media-${seq++}` });
  }
  if (/^\d+\/messages$/.test(path)) {
    const body = JSON.parse(String(init.body));
    const comps = (body.template?.components ?? []) as { type: string; parameters: { type: string; text?: string; image?: { id: string }; payload?: string }[] }[];
    const record: Sent = {
      to: body.to,
      template: body.template?.name,
      header: comps.find((c) => c.type === "header")?.parameters[0]?.image?.id ?? null,
      params: comps.find((c) => c.type === "body")?.parameters.map((p) => p.text ?? "") ?? [],
      buttons: comps.filter((c) => c.type === "button").map((c) => c.parameters[0]?.payload ?? ""),
    };
    sent.push(record);
    // An answer lost on the way back: Meta sent it, we never heard.
    if (loseNext > 0) {
      loseNext -= 1;
      throw new Error("socket hang up");
    }
    return json({ messaging_product: "whatsapp", messages: [{ id: `wamid.bc.${seq++}` }] });
  }
  return json({ error: { message: `no route for ${path}`, code: 100 } }, 400);
});

// ---------------------------------------------------------------------------
// A tenant of its own: a registered tower, signed facts, a post that clears
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const made = { orgs: [] as string[], users: [] as string[] };
const [admin] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`admin@bc${tag}.example`}, ${`bc${tag}.example`}, 'Broadcast Admin') RETURNING id`;
made.users.push(admin.id);
const [org] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Sath Group', 'Sath Group', 'AAPFU0939F', ${`bc${tag}.example`}, ${admin.id}) RETURNING id`;
const orgId = org.id;
made.orgs.push(orgId);
const [cpOrg] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, created_by, status)
  VALUES ('CHANNEL_PARTNER', 'Keystone Realty', 'Keystone Realty', 'AAKCK1234K', ${admin.id}, 'PENDING_VERIFICATION') RETURNING id`;
const [root] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${orgId}, NULL, 'ORG', 'Sath Group', ${`bc_${tag}`}, ${`bc_${tag}`}::ltree) RETURNING id, path::text AS path`;
const node = async (parent: { id: string; path: string }, kind: string, name: string, slug: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${orgId}, ${parent.id}, ${kind}, ${name}, ${slug}, ${`${parent.path}.${slug}`}::ltree) RETURNING id, path::text AS path`;
  return row;
};
const entity = await node(root, "ENTITY", "Sath Heights LLP", "sath_llp");
const region = await node(entity, "REGION", "Mumbai", "mumbai");
const project = await node(region, "PROJECT", "Sath Heights", "sath_heights");
const tower = await node(project, "PHASE", "Tower C", "tower_c");
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${orgId}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, promoter_name, valid_to, verified_at)
  VALUES (${tower.id}, ${orgId}, 'VERIFIED', 'P52100012345', 'MH', 'Sath Heights LLP', ${FAR}, now())`;
const [bv] = await sql<{ id: string }[]>`
  INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by) VALUES (${orgId}, ${tower.id}, 1, 'DRAFT', ${admin.id}) RETURNING id`;
for (const [k, v] of [
  ["claims.talking_points", "Sea facing from the 18th floor up\nA podium garden"],
  ["claims.never_say", "guaranteed returns"],
  ["claims.location", "Goregaon West"],
] as const) {
  await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value) VALUES (${orgId}, ${bv.id}, ${k}, ${v})`;
}
await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${bv.id}`;
await sql`INSERT INTO brand_kits (org_id, scope_node_id, sales_phone, website, updated_by) VALUES (${orgId}, ${entity.id}, '+919876500000', 'https://sathheights.example', ${admin.id})`;
const [brief] = await sql<{ id: string }[]>`
  INSERT INTO campaign_briefs (org_id, scope_node_id, name, status, objective, languages, formats, cta, audience, updated_by)
  VALUES (${orgId}, ${tower.id}, 'Broadcast Check', 'READY', 'SITE_VISIT', ${["English"]}, ${["Meta feed 1:1", "Hoarding"]},
          'Book a site visit', 'First time buyers', ${admin.id}) RETURNING id`;
const [copy] = await sql<{ id: string }[]>`
  INSERT INTO campaign_copy (org_id, brief_id, scope_node_id, language, segment, headline, body, cta, verdict, model, generated_by)
  VALUES (${orgId}, ${brief.id}, ${tower.id}, 'English', 'END_USER', 'Sea facing homes', 'Sea facing from the 18th floor up.',
          'Book a site visit', 'PASS', 'fixture', ${admin.id}) RETURNING id`;

async function makePost(kind: "IMAGE" | "VIDEO", placement: string) {
  const id = randomUUID();
  const bytes = kind === "VIDEO" ? Buffer.from("fake mp4") : await sharp({ create: { width: 1080, height: 1080, channels: 3, background: { r: 40, g: 90, b: 140 } } }).jpeg().toBuffer();
  const type = kind === "VIDEO" ? "video/mp4" : "image/jpeg";
  const put = await putAsset({ orgId, project: null, kind: "post", id: `${id}-0`, bytes, contentType: type });
  if (!put.ok) throw new Error("could not store a fixture file");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const media = [{ key: put.key, type, width: 1080, height: 1080, bytes: bytes.byteLength, sha256: sha }];
  const pixel = { verdict: "PASS", engine: "fixture", checkedAt: new Date().toISOString(), registrationNo: "P52100012345", files: [{ sha256: sha, frames: 1, verdict: "PASS" }], findings: [] };
  await sql`
    INSERT INTO rendered_posts (id, org_id, brief_id, scope_node_id, copy_id, kind, placement, language, segment, headline, body, cta,
                                media, inputs, review, pixel, created_by)
    VALUES (${id}, ${orgId}, ${brief.id}, ${tower.id}, ${copy.id}, ${kind}, ${placement}, 'English', 'END_USER', 'Sea facing homes',
            'Sea facing from the 18th floor up.', 'Book a site visit', ${sql.json(media)}, ${sql.json({})},
            ${sql.json({ passed: true, attempts: 1, problems: [], model: "fixture" })}, ${sql.json(pixel)}, ${admin.id})`;
  return id;
}

const wa = await connectFixtureNumber(sql, orgId, root.id);
const waMeta = { phone_number_id: wa.phoneNumberId, display_phone_number: "919876501234" };

// Leads, each built to meet one rule.
const lead = async (name: string, phone: string, o: { language?: string; stage?: string; channel?: string; consent?: boolean } = {}) => {
  const [l] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, language, stage, path_stage, exit_reason, enquired_at, last_activity_at)
    VALUES (${orgId}, ${tower.id}, ${name}, ${phone}, 'Website', ${o.channel ?? "WEBSITE"}, ${o.language ?? "en"}, ${o.stage ?? "qualified"},
            ${o.stage === "lost" || o.stage === "nurture" ? "qualified" : o.stage ?? "qualified"},
            ${o.stage === "lost" || o.stage === "nurture" ? "Not interested" : null}, now() - interval '20 days', now() - interval '1 day')
    RETURNING id`;
  if (o.consent !== false) {
    await sql`
      INSERT INTO lead_consents (org_id, phone, channels, wording, source, captured_at)
      VALUES (${orgId}, ${phone}, ${["whatsapp", "call"]}, 'Tick on the form', 'WEBSITE', now() - interval '20 days')`;
  }
  return l.id;
};
const P = (n: number) => `+9190001${String(n).padStart(5, "0")}`;
const L = {
  en: await lead("Priya Sharma", P(1)),
  hi: await lead("Rahul Verma", P(2), { language: "hi" }),
  mr: await lead("Sneha Patil", P(3), { language: "mr" }),
  stopper: await lead("Late Stopper", P(4)),
  promo: await lead("Promo Stopper", P(5)),
  lost: await lead("Lost Buyer", P(6)),
  noConsent: await lead("No Consent", P(7), { consent: false }),
  crm: await lead("From CRM", P(8), { channel: "CRM", consent: false }),
  booked: await lead("Booked Buyer", P(9), { stage: "booked" }),
  lostStage: await lead("Gone Cold", P(10), { stage: "lost" }),
  capped: await lead("Four Nudges", P(11)),
  partner: await lead("Partner Buyer", P(12)),
  us: await lead("NRI Buyer", "+14155550123"),
};
void L.lost;
await sql`INSERT INTO call_suppressions (org_id, phone, reason) VALUES (${orgId}, ${P(6)}, 'SAID_ON_CALL')`;
for (let i = 0; i < 4; i++) {
  await sql`
    INSERT INTO messages (org_id, lead_id, direction, channel, purpose, template, category, body, phone, status, created_at)
    VALUES (${orgId}, ${L.capped}, 'OUT', 'WHATSAPP', 'NURTURE', 'salesdesk_nurture_en', 'MARKETING', 'nudge', ${P(11)}, 'DELIVERED', now() - ${`${i + 2} days`}::interval)`;
}
const [grant] = await sql<{ id: string }[]>`
  INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_to, created_by)
  VALUES (${orgId}, ${cpOrg.id}, ${project.id}, 'CHANNEL_PARTNER', now() + interval '60 days', ${admin.id}) RETURNING id`;
await sql`
  INSERT INTO client_registrations (org_id, cp_org_id, grant_id, scope_node_id, phone, via, verdict, valid_until, status)
  VALUES (${orgId}, ${cpOrg.id}, ${grant.id}, ${project.id}, ${P(12)}, 'CONSOLE', 'REGISTERED', now() + interval '30 days', 'ACTIVE')`;

// Noon in India today: inside the hours, whatever the machine's clock says.
const istToday = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const NOON = new Date(`${istToday}T06:30:00Z`);
const NIGHT = new Date(`${istToday}T17:00:00Z`);

try {
  // -------------------------------------------------------------------------
  console.log("\nWhat a post can be broadcast as");
  const image = await makePost("IMAGE", "Meta feed 1:1");
  const video = await makePost("VIDEO", "Instagram reel 9:16");
  const hoarding = await makePost("IMAGE", "Hoarding");
  const v = await BC.previewBroadcast({ orgId, source: { kind: "STUDIO", postId: video }, stages: [], voice: null, now: NOON });
  check("a video is refused, with what to do instead", [v.ok, (v as { code: string }).code], [false, "PICTURE"]);
  const h = await BC.previewBroadcast({ orgId, source: { kind: "STUDIO", postId: hoarding }, stages: [], voice: null, now: NOON });
  check("and a hoarding", (h as { code: string }).code, "PICTURE");

  console.log("\nWho it reaches, and who it leaves out");
  const pre = await BC.previewBroadcast({ orgId, source: { kind: "STUDIO", postId: image }, stages: [], voice: null, now: NOON });
  if (!pre.ok) throw new Error(`preview refused: ${pre.message}`);
  check("the leads with consent and nothing against them", pre.audience, 5);
  check("every one left out is counted under its reason",
    sorted(Object.fromEntries(pre.excluded.map((e) => [e.code, e.count]))),
    sorted({ OPTED_OUT: 1, NO_CONSENT: 1, PARTNER: 1, CRM_NO_CONSENT: 1, CLOSED: 2, CAP_30D: 1, US_NUMBER: 1 }));
  check("split by the language each will read", sorted(pre.byVoice), sorted({ ENGLISH: 3, HINGLISH: 1, MARATHI: 1 }));
  check("and priced at Meta's price plus 15%", [pre.costPaise, pre.billedPaise], [5 * 87, 5 * 101]);
  check("the line is the post's own cleared words", pre.line, "Sea facing homes. Sea facing from the 18th floor up.");
  check("no phone number anywhere in what the screen is sent", /\+?91900|4155550/.test(JSON.stringify(pre)), false);
  const hindiOnly = await BC.previewBroadcast({ orgId, source: { kind: "STUDIO", postId: image }, stages: [], voice: "HINGLISH", now: NOON });
  check("a language narrows it", hindiOnly.ok && hindiOnly.audience, 1);

  console.log("\nBuilt, approved, frozen");
  const draft = await BC.createBroadcast({ orgId, userId: admin.id, source: { kind: "STUDIO", postId: image }, stages: [], voice: null, now: NOON });
  if (!draft.ok) throw new Error(`draft refused: ${draft.message}`);
  check("a draft sends nothing", (await sql`SELECT 1 FROM broadcast_recipients WHERE broadcast_id = ${draft.broadcastId}`).length, 0);
  const approved = await BC.approveBroadcast({ orgId, userId: admin.id, broadcastId: draft.broadcastId, now: NOON });
  check("approving freezes who it goes to", [approved.ok, approved.ok && approved.audience], [true, 5]);
  check("and approving twice does nothing", (await BC.approveBroadcast({ orgId, userId: admin.id, broadcastId: draft.broadcastId, now: NOON })).ok, false);

  // Between approval and their turn: one buyer says STOP, another taps "Stop promotions".
  await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ id: wa.wabaId, changes: [{ field: "messages", value: { metadata: waMeta,
    messages: [{ id: `in.${tag}.1`, from: P(4).slice(1), timestamp: "1", type: "text", text: { body: "STOP" } }] } }] }] });
  await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ id: wa.wabaId, changes: [{ field: "messages", value: { metadata: waMeta,
    messages: [{ id: `in.${tag}.2`, from: P(5).slice(1), timestamp: "2", type: "button", button: { text: "Stop promotions", payload: "STOP_PROMO:old" } }] } }] }] });
  check("a tap on Stop promotions is a marketing stop, not a full one",
    [(await sql`SELECT 1 FROM message_opt_outs WHERE org_id = ${orgId} AND phone = ${P(5)} AND NOT resumed`).length,
     (await sql`SELECT 1 FROM call_suppressions WHERE org_id = ${orgId} AND phone = ${P(5)}`).length], [1, 0]);

  console.log("\nSending");
  const night = await BC.sendDueBroadcasts({ orgId, now: NIGHT });
  check("nothing goes at night", [night.sent, sent.length], [0, 0]);
  loseNext = 1;
  const first = await BC.sendDueBroadcasts({ orgId, now: NOON });
  check("the rest go, the two who stopped are refused", [first.sent, first.refused], [3, 2]);
  check("the picture went up once, on the developer's number", uploads, [`${wa.phoneNumberId}/media`]);
  const byTo = new Map(sent.map((s) => [s.to, s]));
  check("each buyer reads their own version",
    [byTo.get(P(1).slice(1))?.template.endsWith("_en"), /_(en|mr)$/.test(byTo.get(P(2).slice(1))?.template ?? "_en"), byTo.get(P(3).slice(1))?.template.endsWith("_mr")],
    [true, false, true]);
  check("with the post's picture, their name, the project and the line",
    byTo.get(P(1).slice(1)) && [byTo.get(P(1).slice(1))!.header, byTo.get(P(1).slice(1))!.params],
    ["media-1", ["Priya", "Sath Heights Tower C", "Sea facing homes. Sea facing from the 18th floor up."]]);
  check("and a Stop button that names this broadcast", byTo.get(P(1).slice(1))?.buttons, [`STOP_PROMO:${draft.broadcastId}`]);
  const recips = await sql<{ status: string; refusal: string | null; lead_id: string }[]>`
    SELECT status, refusal, lead_id FROM broadcast_recipients WHERE broadcast_id = ${draft.broadcastId}`;
  const byLead = new Map(recips.map((r) => [r.lead_id, r]));
  check("the refusals are recorded on the recipient",
    [byLead.get(L.stopper)?.refusal, byLead.get(L.promo)?.refusal], ["OPTED_OUT", "MARKETING_STOPPED"]);
  check("and on the lead's own history", (await sql`SELECT 1 FROM messages WHERE lead_id = ${L.promo} AND broadcast_id = ${draft.broadcastId} AND status = 'REFUSED'`).length, 1);
  const lost = await sql<{ status: string }[]>`SELECT m.status FROM broadcast_recipients r JOIN messages m ON m.id = r.message_id
    WHERE r.broadcast_id = ${draft.broadcastId} AND r.status = 'SENT' AND m.provider_id IS NULL`;
  check("an answer lost on the way back leaves the message waiting for its receipt", lost.map((x) => x.status), ["QUEUED"]);
  const before = sent.length;
  await BC.sendDueBroadcasts({ orgId, now: NOON });
  check("and is never sent twice", sent.length, before);
  check("the broadcast is done", (await sql<{ status: string }[]>`SELECT status FROM broadcasts WHERE id = ${draft.broadcastId}`)[0].status, "DONE");

  const [one] = await sql<{ id: string; provider_id: string }[]>`
    SELECT m.id, m.provider_id FROM messages m
    WHERE m.broadcast_id = ${draft.broadcastId} AND m.provider_id IS NOT NULL ORDER BY m.phone LIMIT 1`;
  await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ id: wa.wabaId, changes: [{ field: "messages", value: { metadata: waMeta,
    statuses: [{ id: one.provider_id, status: "delivered", timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: `${orgId}:${one.id}` }] } }] }] });
  const list = await BC.listBroadcasts(orgId, [root.path]);
  check("the Published list counts it", list[0] && [list[0].counts.sent, list[0].counts.delivered, list[0].counts.refused], [3, 1, 2]);

  console.log("\nThe caps, across broadcasts and the drip");
  const again = await BC.previewBroadcast({ orgId, source: { kind: "STUDIO", postId: image }, stages: [], voice: null, now: NOON });
  check("nobody broadcast to this week is broadcast to again", again.ok && Object.fromEntries(again.excluded.map((e) => [e.code, e.count])).CAP_7D, 3);
  await sql`UPDATE leads SET stage = 'nurture', path_stage = 'qualified', exit_reason = 'Not ready yet' WHERE id = ${L.capped}`;
  const nudge = await sendMessage({ orgId, leadId: L.capped, purpose: "NURTURE", nowIso: NOON.toISOString() });
  check("the drip is held to the same four a month", [nudge.ok, (nudge as { code: string }).code], [false, "CAP_30D"]);

  console.log("\nA phase that stops being advertisable halts what is left");
  const second = await BC.createBroadcast({ orgId, userId: admin.id, source: { kind: "STUDIO", postId: image }, stages: [], voice: null, now: NOON });
  // A fresh lead so the second broadcast has somebody to wait for.
  await lead("New Buyer", P(20));
  const second2 = await BC.createBroadcast({ orgId, userId: admin.id, source: { kind: "STUDIO", postId: image }, stages: [], voice: null, now: NOON });
  void second;
  if (!second2.ok) throw new Error("second broadcast refused");
  const ok2 = await BC.approveBroadcast({ orgId, userId: admin.id, broadcastId: second2.broadcastId, now: NOON });
  check("a second broadcast reaches only the new buyer", ok2.ok && ok2.audience, 1);
  await sql`UPDATE registration_records SET status = 'BLOCKED' WHERE scope_node_id = ${tower.id}`;
  await haltBlocked(orgId);
  const halted = (await sql<{ status: string; halted_reason: string }[]>`SELECT status, halted_reason FROM broadcasts WHERE id = ${second2.broadcastId}`)[0];
  check("the kill switch halts it", [halted.status, halted.halted_reason], ["HALTED", "REGISTRATION"]);
  const sentBefore = sent.length;
  await BC.sendDueBroadcasts({ orgId, now: NOON });
  check("and nothing more goes", [sent.length - sentBefore, (await sql<{ status: string }[]>`SELECT status FROM broadcast_recipients WHERE broadcast_id = ${second2.broadcastId}`).map((r) => r.status)], [0, ["CANCELLED"]]);
  await sql`UPDATE registration_records SET status = 'VERIFIED' WHERE scope_node_id = ${tower.id}`;

  const stopped = await BC.stopBroadcast({ orgId, userId: admin.id, broadcastId: second2.broadcastId });
  check("a halted broadcast cannot be stopped again", stopped.ok, false);

  console.log("\nA schedule that broadcasts every approved post");
  const fresh = [await lead("Recent One", P(31)), await lead("Recent Two", P(32)), await lead("Quiet Three", P(30))];
  await sql`UPDATE leads SET last_activity_at = now() - interval '1 hour' WHERE id = ${fresh[0]}`;
  await sql`UPDATE leads SET last_activity_at = now() - interval '2 hours' WHERE id = ${fresh[1]}`;
  const [schedule] = await sql<{ id: string }[]>`
    INSERT INTO post_schedules (org_id, brief_id, scope_node_id, name, mode, days_of_week, day_kinds, at_minute,
                                destinations, broadcast_cap, created_by)
    VALUES (${orgId}, ${brief.id}, ${tower.id}, 'Weekly', 'REVIEW', ${[2]},
            ${[null, null, "IMAGE", null, null, null, null]}::text[], 600, ${["WHATSAPP_BROADCAST"]}::text[], 2, ${admin.id})
    RETURNING id`;
  const at = new Date(NOON.getTime() - 60_000);
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at, state)
    VALUES (${orgId}, ${schedule.id}, ${at}, ${new Date(at.getTime() - 86_400_000)}, ${at}, 'GENERATED') RETURNING id`;
  const [src] = await sql<{ media: { key: string; sha256: string }[]; pixel: unknown }[]>`SELECT media, pixel FROM rendered_posts WHERE id = ${image}`;
  const frame = { ...src.media[0], placement: "Meta feed 1:1" };
  const [creative] = await sql<{ id: string }[]>`
    INSERT INTO post_creatives (org_id, run_id, language, segment, headline, body, cta, verdict, model, template,
                                content_sha256, state, decided_by, decided_at, decided_sha256, kind, media, pixel)
    VALUES (${orgId}, ${run.id}, 'English', 'END_USER', 'Sea facing homes', 'Sea facing from the 18th floor up.', 'Book a site visit',
            'PASS', 'fixture', 'LIST', ${"a".repeat(64)}, 'APPROVED', ${admin.id}, now(), ${"a".repeat(64)}, 'IMAGE',
            ${sql.json([frame])}, ${sql.json(src.pixel as object)})
    RETURNING id`;
  const sentBeforeSchedule = sent.length;
  const pass1 = await BC.sendDueBroadcasts({ orgId, now: NOON });
  check("its time come, the broadcast is built and approved by itself", [pass1.scheduled, pass1.sent], [1, 2]);
  const [sb] = await sql<{ source: string; audience: number; excluded: Record<string, number>; approved_by: string }[]>`
    SELECT source, audience, excluded, approved_by FROM broadcasts WHERE post_creative_id = ${creative.id}`;
  check("to no more than the schedule's limit, the most recently active first",
    [sb?.source, sb?.audience, sb?.excluded.OVER_CAP, sent.slice(sentBeforeSchedule).map((x) => x.to).sort()],
    ["SCHEDULE", 2, 2, [P(31).slice(1), P(32).slice(1)].sort()]);
  check("approved in the name of whoever approved the post", sb?.approved_by, admin.id);
  check("and the post reads as published", (await sql<{ state: string }[]>`SELECT state FROM post_creatives WHERE id = ${creative.id}`)[0].state, "PUBLISHED");
  check("a second pass builds nothing twice", (await BC.sendDueBroadcasts({ orgId, now: NOON })).scheduled, 0);


  console.log("\nSMS, when WhatsApp cannot carry a service message");
  type Sms = { to: string; body: string; header: string; entityId: string; templateId: string };
  const texts: Sms[] = [];
  let smsDown = false;
  SMS.useSms({
    async send(input) {
      if (smsDown) throw new Error("ThrottlingException: slow down");
      texts.push({ to: input.to, body: input.body, header: input.header, entityId: input.entityId, templateId: input.templateId });
      return { id: `aws-${texts.length}` };
    },
  });
  const ENTITY = "1201159178483176795";
  const ACK_EN = "1207161729781542612";
  await SMS.saveSmsSettings({
    orgId, userId: admin.id, nodeId: root.id, entityId: ENTITY, header: "SATHHT",
    templates: [{ purpose: "ACK", voice: "ENGLISH", templateId: ACK_EN }, { purpose: "VISIT_REMINDER_DAY", voice: "ENGLISH", templateId: "1207161729781542613" }],
  });
  const fresh2 = async (name: string, phone: string, language = "en") => {
    const [l] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, language, stage, path_stage, enquired_at, last_activity_at)
      VALUES (${orgId}, ${tower.id}, ${name}, ${phone}, 'Website', 'WEBSITE', ${language}, 'new', 'new', now(), now()) RETURNING id`;
    await sql`
      INSERT INTO lead_consents (org_id, phone, channels, wording, source, captured_at)
      VALUES (${orgId}, ${phone}, ${["whatsapp", "call"]}, 'Tick on the form', 'WEBSITE', now() - interval '1 day')`;
    return l.id;
  };
  const unapprove = (name: string) => sql`UPDATE whatsapp_templates SET status = 'PENDING' WHERE org_id = ${orgId} AND name = ${name}`;
  const reapprove = (name: string) => sql`UPDATE whatsapp_templates SET status = 'APPROVED' WHERE org_id = ${orgId} AND name = ${name}`;

  await unapprove("salesdesk_enquiry_received_en");
  const ackLead = await fresh2("Anita Rao", P(40));
  const ack = await sendMessage({ orgId, leadId: ackLead, purpose: "ACK", nowIso: NOON.toISOString() });
  check("a service message Meta has not approved goes as an SMS", [ack.ok, texts.length], [true, 1]);
  check("from the developer's own DLT registration, header and template",
    [texts[0]?.header, texts[0]?.entityId, texts[0]?.templateId, texts[0]?.to], ["SATHHT", ENTITY, ACK_EN, P(40)]);
  check("in the words registered, filled", texts[0]?.body, "Hi Anita, thank you for your enquiry with Sath Group. Our team will call you after 10 am.");
  const ackRows = await sql<{ channel: string; status: string; cost_paise: number | null; sms_parts: number | null; provider_id: string | null }[]>`
    SELECT channel, status, cost_paise, sms_parts, provider_id FROM messages WHERE lead_id = ${ackLead} ORDER BY created_at`;
  check("the lead's history shows both: WhatsApp refused, the SMS sent",
    ackRows.map((r) => [r.channel, r.status]), [["WHATSAPP", "REFUSED"], ["SMS", "SENT"]]);
  check("priced per part, at AWS's price", [ackRows[1]?.cost_paise, ackRows[1]?.sms_parts, ackRows[1]?.provider_id], [36, 1, "sms:aws-1"]);
  const [smsAudit] = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'message.sms_sent' ORDER BY created_at DESC LIMIT 1`;
  check("audited with the header, the template id and the basis, never the number",
    [smsAudit?.metadata.header, smsAudit?.metadata.dlt_template_id, smsAudit?.metadata.registration, /9190001|Anita/.test(JSON.stringify(smsAudit))],
    ["SATHHT", ACK_EN, "NOT_NAMED", false]);
  check("and metered on the messaging credit",
    (await sql<{ kind: string; qty: string }[]>`SELECT kind, qty FROM usage_events WHERE org_id = ${orgId} AND kind = 'SMS'`).map((u) => [u.kind, Number(u.qty)]),
    [["SMS", 42]]);

  const hiLead = await fresh2("Rakesh Jain", P(41), "hi");
  await unapprove("salesdesk_enquiry_received");
  await sendMessage({ orgId, leadId: hiLead, purpose: "ACK", nowIso: NOON.toISOString() });
  check("a Hinglish buyer with only English registered gets English", texts[1]?.body.startsWith("Hi Rakesh, thank you"), true);

  await unapprove("salesdesk_missed_call");
  const missed = await sendMessage({ orgId, leadId: hiLead, purpose: "MISSED_CALL", nowIso: NOON.toISOString() });
  check("a message that is not on the SMS list never falls back", [missed.ok, texts.length], [false, 2]);
  await reapprove("salesdesk_missed_call");

  await sql`INSERT INTO call_suppressions (org_id, phone, reason) VALUES (${orgId}, ${P(41)}, 'SAID_ON_CALL')`;
  const stopped2 = await sendMessage({ orgId, leadId: hiLead, purpose: "ACK", nowIso: NOON.toISOString() });
  check("an opt-out stops the SMS too", [stopped2.ok, texts.length], [false, 2]);

  smsDown = true;
  const downLead = await fresh2("Down Lead", P(42));
  const down = await sendMessage({ orgId, leadId: downLead, purpose: "ACK", nowIso: NOON.toISOString() });
  check("an SMS AWS would not take is recorded as failed and not counted",
    [down.ok, (await sql<{ status: string; cost_paise: number | null }[]>`SELECT status, cost_paise FROM messages WHERE lead_id = ${downLead} AND channel = 'SMS'`).map((r) => [r.status, r.cost_paise])],
    [false, [["FAILED", null]]]);
  smsDown = false;

  await reapprove("salesdesk_enquiry_received_en");
  const offLead = await fresh2("Not On WhatsApp", P(43));
  const waOk = await sendMessage({ orgId, leadId: offLead, purpose: "ACK", nowIso: NOON.toISOString() });
  const [waMsg] = await sql<{ id: string; provider_id: string }[]>`SELECT id, provider_id FROM messages WHERE lead_id = ${offLead} AND channel = 'WHATSAPP'`;
  const failed131026 = { object: "whatsapp_business_account", entry: [{ id: wa.wabaId, changes: [{ field: "messages", value: { metadata: waMeta,
    statuses: [{ id: waMsg.provider_id, status: "failed", timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: `${orgId}:${waMsg.id}`,
      errors: [{ code: 131026, title: "Message undeliverable" }] }] } }] }] };
  await ingestWhatsApp(failed131026);
  await ingestWhatsApp(failed131026);
  check("a buyer Meta says is not on WhatsApp gets the SMS, once however often Meta says so",
    [waOk.ok, (await sql`SELECT 1 FROM messages WHERE lead_id = ${offLead} AND channel = 'SMS' AND status = 'SENT'`).length], [true, 1]);

  await sql`UPDATE sms_templates SET body_sha256 = ${"0".repeat(64)} WHERE org_id = ${orgId} AND purpose = 'ACK'`;
  await unapprove("salesdesk_enquiry_received_en");
  const before2 = texts.length;
  const reworded = await sendMessage({ orgId, leadId: await fresh2("Reworded", P(44)), purpose: "ACK", nowIso: NOON.toISOString() });
  check("words changed since they were registered: no SMS, and the WhatsApp refusal stands",
    [reworded.ok, (reworded as { code?: string }).code, texts.length - before2], [false, "NOT_APPROVED", 0]);
  await reapprove("salesdesk_enquiry_received_en");
  SMS.useSms(null);

  const audits = await sql<{ action: string; metadata: unknown; target_id: string | null }[]>`
    SELECT action, metadata, target_id FROM audit_log WHERE org_id = ${orgId} AND (action LIKE 'broadcast.%' OR action LIKE 'message.%')`;
  check("the audit trail counts, and names nobody", [audits.some((a) => a.action === "broadcast.approved"), /\+?91900|4155550|Sea facing/.test(JSON.stringify(audits))], [true, false]);
} finally {
  await sql`DELETE FROM broadcast_recipients WHERE org_id = ${orgId}`;
  await sql`UPDATE messages SET broadcast_id = NULL WHERE org_id = ${orgId}`;
  await sql`DELETE FROM broadcasts WHERE org_id = ${orgId}`;
  await sql`DELETE FROM message_opt_outs WHERE org_id = ${orgId}`;
  await sql`DELETE FROM usage_events WHERE org_id = ${orgId}`;
  await dropFixtureNumbers(sql, orgId);
  await sql`DELETE FROM messages WHERE org_id = ${orgId}`;
  await sql`DELETE FROM client_registrations WHERE org_id = ${orgId}`;
  await sql`DELETE FROM grants WHERE org_id = ${orgId}`;
  await sql`DELETE FROM lead_tasks WHERE org_id = ${orgId}`;
  await sql`DELETE FROM leads WHERE org_id = ${orgId}`;
  await sql`DELETE FROM audit_log WHERE org_id = ANY(${[orgId, cpOrg.id]})`;
  await sql`DELETE FROM orgs WHERE id = ${orgId}`;
  await sql`DELETE FROM orgs WHERE id = ${cpOrg.id}`;
  await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  await sql.end();
  await closeDb();
  rmSync(STORE, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
