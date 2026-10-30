// One-time codes and calls through our number, with WhatsApp and Vobiz
// injected. Nothing here reaches Meta or Vobiz.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/check-proxy.mts
//
// Builds its own project, tower, lead and person, and removes exactly those.
import postgres from "postgres";
import { createHash } from "node:crypto";
import { useCodeSender, startChallenge, verifyChallenge, confirmOwnPhone } from "../src/lib/otp.ts";
import { useVobiz, type OutboundCall } from "../src/lib/vobiz.ts";
import { placeProxyCall, proxyAnswerXml, proxyEvent, proxyHangup, proxyIsGenuine } from "../src/lib/proxy.ts";
import { proxyToken } from "../src/lib/proxy-rules.ts";
import { webhookSecret } from "../src/lib/calling.ts";
import { buildAuthz } from "../src/lib/rbac-rules.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { istDate, termsFor } from "../src/lib/billing-rules.ts";

// The hours are tested as production keeps them.
delete process.env.CALLS_ANY_HOUR;
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

// Anything this machine has not configured is faked in this process only.
for (const [k, v] of Object.entries({
  SARVAM_FROM_NUMBER: "+912265480217",
  CALLS_WEBHOOK_BASE: "https://example.test",
  VOBIZ_AUTH_ID: "test-vobiz",
  VOBIZ_AUTH_TOKEN: "test-vobiz-token",
})) process.env[k] ??= v;

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const NOON = (() => {
  const ist = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  let t = Date.parse(`${ist}T06:30:00Z`);
  if (t < Date.now()) t += 86_400_000;
  return new Date(t).toISOString();
})();

const BUYER = "+919123400001";
const MINE = "+919123400002";
const EMAIL = "proxy-caller@example-tenant.test";
const SLUGS = ["proxy_check_project", "proxy_check_tower", "proxy_check_other"];
const hashOf = (p: string) => createHash("sha256").update(p).digest("hex");

const [admin] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string }[]>`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY m.created_at LIMIT 1`;
const [region] = await sql<{ id: string; path: string }[]>`
  SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'REGION' ORDER BY path LIMIT 1`;

const drop = async () => {
  const leads = await sql<{ id: string }[]>`
    SELECT l.id FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE n.org_id = ${org.id} AND n.slug = ANY(${SLUGS})`;
  const ids = leads.map((l) => l.id);
  if (ids.length) {
    await sql`DELETE FROM usage_events WHERE org_id = ${org.id} AND source_id IN
                (SELECT 'proxy:' || id::text FROM proxy_calls WHERE lead_id = ANY(${ids}))`.catch(() => {});
    await sql`DELETE FROM audit_log WHERE target_id = ANY(${ids})`;
    await sql`DELETE FROM proxy_calls WHERE lead_id = ANY(${ids})`;
    await sql`DELETE FROM call_suppressions WHERE org_id = ${org.id} AND phone = ${BUYER}`;
    await sql`DELETE FROM leads WHERE id = ANY(${ids})`;
  }
  await sql`DELETE FROM otp_challenges WHERE phone_hash IN (${hashOf(MINE)}, ${hashOf(BUYER)})`;
  const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${EMAIL}`;
  if (u) {
    await sql`DELETE FROM audit_log WHERE actor_user_id = ${u.id}`;
    await sql`DELETE FROM memberships WHERE user_id = ${u.id}`;
    await sql`DELETE FROM users WHERE id = ${u.id}`;
  }
  await sql`DELETE FROM registration_records WHERE scope_node_id IN
              (SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS}))`;
  await sql`DELETE FROM subscriptions WHERE project_id IN (SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS}))`;
  await sql`DELETE FROM commission_terms WHERE scope_node_id IN (SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS}))`;
  await sql`DELETE FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS})`;
};
await drop();

const [project] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${region.id}, 'PROJECT', 'Proxy Check', 'proxy_check_project', ${`${region.path}.proxy_check_project`}::ltree)
  RETURNING id, path::text AS path`;
const [tower] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Proxy Tower', 'proxy_check_tower', ${`${project.path}.proxy_check_tower`}::ltree)
  RETURNING id, path::text AS path`;
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, valid_from, valid_to, verified_at)
  VALUES (${tower.id}, ${org.id}, 'VERIFIED', 'P52100077002', 'MH', current_date - 30, current_date + 400, now())`;
// An organisation with a billing account places no call on a project without
// a plan, so the fixture project is sold one, the way the operator's tool does:
// Launch, whose three calls at once are the three lines the busy check fills.
const [billed] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM billing_accounts WHERE org_id = ${org.id}`;
if (billed.n) {
  await sql`
    INSERT INTO subscriptions (org_id, project_id, plan, status, cycle, starts_on, terms)
    VALUES (${org.id}, ${project.id}, 'LAUNCH', 'ACTIVE', 'MONTHLY', ${istDate(new Date().toISOString())}, ${sql.json(termsFor("LAUNCH") as never)})`;
}
const [me] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${EMAIL}, 'example-tenant.test', 'Proxy Caller') RETURNING id`;
await sql`
  INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
  VALUES (${me.id}, ${org.id}, ${project.id}, 'CLOSING_MANAGER', 'ACTIVE', now())`;
