/**
 * Single sign-on and SCIM provisioning, end to end, with a local identity
 * provider: a throwaway key pair in `db/fixtures/sso/` signs the
 * assertions, and DNS is injected.
 *
 * Two tenants of its own, built here and removed at the end. The first sets
 * up its provider from pasted metadata, proves a domain by TXT record, and
 * signs a person in through a signed assertion; then every way an assertion
 * must be refused (unsigned, signed by another key, for another audience,
 * expired, answering no request of ours, replayed, on another domain, a
 * second assertion wrapped in beside a signed one). Requiring it turns
 * Google and Microsoft away for everyone but an admin. Then SCIM as Okta
 * and Entra ID send it: a token, people, a group that gives nothing until
 * it is mapped, members added, removed and replaced, somebody deactivated
 * losing every membership, the last admin kept, and the other tenant's
 * token reaching nothing here.
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { SignedXml } from "xml-crypto";
import { closeDb } from "../src/lib/db/index.ts";
import {
  addDomain,
  finishSamlLogin,
  redeemTicket,
  saveSsoConfig,
  setEnforce,
  ssoRequiredFor,
  ssoSettings,
  startSamlLogin,
  ticketOrg,
  useDns,
  verifyDomain,
} from "../src/lib/sso.ts";
import { readSsoInput, spValues, txtRecord } from "../src/lib/sso-rules.ts";
import {
  createGroup,
  createScimToken,
  createUser,
  deleteGroup,
  deleteUser,
  getUser,
  listUsers,
  mapGroup,
  patchGroup,
  patchUser,
  revokeScimToken,
  scimAuth,
} from "../src/lib/scim.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const KEY = readFileSync("db/fixtures/sso/idp-key.pem", "utf8");
const CERT = readFileSync("db/fixtures/sso/idp-cert.pem", "utf8");
const OTHER_KEY = readFileSync("db/fixtures/sso/other-key.pem", "utf8");
const OTHER_CERT = readFileSync("db/fixtures/sso/other-cert.pem", "utf8");
const certBody = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
const BASE = (process.env.SSO_BASE_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");

const tag = Date.now().toString(36);
const DOMAIN = `acme${tag}.example`;
const SECOND = `acme-india${tag}.example`;
const IDP = `https://idp.${DOMAIN}/saml`;
const made = { users: [] as string[], orgs: [] as string[] };

async function tenant(name: string, domain: string) {
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${`admin@${domain}`}, ${domain}, ${`${name} Admin`}) RETURNING id`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, 'AAPFU0939F', ${domain}, ${admin.id}) RETURNING id`;
  made.users.push(admin.id);
  made.orgs.push(org.id);
  const slug = `sso_${name.toLowerCase().replace(/\W/g, "")}_${tag}`;
  const [root] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, NULL, 'ORG', ${name}, ${slug}, ${slug}::ltree) RETURNING id, path::text AS path`;
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${org.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
  return { orgId: org.id, admin: admin.id, adminEmail: `admin@${domain}`, root };
}

const A = await tenant("Acme", DOMAIN);
const B = await tenant("Other", `other${tag}.example`);
const sp = spValues(BASE, A.orgId);
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/** The request id inside a redirect we were sent to. */
function requestId(url: string): string {
  const q = new URL(url).searchParams.get("SAMLRequest")!;
  return inflateRawSync(Buffer.from(q, "base64")).toString("utf8").match(/\bID="([^"]+)"/)![1];
}

/** An IdP's answer, the assertion signed with `key`, or not at all. */
function response(o: {
  inResponseTo: string | null;
  email: string;
  key?: string | null;
  cert?: string;
  audience?: string;
  notOnOrAfter?: string;
  wrapFor?: string;
}): string {
  const id = `_a${randomBytes(12).toString("hex")}`;
  const now = iso(0);
  const later = o.notOnOrAfter ?? iso(5 * 60_000);
  const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : "";
  const assertion = (aid: string, email: string) => `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${now}"><saml:Issuer>${IDP}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${sp.acsUrl}"${irt}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? sp.entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>Priya Sharma</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
  let a = assertion(id, o.email);
  if (o.key !== null) {
    const sig = new SignedXml({
      privateKey: o.key ?? KEY,
      publicCert: o.cert ?? CERT,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    });
    sig.computeSignature(a, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
    a = sig.getSignedXml();
  }
  // A second, unsigned assertion slipped in front of a signed one.
  const wrapped = o.wrapFor ? assertion(`_w${randomBytes(8).toString("hex")}`, o.wrapFor) : "";
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${now}" Destination="${sp.acsUrl}"${irt}><saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${wrapped}${a}</samlp:Response>`;
  return Buffer.from(xml).toString("base64");
}

