// Signing a channel partner's people in with a phone and a code, with
// WhatsApp injected. Nothing here reaches Meta.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/check-otp.mts
//
// The first half drives the library in this process. The second signs in
// through the dev server's own `phone` provider (AUTH_URL) and reads what a
// phone session may open. Builds its own firm, developer and people, and
// removes exactly those.
import postgres from "postgres";
import { createHash } from "node:crypto";
import { useCodeSender } from "../src/lib/otp.ts";
import { finishPhoneSignIn, redeemStepUp, resolvePhoneAuthz, startPhoneSignIn, startStepUp } from "../src/lib/phone-session.ts";
import { SIGN_IN_FLOOR_MS, SIGN_IN_SENT, PHONE_TIER } from "../src/lib/phone-session-rules.ts";
import { invitePhonePerson, listPhonePeople, removePhonePerson } from "../src/lib/partner-team.ts";
import { buildAuthz } from "../src/lib/rbac-rules.ts";
import { closeDb } from "../src/lib/db/index.ts";

const BASE = (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// Numbers nobody else's fixtures use.
const OWNER = "+919123411001";
const AGENT = "+919123411002";
const DEVUSER = "+919123411003";
const UNKNOWN = "+919123411009";
const LIMITED = "+919123411011";
const LIMITED_UNKNOWN = "+919123411019";
const INVITEE = "+919123411021";
const INVITEE_WEB = "+919123411022";
const ALL = [OWNER, AGENT, DEVUSER, UNKNOWN, LIMITED, LIMITED_UNKNOWN, INVITEE, INVITEE_WEB];
const national = (p: string) => p.slice(3);
const hashOf = (p: string) => createHash("sha256").update(p).digest("hex");
const TAG = "otp_check";

const made = { users: [] as string[], orgs: [] as string[] };

const drop = async () => {
  const users = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ANY(${ALL}) OR email = 'otp-dev@otpcheck.test'`;
  const orgs = await sql<{ id: string }[]>`SELECT id FROM orgs WHERE legal_name LIKE ${`${TAG}%`}`;
  const uids = users.map((u) => u.id);
  const oids = orgs.map((o) => o.id);
  await sql`DELETE FROM otp_challenges WHERE phone_hash = ANY(${ALL.map(hashOf)})`;
  if (uids.length) await sql`DELETE FROM audit_log WHERE actor_user_id = ANY(${uids}) OR target_id = ANY(${uids.map(String)})`;
  if (oids.length) {
    // Winding a tenant down is exempt from the last-admin rule.
    await sql`UPDATE orgs SET status = 'SUSPENDED' WHERE id = ANY(${oids})`;
    await sql`DELETE FROM audit_log WHERE org_id = ANY(${oids})`;
    await sql`DELETE FROM memberships WHERE org_id = ANY(${oids})`;
    await sql`DELETE FROM scope_nodes WHERE org_id = ANY(${oids})`;
    await sql`DELETE FROM orgs WHERE id = ANY(${oids})`;
  }
  if (uids.length) {
    await sql`DELETE FROM memberships WHERE user_id = ANY(${uids})`;
    await sql`DELETE FROM users WHERE id = ANY(${uids})`;
  }
};
await drop();
const began = new Date();

async function company(type: "CHANNEL_PARTNER" | "DEVELOPER", name: string) {
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, status)
    VALUES (${type}, ${`${TAG} ${name}`}, ${name}, 'AAQFS4821K', 'ACTIVE') RETURNING id`;
  const slug = `${TAG}_${name.toLowerCase().replace(/\W/g, "")}`;
  const [root] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, NULL, 'ORG', ${name}, ${slug}, ${slug}::ltree) RETURNING id, path::text AS path`;
  made.orgs.push(org.id);
  return { id: org.id, root };
}

const firm = await company("CHANNEL_PARTNER", "Otp Realty");
const dev = await company("DEVELOPER", "Otp Developer");

const person = async (phone: string, name: string, email: string | null = null) => {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (phone, phone_verified_at, name, email, email_domain)
    VALUES (${phone}, now(), ${name}, ${email}, ${email ? email.split("@")[1] : null}) RETURNING id`;
  made.users.push(u.id);
  return u.id;
};
const member = (userId: string, org: { id: string; root: { id: string } }, role: string) =>
  sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
      VALUES (${userId}, ${org.id}, ${org.root.id}, ${role}, 'ACTIVE', now())`;

// The firm's founder: its admin, with a proved phone.
const owner = await person(OWNER, "Otp Owner");
await member(owner, firm, "ORG_ADMIN");
// An agent the partner bot made, who is also a sales head at a developer.
const agent = await person(AGENT, "Otp Agent");
await member(agent, firm, "CP_AGENT");
await member(agent, dev, "SALES_HEAD");
// A developer's own person with a proved phone and no firm.
const devUser = await person(DEVUSER, "Otp Dev", "otp-dev@otpcheck.test");
await member(devUser, dev, "SALES_HEAD");

const sent: { to: string; code: string }[] = [];
const codes = useCodeSender({ async send(to, code) { sent.push({ to, code }); } });
const lastCodeFor = (p: string) => [...sent].reverse().find((s) => s.to === p)?.code ?? "";

// --- asking for a code --------------------------------------------------------
console.log("\nasking for a code");
const t0 = new Date(Date.now() + 5 * 60_000);
const known = await startPhoneSignIn({ raw: national(OWNER), ip: "10.7.0.1", now: t0, floorMs: 0 });
check("a firm's person gets a code on WhatsApp", known.ok && sent.at(-1)?.to === OWNER && /^\d{6}$/.test(sent.at(-1)?.code ?? ""));
const sentBefore = sent.length;
const unknown = await startPhoneSignIn({ raw: national(UNKNOWN), ip: "10.7.0.2", now: t0, floorMs: 0 });
check("a number nobody holds is sent nothing", sent.length === sentBefore);
const devAsk = await startPhoneSignIn({ raw: national(DEVUSER), ip: "10.7.0.3", now: t0, floorMs: 0 });
check("a developer's person with a proved phone is sent nothing either (channel partners only)", sent.length === sentBefore);
const shape = (r: typeof known) => (r.ok ? { ok: true, message: r.message, id: /^[0-9a-f-]{36}$/.test(r.challengeId) } : r);
check("a known and an unknown number get the same answer",
  JSON.stringify(shape(known)) === JSON.stringify(shape(unknown)) && JSON.stringify(shape(unknown)) === JSON.stringify(shape(devAsk)),
  JSON.stringify([shape(known), shape(unknown)]));
check("and it is the neutral one", known.ok && known.message === SIGN_IN_SENT);
const rows = await sql<{ phone_hash: string; sent: boolean; cost_paise: number; user_id: string | null; org_id: string | null }[]>`
  SELECT phone_hash, sent, cost_paise, user_id, org_id FROM otp_challenges WHERE phone_hash = ANY(${[OWNER, UNKNOWN].map(hashOf)})`;
check("both are rows every limit counts, and only the real one cost anything",
  rows.length === 2 && rows.every((r) => r.sent && r.user_id === null && r.org_id === null)
    && rows.find((r) => r.phone_hash === hashOf(OWNER))?.cost_paise === 12 && rows.find((r) => r.phone_hash === hashOf(UNKNOWN))?.cost_paise === 0);

const soonKnown = await startPhoneSignIn({ raw: national(OWNER), ip: "10.7.0.1", now: new Date(t0.getTime() + 20_000), floorMs: 0 });
const soonUnknown = await startPhoneSignIn({ raw: national(UNKNOWN), ip: "10.7.0.2", now: new Date(t0.getTime() + 20_000), floorMs: 0 });
check("a second code inside a minute is refused the same way for both",
  !soonKnown.ok && !soonUnknown.ok && soonKnown.message === soonUnknown.message, JSON.stringify([soonKnown, soonUnknown]));

// Five an hour, for a number that may sign in and one that may not, alike.
const firmPerson = await person(LIMITED, "Otp Limited");
await member(firmPerson, firm, "CP_AGENT");
const answers = async (phone: string, ip: string) => {
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await startPhoneSignIn({ raw: national(phone), ip, now: new Date(t0.getTime() + i * 61_000), floorMs: 0 });
    out.push(r.ok ? "sent" : r.message);
  }
  return out;
};
const limKnown = await answers(LIMITED, "10.7.1.1");
const limUnknown = await answers(LIMITED_UNKNOWN, "10.7.1.2");
check("the sixth code in an hour is refused, for a known and an unknown number alike",
  limKnown[5] !== "sent" && limKnown.slice(0, 5).every((a) => a === "sent") && JSON.stringify(limKnown) === JSON.stringify(limUnknown),
  JSON.stringify([limKnown, limUnknown]));

const ipAnswers: string[] = [];
for (let i = 0; i < 21; i++) {
  const r = await startPhoneSignIn({ raw: `9123422${String(i).padStart(3, "0")}`, ip: "10.7.2.1", now: t0, floorMs: 0 });
  ipAnswers.push(r.ok ? "sent" : r.message);
}
await sql`DELETE FROM otp_challenges WHERE ip_hash = ${createHash("sha256").update("ip:10.7.2.1").digest("hex")}`;
check("twenty numbers an hour from one address, then refused (probing costs the prober)",
  ipAnswers.slice(0, 20).every((a) => a === "sent") && ipAnswers[20] !== "sent", JSON.stringify(ipAnswers.slice(18)));

const slowStart = Date.now();
await startPhoneSignIn({ raw: "9123433001", ip: "10.7.3.1" });
const slowUnknown = Date.now() - slowStart;
check("an answer takes at least its floor, so a real send does not stand out by its time", slowUnknown >= SIGN_IN_FLOOR_MS - 5, String(slowUnknown));
await sql`DELETE FROM otp_challenges WHERE phone_hash = ${hashOf("+919123433001")}`;

// --- sending the code back ----------------------------------------------------
console.log("\nsending the code back");
const ownerChallenge = known.ok ? known.challengeId : "";
const unknownChallenge = unknown.ok ? unknown.challengeId : "";
const ownerCode = lastCodeFor(OWNER);
const late = await finishPhoneSignIn({ challengeId: ownerChallenge, raw: OWNER, code: ownerCode, now: new Date(t0.getTime() + 6 * 60_000) });
check("a code past its five minutes signs nobody in", !late.ok && /expired/i.test(late.message));
const wrongPhone = await finishPhoneSignIn({ challengeId: ownerChallenge, raw: AGENT, code: ownerCode, now: t0 });
check("a code sent to one number does not sign in another", !wrongPhone.ok);
const guess = await finishPhoneSignIn({ challengeId: unknownChallenge, raw: UNKNOWN, code: "123456", now: t0 });
check("a guess at a withheld code is just a wrong code", !guess.ok && /not right/.test(guess.message));
const good = await finishPhoneSignIn({ challengeId: ownerChallenge, raw: national(OWNER), code: ownerCode, now: new Date(t0.getTime() + 60_000) });
check("the right code signs the firm's person in, to the firm", good.ok && good.userId === owner && good.orgId === firm.id, JSON.stringify(good));
const again = await finishPhoneSignIn({ challengeId: ownerChallenge, raw: OWNER, code: ownerCode, now: new Date(t0.getTime() + 61_000) });
check("a code signs in once", !again.ok && /already used/.test(again.message));

// Five wrong tries and the challenge is dead, right code or not.
const t1 = new Date(t0.getTime() + 3 * 3_600_000);
const fresh = await startPhoneSignIn({ raw: AGENT, ip: "10.7.4.1", now: t1, floorMs: 0 });
const agentCode = lastCodeFor(AGENT);
const wrongCode = agentCode === "000000" ? "111111" : "000000";
const tries: string[] = [];
for (let i = 0; i < 5; i++) {
  const r = await finishPhoneSignIn({ challengeId: fresh.ok ? fresh.challengeId : "", raw: AGENT, code: wrongCode, now: t1 });
  tries.push(r.ok ? "in" : r.message);
}
const afterTries = await finishPhoneSignIn({ challengeId: fresh.ok ? fresh.challengeId : "", raw: AGENT, code: agentCode, now: t1 });
check("wrong codes count down, and after five the right one opens nothing",
  /4 tries left/.test(tries[0]) && !afterTries.ok, JSON.stringify([tries[0], afterTries]));

// --- what a phone session may do ------------------------------------------------
console.log("\nwhat a phone session may do");
const ownerPhone = await resolvePhoneAuthz(owner, firm.id);
check("the firm's admin, signed in by phone, is not an admin", !ownerPhone.authz.isAdmin && !ownerPhone.authz.permissions.has("*"));
check("admin keys are unreachable from a phone session",
  ["org:manage", "member:invite", "member:role", "role:manage", "billing:manage", "integration:manage", "campaign:publish"].every((p) => !ownerPhone.authz.can(p)));
check("it holds exactly the in-session tier", [...ownerPhone.authz.permissions].sort().join() === [...PHONE_TIER].sort().join());
const agentPhone = await resolvePhoneAuthz(agent, firm.id);
check("an agent the bot made works leads, visits, registrations and posts, and sees no money",
  ["lead:read", "visit:read", "visit:schedule", "inventory:read", "partner:register", "campaign:read"].every((p) => agentPhone.authz.can(p)) && !agentPhone.authz.can("payout:read"));
check("neither may see a whole number or export without a code",
  !ownerPhone.authz.can("lead.phone:unmask") && !ownerPhone.authz.can("lead:export") && !agentPhone.authz.can("lead.phone:unmask"));
const devPhone = await resolvePhoneAuthz(devUser, dev.id);
// resolvePhoneAuthz is asked only for a channel partner (authzFor); what it
// would give a developer's sales head is still only the tier.
check("even read for a developer's role, a phone never holds more than the tier",
  [...devPhone.authz.permissions].every((p) => PHONE_TIER.includes(p)));

// --- a fresh code for one action --------------------------------------------------
console.log("\na fresh code for one action");
const leadA = "0a8f6c1e-8d9b-4c6e-9f00-000000000001";
const leadB = "0a8f6c1e-8d9b-4c6e-9f00-000000000002";
const leadPath = `${firm.root.path}`;
const exportRefused = await startStepUp({ userId: agent, orgId: firm.id, stepUp: agentPhone.stepUp, permission: "lead:export", targetId: firm.id, now: t1 });
const beforeRefused = sent.length;
check("an agent's export is refused before any code is sent", !exportRefused.ok && sent.length === beforeRefused);
const adminKey = await startStepUp({ userId: owner, orgId: firm.id, stepUp: ownerPhone.stepUp, permission: "org:manage", targetId: firm.id, now: t1 });
check("no code opens an admin key", !adminKey.ok);

const t2 = new Date(t1.getTime() + 3 * 3_600_000);
const up = await startStepUp({ userId: agent, orgId: firm.id, stepUp: agentPhone.stepUp, permission: "lead.phone:unmask", targetId: leadA, path: leadPath, ip: "10.7.5.1", now: t2 });
check("a whole number asks for a code, sent to the person's own phone", up.ok && sent.at(-1)?.to === AGENT && /91XXXXXX02/.test(up.ok ? up.message : ""), JSON.stringify(up));
const upCode = lastCodeFor(AGENT);
const otherLead = await redeemStepUp({ userId: agent, orgId: firm.id, authz: agentPhone.authz, stepUp: agentPhone.stepUp, permission: "lead.phone:unmask", targetId: leadB, challengeId: up.ok ? up.challengeId : "", code: upCode, now: t2 });
check("a code for one lead does not open another", !otherLead.ok);
const otherAction = await redeemStepUp({ userId: agent, orgId: firm.id, authz: agentPhone.authz, stepUp: agentPhone.stepUp, permission: "lead:export", targetId: leadA, challengeId: up.ok ? up.challengeId : "", code: upCode, now: t2 });
check("a code for a number does not open an export", !otherAction.ok);
const otherPerson = await redeemStepUp({ userId: owner, orgId: firm.id, authz: ownerPhone.authz, stepUp: ownerPhone.stepUp, permission: "lead.phone:unmask", targetId: leadA, challengeId: up.ok ? up.challengeId : "", code: upCode, now: t2 });
check("somebody else cannot spend it", !otherPerson.ok);
const opened = await redeemStepUp({ userId: agent, orgId: firm.id, authz: agentPhone.authz, stepUp: agentPhone.stepUp, permission: "lead.phone:unmask", targetId: leadA, challengeId: up.ok ? up.challengeId : "", code: upCode, now: t2 });
check("the right code opens that one key for that one action",
  opened.ok && opened.authz.canAt("lead.phone:unmask", `${leadPath}.tower`) && !opened.authz.can("lead:export") && !opened.authz.isAdmin);
const replay = await redeemStepUp({ userId: agent, orgId: firm.id, authz: agentPhone.authz, stepUp: agentPhone.stepUp, permission: "lead.phone:unmask", targetId: leadA, challengeId: up.ok ? up.challengeId : "", code: upCode, now: t2 });
check("and is used once", !replay.ok);

// --- a firm's owner adds its own people by phone -------------------------------------
console.log("\na firm's owner adds its people by phone");
const grantAt = (org: { id: string; root: { id: string; path: string } }, permissions: string[]) =>
  buildAuthz([{ role: "CHECK", roleLabel: "Check", scopeNodeId: org.root.id, scopePath: org.root.path, scopeKind: "ORG", scopeName: "", permissions: new Set(permissions) }]);
const ownerConsole = grantAt(firm, ["*"]);
const devRefused = await invitePhonePerson({ orgId: dev.id, actorUserId: devUser, authz: grantAt(dev, ["*"]), name: "Dev Person", phone: INVITEE });
check("a developer does not add people by phone", !devRefused.ok && (await sql`SELECT 1 FROM users WHERE phone = ${INVITEE}`).length === 0);
const short = await invitePhonePerson({ orgId: firm.id, actorUserId: owner, authz: grantAt(firm, ["member:invite", "lead:read"]), name: "Otp Invitee", phone: national(INVITEE) });
check("somebody short of an agent's keys cannot give them", !short.ok && (await sql`SELECT 1 FROM users WHERE phone = ${INVITEE}`).length === 0, short.ok ? "" : short.message);
const added = await invitePhonePerson({ orgId: firm.id, actorUserId: owner, authz: ownerConsole, name: "Otp Invitee", phone: national(INVITEE) });
const [invitee] = await sql<{ id: string; verified: boolean; name: string }[]>`SELECT id, phone_verified_at IS NOT NULL AS verified, name FROM users WHERE phone = ${INVITEE}`;
check("the owner adds a person by phone: a phone-only user nobody has proved, invited at the firm's root as an agent",
  added.ok && !!invitee && !invitee.verified && invitee.name === "Otp Invitee"
    && (await sql`SELECT 1 FROM memberships WHERE user_id = ${invitee.id} AND org_id = ${firm.id} AND scope_node_id = ${firm.root.id} AND role = 'CP_AGENT' AND status = 'INVITED'`).length === 1,
  added.ok ? "" : added.message);
const addedAgain = await invitePhonePerson({ orgId: firm.id, actorUserId: owner, authz: ownerConsole, name: "Otp Invitee", phone: INVITEE });
check("adding the same number again is the same invite", addedAgain.ok && addedAgain.membershipId === (added.ok ? added.membershipId : "")
  && (await sql`SELECT 1 FROM memberships WHERE user_id = ${invitee.id} AND status <> 'REVOKED'`).length === 1);
const listed = await listPhonePeople(firm.id);
check("the Team page lists them as not signed in yet", listed.some((p) => p.userId === invitee.id && p.status === "INVITED" && p.phone === INVITEE));
const t3 = new Date(t0.getTime() + 9 * 3_600_000);
const invitedAsk = await startPhoneSignIn({ raw: national(INVITEE), ip: "10.7.6.1", now: t3, floorMs: 0 });
check("the invited number is sent a code", invitedAsk.ok && sent.at(-1)?.to === INVITEE);
const claimed = await finishPhoneSignIn({ challengeId: invitedAsk.ok ? invitedAsk.challengeId : "", raw: INVITEE, code: lastCodeFor(INVITEE), now: t3 });
const [after] = await sql<{ verified: boolean; status: string }[]>`
  SELECT u.phone_verified_at IS NOT NULL AS verified, m.status FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = ${firm.id} WHERE u.id = ${invitee.id}`;
check("signing in with it claims the invite and proves the number", claimed.ok && claimed.orgId === firm.id && after?.verified && after.status === "ACTIVE", JSON.stringify([claimed, after]));
const inviteePhone = await resolvePhoneAuthz(invitee.id, firm.id);
check("and they hold an agent's tier on the phone, no money and no admin",
  inviteePhone.authz.can("partner:register") && !inviteePhone.authz.can("payout:read") && !inviteePhone.authz.can("member:invite"));
const notMine = await removePhonePerson({ orgId: firm.id, actorUserId: owner, authz: grantAt(firm, ["member:remove"]), membershipId: added.ok ? added.membershipId! : "" });
check("removing somebody needs everything their role holds", !notMine.ok);
const removed = await removePhonePerson({ orgId: firm.id, actorUserId: owner, authz: ownerConsole, membershipId: added.ok ? added.membershipId! : "" });
check("the owner removes them", removed.ok && (await sql`SELECT 1 FROM memberships WHERE user_id = ${invitee.id} AND status = 'REVOKED'`).length === 1);
const beforeGone = sent.length;
await startPhoneSignIn({ raw: INVITEE, ip: "10.7.6.2", now: new Date(t3.getTime() + 3_600_000), floorMs: 0 });
check("and their phone no longer signs in", sent.length === beforeGone);

// --- nothing in the audit log carries a number ------------------------------------
console.log("\nthe audit log");
const audited = await sql<{ action: string; row: string }[]>`
  SELECT action, row_to_json(a)::text AS row FROM audit_log a
  WHERE created_at >= ${began} AND (actor_user_id = ANY(${made.users}) OR org_id = ANY(${made.orgs}) OR action LIKE 'otp.%')`;
const actions = new Set(audited.map((a) => a.action));
check("sign-in, the withheld codes and the step-up are audited",
  ["auth.signin_phone", "otp.sent", "otp.withheld", "auth.step_up"].every((a) => actions.has(a)), [...actions].join(","));
const leaked = audited.filter((a) => ALL.some((p) => a.row.includes(national(p))));
check("no audit row carries a number, only its hash", leaked.length === 0, leaked.map((l) => l.action).join(","));
// Two people sign in by phone in this run, and the rows come back in no set
// order, so the owner's is looked for rather than taken as the first.
const signinRow = audited.find((a) => a.action === "auth.signin_phone" && a.row.includes(hashOf(OWNER)));
check("the sign-in row names the method and the number's hash", !!signinRow && signinRow.row.includes("\"phone\""));

// --- through the dev server's own provider -------------------------------------------
console.log("\nthrough the console");
class Jar {
  c = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      this.c.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  get header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
const up2 = await fetch(`${BASE}/signin/phone`).catch(() => null);
if (!up2) {
  check(`the dev server answers at ${BASE}`, false, "start it with the same .env.local");
} else {
  check("the phone sign-in page opens", up2.status === 200 && (await up2.text()).includes("Send code on WhatsApp"));
  const signinPage = await (await fetch(`${BASE}/signin`)).text();
  check("the sign-in page offers the phone door", signinPage.includes("/signin/phone"));

  const signInByPhone = async (phone: string, orgCookie?: string) => {
    const jar = new Jar();
    const t = new Date();
    await sql`DELETE FROM otp_challenges WHERE phone_hash = ${hashOf(phone)}`;
    const r = await startPhoneSignIn({ raw: phone, ip: "10.7.9.1", now: t, floorMs: 0 });
    const csrf = await fetch(`${BASE}/api/auth/csrf`);
    jar.take(csrf);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const res = await fetch(`${BASE}/api/auth/callback/phone`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header },
      body: new URLSearchParams({ csrfToken, challengeId: r.ok ? r.challengeId : "", phone, code: lastCodeFor(phone), callbackUrl: `${BASE}/` }),
    });
    jar.take(res);
    if (orgCookie) jar.c.set("salesdesk.org", orgCookie);
    return jar;
  };
  const get = (jar: Jar, path: string) => fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie: jar.header } });
  /** Sent away: a redirect, or one streamed into a page that had already begun. */
  const refused = async (jar: Jar, path: string) => {
    const r = await get(jar, path);
    const body = await r.text();
    return [302, 303, 307, 308, 404].includes(r.status) || /NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|http-equiv="refresh"/.test(body);
  };

  const jar = await signInByPhone(OWNER);
  check("the phone provider signs the person in", jar.c.has("authjs.session-token"));
  const session = (await (await get(jar, "/api/auth/session")).json()) as { method?: string; user?: { id?: string } };
  check("and the session records how: method phone", session.method === "phone" && session.user?.id === owner, JSON.stringify(session));

  check("the firm's leads open", !(await refused(jar, "/dashboard/leads")));
  check("the admin's roles, team and settings screens do not, though the person is the firm's admin",
    (await refused(jar, "/dashboard/settings/roles")) && (await refused(jar, "/dashboard/team")) && (await refused(jar, "/dashboard/settings/phone-numbers")));
  const plainExport = await get(jar, "/dashboard/leads/export");
  check("the leads file is not handed over without a code", plainExport.status >= 300 && plainExport.status < 400, String(plainExport.status));
  const noCode = await fetch(`${BASE}/dashboard/leads/export`, { method: "POST", redirect: "manual", headers: { cookie: jar.header }, body: new URLSearchParams({ challengeId: "", code: "123456" }) });
  check("nor for a made-up one", noCode.status === 403, String(noCode.status));
  const exportUp = await startStepUp({ userId: owner, orgId: firm.id, stepUp: ownerPhone.stepUp, permission: "lead:export", targetId: firm.id, ip: "10.7.9.2", now: new Date(Date.now() + 120_000) });
  const exportBody = () => new URLSearchParams({ challengeId: exportUp.ok ? exportUp.challengeId : "", code: lastCodeFor(OWNER) });
  const withCode = await fetch(`${BASE}/dashboard/leads/export`, { method: "POST", redirect: "manual", headers: { cookie: jar.header }, body: exportBody() });
  check("with a fresh code for the export, the file comes", withCode.status === 200 && (withCode.headers.get("content-type") ?? "").includes("text/csv"), String(withCode.status));
  const twice = await fetch(`${BASE}/dashboard/leads/export`, { method: "POST", redirect: "manual", headers: { cookie: jar.header }, body: exportBody() });
  check("and the same code does not bring it twice", twice.status === 403, String(twice.status));

  const agentJar = await signInByPhone(AGENT, dev.id);
  check("a phone session pointed at a developer the person also works for opens nothing there",
    await refused(agentJar, "/dashboard/leads"));
  const agentHome = await signInByPhone(AGENT);
  check("and signed in plainly, the same agent lands in the firm and works its leads",
    !(await refused(agentHome, "/dashboard/leads")));
  const devJar = await signInByPhone(DEVUSER);
  check("a developer's own person cannot sign in by phone", !devJar.c.has("authjs.session-token"));

  const webInvite = await invitePhonePerson({ orgId: firm.id, actorUserId: owner, authz: ownerConsole, name: "Otp Web Invitee", phone: INVITEE_WEB });
  const webJar = await signInByPhone(INVITEE_WEB);
  const webSession = (await (await get(webJar, "/api/auth/session")).json()) as { method?: string };
  check("a person the owner added signs in through the console's phone door, and lands in the firm",
    webInvite.ok && webJar.c.has("authjs.session-token") && webSession.method === "phone" && !(await refused(webJar, "/dashboard/leads"))
      && (await sql`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.phone = ${INVITEE_WEB} AND m.status = 'ACTIVE'`).length === 1);
}

codes.restore();
await drop();
await sql.end();
await closeDb();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
