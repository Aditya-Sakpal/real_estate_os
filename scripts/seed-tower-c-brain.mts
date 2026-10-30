/**
 * Publish a minimal Brain for Sath Heights / Tower C so Studio can write.
 *
 *   node --import ./scripts/lib/next-resolve.mjs --experimental-strip-types --env-file=.env.local scripts/seed-tower-c-brain.mts
 *
 * Idempotent: skips a node that already has a published Brain with talking points.
 */
import postgres from "postgres";
import { closeDb } from "../src/lib/db/index.ts";
import { loadBrain, publishBrain, resolveBrain, saveGroup, signGroup } from "../src/lib/brain.ts";
import { asList, groupHash, type FieldGroup, type FieldValues } from "../src/lib/brain-rules.ts";

const PROJECT = "Sath Heights";
const PHASE = "Tower C";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

const [phase] = await sql<
  { id: string; org_id: string; project_id: string; registration_no: string | null }[]
>`
  SELECT ph.id, ph.org_id, p.id AS project_id, r.registration_no
  FROM scope_nodes ph
  JOIN scope_nodes p ON p.id = ph.parent_id
  LEFT JOIN registration_records r ON r.scope_node_id = ph.id
  WHERE ph.kind = 'PHASE' AND ph.name = ${PHASE} AND p.name = ${PROJECT}
  LIMIT 1`;
if (!phase) throw new Error(`No ${PHASE} under ${PROJECT}`);
if (!phase.registration_no) {
  throw new Error("Tower C has no registration number. Run npm run seed:tower-c first.");
}

const [admin] = await sql<{ id: string }[]>`
  SELECT u.id FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.org_id = ${phase.org_id}
    AND m.role = 'ORG_ADMIN' AND m.status = 'ACTIVE'
  ORDER BY u.created_at LIMIT 1`;
if (!admin) throw new Error("No ORG_ADMIN for BillBay");

const orgId = phase.org_id;
const actorUserId = admin.id;

async function signAndPublish(nodeId: string, label: string, groups: FieldGroup[]) {
  const view = await loadBrain(orgId, nodeId);
  if (!view?.draft) throw new Error(`${label}: no draft after save`);
  const values = view.draft.values as FieldValues;
  for (const group of groups) {
    const hash = groupHash(group, values);
    const signed = await signGroup({ orgId, actorUserId, nodeId, group, expectedHash: hash });
    if (!signed.ok) throw new Error(`${label} sign ${group}: ${signed.message}`);
    console.log(`  signed  ${label} ${group}`);
  }
  const published = await publishBrain({ orgId, actorUserId, nodeId });
  if (!published.ok) throw new Error(`${label} publish: ${published.message}`);
  console.log(`  published  ${label} v${published.version}`);
}

console.log(`\nBrain for ${PROJECT} / ${PHASE}`);

const projectBrain = await loadBrain(orgId, phase.project_id);
const projectHasPoints = asList(projectBrain?.published?.values["claims.talking_points"]).length > 0;

if (projectHasPoints) {
  console.log(`  skip  ${PROJECT} already published with talking points`);
} else {
  const price = await saveGroup({
    orgId,
    actorUserId,
    nodeId: phase.project_id,
    group: "PRICE",
    input: {
      "price.base_psf": "18500",
      "price.booking_amount": "500000",
      "price.payment_plan": "10 percent on booking, the rest construction linked",
      "price.loan_rate": "8.5",
    },
  });
  if (!price.ok) throw new Error(`project PRICE: ${price.message}`);

  const claims = await saveGroup({
    orgId,
    actorUserId,
    nodeId: phase.project_id,
    group: "CLAIMS",
    input: {
      "claims.location": "Goregaon East",
      "claims.possession_date": "2029-06-30",
      "claims.talking_points":
        "Eight minutes from Goregaon station\nSea facing from the 18th floor up\nA podium garden on twelve acres",
      "claims.never_say": "guaranteed returns\nassured rental",
    },
  });
  if (!claims.ok) throw new Error(`project CLAIMS: ${claims.message}`);

  await signAndPublish(phase.project_id, PROJECT, ["PRICE", "CLAIMS"]);
}

const phaseBrain = await loadBrain(orgId, phase.id);
const phaseLive = !!phaseBrain?.published;

if (phaseLive) {
  console.log(`  skip  ${PHASE} already published`);
} else {
  // Completion on or before marketed possession (2029-06-30 on the project).
  const rera = await saveGroup({
    orgId,
    actorUserId,
    nodeId: phase.id,
    group: "RERA",
    input: {
      "rera.registration_no": phase.registration_no,
      "rera.declared_completion": "2028-12-31",
      "rera.qr_url": "https://maharera.maharashtra.gov.in/",
    },
  });
  if (!rera.ok) throw new Error(`phase RERA: ${rera.message}`);

  const phasePrice = await saveGroup({
    orgId,
    actorUserId,
    nodeId: phase.id,
    group: "PRICE",
    input: {
      "price.base_psf": "",
      "price.booking_amount": "",
      "price.payment_plan": "",
      "price.loan_rate": "",
    },
  });
  if (!phasePrice.ok) throw new Error(`phase PRICE: ${phasePrice.message}`);

  const phaseClaims = await saveGroup({
    orgId,
    actorUserId,
    nodeId: phase.id,
    group: "CLAIMS",
    input: {
      "claims.location": "",
      "claims.possession_date": "",
      "claims.talking_points": "",
      "claims.never_say": "",
    },
  });
  if (!phaseClaims.ok) throw new Error(`phase CLAIMS: ${phaseClaims.message}`);

  await signAndPublish(phase.id, PHASE, ["PRICE", "RERA", "CLAIMS"]);
}

const resolved = await resolveBrain(orgId, phase.id);
const points = asList(resolved?.values["claims.talking_points"]);
const location = resolved?.values["claims.location"] ?? null;
console.log(`\n  resolveBrain talking points: ${points.length}`);
console.log(`  resolveBrain location: ${location ?? "MISSING"}`);
console.log("Done.\n");

await sql.end();
await closeDb();
