// A development tenant (BillBay, selling Sath Heights) on an empty database, built through the same functions
// sign-up and the console use: the first user, a developer organisation, its
// SPV, a project in Mumbai and one tower. The browser suites and the ones that
// read "the first user's organisation" need it; a fresh machine and CI have
// none. Refuses to run where any user already exists, so it never touches a
// database somebody is using.
//
//   node --experimental-strip-types --env-file=.env.local scripts/seed-dev-tenant.mts
import { controlDb, closeDb } from "../src/lib/db/index.ts";
import { createDeveloperOrg } from "../src/lib/onboarding.ts";
import { createEntity } from "../src/lib/entity.ts";
import { createProject } from "../src/lib/project.ts";
import { createPhase } from "../src/lib/rera.ts";

const [{ n }] = await controlDb<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
if (n > 0) {
  console.log(`  ${n} user(s) already here; nothing seeded`);
  await closeDb();
  process.exit(0);
}

const [user] = await controlDb<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name)
  VALUES ('admin@billbay.test', 'billbay.test', 'Dev Admin')
  RETURNING id`;

const org = await createDeveloperOrg({
  userId: user.id,
  legalName: "BillBay Estates Private Limited",
  displayName: "BillBay",
  gstin: null,
  pan: "AAHCB1234K",
  emailDomain: "billbay.test",
  idpTenant: "",
});
if (!org.ok) throw new Error(`org: ${org.error}`);

const entity = await createEntity({
  orgId: org.orgId,
  actorUserId: user.id,
  legalName: "BillBay Co-operation Private Limited",
  pan: "AAKCB5678L",
  registrationNo: "",
  registeredAddress: "12 Link Road, Goregaon West, Mumbai 400104",
});
if (!entity.ok) throw new Error(`entity: ${entity.message}`);
const entityId = entity.id;

const project = await createProject({ orgId: org.orgId, actorUserId: user.id, entityId, city: "Mumbai", name: "Sath Heights" });
if (!project.ok) throw new Error(`project: ${project.message}`);
const projectId = project.id;

const phase = await createPhase({ orgId: org.orgId, actorUserId: user.id, projectId, name: "Tower C" });
if (!phase.ok) throw new Error(`phase: ${phase.message}`);

console.log(`  seeded BillBay (${org.orgId}) with admin@billbay.test, one SPV, one project, Tower C`);
await closeDb();
