// Functional check of story reels: queueing, the job's lifecycle, the whole
// pipeline (script gate, voice, music, shots, the editor's trim, the edit,
// the review and its repair loop, delivery), with every model injected, and
// one real Remotion render of a tiny reel.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-reel.mts
//
// Like check:compose, it builds its own entity, project and phase with their
// own approved pictures, lockup, logo and brief, stores files in a local
// folder, and drops everything it made at the end.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import postgres from "postgres";
import QRCode from "qrcode";

if (!existsSync(".env.local")) throw new Error("run with --env-file=.env.local");
const STORE = mkdtempSync(join(tmpdir(), "salesdesk-reel-check-"));
process.env.ASSETS_DIR = STORE;

const { enqueueReel, listReels, stopReel } = await import("../src/lib/reel.ts");
const { runReelJob } = await import("../src/lib/reel-jobs.ts");
const { termsFor, istDate } = await import("../src/lib/billing-rules.ts");
const { makeReel } = await import("../src/lib/reel-worker.ts");
const { renderReel, serveFolder } = await import("../src/lib/reel-render.ts");
const { listPosts, readQr } = await import("../src/lib/compose.ts");
const { putAsset } = await import("../src/lib/storage.ts");
const { closeDb } = await import("../src/lib/db/index.ts");
const { checkFrame } = await import("../src/lib/pixel.ts");
const { cleanReading, MAHARERA_RULE } = await import("../src/lib/pixel-rules.ts");

// The pixel gate's reader, faked for the renders and films faked here: they
// carry a QR and no words, so there is nothing for OCR to read. The last
// section reads a real Remotion render with the real reader.
let pixelReads = 0;
const fakePixel = async (_bytes: Buffer, e: Parameters<typeof cleanReading>[0]) => {
  pixelReads++;
  return cleanReading(e);
};

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const [admin] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string }[]>`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  LIMIT 1`;
const [root] = await sql<{ id: string; path: string }[]>`
  SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG'`;
