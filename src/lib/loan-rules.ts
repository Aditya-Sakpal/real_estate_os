/**
 * A buyer's home loan, as the developer's loan executive works it.
 *
 * The loan is the bank's and the buyer's; the developer's loan desk follows
 * it: the papers, the bank, the sanction, the papers the bank needs from the
 * developer, and each demand the developer raises as the building rises,
 * split into what the buyer pays and what the bank pays. Nothing here talks
 * to a bank, and Sales Desk takes nothing from one: any payout is between
 * the developer and the bank (decided 13 October 2026). `doc/home-loan-sop.md`
 * is the research this follows, Maharashtra first.
 *
 * Pure, client-safe, covered by `check:logic`. `loans.ts` reads and writes.
 */

import type { Qualification } from "./qualification-rules.ts";

/**
 * `MIN_CONFIDENCE` in `qualification-rules.ts`, which this file cannot import:
 * that one reaches server code, and this one is the lead page's. `check:logic`
 * holds the two equal.
 */
export const LOAN_SURE = 0.5;

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export const LOAN_STAGES = [
  "INTERESTED",
  "PRE_CHECK",
  "DOCUMENTS",
  "APPLIED",
  "APPRAISAL",
  "SANCTIONED",
  "DISBURSING",
  "DISBURSED",
  "REJECTED",
  "NOT_NEEDED",
] as const;
export type LoanStage = (typeof LOAN_STAGES)[number];

export const LOAN_STAGE_LABEL: Record<LoanStage, string> = {
  INTERESTED: "Needs a loan",
  PRE_CHECK: "Eligibility checked",
  DOCUMENTS: "Collecting documents",
  APPLIED: "Applied to the bank",
  APPRAISAL: "Legal and technical check",
  SANCTIONED: "Sanctioned",
  DISBURSING: "Disbursing",
  DISBURSED: "Fully disbursed",
  REJECTED: "Rejected",
  NOT_NEEDED: "Not taking a loan",
};

export const LOAN_TONE: Record<LoanStage, "ok" | "warn" | "risk" | "quiet" | "info"> = {
  INTERESTED: "info",
  PRE_CHECK: "info",
  DOCUMENTS: "info",
  APPLIED: "warn",
  APPRAISAL: "warn",
  SANCTIONED: "ok",
  DISBURSING: "ok",
  DISBURSED: "ok",
  REJECTED: "risk",
  NOT_NEEDED: "quiet",
};

/** The list page's groups, in the order a desk works them. */
export const LOAN_GROUPS = [
  { key: "before", label: "Before sanction", stages: ["INTERESTED", "PRE_CHECK", "DOCUMENTS", "APPLIED", "APPRAISAL"] },
  { key: "sanctioned", label: "Sanctioned", stages: ["SANCTIONED"] },
  { key: "disbursing", label: "Disbursing", stages: ["DISBURSING"] },
  { key: "done", label: "Fully disbursed", stages: ["DISBURSED"] },
  { key: "closed", label: "Closed", stages: ["REJECTED", "NOT_NEEDED"] },
] as const satisfies readonly { key: string; label: string; stages: readonly LoanStage[] }[];

export const LOAN_REASONS = ["INCOME", "CREDIT", "VALUATION", "PAPERS", "PROJECT", "AGE", "OTHER"] as const;
export type LoanReason = (typeof LOAN_REASONS)[number];

export const LOAN_REASON_LABEL: Record<LoanReason, string> = {
  INCOME: "Income too low",
  CREDIT: "Credit score",
  VALUATION: "Bank valued the flat lower",
  PAPERS: "Papers incomplete",
  PROJECT: "Bank does not fund this project",
  AGE: "Age or loan term",
  OTHER: "Another reason",
};

/**
 * Where a loan may go from here. Forward along the desk's path, out to "not
 * taking a loan" before the money moves, back to the bank after a refusal
 * (another bank) or a sanction that lapsed. Disbursing is reached by the
 * bank's first payment on a demand, and a single payment for a ready flat
 * may go straight to fully disbursed. A fully disbursed loan is done; the
 * database holds it there too.
 */
const NEXT: Record<LoanStage, LoanStage[]> = {
  INTERESTED: ["PRE_CHECK", "DOCUMENTS", "APPLIED", "NOT_NEEDED"],
  PRE_CHECK: ["DOCUMENTS", "APPLIED", "NOT_NEEDED"],
  DOCUMENTS: ["APPLIED", "NOT_NEEDED"],
  APPLIED: ["APPRAISAL", "SANCTIONED", "REJECTED", "NOT_NEEDED"],
  APPRAISAL: ["SANCTIONED", "REJECTED", "NOT_NEEDED"],
  SANCTIONED: ["DISBURSING", "DISBURSED", "APPLIED", "NOT_NEEDED"],
  DISBURSING: ["DISBURSED"],
  REJECTED: ["APPLIED", "NOT_NEEDED"],
  NOT_NEEDED: ["INTERESTED"],
  DISBURSED: [],
};

/** The stages a person may choose: the one it is at (to correct the details), then where it may go. */
export function loanChoices(current: LoanStage | null): LoanStage[] {
  if (!current) return LOAN_STAGES.filter((s) => s !== "REJECTED");
  if (current === "DISBURSED") return [];
  return [current, ...NEXT[current]];
}

