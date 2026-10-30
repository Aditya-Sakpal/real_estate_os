import { audit, withTenant } from "./db/index.ts";
import {
  mayAskShare,
  loanSharePayload,
  beforeBankPays,
  docChecklist,
  docProgress,
  loanAlerts,
  loanFlag,
  loanHistoryLine,
  loanProblem,
  loanUnchanged,
  milestoneLabel,
  nextDocuments,
  nextStep,
  splitDemand,
  stageAfterBankPaid,
  BANK_OVERDUE_DAYS,
  LOAN_STAGE_LABEL,
  LOAN_STUCK_DAYS,
  type Applicant,
  type DemandInput,
  type DemandRow,
  type LoanInput,
  type LoanReason,
  type LoanRow,
  type LoanStage,
  type Milestone,
  type ReportLoan,
  type Arranger,
  type PartnerShare,
} from "./loan-rules.ts";

/**
 * A buyer's home loan: the loan file the loan executive works, the list of
 * every loan, the engine opening one when a call or a lender question says
 * the buyer needs it, and the counts for Today. `loan-rules.ts` decides.
 */

export type Loan = LoanRow & {
  id: string;
  /** The bank, by name: the lender's, or the one typed. */
  bank: string | null;
  stageAt: string;
  source: "CALL" | "LENDER_YES" | "PERSON";
  documents: Record<string, string>;
  partnerShare: PartnerShare | null;
  partnerShareAt: string | null;
  partnerShareSource: "WHATSAPP" | "PERSON" | null;
};

type Raw = {
  id: string;
  lead_id: string;
  stage: LoanStage;
  lender_id: string | null;
  bank_name: string | null;
  lender: string | null;
  amount_paise: string | null;
  reason: LoanReason | null;
  stage_at: Date;
  source: Loan["source"];
  applicant: Applicant | null;
  documents: Record<string, string> | null;
  rate_bp: number | null;
  expires_on: string | null;
  agreement_paise: string | null;
  arranged_by: Arranger | null;
  partner_share: PartnerShare | null;
  partner_share_at: Date | null;
  partner_share_source: "WHATSAPP" | "PERSON" | null;
};

function shape(r: Raw): Loan {
  return {
    id: r.id,
    stage: r.stage,
    lenderId: r.lender_id,
    bankName: r.bank_name,
    bank: r.lender ?? r.bank_name,
    amountPaise: r.amount_paise === null ? null : Number(r.amount_paise),
    reason: r.reason,
    stageAt: r.stage_at.toISOString(),
    source: r.source,
    applicant: r.applicant,
    documents: r.documents ?? {},
    rateBp: r.rate_bp,
    expiresOn: r.expires_on,
    agreementPaise: r.agreement_paise === null ? null : Number(r.agreement_paise),
    arrangedBy: r.arranged_by,
    partnerShare: r.partner_share,
    partnerShareAt: r.partner_share_at ? r.partner_share_at.toISOString() : null,
    partnerShareSource: r.partner_share_source,
  };
}

// One column list, so every read shapes the same.
const COLS = `o.id, o.lead_id, o.stage, o.lender_id, o.bank_name, k.name AS lender, o.amount_paise::text, o.reason, o.stage_at, o.source,
  o.applicant, o.documents, o.rate_bp, o.sanction_expires_on::text AS expires_on, o.agreement_paise::text,
  o.arranged_by, o.partner_share, o.partner_share_at, o.partner_share_source`;

type RawDemand = {
  id: string;
  loan_id: string;
  milestone: Milestone;
  slab_no: number | null;
  demand_on: string;
  amount_paise: string;
  buyer_share_paise: string;
  bank_share_paise: string;
  sent_to_bank_on: string | null;
  bank_paid_paise: string | null;
  bank_paid_on: string | null;
  buyer_paid_on: string | null;
  cancelled: boolean;
};

function shapeDemand(d: RawDemand): DemandRow & { loanId: string } {
  return {
    id: d.id,
    loanId: d.loan_id,
    milestone: d.milestone,
    slabNo: d.slab_no,
    demandOn: d.demand_on,
    amountPaise: Number(d.amount_paise),
    buyerSharePaise: Number(d.buyer_share_paise),
    bankSharePaise: Number(d.bank_share_paise),
    sentToBankOn: d.sent_to_bank_on,
    bankPaidPaise: d.bank_paid_paise === null ? null : Number(d.bank_paid_paise),
    bankPaidOn: d.bank_paid_on,
    buyerPaidOn: d.buyer_paid_on,
    cancelled: d.cancelled,
  };
}