const [lead] = await sql<{ id: string }[]>`
  INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel)
  VALUES (${org.id}, ${tower.id}, 'Proxy Buyer', ${BUYER}, 'Website', 'WEBSITE') RETURNING id`;

const grant = (perms: string[]) =>
  buildAuthz([{ role: "CLOSING_MANAGER", roleLabel: "Closing Manager", scopeNodeId: project.id, scopePath: project.path,
    scopeKind: "PROJECT", scopeName: "Proxy Check", permissions: new Set(perms) }]);
const caller = grant(["lead:read", "lead:call"]);

// --- a person's own number, by code ------------------------------------------
console.log("\nconfirming a person's own number");
const sent: { to: string; code: string }[] = [];
const codes = useCodeSender({ async send(to, code) { sent.push({ to, code }); } });
const now0 = new Date();
const first = await startChallenge({ purpose: "VERIFY_PHONE", phone: MINE, userId: me.id, orgId: org.id, ip: "10.0.0.9", now: now0 });
check("a code is sent to the number asked", first.ok && sent.at(-1)?.to === MINE);
check("six digits", /^\d{6}$/.test(sent.at(-1)?.code ?? ""));
const [row] = await sql<{ code_hash: string; phone_hash: string; cost_paise: number }[]>`
  SELECT code_hash, phone_hash, cost_paise FROM otp_challenges WHERE id = ${first.ok ? first.challengeId : ""}`;
check("stored as hashes, never the code or the number",
  row && row.code_hash !== sent.at(-1)?.code && row.phone_hash === hashOf(MINE) && !JSON.stringify(row).includes(MINE.slice(3)));
check("carrying what it cost", row?.cost_paise === 12);
const again = await startChallenge({ purpose: "VERIFY_PHONE", phone: MINE, userId: me.id, orgId: org.id, now: new Date(now0.getTime() + 20_000) });
check("a second code inside a minute is refused before anything is sent", !again.ok && sent.length === 1);
const id = first.ok ? first.challengeId : "";
const wrong = await verifyChallenge({ challengeId: id, phone: MINE, code: "000000", purpose: "VERIFY_PHONE", userId: me.id });
check("a wrong code is refused and counted",
  !wrong.ok && (await sql<{ attempts: number }[]>`SELECT attempts FROM otp_challenges WHERE id = ${id}`)[0].attempts === 1);
const otherPerson = await verifyChallenge({ challengeId: id, phone: MINE, code: sent[0].code, purpose: "VERIFY_PHONE", userId: admin.id });
check("somebody else cannot use a code sent for this person", !otherPerson.ok);
const ok = await confirmOwnPhone({ userId: me.id, orgId: org.id, challengeId: id, phone: MINE, code: sent[0].code });
check("the right code confirms the number", ok.ok);
const [mine] = await sql<{ phone: string | null; phone_verified_at: Date | null }[]>`SELECT phone, phone_verified_at FROM users WHERE id = ${me.id}`;
check("and keeps it as the person's own", mine.phone === MINE && !!mine.phone_verified_at);
const twice = await verifyChallenge({ challengeId: id, phone: MINE, code: sent[0].code, purpose: "VERIFY_PHONE", userId: me.id });
check("a used code cannot be used again", !twice.ok);
const [log] = await sql<{ metadata: Record<string, unknown> }[]>`
  SELECT metadata FROM audit_log WHERE actor_user_id = ${me.id} AND action = 'user.phone_verified' ORDER BY id DESC LIMIT 1`;
check("the audit row carries a hash, not the number", log?.metadata?.phone === hashOf(MINE) && !JSON.stringify(log).includes(MINE.slice(3)));
codes.restore();

// --- the call ----------------------------------------------------------------
console.log("\ncalling a buyer through our number");
const dialled: OutboundCall[] = [];
const vz = useVobiz({
  async liveCalls() { return []; },
  async transfer() {},
  async makeCall(_c, call) { dialled.push(call); return { uuid: `vz-${dialled.length}` }; },
});

const noKey = await placeProxyCall({ orgId: org.id, userId: me.id, authz: grant(["lead:read"]), leadId: lead.id, nowIso: NOON });
check("somebody without the call key places nothing", !noKey.ok && noKey.code === "NOT_ALLOWED" && dialled.length === 0);