/** A stage that names a bank: from the application on. */
export function needsBank(s: LoanStage): boolean {
  return s === "APPLIED" || s === "APPRAISAL" || s === "SANCTIONED" || s === "DISBURSING" || s === "DISBURSED" || s === "REJECTED";
}

/** A stage that carries what the bank sanctioned. */
export function needsAmount(s: LoanStage): boolean {
  return s === "SANCTIONED" || s === "DISBURSING" || s === "DISBURSED";
}

/** A stage before the bank has said yes or no. */
export function beforeSanction(s: LoanStage): boolean {
  return s === "INTERESTED" || s === "PRE_CHECK" || s === "DOCUMENTS" || s === "APPLIED" || s === "APPRAISAL";
}

/** Rs 10 crore: no home loan in this product is larger, and a typo of an extra zero is caught. */
export const MAX_LOAN_RUPEES = 10_00_00_000;
/** Rs 1 lakh: anything smaller is a figure typed in lakhs without the word. */
export const MIN_LOAN_RUPEES = 1_00_000;
/** Rs 100 crore: the most a flat's agreement value may be here. */
export const MAX_AGREEMENT_RUPEES = 100_00_00_000;

const AMOUNT = /^(\d+(?:\.\d+)?)\s*(crores?|cr|c|lakhs?|lacs?|lac|l)?$/;

function clean(raw: string): string {
  return raw.toLowerCase().replace(/,/g, "").replace(/₹|rs\.?|inr/g, " ").trim();
}

/**
 * Rupees from one amount: "72,00,000", "72 lakh", "0.72 Cr", "₹72L". One
 * number only: a range is not an amount a bank sanctioned. A bare number
 * under a lakh is read as lakhs, the way a person types a loan.
 */
