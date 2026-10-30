// Functional check of scheduled posts, against the real database, with the
// copy model replaced by an injected driver.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-posts.mts
//
// What this suite is about is the machine around the copy, not the copy: that
// a slot fires once however many workers see it, that a lease stops two of
// them doing the same work, that a run refuses cheaply before it spends
// anything, that nothing reaches a buyer without a person, and that a post
// nobody looked at expires rather than slipping into tomorrow beside
// tomorrow's own.
//
// The model is injected for the reason `check:studio` gives: the interesting
// cases are what happens when the copy comes back wrong, and waiting for a
// real model to eventually invent a price is not a test.
//
// The suite builds its own entity, project and phase and drops them at the
// end. It never touches the organisation's own campaigns, and every count it
// asserts is scoped to its own fixture rather than to the tenant, because an
// assertion that counts rows across an organisation passes only on an empty
// database.
import { existsSync } from "node:fs";
import postgres from "postgres";
import {
  approveCreative,
  claimRun,
  createSchedule,
  executeRun,
  expireStale,
  listCreatives,
  listOccasions,
  listRuns,
  listSchedulesForBrief,
  materialiseRuns,
  rejectCreative,
  reviewQueue,
  runDue,
  saveSchedule,
  setOptIns,
  startSchedule,
  stopSchedule,
  type ScheduleInput,
} from "../src/lib/post.ts";
import { closeDb, withTenant } from "../src/lib/db/index.ts";
import { istCivil, nextSlotAfter } from "../src/lib/post-rules.ts";
import { looseStyle } from "../src/lib/plan-rules.ts";
import type { CopyDriver } from "../src/lib/generate.ts";

// This suite is about schedules, not pictures. A post a run tries to design
// is refused here rather than sent to a paid model.
const NO_DESIGN = {
  design: async () => ({ ok: false as const, code: "NO_KEY", message: "Not in this suite." }),
  brain: async () => ({ ok: false as const, code: "NO_KEY", message: "Not in this suite." }),
  choose: async () => ({ ok: false as const, code: "NO_KEY", message: "Not in this suite." }),
};

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
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

const SLUGS = ["posts_entity", "posts_project", "posts_phase"];
const dropFixtures = async () => {
  await sql`DELETE FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS})`;
};
await dropFixtures();

// The tenant's own opt-ins are restored at the end, because this suite is
// allowed to build its own subtree and is not allowed to change a setting
// that belongs to the whole organisation.
const priorOptIns = (
  await sql<{ occasion_key: string }[]>`
    SELECT occasion_key FROM occasion_opt_ins WHERE org_id = ${org.id}`
).map((r) => r.occasion_key);

const node = async (parent: string, kind: string, name: string, slug: string, path: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, ${parent}, ${kind}, ${name}, ${slug}, ${path}::ltree)
    RETURNING id, path::text AS path`;
  return row;
};
const entity = await node(root.id, "ENTITY", "Posts Check SPV", "posts_entity",
  `${root.path}.posts_entity`);
const project = await node(entity.id, "PROJECT", "Posts Check Project", "posts_project",
  `${entity.path}.posts_project`);
const phase = await node(project.id, "PHASE", "Posts Check Tower", "posts_phase",
  `${project.path}.posts_phase`);

const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no,
                                    state_code, promoter_name, valid_to, verified_at)
  VALUES (${phase.id}, ${org.id}, 'VERIFIED', 'P51700077777', 'MH',
          'Posts Check SPV', ${FAR}, now())`;

// A published Brain on the PHASE. The readiness gate asks for one at the
// phase specifically, because the RERA group only exists there.
const publishBrainAt = async (nodeId: string) => {
  const [version] = await sql<{ id: string }[]>`
    INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
    VALUES (${org.id}, ${nodeId}, 1, 'DRAFT', ${admin.id})
    RETURNING id`;
  const FACTS: [string, string][] = [
    ["claims.talking_points", "Nine minutes from the metro\nThree sided open plot"],
    ["claims.never_say", "guaranteed returns\nassured rental"],
    ["claims.location", "Goregaon West"],
    ["claims.possession_date", "2029-06-30"],
    ["price.booking_amount", "500000"],
  ];
  for (const [key, value] of FACTS) {
    await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value)
              VALUES (${org.id}, ${version.id}, ${key}, ${value})`;
  }
  await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now()
            WHERE id = ${version.id}`;
};
await publishBrainAt(phase.id);