const metadata = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certBody(CERT)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.${DOMAIN}/post"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.${DOMAIN}/redirect"/></md:IDPSSODescriptor></md:EntityDescriptor>`;

let txt: Record<string, string[][]> = {};
const dns = useDns(async (d) => txt[d] ?? []);

try {
  console.log("\nSetting it up from the provider's metadata");
  const read = readSsoInput({ metadata }, new Date().toISOString());
  check("the metadata gives the entity ID, the redirect sign-in URL and the certificate",
    read.ok && read.input.entityId === IDP && read.input.ssoUrl === `https://idp.${DOMAIN}/redirect` && read.input.certificates[0] === certBody(CERT),
    JSON.stringify(read));
  if (!read.ok) throw new Error("metadata");
  check("a sign-in URL that is not https is refused", !readSsoInput({ entityId: IDP, ssoUrl: "http://idp.example/x", certificate: CERT }, new Date().toISOString()).ok);
  check("so is a certificate that is not one", !readSsoInput({ entityId: IDP, ssoUrl: "https://idp.example/x", certificate: "hello" }, new Date().toISOString()).ok);
  const saved = await saveSsoConfig({ orgId: A.orgId, userId: A.admin, input: read.input });
  check("the provider is saved", saved.ok, saved.message);
  let s = await ssoSettings(A.orgId);
  check("the company's own domain is proved on the way", s.domains.some((d) => d.domain === DOMAIN && d.verified));
  check("requiring it before anybody has signed in through it is refused", !(await setEnforce({ orgId: A.orgId, userId: A.admin, on: true })).ok);

  console.log("\nA second domain, proved by DNS");
  check("a public mail domain cannot be added", !(await addDomain({ orgId: A.orgId, userId: A.admin, raw: "gmail.com" })).ok);
  check("the second domain is added", (await addDomain({ orgId: A.orgId, userId: A.admin, raw: `https://${SECOND}/` })).ok);
  s = await ssoSettings(A.orgId);
  const record = s.domains.find((d) => d.domain === SECOND)!.record;
  check("without the TXT record it is not proved", !(await verifyDomain({ orgId: A.orgId, userId: A.admin, domain: SECOND })).ok);
  txt[SECOND] = [["v=spf1 -all"], [record.slice(0, 20), record.slice(20)]];
  check("with it, split into chunks as DNS returns it, it is", (await verifyDomain({ orgId: A.orgId, userId: A.admin, domain: SECOND })).ok);
  await addDomain({ orgId: B.orgId, userId: B.admin, raw: SECOND });
  const bRecord = (await ssoSettings(B.orgId)).domains.find((d) => d.domain === SECOND)!.record;
  txt[SECOND] = [[bRecord]];
  const stolen = await verifyDomain({ orgId: B.orgId, userId: B.admin, domain: SECOND });
  check("another company cannot prove a domain one company already proved", !stolen.ok && stolen.message.includes("already proved"), stolen.message);
  txt = {};

  console.log("\nSigning in through it");
  const url = await startSamlLogin(A.orgId, { test: true });
  check("sign-in sends the browser to the provider's redirect URL with our request", !!url && url.startsWith(`https://idp.${DOMAIN}/redirect?SAMLRequest=`));
  const rid = requestId(url!);
  const email = `priya@${DOMAIN}`;
  const good = response({ inResponseTo: rid, email });
  const ok = await finishSamlLogin(A.orgId, { SAMLResponse: good, RelayState: "test" });
  check("a signed assertion answering our request signs the person in", ok.ok && ok.test, JSON.stringify(ok));
  const ticket = ok.ok ? ok.ticket : "";
  check("the ticket names the company it was issued in", (await ticketOrg(ticket)) === A.orgId);
  const person = await redeemTicket(ticket);
  check("spending the ticket gives the person, named from the assertion", person?.email === email && person?.name === "Priya Sharma");
  if (person) made.users.push(person.id);
  check("a ticket spends once", (await redeemTicket(ticket)) === null);
  check("the same answer posted again is refused", !(await finishSamlLogin(A.orgId, { SAMLResponse: good, RelayState: "" })).ok);
  check("the provider now reads as tested", !!(await ssoSettings(A.orgId)).config?.testedAt);

  const again = async (o: Omit<Parameters<typeof response>[0], "inResponseTo"> & { noRequest?: boolean }) => {
    const id = o.noRequest ? `_nobody${randomBytes(6).toString("hex")}` : requestId((await startSamlLogin(A.orgId))!);
    return finishSamlLogin(A.orgId, { SAMLResponse: response({ ...o, inResponseTo: id }), RelayState: "" });
  };
  const code = (r: Awaited<ReturnType<typeof finishSamlLogin>>) => (r.ok ? "OK" : r.code);
  check("an unsigned assertion is refused", code(await again({ email, key: null })) === "INVALID");
  check("one signed by any other key is refused", code(await again({ email, key: OTHER_KEY, cert: OTHER_CERT })) === "INVALID");
  check("one for another audience is refused", code(await again({ email, audience: "https://somebody-else.example/sp" })) === "INVALID");
  check("an expired one is refused", code(await again({ email, notOnOrAfter: iso(-10 * 60_000) })) === "INVALID");
  check("one answering no request of ours is refused", code(await again({ email, noRequest: true })) === "INVALID");
  check("an address outside the proved domains is refused", code(await again({ email: `priya${tag}@gmail.com` })) === "WRONG_DOMAIN");
  const wrapped = await again({ email, wrapFor: `ceo@${DOMAIN}` });
  const wrappedWho = wrapped.ok ? (await redeemTicket(wrapped.ticket))?.email : null;
  check("an unsigned assertion wrapped in beside a signed one signs nobody in as it", !wrapped.ok || wrappedWho === email, String(wrappedWho));
  check("a person on the second proved domain signs in too", code(await again({ email: `ravi@${SECOND}` })) === "OK");
  const ravi = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${`ravi@${SECOND}`}`;
  made.users.push(...ravi.map((r) => r.id));

  console.log("\nRequiring it");
  const req = await setEnforce({ orgId: A.orgId, userId: A.admin, on: true });
  check("once tested, it can be required", req.ok, req.message);
  check("Google and Microsoft now turn the company's people away", await ssoRequiredFor(email));
  check("but never its admin, who keeps the ordinary door", !(await ssoRequiredFor(A.adminEmail)));
  check("and nobody on another company's domain", !(await ssoRequiredFor(`someone@other${tag}.example`)));
  const changed = await saveSsoConfig({ orgId: A.orgId, userId: A.admin, input: { ...read.input, certificates: [certBody(OTHER_CERT)] } });
  s = await ssoSettings(A.orgId);
  check("a new certificate is a new connection: untested, and no longer required", changed.ok && !s.config?.enforce && !s.config?.testedAt);
  await saveSsoConfig({ orgId: A.orgId, userId: A.admin, input: read.input });

  console.log("\nSCIM: a token, and people");
  const t = await createScimToken({ orgId: A.orgId, userId: A.admin, label: "Okta" });
  const tb = await createScimToken({ orgId: B.orgId, userId: B.admin, label: "Okta" });
  if (!t.ok || !tb.ok) throw new Error("token");
  check("a token finds its company", (await scimAuth(`Bearer ${t.token}`)) === A.orgId);
  check("no token, a wrong one, or a malformed header finds nothing",
    (await scimAuth(null)) === null && (await scimAuth("Bearer est_scim_nope")) === null && (await scimAuth(t.token)) === null);
  const [stored] = await sql<{ token_hash: string }[]>`SELECT token_hash FROM scim_tokens WHERE org_id = ${A.orgId}`;
  check("the token is stored only as its hash", stored.token_hash.length === 64 && !stored.token_hash.includes(t.token));

  const mk = (userName: string, extra: Record<string, unknown> = {}) =>
    createUser(A.orgId, { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName, name: { givenName: "Asha", familyName: "Rao" }, active: true, ...extra });
  const asha = await mk(`asha@${DOMAIN}`);
  check("a person on the company's domain is created", asha.ok && asha.status === 201, JSON.stringify(asha));
  const ashaId = (asha.body as { id: string }).id;
  check("a public mailbox is refused", (await mk(`asha${tag}@gmail.com`)).status === 400);
  check("so is a domain the company has not proved", (await mk(`asha@notours${tag}.example`)).status === 400);
  check("the same userName twice is a conflict", (await mk(`asha@${DOMAIN}`)).status === 409);
  const found = await listUsers(A.orgId, `userName eq "asha@${DOMAIN}"`, 1, 100);
  check("a provider looks a person up by userName", found.ok && (found.body as { totalResults: number }).totalResults === 1);
  check("another company's token reads nothing of this one", (await getUser(B.orgId, ashaId)).status === 404);
  const [ashaUser] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${`asha@${DOMAIN}`}`;
  made.users.push(ashaUser.id);
  const live = async () =>
    sql<{ role: string; scim: boolean }[]>`
      SELECT role, scim_group_id IS NOT NULL AS scim FROM memberships WHERE org_id = ${A.orgId} AND user_id = ${ashaUser.id} AND status = 'ACTIVE'`;
  check("a person created is given nothing on their own", (await live()).length === 0);

  console.log("\nGroups give only what an admin says they give");
  const grp = await createGroup(A.orgId, { displayName: "Sales", members: [{ value: ashaId }] });
  check("a group is created with its members", grp.ok && grp.status === 201);
  const grpId = (grp.body as { id: string }).id;
  check("and gives nothing until it is mapped", (await live()).length === 0);
  const mapped = await mapGroup({ orgId: A.orgId, userId: A.admin, groupId: grpId, role: "SALES_HEAD", nodeId: A.root.id });
  check("mapped to Sales Head, its members hold it", mapped.ok && (await live()).some((m) => m.role === "SALES_HEAD" && m.scim));
  const removed = await patchGroup(A.orgId, grpId, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Remove", path: `members[value eq "${ashaId}"]` }] });
  check("removed from the group, as Entra ID sends it, the role goes", removed.ok && (await live()).length === 0);
  const back = await patchGroup(A.orgId, grpId, { Operations: [{ op: "replace", path: "members", value: [{ value: ashaId }] }] });
  check("the list replaced, as Okta sends it, brings it back", back.ok && (await live()).length === 1);
  const [proj] = await sql<{ id: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${A.orgId}, ${A.root.id}, 'ENTITY', 'Acme LLP', 'llp', ${`${A.root.path}.llp`}::ltree) RETURNING id`;
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${ashaUser.id}, ${A.orgId}, ${proj.id}, 'MARKETING_HEAD', 'ACTIVE')`;
  const off = await patchUser(A.orgId, ashaId, { Operations: [{ op: "Replace", path: "active", value: "False" }] });
  check("deactivated, as Entra ID sends it, every membership ends, the one given by hand too", off.ok && (await live()).length === 0);
  const on = await patchUser(A.orgId, ashaId, { Operations: [{ op: "replace", value: { active: true } }] });
  check("reactivated, the group's role comes back and nothing else", on.ok && JSON.stringify((await live()).map((m) => m.role)) === '["SALES_HEAD"]');
  check("an email address is not changed from under a person", (await patchUser(A.orgId, ashaId, { Operations: [{ op: "replace", path: "emails[type eq \"work\"].value", value: `other@${DOMAIN}` }] })).status === 400);

  console.log("\nThe last admin, and removing things");
  const me = await mk(A.adminEmail);
  const meId = (me.body as { id: string }).id;
  const lastAdmin = await deleteUser(A.orgId, meId);
  check("removing the last admin through SCIM is refused with 409", lastAdmin.status === 409, JSON.stringify(lastAdmin.body));
  const [still] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM memberships WHERE org_id = ${A.orgId} AND user_id = ${A.admin} AND role = 'ORG_ADMIN' AND status = 'ACTIVE'`;
  check("and the admin stays", still.n === 1);
  const gone = await deleteGroup(A.orgId, grpId);
  check("removing a group ends what it gave", gone.status === 204 && (await live()).length === 0);
  check("removing a person is 204", (await deleteUser(A.orgId, ashaId)).status === 204);
  check("a revoked token finds nothing", (await revokeScimToken({ orgId: A.orgId, userId: A.admin, tokenId: (await sql<{ id: string }[]>`SELECT id FROM scim_tokens WHERE org_id = ${A.orgId}`)[0].id })).ok && (await scimAuth(`Bearer ${t.token}`)) === null);
  const audits = await sql<{ action: string; target_id: string | null }[]>`SELECT action, target_id FROM audit_log WHERE org_id = ${A.orgId}`;
  check("every step is audited, and no row names an address", audits.some((a) => a.action === "auth.sso_signin") && audits.some((a) => a.action === "scim.user_created") && audits.every((a) => !String(a.target_id ?? "").includes("@")));
} finally {
  dns.restore();
  for (const orgId of made.orgs) {
    await sql`UPDATE memberships SET scim_group_id = NULL WHERE org_id = ${orgId}`;
    for (const t of ["scim_group_members", "scim_groups", "scim_users", "scim_tokens", "sso_tickets", "saml_seen", "saml_requests", "sso_domains", "sso_configs"]) {
      await sql.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [orgId]);
    }
  }
  await sql`DELETE FROM audit_log WHERE org_id = ANY(${made.orgs})`;
  await sql`DELETE FROM orgs WHERE id = ANY(${made.orgs})`;
  await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  await sql`DELETE FROM users WHERE email LIKE ${`%${tag}.example`} OR email LIKE ${`%${tag}@gmail.com`}`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