const placed = await placeProxyCall({ orgId: org.id, userId: me.id, authz: caller, leadId: lead.id, nowIso: NOON });
check("a call is placed", placed.ok, placed.ok ? "" : placed.message);
const call = dialled.at(-1);
check("our number rings the person's own phone first", call?.to === MINE && !!call?.from && call.from !== BUYER);
check("the buyer's number is nowhere in what Vobiz is told", !JSON.stringify(call ?? {}).includes(BUYER.slice(3)));
check("capped at thirty minutes", call?.timeLimit === 1800);
const pid = placed.ok ? placed.proxyCallId : "";
check("the answer address proves itself", call?.answerUrl.includes(`t=${proxyToken(webhookSecret(), org.id, pid)}`) === true);
check("and a forged one is refused", proxyIsGenuine(org.id, pid, "0".repeat(64)) === false && proxyIsGenuine(org.id, pid, proxyToken(webhookSecret(), org.id, pid)));
const audited = await sql<{ metadata: Record<string, unknown> }[]>`
  SELECT metadata FROM audit_log WHERE actor_user_id = ${me.id} AND action = 'lead.call_proxied' AND target_id = ${lead.id}`;
check("the call is audited against the lead, with no number in it",
  audited.length === 1 && !JSON.stringify(audited[0].metadata).includes(BUYER.slice(3)));

const xml = await proxyAnswerXml(org.id, pid);
check("when the person picks up, the buyer is rung", xml.includes(`<Number>${BUYER}</Number>`));
check("as our number", xml.includes(`callerId="${call?.from}"`));
const second = await proxyAnswerXml(org.id, pid);
check("an answer that arrives twice rings nobody twice", second.includes("<Hangup/>"));

await proxyEvent(org.id, pid, { Event: "DialHangup", DialBLegBillDuration: "95", DialBLegTo: BUYER.slice(1) });
const [ended] = await sql<{ status: string; bill_s: number }[]>`SELECT status, bill_s FROM proxy_calls WHERE id = ${pid}`;
check("the buyer's leg ending ends the call with what Vobiz billed", ended.status === "ENDED" && ended.bill_s === 95);

// Somebody who never picks up.
const unanswered = await placeProxyCall({ orgId: org.id, userId: me.id, authz: caller, leadId: lead.id, nowIso: NOON });
if (unanswered.ok) await proxyHangup(org.id, unanswered.proxyCallId);
const [missed] = await sql<{ status: string }[]>`SELECT status FROM proxy_calls WHERE id = ${unanswered.ok ? unanswered.proxyCallId : pid}`;
check("a call the person never picked up is failed, not ended", missed?.status === "FAILED");

// Every line busy: three calls already live on the project's three lines.
await sql`
  INSERT INTO proxy_calls (org_id, lead_id, scope_node_id, caller_id, status, placed_at)
  SELECT ${org.id}, ${lead.id}, ${tower.id}, ${me.id}, 'CONNECTED', ${NOON} FROM generate_series(1, 3)`;
const before = dialled.length;
const busy = await placeProxyCall({ orgId: org.id, userId: me.id, authz: caller, leadId: lead.id, nowIso: NOON });
check("with every line busy nothing is dialled", !busy.ok && busy.code === "BUSY" && dialled.length === before,
  busy.ok ? "placed" : busy.code);
await sql`DELETE FROM proxy_calls WHERE lead_id = ${lead.id} AND status = 'CONNECTED' AND vobiz_call_uuid IS NULL`;

// An opt-out is final, for people as for the agent.
await sql`INSERT INTO call_suppressions (org_id, phone, reason) VALUES (${org.id}, ${BUYER}, 'ADDED_BY_HAND')`;
const n = dialled.length;
const opted = await placeProxyCall({ orgId: org.id, userId: me.id, authz: caller, leadId: lead.id, nowIso: NOON });
check("a buyer who opted out is not called", !opted.ok && dialled.length === n);
await sql`DELETE FROM call_suppressions WHERE org_id = ${org.id} AND phone = ${BUYER}`;

// Outside the hours.
const LATE = new Date(Date.parse(NOON) + 10.5 * 3_600_000).toISOString();
const late = await placeProxyCall({ orgId: org.id, userId: me.id, authz: caller, leadId: lead.id, nowIso: LATE });
check("nobody is called at 10:30 at night", !late.ok && dialled.length === n);