const DEMAND_COLS = `d.id, d.loan_id, d.milestone, d.slab_no, d.demand_on::text, d.amount_paise::text, d.buyer_share_paise::text,
  d.bank_share_paise::text, d.sent_to_bank_on::text, d.bank_paid_paise::text, d.bank_paid_on::text, d.buyer_paid_on::text,
  (d.cancelled_at IS NOT NULL) AS cancelled`;

export async function loanFor(orgId: string, leadId: string): Promise<Loan | null> {
  const [r] = await withTenant(orgId, (sql) => sql<Raw[]>`
    SELECT ${sql.unsafe(COLS)} FROM lead_loans o LEFT JOIN lenders k ON k.id = o.lender_id
    WHERE o.org_id = ${orgId} AND o.lead_id = ${leadId}`);
  return r ? shape(r) : null;
}

export type LoanFile = {
  lead: { id: string; name: string; stage: string; place: string; path: string; erased: boolean; agreementRupees: number | null };
  loan: Loan | null;
  demands: DemandRow[];
  /** The loan's bank has approved this buyer's project. */
  approvedBank: boolean;
  /** The channel partner whose buyer this is, when one holds the claim. */
  partner: string | null;
  /** The developer lets partners see their buyers' loan stage, with the buyer's yes. */
  shareSwitch: boolean;
};

/** One buyer's loan file: the lead it belongs to, the loan, and every demand raised on the flat. */
export async function loanFile(orgId: string, leadId: string): Promise<LoanFile | null> {
  return withTenant(orgId, async (sql) => {
    const [l] = await sql<{ id: string; name: string | null; stage: string; tower: string; project: string | null; path: string; erased: boolean; agreement: string | null; quote: string | null }[]>`
      SELECT l.id, l.name, l.stage, n.name AS tower, p.name AS project, n.path::text AS path, (l.erased_at IS NOT NULL) AS erased,
             l.facts->>'agreement' AS agreement, l.facts->>'quote' AS quote
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
      WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    if (!l) return null;
    const [r] = await sql<Raw[]>`
      SELECT ${sql.unsafe(COLS)} FROM lead_loans o LEFT JOIN lenders k ON k.id = o.lender_id
      WHERE o.org_id = ${orgId} AND o.lead_id = ${leadId}`;
    const demands = r
      ? (await sql<RawDemand[]>`
          SELECT ${sql.unsafe(DEMAND_COLS)} FROM lead_loan_demands d
          WHERE d.org_id = ${orgId} AND d.loan_id = ${r.id} ORDER BY d.demand_on, d.created_at`).map(shapeDemand)
      : [];
    const agreed = Number(l.agreement ?? l.quote ?? "");
    const [extra] = await sql<{ approved: boolean; partner: string | null; switch_on: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM lender_projects lp JOIN scope_nodes pn ON pn.id = lp.scope_node_id
                     JOIN scope_nodes me ON me.path = ${l.path}::ltree AND me.org_id = ${orgId}
                     WHERE lp.org_id = ${orgId} AND lp.lender_id = ${r?.lender_id ?? null} AND pn.path @> me.path) AS approved,
             (SELECT pf.name FROM client_registrations c JOIN partner_firms pf ON pf.org_id = c.org_id AND pf.cp_org_id = c.cp_org_id
              WHERE c.org_id = ${orgId} AND c.lead_id = ${leadId} AND c.verdict = 'REGISTERED'
              ORDER BY c.created_at DESC LIMIT 1) AS partner,
             coalesce((SELECT share_loan_stage FROM partner_settings WHERE org_id = ${orgId}), false) AS switch_on`;
    return {
      lead: {
        id: l.id,
        name: l.name ?? "Buyer",
        stage: l.stage,
        place: l.project ? `${l.project} · ${l.tower}` : l.tower,
        path: l.path,
        erased: l.erased,
        agreementRupees: Number.isFinite(agreed) && agreed > 0 ? Math.round(agreed) : null,
      },
      loan: r ? shape(r) : null,
      demands,
      approvedBank: !!extra?.approved,
      partner: extra?.partner ?? null,
      shareSwitch: !!extra?.switch_on,
    };
  });
}

export type LoanListRow = {
  leadId: string;
  name: string;
  place: string;
  leadStage: string;
  stage: LoanStage;
  bank: string | null;
  sanctionedPaise: number | null;
  bankPaidPaise: number;
  docs: { done: number; of: number };
  next: string;
  flag: { kind: string; text: string } | null;
  stageAt: string;
};