// A brand kit on the fixture's own entity, so the branded gate resolves here
// without touching whatever the organisation has set at its root.
await sql`
  INSERT INTO brand_kits (org_id, scope_node_id, sales_phone, sales_email,
                          disclaimer, updated_by)
  VALUES (${org.id}, ${entity.id}, '+919876500000', 'sales@example.com',
          'Artist impression. Subject to approvals.', ${admin.id})`;
await sql`
  INSERT INTO brand_files (org_id, scope_node_id, role, media, media_type,
                           media_name, uploaded_by)
  VALUES (${org.id}, ${entity.id}, 'LOGO_HORIZONTAL',
          ${Buffer.from([0x89, 0x50, 0x4e, 0x47])}, 'image/png', 'logo.png',
          ${admin.id})`;

const [brief] = await sql<{ id: string }[]>`
  INSERT INTO campaign_briefs (org_id, scope_node_id, name, status, objective,
                               languages, formats, cta, audience, updated_by)
  VALUES (${org.id}, ${phase.id}, 'Posts Check Push', 'READY', 'SITE_VISIT',
          ${["English"]}, ${["Meta feed 1:1"]}, 'Book a site visit',
          'First time buyers', ${admin.id})
  RETURNING id`;

const CLEAN = {
  headline: "Nine minutes from the metro",
  body: "A three sided open plot, and a home to grow into.",
  cta: "Book a site visit",
};
const saying = (copy: Record<string, string>): CopyDriver => async () => ({ ok: true, copy });

const baseInput = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  name: "Posts check cadence",
  mode: "REVIEW",
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  atMinute: 600,
  leadMinutes: 1440,
  maxRunsPerDay: 24,
  startsOn: null,
  endsOn: null,
  ...over,
});

// ---------------------------------------------------------------------------
console.log("\nwriting a schedule");

const made = await createSchedule({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, input: baseInput(),
});
check("a schedule is written", made.ok, true);
const scheduleId = made.ok ? made.scheduleId : "";

// AUTO approves posts nobody looked at, so with nowhere to publish them it
// would be a control that does nothing. It is refused, and it says so.
const auto = await createSchedule({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  input: baseInput({ name: "Auto", mode: "AUTO" }),
});
check("sending automatically with nowhere to send is refused", auto.ok, false);
check("and it says so rather than failing quietly",
  auto.ok ? null : auto.code, "AUTO_NOWHERE");

// With a destination it is saved as AUTO. Removed at once, so the counts
// and runs below see the one REVIEW schedule they were written for.
const autoOk = await createSchedule({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  input: baseInput({ name: "Auto", mode: "AUTO", destinations: ["INSTAGRAM"] }),
});
check("sending automatically to a destination is saved", autoOk.ok, true);
const autoId = autoOk.ok ? autoOk.scheduleId : "";
if (autoOk.ok) {
  const [row] = await sql<{ mode: string }[]>`
    SELECT mode FROM post_schedules WHERE id = ${autoOk.scheduleId}`;
  check("as AUTO", row?.mode, "AUTO");
  await sql`DELETE FROM post_schedules WHERE id = ${autoOk.scheduleId}`;
}

const nameless = await createSchedule({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id, input: baseInput({ name: "  " }),
});
check("a schedule with nothing in the name is refused", nameless.ok, false);

const listed = await listSchedulesForBrief(org.id, brief.id);
check("it comes back on the brief", listed.length, 1);
check("running", listed[0]?.active, true);
check("carrying the tower it resolves against", listed[0]?.nodeName, "Posts Check Tower");
check("and the next time it fires", typeof listed[0]?.nextSlot, "string");

