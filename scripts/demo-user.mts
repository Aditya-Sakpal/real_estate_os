// The demo front's user (`src/lib/demo-front.ts`): a user who is admin of ONE
// organisation and member of nothing else, so the public demo can never
// switch into a real client's console. Safe to run again.
//
//   node --experimental-strip-types --env-file=.env.local scripts/demo-user.mts \
//     --org <org id> [--email demo@billbay.co] [--name "Demo Admin"] [--role ORG_ADMIN]
import { controlDb, closeDb } from "../src/lib/db/index.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

const orgId = arg("org");
const email = arg("email", "demo@billbay.co").toLowerCase();
const name = arg("name", "Demo Admin");
const role = arg("role", "ORG_ADMIN");
const domain = email.split("@")[1];

const [org] = await controlDb<{ id: string; display_name: string }[]>`SELECT id, display_name FROM orgs WHERE id = ${orgId}`;
if (!org) throw new Error("no such organisation");
const [root] = await controlDb<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`;
if (!root) throw new Error("the organisation has no root node");

const [user] = await controlDb<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${email}, ${domain}, ${name})
  ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
  RETURNING id`;

const others = await controlDb<{ org_id: string }[]>`
  SELECT org_id FROM memberships WHERE user_id = ${user.id} AND status = 'ACTIVE' AND org_id <> ${orgId}`;
if (others.length) throw new Error(`${email} is active in ${others.length} other organisation(s); use another address`);

const [have] = await controlDb<{ id: string }[]>`
  SELECT id FROM memberships WHERE user_id = ${user.id} AND org_id = ${orgId} AND scope_node_id = ${root.id} AND role = ${role} AND status = 'ACTIVE'`;
if (!have) {
  await controlDb`
    INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
    VALUES (${user.id}, ${orgId}, ${root.id}, ${role}, 'ACTIVE', now())`;
}
console.log(`  ${email} is ${role} of ${org.display_name}, and nothing else`);
await closeDb();