/** Every loan in the viewer's reach, with what each needs. Paths are the lead's tower. */
export async function listLoans(orgId: string, scopes: string[], nowIso = new Date().toISOString()): Promise<LoanListRow[]> {
  if (!scopes.length) return [];
  return withTenant(orgId, async (sql) => {
    const rows = await sql<(Raw & { name: string | null; lead_stage: string; tower: string; project: string | null })[]>`
      SELECT ${sql.unsafe(COLS)}, l.name, l.stage AS lead_stage, n.name AS tower, p.name AS project
      FROM lead_loans o
      JOIN leads l ON l.id = o.lead_id
      JOIN scope_nodes n ON n.id = l.scope_node_id
      LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
      LEFT JOIN lenders k ON k.id = o.lender_id
      WHERE o.org_id = ${orgId} AND l.erased_at IS NULL AND n.path <@ ANY(${scopes}::ltree[])
      ORDER BY o.stage_at DESC
      LIMIT 500`;
    const ids = rows.map((r) => r.id);
    const demands = ids.length
      ? (await sql<RawDemand[]>`
          SELECT ${sql.unsafe(DEMAND_COLS)} FROM lead_loan_demands d WHERE d.org_id = ${orgId} AND d.loan_id = ANY(${ids}::uuid[])`).map(shapeDemand)
      : [];
    return rows.map((r) => {
      const loan = shape(r);
      const mine = demands.filter((d) => d.loanId === r.id);
      const live = mine.filter((d) => !d.cancelled);
      const docs = docProgress(docChecklist(loan.applicant, loan.agreementPaise ? loan.agreementPaise / 100 : null), loan.documents, loan.stage);
      return {
        leadId: r.lead_id,
        name: r.name ?? "Buyer",
        place: r.project ? `${r.project} · ${r.tower}` : r.tower,
        leadStage: r.lead_stage,
        stage: loan.stage,
        bank: loan.bank,
        sanctionedPaise: loan.amountPaise,
        bankPaidPaise: live.reduce((n, d) => n + (d.bankPaidPaise ?? 0), 0),
        docs,
        next: nextStep({
          stage: loan.stage,
          docs,
          beforePay: beforeBankPays(loan.documents),
          unsent: live.filter((d) => d.bankSharePaise > 0 && !d.sentToBankOn).length,
        }),
        flag: loanFlag({ stage: loan.stage, stageAtIso: loan.stageAt, leadStage: r.lead_stage, expiresOn: loan.expiresOn, demands: live }, nowIso),
        stageAt: loan.stageAt,
      };
    });
  });
}

export type SaveLoanResult = { ok: true; changed: boolean } | { ok: false; message: string };

