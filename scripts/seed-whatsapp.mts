// Connect the development WhatsApp account to the development tenant.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/seed-whatsapp.mts
//
// A developer connects their number through Meta's Embedded Signup pop-up,
// which needs our app through App Review first. Until then this puts the
// test account named in `.env.local` (WHATSAPP_TOKEN, a system user token
// that reaches it) on the Sath Heights tenant through the same code the
// pop-up's finish runs, so the dev server sends the way a client's would.
//
// It reads and subscribes, and nothing else: it never registers the number,
// never asks Meta to sync an app, and never creates a template. What Meta
// has already approved on the account is read and recorded.
//
// Development only. It refuses to run on Vercel or in production.
import postgres from "postgres";

if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("seed:whatsapp is a development seed.");
const token = (process.env.WHATSAPP_TOKEN ?? "").trim();
if (!token) throw new Error("WHATSAPP_TOKEN is not set in .env.local.");

const { connectToken } = await import("../src/lib/wa-numbers.ts");
const { closeDb } = await import("../src/lib/db/index.ts");

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const [tower] = await sql<{ org_id: string }[]>`
  SELECT n.org_id FROM scope_nodes n JOIN scope_nodes p ON p.id = n.parent_id
  JOIN orgs o ON o.id = n.org_id
  WHERE n.kind = 'PHASE' AND n.name = 'Tower C' AND p.name = 'Sath Heights'
  -- The first tenant made is the one being worked in (BillBay); the checks' later
  -- fixtures carry the same names.
  ORDER BY o.created_at LIMIT 1`;
if (!tower) throw new Error("No Sath Heights · Tower C in this database.");
const [admin] = await sql<{ user_id: string }[]>`
  SELECT user_id FROM memberships WHERE org_id = ${tower.org_id} AND role = 'ORG_ADMIN' AND status = 'ACTIVE' LIMIT 1`;
await sql.end();

const r = await connectToken({ orgId: tower.org_id, userId: admin.user_id, token, hint: null, submit: false });
console.log(r.ok ? `  ${r.message}` : `  Not connected: ${r.message}`);
await closeDb();
process.exitCode = r.ok ? 0 : 1;
