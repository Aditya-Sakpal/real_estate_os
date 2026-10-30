/**
 * A channel partner with something to show, on the development tenant.
 *
 * BillBay empanels Skyline Realty (PAN AAQFS4821K) on Sath Heights, and the
 * firm has four buyers: one whose registration ends in four days, one with a
 * visit booked, one who visited, and one who booked and whose first half of
 * commission is owed. Signing up as a channel partner with that PAN and the
 * principal's number, 98200 45127, claims the firm and opens its workspace
 * on all of it.
 *
 * Written through the product's own functions, so the trail is the one a
 * person would leave. No message is sent and no call is placed: the visits
 * are written as rows and the leads carry the agent switched off.
 *
 *   npm run seed:partner-demo              # add it
 *   npm run seed:partner-demo -- --remove  # take it out again
 */
import postgres from "postgres";
import { closeDb } from "../src/lib/db/index.ts";
import { creditVisit, empanelFirm, leadForClaim, makeLink, onBooked, recordBookingDates, registerBuyer } from "../src/lib/partners.ts";
import { istDay } from "../src/lib/partner-rules.ts";
import { istAt } from "../src/lib/cadence-rules.ts";

const PAN = "AAQFS4821K";
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const remove = process.argv.includes("--remove");

const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const ahead = (d: number) => istDay(new Date(Date.now() + d * 86_400_000).toISOString());

