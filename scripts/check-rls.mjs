// Cross-tenant leak check.
//
// Seeds two tenants through the owner connection, then attacks tenant B from
// tenant A's context using the app role. Everything here must come back empty
// or refused. This is the suite that catches the class of bug that ends the
// company, so it asserts on writes as well as reads, and on the unset-context
// case -- a pooled connection that forgets to pin app.org_id must see nothing,
// not everything.
import postgres from "postgres";

const owner = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const app = postgres(process.env.DATABASE_APP_URL, { max: 1, onnotice: () => {} });
const retention = postgres(process.env.DATABASE_RETENTION_URL, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

/** Run as the app role with RLS pinned to one tenant. */
function asTenant(orgId, fn) {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  });
}

const tag = Date.now().toString(36);
const seed = async (name, slug, gstin) => {
  const [u] = await owner`
    INSERT INTO users (email, email_domain, name)
    VALUES (${`admin@${slug}${tag}.com`}, ${`${slug}${tag}.com`}, ${name})
    RETURNING id`;
  const [o] = await owner`
    INSERT INTO orgs (type, legal_name, display_name, gstin, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, ${gstin}, 'AAPFU0939F',
            ${`${slug}${tag}.com`}, ${u.id})
    RETURNING id`;
  const [n] = await owner`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${o.id}, NULL, 'ORG', ${name}, ${slug + tag}, ${slug + tag}::ltree)
    RETURNING id`;
  await owner`
    INSERT INTO memberships (user_id, org_id, scope_node_id, role, status)
    VALUES (${u.id}, ${o.id}, ${n.id}, 'ORG_ADMIN', 'ACTIVE')`;
  await owner`
    INSERT INTO audit_log (org_id, actor_user_id, action)
    VALUES (${o.id}, ${u.id}, 'org.created')`;
  return { userId: u.id, orgId: o.id, nodeId: n.id };
};

const A = await seed("Tenant A Developers", "tenant_a_", null);
const B = await seed("Tenant B Developers", "tenant_b_", null);

// Each tenant writes one role of its own, so the isolation assertions below
// have something real to try to reach across the boundary.
for (const [t, key] of [[A, "C_A_ONLY"], [B, "C_B_ONLY"]]) {
  await owner`
    INSERT INTO org_roles (org_id, key, label, description, min_kind, source, permissions)
    VALUES (${t.orgId}, ${key}, 'Private role', 'Tenant-defined.', 'ORG', 'CUSTOM',
            ARRAY['lead:read', 'member:read'])`;
}

console.log("\nreads from tenant A's context");
await asTenant(A.orgId, async (tx) => {
  const orgs = await tx`SELECT id FROM orgs`;
  check("orgs returns only tenant A", orgs.length === 1 && orgs[0].id === A.orgId, `${orgs.length} rows`);

  const nodes = await tx`SELECT id, org_id FROM scope_nodes`;
  check("scope_nodes returns only tenant A", nodes.every((r) => r.org_id === A.orgId) && nodes.length === 1);

  const direct = await tx`SELECT id FROM scope_nodes WHERE id = ${B.nodeId}`;
  check("tenant B's node is invisible even by explicit id", direct.length === 0);

  const mem = await tx`SELECT id FROM memberships WHERE org_id = ${B.orgId}`;
  check("tenant B's memberships are invisible", mem.length === 0);

  const users = await tx`SELECT id FROM users WHERE id = ${B.userId}`;
  check("tenant B's user is invisible in the global users table", users.length === 0);

  const mine = await tx`SELECT id FROM users WHERE id = ${A.userId}`;
  check("own user IS visible (membership-derived policy works)", mine.length === 1);

  const logs = await tx`SELECT id FROM audit_log`;
  check("audit_log shows only tenant A", logs.length === 1);
});

console.log("\nwrites from tenant A's context");
await asTenant(A.orgId, async (tx) => {
  const upd = await tx`UPDATE orgs SET display_name = 'HIJACKED' WHERE id = ${B.orgId}`;
  check("cannot update tenant B's org", upd.count === 0, `${upd.count} rows affected`);

  const del = await tx`DELETE FROM scope_nodes WHERE id = ${B.nodeId}`;
  check("cannot delete tenant B's scope node", del.count === 0, `${del.count} rows affected`);
});

// A refused statement aborts the surrounding transaction, so these negative
// cases each get their own, and the assertion happens outside it.
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${B.orgId}, NULL, 'ORG', 'smuggled', ${"smuggled" + tag}, ${"smuggled" + tag}::ltree)`;
  });
  check("cannot insert a row belonging to tenant B", false, "insert succeeded");
} catch (e) {
  check("cannot insert a row belonging to tenant B", e.code === "42501", e.code);
}

try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE audit_log SET action = 'tampered' WHERE org_id = ${A.orgId}`;
  });
  check("audit_log is not updatable by the app role", false, "update succeeded");
} catch (e) {
  check("audit_log is not updatable by the app role", e.code === "42501", e.code);
}

console.log("");
console.log("org_roles from tenant A's context");
await asTenant(A.orgId, async (tx) => {
  const mine = await tx`SELECT key, label FROM org_roles`;
  check(
    "sees only its own role definitions",
    mine.length === 1 && mine[0].key === "C_A_ONLY",
    mine.map((r) => r.key).join(", "),
  );

  const theirs = await tx`SELECT key FROM org_roles WHERE key = 'C_B_ONLY'`;
  check("tenant B's roles are invisible even by explicit key", theirs.length === 0);

  const upd = await tx`
    UPDATE org_roles SET permissions = ARRAY['lead:export'] WHERE org_id = ${B.orgId}`;
  check("cannot widen a role in tenant B", upd.count === 0, `${upd.count} rows affected`);

  const del = await tx`DELETE FROM org_roles WHERE org_id = ${B.orgId}`;
  check("cannot delete a role in tenant B", del.count === 0, `${del.count} rows affected`);
});

try {
  await asTenant(A.orgId, async (tx) => {
    await tx`
      INSERT INTO org_roles (org_id, key, label, min_kind, source, permissions)
      VALUES (${B.orgId}, 'C_SMUGGLED', 'Smuggled', 'ORG', 'CUSTOM', ARRAY['lead:export'])`;
  });
  check("cannot define a role inside tenant B", false, "insert succeeded");
} catch (e) {
  check("cannot define a role inside tenant B", e.code === "42501", e.code);
}

// The founding role is immutable at the schema level, not only in the app. A
// tenant that could narrow ORG_ADMIN could lock itself out of its own
// organisation, and the only way back would be us editing their database.
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`
      INSERT INTO org_roles (org_id, key, label, min_kind, source, permissions)
      VALUES (${A.orgId}, 'ORG_ADMIN', 'Nerfed admin', 'ORG', 'OVERRIDE', ARRAY['lead:read'])`;
  });
  check("the founding role cannot be overridden", false, "insert succeeded");
} catch (e) {
  check("the founding role cannot be overridden", e.code === "23514", e.code);
}

// Key spaces cannot overlap, so an invented role can never impersonate one we
// ship, nor a shipped key be smuggled in as a custom row.
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`
      INSERT INTO org_roles (org_id, key, label, min_kind, source, permissions)
      VALUES (${A.orgId}, 'SALES_HEAD', 'Fake', 'ORG', 'CUSTOM', ARRAY['lead:read'])`;
  });
  check("a custom role cannot claim a shipped key", false, "insert succeeded");
} catch (e) {
  check("a custom role cannot claim a shipped key", e.code === "23514", e.code);
}

await app.begin(async (tx) => {
  const roles = await tx`SELECT key FROM org_roles`;
  check("org_roles is empty when app.org_id is unset", roles.length === 0, `${roles.length} rows`);
});

console.log("");
console.log("the Project Brain: isolation, and what a published version refuses");

// Each tenant publishes one version, so the assertions below have something
// real to try to reach across the boundary.
// Seeded the way the application writes it, because it is the only way the
// database allows: a DRAFT is filled in and signed, and only then does it
// become PUBLISHED. Facts cannot be inserted into a published version at all.
const brainOf = {};
for (const t of [A, B]) {
  const [v] = await owner`
    INSERT INTO brain_versions (org_id, scope_node_id, version, state)
    VALUES (${t.orgId}, ${t.nodeId}, 1, 'DRAFT')
    RETURNING id`;
  await owner`
    INSERT INTO brain_fields (brain_version_id, org_id, field_key, value)
    VALUES (${v.id}, ${t.orgId}, 'price.base_psf', '14500')`;
  await owner`
    INSERT INTO brain_signatures (brain_version_id, org_id, field_group, group_hash, signed_by)
    VALUES (${v.id}, ${t.orgId}, 'PRICE', ${"h" + t.orgId.slice(0, 8)}, ${t.userId})`;
  await owner`
    UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${v.id}`;
  brainOf[t.orgId] = v.id;
}

await asTenant(A.orgId, async (tx) => {
  const mine = await tx`SELECT id FROM brain_versions`;
  check("sees only its own brain versions", mine.length === 1, `${mine.length} rows`);

  const theirs = await tx`SELECT id FROM brain_versions WHERE id = ${brainOf[B.orgId]}`;
  check("another tenant's version is invisible by explicit id", theirs.length === 0);

  // The whole guarantee of the Brain: a fact reaches a buyer only if somebody
  // signed it. Reading another tenant's price would be the same leak as
  // reading their leads.
  const facts = await tx`SELECT value FROM brain_fields WHERE brain_version_id = ${brainOf[B.orgId]}`;
  check("and so are its facts", facts.length === 0, `${facts.length} rows`);

  const sigs = await tx`SELECT id FROM brain_signatures WHERE org_id = ${B.orgId}`;
  check("and its signatures", sigs.length === 0, `${sigs.length} rows`);

  const upd = await tx`
    UPDATE brain_versions SET state = 'SUPERSEDED' WHERE org_id = ${B.orgId}`;
  check("cannot supersede another tenant's live version", upd.count === 0, `${upd.count} rows`);
});

// Published is immutable in the database, not by convention. Editing a
// published fact would leave a signature attesting to something that is no
// longer there.
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`
      UPDATE brain_fields SET value = '99999'
      WHERE brain_version_id = ${brainOf[A.orgId]}`;
  });
  check("a published fact cannot be edited", false, "update succeeded");
} catch (e) {
  check("a published fact cannot be edited", e.code === "23514", e.code);
}

try {
  await asTenant(A.orgId, async (tx) => {
    await tx`DELETE FROM brain_fields WHERE brain_version_id = ${brainOf[A.orgId]}`;
  });
  check("nor deleted", false, "delete succeeded");
} catch (e) {
  check("nor deleted", e.code === "23514", e.code);
}

// The state machine only runs forwards. A published version reopened as a
// draft would carry its signatures with it.
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE brain_versions SET state = 'DRAFT' WHERE id = ${brainOf[A.orgId]}`;
  });
  check("a published version cannot be reopened as a draft", false, "update succeeded");
} catch (e) {
  check("a published version cannot be reopened as a draft", e.code === "23514", e.code);
}

// A signature is a record of somebody putting their name to a number. It is
// withdrawn by superseding the version, never by rewriting the row.
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE brain_signatures SET signed_by = ${B.userId} WHERE org_id = ${A.orgId}`;
  });
  check("a signature cannot be reassigned to somebody else", false, "update succeeded");
} catch (e) {
  check("a signature cannot be reassigned to somebody else", e.code === "42501", e.code);
}

try {
  await asTenant(A.orgId, async (tx) => {
    await tx`DELETE FROM brain_signatures WHERE org_id = ${A.orgId}`;
  });
  check("nor deleted once given", false, "delete succeeded");
} catch (e) {
  check("nor deleted once given", e.code === "42501", e.code);
}

await app.begin(async (tx) => {
  const rows = await tx`SELECT id FROM brain_fields`;
  check("brain_fields is empty when app.org_id is unset", rows.length === 0, `${rows.length} rows`);
});

console.log("");
console.log("channel partners: the grantor's rows, and what a partner's session may read");

// Tenant A empanels two partner firms on its root node, registers a buyer
// for each, and writes a payout. The firms are orgs of their own, the way
// the product creates them.
const cpOrg = async (name, pan) => {
  const [o] = await owner`
    INSERT INTO orgs (type, legal_name, display_name, pan, status)
    VALUES ('CHANNEL_PARTNER', ${name}, ${name}, ${pan}, 'PENDING_VERIFICATION') RETURNING id`;
  return o.id;
};
const CP1 = await cpOrg("Partner One " + tag, "AAAFP1111A");
const CP2 = await cpOrg("Partner Two " + tag, "AAAFP2222B");
const [termsA] = await owner`
  INSERT INTO commission_terms (org_id, scope_node_id, steps)
  VALUES (${A.orgId}, ${A.nodeId}, '[{"from":1,"rate":0.02}]'::jsonb) RETURNING id`;
await owner`INSERT INTO partner_settings (org_id) VALUES (${A.orgId})`;
for (const [cp, pan] of [[CP1, "AAAFP1111A"], [CP2, "AAAFP2222B"]]) {
  await owner`
    INSERT INTO partner_firms (org_id, cp_org_id, name, legal_name, pan)
    VALUES (${A.orgId}, ${cp}, 'Firm', 'Firm LLP', ${pan})`;
}
const grantOf = {};
for (const cp of [CP1, CP2]) {
  const [g] = await owner`
    INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_from, valid_to, commission_terms_ref)
    VALUES (${A.orgId}, ${cp}, ${A.nodeId}, 'CHANNEL_PARTNER', now() - interval '1 day', now() + interval '30 days', ${termsA.id})
    RETURNING id`;
  grantOf[cp] = g.id;
}
const regOf = {};
for (const [cp, phone] of [[CP1, "+919800000101"], [CP2, "+919800000102"]]) {
  const [r] = await owner`
    INSERT INTO client_registrations (org_id, cp_org_id, grant_id, scope_node_id, phone, via, verdict, valid_until)
    VALUES (${A.orgId}, ${cp}, ${grantOf[cp]}, ${A.nodeId}, ${phone}, 'CONSOLE', 'REGISTERED', now() + interval '20 days')
    RETURNING id`;
  regOf[cp] = r.id;
}
const [leadA] = await owner`
  INSERT INTO leads (org_id, scope_node_id, name, phone, stage) VALUES (${A.orgId}, ${A.nodeId}, 'Buyer', '+919800000101', 'booked')
  RETURNING id`;
const [payA] = await owner`
  INSERT INTO partner_payouts (org_id, lead_id, registration_id, cp_org_id, scope_node_id, agreement, booking_no, rate, gst_registered, booked_on)
  VALUES (${A.orgId}, ${leadA.id}, ${regOf[CP1]}, ${CP1}, ${A.nodeId}, 10000000, 1, 0.02, true, current_date)
  RETURNING id`;
const [mileA] = await owner`
  INSERT INTO payout_milestones (org_id, payout_id, key, base, gst, gross, tds, net)
  VALUES (${A.orgId}, ${payA.id}, 'M1', 100000, 18000, 118000, 2000, 116000) RETURNING id`;
await owner`
  INSERT INTO partner_invoices (org_id, milestone_id, cp_org_id, invoice_no, invoice_date, amount, storage_key, media_type, bytes)
  VALUES (${A.orgId}, ${mileA.id}, ${CP1}, 'INV-1', current_date, 118000, ${"org/" + A.orgId + "/invoice/x"}, 'application/pdf', 10)`;

const [firmRowA] = await owner`SELECT id FROM partner_firms WHERE org_id = ${A.orgId} AND cp_org_id = ${CP1}`;
await owner`
  INSERT INTO partner_links (org_id, firm_id, cp_org_id, scope_node_id, code)
  VALUES (${A.orgId}, ${firmRowA.id}, ${CP1}, ${A.nodeId}, 'TA-PO-1234')`;
const [agentA] = await owner`
  INSERT INTO partner_agents (org_id, firm_id, cp_org_id, name, phone)
  VALUES (${A.orgId}, ${firmRowA.id}, ${CP1}, 'Agent', '+919800000150') RETURNING id`;
await owner`
  INSERT INTO partner_bot_pending (org_id, agent_id, kind, action, expires_at)
  VALUES (${A.orgId}, ${agentA.id}, 'CONFIRM', '{"for":"book"}'::jsonb, now() + interval '90 seconds')`;
await owner`
  INSERT INTO partner_bot_turns (org_id, agent_id, firm_id, action, outcome)
  VALUES (${A.orgId}, ${agentA.id}, ${firmRowA.id}, 'help', 'DONE')`;

await asTenant(B.orgId, async (tx) => {
  for (const table of ["partner_firms", "grants", "client_registrations", "partner_payouts", "payout_milestones", "partner_invoices", "commission_terms", "partner_settings", "partner_links", "partner_agents", "partner_bot_pending", "partner_bot_turns"]) {
    const rows = await tx.unsafe(`SELECT 1 FROM ${table}`);
    check(`another tenant sees none of A's ${table}`, rows.length === 0, `${rows.length} rows`);
  }
  const bound = await tx`UPDATE partner_agents SET status = 'ACTIVE', bound_at = now() WHERE org_id = ${A.orgId}`;
  check("another tenant cannot bind A's partner agent", bound.count === 0, `${bound.count} rows`);
  const upd = await tx`UPDATE grants SET valid_to = now() + interval '10 years' WHERE org_id = ${A.orgId}`;
  check("another tenant cannot stretch A's grant", upd.count === 0, `${upd.count} rows`);
  const moved = await tx`UPDATE payout_milestones SET stage = 'INVOICED' WHERE org_id = ${A.orgId}`;
  check("nor move A's payout", moved.count === 0, `${moved.count} rows`);
});

try {
  await asTenant(B.orgId, async (tx) => {
    await tx`
      INSERT INTO partner_agents (org_id, firm_id, cp_org_id, name, phone)
      VALUES (${A.orgId}, ${firmRowA.id}, ${CP1}, 'Planted', '+919800000151')`;
  });
  check("another tenant cannot put somebody on A's partner list", false, "insert succeeded");
} catch (e) {
  check("another tenant cannot put somebody on A's partner list", e.code === "42501", e.code);
}

