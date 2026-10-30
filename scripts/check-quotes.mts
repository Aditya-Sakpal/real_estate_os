/**
 * `npm run check:quotes`: a buyer's quote, the flat it blocks and the token
 * link, end to end against a fake Razorpay. Nothing leaves the machine.
 *
 * It builds a tenant of its own (Mumbai, one registered tower, one approved
 * 2 BHK, three flats in the availability sheet) and deletes only that.
 */
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { useVaultKey } from "../src/lib/vault.ts";
import { usePayments, savePaymentAccount, ownerOfAccount, type GatewayLink, type GatewayRefund, type LinkRequest, type RefundRequest } from "../src/lib/payments.ts";
import {
  approveQuote, cancelToken, convertBlocks, draftQuote, listQuotes, onLinkEvent, quoteChoices, quotePdf, recordOfflineToken, recordRefundPaid,
  sendQuote, sweepQuotes,
} from "../src/lib/quotes.ts";
import { refundReceipt } from "../src/lib/quote-rules.ts";
import { availability, listUnits } from "../src/lib/inventory.ts";
import { addUnitType, approveUnitType } from "../src/lib/unit.ts";
import { approveShown, loadReview } from "../src/lib/review.ts";
import { buildAuthz } from "../src/lib/rbac-rules.ts";
import { linkReference } from "../src/lib/quote-rules.ts";
import { closeDb, withTenant } from "../src/lib/db/index.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

useVaultKey(randomBytes(32));

// A Razorpay that keeps its links in memory, and can lose an answer or refuse.
const links = new Map<string, GatewayLink & { req: LinkRequest }>();
const cancelled: string[] = [];
let mode: "ok" | "lose" | "refuse" = "ok";
// Refunds by receipt, with the idempotency key each was asked under.
const refunds = new Map<string, GatewayRefund & { paymentId: string; key: string }>();
let refundCalls = 0;
let refundMode: "ok" | "lose" | "refuse" = "ok";
let cancelRefuses = false;
usePayments({
  async refund(_token, req: RefundRequest) {
    refundCalls += 1;
    if (refundMode === "refuse") throw new Error("Razorpay 400: The refund amount is invalid");
    const prior = refunds.get(req.receipt);
    if (prior) return prior;
    const r = { id: `rfnd_${Math.random().toString(36).slice(2, 12)}`, status: "pending", amountPaise: req.amountPaise, paymentId: req.paymentId, key: req.receipt };
    refunds.set(req.receipt, r);
    if (refundMode === "lose") throw new Error("socket hang up");
    return r;
  },
  async findRefund(_token, paymentId, receipt) {
    const r = refunds.get(receipt);
    return r && r.paymentId === paymentId ? r : null;
  },
  async createLink(_token, req) {
    if (mode === "refuse") throw new Error("Razorpay 400: refused");
    const l = { id: `plink_${Math.random().toString(36).slice(2, 12)}`, shortUrl: `https://rzp.io/rzp/${links.size + 1}`, status: "created", req };
    links.set(req.reference, l);
    if (mode === "lose") throw new Error("socket hang up");
    return l;
  },
  async findLink(_token, reference) {
    return links.get(reference) ?? null;
  },
  async cancelLink(_token, id) {
    if (cancelRefuses) throw new Error("Razorpay 500: try again");
    cancelled.push(id);
  },
  async exchange() {
    throw new Error("not used");
  },
  async refresh(r) {
    return { accessToken: "fresh", refreshToken: r, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), accountId: "acc_QUOTECHECK1", mode: "test" };
  },
});

const tag = Date.now().toString(36);
const domain = `quotes${tag}.example`;
const [admin] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`admin@${domain}`}, ${domain}, 'Quotes Admin') RETURNING id`;
const [org] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Quote Check Realty', 'Quote Check', 'AAQPQ1234C', ${domain}, ${admin.id}) RETURNING id`;
const orgId = org.id;
const [root] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${orgId}, NULL, 'ORG', 'Quote Check', ${`quotes_${tag}`}, ${`quotes_${tag}`}::ltree) RETURNING id, path::text AS path`;
const node = async (parent: { id: string; path: string }, kind: string, name: string, slug: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${orgId}, ${parent.id}, ${kind}, ${name}, ${slug}, ${`${parent.path}.${slug}`}::ltree) RETURNING id, path::text AS path`;
  return row;
};