try {
  const [dev] = await sql<{ id: string }[]>`
    SELECT id FROM orgs WHERE display_name = 'BillBay' AND type = 'DEVELOPER' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`;
  if (!dev) throw new Error("No BillBay tenant here.");
  const [cp] = await sql<{ id: string; status: string }[]>`SELECT id, status FROM orgs WHERE pan = ${PAN} AND type = 'CHANNEL_PARTNER'`;

  if (remove) {
    if (!cp) {
      console.log("Nothing to remove.");
    } else {
      const leads = (await sql<{ lead_id: string }[]>`
        SELECT lead_id FROM client_registrations WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id} AND lead_id IS NOT NULL`).map((r) => r.lead_id);
      await sql`DELETE FROM partner_invoices WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id}`;
      await sql`ALTER TABLE payout_milestones DISABLE TRIGGER payout_milestones_forward_only`;
      await sql`DELETE FROM payout_milestones WHERE org_id = ${dev.id} AND payout_id IN (SELECT id FROM partner_payouts WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id})`;
      await sql`ALTER TABLE payout_milestones ENABLE TRIGGER payout_milestones_forward_only`;
      await sql`DELETE FROM partner_payouts WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id}`;
      await sql`DELETE FROM partner_links WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id}`;
      await sql`UPDATE client_registrations SET extended_by_visit = NULL WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id}`;
      if (leads.length) {
        await sql`DELETE FROM lead_tasks WHERE org_id = ${dev.id} AND lead_id = ANY(${leads})`;
        await sql`DELETE FROM lead_activity WHERE org_id = ${dev.id} AND lead_id = ANY(${leads})`;
        await sql`DELETE FROM site_visits WHERE org_id = ${dev.id} AND lead_id = ANY(${leads})`;
      }
      await sql`DELETE FROM client_registrations WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id}`;
      if (leads.length) await sql`DELETE FROM leads WHERE org_id = ${dev.id} AND id = ANY(${leads})`;
      await sql`DELETE FROM grants WHERE org_id = ${dev.id} AND grantee_org_id = ${cp.id}`;
      await sql`DELETE FROM partner_agents WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id}`;
      await sql`DELETE FROM partner_firms WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id}`;
      // The firm itself goes only while nobody has claimed it.
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM memberships WHERE org_id = ${cp.id}`;
      if (cp.status === "PENDING_VERIFICATION" && n === 0) await sql`DELETE FROM orgs WHERE id = ${cp.id}`;
      console.log(`Removed Skyline Realty from BillBay${cp.status === "PENDING_VERIFICATION" && n === 0 ? ", and the unclaimed firm" : ""}.`);
    }
  } else {
    if (cp && (await sql`SELECT 1 FROM partner_firms WHERE org_id = ${dev.id} AND cp_org_id = ${cp.id}`).length) {
      console.log("Skyline Realty is already on BillBay's desk. Run with --remove first to start again.");
    } else {
      const [admin] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM memberships WHERE org_id = ${dev.id} AND role = 'ORG_ADMIN' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`;
      const [rm] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM memberships WHERE org_id = ${dev.id} AND role = 'SALES_HEAD' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`;
      const [place] = await sql<{ project: string; tower: string }[]>`
        SELECT p.id AS project, t.id AS tower FROM scope_nodes p JOIN scope_nodes t ON t.org_id = p.org_id AND t.kind = 'PHASE' AND t.path <@ p.path
        WHERE p.org_id = ${dev.id} AND p.kind = 'PROJECT' AND p.name = 'Sath Heights' AND t.name = 'Tower C'`;
      if (!admin || !place) throw new Error("BillBay needs an admin and Sath Heights, Tower C.");
      const userId = admin.user_id;

      const empanelled = await empanelFirm({
        orgId: dev.id,
        userId,
        firm: {
          name: "Skyline Realty",
          legalName: "Skyline Realty LLP",
          pan: PAN,
          gstin: "27AAQFS4821K1ZO",
          reraNo: "A51900012873",
          reraTill: "2027-12-31",
          competencyTill: null,
          principalName: "Aditya Sakpal",
          principalPhone: "+919820045127",
          area: "Pune",
        },
        rmId: rm?.user_id ?? null,
        projectIds: [place.project],
        validTo: "2027-03-31",
        nowIso: ago(40),
      });
      if (!empanelled.ok) throw new Error(empanelled.message);
      const firmId = empanelled.firmId;

      const buyer = async (name: string, phone: string, daysAgo: number, via: "WHATSAPP" | "WORKSPACE") => {
        const r = await registerBuyer({ orgId: dev.id, userId: null, firmId, projectId: place.project, phone, buyerName: name, agentName: "Aditya Sakpal", via, nowIso: ago(daysAgo) });
        if (!r.ok || r.verdict !== "REGISTERED") throw new Error(`${name}: ${r.message}`);
        return r.id;
      };
      const lead = async (registrationId: string, stage: string, facts: Record<string, string>) => {
        const l = await leadForClaim({ orgId: dev.id, userId, registrationId, phaseId: place.tower });
        if (!l.ok) throw new Error(l.message);
        await sql`
          UPDATE leads SET stage = ${stage}, path_stage = ${stage}, facts = ${sql.json(facts)}, automation = 'PAUSED'
          WHERE id = ${l.leadId}`;
        return l.leadId;
      };

      // Ends in four days, and nobody has visited.
      await buyer("Neha Joshi", "+917020045101", 26, "WHATSAPP");

      // A visit booked for the day after tomorrow.
      const rohit = await buyer("Rohit Patil", "+917020045102", 3, "WORKSPACE");
      const visitDay = ahead(2);
      const rohitLead = await lead(rohit, "visit_scheduled", { visitDate: visitDay, visitTime: "16:30" });
      await sql`
        INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, status, booked_via, created_by)
        VALUES (${dev.id}, ${rohitLead}, ${place.tower}, ${new Date(istAt(visitDay, "16:30"))}, 'CONFIRMED', 'CONSOLE', ${userId})`;

      // Visited six days ago, which carries the claim thirty days past it.
      const kavita = await buyer("Kavita Deshpande", "+917020045103", 18, "WHATSAPP");
      const kavitaLead = await lead(kavita, "visit_done", {});
      const [visited] = await sql<{ id: string }[]>`
        INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, status, booked_via, arrived_at, completed_at, outcome, created_by)
        VALUES (${dev.id}, ${kavitaLead}, ${place.tower}, ${new Date(ago(6))}, 'VISITED', 'CONSOLE', ${new Date(ago(6))}, ${new Date(ago(6))},
                ${sql.json({ interest: "High", objection: "Price", next: "Revisit with family" })}, ${userId})
        RETURNING id`;
      await creditVisit(dev.id, visited.id);

      // Booked ten days ago; the agreement was registered four days ago, so the first half is owed.
      const amit = await buyer("Amit Kulkarni", "+917020045104", 25, "WORKSPACE");
      const amitLead = await lead(amit, "booked", { unit: "C-1204", agreement: "12500000", bookedOn: istDay(ago(10)), token: "200000" });
      const paid = await onBooked({ orgId: dev.id, userId, leadId: amitLead, nowIso: ago(10) });
      if (!paid) throw new Error("The booking wrote no payout.");
      const dates = await recordBookingDates({ orgId: dev.id, userId, payoutId: paid.payoutId, agreementRegisteredOn: istDay(ago(4)), collectedOn: null, today: istDay(new Date().toISOString()) });
      if (!dates.ok) throw new Error(dates.message);

      const link = await makeLink({ orgId: dev.id, userId, firmId, phaseId: place.tower, agentName: null });
      console.log(`Skyline Realty is on BillBay's desk on Sath Heights, with four buyers, a booking and link ${link.ok ? link.code : "(none)"}.`);
    }
  }
} finally {
  await sql.end();
  await closeDb();
}