try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE partner_agents SET is_principal = true WHERE id = ${agentA.id}`;
  });
  check("who a firm's principal is cannot be rewritten", false, "update succeeded");
} catch (e) {
  check("who a firm's principal is cannot be rewritten", e.code === "42501", e.code);
}

try {
  await asTenant(A.orgId, async (tx) => {
    await tx`DELETE FROM partner_bot_turns WHERE org_id = ${A.orgId}`;
  });
  check("the bot's turns cannot be deleted by the app", false, "delete succeeded");
} catch (e) {
  check("the bot's turns cannot be deleted by the app", e.code === "42501", e.code);
}

try {
  await asTenant(B.orgId, async (tx) => {
    await tx`
      INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_to)
      VALUES (${A.orgId}, ${CP1}, ${A.nodeId}, 'CHANNEL_PARTNER', now() + interval '1 day')`;
  });
  check("another tenant cannot write a grant from A's tree", false, "insert succeeded");
} catch (e) {
  check("another tenant cannot write a grant from A's tree", e.code === "42501", e.code);
}

// The developers a partner firm works with, found from its own tenant: ids
// and names, and only where a developer has the firm on its desk.
await asTenant(CP1, async (tx) => {
  const devs = await tx`SELECT org_id FROM partner_developers_for_firm()`;
  check("a partner finds the developer that has it on its desk", devs.length === 1 && devs[0].org_id === A.orgId, `${devs.length} rows`);
});
await asTenant(B.orgId, async (tx) => {
  const devs = await tx`SELECT org_id FROM partner_developers_for_firm()`;
  check("a developer finds nothing through a partner's function", devs.length === 0, `${devs.length} rows`);
});
{
  const devs = await app.begin((tx) => tx`SELECT org_id FROM partner_developers_for_firm()`);
  check("and with no tenant pinned, nobody finds anything", devs.length === 0, `${devs.length} rows`);
}

// The partner's own session. Its workspace reads each developer's rows in
// that developer's tenant, filtered to the firm; these are the policies a
// session pinned to the firm itself runs under.
await asTenant(CP1, async (tx) => {
  const g = await tx`SELECT id FROM grants`;
  check("a partner sees its own live grant", g.length === 1 && g[0].id === grantOf[CP1], `${g.length} rows`);
  const r = await tx`SELECT id FROM client_registrations`;
  check("a partner sees only the buyer it registered", r.length === 1 && r[0].id === regOf[CP1], `${r.length} rows`);
  const other = await tx`SELECT id FROM client_registrations WHERE id = ${regOf[CP2]}`;
  check("never another firm's, even by id", other.length === 0);
  for (const table of ["leads", "partner_payouts", "payout_milestones", "partner_invoices", "partner_firms", "commission_terms", "partner_links", "partner_agents", "partner_bot_pending", "partner_bot_turns"]) {
    const rows = await tx.unsafe(`SELECT 1 FROM ${table}`);
    check(`a partner reads none of the developer's ${table}`, rows.length === 0, `${rows.length} rows`);
  }
  const upd = await tx`UPDATE client_registrations SET valid_until = now() + interval '1 year'`;
  check("a partner cannot stretch its own claim", upd.count === 0, `${upd.count} rows`);
});

try {
  await asTenant(CP1, async (tx) => {
    await tx`
      INSERT INTO client_registrations (org_id, cp_org_id, grant_id, scope_node_id, phone, via, verdict, valid_until)
      VALUES (${A.orgId}, ${CP1}, ${grantOf[CP1]}, ${A.nodeId}, '+919800000199', 'WHATSAPP', 'REGISTERED', now() + interval '1 day')`;
  });
  check("a partner cannot write a claim for itself", false, "insert succeeded");
} catch (e) {
  check("a partner cannot write a claim for itself", e.code === "42501", e.code);
}

// A grant that ended a second ago fails closed at the next query.
await owner`UPDATE grants SET valid_to = now() - interval '1 second' WHERE id = ${grantOf[CP1]}`;
await asTenant(CP1, async (tx) => {
  const g = await tx`SELECT id FROM grants`;
  check("a grant one second past its end is gone", g.length === 0, `${g.length} rows`);
  const r = await tx`SELECT id FROM client_registrations`;
  check("and every claim made under it with it", r.length === 0, `${r.length} rows`);
});
await owner`UPDATE grants SET status = 'SUSPENDED', suspended_reason = 'test' WHERE id = ${grantOf[CP2]}`;
await asTenant(CP2, async (tx) => {
  const r = await tx`SELECT id FROM client_registrations`;
  check("a suspended grant hides its claims", r.length === 0, `${r.length} rows`);
});
await owner`UPDATE grants SET status = 'ACTIVE', suspended_reason = NULL WHERE id = ${grantOf[CP2]}`;
// A claim past its own day is hidden even while the grant is live.
await owner`ALTER TABLE client_registrations DISABLE TRIGGER client_registrations_forward_only`;
await owner`UPDATE client_registrations SET valid_until = now() - interval '1 second' WHERE id = ${regOf[CP2]}`;
await owner`ALTER TABLE client_registrations ENABLE TRIGGER client_registrations_forward_only`;
await asTenant(CP2, async (tx) => {
  const r = await tx`SELECT id FROM client_registrations`;
  check("a claim one second past its day is gone", r.length === 0, `${r.length} rows`);
});

// What the database refuses the grantor too.
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE client_registrations SET valid_until = valid_until - interval '1 day' WHERE id = ${regOf[CP1]}`;
  });
  check("a claim's day never moves back", false, "update succeeded");
} catch (e) {
  check("a claim's day never moves back", e.code === "23514", e.code);
}
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE payout_milestones SET stage = 'APPROVED' WHERE id = ${mileA.id}`;
  });
  check("a milestone cannot skip a step", false, "update succeeded");
} catch (e) {
  check("a milestone cannot skip a step", e.code === "23514", e.code);
}
await owner`UPDATE payout_milestones SET stage = 'INVOICED' WHERE id = ${mileA.id}`;
await owner`UPDATE payout_milestones SET stage = 'VERIFIED' WHERE id = ${mileA.id}`;
await owner`UPDATE payout_milestones SET stage = 'APPROVED' WHERE id = ${mileA.id}`;
await owner`UPDATE payout_milestones SET stage = 'PAID', utr = 'HDFCN26092800001', paid_on = current_date WHERE id = ${mileA.id}`;
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE payout_milestones SET utr = 'HDFCN26092899999' WHERE id = ${mileA.id}`;
  });
  check("a paid milestone never changes", false, "update succeeded");
} catch (e) {
  check("a paid milestone never changes", e.code === "23514", e.code);
}
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`DELETE FROM grants WHERE id = ${grantOf[CP2]}`;
  });
  check("the app role cannot delete a grant", false, "delete succeeded");
} catch (e) {
  check("the app role cannot delete a grant", e.code === "42501", e.code);
}
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE grants SET grantee_org_id = ${CP2} WHERE id = ${grantOf[CP1]}`;
  });
  check("a grant cannot be pointed at another firm", false, "update succeeded");
} catch (e) {
  check("a grant cannot be pointed at another firm", e.code === "42501", e.code);
}
await app.begin(async (tx) => {
  const rows = await tx`SELECT id FROM grants`;
  check("grants is empty when app.org_id is unset", rows.length === 0, `${rows.length} rows`);
});

console.log("\nmandate firms");
// A mandate firm reads its offers through a function that returns names and
// dates, and answers through another; the tables stay the developer's.
const [MF] = await owner`
  INSERT INTO orgs (type, legal_name, display_name, pan, status)
  VALUES ('MANDATE_FIRM', ${"Mandate " + tag}, ${"Mandate " + tag}, 'AAAFM3333C', 'ACTIVE') RETURNING id`;
const [MF2] = await owner`
  INSERT INTO orgs (type, legal_name, display_name, pan, status)
  VALUES ('MANDATE_FIRM', ${"Mandate Two " + tag}, ${"Mandate Two " + tag}, 'AAAFM4444D', 'ACTIVE') RETURNING id`;
await owner`INSERT INTO firm_profiles (org_id, rera_agent_no) VALUES (${MF.id}, 'A51700003333')`;
const [mandA] = await owner`
  INSERT INTO mandates (org_id, firm_org_id, firm_name, firm_pan, rate, valid_from, valid_to, status)
  VALUES (${A.orgId}, ${MF.id}, 'Mandate', 'AAAFM3333C', 0.03, now() - interval '1 day', now() + interval '30 days', 'OFFERED')
  RETURNING id`;
await owner`
  INSERT INTO mandate_projects (mandate_id, org_id, scope_node_id, project_name)
  VALUES (${mandA.id}, ${A.orgId}, ${A.nodeId}, 'Project')`;
await asTenant(B.orgId, async (tx) => {
  for (const table of ["mandates", "mandate_projects", "firm_profiles"]) {
    const rows = await tx.unsafe(`SELECT 1 FROM ${table}`);
    check(`another tenant sees none of ${table}`, rows.length === 0, `${rows.length} rows`);
  }
  const f = await tx`SELECT id FROM mandates_for_firm()`;
  check("a developer is offered nothing through the firm's function", f.length === 0, `${f.length} rows`);
  const [{ answer }] = await tx`SELECT answer_mandate(${mandA.id}, true, NULL) AS answer`;
  check("another tenant cannot accept a firm's offer", answer === "NOT_YOURS", answer);
});
await asTenant(MF.id, async (tx) => {
  for (const table of ["mandates", "mandate_projects", "grants", "partner_payouts", "leads"]) {
    const rows = await tx.unsafe(`SELECT 1 FROM ${table}`);
    check(`a mandate firm reads none of the developer's ${table}`, rows.length === 0, `${rows.length} rows`);
  }
  const mine = await tx`SELECT id, developer, projects FROM mandates_for_firm()`;
  check("a mandate firm reads its own offer, with names only", mine.length === 1 && mine[0].id === mandA.id && mine[0].projects[0] === "Project", `${mine.length} rows`);
  const p = await tx`SELECT org_id FROM firm_profiles`;
  check("and its own profile", p.length === 1 && p[0].org_id === MF.id, `${p.length} rows`);
});
await asTenant(MF2.id, async (tx) => {
  const f = await tx`SELECT id FROM mandates_for_firm()`;
  check("another mandate firm sees no offer made to the first", f.length === 0, `${f.length} rows`);
  const [{ answer }] = await tx`SELECT answer_mandate(${mandA.id}, true, NULL) AS answer`;
  check("and cannot accept it", answer === "NOT_YOURS", answer);
  const firms = await tx`SELECT id FROM mandate_firm_by_pan('AAAFM3333C')`;
  check("a firm can look another up by PAN, name only", firms.length === 1);
});
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE mandates SET status = 'LIVE' WHERE id = ${mandA.id}`;
  });
  const [{ status }] = await owner`SELECT status FROM mandates WHERE id = ${mandA.id}`;
  check("a developer cannot mark its own offer accepted", status !== "LIVE", status);
} catch (e) {
  check("a developer cannot mark its own offer accepted", e.code === "42501" || e.code === "23514", e.code);
}
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE mandates SET rate = 0.08 WHERE id = ${mandA.id}`;
  });
  check("an offer's rate cannot be changed after it was sent", false, "update succeeded");
} catch (e) {
  check("an offer's rate cannot be changed after it was sent", e.code === "42501", e.code);
}
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`DELETE FROM mandates WHERE id = ${mandA.id}`;
  });
  check("the app role cannot delete a mandate", false, "delete succeeded");
} catch (e) {
  check("the app role cannot delete a mandate", e.code === "42501", e.code);
}
await asTenant(MF.id, async (tx) => {
  const [{ answer }] = await tx`SELECT answer_mandate(${mandA.id}, true, NULL) AS answer`;
  check("the firm accepts its own offer", answer === "LIVE", answer);
});
const mg = await owner`SELECT g.role, g.grantee_org_id FROM mandate_projects p JOIN grants g ON g.id = p.grant_id WHERE p.mandate_id = ${mandA.id}`;
check("accepting makes the firm's grant on the project", mg.length === 1 && mg[0].role === "MANDATE_FIRM" && mg[0].grantee_org_id === MF.id);