// --- the developer's own number (0072) -----------------------------------------
console.log("\nthe developer's own calling number");
const [heldNumbers] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calling_numbers WHERE org_id = ${org.id} AND released_at IS NULL`;
if (heldNumbers.n > 0) {
  console.log("  SKIP  this organisation already holds calling numbers; the suite does not touch them");
} else {
  const OWN = "+912240009911";
  check("with none of its own, a call through our number shows the shared number", call?.from === (process.env.PROXY_FROM_NUMBER ?? process.env.SARVAM_FROM_NUMBER));
  const [own] = await sql<{ id: string }[]>`
    INSERT INTO calling_numbers (org_id, number, scope_node_id, active, monthly_cost_paise, monthly_price_paise)
    VALUES (${org.id}, ${OWN}, ${project.id}, true, 60000, 99900) RETURNING id`;
  try {
    const mineCall = await placeProxyCall({ orgId: org.id, userId: me.id, authz: caller, leadId: lead.id, nowIso: NOON });
    check("a call through our number goes out from the developer's own number", mineCall.ok && dialled.at(-1)?.from === OWN,
      mineCall.ok ? String(dialled.at(-1)?.from) : mineCall.message);
    const ownId = mineCall.ok ? mineCall.proxyCallId : pid;
    const [stored] = await sql<{ from_number: string | null }[]>`SELECT from_number FROM proxy_calls WHERE id = ${ownId}`;
    check("and the row remembers it", stored?.from_number === OWN);
    const ownXml = await proxyAnswerXml(org.id, ownId);
    check("so the buyer is rung showing that same number", ownXml.includes(`callerId="${OWN}"`));
    await proxyHangup(org.id, ownId);

    // A buyer ringing that number in (0076): its callbacks are their own
    // namespace, and a person being rung for them is busy for a bridge.
    const IN = await import("../src/lib/inbound-calls.ts");
    const IR = await import("../src/lib/inbound-call-rules.ts");
    const { sellers } = await import("../src/lib/handoff.ts");
    check("a call through our number's proof opens no inbound callback, and the other way round",
      !IN.inboundIsGenuine(org.id, ownId, proxyToken(webhookSecret(), org.id, ownId))
        && !proxyIsGenuine(org.id, ownId, IR.inboundCallToken(webhookSecret(), org.id, ownId))
        && !IR.inboundNumberValid(webhookSecret(), OWN, proxyToken(webhookSecret(), org.id, ownId)));
    const SELLER = "+919000000231";
    const [root] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG' LIMIT 1`;
    await sql`INSERT INTO sales_team (org_id, scope_node_id, name, phone, on_duty) VALUES (${org.id}, ${root.id}, 'Proxy Seller', ${SELLER}, true)`;
    const freeBefore = (await sellers(org.id, "00000000-0000-0000-0000-000000000000")).find((s) => s.phone === SELLER)?.busy;
    await sql`INSERT INTO inbound_calls (org_id, calling_number_id, vobiz_call_uuid, status, stage, rang, in_hours)
              VALUES (${org.id}, ${own.id}, 'proxy-check-in', 'RINGING', 'TEAM', ${[SELLER]}, true)`;
    const busyAfter = (await sellers(org.id, "00000000-0000-0000-0000-000000000000")).find((s) => s.phone === SELLER)?.busy;
    check("a person rung for a buyer calling in is busy for anybody else", freeBefore === false && busyAfter === true);
    await sql`DELETE FROM inbound_calls WHERE org_id = ${org.id} AND vobiz_call_uuid = 'proxy-check-in'`;
    await sql`DELETE FROM sales_team WHERE org_id = ${org.id} AND phone = ${SELLER}`;

    // Placed at another project, it does not call for this one, and the
    // shared number does not step in.
    const [elsewhere] = await sql<{ id: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${org.id}, ${region.id}, 'PROJECT', 'Proxy Check Other', 'proxy_check_other', ${`${region.path}.proxy_check_other`}::ltree)
      RETURNING id`;
    await sql`UPDATE calling_numbers SET scope_node_id = ${elsewhere.id} WHERE id = ${own.id}`;
    const n0 = dialled.length;
    const refused = await placeProxyCall({ orgId: org.id, userId: me.id, authz: caller, leadId: lead.id, nowIso: NOON });
    check("a developer whose number is placed elsewhere is refused, never shown the shared number",
      !refused.ok && refused.code === "NO_NUMBER" && dialled.length === n0, refused.ok ? "placed" : refused.code);
    await sql`UPDATE calling_numbers SET scope_node_id = NULL, active = false, released_at = now() WHERE id = ${own.id}`;
    await sql`DELETE FROM scope_nodes WHERE id = ${elsewhere.id}`;
  } finally {
    await sql`DELETE FROM calling_numbers WHERE id = ${own.id}`;
  }
}

// Without a confirmed number of one's own.
await sql`UPDATE users SET phone_verified_at = NULL WHERE id = ${me.id}`;
const unconfirmed = await placeProxyCall({ orgId: org.id, userId: me.id, authz: caller, leadId: lead.id, nowIso: NOON });
check("a person with no confirmed number is asked for one first", !unconfirmed.ok && unconfirmed.code === "NO_PHONE");
vz.restore();

await drop();
await sql.end();
await closeDb();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
