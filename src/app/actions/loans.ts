"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { isUuid } from "@/lib/capture-rules";
import { readDemandAmount, readDemandForm, readLoanForm } from "@/lib/loan-rules";
import { addDemand, askShare, recordShare, saveDocuments, saveLoan, stepDemand, type DemandStep } from "@/lib/loans";
import { readBankForm } from "@/lib/bank-rules";
import { saveBank } from "@/lib/banks";
import { removeLender } from "@/lib/visit-followups";

/**
 * A buyer's home loan. `loan:update` at the lead's own tower: the loan
 * executive, and the sales roles that close.
 */

export type LoanResult = { ok: boolean; message: string };

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function mayWork(form: FormData): Promise<{ orgId: string; userId: string; leadId: string } | LoanResult> {
  const g = await requirePermission("loan:update");
  const leadId = String(form.get("leadId") ?? "");
  if (!isUuid(leadId)) return { ok: false, message: "That lead no longer exists." };
  const path = await withTenant(g.orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${g.orgId} AND l.id = ${leadId}`;
    return r?.path ?? null;
  });
  if (!path || !g.authz.canAt("loan:update", path)) return { ok: false, message: "You cannot update this buyer's loan." };
  return { orgId: g.orgId, userId: g.userId, leadId };
}

function refresh(leadId: string) {
  revalidatePath(`/dashboard/leads/${leadId}`);
  revalidatePath(`/dashboard/loans/${leadId}`);
  revalidatePath("/dashboard/loans");
}

export async function saveLoanAction(_prev: LoanResult | null, form: FormData): Promise<LoanResult> {
  const w = await mayWork(form);
  if ("ok" in w) return w;
  const input = readLoanForm({
    stage: form.get("stage"),
    lender: form.get("lender"),
    bankName: form.get("bankName"),
    amount: form.get("amount"),
    reason: form.get("reason"),
    applicant: form.get("applicant"),
    rate: form.get("rate"),
    expiresOn: form.get("expiresOn"),
    agreement: form.get("agreement"),
    arrangedBy: form.get("arrangedBy"),
  });
  if ("error" in input) return { ok: false, message: input.error };
  const r = await saveLoan({ ...w, input });
  if (!r.ok) return r;
  refresh(w.leadId);
  return { ok: true, message: r.changed ? "Saved." : "Nothing changed." };
}

export async function saveDocumentsAction(_prev: LoanResult | null, form: FormData): Promise<LoanResult> {
  const w = await mayWork(form);
  if ("ok" in w) return w;
  const ticked = form.getAll("doc").map(String).slice(0, 60);
  const r = await saveDocuments({ ...w, ticked, today: todayIst() });
  if (!r.ok) return r;
  refresh(w.leadId);
  return { ok: true, message: r.changed ? "Saved." : "Nothing changed." };
}

export async function addDemandAction(_prev: LoanResult | null, form: FormData): Promise<LoanResult> {
  const w = await mayWork(form);
  if ("ok" in w) return w;
  const input = readDemandForm(
    { milestone: form.get("milestone"), slabNo: form.get("slabNo"), demandOn: form.get("demandOn"), amount: form.get("amount") },
    todayIst(),
  );
  if ("error" in input) return { ok: false, message: input.error };
  const r = await addDemand({ ...w, input });
  if (!r.ok) return r;
  refresh(w.leadId);
  return { ok: true, message: "Demand recorded." };
}

export async function demandStepAction(_prev: LoanResult | null, form: FormData): Promise<LoanResult> {
  const w = await mayWork(form);
  if ("ok" in w) return w;
  const demandId = String(form.get("demandId") ?? "");
  if (!isUuid(demandId)) return { ok: false, message: "That demand no longer exists." };
  const today = todayIst();
  const on = String(form.get("on") ?? "").trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return { ok: false, message: "Date: choose a day." };
  const kind = String(form.get("step") ?? "");
  let step: DemandStep;
  if (kind === "SENT") step = { kind, on };
  else if (kind === "BUYER_PAID") step = { kind, on };
  else if (kind === "CANCEL") step = { kind };
  else if (kind === "BANK_PAID") {
    const raw = String(form.get("amount") ?? "").trim();
    const amountRupees = readDemandAmount(raw);
    if (amountRupees === null) return { ok: false, message: `Amount: ${raw || "nothing"} is not an amount.` };
    step = { kind, on, amountRupees };
  } else return { ok: false, message: "That is not a step on a demand." };
  const r = await stepDemand({ ...w, demandId, step, today });
  if (!r.ok) return r;
  refresh(w.leadId);
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// Banks: the developer's tie-ups, at the organisation's root.
// ---------------------------------------------------------------------------

async function mayManageBanks(): Promise<{ orgId: string; userId: string } | LoanResult> {
  const g = await requirePermission("loan:manage");
  const root = await withTenant(g.orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${g.orgId} AND kind = 'ORG' LIMIT 1`;
    return r?.path ?? null;
  });
  if (!root || !g.authz.canAt("loan:manage", root)) return { ok: false, message: "Bank tie-ups are managed for the whole company. Ask an admin." };
  return { orgId: g.orgId, userId: g.userId };
}

export async function saveBankAction(_prev: LoanResult | null, form: FormData): Promise<LoanResult> {
  const w = await mayManageBanks();
  if ("ok" in w) return w;
  const lenderId = String(form.get("lenderId") ?? "");
  const projectIds = form.getAll("project").map(String);
  const apf: Record<string, string> = {};
  for (const id of projectIds) apf[id] = String(form.get(`apf:${id}`) ?? "");
  const input = readBankForm(
    {
      name: form.get("name"),
      email: form.get("email"),
      contactName: form.get("contactName"),
      contactPhone: form.get("contactPhone"),
      rate: form.get("rate"),
      feeNote: form.get("feeNote"),
      validUntil: form.get("validUntil"),
      projectIds,
      apf,
    },
    todayIst(),
  );
  if ("error" in input) return { ok: false, message: input.error };
  const r = await saveBank({ ...w, lenderId: isUuid(lenderId) ? lenderId : null, input });
  if (!r.ok) return r;
  revalidatePath("/dashboard/loans/banks");
  return { ok: true, message: lenderId ? "Saved." : "Bank added." };
}

export async function removeBankAction(form: FormData): Promise<void> {
  const w = await mayManageBanks();
  if ("ok" in w) return;
  const id = String(form.get("lenderId") ?? "");
  if (isUuid(id)) await removeLender({ orgId: w.orgId, userId: w.userId, lenderId: id });
  revalidatePath("/dashboard/loans/banks");
}

/** Telling the partner: ask the buyer on WhatsApp, or record what they said to a person. */
export async function loanShareAction(_prev: LoanResult | null, form: FormData): Promise<LoanResult> {
  const w = await mayWork(form);
  if ("ok" in w) return w;
  const step = String(form.get("step") ?? "");
  const r = step === "ASK" ? await askShare(w) : step === "YES" || step === "NO" ? await recordShare({ ...w, yes: step === "YES" }) : null;
  if (!r) return { ok: false, message: "That is not a choice here." };
  if (!r.ok) return r;
  refresh(w.leadId);
  return { ok: true, message: step === "ASK" ? "Asked on WhatsApp." : "Saved." };
}