// Working through the mandate (0065): the developer names the firm's people,
// and nobody else's; the firm reads only what it is owed.
const firmPerson = async (org, who) => {
  const [n] = await owner`
    INSERT INTO scope_nodes (org_id, kind, name, slug, path)
    VALUES (${org.id}, 'ORG', ${who}, ${`mf_${who}_${tag}`}, ${`mf_${who}_${tag}`}::ltree) RETURNING id`;
  const [u] = await owner`
    INSERT INTO users (email, email_domain, name) VALUES (${`${who}${tag}@firm.example`}, 'firm.example', ${who}) RETURNING id`;
  await owner`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${u.id}, ${org.id}, ${n.id}, 'ORG_ADMIN', 'ACTIVE')`;
  return u.id;
};
const mfPerson = await firmPerson(MF, "mfone");
const mf2Person = await firmPerson(MF2, "mftwo");
await asTenant(A.orgId, async (tx) => {
  const seen = await tx`SELECT id FROM users WHERE id IN (${mfPerson}, ${mf2Person})`;
  check("a developer sees the people of a firm it holds a mandate with, and no other firm's",
    seen.length === 1 && seen[0].id === mfPerson, `${seen.length} rows`);
});
await asTenant(B.orgId, async (tx) => {
  const seen = await tx`SELECT id FROM users WHERE id = ${mfPerson}`;
  check("a developer with no mandate sees none of the firm's people", seen.length === 0, `${seen.length} rows`);
  const owed = await tx`SELECT payout_id FROM mandate_payouts_for_firm()`;
  check("and reads no firm's commission", owed.length === 0, `${owed.length} rows`);
});
await asTenant(MF2.id, async (tx) => {
  const owed = await tx`SELECT payout_id FROM mandate_payouts_for_firm()`;
  check("another firm reads none of the first firm's commission", owed.length === 0, `${owed.length} rows`);
});
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_from, valid_to, mandate_id)
             VALUES (${A.orgId}, ${B.orgId}, ${A.nodeId}, 'CHANNEL_PARTNER', now(), now() + interval '400 days', ${mandA.id})`;
  });
  check("a firm's partner cannot outlast its mandate", false, "insert succeeded");
} catch (e) {
  check("a firm's partner cannot outlast its mandate", e.code === "23514", e.code);
}

await app.begin(async (tx) => {
  const rows = await tx`SELECT id FROM mandates`;
  check("mandates is empty when app.org_id is unset", rows.length === 0, `${rows.length} rows`);
  const f = await tx`SELECT id FROM mandate_firm_by_pan('AAAFM3333C')`;
  check("and nobody looks a firm up with no tenant pinned", f.length === 0, `${f.length} rows`);
});
await owner`DELETE FROM mandate_projects WHERE org_id = ${A.orgId}`;
// Grants point at their mandate (0065), so they go first.
await owner`DELETE FROM grants WHERE grantee_org_id = ${MF.id}`;
await owner`DELETE FROM mandates WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM audit_log WHERE org_id IN (${MF.id}, ${MF2.id})`;
await owner`DELETE FROM orgs WHERE id IN (${MF.id}, ${MF2.id})`;
await owner`DELETE FROM users WHERE id IN (${mfPerson}, ${mf2Person})`;

await owner`DELETE FROM partner_invoices WHERE org_id = ${A.orgId}`;
await owner`ALTER TABLE payout_milestones DISABLE TRIGGER payout_milestones_forward_only`;
await owner`DELETE FROM payout_milestones WHERE org_id = ${A.orgId}`;
await owner`ALTER TABLE payout_milestones ENABLE TRIGGER payout_milestones_forward_only`;
await owner`DELETE FROM partner_payouts WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM leads WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM client_registrations WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM partner_links WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM partner_bot_turns WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM partner_bot_pending WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM partner_agents WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM grants WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM partner_firms WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM commission_terms WHERE org_id = ${A.orgId}`;
await owner`DELETE FROM orgs WHERE id IN (${CP1}, ${CP2})`;

console.log("\nsingle sign-on and SCIM");
await owner`INSERT INTO sso_configs (org_id, idp_entity_id, sso_url, certificates) VALUES (${A.orgId}, 'https://idp.a', 'https://idp.a/sso', ARRAY['MIIB'])`;
await owner`INSERT INTO sso_domains (org_id, domain, token, verified_at) VALUES (${A.orgId}, ${"rls-a-" + tag + ".example"}, ${"a".repeat(32)}, now())`;
await owner`INSERT INTO saml_requests (id, org_id) VALUES (${"_req" + tag}, ${A.orgId})`;
await owner`INSERT INTO saml_seen (org_id, assertion_id) VALUES (${A.orgId}, ${"_as" + tag})`;
const [ssoUser] = await owner`INSERT INTO users (email, email_domain, name) VALUES (${"rls-sso-" + tag + "@example.com"}, 'example.com', 'SSO Person') RETURNING id`;
await owner`INSERT INTO sso_tickets (org_id, user_id, token_hash, expires_at) VALUES (${A.orgId}, ${ssoUser.id}, ${"b".repeat(64)}, now() + interval '2 minutes')`;
const [scimTok] = await owner`INSERT INTO scim_tokens (org_id, label, token_hash) VALUES (${A.orgId}, 'Okta', ${"c".repeat(64)}) RETURNING id`;
const [scimU] = await owner`INSERT INTO scim_users (org_id, user_id, user_name, email) VALUES (${A.orgId}, ${ssoUser.id}, ${"rls-sso-" + tag + "@example.com"}, ${"rls-sso-" + tag + "@example.com"}) RETURNING id`;
const [scimG] = await owner`INSERT INTO scim_groups (org_id, display_name) VALUES (${A.orgId}, 'Sales') RETURNING id`;
await owner`INSERT INTO scim_group_members (org_id, group_id, scim_user_id) VALUES (${A.orgId}, ${scimG.id}, ${scimU.id})`;
await asTenant(B.orgId, async (tx) => {
  for (const table of ["sso_configs", "sso_domains", "saml_requests", "saml_seen", "sso_tickets", "scim_tokens", "scim_users", "scim_groups", "scim_group_members"]) {
    const rows = await tx.unsafe(`SELECT 1 FROM ${table}`);
    check(`another tenant sees none of A's ${table}`, rows.length === 0, `${rows.length} rows`);
  }
  const g = await tx`UPDATE scim_groups SET role = 'ORG_ADMIN', scope_node_id = ${A.nodeId} WHERE id = ${scimG.id}`;
  check("another tenant cannot map A's group to a role", g.count === 0, `${g.count} rows`);
  const e = await tx`UPDATE sso_configs SET enforce = false WHERE org_id = ${A.orgId}`;
  check("nor switch A's sign-on", e.count === 0, `${e.count} rows`);
});
await app.begin(async (tx) => {
  const none = await tx`SELECT org_id FROM scim_token_org(${"d".repeat(64)})`;
  check("an unknown SCIM token finds no organisation", none.length === 0, `${none.length} rows`);
  const one = await tx`SELECT org_id FROM scim_token_org(${"c".repeat(64)})`;
  check("a SCIM token finds only its own organisation, with nobody pinned", one.length === 1 && one[0].org_id === A.orgId, `${one.length} rows`);
});
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE scim_tokens SET token_hash = ${"e".repeat(64)} WHERE id = ${scimTok.id}`;
  });
  check("a SCIM token's hash cannot be rewritten", false, "update succeeded");
} catch (e) {
  check("a SCIM token's hash cannot be rewritten", e.code === "42501", e.code);
}
try {
  await asTenant(A.orgId, async (tx) => {
    await tx`UPDATE sso_configs SET enforce = true, tested_at = NULL WHERE org_id = ${A.orgId}`;
  });
  check("single sign-on cannot be required before anybody signed in through it", false, "update succeeded");
} catch (e) {
  check("single sign-on cannot be required before anybody signed in through it", e.code === "23514", e.code);
}
try {
  await asTenant(B.orgId, async (tx) => {
    await tx`INSERT INTO sso_domains (org_id, domain, token, verified_at) VALUES (${B.orgId}, ${"rls-a-" + tag + ".example"}, ${"f".repeat(32)}, now())`;
  });
  check("a domain one company proved cannot be proved by another", false, "insert succeeded");
} catch (e) {
  check("a domain one company proved cannot be proved by another", e.code === "23505", e.code);
}
for (const t of ["scim_group_members", "scim_groups", "scim_users", "scim_tokens", "sso_tickets", "saml_seen", "saml_requests", "sso_domains", "sso_configs"]) {
  await owner.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [A.orgId]);
}
await owner`DELETE FROM users WHERE id = ${ssoUser.id}`;

console.log("\ntenant data keys");
{
  const ARN = "arn:aws:kms:ap-south-1:222222222222:key/0f0e0d0c-0b0a-4908-8706-050403020100";
  await owner`INSERT INTO tenant_keys (org_id, version, wrapped_key, kms_key_arn) VALUES (${A.orgId}, 1, ${Buffer.alloc(60, 1)}, ${ARN})`;
  await asTenant(B.orgId, async (tx) => {
    const rows = await tx`SELECT 1 FROM tenant_keys`;
    check("another tenant sees none of A's tenant_keys", rows.length === 0, `${rows.length} rows`);
    const r = await tx`UPDATE tenant_keys SET retired_at = now() WHERE org_id = ${A.orgId}`;
    check("nor retires A's key", r.count === 0, `${r.count} rows`);
  });
  try {
    await asTenant(B.orgId, async (tx) => {
      await tx`INSERT INTO tenant_keys (org_id, version, wrapped_key, kms_key_arn) VALUES (${A.orgId}, 2, ${Buffer.alloc(60, 2)}, ${ARN})`;
    });
    check("another tenant cannot plant a key for A", false, "insert succeeded");
  } catch (e) {
    check("another tenant cannot plant a key for A", e.code === "42501", e.code);
  }
  for (const [name, stmt, want] of [
    ["the app role cannot rewrite a wrapped key", (tx) => tx`UPDATE tenant_keys SET wrapped_key = ${Buffer.alloc(60, 3)} WHERE org_id = ${A.orgId}`, "42501"],
    ["nor delete a key", (tx) => tx`DELETE FROM tenant_keys WHERE org_id = ${A.orgId}`, "42501"],
  ]) {
    try {
      await asTenant(A.orgId, stmt);
      check(name, false, "succeeded");
    } catch (e) {
      check(name, e.code === want, e.code);
    }
  }
  await app.begin(async (tx) => {
    const rows = await tx`SELECT 1 FROM tenant_keys`;
    check("tenant_keys is empty when app.org_id is unset", rows.length === 0, `${rows.length} rows`);
  });
  await owner`DELETE FROM tenant_keys WHERE org_id = ${A.orgId}`;
}

console.log("\nfail-closed with no tenant pinned");
await app.begin(async (tx) => {
  const orgs = await tx`SELECT id FROM orgs`;
  check("orgs is empty when app.org_id is unset", orgs.length === 0, `${orgs.length} rows`);
  const nodes = await tx`SELECT id FROM scope_nodes`;
  check("scope_nodes is empty when app.org_id is unset", nodes.length === 0, `${nodes.length} rows`);
});

// Verify the owner really does bypass RLS -- the control plane depends on it.
const all = await owner`SELECT id FROM orgs WHERE id IN (${A.orgId}, ${B.orgId})`;
check("owner connection sees both tenants (control plane works)", all.length === 2);

console.log("");
console.log("erasure (DPDP right to be forgotten)");

// Tenant A's user created an org, invited nobody, and decided nothing. Before
// 0004 this delete raised 23503 from orgs.created_by, which meant every admin
// on the platform was undeletable.
try {
  await owner.begin(async (tx) => {
    await tx`DELETE FROM users WHERE id = ${A.userId}`;
    throw new Error("ROLLBACK");
  });
  check("a user who created an org can be erased", false, "transaction did not roll back");
} catch (e) {
  check("a user who created an org can be erased", e.message === "ROLLBACK", e.code ?? e.message);
}

// The shape we actually use: scrub the row, keep the skeleton, so that
// "who invited whom" survives as a uuid pointing at nobody.
try {
  await owner.begin(async (tx) => {
    await tx`
      UPDATE users
      SET email = NULL, email_domain = NULL, name = NULL, picture = NULL,
          phone = NULL, erased_at = now()
      WHERE id = ${A.userId}`;
    const [still] = await tx`SELECT created_by FROM orgs WHERE id = ${A.orgId}`;
    if (still.created_by !== A.userId) throw new Error("attribution lost");
    throw new Error("ROLLBACK");
  });
  check("scrubbing keeps attribution intact", false, "transaction did not roll back");
} catch (e) {
  check("scrubbing keeps attribution intact", e.message === "ROLLBACK", e.message);
}

try {
  await owner.begin(async (tx) => {
    await tx`UPDATE users SET email = NULL WHERE id = ${A.userId}`;
  });
  check("a nameless row must be an erased row", false, "update succeeded");
} catch (e) {
  check("a nameless row must be an erased row", e.code === "23514", e.code);
}

console.log("");
console.log("outcomes and their uploads (0038)");

// One lead per tenant with one outcome and one upload, written as the owner,
// so there is something real on each side of the boundary.
const outcomeFixture = async (t, suffix) => {
  const [lead] = await owner`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source)
    VALUES (${t.orgId}, ${t.nodeId}, 'Fixture buyer', ${`+9199000${suffix}`}, 'Manual')
    RETURNING id`;
  const eventId = `01K${suffix}${"0".repeat(23 - suffix.length)}`;
  await owner`
    INSERT INTO outcome_events (id, org_id, lead_id, kind, occurred_at, scope_node_id, value, lineage)
    VALUES (${eventId}, ${t.orgId}, ${lead.id}, 'QUALIFIED', now(), ${t.nodeId}, 2000, '{"channel":"META_FORM"}'::jsonb)`;
  const [up] = await owner`
    INSERT INTO outcome_uploads (org_id, event_id, platform, state, reason)
    VALUES (${t.orgId}, ${eventId}, 'META', 'WAITING', 'NOT_CONNECTED') RETURNING id`;
  await owner`INSERT INTO attribution_settings (org_id, value_qualified) VALUES (${t.orgId}, 1234)`;
  return { leadId: lead.id, eventId, uploadId: up.id };
};
const OA = await outcomeFixture(A, "11111");
const OB = await outcomeFixture(B, "22222");

await asTenant(A.orgId, async (tx) => {
  const ev = await tx`SELECT id FROM outcome_events WHERE id = ${OB.eventId}`;
  check("tenant B's outcome is invisible by explicit id", ev.length === 0);
  const up = await tx`SELECT id FROM outcome_uploads WHERE org_id = ${B.orgId}`;
  check("tenant B's uploads are invisible", up.length === 0);
  const st = await tx`SELECT org_id FROM attribution_settings`;
  check("attribution_settings returns only tenant A", st.length === 1 && st[0].org_id === A.orgId);
  const mine = await tx`SELECT id FROM outcome_events WHERE org_id = ${A.orgId}`;
  check("tenant A still sees its own outcome", mine.length === 1);
});

try {
  await asTenant(A.orgId, (tx) => tx`
    INSERT INTO outcome_events (id, org_id, lead_id, kind, occurred_at, scope_node_id)
    VALUES ('01K33333000000000000000000', ${B.orgId}, ${OB.leadId}, 'QUALIFIED', now(), ${B.nodeId})`);
  check("an outcome cannot be written into tenant B", false, "insert succeeded");
} catch (e) {
  check("an outcome cannot be written into tenant B", e.code === "42501", e.code);
}

try {
  await asTenant(A.orgId, (tx) => tx`UPDATE outcome_events SET value = 0 WHERE id = ${OA.eventId}`);
  check("an outcome is never edited, even its own tenant's", false, "update succeeded");
} catch (e) {
  check("an outcome is never edited, even its own tenant's", e.code === "42501", e.code);
}

try {
  await asTenant(A.orgId, (tx) => tx`DELETE FROM outcome_events WHERE id = ${OA.eventId}`);
  check("an outcome is never removed by the app", false, "delete succeeded");
} catch (e) {
  check("an outcome is never removed by the app", e.code === "42501", e.code);
}

try {
  await asTenant(A.orgId, (tx) => tx`DELETE FROM outcome_uploads WHERE id = ${OA.uploadId}`);
  check("an upload's record is never removed by the app", false, "delete succeeded");
} catch (e) {
  check("an upload's record is never removed by the app", e.code === "42501", e.code);
}

try {
  await asTenant(A.orgId, (tx) => tx`UPDATE outcome_uploads SET event_id = ${OB.eventId} WHERE id = ${OA.uploadId}`);
  check("an upload cannot be pointed at another outcome", false, "update succeeded");
} catch (e) {
  check("an upload cannot be pointed at another outcome", e.code === "42501", e.code);
}

const crossUpdate = await asTenant(A.orgId, (tx) => tx`
  UPDATE outcome_uploads SET state = 'NOT_SENT', reason = 'CANCELLED' WHERE id = ${OB.uploadId}`);
check("tenant B's upload cannot be cancelled from A", crossUpdate.count === 0, `${crossUpdate.count} rows`);

const crossSettings = await asTenant(A.orgId, (tx) => tx`
  UPDATE attribution_settings SET value_booking = 1 WHERE org_id = ${B.orgId}`);
check("tenant B's values cannot be changed from A", crossSettings.count === 0, `${crossSettings.count} rows`);

try {
  await owner`
    INSERT INTO outcome_events (id, org_id, lead_id, kind, occurred_at, scope_node_id, lineage)
    VALUES ('01K44444000000000000000000', ${A.orgId}, ${OA.leadId}, 'BOOKED', now(), ${A.nodeId}, '{"phone":"+919900000000"}'::jsonb)`;
  check("a phone number cannot ride in an outcome's lineage", false, "insert succeeded");
} catch (e) {
  check("a phone number cannot ride in an outcome's lineage", e.code === "23514", e.code);
}

const unpinned = await app.begin((tx) => tx`SELECT id FROM outcome_events`);
check("with no tenant pinned, no outcome is visible", unpinned.length === 0, `${unpinned.length} rows`);

await owner`DELETE FROM leads WHERE id IN (${OA.leadId}, ${OB.leadId})`;
console.log("");
console.log("ad frequency readings (0039)");
{
  const [acct] = await owner`
    INSERT INTO connections (org_id, provider, status, scopes) VALUES (${B.orgId}, 'META', 'CONNECTED', ARRAY['ads_management'])
    RETURNING id`;
  const [ca] = await owner`
    INSERT INTO connection_accounts (org_id, connection_id, kind, external_id, name, scope_node_id)
    VALUES (${B.orgId}, ${acct.id}, 'META_AD_ACCOUNT', 'act_rls', 'B ads', ${B.nodeId}) RETURNING id`;
  const [t] = await owner`
    INSERT INTO publish_targets (org_id, source, destination, account_id, kind, headline, caption, content_sha256, scope_node_id, phase_id, idempotency_key, state, daily_budget)
    VALUES (${B.orgId}, 'STUDIO', 'META_AD', ${ca.id}, 'IMAGE', 'B ad', 'x', ${"b".repeat(64)}, ${B.nodeId}, ${B.nodeId}, ${"b".repeat(64)}, 'QUEUED', 500)
    RETURNING id`;
  await owner`INSERT INTO ad_windows (publish_target_id, org_id, since, until, reach, frequency) VALUES (${t.id}, ${B.orgId}, '2026-09-01', '2026-09-07', 10, 3.9)`;
  await asTenant(A.orgId, async (tx) => {
    const seen = await tx`SELECT 1 FROM ad_windows WHERE publish_target_id = ${t.id}`;
    check("tenant B's ad frequency is invisible", seen.length === 0);
    const moved = await tx`UPDATE ad_windows SET frequency = 0 WHERE publish_target_id = ${t.id}`;
    check("and cannot be overwritten from A", moved.count === 0, `${moved.count} rows`);
  });
  try {
    await asTenant(A.orgId, (tx) => tx`DELETE FROM ad_windows WHERE publish_target_id = ${t.id}`);
    check("a frequency reading is never removed by the app", false, "delete succeeded");
  } catch (e) {
    check("a frequency reading is never removed by the app", e.code === "42501", e.code);
  }
  await owner`DELETE FROM publish_targets WHERE id = ${t.id}`;
  await owner`DELETE FROM connections WHERE id = ${acct.id}`;
}
console.log("");
console.log("competitor ads and the learning (0057)");
{
  const [ad] = await owner`
    INSERT INTO competitor_ads (org_id, scope_node_id, competitor, platform, kind, tags, read_state)
    VALUES (${B.orgId}, ${B.nodeId}, 'Rival', 'META', 'IMAGE', '{"angle":"VIEW"}'::jsonb, 'READ') RETURNING id`;
  await owner`
    INSERT INTO learning_scores (org_id, scope_node_id, dim, value, blended) VALUES (${B.orgId}, ${B.nodeId}, 'angle', 'VIEW', 1.4)`;
  await owner`INSERT INTO playbooks (scope_node_id, org_id, lines) VALUES (${B.nodeId}, ${B.orgId}, '[]'::jsonb)`;
  await owner`INSERT INTO learning_settings (org_id, market_weight) VALUES (${B.orgId}, 40)`;
  const [lib] = await owner`
    INSERT INTO market_ads (developer, city, platform, kind, tags) VALUES ('RLS fixture', 'Nowhere', 'META', 'IMAGE', '{}'::jsonb) RETURNING id`;

  await asTenant(A.orgId, async (tx) => {
    check("tenant B's saved competitor ads are invisible", (await tx`SELECT 1 FROM competitor_ads WHERE id = ${ad.id}`).length === 0);
    check("tenant B's scores are invisible", (await tx`SELECT 1 FROM learning_scores WHERE org_id = ${B.orgId}`).length === 0);
    check("tenant B's playbook is invisible", (await tx`SELECT 1 FROM playbooks WHERE org_id = ${B.orgId}`).length === 0);
    check("tenant B's weight is invisible", (await tx`SELECT 1 FROM learning_settings WHERE org_id = ${B.orgId}`).length === 0);
    const gone = await tx`DELETE FROM competitor_ads WHERE id = ${ad.id}`;
    check("tenant B's saved ad cannot be removed from A", gone.count === 0, `${gone.count} rows`);
    check("the market library is readable by every tenant", (await tx`SELECT 1 FROM market_ads WHERE id = ${lib.id}`).length === 1);
  });

  try {
    await asTenant(A.orgId, (tx) => tx`
      INSERT INTO competitor_ads (org_id, scope_node_id, competitor, platform, kind, read_state)
      VALUES (${B.orgId}, ${B.nodeId}, 'Smuggled', 'META', 'IMAGE', 'READ')`);
    check("a competitor ad cannot be saved into tenant B", false, "insert succeeded");
  } catch (e) {
    check("a competitor ad cannot be saved into tenant B", e.code === "42501", e.code);
  }
  try {
    await asTenant(A.orgId, (tx) => tx`INSERT INTO market_ads (developer, platform, kind) VALUES ('Steer', 'META', 'IMAGE')`);
    check("no tenant can write the shared market library", false, "insert succeeded");
  } catch (e) {
    check("no tenant can write the shared market library", e.code === "42501", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE competitor_ads SET tags = '{}'::jsonb WHERE id = ${ad.id}`);
    check("what the reader saw is never rewritten, even by its own tenant", false, "update succeeded");
  } catch (e) {
    check("what the reader saw is never rewritten, even by its own tenant", e.code === "42501", e.code);
  }
  await owner`DELETE FROM market_ads WHERE id = ${lib.id}`;
}
console.log("");
console.log("Brain documents and what was read from them (0058)");
{
  const sha = "b".repeat(64);
  const [doc] = await owner`
    INSERT INTO brain_documents (org_id, scope_node_id, kind, name, sha256, storage_key, media_type, bytes, pages)
    VALUES (${B.orgId}, ${B.nodeId}, 'PRICE_LIST', 'Price list.pdf', ${sha}, ${`org/${B.orgId}/doc/${sha}`}, 'application/pdf', 1000, 2)
    RETURNING id`;
  const [run] = await owner`
    INSERT INTO brain_extractions (org_id, document_id, scope_node_id, extractor, state)
    VALUES (${B.orgId}, ${doc.id}, ${B.nodeId}, 'price_list', 'DONE') RETURNING id`;
  const [prop] = await owner`
    INSERT INTO brain_proposals (org_id, extraction_id, document_id, scope_node_id, field_key, value, quote, page, bbox,
      confidence, extractor, model_version)
    VALUES (${B.orgId}, ${run.id}, ${doc.id}, ${B.nodeId}, 'price.base_psf', '12500', 'Rs 12,500 per sq ft', 1,
      '{"x":0.1,"y":0.1,"w":0.5,"h":0.02}'::jsonb, 0.95, 'price_list', 'gpt-5-mini') RETURNING id`;

  await asTenant(A.orgId, async (tx) => {
    check("tenant B's documents are invisible", (await tx`SELECT 1 FROM brain_documents WHERE id = ${doc.id}`).length === 0);
    check("tenant B's readings are invisible", (await tx`SELECT 1 FROM brain_extractions WHERE id = ${run.id}`).length === 0);
    check("tenant B's proposed values are invisible", (await tx`SELECT 1 FROM brain_proposals WHERE id = ${prop.id}`).length === 0);
    const gone = await tx`DELETE FROM brain_documents WHERE id = ${doc.id}`;
    check("tenant B's document cannot be removed from A", gone.count === 0, `${gone.count} rows`);
    const decided = await tx`UPDATE brain_proposals SET state = 'REJECTED', decided_at = now() WHERE id = ${prop.id}`;
    check("tenant B's value cannot be decided from A", decided.count === 0, `${decided.count} rows`);
  });
  try {
    await asTenant(A.orgId, (tx) => tx`
      INSERT INTO brain_documents (org_id, scope_node_id, kind, name, sha256, storage_key, media_type, bytes, pages)
      VALUES (${B.orgId}, ${B.nodeId}, 'BROCHURE', 'Smuggled.pdf', ${"c".repeat(64)}, ${`org/${B.orgId}/doc/${"c".repeat(64)}`}, 'application/pdf', 10, 1)`);
    check("a document cannot be filed into tenant B", false, "insert succeeded");
  } catch (e) {
    check("a document cannot be filed into tenant B", e.code === "42501", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`
      INSERT INTO brain_documents (org_id, scope_node_id, kind, name, sha256, storage_key, media_type, bytes, pages)
      VALUES (${B.orgId}, ${B.nodeId}, 'BROCHURE', 'Elsewhere.pdf', ${"d".repeat(64)}, ${`org/${A.orgId}/doc/${"d".repeat(64)}`}, 'application/pdf', 10, 1)`);
    check("a document's key is its own tenant's and its own hash", false, "insert succeeded");
  } catch (e) {
    check("a document's key is its own tenant's and its own hash", e.code === "23514", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE brain_proposals SET value = '99999' WHERE id = ${prop.id}`);
    check("what a document said is never rewritten, even by its own tenant", false, "update succeeded");
  } catch (e) {
    check("what a document said is never rewritten, even by its own tenant", e.code === "42501", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`DELETE FROM brain_proposals WHERE id = ${prop.id}`);
    check("a proposed value is never deleted by the app", false, "delete succeeded");
  } catch (e) {
    check("a proposed value is never deleted by the app", e.code === "42501", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE brain_documents SET sha256 = ${"e".repeat(64)} WHERE id = ${doc.id}`);
    check("an uploaded file's hash is never rewritten", false, "update succeeded");
  } catch (e) {
    check("an uploaded file's hash is never rewritten", e.code === "42501", e.code);
  }
  await asTenant(B.orgId, (tx) => tx`UPDATE brain_proposals SET state = 'ACCEPTED', decided_by = ${B.userId}, decided_at = now() WHERE id = ${prop.id}`);
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE brain_proposals SET state = 'PROPOSED' WHERE id = ${prop.id}`);
    check("a decision is final", false, "update succeeded");
  } catch (e) {
    check("a decision is final", e.code === "23514", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`DELETE FROM brain_documents WHERE id = ${doc.id}`);
    check("a document a value was taken from is kept", false, "delete succeeded");
  } catch (e) {
    check("a document a value was taken from is kept", e.code === "23514", e.code);
  }
  await owner`DELETE FROM brain_proposals WHERE document_id = ${doc.id}`;
  await owner`DELETE FROM brain_documents WHERE id = ${doc.id}`;
}
console.log("");
console.log("audit_log holds no raw identifiers");

// The bug this exists to prevent: a refused sign-in used to write the
// attempted email address into an append-only table with no delete path.
try {
  await owner`
    INSERT INTO audit_log (org_id, action, target_type, target_id)
    VALUES (${A.orgId}, 'test.raw_email', 'email', 'someone@gmail.com')`;
  check("an email address cannot be written to target_id", false, "insert succeeded");
} catch (e) {
  check("an email address cannot be written to target_id", e.code === "23514", e.code);
}

const [domainRow] = await owner`
  INSERT INTO audit_log (org_id, action, target_type, target_id, metadata)
  VALUES (${A.orgId}, 'test.domain', 'domain', 'gmail.com',
          '{"email_sha256":"9f2c"}'::jsonb)
  RETURNING id`;
check("a domain and a hash are fine", !!domainRow);

console.log("");
console.log("retention: append-only binds the app, not the universe");

const [liveRow] = await owner`
  INSERT INTO audit_log (org_id, action, retain_until)
  VALUES (${A.orgId}, 'test.live', now() + interval '1 year') RETURNING id`;
const [deadRow] = await owner`
  INSERT INTO audit_log (org_id, action, retain_until)
  VALUES (${A.orgId}, 'test.expired', now() - interval '1 day') RETURNING id`;

try {
  await asTenant(A.orgId, async (tx) => {
    await tx`DELETE FROM audit_log WHERE id = ${liveRow.id}`;
  });
  check("the app role cannot delete an audit row", false, "delete succeeded");
} catch (e) {
  check("the app role cannot delete an audit row", e.code === "42501", e.code);
}

const retSees = await retention`SELECT action FROM audit_log WHERE id IN (${liveRow.id}, ${deadRow.id})`;
check("the retention role sees only expired rows",
  retSees.length === 1 && retSees[0].action === "test.expired",
  retSees.map((r) => r.action).join(", "));

const liveDel = await retention`DELETE FROM audit_log WHERE id = ${liveRow.id}`;
check("the retention role cannot delete a live row", liveDel.count === 0,
  `${liveDel.count} rows affected`);

const deadDel = await retention`DELETE FROM audit_log WHERE id = ${deadRow.id}`;
check("the retention role can delete an expired row", deadDel.count === 1,
  `${deadDel.count} rows affected`);

// Its whole reach is one table. A compromised expiry job is a compromised
// expiry job, not a compromised database.
try {
  await retention`SELECT id FROM users LIMIT 1`;
  check("the retention role cannot read anything else", false, "select succeeded");
} catch (e) {
  check("the retention role cannot read anything else", e.code === "42501", e.code);
}

console.log("");
console.log("CRM sync and inventory: isolation");

// Each tenant gets a connection, a mapping, a lead with its link and its
// outbox row (the trigger writes the row), an event and a flat, so every
// table below has something real of B's to try to reach.
const crmOf = {};
for (const t of [A, B]) {
  const [conn] = await owner`
    INSERT INTO crm_connections (org_id, provider, account) VALUES (${t.orgId}, 'LEADRAT', 'acme') RETURNING id`;
  const [map] = await owner`
    INSERT INTO crm_mappings (org_id, connection_id, kind, external_id, label) VALUES (${t.orgId}, ${conn.id}, 'STAGE', 's1', 'New') RETURNING id`;
  const [lead] = await owner`
    INSERT INTO leads (org_id, scope_node_id, name, phone) VALUES (${t.orgId}, ${t.nodeId}, 'Buyer', '+919812300000') RETURNING id`;
  const [link] = await owner`
    INSERT INTO crm_links (org_id, connection_id, lead_id, external_id) VALUES (${t.orgId}, ${conn.id}, ${lead.id}, 'x1') RETURNING id`;
  const [event] = await owner`
    INSERT INTO crm_events (org_id, connection_id, source, external_id, kind, payload)
    VALUES (${t.orgId}, ${conn.id}, 'WEBHOOK', 'e1', 'lead.update', '{}'::jsonb) RETURNING id`;
  const [unit] = await owner`
    INSERT INTO units (org_id, scope_node_id, unit_no, status, source) VALUES (${t.orgId}, ${t.nodeId}, 'C-1201', 'AVAILABLE', 'IMPORT') RETURNING id`;
  const [cv] = await owner`
    INSERT INTO crm_visits (org_id, connection_id, lead_id, external_id, origin, agreed_at)
    VALUES (${t.orgId}, ${conn.id}, ${lead.id}, 'x1:site-visit', 'CRM', '2026-10-10T12:00') RETURNING id`;
  crmOf[t.orgId] = { conn: conn.id, map: map.id, lead: lead.id, link: link.id, event: event.id, unit: unit.id, visit: cv.id };
}
const a = crmOf[A.orgId];
const b = crmOf[B.orgId];
const [outboxRows] = await owner`SELECT count(*)::int AS n FROM crm_outbox WHERE lead_id IN (${a.lead}, ${b.lead})`;
check("a lead written with a CRM connected is queued by the trigger", outboxRows.n === 2, `${outboxRows.n} rows`);

const crmTables = ["crm_connections", "crm_mappings", "crm_links", "crm_events", "crm_outbox", "units", "crm_visits"];
await asTenant(A.orgId, async (tx) => {
  for (const table of crmTables) {
    const rows = await tx`SELECT org_id FROM ${tx(table)}`;
    check(`${table} shows only tenant A`, rows.length >= 1 && rows.every((r) => r.org_id === A.orgId), `${rows.length} rows`);
  }
  const ids = { crm_connections: b.conn, crm_mappings: b.map, crm_links: b.link, crm_events: b.event, units: b.unit, crm_visits: b.visit };
  for (const [table, id] of Object.entries(ids)) {
    const direct = await tx`SELECT id FROM ${tx(table)} WHERE id = ${id}`;
    check(`tenant B's ${table} row is invisible even by explicit id`, direct.length === 0);
  }
  const upd = await tx`UPDATE crm_mappings SET stage = 'lost' WHERE org_id = ${B.orgId}`;
  check("cannot remap tenant B's CRM statuses", upd.count === 0, `${upd.count} rows affected`);
  const unit = await tx`UPDATE units SET status = 'BOOKED' WHERE org_id = ${B.orgId}`;
  check("cannot mark tenant B's flats booked", unit.count === 0, `${unit.count} rows affected`);
  const out = await tx`UPDATE crm_outbox SET status = 'DEAD' WHERE org_id = ${B.orgId}`;
  check("cannot kill tenant B's queued writes", out.count === 0, `${out.count} rows affected`);
  const cvis = await tx`UPDATE crm_visits SET origin = 'US', status = 'CANCELLED' WHERE org_id = ${B.orgId}`;
  check("cannot take over or call off tenant B's CRM visits", cvis.count === 0, `${cvis.count} rows affected`);
  const gone = await tx`UPDATE crm_links SET removed_at = now(), removed_reason = 'DELETED' WHERE org_id = ${B.orgId}`;
  check("cannot mark tenant B's CRM records removed", gone.count === 0, `${gone.count} rows affected`);
});