const SLUGS = ["reel_entity", "reel_project", "reel_phase"];
const dropFixtures = async () => {
  // A plan points at its project and does not go with it.
  await sql`DELETE FROM subscriptions WHERE project_id IN (SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS}))`;
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
const entity = await node(root.id, "ENTITY", "Reel Check SPV", "reel_entity", `${root.path}.reel_entity`);
const project = await node(entity.id, "PROJECT", "Reel Check Project", "reel_project", `${entity.path}.reel_project`);
const phase = await node(project.id, "PHASE", "Reel Check Tower", "reel_phase", `${project.path}.reel_phase`);
// An organisation that has bought a plan runs nothing that costs money on a
// project without one, so the fixture project is sold one, the way the
// operator's tool does, with room for every video the suite queues, and it
// goes with the fixtures.
const [billed] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM billing_accounts WHERE org_id = ${org.id}`;
if (billed.n) {
  await sql`
    INSERT INTO subscriptions (org_id, project_id, plan, status, cycle, starts_on, terms)
    VALUES (${org.id}, ${project.id}, 'SCALE', 'ACTIVE', 'MONTHLY', ${istDate(new Date().toISOString())}, ${sql.json({ ...termsFor("SCALE"), allowance: { ...termsFor("SCALE").allowance, VIDEO: 1000 } } as never)})`;
}
const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, promoter_name, valid_to, verified_at)
  VALUES (${phase.id}, ${org.id}, 'VERIFIED', 'P51700066666', 'MH', 'Reel Check SPV', ${FAR}, now())`;
const [bv] = await sql<{ id: string }[]>`
  INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
  VALUES (${org.id}, ${phase.id}, 1, 'DRAFT', ${admin.id}) RETURNING id`;
for (const [k, v] of [
  ["claims.talking_points", "Sea facing from the 18th floor up\nTwo lifts per wing"],
  ["claims.never_say", "guaranteed returns"],
  ["claims.location", "Goregaon West"],
] as const) {
  await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value) VALUES (${org.id}, ${bv.id}, ${k}, ${v})`;
}
await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${bv.id}`;
const solid = (r: number, g: number, b: number, w = 1080, h = 1920) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();
await sql`
  INSERT INTO brand_kits (org_id, scope_node_id, sales_phone, website, colour_primary, disclaimer, updated_by)
  VALUES (${org.id}, ${entity.id}, '+919876500000', 'https://reel.example', '#1b3a86', 'Prices valid for 30 days.', ${admin.id})`;
const approved = async (category: string, bytes: Buffer) => {
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO assets (org_id, scope_node_id, category, title, is_render, uploaded_by)
    VALUES (${org.id}, ${phase.id}, ${category}, ${category.toLowerCase()}, true, ${admin.id}) RETURNING id`;
  const put = await putAsset({ orgId: org.id, project: null, kind: "asset", id: a.id, bytes, contentType: "image/png" });
  if (!put.ok) throw new Error("could not store a fixture picture");
  const sha = createHash("sha256").update(bytes).digest("hex");
  await sql`
    INSERT INTO asset_versions (org_id, asset_id, version, storage_key, media_type, media_bytes, sha256, uploaded_by)
    VALUES (${org.id}, ${a.id}, 1, ${put.key}, 'image/png', ${bytes.byteLength}, ${sha}, ${admin.id})`;
  await sql`INSERT INTO asset_approvals (org_id, asset_id, sha256, approved_by) VALUES (${org.id}, ${a.id}, ${sha}, ${admin.id})`;
};
// Tall pictures, so a property shot is cropped rather than extended.
// Library pictures carry texture: a flat colour reads as blank and a film never uses it (`looksBlank()`).
const textured = (r: number, g: number, b: number, w = 1080, h = 1920) =>
  sharp({ create: { width: w, height: h, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 40 } } }).tint({ r, g, b }).png().toBuffer();
await approved("EXTERIOR_RENDER", await textured(200, 40, 40));
await approved("AMENITY", await textured(40, 160, 60));
await approved("LOBBY", await textured(40, 60, 200));
const QR_TEXT = "https://maharera.maharashtra.gov.in/P51700066666";
await approved("RERA_LOCKUP", await QRCode.toBuffer(QR_TEXT, { width: 600, margin: 2 }));
const [brief] = await sql<{ id: string }[]>`
  INSERT INTO campaign_briefs (org_id, scope_node_id, name, status, objective, languages, formats, cta, audience, updated_by)
  VALUES (${org.id}, ${phase.id}, 'Reel Check Push', 'READY', 'SITE_VISIT', ${["English"]},
          ${["Meta reel 9:16", "Meta feed 1:1", "YouTube 16:9"]}, 'Book a site visit', 'First time buyers', ${admin.id})
  RETURNING id`;
const [card] = await sql<{ id: string }[]>`
  INSERT INTO campaign_copy (org_id, brief_id, scope_node_id, language, segment, headline, body, cta, verdict, model, generated_by)
  VALUES (${org.id}, ${brief.id}, ${phase.id}, 'English', 'END_USER', 'Pehla ghar, samundar ke saath',
          'Sea facing from the 18th floor up.', 'Book a site visit', 'PASS', 'fixture', ${admin.id})
  RETURNING id`;
const [blocked] = await sql<{ id: string }[]>`
  INSERT INTO campaign_copy (org_id, brief_id, scope_node_id, language, segment, headline, body, cta, verdict, model, generated_by)
  VALUES (${org.id}, ${brief.id}, ${phase.id}, 'English', 'NRI', 'Guaranteed returns', 'x', 'y', 'FAIL', 'fixture', ${admin.id})
  RETURNING id`;

// ---------------------------------------------------------------------------
// The models, injected
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "salesdesk-reel-fakes-"));
const ff = (args: string[]) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...args]);
const shot = (o: Record<string, unknown>) => ({ kind: "people", narration: "", caption: "", scene: "A couple at a cafe", action: "she smiles", picture: null, card: null, seconds: 3, ...o });
const SCRIPT = {
  title: "Pehla ghar", mood: "warm", voice: "female", cast: "A couple in their thirties", cta: "Book a site visit",
  shots: [
    shot({ narration: "हर शाम एक सपना", caption: "Har shaam ek sapna", seconds: 3 }),
    shot({ kind: "property", picture: 0, scene: "A slow push-in", narration: "18th floor से समुद्र", caption: "18th floor se samundar" }),
    shot({ kind: "property", picture: 1, scene: "A slow pan" }),
    shot({ scene: "The couple in a car", action: "he laughs", narration: "अब सपना सच", caption: "Ab sapna sach" }),
    shot({ kind: "property", picture: 2, scene: "A slight rise" }),
    shot({ kind: "card", card: "Sea facing from the 18th floor up", seconds: 3 }),
    shot({ scene: "The couple on a walk", action: "they hold hands", narration: "आइए देखिए", caption: "Aaiye dekhiye" }),
  ],
};
let scriptAnswers: unknown[] = [];
let reviewAnswers: unknown[] = [];
const asked: Record<string, number> = {};
let animated: string[] = [];
// What each clip was asked of: the model, and whether a line to lip-sync to went with it.
let clipAsks: { model: string; audio: boolean }[] = [];
// The keyframe check of a presenter shot, scripted; true unless told otherwise.
let presenterChecks: boolean[] = [];
let heardText: string | null = null;
let stills: string[] = [];
const ask = async (req: { name: string; parts: ({ text: string } | { image: unknown })[] }) => {
  asked[req.name] = (asked[req.name] ?? 0) + 1;
  if (req.name === "story_reel") return { ok: true as const, value: scriptAnswers.shift() ?? SCRIPT };
  if (req.name === "shot_check") return { ok: true as const, value: { clean: true, building_matches: true, issue: "" } };
  if (req.name === "presenter_check") {
    const fine = presenterChecks.shift() ?? true;
    return { ok: true as const, value: { building_matches: fine, person_natural: true, issue: fine ? "" : "The tower lost its crown." } };
  }
  return { ok: true as const, value: reviewAnswers.shift() ?? { verdict: "deliver", issues: [] } };
};
// The director, scripted. By default it works the way the pipeline it
// replaced did: the script (drafts from `scriptAnswers` first), the audio,
// every shot filmed at once, a render, the reviewer's named shots filmed
// again, another render, and delivery once one passes. `reelPlan` overrides
// a turn with exact calls.
type Call = { name: string; args: Record<string, unknown> };
let reelPlan: Call[][] = [];
const reelTurns: { calls: Call[]; outputs: { name: string; text: string }[]; task: string }[] = [];
let reelCallNo = 0;
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
const giveUp: Call = { name: "give_up", args: { reason: "It will not pass." } };
const reelTurn = (input: Record<string, unknown>[]): Call[] => {
  const outs = outputsOf(input);
  const last = outs[outs.length - 1];
  if (last?.name === "deliver" && last.text.startsWith("Refused")) return [giveUp];
  const accepted = outs.filter((o) => o.name === "write_script" && o.text.startsWith("Script accepted")).pop();
  const task = String(((input[0] as { content: { text?: string }[] }).content[0]).text ?? "");
  const resumed = /^s\d+ /m.test(task) || task.includes("The accepted script:");
  if (!accepted && !resumed) return [{ name: "write_script", args: (scriptAnswers.shift() ?? SCRIPT) as Record<string, unknown> }];
  const shots = SCRIPT.shots.map((s, i) => ({ id: `s${i + 1}`, kind: s.kind }));
  if (!outs.some((o) => o.name === "prepare_audio" && o.text.startsWith("Audio ready")) && !task.includes("The audio is prepared.")) {
    return [{ name: "prepare_audio", args: { mood: null } }];
  }
  const cut = new Set([
    ...outs.filter((o) => o.name === "make_clip").map((o) => /^(s\d+)t\d+ · /.exec(o.text)?.[1]),
    ...[...task.matchAll(/(s\d+) from s\d+t\d+/g)].map((m) => m[1]),
  ]);
  const toFilm = shots.filter((s) => s.kind !== "card" && !cut.has(s.id));
  if (toFilm.length) return toFilm.map((s) => ({ name: "make_clip", args: { shot: s.id, direction: "" } }));
  const renders = outs.filter((o) => o.name === "render_and_review");
  const lastRender = renders[renders.length - 1];
  if (!lastRender) return [{ name: "render_and_review", args: {} }];
  if (lastRender.text.startsWith("Refused")) return [giveUp];
  if (/ · DELIVERABLE · /.test(lastRender.text)) return [{ name: "deliver", args: {} }];
  const since = outs.slice(outs.indexOf(lastRender) + 1);
  if (since.length) return since.every((o) => o.text.startsWith("Refused")) ? [giveUp] : [{ name: "render_and_review", args: {} }];
  const named = [...lastRender.text.matchAll(/^- (s\d+) \w+ BLOCKER \((regenerate|retrim)\)/gm)].map((m) => m[1]);
  if (!named.length) return [giveUp];
  return [...new Set(named)].map((shot) => ({ name: "make_clip", args: { shot, direction: "Keep hands and faces natural and steady" } }));
};
const reelBrain = async (req: { input: Record<string, unknown>[] }) => {
  const calls = reelPlan.shift() ?? reelTurn(req.input);
  reelTurns.push({
    calls,
    outputs: outputsOf(req.input),
    task: String(((req.input[0] as { content: { text?: string }[] }).content[0]).text ?? ""),
  });
  return {
    ok: true as const,
    output: calls.map((c) => ({ type: "function_call", call_id: `call_${++reelCallNo}`, name: c.name, arguments: JSON.stringify(c.args) })),
    usage: { inputTokens: 2000, cachedTokens: 1000, outputTokens: 150 },
  };
};

let clipNo = 0;
let lastProps: Record<string, unknown> | null = null;
const FAKES = {
  brain: reelBrain,
  pixel: fakePixel,
  ask,
  speak: async () => {
    const f = join(work, `voice-${Date.now()}-${Math.random()}.wav`);
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=3.6", f]);
    return { ok: true as const, bytes: readFileSync(f), type: "audio/wav" };
  },
  still: async (req: { prompt: string }) => {
    stills.push(req.prompt);
    return { ok: true as const, bytes: await solid(90, 90, 90, 944, 1680), type: "image/png" };
  },
  imagine: async () => ({ ok: true as const, bytes: await solid(120, 100, 80, 1024, 1536), type: "image/png" }),
  // A second of stillness, then movement: the slow start the editor cuts.
  animate: async (req: { duration: number; prompt: string; model?: string; audio?: unknown }) => {
    animated.push(req.prompt.slice(0, 40));
    clipAsks.push({ model: req.model ?? "", audio: !!req.audio });
    const f = join(work, `clip-${clipNo++}.mp4`);
    ff([
      "-f", "lavfi", "-i", `color=c=gray:s=270x480:d=1:r=24`,
      "-f", "lavfi", "-i", `testsrc2=s=270x480:d=${req.duration - 1}:r=24`,
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", f,
    ]);
    return { ok: true as const, bytes: readFileSync(f), type: "video/mp4" };
  },
  hear: async () => ({ ok: true as const, text: heardText ?? SCRIPT.shots.map((s) => s.narration).join(" ") }),
  // The edit, faked: the reel's length in a plain video with the QR where the
  // real one sits, so the review's own checks run on something real.
  render: async (props: { width: number; height: number; shots: { frames: number }[]; end: { frames: number } }, out: string) => {
    lastProps = props as unknown as Record<string, unknown>;
    const seconds = (props.shots.reduce((n, s) => n + s.frames, 0) + props.end.frames) / 30;
    const qr = join(work, "qr.png");
    writeFileSync(qr, await sharp(await QRCode.toBuffer(QR_TEXT, { width: 240, margin: 2 })).png().toBuffer());
    ff([
      "-f", "lavfi", "-i", `color=c=0x224466:s=${props.width}x${props.height}:d=${seconds}:r=30`,
      "-i", qr, "-f", "lavfi", "-i", `anullsrc=r=44100:cl=mono`,
      "-filter_complex", "[0:v][1:v]overlay=W-w-60:60,format=yuv420p[v]", "-map", "[v]", "-map", "2:a", "-t", String(seconds),
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", out,
    ]);
  },
};
const reset = () => {
  clipAsks = [];
  presenterChecks = [];
  heardText = null;
  reelPlan = [];
  reelTurns.length = 0;
  scriptAnswers = [];
  reviewAnswers = [];
  animated = [];
  stills = [];
  for (const k of Object.keys(asked)) delete asked[k];
};

// ---------------------------------------------------------------------------
console.log("\nqueueing");
check("a reel is refused for a square size", (await enqueueReel({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta feed 1:1" })).ok, false);
check("and for a card that did not clear", (await enqueueReel({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: blocked.id, placement: "Meta reel 9:16" })).ok, false);
const queued = await enqueueReel({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16" });
check("a vertical reel of a cleared card is queued", queued.ok, true);
check("and the studio sees it waiting", (await listReels(org.id, brief.id)).map((r) => r.state), ["QUEUED"]);
const [storyJob] = queued.ok
  ? await sql<{ format: string; template: string | null; engine: string | null }[]>`
      SELECT format, plan ->> 'template' AS template, plan ->> 'engine' AS engine FROM reel_jobs WHERE id = ${queued.jobId}`
  : [];
check("a narrated story is queued as one Seedance film from its own skill, never the stitched reel",
  [storyJob?.format, storyJob?.template, storyJob?.engine], ["presenter", "story", "film"]);
// Stopped at once: the worker shares this database, and a film costs money.
if (queued.ok) await stopReel(org.id, queued.jobId, admin.id);
const wideQueued = await enqueueReel({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "YouTube 16:9" });
check("a wide YouTube video is queued the same way", wideQueued.ok, true);
if (wideQueued.ok) await stopReel(org.id, wideQueued.jobId, admin.id);

// ---------------------------------------------------------------------------
console.log("\nmaking a reel");
reset();
// The first draft quotes a price nobody signed; the second is clean.
scriptAnswers = [{ ...SCRIPT, shots: SCRIPT.shots.map((s, i) => (i === 0 ? { ...s, caption: "Sirf Rs 45 lakh" } : s)) }, SCRIPT];
// The first review finds a melting hand in s4; the second passes.
reviewAnswers = [
  { verdict: "repair", issues: [{ shot: "s4", kind: "artefact", fix: "regenerate", blocker: true, note: "His hand melts into the car door." }] },
  { verdict: "deliver", issues: [] },
];
const stages: string[] = [];
const made = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16",
  drivers: FAKES, onStage: async (s) => void stages.push(s), recentTracks: [],
});
check("the reel is made", made.ok ? true : made.message, true);
check("a script with an unsigned number is sent back, and the director writes it again",
  [reelTurns[1]?.outputs[0]?.text.startsWith("Refused: the script needs fixing"), reelTurns.filter((t) => t.calls.some((c) => c.name === "write_script")).length],
  [true, 2]);
check("every shot but the card is filmed in one turn", reelTurns.find((t) => t.calls[0]?.name === "make_clip")?.calls.map((c) => c.args.shot),
  ["s1", "s2", "s3", "s4", "s5", "s7"]);
check("every shot but the card is shot and checked", [animated.length >= 6, asked["shot_check"] >= 6], [true, true]);
check("the review's blocker is repaired by redoing that shot only, then reviewed again",
  [asked["reel_review"], made.plan?.rounds.map((r) => r.redo)], [2, [["s4:regenerate"], []]]);
check("music is chosen for the reel", !!made.plan?.music?.file, true);
check("the stages are reported as it goes",
  ["Writing the story", "Recording the narration", "Choosing the music", "Editing the video", "Reviewing the video"].every((s) => stages.includes(s)), true);
const reel = made.ok ? (await listPosts(org.id, brief.id)).find((p) => p.id === made.postId) : null;
check("it is saved as a story reel video post", [reel?.kind, reel?.format, reel?.media[0]?.type, reel?.media[0]?.height], ["VIDEO", "story", "video/mp4", 1920]);
check("with the pixel gate's PASS, from frames of every shot and the end card", [reel?.pixel?.verdict, pixelReads >= 7], ["PASS", true]);
const [row] = made.ok ? await sql<{ review: { passed: boolean; rounds: number } }[]>`SELECT review FROM rendered_posts WHERE id = ${made.postId}` : [];
check("with its review: passed, in two rounds", [row?.review.passed, row?.review.rounds], [true, 2]);

reset();
// A different shot each round, so no shot runs out of redos before the fifth review.
reviewAnswers = ["s2", "s3", "s4", "s5", "s7", "s2"].map((id) => ({ verdict: "repair", issues: [{ shot: id, kind: "artefact", fix: "regenerate", blocker: true, note: "A hand melts." }] }));
const before = (await listPosts(org.id, brief.id)).length;
const stubborn = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", drivers: FAKES,
});
check("a reel that never passes its review stops after five rounds, and is shown as it stands",
  [stubborn.ok, asked["reel_review"], (await listPosts(org.id, brief.id)).length - before], [true, 5, 1]);
const [kept] = stubborn.ok
  ? await sql<{ review: { passed: boolean; rounds: number; problems: { code: string }[] } }[]>`SELECT review FROM rendered_posts WHERE id = ${stubborn.postId}`
  : [];
check("with what was still wrong on its review, never as an error",
  [kept?.review.passed, kept?.review.rounds, (kept?.review.problems ?? []).length > 0, kept?.review.problems[0]?.code], [true, 5, true, "UNRESOLVED"]);
check("a delivered reel leaves no folder behind", [!!made.plan?.scratch && !existsSync(made.plan.scratch), !!stubborn.plan?.scratch && !existsSync(stubborn.plan.scratch)], [true, true]);

// Stopped part way: its folder is kept, so trying again reuses the clips.
reset();
reviewAnswers = [{ verdict: "repair", issues: [{ shot: "s2", kind: "artefact", fix: "regenerate", blocker: true, note: "A hand melts." }] }];
const halt = new AbortController();
const halted = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16",
  drivers: {
    ...FAKES,
    ask: async (req: Parameters<typeof ask>[0]) => {
      const answer = await ask(req);
      if (req.name === "reel_review") halt.abort();
      return answer;
    },
  },
  signal: halt.signal,
});
check("a reel stopped part way saves nothing and keeps its folder",
  [halted.ok ? null : halted.code, !!halted.plan?.scratch && existsSync(halted.plan.scratch)], ["STOPPED", true]);

// Trying again picks up from what was paid for: the script, the voice, every take and cut.
reset();
const resumed = halted.plan?.scratch && halted.plan.script
  ? await makeReel({
      orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", drivers: FAKES,
      resume: { dir: halted.plan.scratch, script: halted.plan.script, music: halted.plan.music, spend: halted.plan.spend, agent: halted.plan.agent },
    })
  : null;
check("a reel tried again is told what already exists, and films nothing it has",
  [resumed?.ok, reelTurns[0]?.task.includes("STARTED BEFORE"), reelTurns[0]?.task.includes("Shots already cut: "), animated.length],
  [true, true, true, 0]);
check("and what the first attempt spent still counts", resumed?.plan?.spend.clipSeconds, halted.plan?.spend.clipSeconds);
if (halted.plan?.scratch) rmSync(halted.plan.scratch, { recursive: true, force: true });

reset();
reviewAnswers = Array.from({ length: 6 }, () => ({ verdict: "repair", issues: [{ shot: "s2", kind: "building", fix: "regenerate", blocker: true, note: "The tower gained floors." }] }));
const same = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", drivers: FAKES,
});
check("a shot the review keeps sending back is filmed at most four times: shown as it stands after four reviews",
  [same.ok, asked["reel_review"], animated.length], [true, 4, 6 + 3]);
if (same.plan?.scratch) rmSync(same.plan.scratch, { recursive: true, force: true });

reset();
const recentPick = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", drivers: FAKES,
  recentTracks: made.plan?.music ? [made.plan.music.file] : [],
});
check("the next reel does not reuse the last reel's music", recentPick.plan?.music?.file !== made.plan?.music?.file, true);

reset();
const wide = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "YouTube 16:9", drivers: FAKES,
});
const [widePost] = wide.ok ? await sql<{ media: { width: number; height: number }[] }[]>`SELECT media FROM rendered_posts WHERE id = ${wide.postId}` : [];
check("a wide YouTube video is made at 1920 by 1080", [wide.ok ? true : wide.message, widePost?.media[0].width, widePost?.media[0].height], [true, 1920, 1080]);
check("its tall approved pictures are extended to the sides, not cropped to a sliver",
  stills.some((p) => p.includes("wide 16:9") && p.includes("left and right")), true);

// A face a person chose sets the captions and cards, and the video records it.
reset();
let renderedFace = "";
const faced = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", font: "cinzel",
  drivers: {
    ...FAKES,
    render: async (props: Parameters<typeof FAKES.render>[0] & { fonts?: { bold: string } }, out: string) => {
      const res = await fetch(props.fonts!.bold).catch(() => null);
      renderedFace = res?.ok ? Buffer.from(await res.arrayBuffer()).toString("latin1") : "";
      return FAKES.render(props, out);
    },
  },
});
const [facedPost] = faced.ok ? await sql<{ font: string | null }[]>`SELECT inputs ->> 'font' AS font FROM rendered_posts WHERE id = ${faced.postId}` : [];
check("a reel in a chosen face is rendered with that face, and says so",
  [faced.ok ? true : faced.message, renderedFace.includes("Sales Desk Cinzel"), facedPost?.font], [true, true, "cinzel"]);
const facedJob = await enqueueReel({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", font: "cinzel" });
const [facedRow] = facedJob.ok ? await sql<{ font: string | null }[]>`SELECT plan ->> 'font' AS font FROM reel_jobs WHERE id = ${facedJob.jobId}` : [];
check("and a queued reel keeps the face until a worker takes it", facedRow?.font, "cinzel");
if (facedJob.ok) await stopReel(org.id, facedJob.jobId, admin.id);

// ---------------------------------------------------------------------------
console.log("\nthe director");
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });
const everyShot = (direction = "") => ["s1", "s2", "s3", "s4", "s5", "s7"].map((shot) => call("make_clip", { shot, direction }));
const lastOut = (turn: number) => reelTurns[turn]?.outputs[reelTurns[turn].outputs.length - 1]?.text ?? "";

reset();
reelPlan = [
  [call("write_script", SCRIPT as unknown as Record<string, unknown>)],
  [call("prepare_audio", { mood: null })],
  [call("make_clip", { shot: "s1", direction: "The couple look up at their new tower" })],
  [call("make_clip", { shot: "s2", direction: "Push in over five seconds, then 2 more" })],
  [call("make_clip", { shot: "s6", direction: "" })],
  everyShot(),
  [call("deliver")],
  [call("render_and_review")],
  [call("trim_clip", { shot: "s2", take: "s2t1", start: 0.5, speed: 2 })],
  [call("trim_clip", { shot: "s2", take: "s2t1", start: 1, speed: 1 })],
  [call("deliver")],
  [call("set_style", { grade: "warm", shots: [{ shot: "s1", transition: "fade", push: 0.04 }, { shot: "s5", transition: "dip", push: 0.5 }] })],
  [call("render_and_review")],
  [call("deliver")],
];
const directed = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", drivers: FAKES,
});
check("a people shot directed toward the building is refused before anything is filmed",
  lastOut(3).startsWith("Refused, and nothing was filmed") && lastOut(3).includes("may not show the building"), true);
check("so is a direction that carries a number", lastOut(4).includes("may not carry a number"), true);
check("a card is set in type, never filmed", lastOut(5).startsWith("Refused: s6 is a card"), true);
check("every filmed take comes back with its motion, its cut and a contact sheet",
  (reelTurns[6]?.outputs.slice(-6) ?? []).every((o) => /^s\dt1 · shot s\d \(\w+\) · take 1 of 4/.test(o.text) && o.text.includes("Motion by half second") && o.text.includes("Cut applied: from")), true);
check("nothing is delivered before it is rendered and reviewed", lastOut(7), "Refused: Render and review the reel first.");
check("a speed that reads as fast motion is refused", lastOut(9).startsWith("Refused: Speed must be between"), true);
check("a trim is applied and checked by the editor's eye", lastOut(10).startsWith("s2 now cut from s2t1, 1.00 s at speed 1.00. Editor's eye: clean"), true);
check("and an edit changed since its render cannot be delivered", lastOut(11), "Refused: The edit has changed since it was rendered. Render and review it again.");
check("the style reaches the edit: the grade, the transitions, a push held to its ceiling",
  [lastProps?.grade, (lastProps?.shots as { id: string; transition: string; push: number }[] | undefined)?.filter((x) => x.transition !== "cut").map((x) => [x.id, x.transition, x.push])],
  ["warm", [["s1", "fade", 0.04], ["s5", "dip", 0.08]]]);
check("and the reel rendered as it stands is delivered", [directed.ok, reelTurns.length], [true, 14]);

// A shot dropped from the middle renumbers the rest, and their takes follow them.
reset();
const withoutFirst = { ...SCRIPT, shots: SCRIPT.shots.slice(1).map((s) => (s.kind === "card" ? { ...s, seconds: 6 } : s)) };
reelPlan = [
  [call("write_script", SCRIPT as unknown as Record<string, unknown>)],
  [call("prepare_audio", { mood: null })],
  everyShot(),
  [call("write_script", withoutFirst as unknown as Record<string, unknown>)],
  [call("prepare_audio", { mood: null })],
  [call("render_and_review")],
  [call("deliver")],
];
const renumbered = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", drivers: FAKES,
});
check("dropping a shot keeps every other shot's paid takes, renumbered, and nothing is filmed again",
  [renumbered.ok ? true : renumbered.message, animated.length, lastOut(6).startsWith("Render 1 of 5")], [true, 6, true]);

// The seconds of video are capped in code, however many takes the director asks for.
reset();
reelPlan = [
  [call("write_script", SCRIPT as unknown as Record<string, unknown>)], [call("prepare_audio", { mood: null })],
  everyShot(), everyShot("Again"), everyShot("Again"), everyShot("Again"), [call("give_up", { reason: "Out of money." })],
];
const capped = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", drivers: FAKES,
});
const cappedOuts = reelTurns[reelTurns.length - 1]?.outputs ?? [];
check("the director is refused video past the reel's spending limit",
  [cappedOuts.some((o) => o.text.startsWith("Refused: this reel has used")), (capped.plan?.spend.clipSeconds ?? 999) <= 100],
  [true, true]);
if (capped.plan?.scratch) rmSync(capped.plan.scratch, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log("\nan agent on camera");
const say = (o: Record<string, unknown>) => shot({ supers: [], ...o });
const PRESENTER = {
  title: "Sea view chahiye?", mood: "uplifting", voice: "female", cta: "Book a site visit",
  cast: "An Indian property advisor in her thirties, navy blazer, hair tied back",
  shots: [
    say({ kind: "presenter", picture: 0, scene: "waist up, facing the camera", action: "she smiles and gestures to the tower", narration: "क्या आप sea view चाहते हैं?", caption: "Sea view chahiye?", supers: ["Sea view chahiye?"] }),
    say({ kind: "property", picture: 0, scene: "A slow push-in", seconds: 5, supers: ["Sea facing, 18th floor up"] }),
    say({ kind: "presenter", picture: 1, scene: "waist up by the pool", action: "a nod", narration: "आइए देखिए", caption: "Aaiye dekhiye", supers: ["Aaiye dekhiye"] }),
    say({ kind: "property", picture: 1, scene: "A slow pan", seconds: 5 }),
    say({ kind: "property", picture: 2, scene: "A slight rise", seconds: 5 }),
    say({ kind: "card", card: "Sea facing from the 18th floor up", seconds: 3 }),
    say({ kind: "presenter", picture: 2, scene: "waist up in the lobby", action: "an open hand", narration: "इस weekend आइए", caption: "Is weekend aaiye", supers: ["Book a site visit"] }),
  ],
};
reset();
heardText = PRESENTER.shots.map((x) => x.narration).join(" ");
presenterChecks = [false];
const presenterShots = ["s1", "s2", "s3", "s4", "s5", "s7"];
reelPlan = [
  [call("write_script", PRESENTER as unknown as Record<string, unknown>)],
  [call("prepare_audio", { mood: null })],
  [call("make_clip", { shot: "s1", direction: "" })],
  [call("make_clip", { shot: "s1", direction: "Keep her lower in the frame" }), ...presenterShots.slice(1).map((shot) => call("make_clip", { shot, direction: "" }))],
  [call("trim_clip", { shot: "s3", take: "s3t1", start: 0.5, speed: 1 })],
  [call("render_and_review")],
  [call("deliver")],
];
const presented = await makeReel({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16",
  format: "presenter", drivers: FAKES,
});
const firstFilming = reelTurns[3]?.outputs.slice(-1) ?? [];
check("a presenter frame that changed the building films nothing, and says so",
  firstFilming.some((o) => o.text.startsWith("Nothing was filmed: the frame with the presenter did not keep the approved building")), true);
check("presenters are lip-synced to their own recorded line by the presenter model; the property is filmed as before",
  [clipAsks.filter((c) => c.model === "alibaba/wan-2.7" && c.audio).length, clipAsks.filter((c) => c.model.startsWith("kwaivgi/kling") && !c.audio).length],
  [3, 3]);
check("a presenter shot is never trimmed, because its lips start with its first frame",
  lastOut(5).startsWith("Refused: a presenter shot is lip-synced from its first frame"), true);
check("the large text reaches the edit, and a presenter's line starts with the shot",
  [(lastProps?.shots as { id: string; supers?: string[] }[] | undefined)?.find((x) => x.id === "s1")?.supers,
    (lastProps?.voice as { from: number }[] | undefined)?.[0]?.from],
  [["Sea view chahiye?"], 0]);
check("the agent on camera is delivered", presented.ok ? true : presented.message, true);
const [presentedRow] = presented.ok ? await sql<{ inputs: { format: string; template: { key: string } } }[]>`
  SELECT inputs FROM rendered_posts WHERE id = ${presented.postId}` : [];
check("and saved as the Agent on camera template", [presentedRow?.inputs.format, presentedRow?.inputs.template.key],
  ["presenter", "17-insta-friendly-agent-describing-property"]);
const queuedPresenter = await enqueueReel({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", format: "presenter" });
const [presenterJob] = queuedPresenter.ok ? await sql<{ format: string }[]>`SELECT format FROM reel_jobs WHERE id = ${queuedPresenter.jobId}` : [];
check("the studio queues an agent on camera as its own kind of job", presenterJob?.format, "presenter");
if (queuedPresenter.ok) await stopReel(org.id, queuedPresenter.jobId, admin.id);

// ---------------------------------------------------------------------------
console.log("\na job, from queue to post");
reset();
// A film from queue to post is driven below, with its own fakes.
check("a stopped job is never claimed", (await runReelJob(org.id, queued.ok ? queued.jobId : "", FAKES)).ok, false);
const second = await enqueueReel({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16" });
check("a queued reel can be stopped before it starts", second.ok ? await stopReel(org.id, second.jobId, admin.id) : null, true);
check("and then never starts", second.ok ? (await runReelJob(org.id, second.jobId, FAKES)).ok : null, false);

// ---------------------------------------------------------------------------
console.log("\nan agent on camera, made in one film");
{
  const { reviseFilm } = await import("../src/lib/reel.ts");
  const { readAsset } = await import("../src/lib/storage.ts");
  const P = (picture: number, line: string, text: string) => ({ kind: "presenter", picture, line, text, shot: "Full body in front of the tower, arms wide, walking toward the camera" });
  const Q = (picture: number, line: string, text: string) => ({ kind: "property", picture, line, text, shot: "A fast drone rise along the facade with motion blur" });
  const FILM = {
    title: "Not seen in Goregaon",
    presenter: "An Indian woman in her late twenties, dark hair in a high ponytail, an emerald green co-ord set and white sneakers",
    voice: "female",
    // The shape of the near-perfect film: ten quick shots, six of them the presenter, sixty-odd words.
    // The presenter stands in the pool deck and the lobby, never in front of the far-off render (0).
    scenes: [
      P(1, "Okay Mumbai, stop scrolling. You have not seen a home like this in Goregaon West.", "You have NOT seen"),
      Q(1, "Wait till you see this view.", ""),
      P(2, "From the 18th floor up, it is sea facing.", "SEA FACING"),
      Q(0, "", "18TH FLOOR UP"),
      P(1, "Now look at this.", ""),
      Q(2, "Every morning starts right here, with the sea.", ""),
      P(1, "Honestly, you have to see it to believe it.", ""),
      Q(1, "", ""),
      P(2, "So what are you waiting for?", ""),
      P(2, "Book a site visit this weekend!", "BOOK A SITE VISIT"),
    ],
  };
  let drafts: unknown[] = [];
  let frames: unknown[] = [];
  let sweeps: unknown[] = [];
  let filmFails: { code: string; message: string }[] = [];
  // A job to stop by hand once its film is asked for, the way the studio's Stop does.
  let stopWhileFilming: string | null = null;
  const films: { prompt: string; images: number; videos: number; job: string | null }[] = [];
  const filmAsk = async (req: { name: string }) => {
    asked[req.name] = (asked[req.name] ?? 0) + 1;
    if (req.name === "film_script") return { ok: true as const, value: drafts.shift() ?? FILM };
    if (req.name === "film_frames") return { ok: true as const, value: frames.shift() ?? { frames: [{ frame: 0, texts: [], building: "matches" }] } };
    if (req.name === "film_sweep") return { ok: true as const, value: sweeps.shift() ?? { frames: [] } };
    return { ok: false as const, code: "AI_FAILED", message: "unexpected" };
  };
  // Seedance, faked: three seconds with sound, and the request remembered.
  const film = async (
    req: { prompt: string; images: unknown[]; videos?: unknown[] },
    opts?: { job?: { requestId: string } | null; onSubmitted?: (j: { requestId: string; statusUrl: string; cancelUrl: null }) => Promise<void>; onWait?: (s: string) => Promise<void> },
  ) => {
    films.push({ prompt: req.prompt, images: req.images.length, videos: req.videos?.length ?? 0, job: opts?.job?.requestId ?? null });
    const refused = filmFails.shift();
    if (refused) return { ok: false as const, ...refused };
    const job = opts?.job ?? { requestId: `req-${films.length}`, statusUrl: "https://example.invalid/status", cancelUrl: null };
    if (!opts?.job) await opts?.onSubmitted?.(job as { requestId: string; statusUrl: string; cancelUrl: null });
    // Stopped by the person after the film was asked for: the service goes on making it.
    if (stopWhileFilming) {
      await stopReel(org.id, stopWhileFilming, admin.id);
      stopWhileFilming = null;
      // The worker hears of the stop on its next poll, as it would live.
      await opts?.onWait?.("in_progress");
      return { ok: false as const, code: "STOPPED", message: "Stopped." };
    }
    const f = join(work, `film-${films.length}.mp4`);
    ff(["-f", "lavfi", "-i", "testsrc2=s=360x640:d=3:r=24", "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]);
    return { ok: true as const, bytes: readFileSync(f), type: "video/mp4", job };
  };
  const heardFilm = async () => ({ ok: true as const, text: FILM.scenes.map((s) => s.line).filter(Boolean).join(" ") });
  // The word fix, faked: what it was handed, and what it says it did.
  const respeakCalls: string[][] = [];
  type Respoken = { ok: true; film: null; report: { fixed: { words: string; heard: string; at: number; reason: "misheard" | "name" }[]; skipped: []; chars: number; takes: number; heardSeconds: number } } | { ok: false; code: string; message: string };
  let respeakNext: Respoken | null = null;
  const respeak = async (inp: { lines: string[] }): Promise<Respoken> => {
    respeakCalls.push(inp.lines);
    const r = respeakNext ?? { ok: true as const, film: null, report: { fixed: [{ words: "scrolling", heard: "strolling", at: 1.4, reason: "misheard" as const }], skipped: [] as [], chars: 40, takes: 1, heardSeconds: 33 } };
    respeakNext = null;
    return r;
  };
  const DRIVERS = { ask: filmAsk, film, hear: heardFilm, pixel: fakePixel, respeak };
  const queueFilm = async () => {
    const q = await enqueueReel({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, copyId: card.id, placement: "Meta reel 9:16", format: "presenter" });
    if (!q.ok) throw new Error(`could not queue a film: ${q.message}`);
    return q.jobId;
  };
  const jobRow = async (id: string) =>
    (await sql<{ state: string; message: string | null; post_id: string | null; plan: Record<string, unknown> | null }[]>`
      SELECT state, message, post_id, plan FROM reel_jobs WHERE id = ${id}`)[0];
  const postRow = async (id: string | null) =>
    (await sql<{ inputs: { format: string; film: { units: number; revisionOf: string | null; raw: string | null; note: string | null; fix: { problems: string[]; made: boolean; delivered: string; firstProblems: string[] } | null } }; review: { passed: boolean; attempts: number; problems: { text: string }[]; notes: string[] }; media: { key: string }[] }[]>`
      SELECT inputs, review, media FROM rendered_posts WHERE id = ${id}`)[0];

  reset();
  // The first draft says a floor nobody signed; the second keeps to the facts.
  drafts = [{ ...FILM, scenes: FILM.scenes.map((s, i) => (i === 2 ? { ...s, line: "From the 20th floor up, it is sea facing." } : s)) }, FILM];
  // Every card of the agent on camera is ours (17 October 2026), so a word the model drew is a word nobody asked for.
  frames = [{ frames: [{ frame: 0, texts: [], building: "matches" }, { frame: 1, texts: ["BOOK A SITE VSIIT"], building: "matches" }] }];
  const firstJob = await queueFilm();
  const firstPlan = (await jobRow(firstJob)).plan;
  check("a film job records what it counts as when it is queued", [firstPlan?.engine, firstPlan?.units], ["film", 1]);
  const firstRun = await runReelJob(org.id, firstJob, FAKES, DRIVERS);
  const first = await jobRow(firstJob);
  const firstPost = await postRow(first.post_id);
  check("the agent on camera is written and checked, filmed, and a mistake its checks found filmed once more to put right",
    [firstRun.ok, first.state, films.length, asked.film_script], [true, "DONE", 2, 2]);
  check("the fix sends the first film back in with what was wrong, the same pictures, and no new script",
    [films[1].videos, films[1].images, films[1].prompt.includes("@Video1 is the previous version"), films[1].prompt.includes('not asked for: "BOOK A SITE VSIIT"')],
    [1, 3, true, true]);
  check("the fixed film is delivered, cleared, as one video, with what the first got wrong on the record",
    [firstPost?.review.passed, firstPost?.review.attempts, firstPost?.inputs.film.units, firstPost?.inputs.film.fix?.delivered,
      firstPost?.inputs.film.fix?.problems.some((x) => x.includes('"BOOK A SITE VSIIT"')), firstPost?.review.notes.some((n) => n.includes("VSIIT"))],
    [true, 2, 1, "fixed", true, false]);
  check("the director and the old presenter pipeline are not used for it", [asked.story_reel ?? 0, asked.presenter_check ?? 0, clipAsks.length], [0, 0, 0]);
  check("only the approved pictures it uses go in: no card of big text (every card is ours), no other creator's frames, no film to redo",
    [films[0].images, films[0].videos, films[0].prompt.includes("@Image4"), films[0].prompt.includes("@Video1"), films[0].prompt.includes("STYLE references")],
    [3, 0, false, false, false]);
  check("and the model is told to draw no words", [films[0].prompt.includes("@Image1 shows only how the big text looks"), films[0].prompt.includes("draw no words")], [false, true]);
  check("the prompt carries the time plan and says the lines as they are said",
    [films[0].prompt.includes("take that time from a shot that does not need it"), films[0].prompt.includes("From the eighteenth floor up, it is sea facing.")], [true, true]);
  check("the film counts as one video and keeps its own copy for a new version",
    [firstPost?.inputs.format, firstPost?.inputs.film.units, !!firstPost?.inputs.film.raw], ["presenter", 1, true]);
  const stored = firstPost ? await readAsset(firstPost.media[0].key) : null;
  const stampedFrame = join(work, "film-frame.png");
  if (stored) {
    writeFileSync(join(work, "film-out.mp4"), stored);
    ff(["-ss", "1.5", "-i", join(work, "film-out.mp4"), "-frames:v", "1", stampedFrame]);
  }
  const meta = stored ? await sharp(readFileSync(stampedFrame)).metadata() : null;
  check("the film is stamped at the placement's size with a QR that scans in the upper-right quarter",
    [meta?.width, meta?.height, stored ? await readQr(readFileSync(stampedFrame), { x: 540, y: 0, w: 540, h: 480 }) : null], [1080, 1920, QR_TEXT]);
  check("the words its voice got wrong are said again before it is stamped, from the script's own lines, and the person is told",
    [respeakCalls.length, respeakCalls[0]?.[0], firstPost?.review.notes.some((n) => n.startsWith('Said again in her voice: "scrolling" (heard as "strolling", 0:01)')),
      (firstPost?.inputs.film as { respeak?: { report?: { fixed?: unknown[] } } } | undefined)?.respeak?.report?.fixed?.length],
    [2, FILM.scenes[0].line, true, 1]);
  const listed = (await listPosts(org.id, brief.id)).find((p) => p.id === first.post_id);
  check("the studio lists it as a film", listed?.film, { units: 1, revision: false });

  // A building the eye says is not the approved one: the film is still kept,
  // because it was paid for whole, and it is not cleared to publish.
  reset();
  frames = [{ frames: [{ frame: 0, texts: ["NOT SEEN"], building: "differs" }] }];
  // And the sweep of the whole film finds a car no approved picture has.
  sweeps = [{ frames: [{ frame: 1, kind: "vehicle", what: "a turquoise sports car" }, { frame: 2, kind: "none", what: "" }] }];
  respeakNext = { ok: false, code: "NO_SEPARATION", message: "Her voice could not be separated from the music on this machine." };
  const secondJob = await queueFilm();
  await runReelJob(org.id, secondJob, FAKES, DRIVERS);
  const secondId = (await jobRow(secondJob)).post_id;
  const secondPost = await postRow(secondId);
  check("a film whose building does not match is filmed once more, and the fix that matches is delivered cleared",
    [secondPost?.review.passed, secondPost?.review.problems.map((p) => p.text), films.length, secondPost?.inputs.film.fix?.firstProblems],
    [true, [], 4, ["A building in the film does not look like its approved picture."]]);
  check("and the studio still shows it", !!secondId && (await listPosts(org.id, brief.id)).some((p) => p.id === secondId), true);
  check("a car no approved picture has, anywhere in the film, is named with its time, and sent to the fix",
    [asked.film_sweep, secondPost?.inputs.film.fix?.problems.includes("The film shows a turquoise sports car at 0:01, which is in none of the approved pictures.")], [2, true]);

  // Our own card (a price, a configuration) goes on over its window, and only then.
  {
    const { stampFilm } = await import("../src/lib/film.ts");
    const { filmCard } = await import("../src/lib/compose.ts");
    const clip = join(work, "card-clip.mp4");
    ff(["-f", "lavfi", "-i", "color=c=0x303030:s=360x640:d=3:r=24", "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    const blank = await sharp({ create: { width: 1080, height: 1920, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const carded = join(work, "card-out.mp4");
    await stampFilm(clip, carded, blank, 1080, 1920, work, [{ png: await filmCard(["1 BHK", "₹1.45 CR"], 1080, 1920), start: 1, end: 2.2 }]);
    const magenta = async (t: number) => {
      const f = join(work, `card-${t}.png`);
      ff(["-ss", String(t), "-i", carded, "-frames:v", "1", f]);
      const { data, info } = await sharp(f).extract({ left: 0, top: 200, width: 1080, height: 500 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let n = 0;
      for (let i = 0; i < info.width * info.height * 3; i += 3) if (data[i] > 200 && data[i + 1] < 90 && data[i + 2] > 90) n++;
      return n;
    };
    check("a card we set is on the film over its own window and nowhere else", [(await magenta(0.5)) === 0, (await magenta(1.6)) > 2000, (await magenta(2.7)) === 0], [true, true, true]);
  }
  check("a word fix that could not run never costs the film, and is not something a second film is asked to fix",
    [!!secondId, secondPost?.inputs.film.fix?.problems.some((x) => x.startsWith("How words were said"))], [true, false]);

  // The fix the service would not make: the first film is delivered, and the fix never asked for again.
  reset();
  frames = [{ frames: [{ frame: 0, texts: ["NOT SEEN"], building: "differs" }] }];
  filmFails = [];
  const noFixJob = await queueFilm();
  const beforeNoFix = films.length;
  // The first film comes back; the fix is refused.
  const realFilm = DRIVERS.film;
  let calls = 0;
  const filmThenRefuse = async (...args: Parameters<typeof realFilm>) => (++calls === 2 ? { ok: false as const, code: "AI_FAILED", message: "no" } : realFilm(...args));
  await runReelJob(org.id, noFixJob, FAKES, { ...DRIVERS, film: filmThenRefuse as typeof realFilm });
  const noFix = await postRow((await jobRow(noFixJob)).post_id);
  check("a fix the service would not make delivers the first film, cleared, and asks no more",
    [(await jobRow(noFixJob)).state, films.length - beforeNoFix, calls, noFix?.inputs.film.fix?.delivered, noFix?.review.passed], ["DONE", 1, 2, "first", true]);

  // A fix that came out worse: the first is kept.
  reset();
  frames = [{ frames: [{ frame: 0, texts: ["NOT SEEN"], building: "matches" }, { frame: 1, texts: ["BOOK A SITE VSIIT"], building: "matches" }] },
    { frames: [{ frame: 0, texts: ["NOT SEEN"], building: "differs" }] }];
  const worseJob = await queueFilm();
  await runReelJob(org.id, worseJob, FAKES, DRIVERS);
  const worse = await postRow((await jobRow(worseJob)).post_id);
  check("a fix that came out worse than the first is not delivered", [worse?.inputs.film.fix?.delivered, worse?.review.problems.length], ["first", 0]);

  // A new version: the person's choice, and never one that changes the building.
  check("a new version that would change the building is refused before it is queued",
    await reviseFilm({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, postId: first.post_id!, note: "Make the tower taller." }),
    { ok: false, message: "A new version can change the presenter, the words' delivery, the text or the camera, never the building." });
  const again = await reviseFilm({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, postId: first.post_id!, note: "Say the last line more slowly." });
  const againPlan = again.ok ? (await jobRow(again.jobId)).plan : null;
  check("a new version is queued, counted as two videos", [againPlan?.units, (againPlan?.revise as { postId?: string; note?: string } | undefined)?.postId, (againPlan?.revise as { note?: string } | undefined)?.note],
    [2, first.post_id, "Say the last line more slowly."]);
  check("and the studio says so", (await listReels(org.id, brief.id)).find((r) => again.ok && r.id === again.jobId)?.revision, true);
  reset();
  if (again.ok) await runReelJob(org.id, again.jobId, FAKES, DRIVERS);
  const revised = again.ok ? await postRow((await jobRow(again.jobId)).post_id) : null;
  const last = films[films.length - 1];
  check("a person's new version is never fixed again by itself", films.filter((f) => f.videos > 0).length >= 1 && revised?.inputs.film.fix === null, true);
  check("the new version sends the first film back in with the note and what the checks found, and writes nothing new",
    [last.videos, last.prompt.includes("@Video1 is the previous version"), last.prompt.includes("Say the last line more slowly."), last.prompt.includes("draw no words"), asked.film_script ?? 0],
    [1, true, true, true, 0]);
  check("and is saved as a new version worth two videos", [revised?.inputs.film.units, revised?.inputs.film.revisionOf], [2, first.post_id]);

  // A worker that died while the film was being made waits for that film
  // rather than paying for another.
  reset();
  const resumedJob = await queueFilm();
  await sql`UPDATE reel_jobs SET plan = ${sql.json({ engine: "film", units: 1, script: FILM, film: { job: { requestId: "req-lost", statusUrl: "https://example.invalid/s", cancelUrl: null }, requests: 1 }, spend: { drafts: 1, asks: 0 } })} WHERE id = ${resumedJob}`;
  const before = films.length;
  await runReelJob(org.id, resumedJob, FAKES, DRIVERS);
  check("a film already asked for is waited for, not asked for again, and the script is not written again",
    [films.length - before, films[films.length - 1].job, asked.film_script ?? 0, (await jobRow(resumedJob)).state], [1, "req-lost", 0, "DONE"]);

  // A script that will not keep to the facts is never filmed.
  reset();
  const bad = { ...FILM, scenes: FILM.scenes.map((s, i) => (i === 2 ? { ...s, line: "From the 20th floor up, it is sea facing." } : s)) };
  drafts = [bad, bad, bad];
  const refusedJob = await queueFilm();
  const beforeRefused = films.length;
  await runReelJob(org.id, refusedJob, FAKES, DRIVERS);
  const refusedRow = await jobRow(refusedJob);
  check("three drafts that break the facts film nothing and say why",
    [refusedRow.state, films.length - beforeRefused, asked.film_script, (refusedRow.message ?? "").startsWith("The script could not be kept to the approved facts")], ["FAILED", 0, 3, true]);

  // Out of credit at the video service: said plainly, and not counted as a film asked for.
  reset();
  filmFails = [{ code: "OUT_OF_CREDITS", message: "AI generation is paused because our usage limit has been reached. Please try again later." }];
  const brokeJob = await queueFilm();
  await runReelJob(org.id, brokeJob, FAKES, DRIVERS);
  const broke = await jobRow(brokeJob);
  check("a film the service would not make fails with its reason, and nothing is saved", [broke.state, broke.post_id, broke.message],
    ["FAILED", null, "AI generation is paused because our usage limit has been reached. Please try again later."]);

  // A card put away stays away, and trying the job again brings it back.
  const { dismissReel, retryReel } = await import("../src/lib/reel.ts");
  check("a failed video's card, dismissed, stays away on the next load",
    [await dismissReel(org.id, brokeJob), (await listReels(org.id, brief.id)).some((r) => r.id === brokeJob)], [true, false]);
  const waiting = await queueFilm();
  check("a video still being made cannot be dismissed, only stopped", await dismissReel(org.id, waiting), false);
  await stopReel(org.id, waiting, admin.id);

  // Stopped while the film was being made: the film is kept by its request,
  // and trying again collects it instead of paying for another.
  reset();
  const stoppedJob = await queueFilm();
  stopWhileFilming = stoppedJob;
  const beforeStop = films.length;
  await runReelJob(org.id, stoppedJob, FAKES, DRIVERS);
  const stoppedRow = await jobRow(stoppedJob);
  check("a film stopped while it was being made keeps its request and says it is still being made",
    [stoppedRow.state, !!(stoppedRow.plan?.film as { job?: unknown } | undefined)?.job, (stoppedRow.message ?? "").includes("Try again collects it")],
    ["STOPPED", true, true]);
  await retryReel(org.id, stoppedJob, admin.id);
  await runReelJob(org.id, stoppedJob, FAKES, DRIVERS);
  check("and trying again collects that film: one request, no second film paid for",
    [films.length - beforeStop, films[films.length - 1].job, (await jobRow(stoppedJob)).state], [2, films[beforeStop].job ?? `req-${beforeStop + 1}`, "DONE"]);
}

// ---------------------------------------------------------------------------
console.log("\nthe real edit, rendered by Remotion");
const tiny = mkdtempSync(join(tmpdir(), "salesdesk-reel-render-"));
ff(["-f", "lavfi", "-i", "testsrc2=s=540x960:d=2:r=30", "-pix_fmt", "yuv420p", join(tiny, "c.mp4")]);
writeFileSync(join(tiny, "qr.png"), await QRCode.toBuffer(QR_TEXT, { width: 300, margin: 2 }));
copyFileSync(join("assets", "fonts", "NotoSans-Regular.ttf"), join(tiny, "r.ttf"));
const server = await serveFolder(tiny);
const out = join(tiny, "out.mp4");
await renderReel({
  width: 1080, height: 1920, fps: 30,
  shots: [
    { id: "s1", kind: "presenter", src: server.base + "c.mp4", trimBefore: 0, rate: 1, frames: 30, caption: "Har shaam ek sapna", card: null, supers: ["Sea view chahiye?"], transition: "dip", push: 0.04 },
    { id: "s2", kind: "card", src: null, trimBefore: 0, rate: 1, frames: 15, caption: "", card: "Sea facing" },
  ],
  end: { frames: 15, cta: "Book a site visit", phone: "+91 98765 00000", website: "reel.example" },
  voice: [], music: null,
  brand: { colour: "#1b3a86", logo: null, qr: server.base + "qr.png", registrationNo: "P51700066666", reraWebsite: "maharera.maharashtra.gov.in", smallPrint: "Artist's impression." },
  fonts: { regular: server.base + "r.ttf", bold: server.base + "r.ttf" },
}, out);
await server.close();
const probe = JSON.parse(execFileSync(FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1"), ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", out]).toString()) as { format: { duration: string }; streams: { width?: number; height?: number }[] };
check("Remotion renders the reel at its size and length, large text and all", [probe.streams.find((s) => s.width)?.width, Math.abs(Number(probe.format.duration) - 2) < 0.2], [1080, true]);
const mid = join(tiny, "mid.png");
ff(["-ss", "0.5", "-i", out, "-frames:v", "1", mid]);
check("with the MahaRERA QR scannable on the shot", await readQr(readFileSync(mid), { x: 600, y: 0, w: 480, h: 420 }), QR_TEXT);
// The real pixel gate on the real overlay: the block, over a busy picture,
// reads back and is readable, and the small print is there.
const reelExpect = {
  registrationNo: "P51700066666", authority: MAHARERA_RULE, qrPayload: QR_TEXT, phone: null, website: null,
  render: true, contact: false, configurations: [], money: [], registrationDaysLeft: 400,
};
const reelFindings = await checkFrame(readFileSync(mid), reelExpect);
check("and the pixel gate reads its registration block and small print, and passes it", reelFindings.map((f) => f.code), []);

// The same edit, wide: the registration block must still sit in the corner and scan.
const wideServer = await serveFolder(tiny);
const wideOut = join(tiny, "wide.mp4");
await renderReel({
  width: 1920, height: 1080, fps: 30,
  shots: [{ id: "s1", kind: "property", src: wideServer.base + "c.mp4", trimBefore: 0, rate: 1, frames: 30, caption: "Har shaam ek sapna", card: null }],
  end: { frames: 15, cta: "Book a site visit", phone: "+91 98765 00000", website: "reel.example" },
  voice: [], music: null,
  brand: { colour: "#1b3a86", logo: null, qr: wideServer.base + "qr.png", registrationNo: "P51700066666", reraWebsite: "maharera.maharashtra.gov.in", smallPrint: "Artist's impression." },
  fonts: { regular: wideServer.base + "r.ttf", bold: wideServer.base + "r.ttf" },
}, wideOut);
await wideServer.close();
const wideMid = join(tiny, "wide-mid.png");
ff(["-ss", "0.5", "-i", wideOut, "-frames:v", "1", wideMid]);
check("a wide render keeps the MahaRERA QR scannable in its upper-right corner",
  await readQr(readFileSync(wideMid), { x: 1060, y: 0, w: 860, h: 400 }), QR_TEXT);
rmSync(tiny, { recursive: true, force: true });

// ---------------------------------------------------------------------------
await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND (action LIKE 'creative.reel_%' OR action = 'creative.pixel_checked')
            AND (target_id = ${brief.id} OR target_id IN (SELECT id::text FROM rendered_posts WHERE brief_id = ${brief.id})
                 OR target_id IN (SELECT id::text FROM reel_jobs WHERE brief_id = ${brief.id}))`;
await dropFixtures();
rmSync(STORE, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
await sql.end();
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