/** A person records where the loan stands. Checked again here, under a lock on the lead. */
export async function saveLoan(o: { orgId: string; userId: string; leadId: string; input: LoanInput }): Promise<SaveLoanResult> {
  const res = await withTenant(o.orgId, async (sql): Promise<SaveLoanResult> => {
    const [lead] = await sql<{ erased_at: Date | null }[]>`
      SELECT erased_at FROM leads WHERE org_id = ${o.orgId} AND id = ${o.leadId} FOR UPDATE`;
    if (!lead) return { ok: false, message: "That lead no longer exists." };
    if (lead.erased_at) return { ok: false, message: "This buyer's data was erased." };
    const [cur] = await sql<Raw[]>`
      SELECT ${sql.unsafe(COLS)} FROM lead_loans o LEFT JOIN lenders k ON k.id = o.lender_id
      WHERE o.org_id = ${o.orgId} AND o.lead_id = ${o.leadId} FOR UPDATE OF o`;
    const row = cur ? shape(cur) : null;
    // A lender id is believed only when it is one of this organisation's, still listed or already the loan's.
    let bank: string | null = o.input.bankName;
    if (o.input.lenderId) {
      const [k] = await sql<{ name: string }[]>`
        SELECT name FROM lenders WHERE org_id = ${o.orgId} AND id = ${o.input.lenderId} AND (active OR id = ${row?.lenderId ?? null})`;
      if (!k) return { ok: false, message: "Bank: that bank is no longer on your list. Choose again." };
      bank = k.name;
    }
    const problem = loanProblem(row?.stage ?? null, o.input);
    if (problem) return { ok: false, message: problem };
    // A bank that has already paid on this loan stays the loan's bank.
    if (row && row.stage === "DISBURSING" && (o.input.lenderId !== row.lenderId || o.input.bankName !== row.bankName)) {
      return { ok: false, message: "Bank: the bank is already paying on this loan." };
    }
    if (loanUnchanged(row, o.input)) return { ok: true, changed: false };
    const paise = (r: number | null) => (r === null ? null : r * 100);
    const moved = row?.stage !== o.input.stage;
    const v = {
      stage: o.input.stage,
      lender_id: o.input.lenderId,
      bank_name: o.input.bankName,
      amount_paise: paise(o.input.amountRupees),
      reason: o.input.reason,
      applicant: o.input.applicant,
      rate_bp: o.input.rateBp,
      sanction_expires_on: o.input.expiresOn,
      agreement_paise: paise(o.input.agreementRupees),
      arranged_by: o.input.arrangedBy,
    };
    if (row) {
      await sql`
        UPDATE lead_loans SET ${sql(v)}, stage_at = CASE WHEN ${moved} THEN now() ELSE stage_at END,
               updated_by = ${o.userId}, updated_at = now()
        WHERE org_id = ${o.orgId} AND id = ${row.id}`;
    } else {
      await sql`INSERT INTO lead_loans ${sql({ ...v, org_id: o.orgId, lead_id: o.leadId, source: "PERSON", updated_by: o.userId })}`;
    }
    if (moved || bank !== row?.bank || paise(o.input.amountRupees) !== row?.amountPaise) {
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
        VALUES (${o.orgId}, ${o.leadId}, 'NOTE', ${loanHistoryLine(o.input, bank)}, ${o.userId})`;
    }
    // A refusal on a buyer who has booked is the booking at risk: somebody calls them.
    if (o.input.stage === "REJECTED" && moved) {
      await sql`
        UPDATE leads SET needs_person = 'Home loan rejected. Call the buyer about another bank', updated_at = now()
        WHERE org_id = ${o.orgId} AND id = ${o.leadId} AND stage IN ('booked', 'negotiation')`;
    }
    return { ok: true, changed: true };
  });
  if (res.ok && res.changed) {
    await audit({
      orgId: o.orgId,
      actorUserId: o.userId,
      action: "lead.loan_updated",
      targetType: "lead",
      targetId: o.leadId,
      metadata: { stage: o.input.stage, lender_id: o.input.lenderId, other_bank: !!o.input.bankName },
    });
  }
  return res;
}

/** The documents received, as ticked on the loan file. A day already recorded is kept. */
export async function saveDocuments(o: { orgId: string; userId: string; leadId: string; ticked: string[]; today: string }): Promise<SaveLoanResult> {
  const res = await withTenant(o.orgId, async (sql): Promise<SaveLoanResult> => {
    const [cur] = await sql<{ id: string; documents: Record<string, string> }[]>`
      SELECT o.id, o.documents FROM lead_loans o JOIN leads l ON l.id = o.lead_id
      WHERE o.org_id = ${o.orgId} AND o.lead_id = ${o.leadId} AND l.erased_at IS NULL FOR UPDATE OF o`;
    if (!cur) return { ok: false, message: "Record the loan first." };
    const next = nextDocuments(cur.documents ?? {}, o.ticked, o.today);
    if (JSON.stringify(Object.keys(next).sort()) === JSON.stringify(Object.keys(cur.documents ?? {}).sort())) return { ok: true, changed: false };
    await sql`UPDATE lead_loans SET documents = ${sql.json(next)}, updated_by = ${o.userId}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${cur.id}`;
    return { ok: true, changed: true };
  });
  if (res.ok && res.changed) {
    await audit({ orgId: o.orgId, actorUserId: o.userId, action: "lead.loan_documents", targetType: "lead", targetId: o.leadId, metadata: { received: o.ticked.length } });
  }
  return res;
}

/**
 * A demand the developer raised on the flat, copied off its demand letter.
 * Split here, once, into the buyer's share and the bank's; the split never
 * changes afterwards (a wrong demand is cancelled and raised again).
 */
export async function addDemand(o: { orgId: string; userId: string; leadId: string; input: DemandInput }): Promise<SaveLoanResult> {
  const res = await withTenant(o.orgId, async (sql): Promise<SaveLoanResult & { label?: string }> => {
    const [loan] = await sql<{ id: string; stage: LoanStage; amount_paise: string | null; agreement_paise: string | null }[]>`
      SELECT o.id, o.stage, o.amount_paise::text, o.agreement_paise::text
      FROM lead_loans o JOIN leads l ON l.id = o.lead_id
      WHERE o.org_id = ${o.orgId} AND o.lead_id = ${o.leadId} AND l.erased_at IS NULL FOR UPDATE OF o`;
    if (!loan) return { ok: false, message: "Record the loan first." };
    const sanctioned = loan.amount_paise === null ? null : Number(loan.amount_paise);
    const agreement = loan.agreement_paise === null ? null : Number(loan.agreement_paise);
    if (sanctioned && !agreement) return { ok: false, message: "Agreement value: record the flat's agreement value first, so the buyer's share can be worked out." };
    const [so] = await sql<{ buyer: string; bank: string }[]>`
      SELECT coalesce(sum(buyer_share_paise), 0)::text AS buyer, coalesce(sum(bank_share_paise), 0)::text AS bank
      FROM lead_loan_demands WHERE org_id = ${o.orgId} AND loan_id = ${loan.id} AND cancelled_at IS NULL`;
    const amount = o.input.amountRupees * 100;
    const split = splitDemand({
      amountPaise: amount,
      agreementPaise: agreement,
      // Only a loan the bank has said yes to pays anything.
      sanctionedPaise: loan.stage === "SANCTIONED" || loan.stage === "DISBURSING" ? sanctioned : null,
      buyerSharesSoFar: Number(so.buyer),
      bankSharesSoFar: Number(so.bank),
    });
    await sql`
      INSERT INTO lead_loan_demands (org_id, loan_id, milestone, slab_no, demand_on, amount_paise, buyer_share_paise, bank_share_paise, created_by)
      VALUES (${o.orgId}, ${loan.id}, ${o.input.milestone}, ${o.input.slabNo}, ${o.input.demandOn}, ${amount}, ${split.buyer}, ${split.bank}, ${o.userId})`;
    const label = milestoneLabel(o.input.milestone, o.input.slabNo);
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
      VALUES (${o.orgId}, ${o.leadId}, 'NOTE', ${`Demand raised: ${label}, Rs ${o.input.amountRupees.toLocaleString("en-IN")}`}, ${o.userId})`;
    return { ok: true, changed: true, label };
  });
  if (res.ok) {
    await audit({ orgId: o.orgId, actorUserId: o.userId, action: "lead.loan_demand", targetType: "lead", targetId: o.leadId, metadata: { milestone: o.input.milestone } });
  }
  return res;
}

export type DemandStep =
  | { kind: "SENT"; on: string }
  | { kind: "BANK_PAID"; on: string; amountRupees: number }
  | { kind: "BUYER_PAID"; on: string }
  | { kind: "CANCEL" };

/** One step on a demand. A bank payment may move the loan to disbursing, or to fully disbursed. */
export async function stepDemand(o: { orgId: string; userId: string; leadId: string; demandId: string; step: DemandStep; today: string }): Promise<SaveLoanResult> {
  const res = await withTenant(o.orgId, async (sql): Promise<SaveLoanResult & { line?: string; stage?: LoanStage }> => {
    const [d] = await sql<(RawDemand & { stage: LoanStage; sanctioned: string | null })[]>`
      SELECT ${sql.unsafe(DEMAND_COLS)}, o.stage, o.amount_paise::text AS sanctioned
      FROM lead_loan_demands d JOIN lead_loans o ON o.id = d.loan_id
      WHERE d.org_id = ${o.orgId} AND d.id = ${o.demandId} AND o.lead_id = ${o.leadId} FOR UPDATE OF d, o`;
    if (!d) return { ok: false, message: "That demand no longer exists." };
    const row = shapeDemand(d);
    if (row.cancelled) return { ok: false, message: "That demand was cancelled." };
    const s = o.step;
    if (s.kind !== "CANCEL" && (s.on > o.today || s.on < row.demandOn)) return { ok: false, message: "Date: between the demand's date and today." };
    const label = milestoneLabel(row.milestone, row.slabNo);
    if (s.kind === "SENT") {
      if (row.bankSharePaise === 0) return { ok: false, message: "The bank pays nothing on this demand." };
      if (row.bankPaidOn) return { ok: false, message: "The bank has already paid this demand." };
      await sql`UPDATE lead_loan_demands SET sent_to_bank_on = ${s.on}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${row.id}`;
      return { ok: true, changed: true, line: `Demand sent to the bank: ${label}` };
    }
    if (s.kind === "BANK_PAID") {
      if (row.bankSharePaise === 0) return { ok: false, message: "The bank pays nothing on this demand." };
      if (row.bankPaidOn) return { ok: false, message: "The bank's payment is already recorded." };
      const paid = s.amountRupees * 100;
      if (paid > row.bankSharePaise) return { ok: false, message: `Amount: more than the bank's share, Rs ${(row.bankSharePaise / 100).toLocaleString("en-IN")}.` };
      await sql`
        UPDATE lead_loan_demands SET bank_paid_paise = ${paid}, bank_paid_on = ${s.on},
               sent_to_bank_on = coalesce(sent_to_bank_on, ${s.on}), updated_at = now()
        WHERE org_id = ${o.orgId} AND id = ${row.id}`;
      const [t] = await sql<{ total: string }[]>`
        SELECT coalesce(sum(bank_paid_paise), 0)::text AS total FROM lead_loan_demands
        WHERE org_id = ${o.orgId} AND loan_id = ${row.loanId} AND cancelled_at IS NULL`;
      const next = stageAfterBankPaid(d.stage, d.sanctioned === null ? null : Number(d.sanctioned), Number(t.total));
      if (next !== d.stage) {
        await sql`UPDATE lead_loans SET stage = ${next}, stage_at = now(), updated_by = ${o.userId}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${row.loanId}`;
      }
      return { ok: true, changed: true, line: `Bank paid Rs ${s.amountRupees.toLocaleString("en-IN")}: ${label}`, stage: next };
    }
    if (s.kind === "BUYER_PAID") {
      if (row.buyerSharePaise === 0) return { ok: false, message: "The buyer pays nothing on this demand." };
      if (row.buyerPaidOn) return { ok: false, message: "The buyer's payment is already recorded." };
      await sql`UPDATE lead_loan_demands SET buyer_paid_on = ${s.on}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${row.id}`;
      return { ok: true, changed: true, line: `Buyer paid their share: ${label}` };
    }
    if (row.bankPaidOn || row.buyerPaidOn) return { ok: false, message: "Something was paid on this demand, so it stays." };
    await sql`UPDATE lead_loan_demands SET cancelled_at = now(), updated_at = now() WHERE org_id = ${o.orgId} AND id = ${row.id}`;
    return { ok: true, changed: true, line: `Demand cancelled: ${label}` };
  });
  if (res.ok && o.step.kind === "BANK_PAID") {
    // A partner's second half may fall due on the bank's first payment.
    const { bankPaidForLead } = await import("./partners.ts");
    await bankPaidForLead({ orgId: o.orgId, leadId: o.leadId, on: o.step.on }).catch((e) => console.warn("loans: payout half not checked,", (e as Error).message));
  }
  if (res.ok && res.line) {
    await withTenant(o.orgId, (sql) => sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
      VALUES (${o.orgId}, ${o.leadId}, 'NOTE', ${res.line!.slice(0, 200)}, ${o.userId})`);
    await audit({ orgId: o.orgId, actorUserId: o.userId, action: "lead.loan_demand_step", targetType: "lead", targetId: o.leadId, metadata: { step: o.step.kind, stage: res.stage ?? null } });
  }
  return res.ok ? { ok: true, changed: res.changed } : res;
}

/**
 * The engine heard the buyer needs a loan: on a call, or a yes to a lender
 * calling. Opens the loan as "needs a loan" when nothing is recorded, and
 * names the lender the buyer said yes to when none is named yet. Never moves
 * a loan a person already took further.
 */
export async function noteLoanInterest(o: { orgId: string; leadId: string; source: "CALL" | "LENDER_YES"; lenderId?: string | null }): Promise<void> {
  const opened = await withTenant(o.orgId, async (sql) => {
    const inserted = await sql`
      INSERT INTO lead_loans (org_id, lead_id, stage, lender_id, source)
      SELECT ${o.orgId}, ${o.leadId}, 'INTERESTED', ${o.lenderId ?? null}, ${o.source}
      WHERE EXISTS (SELECT 1 FROM leads WHERE org_id = ${o.orgId} AND id = ${o.leadId} AND erased_at IS NULL)
      ON CONFLICT (org_id, lead_id) DO NOTHING`;
    if (inserted.count) {
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason)
        VALUES (${o.orgId}, ${o.leadId}, 'NOTE',
                ${o.source === "CALL" ? "Home loan: the buyer said on the call they will take a loan" : "Home loan: the buyer said yes to a lender calling"})`;
      return true;
    }
    if (o.lenderId) {
      await sql`
        UPDATE lead_loans SET lender_id = ${o.lenderId}, updated_at = now()
        WHERE org_id = ${o.orgId} AND lead_id = ${o.leadId} AND stage = 'INTERESTED' AND lender_id IS NULL AND bank_name IS NULL`;
    }
    return false;
  });
  if (opened) {
    await audit({ orgId: o.orgId, actorUserId: null, action: "lead.loan_opened", targetType: "lead", targetId: o.leadId, metadata: { source: o.source } });
  }
}