for (const [name, attempt] of [
  ["cannot connect a CRM inside tenant B", (tx) => tx`INSERT INTO crm_connections (org_id, provider) VALUES (${B.orgId}, 'LEADRAT')`],
  ["cannot store an event for tenant B", (tx) => tx`
    INSERT INTO crm_events (org_id, connection_id, source, external_id, kind, payload)
    VALUES (${B.orgId}, ${b.conn}, 'WEBHOOK', 'smuggled', 'lead.update', '{}'::jsonb)`],
  ["cannot book a CRM visit onto tenant B's lead", (tx) => tx`
    INSERT INTO crm_visits (org_id, connection_id, lead_id, external_id, origin) VALUES (${B.orgId}, ${b.conn}, ${b.lead}, 'smuggled', 'CRM')`],
  ["cannot add a flat to tenant B's tower", (tx) => tx`
    INSERT INTO units (org_id, scope_node_id, unit_no, status, source) VALUES (${B.orgId}, ${B.nodeId}, 'X-1', 'AVAILABLE', 'IMPORT')`],
]) {
  try {
    await asTenant(A.orgId, attempt);
    check(name, false, "insert succeeded");
  } catch (e) {
    check(name, e.code === "42501", e.code);
  }
}

// What arrived is evidence: only what became of it may be written back.
try {
  await asTenant(A.orgId, (tx) => tx`UPDATE crm_events SET payload = '{"forged":true}'::jsonb WHERE id = ${a.event}`);
  check("a stored CRM event's payload cannot be rewritten", false, "update succeeded");
} catch (e) {
  check("a stored CRM event's payload cannot be rewritten", e.code === "42501", e.code);
}

await app.begin(async (tx) => {
  let seen = 0;
  for (const table of crmTables) seen += (await tx`SELECT id FROM ${tx(table)}`).length;
  check("the CRM tables are empty when app.org_id is unset", seen === 0, `${seen} rows`);
});

// --- 0043: who sees a buyer's number ---------------------------------------
console.log("");
console.log("field policies (0043)");
await owner`
  INSERT INTO field_policies (org_id, resource, field, role, stage, visibility)
  VALUES (${B.orgId}, 'lead', 'phone', 'SALES_HEAD', 'new', 'FULL')`;
await asTenant(A.orgId, async (tx) => {
  const rows = await tx`SELECT role FROM field_policies WHERE org_id = ${B.orgId}`;
  check("tenant B's phone policy is invisible to A", rows.length === 0, `${rows.length} rows`);
  const res = await tx`UPDATE field_policies SET visibility = 'HIDDEN' WHERE org_id = ${B.orgId}`;
  check("and cannot be changed from A", res.count === 0, `${res.count} rows`);
});
try {
  await asTenant(A.orgId, (tx) => tx`
    INSERT INTO field_policies (org_id, resource, field, role, stage, visibility)
    VALUES (${B.orgId}, 'lead', 'phone', 'PRESALES_AGENT', 'new', 'FULL')`);
  check("A cannot write a phone policy for B", false, "insert succeeded");
} catch (e) {
  check("A cannot write a phone policy for B", e.code === "42501", e.code);
}
try {
  await asTenant(B.orgId, (tx) => tx`
    INSERT INTO field_policies (org_id, resource, field, role, stage, visibility)
    VALUES (${B.orgId}, 'lead', 'phone', 'PRESALES_AGENT', 'nurture', 'FULL')`);
  check("a side stage is not a stage a policy is set at", false, "insert succeeded");
} catch (e) {
  check("a side stage is not a stage a policy is set at", e.code === "23514", e.code);
}
await app.begin(async (tx) => {
  const rows = await tx`SELECT role FROM field_policies`;
  check("phone policies are empty when app.org_id is unset", rows.length === 0, `${rows.length} rows`);
});

// --- 0044: one-time codes and calls through our number ----------------------
console.log("");
console.log("one-time codes and calls through our number (0044)");
try {
  await asTenant(A.orgId, (tx) => tx`SELECT id FROM otp_challenges LIMIT 1`);
  check("the app role cannot read one-time codes at all", false, "select succeeded");
} catch (e) {
  check("the app role cannot read one-time codes at all", e.code === "42501", e.code);
}
try {
  await asTenant(A.orgId, (tx) => tx`
    INSERT INTO otp_challenges (purpose, phone_hash, code_hash, expires_at)
    VALUES ('SIGN_IN', ${"a".repeat(64)}, ${"b".repeat(64)}, now() + interval '5 minutes')`);
  check("nor write one", false, "insert succeeded");
} catch (e) {
  check("nor write one", e.code === "42501", e.code);
}
const [{ scope_node_id: bTower }] = await owner`SELECT scope_node_id FROM leads WHERE id = ${b.lead}`;
const [proxyB] = await owner`
  INSERT INTO proxy_calls (org_id, lead_id, scope_node_id, status)
  VALUES (${B.orgId}, ${b.lead}, ${bTower}, 'CONNECTED')
  RETURNING id`;
await asTenant(A.orgId, async (tx) => {
  const rows = await tx`SELECT id FROM proxy_calls WHERE id = ${proxyB.id}`;
  check("tenant B's calls through our number are invisible to A", rows.length === 0, `${rows.length} rows`);
  const res = await tx`UPDATE proxy_calls SET status = 'ENDED' WHERE id = ${proxyB.id}`;
  check("and cannot be ended from A", res.count === 0, `${res.count} rows`);
});
try {
  await asTenant(A.orgId, (tx) => tx`
    INSERT INTO proxy_calls (org_id, lead_id, scope_node_id) VALUES (${B.orgId}, ${b.lead}, ${bTower})`);
  check("A cannot place a call in B's name", false, "insert succeeded");
} catch (e) {
  check("A cannot place a call in B's name", e.code === "42501", e.code);
}
try {
  await asTenant(B.orgId, (tx) => tx`DELETE FROM proxy_calls WHERE id = ${proxyB.id}`);
  check("a call through our number cannot be deleted by the app", false, "delete succeeded");
} catch (e) {
  check("a call through our number cannot be deleted by the app", e.code === "42501", e.code);
}
await owner`DELETE FROM proxy_calls WHERE id = ${proxyB.id}`;

// --- 0049: what we know about a number and the DND register -----------------
console.log("");
console.log("the DND register (0049)");
const [dndB] = await owner`
  INSERT INTO dnd_checks (org_id, phone, status, source, lead_id)
  VALUES (${B.orgId}, '+919812300000', 'DND', 'OPERATOR', ${b.lead}) RETURNING id`;
await asTenant(A.orgId, async (tx) => {
  const rows = await tx`SELECT id FROM dnd_checks WHERE phone = '+919812300000'`;
  check("tenant B's DND answers are invisible to A, even for the same number", rows.length === 0, `${rows.length} rows`);
});
try {
  await asTenant(A.orgId, (tx) => tx`
    INSERT INTO dnd_checks (org_id, phone, status, source) VALUES (${B.orgId}, '+919812300000', 'CLEAR', 'OPERATOR')`);
  check("A cannot record an answer in B's name", false, "insert succeeded");
} catch (e) {
  check("A cannot record an answer in B's name", e.code === "42501", e.code);
}
for (const [name, write] of [
  ["an answer cannot be rewritten by the app", (tx) => tx`UPDATE dnd_checks SET status = 'CLEAR' WHERE id = ${dndB.id}`],
  ["nor removed", (tx) => tx`DELETE FROM dnd_checks WHERE id = ${dndB.id}`],
]) {
  try {
    await asTenant(B.orgId, write);
    check(name, false, "write succeeded");
  } catch (e) {
    check(name, e.code === "42501", e.code);
  }
}
const dndUnpinned = await app.begin((tx) => tx`SELECT id FROM dnd_checks`);
check("the DND answers are empty when app.org_id is unset", dndUnpinned.length === 0, `${dndUnpinned.length} rows`);
await owner`DELETE FROM dnd_checks WHERE id = ${dndB.id}`;

// --- 0051: the ownership rules' settings ------------------------------------
console.log("");
console.log("ownership rules at capture (0051)");
await owner`INSERT INTO lead_settings (org_id, lookback_days) VALUES (${B.orgId}, 45) ON CONFLICT (org_id) DO UPDATE SET lookback_days = 45`;
await asTenant(A.orgId, async (tx) => {
  const rows = await tx`SELECT org_id FROM lead_settings WHERE org_id = ${B.orgId}`;
  check("tenant B's lookback is invisible to A", rows.length === 0, `${rows.length} rows`);
  const res = await tx`UPDATE lead_settings SET lookback_days = 7 WHERE org_id = ${B.orgId}`;
  check("and cannot be changed from A", res.count === 0, `${res.count} rows`);
});
try {
  await asTenant(A.orgId, (tx) => tx`INSERT INTO lead_settings (org_id, lookback_days) VALUES (${B.orgId}, 30)`);
  check("A cannot write B's lookback", false, "insert succeeded");
} catch (e) {
  check("A cannot write B's lookback", e.code === "42501" || e.code === "23505", e.code);
}
try {
  await asTenant(B.orgId, (tx) => tx`UPDATE lead_settings SET lookback_days = 2 WHERE org_id = ${B.orgId}`);
  check("a lookback under a week is refused by the database", false, "update succeeded");
} catch (e) {
  check("a lookback under a week is refused by the database", e.code === "23514", e.code);
}
try {
  // 0088 lets the app empty a payload, and only for an erased buyer: a row of
  // tenant B's own, with no lead behind it, is refused by the trigger.
  await asTenant(B.orgId, async (tx) => {
    await tx`INSERT INTO lead_events (org_id, source, external_id, payload) VALUES (${B.orgId}, 'WEBSITE', 'rls-payload', '{"a":1}'::jsonb)`;
    await tx`UPDATE lead_events SET payload = '{}'::jsonb WHERE org_id = ${B.orgId} AND external_id = 'rls-payload'`;
  });
  check("the rule column opens no other column of a capture event", false, "update succeeded");
} catch (e) {
  check("the rule column opens no other column of a capture event", e.code === "42501" || e.code === "23514", e.code);
}
const settingsUnpinned = await app.begin((tx) => tx`SELECT org_id FROM lead_settings`);
check("the lead settings are empty when app.org_id is unset", settingsUnpinned.length === 0, `${settingsUnpinned.length} rows`);
await owner`DELETE FROM lead_settings WHERE org_id = ${B.orgId}`;