// ---------------------------------------------------------------------------
// A scheduler that fires twice is ordinary: a retry, two workers, a deploy
// mid-cycle. This one calls paid models, so the second fire has to insert
// nothing rather than usually lose a race.
// ---------------------------------------------------------------------------
console.log("\na slot fires once, however many workers see it");

const now = new Date();
const created = await materialiseRuns({ orgId: org.id, now });
check("the due slots get their rows", created > 0, true);

const again = await materialiseRuns({ orgId: org.id, now });
check("and asking a second time creates nothing", again, 0);

// Two workers arriving together, which is the case the unique index exists
// for. Both compute the same slot and one of them writes it.
const [a, b] = await Promise.all([
  materialiseRuns({ orgId: org.id, now }),
  materialiseRuns({ orgId: org.id, now }),
]);
check("nor do two at once", a + b, 0);

const runs = await listRuns(org.id, { scheduleId });
check("the run is pending", runs[0]?.state, "PENDING");
const runId = runs[0]?.id ?? "";

// ---------------------------------------------------------------------------
console.log("\nwork is claimed, not started");

const claim = await claimRun({ orgId: org.id, runId });
check("a worker takes the lease", claim.ok, true);

const second = await claimRun({ orgId: org.id, runId });
check("and a second worker is refused while it is live", second.ok, false);

// A worker that died must not freeze the slot forever, and the expiry is what
// makes that a rule rather than a hope.
await sql`UPDATE post_runs SET lease_until = now() - interval '1 minute'
          WHERE id = ${runId}`;
const afterDeath = await claimRun({ orgId: org.id, runId });
check("an expired lease may be taken", afterDeath.ok, true);

// A run that crashes the same way three times must not be retried forever.
await sql`UPDATE post_runs SET attempts = 3, lease_until = NULL WHERE id = ${runId}`;
check("a run that has failed three times is left alone",
  (await claimRun({ orgId: org.id, runId })).ok, false);
await sql`UPDATE post_runs SET attempts = 0, state = 'PENDING', lease_until = NULL
          WHERE id = ${runId}`;

// ---------------------------------------------------------------------------
console.log("\nthe run, and what it refuses before spending anything");

let asked = 0;
const counting = (copy: Record<string, string>): CopyDriver => async () => {
  asked += 1;
  return { ok: true, copy };
};

// A phase nobody may advertise has nothing lawful to write, so the refusal
// comes before the model is ever called.
await sql`UPDATE registration_records SET status = 'BLOCKED', registration_no = NULL,
          valid_to = NULL WHERE scope_node_id = ${phase.id}`;
const blocked = await executeRun({ designers: NO_DESIGN,
  orgId: org.id, runId, actorUserId: admin.id, driver: counting(CLEAN),
});
check("an unadvertisable phase is refused", blocked.ok, false);
check("with the reason recorded", blocked.ok ? null : blocked.code, "NOT_ADVERTISABLE");
check("and nothing was written to a model", asked, 0);
await sql`UPDATE registration_records SET status = 'VERIFIED',
          registration_no = 'P51700077777', valid_to = ${FAR}
          WHERE scope_node_id = ${phase.id}`;

// A refusal is a state a person can see and act on, not a silent nothing.
const refusedRun = (await listRuns(org.id, { scheduleId })).find((r) => r.id === runId);
check("the refusal is on the run", refusedRun?.state, "REFUSED");
check("in the product's own words rather than a code",
  refusedRun?.refusalDetail, "Not registered yet, so it can't be advertised.");

// A stopped schedule refuses the runs already sitting in front of it.
await stopSchedule({
  orgId: org.id, actorUserId: admin.id, scheduleId, reason: "Election code of conduct",
});
check("stopping refuses what has not been written",
  (await listSchedulesForBrief(org.id, brief.id))[0]?.active, false);
check("and says why", (await listSchedulesForBrief(org.id, brief.id))[0]?.stoppedReason,
  "Election code of conduct");