try {
  const entity = await node(root, "ENTITY", "Quote Check LLP", "qc_llp");
  const region = await node(entity, "REGION", "Mumbai", "mumbai");
  const project = await node(region, "PROJECT", "Harbour View", "harbour_view");
  const tower = await node(project, "PHASE", "Tower A", "tower_a");
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${orgId}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
  const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  await sql`
    INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, promoter_name, valid_to, verified_at)
    VALUES (${tower.id}, ${orgId}, 'VERIFIED', 'P51800012345', 'MH', 'Quote Check LLP', ${FAR}, now())`;
  const [bv] = await sql<{ id: string }[]>`
    INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by) VALUES (${orgId}, ${tower.id}, 1, 'DRAFT', ${admin.id}) RETURNING id`;
  await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value) VALUES (${orgId}, ${bv.id}, 'price.booking_amount', '100000')`;
  await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${bv.id}`;
  const unit = await addUnitType({ orgId, actorUserId: admin.id, nodeId: tower.id, config: "2BHK", variant: null, carpetAreaSqft: 682, balconyAreaSqft: null, startingPrice: 9_537_500 });
  const unitId = unit.ok ? unit.unitTypeId : "";
  {
    console.log("\nReview and approve, on one project");
    const as = (perms: string[]) =>
      buildAuthz([{ role: "R", roleLabel: "R", scopeNodeId: root.id, scopePath: root.path, scopeKind: "ORG", scopeName: "", permissions: new Set(perms) }]);
    const pricer = as(["brain:read", "brain.price:approve"]);
    const looker = as(["brain:read"]);
    const seen = await loadReview(orgId, project.id, pricer);
    check("a flat type waiting is listed for whoever approves prices", seen?.flats.length === 1 && seen.flats[0].id === unitId, JSON.stringify(seen?.flats));
    check("and for nobody else", (await loadReview(orgId, project.id, looker))?.flats.length === 0);
    const refused = await approveShown({ orgId, userId: admin.id, projectId: project.id, authz: looker, kind: "FLATS", ids: [unitId] });
    check("a press by somebody who may not approve approves nothing", refused.done === 0, refused.message);
    const stray = await approveShown({ orgId, userId: admin.id, projectId: project.id, authz: pricer, kind: "FLATS", ids: ["00000000-0000-4000-8000-000000000000"] });
    check("an id the screen never listed does nothing", stray.done === 0, stray.message);
    const done = await approveShown({ orgId, userId: admin.id, projectId: project.id, authz: pricer, kind: "FLATS", ids: [unitId] });
    check("Approve all approves the flat type, through its own function", done.done === 1 && done.message === "1 flat type approved.", done.message);
    check("and it leaves the list", (await loadReview(orgId, project.id, pricer))?.flats.length === 0);
  }
  for (const [no, status] of [["C-803", "AVAILABLE"], ["C-804", "AVAILABLE"], ["C-805", "BOOKED"], ["C-806", "AVAILABLE"],
    ["C-807", "AVAILABLE"], ["C-808", "AVAILABLE"], ["C-809", "AVAILABLE"], ["C-810", "AVAILABLE"]] as const) {
    await sql`INSERT INTO units (org_id, scope_node_id, unit_type_id, unit_no, config, status, source) VALUES (${orgId}, ${tower.id}, ${unitId}, ${no}, '2 BHK', ${status}, 'IMPORT')`;
  }
  const newLead = async (name: string, phone: string) =>
    (await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, stage, path_stage)
      VALUES (${orgId}, ${tower.id}, ${name}, ${phone}, 'Website', 'WEBSITE', 'negotiation', 'negotiation') RETURNING id`)[0].id;
  const buyer = await newLead("Rohan Iyer", "+919000000801");
  const other = await newLead("Sana Shaikh", "+919000000802");

  const grant = (perms: string[]) =>
    buildAuthz([{ role: "R", roleLabel: "R", scopeNodeId: root.id, scopePath: root.path, scopeKind: "ORG", scopeName: "", permissions: new Set(perms) }]);
  const closer = grant(["lead:read", "quote:create", "quote:approve"]);
  const drafter = grant(["lead:read", "quote:create"]);
  const reader = grant(["lead:read"]);

  console.log("\nDrafting: every number from approved facts");
  const noFlat = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: buyer, unitTypeId: unitId, unitNo: "Z-999" });
  check("a flat not in the tower's availability is refused", !noFlat.ok && noFlat.message === "Flat Z-999 is not in this tower's availability.");
  const sold = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: buyer, unitTypeId: unitId, unitNo: "c-805" });
  check("a flat already booked is refused", !sold.ok && sold.message === "Flat C-805 is not available.");
  check("somebody who cannot quote cannot draft one", !(await draftQuote({ orgId, userId: admin.id, authz: reader, leadId: buyer, unitTypeId: unitId, unitNo: "C-803" })).ok);
  const d1 = await draftQuote({ orgId, userId: admin.id, authz: drafter, leadId: buyer, unitTypeId: unitId, unitNo: "C-803" });
  check("a quote is drafted for an available flat", d1.ok);
  const q1 = d1.ok ? d1.quoteId : "";
  const [n] = await listQuotes(orgId, buyer);
  check("Rs 95,37,500 in Mumbai: 5% GST, 6% duty, the Rs 30,000 cap, Rs 1,06,16,625 all in",
    n?.price === 9_537_500 && n.gst === 476_875 && n.stampDuty === 572_250 && n.registration === 30_000 && n.allIn === 10_616_625 && n.token === 100_000,
    JSON.stringify(n));
  let frozen = false;
  try {
    await withTenant(orgId, (tx) => tx`UPDATE quotes SET price = 1 WHERE id = ${q1}`);
  } catch (e) {
    frozen = (e as { code?: string }).code === "42501";
  }
  check("a quote's numbers are never rewritten by the app", frozen);

  console.log("\nApproving: a person, on the numbers as drafted");
  check("drafting is not approving", !(await approveQuote({ orgId, userId: admin.id, authz: drafter, quoteId: q1 })).ok);
  // The booking amount changes after the draft: the draft is stale.
  const [bv2] = await sql<{ id: string }[]>`
    INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by) VALUES (${orgId}, ${tower.id}, 2, 'DRAFT', ${admin.id}) RETURNING id`;
  await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value) VALUES (${orgId}, ${bv2.id}, 'price.booking_amount', '150000')`;
  await sql`UPDATE brain_versions SET state = 'SUPERSEDED' WHERE id = ${bv.id}`;
  await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${bv2.id}`;
  const stale = await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: q1 });
  check("a draft whose facts changed is drafted again, never approved", !stale.ok && stale.message.startsWith("The price, the taxes or the flat changed"));
  const d2 = await draftQuote({ orgId, userId: admin.id, authz: drafter, leadId: buyer, unitTypeId: unitId, unitNo: "C-803" });
  const q2 = d2.ok ? d2.quoteId : "";
  check("drafting again supersedes the stale one", (await sql`SELECT 1 FROM quotes WHERE id = ${q1} AND state = 'SUPERSEDED'`).length === 1);
  check("the new draft is approved", (await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: q2 })).ok);
  let backwards = false;
  try {
    await withTenant(orgId, (tx) => tx`UPDATE quotes SET state = 'DRAFT' WHERE id = ${q2}`);
  } catch (e) {
    backwards = (e as { code?: string }).code === "23514";
  }
  check("a quote moves forward only", backwards);

  console.log("\nSending: the flat, the link and the quote together, or none of them");
  const noAccount = await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: q2 });
  check("with no Razorpay account connected, nothing is blocked", !noAccount.ok && (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${q2}`).length === 0);
  check("the developer's own account is connected, sealed", (await savePaymentAccount({ orgId, userId: admin.id, tokens: {
    accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), accountId: "acc_QUOTECHECK1", mode: "test" } })).ok);
  check("a webhook naming the account finds this tenant, and only it", (await ownerOfAccount("acc_QUOTECHECK1")) === orgId && (await ownerOfAccount("acc_NOBODY0001")) === null);
  const sent = await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: q2 });
  const [blk] = await sql<{ state: string; expires_at: Date; created_at: Date }[]>`SELECT state, expires_at, created_at FROM unit_blocks WHERE quote_id = ${q2}`;
  const [lnk] = await sql<{ status: string; amount_paise: string; reference: string }[]>`SELECT status, amount_paise::text, reference FROM payment_links WHERE quote_id = ${q2}`;
  check("the flat is held 48 hours and the link is out for the signed token", sent.ok && blk?.state === "PENDING_TOKEN"
    && Math.round((blk.expires_at.getTime() - blk.created_at.getTime()) / 3_600_000) === 48 && lnk?.status === "CREATED" && lnk.amount_paise === "15000000");
  check("the link names the quote, so the gateway can be asked for it again", lnk?.reference === linkReference(q2) && links.has(linkReference(q2)));
  const sheet = await listUnits(orgId, tower.id);
  const c803 = sheet.find((u) => u.unitNo === "C-803");
  check("the availability sheet shows the flat held, and until when", c803?.status === "BLOCKED" && !!c803.heldUntil
    && (await availability(orgId, tower.id)).reduce((n, x) => n + x.blocked, 0) === 1);
  check("and another buyer is not offered it", !(await quoteChoices(orgId, other)).flats.some((f) => f.unitNo === "C-803")
    && (await quoteChoices(orgId, buyer)).flats.some((f) => f.unitNo === "C-803"));

  // Another buyer wants the same flat.
  const o1 = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: other, unitTypeId: unitId, unitNo: "C-803" });
  check("a flat held for one buyer cannot be quoted to another", !o1.ok && o1.message.startsWith("Flat C-803 is held for another buyer until"));
  let twoLive = false;
  try {
    await sql`INSERT INTO unit_blocks (org_id, scope_node_id, unit_no, quote_id, lead_id, expires_at)
              VALUES (${orgId}, ${tower.id}, 'C-803', ${q2}, ${buyer}, now() + interval '1 hour')`;
  } catch (e) {
    twoLive = (e as { code?: string }).code === "23505";
  }
  check("and the database refuses a second live block on one flat", twoLive);

  // A lost answer: the link is made, the answer never arrives.
  const o2 = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: other, unitTypeId: unitId, unitNo: "C-804" });
  const oq = o2.ok ? o2.quoteId : "";
  await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: oq });
  mode = "lose";
  const lost = await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: oq });
  mode = "ok";
  check("a lost answer is found at the gateway rather than made twice", lost.ok && [...links.keys()].filter((k) => k === linkReference(oq)).length === 1
    && (await sql`SELECT 1 FROM payment_links WHERE quote_id = ${oq} AND status = 'CREATED'`).length === 1);

  // The other buyer's link on C-804 runs out.
  await sql`UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE quote_id = ${oq}`;
  await sql`UPDATE unit_blocks SET expires_at = now() - interval '1 minute' WHERE quote_id = ${oq}`;
  check("the sweep lets an expired block go and cancels its link at the gateway", (await sweepQuotes(orgId)) === 1
    && (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${oq} AND state = 'RELEASED'`).length === 1 && cancelled.length === 1
    && (await sql`SELECT 1 FROM quotes WHERE id = ${oq} AND state = 'EXPIRED'`).length === 1);
  const o4 = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: other, unitTypeId: unitId, unitNo: "C-806" });
  const q4 = o4.ok ? o4.quoteId : "";
  await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: q4 });
  mode = "refuse";
  const refused = await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: q4 });
  mode = "ok";
  check("a link the gateway refused leaves the flat free and the quote approved", !refused.ok
    && (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${q4} AND state = 'RELEASED'`).length === 1
    && (await sql`SELECT 1 FROM payment_links WHERE quote_id = ${q4} AND status = 'VOID'`).length === 1
    && (await sql`SELECT 1 FROM quotes WHERE id = ${q4} AND state = 'APPROVED'`).length === 1);
  check("and it can be sent again", (await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: q4 })).ok);

  console.log("\nThe token: paid into the developer's account, and the buyer is booked");
  const gate = links.get(linkReference(q2))!;
  const paid = await onLinkEvent(orgId, { event: "PAID", accountId: "acc_QUOTECHECK1", linkId: gate.id, reference: linkReference(q2), paymentId: "pay_TESTPAY001", amountPaise: 15_000_000, paidAt: new Date().toISOString() });
  const [after] = await sql<{ state: string; paid: Date | null; expires_at: Date }[]>`SELECT state, paid_at AS paid, expires_at FROM unit_blocks WHERE quote_id = ${q2}`;
  check("the token paid holds the flat seven days more", paid === "BOOKED" && after.state === "TOKEN_PAID" && Math.round((after.expires_at.getTime() - after.paid!.getTime()) / 86_400_000) === 7);
  const [booked] = await sql<{ stage: string; facts: Record<string, string> }[]>`SELECT stage, facts FROM leads WHERE id = ${buyer}`;
  check("the buyer is booked with the agreement value and the token", booked.stage === "booked" && booked.facts.agreement === "9537500" && booked.facts.token === "150000");
  check("the same webhook twice changes nothing", (await onLinkEvent(orgId, { event: "PAID", accountId: "acc_QUOTECHECK1", linkId: gate.id, reference: linkReference(q2), paymentId: "pay_TESTPAY001", amountPaise: 15_000_000, paidAt: null })) === "IGNORED");

  check("the agreement makes the held flat the buyer's", (await convertBlocks(orgId, buyer)) === 1
    && (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${q2} AND state = 'CONVERTED'`).length === 1);

  console.log("\nA stopped tower stops all three");
  await sql`UPDATE registration_records SET status = 'BLOCKED' WHERE scope_node_id = ${tower.id}`;
  const before = cancelled.length;
  const swept = await sweepQuotes(orgId);
  check("the sweep cancels a live link on a tower that may not be advertised", swept === 1 && cancelled.length === before + 1
    && (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${q4} AND state IN ('PENDING_TOKEN', 'TOKEN_PAID')`).length === 0
    && (await sql`SELECT 1 FROM payment_links WHERE quote_id = ${q4} AND status = 'CANCELLED'`).length === 1);
  check("and nothing new is quoted there", !(await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: other, unitTypeId: unitId, unitNo: "C-804" })).ok);

  console.log("\nA paid hold runs out");
  const [q4row] = await sql<{ id: string }[]>`SELECT id FROM quotes WHERE lead_id = ${other} ORDER BY created_at DESC LIMIT 1`;
  await sql`INSERT INTO unit_blocks (org_id, scope_node_id, unit_no, quote_id, lead_id, state, paid_at, expires_at)
            VALUES (${orgId}, ${tower.id}, 'C-806', ${q4row.id}, ${other}, 'TOKEN_PAID', now() - interval '8 days', now() - interval '1 day')`;
  check("seven days after the token with no agreement, the flat is let go and a person is told", (await sweepQuotes(orgId)) === 1
    && (await sql`SELECT 1 FROM unit_blocks WHERE lead_id = ${other} AND unit_no = 'C-806' AND state = 'RELEASED' AND paid_at IS NOT NULL`).length === 1
    && ((await sql<{ needs_person: string | null }[]>`SELECT needs_person FROM leads WHERE id = ${other}`)[0].needs_person ?? "").startsWith("The hold on C-806 ended"));

  // The tower may be advertised again for what follows.
  await sql`UPDATE registration_records SET status = 'VERIFIED' WHERE scope_node_id = ${tower.id}`;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const quoteOf = async (lead: string) => (await sql<{ id: string }[]>`SELECT id FROM quotes WHERE lead_id = ${lead} ORDER BY created_at DESC LIMIT 1`)[0].id;
  const stageOf = async (lead: string) => (await sql<{ stage: string; exit_reason: string | null; facts: Record<string, string> }[]>`
    SELECT stage, exit_reason, facts FROM leads WHERE id = ${lead}`)[0];

  console.log("\nFloor rise, PLC and a woman buying alone: typed on the draft, approved with it");
  const meera = await newLead("Meera Joshi", "+919000000803");
  const badLine = await draftQuote({ orgId, userId: admin.id, authz: drafter, leadId: meera, unitTypeId: unitId, unitNo: "C-807",
    extras: [{ kind: "FLOOR_RISE", basis: "PSF", rate: 20_000 }] });
  check("a floor rise nobody could mean is refused", !badLine.ok && badLine.message.includes("is not a rate"));
  const d5 = await draftQuote({ orgId, userId: admin.id, authz: drafter, leadId: meera, unitTypeId: unitId, unitNo: "C-807",
    extras: [{ kind: "PLC", basis: "LUMP", rate: 2_00_000 }, { kind: "FLOOR_RISE", basis: "PSF", rate: 150 }], woman: true });
  const q5 = d5.ok ? d5.quoteId : "";
  const [m] = await listQuotes(orgId, meera);
  check("Rs 95,37,500 plus Rs 1,02,300 floor rise and Rs 2,00,000 PLC: Rs 98,39,800 agreed, duty 5% for a woman, Rs 1,08,53,780 all in",
    d5.ok && m?.agreement === 98_39_800 && m.extras.length === 2 && m.extras[0].kind === "FLOOR_RISE" && m.dutyRate === 5
      && m.stampDuty === 4_91_990 && m.gst === 4_91_990 && m.allIn === 1_08_53_780 && m.woman === "Stamp duty 1 point less for a woman buying alone",
    JSON.stringify(m));
  check("the lines are written once with the quote", (await sql`SELECT 1 FROM quotes WHERE id = ${q5} AND extras = 302300 AND woman_buyer
    AND jsonb_array_length(extra_lines) = 2 AND registration_no = 'P51800012345' AND parties->>'developer' = 'Quote Check Realty'`).length === 1);
  check("the concession is offered here because Mumbai's row records one", (await quoteChoices(orgId, meera)).woman === "Stamp duty 1 point less for a woman buying alone");
  check("an unapproved quote has no PDF", (await quotePdf(orgId, meera, q5)) === null);
  check("the draft is approved with its lines, and the approval pins them", (await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: q5 })).ok);

  console.log("\nThe quote as a PDF: from its own row");
  await sql`UPDATE orgs SET legal_name = 'Renamed Realty' WHERE id = ${orgId}`;
  const pdf = await quotePdf(orgId, meera, q5);
  const text = pdf?.bytes.toString("latin1") ?? "";
  check("the PDF prints the developer, the flat, every line, the token, validity and the registration",
    !!pdf && text.startsWith("%PDF-1.4") && text.includes("(Quote Check Realty)") && text.includes("Harbour View, Tower A") && text.includes("Flat C-803") === false
      && text.includes("Flat C-807, 2 BHK") && text.includes("(Rs 1,02,300)") && text.includes("(Rs 2,00,000)") && text.includes("(Rs 98,39,800)")
      && text.includes("(Rs 1,08,53,780)") && text.includes("(Rs 1,50,000)") && text.includes("Valid until") && text.includes("RERA registration: P51800012345")
      && text.includes("Meera Joshi") && text.includes("woman buying alone: applied"));
  check("the names are the ones recorded at drafting, never today's", !text.includes("Renamed Realty"));
  check("and nothing on it is an advertisement's", !/impression/i.test(text));
  await sql`UPDATE orgs SET legal_name = 'Quote Check Realty' WHERE id = ${orgId}`;
  check("a quote asked for under another buyer is not found", (await quotePdf(orgId, other, q5)) === null);

  console.log("\nA token paid by cheque: it books the buyer the way a paid link does");
  check("somebody who cannot approve cannot record a token",
    !(await recordOfflineToken({ orgId, userId: admin.id, authz: drafter, quoteId: q5, mode: "CHEQUE", reference: "004512", amount: 1_50_000, paidOn: today, today })).ok);
  const wrongAmount = await recordOfflineToken({ orgId, userId: admin.id, authz: closer, quoteId: q5, mode: "CHEQUE", reference: "004512", amount: 1_49_000, paidOn: today, today });
  check("an amount that is not the quote's token is refused", !wrongAmount.ok && wrongAmount.message === "The amount is not this quote's token of Rs 1,50,000.");
  check("and nothing was blocked", (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${q5}`).length === 0);
  const offline = await recordOfflineToken({ orgId, userId: admin.id, authz: closer, quoteId: q5, mode: "CHEQUE", reference: "004 512", amount: 1_50_000, paidOn: today, today });
  const [ob] = await sql<{ state: string; paid_at: Date; expires_at: Date }[]>`SELECT state, paid_at, expires_at FROM unit_blocks WHERE quote_id = ${q5}`;
  check("the cheque blocks the flat as paid, seven days for the agreement", offline.ok && ob?.state === "TOKEN_PAID"
    && Math.round((ob.expires_at.getTime() - ob.paid_at.getTime()) / 86_400_000) === 7
    && (await sql`SELECT 1 FROM token_payments WHERE quote_id = ${q5} AND mode = 'CHEQUE' AND reference = '004512' AND amount = 150000`).length === 1
    && (await sql`SELECT 1 FROM quotes WHERE id = ${q5} AND state = 'SENT'`).length === 1, offline.message);
  const mb = await stageOf(meera);
  check("the buyer is booked with the agreement value, floor rise and PLC included, and the token",
    mb.stage === "booked" && mb.facts.agreement === "9839800" && mb.facts.token === "150000" && mb.facts.bookedOn === today, JSON.stringify(mb));
  check("the same token twice is refused",
    !(await recordOfflineToken({ orgId, userId: admin.id, authz: closer, quoteId: q5, mode: "CHEQUE", reference: "004512", amount: 1_50_000, paidOn: today, today })).ok);
  check("the audit row names the mode and never the cheque", (await sql`
    SELECT 1 FROM audit_log WHERE org_id = ${orgId} AND action = 'quote.token_recorded' AND target_id = ${q5}
      AND metadata->>'mode' = 'CHEQUE' AND metadata::text NOT LIKE '%004512%'`).length === 1);
  check("a buyer with a token paid is not quoted again", !(await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: meera, unitTypeId: unitId, unitNo: "C-810" })).ok);

  console.log("\nA transfer while the link is out: the link is cancelled first");
  const ravi = await newLead("Ravi Menon", "+919000000804");
  const d6 = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: ravi, unitTypeId: unitId, unitNo: "C-808" });
  const q6 = d6.ok ? d6.quoteId : "";
  await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: q6 });
  check("the link goes out", (await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: q6 })).ok);
  cancelRefuses = true;
  const stuck = await recordOfflineToken({ orgId, userId: admin.id, authz: closer, quoteId: q6, mode: "TRANSFER", reference: "HDFCR52026093012345", amount: 1_50_000, paidOn: today, today });
  cancelRefuses = false;
  check("a link the gateway would not cancel records nothing, so the buyer cannot pay twice", !stuck.ok
    && (await sql`SELECT 1 FROM payment_links WHERE quote_id = ${q6} AND status = 'CREATED'`).length === 1
    && (await sql`SELECT 1 FROM token_payments WHERE quote_id = ${q6}`).length === 0);
  const before6 = cancelled.length;
  const byTransfer = await recordOfflineToken({ orgId, userId: admin.id, authz: closer, quoteId: q6, mode: "TRANSFER", reference: "hdfcr52026093012345", amount: 1_50_000, paidOn: today, today });
  check("the transfer cancels the link at the gateway, keeps the block and books the buyer", byTransfer.ok && cancelled.length === before6 + 1
    && (await sql`SELECT 1 FROM payment_links WHERE quote_id = ${q6} AND status = 'CANCELLED'`).length === 1
    && (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${q6} AND state = 'TOKEN_PAID'`).length === 1
    && (await stageOf(ravi)).stage === "booked", byTransfer.message);

  console.log("\nCancelling a token paid by hand: the flat goes back, the refund is owed");
  const tooMuch = await cancelToken({ orgId, userId: admin.id, authz: closer, quoteId: q5, reason: "Loan not approved", refund: 1_50_001, today });
  check("a refund larger than was paid is refused", !tooMuch.ok && tooMuch.message === "A refund cannot be more than the Rs 1,50,000 paid.");
  check("a reason off the list is refused", !(await cancelToken({ orgId, userId: admin.id, authz: closer, quoteId: q5, reason: "Because", refund: 1_00_000, today })).ok);
  check("somebody who cannot approve cannot cancel", !(await cancelToken({ orgId, userId: admin.id, authz: drafter, quoteId: q5, reason: "Loan not approved", refund: 1_00_000, today })).ok);
  const c5 = await cancelToken({ orgId, userId: admin.id, authz: closer, quoteId: q5, reason: "Loan not approved", refund: 1_00_000, today });
  check("cancelled: the quote says so and the flat is free", c5.ok && (await sql`SELECT 1 FROM quotes WHERE id = ${q5} AND state = 'CANCELLED' AND cancelled_by = ${admin.id}`).length === 1
    && (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${q5} AND state = 'RELEASED'`).length === 1
    && (await quoteChoices(orgId, other)).flats.some((f) => f.unitNo === "C-807"), c5.ok ? c5.message : c5.message);
  const mc = await stageOf(meera);
  check("the buyer leaves Booked through the board's own move, with the reason", mc.stage === "lost" && mc.exit_reason === "Loan not approved" && !mc.facts.token, JSON.stringify(mc));
  check("the refund owed is a row: part of what was paid, by cheque", (await sql`
    SELECT 1 FROM token_refunds WHERE quote_id = ${q5} AND mode = 'CHEQUE' AND state = 'DUE' AND amount = 100000 AND paid_amount = 150000`).length === 1);
  check("a cancelled token is not cancelled twice", !(await cancelToken({ orgId, userId: admin.id, authz: closer, quoteId: q5, reason: "Loan not approved", refund: 1, today })).ok);
  check("a refund's reference must read as a cheque or a UTR", !(await recordRefundPaid({ orgId, userId: admin.id, authz: closer, quoteId: q5, reference: "12" })).ok);
  check("paying it back is recorded once", (await recordRefundPaid({ orgId, userId: admin.id, authz: closer, quoteId: q5, reference: "004513" })).ok
    && (await sql`SELECT 1 FROM token_refunds WHERE quote_id = ${q5} AND state = 'PROCESSED' AND paid_reference = '004513'`).length === 1
    && !(await recordRefundPaid({ orgId, userId: admin.id, authz: closer, quoteId: q5, reference: "004513" })).ok);
  check("an agreement already registered is not cancelled here", !(await cancelToken({ orgId, userId: admin.id, authz: closer, quoteId: q2, reason: "Other", refund: 0, today })).ok);

  console.log("\nCancelling a token paid on the link: refunded through the developer's own account");
  const sana = await newLead("Aarti Kulkarni", "+919000000805");
  const d7 = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: sana, unitTypeId: unitId, unitNo: "C-809" });
  const q7 = d7.ok ? d7.quoteId : "";
  await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: q7 });
  await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: q7 });
  const l7 = links.get(linkReference(q7))!;
  check("the token is paid on the link", (await onLinkEvent(orgId, { event: "PAID", accountId: "acc_QUOTECHECK1", linkId: l7.id, reference: linkReference(q7),
    paymentId: "pay_REFUNDME001", amountPaise: 15_000_000, paidAt: new Date().toISOString() })) === "BOOKED");
  refundMode = "lose";
  const c7 = await cancelToken({ orgId, userId: admin.id, authz: closer, quoteId: q7, reason: "Buyer changed their mind", refund: 1_50_000, today });
  refundMode = "ok";
  const [r7] = await sql<{ state: string; provider_refund_id: string | null; amount: string; attempts: number }[]>`
    SELECT state, provider_refund_id, amount::text, attempts FROM token_refunds WHERE quote_id = ${q7}`;
  const g7 = refunds.get(refundReceipt(q7));
  check("a lost answer is found under the quote's receipt: one refund, the whole token, asked under that key",
    c7.ok && refundCalls === 1 && !!g7 && g7.amountPaise === 15_000_000 && g7.paymentId === "pay_REFUNDME001" && g7.key === refundReceipt(q7)
      && r7?.provider_refund_id === g7.id && r7.state === "REQUESTED", JSON.stringify(r7));
  check("the flat is free and the buyer out of Booked", (await sql`SELECT 1 FROM unit_blocks WHERE quote_id = ${q7} AND state = 'RELEASED'`).length === 1
    && (await stageOf(sana)).stage === "lost");
  g7!.status = "processed";
  await sweepQuotes(orgId);
  check("the sweep reads it back as refunded", (await sql`SELECT 1 FROM token_refunds WHERE quote_id = ${q7} AND state = 'PROCESSED' AND processed_at IS NOT NULL`).length === 1
    && refundCalls === 1);

  console.log("\nA refund the gateway refuses: asked again, a few times, then a person");
  const neha = await newLead("Neha Rao", "+919000000806");
  const d8 = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: neha, unitTypeId: unitId, unitNo: "C-810" });
  const q8 = d8.ok ? d8.quoteId : "";
  await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: q8 });
  await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: q8 });
  const l8 = links.get(linkReference(q8))!;
  await onLinkEvent(orgId, { event: "PAID", accountId: "acc_QUOTECHECK1", linkId: l8.id, reference: linkReference(q8), paymentId: "pay_REFUNDME002", amountPaise: 15_000_000, paidAt: new Date().toISOString() });
  refundMode = "refuse";
  const c8 = await cancelToken({ orgId, userId: admin.id, authz: closer, quoteId: q8, reason: "Found a better deal", refund: 75_000, today });
  const [r8] = await sql<{ state: string; attempts: number; last_error: string | null }[]>`SELECT state, attempts, last_error FROM token_refunds WHERE quote_id = ${q8}`;
  check("a refused refund stays asked for, with why", c8.ok && r8?.state === "REQUESTED" && r8.attempts === 1 && (r8.last_error ?? "").includes("invalid"));
  await sql`UPDATE token_refunds SET attempts = 4 WHERE quote_id = ${q8}`;
  await sweepQuotes(orgId);
  check("past the fifth refusal it is FAILED and a person is told", (await sql`SELECT 1 FROM token_refunds WHERE quote_id = ${q8} AND state = 'FAILED' AND attempts = 5`).length === 1
    && ((await sql<{ needs_person: string | null }[]>`SELECT needs_person FROM leads WHERE id = ${neha}`)[0].needs_person ?? "").startsWith("Razorpay did not refund"));
  refundMode = "ok";
  const calls8 = refundCalls;
  await sweepQuotes(orgId);
  check("and it is never asked again by itself", refundCalls === calls8);
  check("a person who paid it another way records it", (await recordRefundPaid({ orgId, userId: admin.id, authz: closer, quoteId: q8, reference: "UTR123456789012" })).ok
    && (await sql`SELECT 1 FROM token_refunds WHERE quote_id = ${q8} AND state = 'PROCESSED'`).length === 1);

  console.log("\nRazorpay's refund webhooks: proved, stored once, and moving only their own row");
  {
    process.env.RAZORPAY_PARTNER_WEBHOOK_SECRET = "quote-check-webhook-secret";
    const { receivePaymentWebhook } = await import("../src/lib/quotes.ts");
    const { createHmac } = await import("node:crypto");
    const sign = (raw: string) => createHmac("sha256", process.env.RAZORPAY_PARTNER_WEBHOOK_SECRET!).update(raw).digest("hex");
    const paidAndCancelled = async (name: string, phone: string, unitNo: string, payment: string) => {
      await sql`INSERT INTO units (org_id, scope_node_id, unit_type_id, unit_no, config, status, source) VALUES (${orgId}, ${tower.id}, ${unitId}, ${unitNo}, '2 BHK', 'AVAILABLE', 'IMPORT')`;
      const who = await newLead(name, phone);
      const d = await draftQuote({ orgId, userId: admin.id, authz: closer, leadId: who, unitTypeId: unitId, unitNo });
      const q = d.ok ? d.quoteId : "";
      await approveQuote({ orgId, userId: admin.id, authz: closer, quoteId: q });
      await sendQuote({ orgId, userId: admin.id, authz: closer, quoteId: q });
      const l = links.get(linkReference(q))!;
      await onLinkEvent(orgId, { event: "PAID", accountId: "acc_QUOTECHECK1", linkId: l.id, reference: linkReference(q), paymentId: payment, amountPaise: 15_000_000, paidAt: new Date().toISOString() });
      await cancelToken({ orgId, userId: admin.id, authz: closer, quoteId: q, reason: "Buyer changed their mind", refund: 1_00_000, today });
      return { q, who, gateway: refunds.get(refundReceipt(q))! };
    };
    const body = (event: string, g: { id: string }, payment: string, receipt: string, amount = 10_000_000) =>
      JSON.stringify({ event, account_id: "acc_QUOTECHECK1", payload: { refund: { entity: { id: g.id, payment_id: payment, receipt, amount, status: event.split(".")[1] } } } });
    const stateOf = async (q: string) => (await sql<{ state: string; processed_at: Date | null }[]>`SELECT state, processed_at FROM token_refunds WHERE quote_id = ${q}`)[0];

    const r9 = await paidAndCancelled("Kavya Iyer", "+919000000807", "C-811", "pay_REFUNDME003");
    check("the refund is asked of the developer's account and waits", (await stateOf(r9.q))?.state === "REQUESTED" && !!r9.gateway);
    const raw9 = body("refund.processed", r9.gateway, "pay_REFUNDME003", refundReceipt(r9.q));
    const forged = await receivePaymentWebhook(raw9, "0".repeat(64), "evt_refund_9");
    check("a webhook that does not prove itself is refused and stored nowhere",
      forged.status === 403 && !forged.work && (await sql`SELECT 1 FROM payment_events WHERE event_id = 'evt_refund_9'`).length === 0);
    const wrongAmount = await receivePaymentWebhook(body("refund.processed", r9.gateway, "pay_REFUNDME003", refundReceipt(r9.q), 99), sign(body("refund.processed", r9.gateway, "pay_REFUNDME003", refundReceipt(r9.q), 99)), "evt_refund_9x");
    await wrongAmount.work?.();
    check("a refund for another amount than asked moves nothing", (await stateOf(r9.q))?.state === "REQUESTED");
    const got = await receivePaymentWebhook(raw9, sign(raw9), "evt_refund_9");
    await got.work?.();
    const s9 = await stateOf(r9.q);
    check("refund.processed marks the refund processed", got.status === 200 && s9?.state === "PROCESSED" && !!s9.processed_at);
    check("and the event is stored once, and worked", (await sql`SELECT 1 FROM payment_events WHERE org_id = ${orgId} AND event_id = 'evt_refund_9' AND processed_at IS NOT NULL`).length === 1);
    const twice = await receivePaymentWebhook(raw9, sign(raw9), "evt_refund_9");
    check("the same event again is not worked twice", twice.status === 200 && twice.work === null);
    const late = await receivePaymentWebhook(body("refund.failed", r9.gateway, "pay_REFUNDME003", refundReceipt(r9.q)), sign(body("refund.failed", r9.gateway, "pay_REFUNDME003", refundReceipt(r9.q))), "evt_refund_9f");
    await late.work?.();
    check("a failure after it was processed changes nothing: a refund paid is final", (await stateOf(r9.q))?.state === "PROCESSED");

    const r10 = await paidAndCancelled("Rohan Mehta", "+919000000808", "C-812", "pay_REFUNDME004");
    const raw10 = body("refund.failed", r10.gateway, "pay_REFUNDME004", refundReceipt(r10.q));
    const failed = await receivePaymentWebhook(raw10, sign(raw10), "evt_refund_10");
    await failed.work?.();
    check("refund.failed marks it failed and asks a person",
      (await stateOf(r10.q))?.state === "FAILED"
        && ((await sql<{ needs_person: string | null }[]>`SELECT needs_person FROM leads WHERE id = ${r10.who}`)[0].needs_person ?? "").startsWith("Razorpay did not refund"));
    const other = await receivePaymentWebhook(raw10.replace("acc_QUOTECHECK1", "acc_NOBODY0001"), sign(raw10.replace("acc_QUOTECHECK1", "acc_NOBODY0001")), "evt_refund_10b");
    check("an account nobody here connected is answered and stored nowhere",
      other.status === 200 && other.work === null && (await sql`SELECT 1 FROM payment_events WHERE event_id = 'evt_refund_10b'`).length === 0);
  }

  check("no audit row carries a payment's reference", (await sql`
    SELECT 1 FROM audit_log WHERE org_id = ${orgId} AND (metadata::text LIKE '%pay_REFUND%' OR metadata::text LIKE '%004513%' OR metadata::text LIKE '%UTR123%')`).length === 0);
} finally {
  usePayments(null);
  useVaultKey(null);
  await sql`DELETE FROM payment_events WHERE org_id = ${orgId}`;
  await sql`DELETE FROM token_refunds WHERE org_id = ${orgId}`;
  await sql`DELETE FROM token_payments WHERE org_id = ${orgId}`;
  await sql`DELETE FROM payment_links WHERE org_id = ${orgId}`;
  await sql`DELETE FROM unit_blocks WHERE org_id = ${orgId}`;
  await sql`DELETE FROM quotes WHERE org_id = ${orgId}`;
  await sql`DELETE FROM payment_accounts WHERE org_id = ${orgId}`;
  await sql`DELETE FROM messages WHERE org_id = ${orgId}`;
  await sql`DELETE FROM leads WHERE org_id = ${orgId}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  await sql`DELETE FROM orgs WHERE id = ${orgId}`;
  await sql`DELETE FROM users WHERE email_domain = ${domain}`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