// --- 0052: gallery capacity, the seat ledger and the holds -----------------
console.log("");
console.log("visit capacity (0052)");
{
  const [bProject] = await owner`SELECT id FROM scope_nodes WHERE org_id = ${B.orgId} AND kind = 'ORG' LIMIT 1`;
  await owner`INSERT INTO visit_capacity (org_id, project_id, weekday_hosts, weekend_hosts) VALUES (${B.orgId}, ${bProject.id}, 4, 5)`;
  const [slotB] = await owner`
    INSERT INTO visit_slots (org_id, project_id, day, hour, capacity, taken)
    VALUES (${B.orgId}, ${bProject.id}, '2030-01-01', 11, 4, 1) RETURNING id`;
  const [holdB] = await owner`
    INSERT INTO visit_holds (org_id, slot_id, lead_id, starts_at, expires_at)
    VALUES (${B.orgId}, ${slotB.id}, ${b.lead}, '2030-01-01T05:30:00Z', now() + interval '10 minutes') RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = (await tx`SELECT project_id FROM visit_capacity WHERE org_id = ${B.orgId}`).length
      + (await tx`SELECT id FROM visit_slots WHERE id = ${slotB.id}`).length
      + (await tx`SELECT id FROM visit_holds WHERE id = ${holdB.id}`).length;
    check("tenant B's capacity, seats and holds are invisible to A", seen === 0, `${seen} rows`);
    const res = await tx`UPDATE visit_slots SET taken = 0 WHERE id = ${slotB.id}`;
    check("and A cannot free one of B's seats", res.count === 0, `${res.count} rows`);
  });
  try {
    await asTenant(A.orgId, (tx) => tx`
      INSERT INTO visit_holds (org_id, slot_id, lead_id, starts_at, expires_at)
      VALUES (${B.orgId}, ${slotB.id}, ${b.lead}, now(), now() + interval '1 minute')`);
    check("A cannot hold a seat in B's name", false, "insert succeeded");
  } catch (e) {
    check("A cannot hold a seat in B's name", e.code === "42501", e.code);
  }
  for (const [name, write] of [
    ["a seat's hour cannot be rewritten by the app", (tx) => tx`UPDATE visit_slots SET hour = 12 WHERE id = ${slotB.id}`],
    ["the ledger's rows are never removed by the app", (tx) => tx`DELETE FROM visit_slots WHERE id = ${slotB.id}`],
    ["a hold's time cannot be rewritten by the app", (tx) => tx`UPDATE visit_holds SET starts_at = now() WHERE id = ${holdB.id}`],
  ]) {
    try {
      await asTenant(B.orgId, write);
      check(name, false, "write succeeded");
    } catch (e) {
      check(name, e.code === "42501", e.code);
    }
  }
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE visit_slots SET taken = -1 WHERE id = ${slotB.id}`);
    check("a seat count cannot go below zero", false, "update succeeded");
  } catch (e) {
    check("a seat count cannot go below zero", e.code === "23514", e.code);
  }
  const unpinned = await app.begin(async (tx) =>
    (await tx`SELECT project_id FROM visit_capacity`).length + (await tx`SELECT id FROM visit_slots`).length + (await tx`SELECT id FROM visit_holds`).length);
  check("the capacity tables are empty when app.org_id is unset", unpinned === 0, `${unpinned} rows`);
  await owner`DELETE FROM visit_holds WHERE id = ${holdB.id}`;
  await owner`DELETE FROM visit_slots WHERE id = ${slotB.id}`;
  await owner`DELETE FROM visit_capacity WHERE org_id = ${B.orgId}`;
}

// --- 0075: hosts' own hours ---------------------------------------------------
console.log("");
console.log("hosts' hours (0075)");
{
  const [bNode] = await owner`SELECT id FROM scope_nodes WHERE org_id = ${B.orgId} AND kind = 'ORG' LIMIT 1`;
  await owner`
    INSERT INTO visit_host_hours (org_id, project_id, user_id, weekday, start_hour, end_hour)
    VALUES (${B.orgId}, ${bNode.id}, ${B.userId}, 1, 10, 18)`;
  await asTenant(A.orgId, async (tx) => {
    const seen = (await tx`SELECT user_id FROM visit_host_hours WHERE org_id = ${B.orgId}`).length;
    check("tenant B's hosts' hours are invisible to A", seen === 0, `${seen} rows`);
    const moved = await tx`UPDATE visit_host_hours SET end_hour = 19 WHERE org_id = ${B.orgId}`;
    check("and A cannot change them", moved.count === 0, `${moved.count} rows`);
    const gone = await tx`DELETE FROM visit_host_hours WHERE org_id = ${B.orgId}`;
    check("nor take a host of B's off the floor", gone.count === 0, `${gone.count} rows`);
  });
  try {
    await asTenant(A.orgId, (tx) => tx`
      INSERT INTO visit_host_hours (org_id, project_id, user_id, weekday, start_hour, end_hour)
      VALUES (${B.orgId}, ${bNode.id}, ${B.userId}, 2, 10, 18)`);
    check("A cannot put a host on B's floor", false, "insert succeeded");
  } catch (e) {
    check("A cannot put a host on B's floor", e.code === "42501", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE visit_host_hours SET end_hour = 10 WHERE org_id = ${B.orgId}`);
    check("a host finishes after they start", false, "update succeeded");
  } catch (e) {
    check("a host finishes after they start", e.code === "23514", e.code);
  }
  const unpinned = await app.begin((tx) => tx`SELECT user_id FROM visit_host_hours`);
  check("hosts' hours are empty when app.org_id is unset", unpinned.length === 0, `${unpinned.length} rows`);
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE visit_notes SET before_visit = true WHERE org_id = ${B.orgId}`);
    check("whether a note came before the visit is written once", false, "update succeeded");
  } catch (e) {
    check("whether a note came before the visit is written once", e.code === "42501", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE lender_referrals SET ask_id = gen_random_uuid() WHERE org_id = ${B.orgId}`);
    check("the lenders one question named stay tied together", false, "update succeeded");
  } catch (e) {
    check("the lenders one question named stay tied together", e.code === "42501", e.code);
  }
  await owner`DELETE FROM visit_host_hours WHERE org_id = ${B.orgId}`;
}

// --- 0053: the call's reading, the score, the route, the bridge -------------
console.log("");
console.log("qualification and the bridge (0053)");
{
  await owner`UPDATE leads SET qualification = '{"timeline":{"value":"LE_30D","confidence":0.9,"span":"x"}}', score = 80, route = 'HOT' WHERE id = ${b.lead}`;
  await asTenant(A.orgId, async (tx) => {
    const rows = await tx`SELECT id FROM leads WHERE route = 'HOT' AND id = ${b.lead}`;
    check("tenant B's scored leads are invisible to A", rows.length === 0, `${rows.length} rows`);
  });
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE leads SET score = 101 WHERE id = ${b.lead}`);
    check("a score is held to 0 to 100", false, "update succeeded");
  } catch (e) {
    check("a score is held to 0 to 100", e.code === "23514", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`
      INSERT INTO proxy_calls (org_id, lead_id, scope_node_id, kind) VALUES (${B.orgId}, ${b.lead}, ${bTower}, 'BRIDGE')`);
    check("a bridge must name the sales person it rings", false, "insert succeeded");
  } catch (e) {
    check("a bridge must name the sales person it rings", e.code === "23514", e.code);
  }
  try {
    await owner`INSERT INTO lead_settings (org_id, hot_floor, warm_floor) VALUES (${B.orgId}, 40, 60)`;
    check("warm has to start below hot, by the database", false, "insert succeeded");
  } catch (e) {
    check("warm has to start below hot, by the database", e.code === "23514", e.code);
  }
  await owner`UPDATE leads SET qualification = '{}', score = NULL, route = NULL WHERE id = ${b.lead}`;
}

// --- 0054: a visit's check-in, and its attribution frozen ------------------
console.log("");
console.log("visit check-in (0054)");
{
  const [leadB] = await owner`SELECT scope_node_id FROM leads WHERE id = ${b.lead}`;
  const [visitB] = await owner`
    INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, status, booked_via, checkin_method, attribution)
    VALUES (${B.orgId}, ${b.lead}, ${leadB.scope_node_id}, now(), 'ON_SITE', 'CONSOLE', 'QR', '{"channel":"WEBSITE"}') RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = await tx`SELECT id FROM site_visits WHERE id = ${visitB.id}`;
    check("tenant B's check-ins are invisible to A", seen.length === 0, `${seen.length} rows`);
  });
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE site_visits SET attribution = '{"channel":"META"}' WHERE id = ${visitB.id}`);
    check("a visit's attribution cannot be rewritten once written", false, "update succeeded");
  } catch (e) {
    check("a visit's attribution cannot be rewritten once written", e.code === "23514", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE site_visits SET checkin_method = 'PHONE' WHERE id = ${visitB.id}`);
    check("a check-in is by QR or by hand, nothing else", false, "update succeeded");
  } catch (e) {
    check("a check-in is by QR or by hand, nothing else", e.code === "23514", e.code);
  }
  await owner`DELETE FROM site_visits WHERE id = ${visitB.id}`;
}

// --- 0055: voice notes, lenders, and the buyer's yes ------------------------
console.log("");
console.log("voice notes and lenders (0055)");
{
  const [leadB] = await owner`SELECT scope_node_id FROM leads WHERE id = ${b.lead}`;
  const [visitB] = await owner`
    INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, status, booked_via)
    VALUES (${B.orgId}, ${b.lead}, ${leadB.scope_node_id}, now(), 'ON_SITE', 'CONSOLE') RETURNING id`;
  const note = async () => {
    const id = (await owner`SELECT gen_random_uuid() AS id`)[0].id;
    return owner`
      INSERT INTO visit_notes (id, org_id, visit_id, scope_node_id, storage_key, content_type, bytes, sha256, duration_ms)
      VALUES (${id}, ${B.orgId}, ${visitB.id}, ${leadB.scope_node_id}, ${`org/${B.orgId}/visitnote/${id}`}, 'audio/webm', 1000, ${"a".repeat(64)}, 50000)
      RETURNING id`;
  };
  const [noteB] = await note();
  await note();
  try {
    await note();
    check("a visit holds two notes at most, by the database", false, "third insert succeeded");
  } catch (e) {
    check("a visit holds two notes at most, by the database", e.code === "23514", e.code);
  }
  const [lenderB] = await owner`INSERT INTO lenders (org_id, name, email) VALUES (${B.orgId}, 'B Bank', 'loans@b.example') RETURNING id`;
  const [refB] = await owner`
    INSERT INTO lender_referrals (org_id, lead_id, lender_id, wording) VALUES (${B.orgId}, ${b.lead}, ${lenderB.id}, 'May we share?') RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = (await tx`SELECT id FROM visit_notes WHERE id = ${noteB.id}`).length
      + (await tx`SELECT id FROM lenders WHERE id = ${lenderB.id}`).length
      + (await tx`SELECT id FROM lender_referrals WHERE id = ${refB.id}`).length;
    check("tenant B's notes, lenders and referrals are invisible to A", seen === 0, `${seen} rows`);
    const res = await tx`DELETE FROM visit_notes WHERE id = ${noteB.id}`;
    check("and A cannot delete one of B's notes", res.count === 0, `${res.count} rows`);
  });
  for (const [name, write] of [
    ["a note's recording, key and hash are never rewritten by the app", (tx) => tx`UPDATE visit_notes SET storage_key = storage_key WHERE id = ${noteB.id}`],
    ["a lender's address is never rewritten, only retired", (tx) => tx`UPDATE lenders SET email = 'x@y.example' WHERE id = ${lenderB.id}`],
  ]) {
    try {
      await asTenant(B.orgId, write);
      check(name, false, "write succeeded");
    } catch (e) {
      check(name, e.code === "42501", e.code);
    }
  }
  const live = await asTenant(B.orgId, (tx) => tx`DELETE FROM visit_notes WHERE id = ${noteB.id}`);
  check("a note on a lead still open cannot be deleted, even by its own tenant", live.count === 0, `${live.count} rows`);
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE lender_referrals SET state = 'SENT', sent_at = now(), answered_at = now() WHERE id = ${refB.id}`);
    check("a buyer is sent to a lender only after saying yes", false, "update succeeded");
  } catch (e) {
    check("a buyer is sent to a lender only after saying yes", e.code === "23514", e.code);
  }
  await asTenant(B.orgId, (tx) => tx`UPDATE lender_referrals SET state = 'NO', answered_at = now() WHERE id = ${refB.id}`);
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE lender_referrals SET state = 'YES' WHERE id = ${refB.id}`);
    check("a no stays a no", false, "update succeeded");
  } catch (e) {
    check("a no stays a no", e.code === "23514", e.code);
  }
  // 0107: a buyer's home loan.
  const [loanB] = await owner`
    INSERT INTO lead_loans (org_id, lead_id, stage, source) VALUES (${B.orgId}, ${b.lead}, 'INTERESTED', 'PERSON') RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = (await tx`SELECT id FROM lead_loans WHERE id = ${loanB.id}`).length;
    check("tenant B's home loans are invisible to A", seen === 0, `${seen} rows`);
    const res = await tx`UPDATE lead_loans SET stage = 'NOT_NEEDED' WHERE id = ${loanB.id}`;
    check("and A cannot change one", res.count === 0, `${res.count} rows`);
  });
  try {
    await asTenant(A.orgId, (tx) => tx`
      INSERT INTO lead_loans (org_id, lead_id, stage, lender_id, source) VALUES (${A.orgId}, ${a.lead}, 'INTERESTED', ${lenderB.id}, 'PERSON')`);
    check("a loan never names another tenant's lender", false, "insert succeeded");
  } catch (e) {
    check("a loan never names another tenant's lender", e.code === "23514", e.code);
  }
  await asTenant(B.orgId, (tx) => tx`
    UPDATE lead_loans SET stage = 'DISBURSED', lender_id = ${lenderB.id}, amount_paise = 720000000 WHERE id = ${loanB.id}`);
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE lead_loans SET amount_paise = 700000000 WHERE id = ${loanB.id}`);
    check("a disbursed loan never changes", false, "update succeeded");
  } catch (e) {
    check("a disbursed loan never changes", e.code === "23514", e.code);
  }
  try {
    await asTenant(B.orgId, (tx) => tx`DELETE FROM lead_loans WHERE id = ${loanB.id}`);
    check("the app never deletes a loan", false, "delete succeeded");
  } catch (e) {
    check("the app never deletes a loan", e.code === "42501", e.code);
  }
  // 0108: the demands on a loan.
  const [demB] = await owner`
    INSERT INTO lead_loan_demands (org_id, loan_id, milestone, demand_on, amount_paise, buyer_share_paise, bank_share_paise)
    VALUES (${B.orgId}, ${loanB.id}, 'PLINTH', CURRENT_DATE, 100000, 40000, 60000) RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = (await tx`SELECT id FROM lead_loan_demands WHERE id = ${demB.id}`).length;
    check("tenant B's loan demands are invisible to A", seen === 0, `${seen} rows`);
    const res = await tx`UPDATE lead_loan_demands SET buyer_paid_on = CURRENT_DATE WHERE id = ${demB.id}`;
    check("and A cannot mark one paid", res.count === 0, `${res.count} rows`);
  });
  await asTenant(B.orgId, (tx) => tx`UPDATE lead_loan_demands SET bank_paid_paise = 60000, bank_paid_on = CURRENT_DATE WHERE id = ${demB.id}`);
  for (const [name, write, code] of [
    ["a bank payment once recorded never changes", (tx) => tx`UPDATE lead_loan_demands SET bank_paid_paise = 50000 WHERE id = ${demB.id}`, "23514"],
    ["a demand's split never changes", (tx) => tx`UPDATE lead_loan_demands SET bank_share_paise = 1 WHERE id = ${demB.id}`, "42501"],
    ["a demand something was paid on cannot be cancelled", (tx) => tx`UPDATE lead_loan_demands SET cancelled_at = now() WHERE id = ${demB.id}`, "23514"],
    ["the app never deletes a demand", (tx) => tx`DELETE FROM lead_loan_demands WHERE id = ${demB.id}`, "42501"],
  ]) {
    try {
      await asTenant(B.orgId, write);
      check(name, false, "write succeeded");
    } catch (e) {
      check(name, e.code === code, e.code);
    }
  }
  await owner`DELETE FROM lead_loans WHERE id = ${loanB.id}`;
  await owner`DELETE FROM lender_referrals WHERE id = ${refB.id}`;
  // 0109: a bank's approved projects.
  const loanProject = async (t) => (await owner`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${t.orgId}, ${t.nodeId}, 'PROJECT', 'Tied', 'tied', (SELECT path FROM scope_nodes WHERE id = ${t.nodeId}) || 'tied'::ltree)
    RETURNING id`)[0];
  const projB = await loanProject(B);
  const projA = await loanProject(A);
  {
    await owner`INSERT INTO lender_projects (org_id, lender_id, scope_node_id) VALUES (${B.orgId}, ${lenderB.id}, ${projB.id})`;
    await asTenant(A.orgId, async (tx) => {
      const seen = (await tx`SELECT 1 FROM lender_projects WHERE lender_id = ${lenderB.id}`).length;
      check("tenant B's bank tie-ups are invisible to A", seen === 0, `${seen} rows`);
    });
    try {
      await asTenant(B.orgId, (tx) => tx`INSERT INTO lender_projects (org_id, lender_id, scope_node_id) VALUES (${B.orgId}, ${lenderB.id}, ${projA.id})`);
      check("a bank is tied only to its own organisation's projects", false, "insert succeeded");
    } catch (e) {
      check("a bank is tied only to its own organisation's projects", e.code === "23514", e.code);
    }
    await owner`DELETE FROM lender_projects WHERE lender_id = ${lenderB.id}`;
    await owner`DELETE FROM scope_nodes WHERE id IN (${projA.id}, ${projB.id})`;
  }
  await owner`DELETE FROM lenders WHERE id = ${lenderB.id}`;
  await owner`DELETE FROM site_visits WHERE id = ${visitB.id}`;
}

// --- 0056: quotes, blocks, token links and the payment account ------------
console.log("");
console.log("quotes and token links (0056)");
{
  const [leadB] = await owner`SELECT scope_node_id FROM leads WHERE id = ${b.lead}`;
  const [utB] = await owner`
    INSERT INTO unit_types (org_id, scope_node_id, config) VALUES (${B.orgId}, ${leadB.scope_node_id}, '2BHK') RETURNING id`;
  const [accB] = await owner`
    INSERT INTO payment_accounts (org_id, account_id, mode, secret, key_version) VALUES (${B.orgId}, 'acc_RLSCHECKB1', 'test', '\\x00'::bytea, 1) RETURNING id`;
  const [qB] = await owner`
    INSERT INTO quotes (org_id, lead_id, scope_node_id, unit_type_id, unit_no, unit_hash, price, gst_rate, gst, duty_rate, stamp_duty,
                        registration, all_in, token, tax_row, content_hash)
    VALUES (${B.orgId}, ${b.lead}, ${leadB.scope_node_id}, ${utB.id}, 'C-1', ${"a".repeat(64)}, 100, 5, 5, 6, 6, 1, 112, 10, '{}', ${"b".repeat(64)})
    RETURNING id`;
  const [blkB] = await owner`
    INSERT INTO unit_blocks (org_id, scope_node_id, unit_no, quote_id, lead_id, expires_at)
    VALUES (${B.orgId}, ${leadB.scope_node_id}, 'C-1', ${qB.id}, ${b.lead}, now() + interval '2 days') RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = (await tx`SELECT id FROM quotes WHERE id = ${qB.id}`).length
      + (await tx`SELECT id FROM unit_blocks WHERE id = ${blkB.id}`).length
      + (await tx`SELECT id FROM payment_accounts WHERE id = ${accB.id}`).length;
    check("tenant B's quotes, blocks and payment account are invisible to A", seen === 0, `${seen} rows`);
    const [owner_] = await tx`SELECT org_id FROM payment_account_owner('acc_RLSCHECKB1')`;
    check("a webhook's account is found across tenants, as an id only", owner_?.org_id === B.orgId, JSON.stringify(owner_));
  });
  try {
    await owner`INSERT INTO payment_accounts (org_id, account_id, mode, secret, key_version) VALUES (${A.orgId}, 'acc_RLSCHECKB1', 'test', '\\x00'::bytea, 1)`;
    check("one Razorpay account belongs to one tenant", false, "insert succeeded");
  } catch (e) {
    check("one Razorpay account belongs to one tenant", e.code === "23505", e.code);
  }
  for (const [name, write] of [
    ["a quote's numbers are never rewritten by the app", (tx) => tx`UPDATE quotes SET all_in = 1 WHERE id = ${qB.id}`],
    ["a payment account's id is never rewritten by the app", (tx) => tx`UPDATE payment_accounts SET account_id = 'acc_OTHER0001' WHERE id = ${accB.id}`],
    ["a block's flat is never rewritten by the app", (tx) => tx`UPDATE unit_blocks SET unit_no = 'C-2' WHERE id = ${blkB.id}`],
  ]) {
    try {
      await asTenant(B.orgId, write);
      check(name, false, "write succeeded");
    } catch (e) {
      check(name, e.code === "42501", e.code);
    }
  }
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE quotes SET state = 'SENT', sent_at = now() WHERE id = ${qB.id}`);
    check("a draft is never sent without an approval", false, "update succeeded");
  } catch (e) {
    check("a draft is never sent without an approval", e.code === "23514", e.code);
  }
  await asTenant(B.orgId, (tx) => tx`UPDATE unit_blocks SET state = 'RELEASED', released_at = now() WHERE id = ${blkB.id}`);
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE unit_blocks SET state = 'PENDING_TOKEN', released_at = NULL WHERE id = ${blkB.id}`);
    check("a released block is final", false, "update succeeded");
  } catch (e) {
    check("a released block is final", e.code === "23514", e.code);
  }
  await owner`DELETE FROM unit_blocks WHERE id = ${blkB.id}`;
  await owner`DELETE FROM quotes WHERE id = ${qB.id}`;
  await owner`DELETE FROM payment_accounts WHERE id = ${accB.id}`;
  await owner`DELETE FROM unit_types WHERE id = ${utB.id}`;
}