/** Whether the buyer was ever asked about a lender, so a call does not ask twice. */
export async function lenderAsked(orgId: string, leadId: string): Promise<boolean> {
  const [r] = await withTenant(orgId, (sql) => sql<{ asked: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM lender_referrals WHERE org_id = ${orgId} AND lead_id = ${leadId})
        OR EXISTS (SELECT 1 FROM lead_tasks WHERE org_id = ${orgId} AND lead_id = ${leadId} AND purpose = 'LENDER_ASK') AS asked`);
  return !!r?.asked;
}

type QueueItem = {
  id: string;
  severity: "risk" | "warn" | "info";
  title: string;
  why: string;
  action: string;
  href: string;
  tag?: { text: string; tone: "risk" | "warn" | "ok" | "quiet" } | null;
  resolvers: string[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Today: loans refused on a booking, bank payments late, sanctions lapsing, loans stuck. Counts only. */
export async function loanQueue(orgId: string, nowIso = new Date().toISOString()): Promise<QueueItem[]> {
  try {
    const rows = await withTenant(orgId, async (sql) => {
      const loans = await sql<{ id: string; stage: LoanStage; stage_at: Date; lead_stage: string; expires_on: string | null }[]>`
        SELECT o.id, o.stage, o.stage_at, l.stage AS lead_stage, o.sanction_expires_on::text AS expires_on
        FROM lead_loans o JOIN leads l ON l.id = o.lead_id
        WHERE o.org_id = ${orgId} AND o.stage NOT IN ('DISBURSED', 'NOT_NEEDED', 'INTERESTED', 'PRE_CHECK') AND l.erased_at IS NULL`;
      const ids = loans.map((l) => l.id);
      const demands = ids.length
        ? await sql<{ loan_id: string; sent_to_bank_on: string | null; bank_paid_on: string | null; bank_share_paise: string; cancelled: boolean }[]>`
            SELECT loan_id, sent_to_bank_on::text, bank_paid_on::text, bank_share_paise::text, (cancelled_at IS NOT NULL) AS cancelled
            FROM lead_loan_demands WHERE org_id = ${orgId} AND loan_id = ANY(${ids}::uuid[]) AND bank_paid_on IS NULL`
        : [];
      return loans.map((l) => ({
        stage: l.stage,
        stageAtIso: l.stage_at.toISOString(),
        leadStage: l.lead_stage,
        expiresOn: l.expires_on,
        demands: demands
          .filter((d) => d.loan_id === l.id)
          .map((d) => ({ sentToBankOn: d.sent_to_bank_on, bankPaidOn: d.bank_paid_on, bankSharePaise: Number(d.bank_share_paise), cancelled: d.cancelled })),
      }));
    });
    const a = loanAlerts(rows, nowIso);
    const out: QueueItem[] = [];
    if (a.refusedBooked) {
      out.push({
        id: "loans-refused",
        severity: "risk",
        title: `${plural(a.refusedBooked, "buyer's home loan was", "buyers' home loans were")} rejected`,
        why: "Each has booked or is about to. Help them apply to another bank before the booking falls through.",
        action: "Open home loans",
        href: "/dashboard/loans",
        tag: { text: "Booking at risk", tone: "risk" },
        resolvers: ["loan:update"],
      });
    }
    if (a.bankLate) {
      out.push({
        id: "loans-bank-late",
        severity: "warn",
        title: `${plural(a.bankLate, "bank has", "banks have")} not paid a demand in ${BANK_OVERDUE_DAYS} days`,
        why: "Ask the bank what it is waiting for: a site inspection, the architect's certificate or a document.",
        action: "Open home loans",
        href: "/dashboard/loans",
        tag: null,
        resolvers: ["loan:update"],
      });
    }
    if (a.lapsing) {
      out.push({
        id: "loans-lapsing",
        severity: "warn",
        title: `${plural(a.lapsing, "sanction lapses", "sanctions lapse")} within a month`,
        why: "A lapsed sanction means applying again. Draw on it, or ask the bank to extend it.",
        action: "Open home loans",
        href: "/dashboard/loans",
        tag: null,
        resolvers: ["loan:update"],
      });
    }
    if (a.stuck) {
      out.push({
        id: "loans-stuck",
        severity: "info",
        title: `${plural(a.stuck, "home loan has", "home loans have")} not moved in ${LOAN_STUCK_DAYS} days`,
        why: `Still at ${LOAN_STAGE_LABEL.DOCUMENTS.toLowerCase()} or with the bank. Ask what is holding it.`,
        action: "Open home loans",
        href: "/dashboard/loans",
        tag: null,
        resolvers: ["loan:update"],
      });
    }
    return out;
  } catch (e) {
    console.error("queue: loans could not be read", e);
    return [];
  }
}

/** Every loan in reach and its demands, for the report. */
export async function loanReportData(orgId: string, scopes: string[]): Promise<{ loans: ReportLoan[]; demands: (DemandRow & { loanId: string })[] }> {
  if (!scopes.length) return { loans: [], demands: [] };
  return withTenant(orgId, async (sql) => {
    const rows = await sql<Raw[]>`
      SELECT ${sql.unsafe(COLS)}
      FROM lead_loans o
      JOIN leads l ON l.id = o.lead_id
      JOIN scope_nodes n ON n.id = l.scope_node_id
      LEFT JOIN lenders k ON k.id = o.lender_id
      WHERE o.org_id = ${orgId} AND l.erased_at IS NULL AND n.path <@ ANY(${scopes}::ltree[])
      LIMIT 5000`;
    const ids = rows.map((r) => r.id);
    const demands = ids.length
      ? (await sql<RawDemand[]>`
          SELECT ${sql.unsafe(DEMAND_COLS)} FROM lead_loan_demands d WHERE d.org_id = ${orgId} AND d.loan_id = ANY(${ids}::uuid[])`).map(shapeDemand)
      : [];
    return {
      loans: rows.map((r) => {
        const l = shape(r);
        return { id: l.id, stage: l.stage, bank: l.bank, amountPaise: l.amountPaise, reason: l.reason, expiresOn: l.expiresOn };
      }),
      demands,
    };
  });
}

// ---------------------------------------------------------------------------
// The partner told of the loan, only with the buyer's yes
// ---------------------------------------------------------------------------

/** A person records what the buyer said about telling the partner (on a call, at the site). */
export async function recordShare(o: { orgId: string; userId: string; leadId: string; yes: boolean }): Promise<SaveLoanResult> {
  const r = await withTenant(o.orgId, (sql) => sql`
    UPDATE lead_loans SET partner_share = ${o.yes ? "YES" : "NO"}, partner_share_at = now(), partner_share_source = 'PERSON',
           updated_by = ${o.userId}, updated_at = now()
    WHERE org_id = ${o.orgId} AND lead_id = ${o.leadId}`);
  if (!r.count) return { ok: false, message: "Record the loan first." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "lead.loan_share_consent", targetType: "lead", targetId: o.leadId, metadata: { yes: o.yes, via: "person" } });
  return { ok: true, changed: true };
}

/**
 * Asks the buyer on WhatsApp whether the partner who brought them may be
 * told how the loan is going. Only with the switch on and a partner holding
 * the buyer; the answer lands on the loan (`onLoanShareAnswer()`).
 */
export async function askShare(o: { orgId: string; userId: string; leadId: string }): Promise<SaveLoanResult> {
  const file = await loanFile(o.orgId, o.leadId);
  if (!file?.loan) return { ok: false, message: "Record the loan first." };
  if (!mayAskShare({ switchOn: file.shareSwitch, partner: !!file.partner, share: file.loan.partnerShare, stage: file.loan.stage })) {
    return { ok: false, message: "There is nothing to ask this buyer." };
  }
  const { sendMessage } = await import("./messaging.ts");
  const sent = await sendMessage({
    orgId: o.orgId,
    leadId: o.leadId,
    purpose: "LOAN_SHARE_ASK",
    userId: o.userId,
    extra: { advisor: file.partner! },
    buttonPayloads: [loanSharePayload(file.loan.id, true), loanSharePayload(file.loan.id, false)],
  });
  if (!sent.ok) return { ok: false, message: sent.message };
  await withTenant(o.orgId, (sql) => sql`
    UPDATE lead_loans SET partner_share = 'ASKED', updated_by = ${o.userId}, updated_at = now()
    WHERE org_id = ${o.orgId} AND id = ${file.loan!.id} AND (partner_share IS NULL OR partner_share = 'ASKED')`);
  return { ok: true, changed: true };
}

/** The buyer's tap. Only the number the loan's lead holds answers it; a yes or a no is final until a person records otherwise. */
export async function onLoanShareAnswer(o: { orgId: string; loanId: string; yes: boolean; phone: string }): Promise<"SAVED" | "IGNORED"> {
  const r = await withTenant(o.orgId, (sql) => sql<{ lead_id: string }[]>`
    UPDATE lead_loans o SET partner_share = ${o.yes ? "YES" : "NO"}, partner_share_at = now(), partner_share_source = 'WHATSAPP', updated_at = now()
    FROM leads l
    WHERE o.org_id = ${o.orgId} AND o.id = ${o.loanId} AND l.id = o.lead_id AND l.phone = ${o.phone} AND o.partner_share = 'ASKED'
    RETURNING o.lead_id`);
  if (!r.length) return "IGNORED";
  await audit({ orgId: o.orgId, actorUserId: null, action: "lead.loan_share_consent", targetType: "lead", targetId: r[0].lead_id, metadata: { yes: o.yes, via: "whatsapp" } });
  return "SAVED";
}