await startSchedule({ orgId: org.id, actorUserId: admin.id, scheduleId });

// ---------------------------------------------------------------------------
console.log("\na run that writes");

const fresh = async (): Promise<string> => {
  const slot = new Date(Date.now() + 3 * 3_600_000);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at)
    VALUES (${org.id}, ${scheduleId}, ${slot}, ${new Date()}, ${slot})
    RETURNING id`;
  return row.id;
};

const goodRun = await fresh();
const wrote = await executeRun({ designers: NO_DESIGN,
  orgId: org.id, runId: goodRun, actorUserId: admin.id, driver: saying(CLEAN),
});
check("the run writes a block per buyer", wrote.ok ? wrote.written : null, 4);
check("and every one of them clears", wrote.ok ? wrote.passed : null, 4);

const creatives = await listCreatives(org.id, goodRun);
check("the creatives come back", creatives.length, 4);
check("waiting on a person, because the mode is review",
  [...new Set(creatives.map((c) => c.state))], ["DRAFT"]);
// Every other approval in this product pins a part. This is the one that
// pins what actually reaches a buyer.
check("each one records what it was built from",
  creatives.every((c) => c.inputCount > 0), true);
check("and which shape it was written in",
  creatives.every((c) => c.template.length > 0), true);

// The gate runs on what came back, not on what was asked for. The prompt
// carried the never-say list either way.
const dirty = await fresh();
await executeRun({ designers: NO_DESIGN,
  orgId: org.id, runId: dirty, actorUserId: admin.id,
  driver: saying({ ...CLEAN, body: "Guaranteed returns on every unit." }),
});
const refusedCopy = await listCreatives(org.id, dirty);
check("a banned phrase is refused however it was asked for",
  [...new Set(refusedCopy.map((c) => c.verdict))], ["FAIL"]);
check("and the refusal is kept rather than dropped", refusedCopy.length, 4);

// ---------------------------------------------------------------------------
console.log("\nnot the same post twice");

// The second run on this schedule, measured against the first. Deliberately
// consecutive: with two signed talking points, a third run has to reuse one,
// and asserting otherwise would be asserting that the pool is infinite.
check("the next run leads on a different point",
  refusedCopy[0]?.leadPoint === creatives[0]?.leadPoint, false);
check("and writes in a different shape",
  refusedCopy[0]?.template === creatives[0]?.template, false);

// Rotation is least recently used rather than random, so the run after the
// pool is exhausted comes back to the oldest choice rather than to whatever
// a coin said.
const third = await fresh();
await executeRun({ designers: NO_DESIGN, orgId: org.id, runId: third, actorUserId: admin.id, driver: saying(CLEAN) });
const later = await listCreatives(org.id, third);
check("and the one after that returns to the oldest, not to a guess",
  later[0]?.leadPoint, creatives[0]?.leadPoint);

// ---------------------------------------------------------------------------
console.log("\nnothing reaches a buyer without a person");

const queue = await reviewQueue(org.id);
const mine = queue.filter((c) => c.nodeName === "Posts Check Tower");
check("everything written is in the queue", mine.length >= 4, true);
// A refusal nobody can see is a refusal nobody can fix, and the reason
// usually names something missing from the Brain.
check("blocked posts are shown too, with their reasons",
  mine.some((c) => c.verdict === "FAIL" && c.reasons.length > 0), true);

const approvable = mine.find((c) => c.verdict === "PASS");
const approved = await approveCreative({
  orgId: org.id, actorUserId: admin.id, creativeId: approvable!.id,
});
check("a person can approve a cleared post", approved.ok, true);

check("and cannot approve it twice",
  (await approveCreative({
    orgId: org.id, actorUserId: admin.id, creativeId: approvable!.id,
  })).ok, false);

// An approval over the top of a refusal would make every FAIL a suggestion.
const blockedOne = mine.find((c) => c.verdict === "FAIL");
const overridden = await approveCreative({
  orgId: org.id, actorUserId: admin.id, creativeId: blockedOne!.id,
});
check("a blocked post cannot be approved at all", overridden.ok, false);
check("and it says which control refused",
  overridden.ok ? null : overridden.code, "BLOCKED");

const sendBack = mine.filter((c) => c.verdict === "PASS")[1];
check("a post can be sent back",
  (await rejectCreative({
    orgId: org.id, actorUserId: admin.id, creativeId: sendBack!.id,
    note: "Lead on the school instead",
  })).ok, true);

// The approval pins the hash of what was on the screen, the mechanism
// brain_signatures, asset_approvals and unit_type_approvals all use.
const [decided] = await sql<{ decided_sha256: string; content_sha256: string }[]>`
  SELECT decided_sha256, content_sha256 FROM post_creatives WHERE id = ${approvable!.id}`;
check("the decision pins what was decided on",
  decided.decided_sha256, decided.content_sha256);

// ---------------------------------------------------------------------------
// A slot that slipped would arrive beside the next slot's own creative, and
// two posts would land the day somebody finally opened the queue.
// ---------------------------------------------------------------------------
console.log("\nnothing waits forever, and nothing slips");

const stale = await fresh();
await executeRun({ designers: NO_DESIGN, orgId: org.id, runId: stale, actorUserId: admin.id, driver: saying(CLEAN) });
await sql`UPDATE post_runs SET publish_at = now() - interval '2 days',
          slot = now() - interval '2 days' WHERE id = ${stale}`;

const tidied = await expireStale({ orgId: org.id });
check("what nobody looked at expires", tidied.creatives >= 4, true);
check("nothing is left waiting on that run",
  (await listCreatives(org.id, stale)).filter((c) => c.state === "DRAFT" && c.verdict !== "FAIL")
    .length, 0);
const closed = (await listRuns(org.id, { scheduleId })).find((r) => r.id === stale);
check("and the run closes rather than sitting open",
  ["EXPIRED", "RELEASED"].includes(closed?.state ?? ""), true);

// ---------------------------------------------------------------------------
console.log("\nthe calendar belongs to nobody, and the opt-in to one tenant");

const calendar = await listOccasions(org.id, new Date("2026-01-01"), new Date("2027-12-31"));
check("the calendar is seeded", calendar.length > 20, true);
// The tenant's own marks are put back at the end; the suite starts from none.
await setOptIns({ orgId: org.id, actorUserId: admin.id, keys: [] });
check("nothing is marked to begin with",
  (await listOccasions(org.id, new Date("2026-01-01"), new Date("2027-12-31"))).every((o) => !o.optedIn), true);
// The hard stop is computed from the date, so a date nobody checked would
// publish a false offer on its own schedule. Akshaya Tritiya 2027 is 8 May in
// one calendar and 9 May in another, so it stays unconfirmed.
check("a lunar date the calendars disagree on carries no confirmation",
  calendar.some((o) => o.key === "akshaya_tritiya" && !o.verified), true);
check("and one they agree on does",
  calendar.some((o) => o.key === "diwali" && o.onDate === "2026-11-08" && o.verified), true);
check("and a solar one does",
  calendar.some((o) => o.key === "independence_day" && o.verified), true);

await setOptIns({ orgId: org.id, actorUserId: admin.id, keys: ["diwali", "not_a_festival"] });
const marked = await listOccasions(org.id, new Date("2026-01-01"), new Date("2027-12-31"));
check("what was marked is marked",
  marked.filter((o) => o.optedIn).map((o) => o.key), ["diwali", "diwali"]);
check("and a key nothing in the calendar knows is dropped",
  marked.some((o) => o.key === "not_a_festival"), false);

// A tenant that could write this table could move Diwali.
let moved = "allowed";
await withTenant(org.id, async (tx) => {
  await tx`UPDATE occasions SET on_date = '2026-01-01' WHERE key = 'diwali'`;
}).catch((e) => {
  moved = /permission denied/i.test(String(e)) ? "refused" : String(e).slice(0, 60);
});
check("a tenant cannot move a festival", moved, "refused");

// ---------------------------------------------------------------------------
console.log("\nthe runner, bounded and repeatable");

const report = await runDue({ orgIds: [org.id], scheduleIds: [scheduleId], driver: saying(CLEAN), designers: NO_DESIGN, maxRuns: 5 });
check("it scans only the tenant it was given", report.orgsScanned, 1);
check("and a second pass over the same minute does no work twice",
  (await runDue({ orgIds: [org.id], scheduleIds: [scheduleId], driver: saying(CLEAN), designers: NO_DESIGN, maxRuns: 5 })).created, 0);

// ---------------------------------------------------------------------------
// Editing a schedule moves the runs it already made. A run waiting for a
// slot the new cadence still has keeps its row with the new lead time; one
// for a slot it no longer has is dropped, or it would write a post for a
// time nobody now wants.
// ---------------------------------------------------------------------------
console.log("\nediting a schedule");

const ten = nextSlotAfter(
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], atMinute: 600, startsOn: null, endsOn: null },
  new Date(Date.now() + 4 * 86_400_000),
)!;
const eleven = new Date(ten.getTime() + 3_600_000);
const waiting = await sql<{ id: string; slot: Date }[]>`
  INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at)
  VALUES (${org.id}, ${scheduleId}, ${ten}, ${ten}, ${ten}),
         (${org.id}, ${scheduleId}, ${eleven}, ${eleven}, ${eleven})
  RETURNING id, slot`;
const tenRun = waiting.find((r) => r.slot.getTime() === ten.getTime())!.id;
const elevenRun = waiting.find((r) => r.slot.getTime() === eleven.getTime())!.id;

const edited = await saveSchedule({
  orgId: org.id, actorUserId: admin.id, scheduleId,
  input: baseInput({ name: "Posts check cadence, moved", atMinute: 660, leadMinutes: 720 }),
});
check("a schedule can be changed", edited.ok, true);
const afterEdit = (await listSchedulesForBrief(org.id, brief.id))[0];
check("and the change is what comes back",
  [afterEdit?.name, afterEdit?.atMinute, afterEdit?.leadMinutes],
  ["Posts check cadence, moved", 660, 720]);
const left = await sql<{ id: string; generate_at: Date }[]>`
  SELECT id, generate_at FROM post_runs WHERE id = ANY(${[tenRun, elevenRun]})`;
check("the run for a time it no longer posts at is dropped", left.some((r) => r.id === tenRun), false);
check("the run for a time it still posts at stays", left.some((r) => r.id === elevenRun), true);
check("written with the new lead time",
  left.find((r) => r.id === elevenRun)?.generate_at.getTime(), eleven.getTime() - 720 * 60_000);

// ---------------------------------------------------------------------------
// A schedule on picked dates, and one whose plan carries an ad.
// ---------------------------------------------------------------------------
console.log("\npicked dates, and ads");

// Two hours from now, on the IST clock, rounded to the minute.
const soon = istCivil(new Date(Date.now() + 2 * 3_600_000));
const soonOn = `${soon.year}-${String(soon.month).padStart(2, "0")}-${String(soon.day).padStart(2, "0")}`;
const datedInput = baseInput({
  name: "Launch week",
  repeat: "DATES",
  dated: JSON.stringify([
    { on: soonOn, at: soon.minute, kind: "CAROUSEL", outlet: "POST" },
    { on: "2099-01-01", at: 600, kind: "IMAGE", outlet: "POST" },
  ]),
});
const datedMade = await createSchedule({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, input: datedInput });
check("a schedule on picked dates is written", datedMade.ok, true);
const datedId = datedMade.ok ? datedMade.scheduleId : "";
const [datedRow] = await sql<{ repeat: string; days_of_week: number[]; dated: unknown[]; max_runs_per_day: number }[]>`
  SELECT repeat, days_of_week, dated, max_runs_per_day FROM post_schedules WHERE id = ${datedId}`;
check("holding its dates and no weekdays", [datedRow.repeat, datedRow.days_of_week, datedRow.dated.length], ["DATES", [], 2]);
await materialiseRuns({ orgId: org.id, now: new Date() });
const datedRuns = await sql<{ slot: Date; generate_at: Date }[]>`
  SELECT slot, generate_at FROM post_runs WHERE schedule_id = ${datedId}`;
check("a date closer than the lead time still gets its run, due now rather than never",
  [datedRuns.length, datedRuns[0]?.generate_at.getTime() <= Date.now()], [1, true]);
check("an empty calendar is refused",
  (await createSchedule({ orgId: org.id, actorUserId: admin.id, briefId: brief.id, input: baseInput({ repeat: "DATES", dated: "[]" }) })).ok, false);

const withAd = (over: Partial<ScheduleInput>) =>
  createSchedule({
    orgId: org.id, actorUserId: admin.id, briefId: brief.id,
    input: baseInput({ name: "Weekend ads", dayOutlets: ["AD", "POST", "POST", "POST", "POST", "POST", "BOTH"], ...over }),
  });
const noAccount = await withAd({ destinations: ["INSTAGRAM"], adDailyBudget: 800 });
check("a plan with an ad and no ad account is refused", noAccount.ok ? null : noAccount.code, "AD_SETTINGS");
const noBudget = await withAd({ destinations: ["META_AD"] });
check("and one with no budget", noBudget.ok ? null : noBudget.message, "Set a daily budget for the ads.");
const tooLong = await withAd({ destinations: ["META_AD"], adDailyBudget: 800, adDays: 45 });
check("and one that runs too long", tooLong.ok ? null : tooLong.message, "An ad runs for 3 to 30 days.");
const adOk = await withAd({ destinations: ["META_AD", "INSTAGRAM"], adDailyBudget: 800 });
check("a complete one is saved", adOk.ok, true);
const adId = adOk.ok ? adOk.scheduleId : "";
const [adRow] = await sql<{ destinations: string[]; ad_daily_budget: number; ad_days: number; day_outlets: string[] }[]>`
  SELECT destinations, ad_daily_budget, ad_days, day_outlets FROM post_schedules WHERE id = ${adId}`;
check("with the ad account, the budget, ten days, and each day's outlet",
  [adRow.destinations, adRow.ad_daily_budget, adRow.ad_days, adRow.day_outlets],
  [["INSTAGRAM", "META_AD"], 800, 10, ["AD", "POST", "POST", "POST", "POST", "POST", "BOTH"]]);
const noAdsNow = await saveSchedule({
  orgId: org.id, actorUserId: admin.id, scheduleId: adId,
  input: baseInput({ name: "Weekend ads", destinations: ["META_AD", "INSTAGRAM"], adDailyBudget: 800 }),
});
const [adAfter] = await sql<{ destinations: string[]; ad_daily_budget: number | null }[]>`
  SELECT destinations, ad_daily_budget FROM post_schedules WHERE id = ${adId}`;
check("a plan with the ads taken out drops the ad account and the budget",
  [noAdsNow.ok, adAfter.destinations, adAfter.ad_daily_budget], [true, ["INSTAGRAM"], null]);
await sql`DELETE FROM post_schedules WHERE id = ANY(${[datedId, adId]})`;

// ---------------------------------------------------------------------------
// A post's style, the studio's choices kept on the schedule: set once per
// kind, changed per date, kept to what the brief can make, and obeyed by the
// run that writes the post.
// ---------------------------------------------------------------------------
console.log("\na post's style");

const later2 = istCivil(new Date(Date.now() + 5 * 86_400_000));
const laterOn = `${later2.year}-${String(later2.month).padStart(2, "0")}-${String(later2.day).padStart(2, "0")}`;
const styled = await createSchedule({
  orgId: org.id, actorUserId: admin.id, briefId: brief.id,
  input: baseInput({
    name: "Styled",
    repeat: "DATES",
    styles: JSON.stringify({ IMAGE: { buyers: ["INVESTOR", "NOT_A_BUYER"], font: "cinzel", template: "not-a-template", slides: 6 } }),
    dated: JSON.stringify([
      { on: laterOn, at: 600, kind: "IMAGE", outlet: "POST", style: { buyers: ["INVESTOR"], font: "cinzel" } },
      { on: laterOn, at: 900, kind: "IMAGE", outlet: "POST", style: { buyers: ["NRI"] } },
    ]),
  }),
});
check("a schedule with a style is written", styled.ok, true);
const styledId = styled.ok ? styled.scheduleId : "";
const [styledRow] = await sql<{ styles: Record<string, unknown>; dated: { style: unknown }[] }[]>`
  SELECT styles, dated FROM post_schedules WHERE id = ${styledId}`;
check("each kind's style is kept to what the brief can make",
  looseStyle(styledRow.styles.IMAGE), { languages: [], buyers: ["INVESTOR"], size: null, template: null, font: "cinzel", slides: null });
check("a date whose style is its kind's takes the kind's, and one that differs keeps its own",
  styledRow.dated.map((d) => (d.style ? looseStyle(d.style) : null)), [null, { languages: [], buyers: ["NRI"], size: null, template: null, font: null, slides: null }]);
await sql`DELETE FROM post_schedules WHERE id = ${styledId}`;

// The main schedule's image style writes for investors only: one block, not four.
await sql`UPDATE post_schedules SET styles = ${sql.json({ IMAGE: { buyers: ["INVESTOR"] } })} WHERE id = ${scheduleId}`;
const forInvestors = await fresh();
const investorRun = await executeRun({ designers: NO_DESIGN, orgId: org.id, runId: forInvestors, actorUserId: admin.id, driver: saying(CLEAN) });
check("a run writes for the buyers its style names, and no others",
  [investorRun.ok ? investorRun.written : null, [...new Set((await listCreatives(org.id, forInvestors)).map((c) => c.segment))]],
  [1, ["INVESTOR"]]);
await sql`UPDATE post_schedules SET styles = '{}'::jsonb WHERE id = ${scheduleId}`;

// ---------------------------------------------------------------------------
console.log("\nanother tenant's schedule is not a schedule");

const [other] = await sql<{ id: string }[]>`
  SELECT id FROM orgs WHERE id <> ${org.id} LIMIT 1`;
if (other) {
  check("it does not list", (await listSchedulesForBrief(other.id, brief.id)).length, 0);
  check("its runs do not list", (await listRuns(other.id, { scheduleId })).length, 0);
  check("and approving into it is refused",
    (await approveCreative({
      orgId: other.id, actorUserId: admin.id, creativeId: approvable!.id,
    })).ok, false);
}
check("a malformed schedule id is refused before the query",
  (await listSchedulesForBrief(org.id, "not-a-uuid")).length, 0);

// ---------------------------------------------------------------------------
// The fixture subtree goes and the schedules, runs and creatives go with it:
// all of them cascade from scope_nodes through the brief. The audit rows are
// scoped to the fixture rather than to the action, because `post.%` would
// take the developer's own history with it.
await sql`DELETE FROM audit_log
          WHERE org_id = ${org.id} AND action LIKE 'post.%'
            AND target_id = ANY(${[scheduleId, autoId, datedId, adId, styledId, forInvestors, runId, goodRun, dirty, third, stale,
                                   approvable!.id, sendBack!.id]})`;
// The opt-in list belongs to the organisation rather than to this fixture, so
// it is put back exactly as it was found.
await sql`DELETE FROM occasion_opt_ins WHERE org_id = ${org.id}`;
for (const key of priorOptIns) {
  await sql`INSERT INTO occasion_opt_ins (org_id, occasion_key) VALUES (${org.id}, ${key})`;
}
await sql`DELETE FROM audit_log WHERE org_id = ${org.id}
            AND action = 'post.occasions_set' AND target_id = ${org.id}`;
await dropFixtures();
await sql.end();
await closeDb();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