// --- 0069: floor rise and PLC, tokens paid by hand, refunds -----------------
console.log("");
console.log("offline tokens and refunds (0069)");
{
  const [leadB] = await owner`SELECT scope_node_id FROM leads WHERE id = ${b.lead}`;
  const [utB] = await owner`
    INSERT INTO unit_types (org_id, scope_node_id, config) VALUES (${B.orgId}, ${leadB.scope_node_id}, '2BHK') RETURNING id`;
  const [qB] = await owner`
    INSERT INTO quotes (org_id, lead_id, scope_node_id, unit_type_id, unit_no, unit_hash, price, extras, gst_rate, gst, duty_rate, stamp_duty,
                        registration, all_in, token, tax_row, content_hash, state, approved_at, sent_at)
    VALUES (${B.orgId}, ${b.lead}, ${leadB.scope_node_id}, ${utB.id}, 'C-1', ${"a".repeat(64)}, 100, 10, 5, 5, 6, 6, 1, 122, 10, '{}',
            ${"b".repeat(64)}, 'SENT', now(), now())
    RETURNING id`;
  const [blkB] = await owner`
    INSERT INTO unit_blocks (org_id, scope_node_id, unit_no, quote_id, lead_id, state, paid_at, expires_at)
    VALUES (${B.orgId}, ${leadB.scope_node_id}, 'C-1', ${qB.id}, ${b.lead}, 'TOKEN_PAID', now(), now() + interval '7 days') RETURNING id`;
  const [tpB] = await asTenant(B.orgId, (tx) => tx`
    INSERT INTO token_payments (org_id, quote_id, block_id, lead_id, mode, reference, amount, paid_on)
    VALUES (${B.orgId}, ${qB.id}, ${blkB.id}, ${b.lead}, 'CHEQUE', '004512', 10, current_date) RETURNING id`);
  const [rfB] = await asTenant(B.orgId, (tx) => tx`
    INSERT INTO token_refunds (org_id, quote_id, lead_id, mode, paid_amount, amount, reason, receipt, state)
    VALUES (${B.orgId}, ${qB.id}, ${b.lead}, 'CHEQUE', 10, 10, 'Buyer changed their mind', ${`r${"c".repeat(32)}`}, 'DUE') RETURNING id`);
  await asTenant(A.orgId, async (tx) => {
    const seen = (await tx`SELECT id FROM token_payments WHERE id = ${tpB.id}`).length
      + (await tx`SELECT id FROM token_refunds WHERE id = ${rfB.id}`).length;
    check("tenant B's tokens paid by hand and refunds are invisible to A", seen === 0, `${seen} rows`);
    const hit = await tx`UPDATE token_refunds SET state = 'PROCESSED', processed_at = now(), paid_reference = '004513' WHERE id = ${rfB.id}`;
    check("A cannot mark B's refund paid", hit.count === 0, `${hit.count} rows`);
  });
  try {
    await asTenant(A.orgId, (tx) => tx`
      INSERT INTO token_refunds (org_id, quote_id, lead_id, mode, paid_amount, amount, reason, receipt, state)
      VALUES (${B.orgId}, ${qB.id}, ${b.lead}, 'CHEQUE', 10, 10, 'Other', ${`r${"d".repeat(32)}`}, 'DUE')`);
    check("A cannot write a refund into B", false, "insert succeeded");
  } catch (e) {
    check("A cannot write a refund into B", e.code === "42501" || e.code === "23505", e.code);
  }
  for (const [name, write] of [
    ["a token paid by hand is never rewritten by the app", (tx) => tx`UPDATE token_payments SET amount = 1 WHERE id = ${tpB.id}`],
    ["a refund's amount is never rewritten by the app", (tx) => tx`UPDATE token_refunds SET amount = 5 WHERE id = ${rfB.id}`],
    ["a quote's floor rise and PLC are never rewritten by the app", (tx) => tx`UPDATE quotes SET extras = 0 WHERE id = ${qB.id}`],
    ["a token paid by hand is never deleted by the app", (tx) => tx`DELETE FROM token_payments WHERE id = ${tpB.id}`],
  ]) {
    try {
      await asTenant(B.orgId, write);
      check(name, false, "write succeeded");
    } catch (e) {
      check(name, e.code === "42501", e.code);
    }
  }
  for (const [name, write] of [
    ["a refund is never more than was paid", (tx) => tx`
      INSERT INTO token_refunds (org_id, quote_id, lead_id, mode, paid_amount, amount, reason, receipt, state)
      VALUES (${B.orgId}, ${qB.id}, ${b.lead}, 'CHEQUE', 10, 11, 'Other', ${`r${"e".repeat(32)}`}, 'DUE')`],
    ["an all-in figure leaves nothing out", (tx) => tx`
      INSERT INTO quotes (org_id, lead_id, scope_node_id, unit_type_id, unit_no, unit_hash, price, extras, gst_rate, gst, duty_rate, stamp_duty,
                          registration, all_in, token, tax_row, content_hash)
      VALUES (${B.orgId}, ${b.lead}, ${leadB.scope_node_id}, ${utB.id}, 'C-2', ${"a".repeat(64)}, 100, 10, 5, 5, 6, 6, 1, 112, 10, '{}', ${"b".repeat(64)})`],
  ]) {
    try {
      await asTenant(B.orgId, write);
      check(name, false, "write succeeded");
    } catch (e) {
      check(name, e.code === "23514", e.code);
    }
  }
  await asTenant(B.orgId, (tx) => tx`UPDATE token_refunds SET state = 'PROCESSED', processed_at = now(), paid_reference = '004513' WHERE id = ${rfB.id}`);
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE token_refunds SET state = 'DUE', processed_at = NULL WHERE id = ${rfB.id}`);
    check("a refund paid is final", false, "update succeeded");
  } catch (e) {
    check("a refund paid is final", e.code === "23514", e.code);
  }
  await asTenant(B.orgId, (tx) => tx`UPDATE quotes SET state = 'CANCELLED', cancelled_at = now() WHERE id = ${qB.id}`);
  try {
    await asTenant(B.orgId, (tx) => tx`UPDATE quotes SET state = 'SENT', cancelled_at = NULL WHERE id = ${qB.id}`);
    check("a cancelled quote stays cancelled", false, "update succeeded");
  } catch (e) {
    check("a cancelled quote stays cancelled", e.code === "23514", e.code);
  }
  await owner`DELETE FROM token_refunds WHERE id = ${rfB.id}`;
  await owner`DELETE FROM token_payments WHERE id = ${tpB.id}`;
  await owner`DELETE FROM unit_blocks WHERE id = ${blkB.id}`;
  await owner`DELETE FROM quotes WHERE id = ${qB.id}`;
  await owner`DELETE FROM unit_types WHERE id = ${utB.id}`;
}

// A lead's tower is ON DELETE RESTRICT, so the leads go before the orgs do.
await owner`DELETE FROM leads WHERE id IN (${a.lead}, ${b.lead})`;

console.log("");
console.log("Billing: isolation, and what only the operator may write");

// Each tenant is sold a plan on a project of its own, uses something, holds
// a top-up, starts a payment, has an invoice and a gateway event, so every
// billing table below has something real of B's to try to reach.
const billOf = {};
for (const t of [A, B]) {
  const [project] = await owner`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${t.orgId}, ${t.nodeId}, 'PROJECT', 'Billed', 'billed',
            (SELECT path FROM scope_nodes WHERE id = ${t.nodeId}) || 'billed'::ltree)
    RETURNING id`;
  await owner`INSERT INTO billing_accounts (org_id, bill_name) VALUES (${t.orgId}, 'Billed Ltd')`;
  const [sub] = await owner`
    INSERT INTO subscriptions (org_id, project_id, plan, status, starts_on, terms)
    VALUES (${t.orgId}, ${project.id}, 'LAUNCH', 'ACTIVE', date_trunc('month', now())::date, '{}'::jsonb) RETURNING id`;
  const [use] = await owner`
    INSERT INTO usage_events (org_id, project_id, kind, unit, qty, from_allowance, billable, plan, source_kind, source_id, period)
    VALUES (${t.orgId}, ${project.id}, 'IMAGE_POST', 'IMAGE', 1, 1, true, 'LAUNCH', 'post', ${`rls-${t.orgId}`}, date_trunc('month', now())::date)
    RETURNING id`;
  const [lot] = await owner`
    INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source)
    VALUES (${t.orgId}, 'CREDIT', 'VIDEO', 2, now() + interval '1 year', 'GRANT') RETURNING id`;
  const [pay] = await owner`
    INSERT INTO payments (org_id, order_id, items, taxable_paise, tax_paise, total_paise, test)
    VALUES (${t.orgId}, ${`order_rls_${tag}_${t.orgId.slice(0, 8)}`}, '[]'::jsonb, 100, 18, 118, true) RETURNING id`;
  const [{ seq }] = await owner`SELECT next_invoice_seq('TST', '00-01') AS seq`;
  const [inv] = await owner`
    INSERT INTO invoices (org_id, number, series, fy, seq, kind, purpose, test, issued_on, seller, buyer, place_of_supply,
                          lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
    VALUES (${t.orgId}, ${`TST/00-01/${String(seq).padStart(5, "0")}`}, 'TST', '00-01', ${seq}, 'INVOICE', 'TOPUP', true,
            current_date, '{}'::jsonb, '{}'::jsonb, '27', '[]'::jsonb, 100, 9, 9, 0, 118)
    RETURNING id`;
  const [ev] = await owner`
    INSERT INTO billing_events (org_id, event_id, type, payload)
    VALUES (${t.orgId}, ${`evt_rls_${tag}_${t.orgId.slice(0, 8)}`}, 'payment.captured', '{}'::jsonb) RETURNING id`;
  billOf[t.orgId] = { project: project.id, sub: sub.id, use: use.id, lot: lot.id, pay: pay.id, inv: inv.id, ev: ev.id };
}
const ba = billOf[A.orgId];
const bb = billOf[B.orgId];

const billTables = ["billing_accounts", "subscriptions", "usage_events", "wallet_entries", "payments", "invoices", "billing_events"];
await asTenant(A.orgId, async (tx) => {
  for (const table of billTables) {
    const rows = await tx`SELECT org_id FROM ${tx(table)}`;
    check(`${table} shows only tenant A`, rows.length >= 1 && rows.every((r) => r.org_id === A.orgId), `${rows.length} rows`);
  }
  const ids = { subscriptions: bb.sub, usage_events: bb.use, wallet_entries: bb.lot, payments: bb.pay, invoices: bb.inv, billing_events: bb.ev };
  for (const [table, id] of Object.entries(ids)) {
    const direct = await tx`SELECT id FROM ${tx(table)} WHERE id = ${id}`;
    check(`tenant B's ${table} row is invisible even by explicit id`, direct.length === 0);
  }
  const acct = await tx`UPDATE billing_accounts SET bill_name = 'Hijacked' WHERE org_id = ${B.orgId}`;
  check("cannot rename who tenant B's invoices go to", acct.count === 0, `${acct.count} rows affected`);
  const paid = await tx`UPDATE payments SET status = 'FAILED' WHERE org_id = ${B.orgId}`;
  check("cannot settle or fail tenant B's payment", paid.count === 0, `${paid.count} rows affected`);
});

for (const [name, attempt] of [
  ["cannot meter usage onto tenant B", (tx) => tx`
    INSERT INTO usage_events (org_id, kind, unit, qty, billable, source_kind, source_id, period)
    VALUES (${B.orgId}, 'VIDEO', 'VIDEO', 1, true, 'post', 'smuggled', date_trunc('month', now())::date)`],
  ["cannot draw on tenant B's top-up", (tx) => tx`
    INSERT INTO wallet_entries (org_id, kind, unit, qty, lot_id, source, usage_id)
    VALUES (${B.orgId}, 'DRAW', 'VIDEO', 1, ${bb.lot}, 'USAGE', ${bb.use})`],
  ["cannot start a payment in tenant B's name", (tx) => tx`
    INSERT INTO payments (org_id, order_id, items, taxable_paise, tax_paise, total_paise, test)
    VALUES (${B.orgId}, 'order_smuggled', '[]'::jsonb, 100, 18, 118, true)`],
  ["cannot issue an invoice to tenant B", (tx) => tx`
    INSERT INTO invoices (org_id, number, series, fy, seq, kind, purpose, test, issued_on, seller, buyer, place_of_supply,
                          lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
    VALUES (${B.orgId}, 'TST/00-01/99999', 'TST', '00-01', 99999, 'INVOICE', 'TOPUP', true, current_date,
            '{}'::jsonb, '{}'::jsonb, '27', '[]'::jsonb, 0, 0, 0, 0, 0)`],
  ["tenant A cannot sell itself a plan", (tx) => tx`
    INSERT INTO subscriptions (org_id, project_id, plan, status, starts_on, ends_on, terms)
    VALUES (${A.orgId}, ${ba.project}, 'SCALE', 'ACTIVE', date_trunc('month', now())::date - 400, date_trunc('month', now())::date, '{}'::jsonb)`],
  ["tenant A cannot switch its own billing to another mode", (tx) => tx`
    UPDATE billing_accounts SET mode = 'LIVE' WHERE org_id = ${A.orgId}`],
  ["tenant A cannot give itself free credit", (tx) => tx`
    INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source)
    VALUES (${A.orgId}, 'CREDIT', 'VIDEO', 100, now() + interval '1 year', 'GRANT')`],
  ["tenant A cannot rewrite what it used", (tx) => tx`UPDATE usage_events SET qty = 0 WHERE org_id = ${A.orgId}`],
  ["tenant A cannot delete what it used", (tx) => tx`DELETE FROM usage_events WHERE org_id = ${A.orgId}`],
  ["tenant A cannot delete a draw on its top-ups", (tx) => tx`DELETE FROM wallet_entries WHERE org_id = ${A.orgId}`],
  ["tenant A cannot edit an issued invoice", (tx) => tx`UPDATE invoices SET total_paise = 1 WHERE org_id = ${A.orgId}`],
  ["tenant A cannot read or move the invoice counter", (tx) => tx`SELECT * FROM invoice_series`],
]) {
  try {
    await asTenant(A.orgId, attempt);
    check(name, false, "it succeeded");
  } catch (e) {
    check(name, e.code === "42501", e.code);
  }
}

// A credit bought with a payment needs that payment PAID, in the same tenant.
try {
  await asTenant(A.orgId, (tx) => tx`
    INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source, payment_id, test)
    VALUES (${A.orgId}, 'CREDIT', 'VIDEO', 5, now() + interval '1 year', 'PURCHASE', ${ba.pay}, true)`);
  check("an unpaid payment buys no top-up", false, "it did");
} catch (e) {
  check("an unpaid payment buys no top-up", e.code === "23514", e.code);
}
try {
  await asTenant(A.orgId, (tx) => tx`
    INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source, payment_id, test)
    VALUES (${A.orgId}, 'CREDIT', 'VIDEO', 5, now() + interval '1 year', 'PURCHASE', ${bb.pay}, true)`);
  check("tenant B's payment buys tenant A nothing", false, "it did");
} catch (e) {
  check("tenant B's payment buys tenant A nothing", e.code === "23514", e.code);
}