export function readLoanAmount(raw: string): number | null {
  const m = AMOUNT.exec(clean(raw));
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  const mult = !u ? (n >= 1e5 ? 1 : 1e5) : /^c/.test(u) ? 1e7 : 1e5;
  const v = Math.round(n * mult);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Rupees from a demand: the same, except a bare number is rupees. A demand
 * is copied off the developer's demand letter, which prints it in full.
 */
export function readDemandAmount(raw: string): number | null {
  const m = AMOUNT.exec(clean(raw));
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  const mult = !u ? 1 : /^c/.test(u) ? 1e7 : 1e5;
  const v = Math.round(n * mult);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** A yearly rate from "8.5", "8.5%" or "8.50 % p.a.", in basis points. */
export function readRate(raw: string): number | null {
  const m = /^(\d{1,2}(?:\.\d{1,2})?)\s*%?\s*(p\.?a\.?)?$/i.exec(raw.trim());
  if (!m) return null;
  const bp = Math.round(Number(m[1]) * 100);
  return bp >= 100 && bp <= 2500 ? bp : null;
}

export const APPLICANTS = ["SALARIED", "SELF_EMPLOYED", "NRI"] as const;
export type Applicant = (typeof APPLICANTS)[number];
export const APPLICANT_LABEL: Record<Applicant, string> = {
  SALARIED: "Salaried",
  SELF_EMPLOYED: "Self-employed",
  NRI: "NRI",
};

export type LoanInput = {
  stage: LoanStage;
  lenderId: string | null;
  bankName: string | null;
  /** What the bank sanctioned, from the sanction on. */
  amountRupees: number | null;
  reason: LoanReason | null;
  applicant: Applicant | null;
  rateBp: number | null;
  expiresOn: string | null;
  agreementRupees: number | null;
  arrangedBy: Arranger | null;
};

export type LoanRow = {
  stage: LoanStage;
  lenderId: string | null;
  bankName: string | null;
  amountPaise: number | null;
  reason: LoanReason | null;
  applicant: Applicant | null;
  rateBp: number | null;
  expiresOn: string | null;
  agreementPaise: number | null;
  arrangedBy: Arranger | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The form, read. The catalog is the filter: a stage, reason or kind of
 * buyer it does not know is refused or dropped, a lender id that is not one
 * is nothing (the server then asks whether it is one of the organisation's).
 * Every problem is named in the form's own words.
 */
export function readLoanForm(f: {
  stage?: unknown;
  lender?: unknown;
  bankName?: unknown;
  amount?: unknown;
  reason?: unknown;
  applicant?: unknown;
  rate?: unknown;
  expiresOn?: unknown;
  agreement?: unknown;
  arrangedBy?: unknown;
}): LoanInput | { error: string } {
  const stage = String(f.stage ?? "") as LoanStage;
  if (!LOAN_STAGES.includes(stage)) return { error: "Choose where the loan stands." };
  const lender = String(f.lender ?? "");
  const lenderId = UUID.test(lender) ? lender : null;
  const bankName = lender === "OTHER" ? String(f.bankName ?? "").trim().replace(/\s+/g, " ") || null : null;
  if (bankName && bankName.length > 80) return { error: "Bank: keep the name under 80 letters." };
  const amountRaw = String(f.amount ?? "").trim();
  let amountRupees: number | null = null;
  if (amountRaw && needsAmount(stage)) {
    amountRupees = readLoanAmount(amountRaw);
    if (amountRupees === null) return { error: `Sanctioned: ${amountRaw} is not an amount. Write it as 72,00,000 or 72 lakh.` };
  }
  const agreementRaw = String(f.agreement ?? "").trim();
  let agreementRupees: number | null = null;
  if (agreementRaw) {
    agreementRupees = readLoanAmount(agreementRaw);
    if (agreementRupees === null) return { error: `Agreement value: ${agreementRaw} is not an amount. Write it as 96,00,000 or 96 lakh.` };
  }
  const rateRaw = String(f.rate ?? "").trim();
  let rateBp: number | null = null;
  if (rateRaw && needsAmount(stage)) {
    rateBp = readRate(rateRaw);
    if (rateBp === null) return { error: `Rate: ${rateRaw} is not a rate. Write it as 8.5.` };
  }
  const expiresRaw = String(f.expiresOn ?? "").trim();
  const expiresOn = needsAmount(stage) && YMD.test(expiresRaw) ? expiresRaw : null;
  const reasonRaw = String(f.reason ?? "");
  const reason = (LOAN_REASONS as readonly string[]).includes(reasonRaw) ? (reasonRaw as LoanReason) : null;
  const applicantRaw = String(f.applicant ?? "");
  const applicant = (APPLICANTS as readonly string[]).includes(applicantRaw) ? (applicantRaw as Applicant) : null;
  return {
    stage,
    lenderId,
    bankName,
    amountRupees,
    reason: stage === "REJECTED" ? reason : null,
    applicant,
    rateBp,
    expiresOn,
    agreementRupees,
    arrangedBy: (ARRANGERS as readonly string[]).includes(String(f.arrangedBy ?? "")) ? (String(f.arrangedBy) as Arranger) : null,
  };
}

/** Why this change cannot be saved, or null. */
export function loanProblem(current: LoanStage | null, input: LoanInput): string | null {
  if (current === "DISBURSED") return "The loan is fully disbursed. Nothing more to record.";
  if (!loanChoices(current).includes(input.stage)) {
    return `A loan that is ${LOAN_STAGE_LABEL[current!].toLowerCase()} cannot go to ${LOAN_STAGE_LABEL[input.stage].toLowerCase()}.`;
  }
  if (needsBank(input.stage) && !input.lenderId && !input.bankName) return "Bank: choose which bank.";
  if (needsAmount(input.stage)) {
    if (input.amountRupees === null) return "Sanctioned: how much did the bank sanction?";
    if (input.amountRupees < MIN_LOAN_RUPEES) return "Sanctioned: under Rs 1,00,000. Write it in rupees, or add lakh.";
    if (input.amountRupees > MAX_LOAN_RUPEES) return "Sanctioned: over Rs 10 Cr. Check the zeros.";
  }
  if (input.agreementRupees !== null) {
    if (input.agreementRupees < MIN_LOAN_RUPEES) return "Agreement value: under Rs 1,00,000. Write it in rupees, or add lakh.";
    if (input.agreementRupees > MAX_AGREEMENT_RUPEES) return "Agreement value: over Rs 100 Cr. Check the zeros.";
    if (input.amountRupees !== null && input.amountRupees > input.agreementRupees) return "Sanctioned: more than the flat's agreement value.";
  }
  if (input.stage === "REJECTED" && !input.reason) return "Reason: why did the bank say no?";
  return null;
}

/** Nothing changed. Saving it writes nothing. */
export function loanUnchanged(row: LoanRow | null, input: LoanInput): boolean {
  if (!row) return false;
  const paise = (r: number | null) => (r === null ? null : r * 100);
  return row.stage === input.stage
    && row.lenderId === input.lenderId
    && (row.bankName ?? null) === (input.bankName ?? null)
    && (row.amountPaise ?? null) === paise(input.amountRupees)
    && (row.reason ?? null) === (input.reason ?? null)
    && (row.applicant ?? null) === (input.applicant ?? null)
    && (row.rateBp ?? null) === (input.rateBp ?? null)
    && (row.expiresOn ?? null) === (input.expiresOn ?? null)
    && (row.agreementPaise ?? null) === paise(input.agreementRupees)
    && (row.arrangedBy ?? null) === (input.arrangedBy ?? null);
}

/** The line the lead's history gets: "Home loan: Sanctioned, HDFC Bank, Rs 72,00,000". */
export function loanHistoryLine(input: LoanInput, bank: string | null): string {
  const parts = [LOAN_STAGE_LABEL[input.stage]];
  if (bank) parts.push(bank);
  if (input.amountRupees !== null) parts.push(`Rs ${input.amountRupees.toLocaleString("en-IN")}`);
  if (input.reason) parts.push(LOAN_REASON_LABEL[input.reason]);
  return `Home loan: ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------
// The engine: a call that heard "loan"
// ---------------------------------------------------------------------------

/**
 * What the call heard about paying: a buyer who said they will take a
 * loan, and said it clearly enough to count, needs one. One who already has
 * it approved still needs this flat's sanction. Own money is no loan.
 */
export function callSaysLoan(q: Qualification | null | undefined): boolean {
  const f = q?.funding;
  if (!f || f.confidence < LOAN_SURE) return false;
  return f.value === "LOAN" || f.value === "LOAN_PRE_APPROVED" || f.value === "MIXED";
}

/**
 * After a call: whether the buyer is asked on WhatsApp if a lender may call.
 * Only a buyer the call found worth working (hot or warm), who needs a loan,
 * is not already booked or lost, and was never asked. The question itself
 * asks for consent before any number is shared.
 */
export function askLenderAfterCall(o: { q: Qualification | null | undefined; route: string | null | undefined; stage: string; asked: boolean }): boolean {
  if (o.asked) return false;
  if (o.stage === "booked" || o.stage === "lost") return false;
  if (o.route !== "HOT" && o.route !== "WARM") return false;
  return callSaysLoan(o.q);
}

// ---------------------------------------------------------------------------
// The document checklist
// ---------------------------------------------------------------------------

export type DocItem = { key: string; label: string; optional?: boolean };
export type DocGroup = { key: string; label: string; items: DocItem[] };

const BUYER_ALL: DocItem[] = [
  { key: "PAN", label: "PAN" },
  { key: "AADHAAR", label: "Aadhaar" },
  { key: "PHOTO", label: "Photograph" },
  { key: "BANK_STATEMENTS", label: "Bank statements, 6 months" },
  { key: "EXISTING_LOANS", label: "Existing loan statements", optional: true },
];

const BUYER_BY_KIND: Record<Applicant, DocItem[]> = {
  SALARIED: [
    { key: "SALARY_SLIPS", label: "Salary slips, 3 months" },
    { key: "FORM_16", label: "Form 16" },
    { key: "ITR", label: "ITR, 2 years" },
  ],
  SELF_EMPLOYED: [
    { key: "ITR", label: "ITR with computation, 2 to 3 years" },
    { key: "FINANCIALS", label: "Audited or CA-certified P&L and balance sheet" },
    { key: "BUSINESS_PROOF", label: "Business proof: GST, Udyam or licence" },
  ],
  NRI: [
    { key: "PASSPORT_VISA", label: "Passport and visa" },
    { key: "WORK_PROOF", label: "Work permit or employment contract" },
    { key: "SALARY_SLIPS", label: "Overseas salary slips" },
    { key: "NRE_STATEMENTS", label: "NRE or NRO statements, 6 months" },
    { key: "POA", label: "Power of attorney, stamped in India" },
  ],
};

/** The 1% TDS under section 194-IA applies from a Rs 50 lakh price. */
export const TDS_FROM_RUPEES = 50_00_000;

/**
 * What the loan desk collects for one buyer, in the order a bank asks for
 * it (`doc/home-loan-sop.md`, sections 2 and 12b). The buyer's own papers
 * follow who they are; the flat's are Maharashtra's (a registered agreement
 * and its Index II); "Before the bank pays" is what the developer gives the
 * bank; possession comes last. The project's own pack (RERA certificate,
 * plans, CC, title report) is given to each bank once per project, not per
 * buyer, and is not here.
 */
export function docChecklist(applicant: Applicant | null, agreementRupees: number | null, extraPapers = false): DocGroup[] {
  const tds = agreementRupees !== null && agreementRupees >= TDS_FROM_RUPEES;
  return [
    {
      key: "BUYER",
      label: applicant ? `The buyer (${APPLICANT_LABEL[applicant].toLowerCase()})` : "The buyer",
      items: [...BUYER_ALL, ...(applicant ? BUYER_BY_KIND[applicant] : [])],
    },
    {
      key: "BOOKING",
      label: "Booking and payments",
      items: [
        { key: "ALLOTMENT", label: "Allotment letter" },
        { key: "COST_SHEET", label: "Cost sheet" },
        { key: "RECEIPTS", label: "Payment receipts, with bank proof" },
        ...(tds ? [{ key: "TDS", label: "TDS challans (1%)" }] : []),
      ],
    },
    {
      key: "AGREEMENT",
      label: "Registered agreement",
      items: [
        { key: "AFS", label: "Agreement for sale, registered" },
        { key: "INDEX_II", label: "Index II" },
        { key: "STAMP_DUTY", label: "Stamp duty and registration receipts" },
      ],
    },
    {
      key: "BEFORE_PAY",
      label: "Before the bank pays",
      items: [
        { key: "BUILDER_NOC", label: "Builder's NOC (permission to mortgage)" },
        { key: "LENDER_NOC", label: "Project lender's NOC, if the project is financed", optional: true },
        { key: "TPA", label: "Tripartite agreement signed" },
        ...(extraPapers ? [COLLECTION_ACCOUNT] : []),
      ],
    },
    {
      key: "POSSESSION",
      label: "At possession",
      items: [
        { key: "OC", label: "Occupancy certificate" },
        { key: "POSSESSION_LETTER", label: "Possession letter" },
      ],
    },
  ];
}

/** The documents counted towards "x of y": every one not optional, possession only once the bank is paying. */
export function docProgress(groups: DocGroup[], received: Record<string, string>, stage: LoanStage): { done: number; of: number } {
  const counted = groups
    .filter((g) => g.key !== "POSSESSION" || stage === "DISBURSING" || stage === "DISBURSED")
    .flatMap((g) => g.items.filter((i) => !i.optional));
  return { done: counted.filter((i) => !!received[i.key]).length, of: counted.length };
}

/** The keys of every document the checklist could hold, whoever the buyer is. */
export function allDocKeys(): Set<string> {
  const all = new Set<string>();
  for (const a of [null, ...APPLICANTS] as (Applicant | null)[]) {
    for (const g of docChecklist(a, MAX_AGREEMENT_RUPEES, true)) for (const i of g.items) all.add(i.key);
  }
  return all;
}

/**
 * The documents as received, from the form: a ticked key keeps the day it
 * was first ticked, a newly ticked one is today, an unticked one is dropped,
 * and a key the checklist does not know is never stored.
 */
export function nextDocuments(prev: Record<string, string>, ticked: string[], today: string): Record<string, string> {
  const known = allDocKeys();
  const out: Record<string, string> = {};
  for (const k of ticked) if (known.has(k)) out[k] = prev[k] ?? today;
  return out;
}

/** What the bank still needs before it pays anything: the registered agreement, the builder's NOC, the tripartite agreement. */
export function beforeBankPays(received: Record<string, string>): string[] {
  const need: [string, string][] = [
    ["AFS", "registered agreement"],
    ["INDEX_II", "Index II"],
    ["BUILDER_NOC", "builder's NOC"],
    ["TPA", "tripartite agreement"],
  ];
  return need.filter(([k]) => !received[k]).map(([, label]) => label);
}

// ---------------------------------------------------------------------------
// Demands: the construction-linked plan
// ---------------------------------------------------------------------------

/**
 * The MahaRERA model agreement's stages and the most a developer may have
 * demanded by each, cumulative, as a share of the agreement value (clause
 * 1(c), Annexure A to the Maharashtra RERA Rules 2017).
 */
export const MILESTONES = [
  { key: "BOOKING", label: "Booking", cap: 10 },
  { key: "AGREEMENT", label: "Agreement", cap: 30 },
  { key: "PLINTH", label: "Plinth", cap: 45 },
  { key: "SLAB", label: "Slab", cap: 70 },
  { key: "WALLS", label: "Walls, flooring and doors", cap: 75 },
  { key: "SANITARY", label: "Sanitary fittings and lift wells", cap: 80 },
  { key: "EXTERNAL", label: "External plaster and elevation", cap: 85 },
  { key: "LIFTS", label: "Lifts and services", cap: 95 },
  { key: "POSSESSION", label: "Possession", cap: 100 },
] as const;
export type Milestone = (typeof MILESTONES)[number]["key"];

export function milestoneLabel(m: Milestone, slabNo: number | null): string {
  const label = MILESTONES.find((x) => x.key === m)!.label;
  return m === "SLAB" && slabNo ? `${label} ${slabNo}` : label;
}

export type DemandInput = { milestone: Milestone; slabNo: number | null; demandOn: string; amountRupees: number };

/** Rs 1,000: a demand smaller than this is a typo. */
export const MIN_DEMAND_RUPEES = 1_000;

export function readDemandForm(f: { milestone?: unknown; slabNo?: unknown; demandOn?: unknown; amount?: unknown }, today: string): DemandInput | { error: string } {
  const milestone = String(f.milestone ?? "") as Milestone;
  if (!MILESTONES.some((m) => m.key === milestone)) return { error: "Stage: choose which stage this demand is for." };
  let slabNo: number | null = null;
  if (milestone === "SLAB") {
    const n = Number(String(f.slabNo ?? "").trim());
    if (!Number.isInteger(n) || n < 1 || n > 200) return { error: "Slab: which slab, as a number?" };
    slabNo = n;
  }
  const demandOn = String(f.demandOn ?? "").trim();
  if (!YMD.test(demandOn)) return { error: "Date: when was the demand raised?" };
  if (demandOn > today) return { error: "Date: a demand cannot be dated after today." };
  const raw = String(f.amount ?? "").trim();
  const amountRupees = readDemandAmount(raw);
  if (amountRupees === null) return { error: `Amount: ${raw || "nothing"} is not an amount. Copy it off the demand letter, as 4,80,000.` };
  if (amountRupees < MIN_DEMAND_RUPEES) return { error: "Amount: under Rs 1,000. Check the figure." };
  if (amountRupees > MAX_AGREEMENT_RUPEES) return { error: "Amount: over Rs 100 Cr. Check the zeros." };
  return { milestone, slabNo, demandOn, amountRupees };
}

/**
 * Who pays a demand. The buyer's own contribution (the agreement value less
 * what the bank sanctioned) is paid first; once it is spent the bank pays
 * each demand in full, up to what is left of the loan, and anything past
 * that is the buyer's again (`doc/home-loan-sop.md`, 6d). Before a sanction
 * the buyer pays everything. In paise.
 */
export function splitDemand(o: {
  amountPaise: number;
  agreementPaise: number | null;
  sanctionedPaise: number | null;
  buyerSharesSoFar: number;
  bankSharesSoFar: number;
}): { buyer: number; bank: number } {
  if (!o.sanctionedPaise || !o.agreementPaise) return { buyer: o.amountPaise, bank: 0 };
  const own = Math.max(0, o.agreementPaise - o.sanctionedPaise);
  const ownLeft = Math.max(0, own - o.buyerSharesSoFar);
  const first = Math.min(o.amountPaise, ownLeft);
  const undrawn = Math.max(0, o.sanctionedPaise - o.bankSharesSoFar);
  const bank = Math.min(o.amountPaise - first, undrawn);
  return { buyer: o.amountPaise - bank, bank };
}

/**
 * A demand past MahaRERA's cumulative cap for its stage, or null. A warning:
 * the demand letter is the developer's, and the desk records what it says.
 * Half a per cent of give, for rounding on the letter.
 */
export function capWarning(m: Milestone, cumulativePaise: number, agreementPaise: number | null): string | null {
  if (!agreementPaise) return null;
  const cap = MILESTONES.find((x) => x.key === m)!.cap;
  const pct = (cumulativePaise / agreementPaise) * 100;
  if (pct <= cap + 0.5) return null;
  return `Demands so far are ${pct.toFixed(1)}% of the agreement value, past MahaRERA's ${cap}% by ${MILESTONES.find((x) => x.key === m)!.label.toLowerCase()}.`;
}

/** A bank part sent this many days ago and not paid is overdue. */
export const BANK_OVERDUE_DAYS = 15;

export type DemandRow = {
  id: string;
  milestone: Milestone;
  slabNo: number | null;
  demandOn: string;
  amountPaise: number;
  buyerSharePaise: number;
  bankSharePaise: number;
  sentToBankOn: string | null;
  bankPaidPaise: number | null;
  bankPaidOn: string | null;
  buyerPaidOn: string | null;
  cancelled: boolean;
};

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Where the bank's part of a demand stands, in words, and whether it is late. */
export function bankPart(d: DemandRow, today: string): { text: string; tone: "ok" | "warn" | "risk" | "quiet" } | null {
  if (d.bankSharePaise === 0) return null;
  if (d.bankPaidOn) return { text: "Bank paid", tone: "ok" };
  if (!d.sentToBankOn) return { text: "Not sent to the bank", tone: "warn" };
  const days = daysBetween(d.sentToBankOn, today);
  return days > BANK_OVERDUE_DAYS
    ? { text: `With the bank ${days} days`, tone: "risk" }
    : { text: days === 0 ? "Sent to the bank today" : `With the bank ${days} ${days === 1 ? "day" : "days"}`, tone: "quiet" };
}

/** The loan's money, from its demands: the buyer's share and the bank's, owed and paid. In paise. */
export function loanSums(demands: DemandRow[], sanctionedPaise: number | null, agreementPaise: number | null) {
  const live = demands.filter((d) => !d.cancelled);
  const sum = (f: (d: DemandRow) => number) => live.reduce((n, d) => n + f(d), 0);
  const bankPaid = sum((d) => d.bankPaidPaise ?? 0);
  return {
    demanded: sum((d) => d.amountPaise),
    buyerDemanded: sum((d) => d.buyerSharePaise),
    buyerPaid: sum((d) => (d.buyerPaidOn ? d.buyerSharePaise : 0)),
    bankDemanded: sum((d) => d.bankSharePaise),
    bankPaid,
    /** The buyer's own contribution: the agreement value less the loan. */
    own: sanctionedPaise && agreementPaise ? Math.max(0, agreementPaise - sanctionedPaise) : null,
    undrawn: sanctionedPaise ? Math.max(0, sanctionedPaise - bankPaid) : null,
  };
}

/**
 * The stage a bank payment moves the loan to: the first payment starts
 * disbursing, and the payment that draws the whole loan finishes it.
 */
export function stageAfterBankPaid(stage: LoanStage, sanctionedPaise: number | null, bankPaidTotal: number): LoanStage {
  if (stage !== "SANCTIONED" && stage !== "DISBURSING") return stage;
  if (sanctionedPaise && bankPaidTotal >= sanctionedPaise) return "DISBURSED";
  return bankPaidTotal > 0 ? "DISBURSING" : stage;
}

// ---------------------------------------------------------------------------
// What needs a person
// ---------------------------------------------------------------------------

/** A loan with no change in this many days, while waiting on the bank or the buyer, is stuck. */
export const LOAN_STUCK_DAYS = 10;
/** A sanction lapsing within this many days is to be used or renewed. */
export const SANCTION_WARN_DAYS = 30;

export type LoanForAlerts = {
  stage: LoanStage;
  stageAtIso: string;
  leadStage: string;
  expiresOn: string | null;
  demands: Pick<DemandRow, "sentToBankOn" | "bankPaidOn" | "bankSharePaise" | "cancelled">[];
};

/** Why one loan needs somebody today, or null. The worst first. */
export function loanFlag(l: LoanForAlerts, nowIso: string): { kind: "REFUSED" | "BANK_LATE" | "LAPSING" | "STUCK"; text: string } | null {
  if (l.leadStage === "lost") return null;
  const today = nowIso.slice(0, 10);
  if (l.stage === "REJECTED" && (l.leadStage === "booked" || l.leadStage === "negotiation")) {
    return { kind: "REFUSED", text: "Rejected on a booked buyer. Try another bank" };
  }
  const late = l.demands.filter((d) => !d.cancelled && d.bankSharePaise > 0 && !d.bankPaidOn && d.sentToBankOn && daysBetween(d.sentToBankOn, today) > BANK_OVERDUE_DAYS);
  if (late.length) return { kind: "BANK_LATE", text: `Bank has not paid a demand in ${BANK_OVERDUE_DAYS} days` };
  if ((l.stage === "SANCTIONED" || l.stage === "DISBURSING") && l.expiresOn) {
    const left = daysBetween(today, l.expiresOn);
    if (left <= SANCTION_WARN_DAYS) return { kind: "LAPSING", text: left < 0 ? "Sanction has lapsed" : `Sanction lapses in ${left} ${left === 1 ? "day" : "days"}` };
  }
  if ((l.stage === "DOCUMENTS" || l.stage === "APPLIED" || l.stage === "APPRAISAL") && Date.parse(l.stageAtIso) < Date.parse(nowIso) - LOAN_STUCK_DAYS * 86_400_000) {
    return { kind: "STUCK", text: `No change in ${LOAN_STUCK_DAYS} days` };
  }
  return null;
}

/** What Today says about loans, as counts. */
export function loanAlerts(loans: LoanForAlerts[], nowIso: string): { refusedBooked: number; bankLate: number; lapsing: number; stuck: number } {
  const out = { refusedBooked: 0, bankLate: 0, lapsing: 0, stuck: 0 };
  for (const l of loans) {
    const f = loanFlag(l, nowIso);
    if (f?.kind === "REFUSED") out.refusedBooked++;
    if (f?.kind === "BANK_LATE") out.bankLate++;
    if (f?.kind === "LAPSING") out.lapsing++;
    if (f?.kind === "STUCK") out.stuck++;
  }
  return out;
}

/** The next thing to do on a loan, in a few words, for the list. */
export function nextStep(o: { stage: LoanStage; docs: { done: number; of: number }; beforePay: string[]; unsent: number }): string {
  switch (o.stage) {
    case "INTERESTED":
      return "Check eligibility";
    case "PRE_CHECK":
    case "DOCUMENTS":
      return o.docs.done < o.docs.of ? `${o.docs.of - o.docs.done} documents to collect` : "Apply to the bank";
    case "APPLIED":
    case "APPRAISAL":
      return "Waiting on the bank";
    case "SANCTIONED":
      return o.beforePay.length ? `Needs ${o.beforePay[0]}` : o.unsent ? "Send the demand to the bank" : "Waiting on the next demand";
    case "DISBURSING":
      return o.unsent ? "Send the demand to the bank" : "Waiting on the next demand";
    case "DISBURSED":
      return "Done";
    case "REJECTED":
      return "Try another bank";
    case "NOT_NEEDED":
      return "Paying from own funds";
  }
}

// ---------------------------------------------------------------------------
// The loan desk's report
// ---------------------------------------------------------------------------

export type ReportLoan = {
  id: string;
  stage: LoanStage;
  bank: string | null;
  amountPaise: number | null;
  reason: LoanReason | null;
  expiresOn: string | null;
};

/**
 * What a sales or CRM head reads about the loan desk (`doc/home-loan-sop.md`,
 * section 10): the loans by stage and by bank, the money demanded against
 * the money in, the bank's parts waiting and for how long, the refusals by
 * reason, and the sanctions about to lapse. In paise.
 */
export function loanReport(loans: ReportLoan[], demands: (DemandRow & { loanId: string })[], today: string) {
  const live = demands.filter((d) => !d.cancelled);
  const stages = LOAN_GROUPS.map((g) => {
    const mine = loans.filter((l) => (g.stages as readonly string[]).includes(l.stage));
    return { key: g.key, label: g.label, count: mine.length, sanctionedPaise: mine.reduce((n, l) => n + (needsAmount(l.stage) ? l.amountPaise ?? 0 : 0), 0) };
  });
  const banks = [...new Set(loans.map((l) => l.bank).filter((b): b is string => !!b))].sort();
  const byBank = banks.map((bank) => {
    const mine = loans.filter((l) => l.bank === bank);
    const ids = new Set(mine.map((l) => l.id));
    const paid = live.filter((d) => ids.has(d.loanId) && d.bankPaidOn && d.sentToBankOn);
    const days = paid.map((d) => daysBetween(d.sentToBankOn!, d.bankPaidOn!));
    return {
      bank,
      loans: mine.length,
      open: mine.filter((l) => !["DISBURSED", "REJECTED", "NOT_NEEDED"].includes(l.stage)).length,
      sanctioned: mine.filter((l) => needsAmount(l.stage)).length,
      sanctionedPaise: mine.reduce((n, l) => n + (needsAmount(l.stage) ? l.amountPaise ?? 0 : 0), 0),
      bankPaidPaise: live.filter((d) => ids.has(d.loanId)).reduce((n, d) => n + (d.bankPaidPaise ?? 0), 0),
      rejected: mine.filter((l) => l.stage === "REJECTED").length,
      daysToPay: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null,
    };
  });
  const waiting = live.filter((d) => d.bankSharePaise > 0 && !d.bankPaidOn);
  const bucket = (lo: number, hi: number) => {
    const ds = waiting.filter((d) => d.sentToBankOn && daysBetween(d.sentToBankOn, today) >= lo && daysBetween(d.sentToBankOn, today) <= hi);
    return { count: ds.length, paise: ds.reduce((n, d) => n + d.bankSharePaise, 0) };
  };
  const unsent = waiting.filter((d) => !d.sentToBankOn);
  const money = {
    demanded: live.reduce((n, d) => n + d.amountPaise, 0),
    buyerShare: live.reduce((n, d) => n + d.buyerSharePaise, 0),
    buyerPaid: live.reduce((n, d) => n + (d.buyerPaidOn ? d.buyerSharePaise : 0), 0),
    bankShare: live.reduce((n, d) => n + d.bankSharePaise, 0),
    bankPaid: live.reduce((n, d) => n + (d.bankPaidPaise ?? 0), 0),
  };
  const ageing = [
    { label: "Not sent yet", count: unsent.length, paise: unsent.reduce((n, d) => n + d.bankSharePaise, 0) },
    { label: `Up to ${BANK_OVERDUE_DAYS} days`, ...bucket(0, BANK_OVERDUE_DAYS) },
    { label: `${BANK_OVERDUE_DAYS + 1} to 30 days`, ...bucket(BANK_OVERDUE_DAYS + 1, 30) },
    { label: "Over 30 days", ...bucket(31, 100_000) },
  ];
  const rejections = LOAN_REASONS.map((r) => ({ reason: r, label: LOAN_REASON_LABEL[r], count: loans.filter((l) => l.stage === "REJECTED" && l.reason === r).length })).filter((r) => r.count > 0);
  const lapsing = loans.filter((l) => (l.stage === "SANCTIONED" || l.stage === "DISBURSING") && l.expiresOn && daysBetween(today, l.expiresOn) <= SANCTION_WARN_DAYS).length;
  return { stages, byBank, money, ageing, rejections, lapsing };
}

/**
 * What a channel partner is told about its own buyer's home loan: where it
 * stands, in a few words, and nothing else. Never the bank, the amount, the
 * documents or why a bank said no: those are the buyer's finances. A
 * partner's second half usually waits on the money coming in, so this is
 * what tells it when.
 */
export function partnerLoanLine(stage: LoanStage | null): string | null {
  if (!stage) return null;
  if (stage === "REJECTED") return "Home loan: not approved yet";
  if (stage === "NOT_NEEDED") return "Paying without a loan";
  if (beforeSanction(stage)) return "Home loan: in progress";
  return `Home loan: ${LOAN_STAGE_LABEL[stage].toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Who arranges the loan, and what a partner may be told
// ---------------------------------------------------------------------------

export const ARRANGERS = ["DEVELOPER", "BUYER", "PARTNER", "MANDATE"] as const;
export type Arranger = (typeof ARRANGERS)[number];
export const ARRANGER_LABEL: Record<Arranger, string> = {
  DEVELOPER: "Our tie-up bank",
  BUYER: "Buyer's own bank",
  PARTNER: "The channel partner",
  MANDATE: "The mandate firm",
};

/**
 * A bank that has not approved the project checks the title and the plans
 * itself, and needs the developer's NOC, the project lender's NOC, a
 * tripartite agreement and the project's MahaRERA collection account before
 * it pays (`doc/home-loan-partners.md`, section 4). So the loan file asks
 * for more, and says why the loan may take longer.
 */
export function needsExtraPapers(o: { approvedBank: boolean; hasBank: boolean }): boolean {
  return o.hasBank && !o.approvedBank;
}

/** The extra item a bank outside the project's approved list needs. */
export const COLLECTION_ACCOUNT: DocItem = { key: "COLLECTION_ACCOUNT", label: "Project's collection account given to the bank" };

export type PartnerShare = "ASKED" | "YES" | "NO";

/**
 * Whether a partner sees its buyer's loan stage: only when the developer
 * switched it on and the buyer said yes. A buyer asked and not answering,
 * or never asked, is a no.
 */
export function partnerMaySee(o: { switchOn: boolean; share: PartnerShare | null }): boolean {
  return o.switchOn && o.share === "YES";
}

/** Whether the loan executive may ask the buyer: the switch is on, a partner holds the buyer, and nobody asked yet or the last ask went unanswered. */
export function mayAskShare(o: { switchOn: boolean; partner: boolean; share: PartnerShare | null; stage: LoanStage }): boolean {
  if (!o.switchOn || !o.partner) return false;
  if (o.stage === "NOT_NEEDED") return false;
  return o.share === null || o.share === "ASKED";
}

export function loanSharePayload(loanId: string, yes: boolean): string {
  return `loanshare:${loanId}:${yes ? "yes" : "no"}`;
}

export function readLoanSharePayload(raw: string | null | undefined): { loanId: string; yes: boolean } | null {
  const m = /^loanshare:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(yes|no)$/i.exec((raw ?? "").trim());
  return m ? { loanId: m[1].toLowerCase(), yes: m[2].toLowerCase() === "yes" } : null;
}

// ---------------------------------------------------------------------------
// A partner's second half, on the bank's money
// ---------------------------------------------------------------------------

export type SecondHalf = "COLLECTED" | "COLLECTED_OR_BANK";
export const SECOND_HALF_LABEL: Record<SecondHalf, string> = {
  COLLECTED: "When the share of the price is collected",
  COLLECTED_OR_BANK: "When it is collected or the bank first pays, whichever is earlier",
};

/**
 * The day a partner's second half falls due: the day the share of the
 * price was collected, or, where the project's terms say so, the bank's
 * first payment on the buyer's loan if that came first (Shriram's wording;
 * `doc/home-loan-partners.md`, section 3). Null while neither happened.
 */
export function secondHalfDue(o: { rule: SecondHalf; collectedOn: string | null; firstBankPaidOn: string | null }): string | null {
  if (o.rule === "COLLECTED" || !o.firstBankPaidOn) return o.collectedOn;
  if (!o.collectedOn) return o.firstBankPaidOn;
  return o.collectedOn < o.firstBankPaidOn ? o.collectedOn : o.firstBankPaidOn;
}