await app.begin(async (tx) => {
  let seen = 0;
  for (const table of billTables) seen += (await tx`SELECT org_id FROM ${tx(table)}`).length;
  check("the billing tables are empty when app.org_id is unset", seen === 0, `${seen} rows`);
});

console.log("");
console.log("credit notes and automatic top-ups (0071): isolation, and what only the operator may write");
{
  // Each tenant holds a saved mandate and a recorded automatic top-up, so
  // both tables have something real of B's to reach for.
  const autoOf = {};
  for (const t of [A, B]) {
    const [m] = await owner`
      INSERT INTO billing_mandates (org_id, method, secret, key_version, max_amount_paise, test)
      VALUES (${t.orgId}, 'EMANDATE', '\\x01'::bytea, 1, 1500000, true) RETURNING id`;
    const [c] = await owner`
      INSERT INTO auto_topup_charges (org_id, period, seq, sku, qty, unit, units, taxable_paise, total_paise, left_then, status, note)
      VALUES (${t.orgId}, date_trunc('month', now())::date, 1, 'VIDEO', 1, 'VIDEO', 1, 549900, 648882, 0, 'WOULD_CHARGE', 'SHADOW') RETURNING id`;
    autoOf[t.orgId] = { mandate: m.id, charge: c.id };
  }
  const autoTables = ["billing_mandates", "auto_topup_charges"];
  await asTenant(A.orgId, async (tx) => {
    for (const table of autoTables) {
      const rows = await tx`SELECT org_id FROM ${tx(table)}`;
      check(`${table} shows only tenant A`, rows.length >= 1 && rows.every((r) => r.org_id === A.orgId), `${rows.length} rows`);
    }
    for (const [table, id] of [["billing_mandates", autoOf[B.orgId].mandate], ["auto_topup_charges", autoOf[B.orgId].charge]]) {
      const direct = await tx`SELECT id FROM ${tx(table)} WHERE id = ${id}`;
      check(`tenant B's ${table} row is invisible even by explicit id`, direct.length === 0);
    }
    const moved = await tx`UPDATE auto_topup_charges SET note = 'HIJACKED' WHERE org_id = ${B.orgId}`;
    check("cannot touch tenant B's automatic top-ups", moved.count === 0, `${moved.count} rows affected`);
  });

  for (const [name, attempt, code] of [
    ["tenant A cannot save itself a mandate", (tx) => tx`
      INSERT INTO billing_mandates (org_id, method, secret, key_version, max_amount_paise, test)
      VALUES (${A.orgId}, 'CARD', '\\x01'::bytea, 1, 100, true)`, "42501"],
    ["tenant A cannot issue itself a credit note", (tx) => tx`
      INSERT INTO invoices (org_id, number, series, fy, seq, kind, purpose, test, issued_on, seller, buyer, place_of_supply,
                            lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, reverses, reason)
      VALUES (${A.orgId}, 'TCN/00-01/99999', 'TCN', '00-01', 99999, 'CREDIT_NOTE', 'TOPUP', true, current_date,
              '{}'::jsonb, '{}'::jsonb, '27', '[]'::jsonb, 100, 9, 9, 0, 118, ${ba.inv}, 'Smuggled')`, "42501"],
    ["tenant A cannot take a top-up back without a credit note of the operator's", (tx) => tx`
      INSERT INTO wallet_entries (org_id, kind, unit, qty, lot_id, source, credit_note_id)
      VALUES (${A.orgId}, 'REVERSE', 'VIDEO', 1, ${ba.lot}, 'CREDIT_NOTE', ${ba.inv})`, "42501"],
    ["cannot record an automatic top-up in tenant B's name", (tx) => tx`
      INSERT INTO auto_topup_charges (org_id, period, seq, sku, qty, unit, units, taxable_paise, total_paise, left_then, status)
      VALUES (${B.orgId}, date_trunc('month', now())::date, 50, 'VIDEO', 1, 'VIDEO', 1, 549900, 648882, 0, 'WOULD_CHARGE')`, "42501"],
    ["a shadow organisation's automatic top-up is never a charge", (tx) => tx`
      INSERT INTO auto_topup_charges (org_id, period, seq, sku, qty, unit, units, taxable_paise, total_paise, left_then, status, notified_at, due_at)
      VALUES (${A.orgId}, date_trunc('month', now())::date, 51, 'VIDEO', 1, 'VIDEO', 1, 549900, 648882, 0, 'NOTIFIED', now(), now())`, "23514"],
    ["a recorded top-up cannot be turned into a charge", (tx) => tx`
      UPDATE auto_topup_charges SET status = 'CHARGING' WHERE org_id = ${A.orgId}`, "23514"],
    ["tenant A cannot delete its automatic top-ups", (tx) => tx`DELETE FROM auto_topup_charges WHERE org_id = ${A.orgId}`, "42501"],
    ["tenant A cannot rewrite what an automatic top-up bought", (tx) => tx`UPDATE auto_topup_charges SET total_paise = 1 WHERE org_id = ${A.orgId}`, "42501"],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, e.code === code, e.code);
    }
  }

  await app.begin(async (tx) => {
    let seen = 0;
    for (const table of autoTables) seen += (await tx`SELECT org_id FROM ${tx(table)}`).length;
    check("the auto top-up tables are empty when app.org_id is unset", seen === 0, `${seen} rows`);
  });
}

console.log("");
console.log("a mandate the client sets up, and refunds (0077): isolation, and what the app may write");
{
  const setupOf = {};
  for (const [i, t] of [A, B].entries()) {
    const [s] = await owner`
      INSERT INTO billing_mandate_setups (org_id, order_id, customer_id, method, max_amount_paise, auth_paise, expire_at, test)
      VALUES (${t.orgId}, ${`order_rls_${i}_${Date.now()}`}, 'cust_rls0000001', 'EMANDATE', 1500000, 0, now() + interval '5 years', ${i === 1})
      RETURNING id`;
    setupOf[t.orgId] = s.id;
  }
  await asTenant(A.orgId, async (tx) => {
    const rows = await tx`SELECT org_id FROM billing_mandate_setups`;
    check("billing_mandate_setups shows only tenant A", rows.length >= 1 && rows.every((r) => r.org_id === A.orgId), `${rows.length} rows`);
    const direct = await tx`SELECT id FROM billing_mandate_setups WHERE id = ${setupOf[B.orgId]}`;
    check("tenant B's mandate set-up is invisible even by explicit id", direct.length === 0);
    const moved = await tx`UPDATE billing_mandate_setups SET status = 'EXPIRED' WHERE org_id = ${B.orgId}`;
    check("cannot touch tenant B's mandate set-ups", moved.count === 0, `${moved.count} rows affected`);
    const [{ org }] = await tx`SELECT mandate_setup_org(${"order_nobody"}) AS org`;
    check("an order nobody set up names no tenant", org === null);
  });
  for (const [name, attempt, code] of [
    ["tenant A cannot save a mandate from tenant B's set-up", (tx) => tx`
      INSERT INTO billing_mandates (org_id, method, secret, key_version, max_amount_paise, test, setup_id)
      VALUES (${A.orgId}, 'EMANDATE', '\\x01'::bytea, 1, 1500000, true, ${setupOf[B.orgId]})`, "42501"],
    ["tenant A cannot save a mandate in tenant B's name", (tx) => tx`
      INSERT INTO billing_mandates (org_id, method, secret, key_version, max_amount_paise, test, setup_id)
      VALUES (${B.orgId}, 'EMANDATE', '\\x01'::bytea, 1, 1500000, true, ${setupOf[B.orgId]})`, "42501"],
    ["a mandate larger than the set-up asked for is refused", (tx) => tx`
      INSERT INTO billing_mandates (org_id, method, secret, key_version, max_amount_paise, test, setup_id)
      VALUES (${A.orgId}, 'EMANDATE', '\\x01'::bytea, 1, 9900000, false, ${setupOf[A.orgId]})`, "42501"],
    ["a live mandate is refused for an organisation that is not LIVE", (tx) => tx`
      INSERT INTO billing_mandates (org_id, method, secret, key_version, max_amount_paise, test, setup_id)
      VALUES (${A.orgId}, 'EMANDATE', '\\x01'::bytea, 1, 1500000, false, ${setupOf[A.orgId]})`, "23514"],
    ["cannot start a mandate set-up in tenant B's name", (tx) => tx`
      INSERT INTO billing_mandate_setups (org_id, order_id, customer_id, method, max_amount_paise, auth_paise, expire_at, test)
      VALUES (${B.orgId}, 'order_rls_smuggled', 'cust_rls0000001', 'CARD', 100, 100, now(), true)`, "42501"],
    ["tenant A cannot rewrite what a set-up asked for", (tx) => tx`
      UPDATE billing_mandate_setups SET max_amount_paise = 1 WHERE org_id = ${A.orgId}`, "42501"],
    ["tenant A cannot delete a mandate set-up", (tx) => tx`DELETE FROM billing_mandate_setups WHERE org_id = ${A.orgId}`, "42501"],
    ["tenant A cannot record a refund on a credit note", (tx) => tx`
      UPDATE invoices SET refund_status = 'REQUESTED', refund_paise = 1, refund_requested_at = now() WHERE org_id = ${A.orgId}`, "42501"],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, e.code === code, e.code);
    }
  }
  await app.begin(async (tx) => {
    const seen = (await tx`SELECT org_id FROM billing_mandate_setups`).length;
    check("the mandate set-ups are empty when app.org_id is unset", seen === 0, `${seen} rows`);
  });
}

console.log("");
console.log("each developer's own WhatsApp number (0045): isolation");
{
  // Each tenant gets an account with a sealed token, a number and a
  // template, so every table below has something real of B's to reach for.
  const waOf = {};
  const stamp = String(Date.now()).slice(-9);
  for (const [i, t] of [A, B].entries()) {
    const [acct] = await owner`
      INSERT INTO whatsapp_accounts (org_id, waba_id, status, secret, key_version)
      VALUES (${t.orgId}, ${`4${i}${stamp}`}, 'CONNECTED', '\\x01'::bytea, 1) RETURNING id`;
    const [num] = await owner`
      INSERT INTO whatsapp_numbers (org_id, account_id, phone_number_id, display_phone, registered, scope_node_id, active)
      VALUES (${t.orgId}, ${acct.id}, ${`5${i}${stamp}`}, '+919876501234', true, ${t.nodeId}, true) RETURNING id`;
    const [tpl] = await owner`
      INSERT INTO whatsapp_templates (org_id, account_id, name, language, category_asked, status, body_sha256)
      VALUES (${t.orgId}, ${acct.id}, 'salesdesk_enquiry_received', 'en', 'UTILITY', 'APPROVED', ${"a".repeat(64)}) RETURNING id`;
    waOf[t.orgId] = { acct: acct.id, num: num.id, tpl: tpl.id, waba: `4${i}${stamp}`, phone: `5${i}${stamp}` };
  }
  const wb = waOf[B.orgId];
  const waTables = ["whatsapp_accounts", "whatsapp_numbers", "whatsapp_templates"];
  await asTenant(A.orgId, async (tx) => {
    for (const table of waTables) {
      const rows = await tx`SELECT org_id FROM ${tx(table)}`;
      check(`${table} shows only tenant A`, rows.length >= 1 && rows.every((r) => r.org_id === A.orgId), `${rows.length} rows`);
    }
    const ids = { whatsapp_accounts: wb.acct, whatsapp_numbers: wb.num, whatsapp_templates: wb.tpl };
    for (const [table, id] of Object.entries(ids)) {
      const direct = await tx`SELECT id FROM ${tx(table)} WHERE id = ${id}`;
      check(`tenant B's ${table} row is invisible even by explicit id`, direct.length === 0);
    }
    const token = await tx`UPDATE whatsapp_accounts SET status = 'BROKEN' WHERE org_id = ${B.orgId}`;
    check("cannot break tenant B's WhatsApp account", token.count === 0, `${token.count} rows affected`);
    const moved = await tx`UPDATE whatsapp_numbers SET active = false WHERE org_id = ${B.orgId}`;
    check("cannot take tenant B's number off its towers", moved.count === 0, `${moved.count} rows affected`);
    const approve = await tx`UPDATE whatsapp_templates SET status = 'REJECTED' WHERE org_id = ${B.orgId}`;
    check("cannot change what Meta decided about tenant B's templates", approve.count === 0, `${approve.count} rows affected`);
  });

  for (const [name, attempt] of [
    ["cannot connect a WhatsApp account inside tenant B", (tx) => tx`
      INSERT INTO whatsapp_accounts (org_id, waba_id, status, secret, key_version) VALUES (${B.orgId}, '999', 'CONNECTED', '\\x01'::bytea, 1)`],
    ["cannot add a number to tenant B's account", (tx) => tx`
      INSERT INTO whatsapp_numbers (org_id, account_id, phone_number_id, display_phone) VALUES (${B.orgId}, ${wb.acct}, '998', '+919000000000')`],
    ["cannot delete an account the app scrubs", (tx) => tx`DELETE FROM whatsapp_accounts WHERE org_id = ${A.orgId}`],
    ["cannot delete a number the messages name", (tx) => tx`DELETE FROM whatsapp_numbers WHERE org_id = ${A.orgId}`],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, e.code === "42501", e.code);
    }
  }

  // One number, one tenant: A cannot claim B's number or B's WABA, and the
  // refusal says only that it is taken.
  for (const [name, attempt] of [
    ["tenant A cannot connect the WABA tenant B holds", (tx) => tx`
      INSERT INTO whatsapp_accounts (org_id, waba_id, status, secret, key_version) VALUES (${A.orgId}, ${wb.waba}, 'CONNECTED', '\\x01'::bytea, 1)`],
    ["tenant A cannot connect the number tenant B holds", (tx) => tx`
      INSERT INTO whatsapp_numbers (org_id, account_id, phone_number_id, display_phone) VALUES (${A.orgId}, ${waOf[A.orgId].acct}, ${wb.phone}, '+919000000000')`],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, e.code === "23505", e.code);
    }
  }

  try {
    await owner`UPDATE whatsapp_accounts SET status = 'DISCONNECTED' WHERE id = ${waOf[A.orgId].acct}`;
    check("a disconnected account cannot keep its token", false, "update succeeded");
  } catch (e) {
    check("a disconnected account cannot keep its token", e.code === "23514", e.code);
  }

  // The webhook's two lookups: ids only, and only for live rows.
  await app.begin(async (tx) => {
    const [n] = await tx`SELECT * FROM whatsapp_number_owner(${wb.phone})`;
    check("the number lookup names tenant B and returns ids only",
      n?.org_id === B.orgId && Object.keys(n).sort().join(",") === "number_id,org_id", JSON.stringify(n));
    const [w] = await tx`SELECT * FROM whatsapp_waba_owner(${wb.waba})`;
    check("the WABA lookup returns ids only", Object.keys(w ?? {}).sort().join(",") === "account_id,org_id", JSON.stringify(w));
    const odd = await tx`SELECT * FROM whatsapp_number_owner(${"1' OR '1'='1"})`;
    check("a lookup with something that is not an id returns nothing", odd.length === 0);
    let seen = 0;
    for (const table of waTables) seen += (await tx`SELECT id FROM ${tx(table)}`).length;
    check("the WhatsApp tables are empty when app.org_id is unset", seen === 0, `${seen} rows`);
  });

  for (const t of [A, B]) {
    await owner`DELETE FROM whatsapp_templates WHERE org_id = ${t.orgId}`;
    await owner`DELETE FROM whatsapp_numbers WHERE org_id = ${t.orgId}`;
    await owner`DELETE FROM whatsapp_accounts WHERE org_id = ${t.orgId}`;
  }
}

console.log("");
console.log("WhatsApp broadcasts (0059): isolation");
{
  const bcOf = {};
  for (const t of [A, B]) {
    const [lead] = await owner`
      INSERT INTO leads (org_id, scope_node_id, name, phone) VALUES (${t.orgId}, ${t.nodeId}, 'Buyer', '+919812300077') RETURNING id`;
    const [b] = await owner`
      INSERT INTO broadcasts (org_id, scope_node_id, source, media_key, media_sha256, line, status, approved_at, audience)
      VALUES (${t.orgId}, ${t.nodeId}, 'STUDIO', ${`org/${t.orgId}/post/x`}, ${"c".repeat(64)}, 'Sea facing homes.', 'APPROVED', now(), 1)
      RETURNING id`;
    const [r] = await owner`
      INSERT INTO broadcast_recipients (org_id, broadcast_id, lead_id, voice) VALUES (${t.orgId}, ${b.id}, ${lead.id}, 'ENGLISH') RETURNING id`;
    const [o] = await owner`
      INSERT INTO message_opt_outs (org_id, phone, source) VALUES (${t.orgId}, '+919812300077', 'BUTTON') RETURNING id`;
    bcOf[t.orgId] = { lead: lead.id, bc: b.id, rec: r.id, opt: o.id };
  }
  const bb = bcOf[B.orgId];
  const bcTables = ["broadcasts", "broadcast_recipients", "message_opt_outs"];
  await asTenant(A.orgId, async (tx) => {
    for (const table of bcTables) {
      const rows = await tx`SELECT org_id FROM ${tx(table)}`;
      check(`${table} shows only tenant A`, rows.length >= 1 && rows.every((r) => r.org_id === A.orgId), `${rows.length} rows`);
    }
    for (const [table, id] of [["broadcasts", bb.bc], ["broadcast_recipients", bb.rec], ["message_opt_outs", bb.opt]]) {
      const direct = await tx`SELECT id FROM ${tx(table)} WHERE id = ${id}`;
      check(`tenant B's ${table} row is invisible even by explicit id`, direct.length === 0);
    }
    const stop = await tx`UPDATE broadcasts SET status = 'CANCELLED' WHERE org_id = ${B.orgId}`;
    check("cannot stop tenant B's broadcast", stop.count === 0, `${stop.count} rows affected`);
    const rec = await tx`UPDATE broadcast_recipients SET status = 'CANCELLED' WHERE org_id = ${B.orgId}`;
    check("cannot cancel tenant B's recipients", rec.count === 0, `${rec.count} rows affected`);
  });

  for (const [name, attempt] of [
    ["cannot broadcast inside tenant B", (tx) => tx`
      INSERT INTO broadcasts (org_id, scope_node_id, source, media_key, media_sha256, line)
      VALUES (${B.orgId}, ${B.nodeId}, 'STUDIO', 'k', ${"c".repeat(64)}, 'x')`],
    ["cannot add a recipient to tenant B's broadcast", (tx) => tx`
      INSERT INTO broadcast_recipients (org_id, broadcast_id, lead_id, voice) VALUES (${B.orgId}, ${bb.bc}, ${bb.lead}, 'ENGLISH')`],
    ["cannot stop promotions for tenant B's buyer", (tx) => tx`
      INSERT INTO message_opt_outs (org_id, phone, source) VALUES (${B.orgId}, '+919812300099', 'PERSON')`],
    ["a broadcast is never deleted by the app", (tx) => tx`DELETE FROM broadcasts WHERE org_id = ${A.orgId}`],
    ["a recipient is never deleted by the app", (tx) => tx`DELETE FROM broadcast_recipients WHERE org_id = ${A.orgId}`],
    ["a marketing stop is never deleted by the app", (tx) => tx`DELETE FROM message_opt_outs WHERE org_id = ${A.orgId}`],
    ["a marketing stop is never rewritten", (tx) => tx`UPDATE message_opt_outs SET resumed = true WHERE org_id = ${A.orgId}`],
    ["a broadcast's picture and line are never rewritten", (tx) => tx`UPDATE broadcasts SET line = 'other words' WHERE org_id = ${A.orgId}`],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, e.code === "42501", e.code);
    }
  }

  await app.begin(async (tx) => {
    let seen = 0;
    for (const table of bcTables) seen += (await tx`SELECT id FROM ${tx(table)}`).length;
    check("the broadcast tables are empty when app.org_id is unset", seen === 0, `${seen} rows`);
  });

  for (const t of [A, B]) {
    const o = bcOf[t.orgId];
    await owner`DELETE FROM broadcast_recipients WHERE org_id = ${t.orgId}`;
    await owner`DELETE FROM broadcasts WHERE org_id = ${t.orgId}`;
    await owner`DELETE FROM message_opt_outs WHERE org_id = ${t.orgId}`;
    await owner`DELETE FROM leads WHERE id = ${o.lead}`;
  }
}

console.log("");
console.log("Service SMS (0061): isolation");
{
  const smsOf = {};
  for (const t of [A, B]) {
    const [sender] = await owner`
      INSERT INTO sms_senders (org_id, scope_node_id, dlt_entity_id, header) VALUES (${t.orgId}, ${t.nodeId}, '1201159178483176795', 'SATHHT') RETURNING id`;
    const [tpl] = await owner`
      INSERT INTO sms_templates (org_id, sender_id, purpose, voice, dlt_template_id, body_sha256)
      VALUES (${t.orgId}, ${sender.id}, 'ACK', 'ENGLISH', '1207161729781542612', ${"d".repeat(64)}) RETURNING id`;
    smsOf[t.orgId] = { sender: sender.id, tpl: tpl.id };
  }
  const sb = smsOf[B.orgId];
  const smsTables = ["sms_senders", "sms_templates"];
  await asTenant(A.orgId, async (tx) => {
    for (const table of smsTables) {
      const rows = await tx`SELECT org_id FROM ${tx(table)}`;
      check(`${table} shows only tenant A`, rows.length >= 1 && rows.every((r) => r.org_id === A.orgId), `${rows.length} rows`);
    }
    for (const [table, id] of [["sms_senders", sb.sender], ["sms_templates", sb.tpl]]) {
      const direct = await tx`SELECT id FROM ${tx(table)} WHERE id = ${id}`;
      check(`tenant B's ${table} row is invisible even by explicit id`, direct.length === 0);
    }
    const retire = await tx`UPDATE sms_senders SET status = 'RETIRED', retired_at = now() WHERE org_id = ${B.orgId}`;
    check("cannot retire tenant B's DLT registration", retire.count === 0, `${retire.count} rows affected`);
  });

  for (const [name, attempt] of [
    ["cannot register a header inside tenant B", (tx) => tx`
      INSERT INTO sms_senders (org_id, scope_node_id, dlt_entity_id, header) VALUES (${B.orgId}, ${B.nodeId}, '1201159178483176795', 'OTHERS')`],
    ["cannot add a template id under tenant B's registration", (tx) => tx`
      INSERT INTO sms_templates (org_id, sender_id, purpose, voice, dlt_template_id, body_sha256)
      VALUES (${B.orgId}, ${sb.sender}, 'ACK', 'HINGLISH', '1207161729781542699', ${"d".repeat(64)})`],
    ["a DLT registration is never deleted by the app", (tx) => tx`DELETE FROM sms_senders WHERE org_id = ${A.orgId}`],
    ["a template id is never deleted by the app", (tx) => tx`DELETE FROM sms_templates WHERE org_id = ${A.orgId}`],
    ["a registered entity id is never rewritten", (tx) => tx`UPDATE sms_senders SET dlt_entity_id = '1201159178483170000' WHERE org_id = ${A.orgId}`],
    ["a template id is never rewritten", (tx) => tx`UPDATE sms_templates SET dlt_template_id = '1207161729781540000' WHERE org_id = ${A.orgId}`],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, e.code === "42501", e.code);
    }
  }

  await app.begin(async (tx) => {
    let seen = 0;
    for (const table of smsTables) seen += (await tx`SELECT id FROM ${tx(table)}`).length;
    check("the SMS tables are empty when app.org_id is unset", seen === 0, `${seen} rows`);
  });

  for (const t of [A, B]) {
    await owner`DELETE FROM sms_templates WHERE org_id = ${t.orgId}`;
    await owner`DELETE FROM sms_senders WHERE org_id = ${t.orgId}`;
  }
}

console.log("");
console.log("each developer's own calling number (0072): isolation");
{
  const cnOf = {};
  const stamp = String(Date.now()).slice(-7);
  for (const [i, t] of [A, B].entries()) {
    const number = `+9122${i}${stamp}`;
    const [row] = await owner`
      INSERT INTO calling_numbers (org_id, number, scope_node_id, active, monthly_cost_paise, monthly_price_paise)
      VALUES (${t.orgId}, ${number}, ${t.nodeId}, true, 60000, 99900) RETURNING id`;
    cnOf[t.orgId] = { id: row.id, number };
  }
  const cb = cnOf[B.orgId];
  await asTenant(A.orgId, async (tx) => {
    const rows = await tx`SELECT org_id FROM calling_numbers`;
    check("calling_numbers shows only tenant A", rows.length >= 1 && rows.every((r) => r.org_id === A.orgId), `${rows.length} rows`);
    const direct = await tx`SELECT id FROM calling_numbers WHERE id = ${cb.id}`;
    check("tenant B's calling number is invisible even by explicit id", direct.length === 0);
    const moved = await tx`UPDATE calling_numbers SET active = false, scope_node_id = NULL WHERE org_id = ${B.orgId}`;
    check("cannot take tenant B's number off its places", moved.count === 0, `${moved.count} rows affected`);
    const released = await tx`UPDATE calling_numbers SET active = false, scope_node_id = NULL, released_at = now() WHERE id = ${cb.id}`;
    check("cannot release tenant B's number", released.count === 0, `${released.count} rows affected`);
  });

  for (const [name, attempt, code] of [
    ["cannot rent a number inside tenant B", (tx) => tx`
      INSERT INTO calling_numbers (org_id, number, monthly_cost_paise, monthly_price_paise) VALUES (${B.orgId}, '+912299999999', 60000, 99900)`, "42501"],
    ["a calling number is never deleted by the app", (tx) => tx`DELETE FROM calling_numbers WHERE org_id = ${A.orgId}`, "42501"],
    ["tenant A cannot rent the number tenant B holds", (tx) => tx`
      INSERT INTO calling_numbers (org_id, number, monthly_cost_paise, monthly_price_paise) VALUES (${A.orgId}, ${cb.number}, 60000, 99900)`, "23505"],
    ["tenant A cannot place its number at tenant B's node", (tx) => tx`
      UPDATE calling_numbers SET scope_node_id = ${B.nodeId} WHERE org_id = ${A.orgId}`, "23514"],
    ["a rented number's price is fixed", (tx) => tx`
      UPDATE calling_numbers SET monthly_price_paise = 0 WHERE org_id = ${A.orgId}`, "23514"],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, e.code === code, e.code);
    }
  }

  // An agent's voice on tenant B's project is B's alone (0094).
  await owner`INSERT INTO agent_voices (org_id, project_id, job, voice) VALUES (${B.orgId}, ${bb.project}, 'QUALIFIER', 'priya')`;
  await asTenant(A.orgId, async (tx) => {
    const seen = await tx`SELECT 1 FROM agent_voices WHERE org_id = ${B.orgId}`;
    check("tenant B's agent voices are invisible to tenant A", seen.length === 0, `${seen.length} rows`);
    const moved = await tx`UPDATE agent_voices SET voice = 'advait' WHERE org_id = ${B.orgId}`;
    check("cannot change tenant B's agent voice", moved.count === 0, `${moved.count} rows affected`);
  });
  for (const [name, attempt, code] of [
    ["cannot pick a voice inside tenant B", (tx) => tx`
      INSERT INTO agent_voices (org_id, project_id, job, voice) VALUES (${B.orgId}, ${bb.project}, 'CONFIRMER', 'priya')`, ["42501", "P0001"]],
    ["cannot pick a voice for tenant B's project", (tx) => tx`
      INSERT INTO agent_voices (org_id, project_id, job, voice) VALUES (${A.orgId}, ${bb.project}, 'CONFIRMER', 'priya')`, ["23514", "P0001", "23503"]],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, [code].flat().includes(e.code), e.code);
    }
  }

  // A buyer's call in to tenant B's number is B's alone (0076).
  const ca = cnOf[A.orgId];
  const [inB] = await owner`
    INSERT INTO inbound_calls (org_id, calling_number_id, from_number, vobiz_call_uuid, status, in_hours)
    VALUES (${B.orgId}, ${cb.id}, '+919000000777', 'rls-inbound-b', 'MISSED', true) RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = await tx`SELECT id FROM inbound_calls WHERE id = ${inB.id}`;
    check("tenant B's call in is invisible to tenant A", seen.length === 0, `${seen.length} rows`);
    const moved = await tx`UPDATE inbound_calls SET note = 'x' WHERE id = ${inB.id}`;
    check("cannot touch tenant B's call in", moved.count === 0, `${moved.count} rows affected`);
  });
  for (const [name, attempt, code] of [
    ["cannot write a call in inside tenant B", (tx) => tx`
      INSERT INTO inbound_calls (org_id, calling_number_id, vobiz_call_uuid, in_hours) VALUES (${B.orgId}, ${cb.id}, 'rls-x', true)`, ["42501", "23514"]],
    ["cannot file a call in on tenant B's number", (tx) => tx`
      INSERT INTO inbound_calls (org_id, calling_number_id, vobiz_call_uuid, in_hours) VALUES (${A.orgId}, ${cb.id}, 'rls-y', true)`, "23514"],
    ["a call in is never deleted by the app", (tx) => tx`DELETE FROM inbound_calls WHERE org_id = ${A.orgId}`, "42501"],
    ["a call in's caller is never rewritten", (tx) => tx`UPDATE inbound_calls SET from_number = '+919000000778' WHERE org_id = ${A.orgId}`, ["42501", "23514"]],
  ]) {
    try {
      await asTenant(A.orgId, async (tx) => {
        // Tenant A's own row, for the attempts that need one to touch.
        await tx`INSERT INTO inbound_calls (org_id, calling_number_id, vobiz_call_uuid, in_hours) VALUES (${A.orgId}, ${ca.id}, ${`rls-a-${name.length}`}, true)`;
        await attempt(tx);
      });
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, [code].flat().includes(e.code), e.code);
    }
  }
  await app.begin(async (tx) => {
    const seen = await tx`SELECT id FROM inbound_calls`;
    check("inbound_calls is empty when app.org_id is unset", seen.length === 0, `${seen.length} rows`);
  });
  await owner`DELETE FROM inbound_calls WHERE org_id IN (${A.orgId}, ${B.orgId})`;

  // The inbound lookup: ids only, one tenant per number, nothing for junk.
  await app.begin(async (tx) => {
    const [n] = await tx`SELECT * FROM calling_number_owner(${cb.number})`;
    check("the number lookup names tenant B and returns ids only",
      n?.org_id === B.orgId && Object.keys(n).sort().join(",") === "number_id,org_id", JSON.stringify(n));
    const odd = await tx`SELECT * FROM calling_number_owner(${"1' OR '1'='1"})`;
    check("a lookup with something that is not a number returns nothing", odd.length === 0);
    const seen = await tx`SELECT id FROM calling_numbers`;
    check("calling_numbers is empty when app.org_id is unset", seen.length === 0, `${seen.length} rows`);
  });

  // A released number is free for anybody again, and its row stays.
  await owner`UPDATE calling_numbers SET active = false, scope_node_id = NULL, released_at = now() WHERE id = ${cb.id}`;
  await app.begin(async (tx) => {
    const gone = await tx`SELECT * FROM calling_number_owner(${cb.number})`;
    check("a released number names no tenant", gone.length === 0);
  });
  try {
    await owner`UPDATE calling_numbers SET released_at = NULL WHERE id = ${cb.id}`;
    check("a released number stays released", false, "update succeeded");
  } catch (e) {
    check("a released number stays released", e.code === "23514", e.code);
  }

  for (const t of [A, B]) await owner`DELETE FROM calling_numbers WHERE org_id = ${t.orgId}`;
}

// ---------------------------------------------------------------------------
// A portal account we ask for its leads (0095): one tenant's, its key sealed
// ---------------------------------------------------------------------------
{
  const [pB] = await owner`
    INSERT INTO portal_accounts (org_id, portal, account_id, secret, key_version)
    VALUES (${B.orgId}, 'HOUSING', 'rls-b-4544', '\\x01'::bytea, 1) RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = await tx`SELECT id FROM portal_accounts WHERE id = ${pB.id}`;
    check("tenant B's portal account is invisible to tenant A", seen.length === 0, `${seen.length} rows`);
    const moved = await tx`UPDATE portal_accounts SET status = 'BROKEN' WHERE id = ${pB.id}`;
    check("cannot touch tenant B's portal account", moved.count === 0, `${moved.count} rows affected`);
    const [t] = await tx`SELECT portal_account_taken('HOUSING', 'rls-b-4544') AS taken`;
    check("tenant A learns only that the account is taken", t.taken === true);
  });
  for (const [name, attempt, code] of [
    ["cannot add a portal account inside tenant B", (tx) => tx`
      INSERT INTO portal_accounts (org_id, portal, account_id, secret, key_version) VALUES (${B.orgId}, 'HOUSING', 'rls-x', '\\x01'::bytea, 1)`, "42501"],
    ["cannot take an account tenant B holds", (tx) => tx`
      INSERT INTO portal_accounts (org_id, portal, account_id, secret, key_version) VALUES (${A.orgId}, 'HOUSING', 'rls-b-4544', '\\x01'::bytea, 1)`, "23505"],
    ["a portal account is never deleted by the app", (tx) => tx`DELETE FROM portal_accounts WHERE org_id = ${A.orgId}`, "42501"],
    ["a removed account keeps no key", (tx) => tx`
      INSERT INTO portal_accounts (org_id, portal, account_id, secret, key_version, status) VALUES (${A.orgId}, 'HOUSING', 'rls-a-1', '\\x01'::bytea, 1, 'REMOVED')`, "23514"],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, [code].flat().includes(e.code), e.code);
    }
  }
  await app.begin(async (tx) => {
    const seen = await tx`SELECT id FROM portal_accounts`;
    check("portal_accounts is empty when app.org_id is unset", seen.length === 0, `${seen.length} rows`);
  });
  await owner`DELETE FROM portal_accounts WHERE org_id IN (${A.orgId}, ${B.orgId})`;
}

// 0115: call lists.
{
  const towerFor = async (t, slug) => {
    const [root] = await owner`SELECT path::text AS path FROM scope_nodes WHERE id = ${t.nodeId}`;
    const [n] = await owner`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${t.orgId}, ${t.nodeId}, 'PHASE', ${`RLS list ${slug}`}, ${slug}, ${`${root.path}.${slug}`}::ltree) RETURNING id`;
    return n.id;
  };
  const towerA = await towerFor(A, "rls_list_a");
  const towerB = await towerFor(B, "rls_list_b");
  const [listB] = await owner`
    INSERT INTO call_lists (org_id, scope_node_id, file_name) VALUES (${B.orgId}, ${towerB}, 'b.csv') RETURNING id`;
  const [rowB] = await owner`
    INSERT INTO call_list_rows (org_id, list_id, line, name, phone) VALUES (${B.orgId}, ${listB.id}, 2, 'B buyer', '+919123400199') RETURNING id`;
  await asTenant(A.orgId, async (tx) => {
    const seen = (await tx`SELECT id FROM call_lists WHERE id = ${listB.id}`).length + (await tx`SELECT id FROM call_list_rows WHERE id = ${rowB.id}`).length;
    check("tenant B's call lists and their people are invisible to A", seen === 0, `${seen} rows`);
    const res = await tx`UPDATE call_list_rows SET state = 'SKIPPED' WHERE id = ${rowB.id}`;
    check("and A cannot change one", res.count === 0, `${res.count} rows`);
  });
  for (const [name, attempt] of [
    ["a list is never about another tenant's tower", (tx) => tx`INSERT INTO call_lists (org_id, scope_node_id, file_name) VALUES (${A.orgId}, ${towerB}, 'a.csv')`],
    ["a row never joins another tenant's list", (tx) => tx`INSERT INTO call_list_rows (org_id, list_id, line) VALUES (${A.orgId}, ${listB.id}, 3)`],
  ]) {
    try {
      await asTenant(A.orgId, attempt);
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, ["23514", "42501"].includes(e.code), e.code);
    }
  }
  try {
    await asTenant(A.orgId, (tx) => tx`INSERT INTO call_lists (org_id, scope_node_id, file_name, state) VALUES (${A.orgId}, ${towerA}, 'a.csv', 'RUNNING')`);
    check("a list never runs without being started and its consent recorded", false, "it succeeded");
  } catch (e) {
    check("a list never runs without being started and its consent recorded", e.code === "23514", e.code);
  }
  await app.begin(async (tx) => {
    const seen = await tx`SELECT id FROM call_lists`;
    check("call_lists is empty when app.org_id is unset", seen.length === 0, `${seen.length} rows`);
  });
  await owner`DELETE FROM call_lists WHERE org_id IN (${A.orgId}, ${B.orgId})`;
  await owner`DELETE FROM scope_nodes WHERE id IN (${towerA}, ${towerB})`;
}

await owner`DELETE FROM audit_log WHERE action LIKE 'test.%'`;

// audit_log deliberately has no FK to orgs -- an audit row must outlive the
// tenant it describes. That means this suite has to clear its own rows, or
// every run leaves two orphans behind in a real database.
await owner`DELETE FROM audit_log WHERE org_id IN (${A.orgId}, ${B.orgId})`;
await owner`DELETE FROM orgs WHERE id IN (${A.orgId}, ${B.orgId})`;
await owner`DELETE FROM users WHERE id IN (${A.userId}, ${B.userId})`;

console.log(`\n${pass} passed, ${fail} failed\n`);
await owner.end();
await app.end();
await retention.end();
process.exitCode = fail === 0 ? 0 : 1;
