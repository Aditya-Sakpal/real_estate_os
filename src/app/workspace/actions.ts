"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserOrgState } from "@/lib/onboarding";
import type { Authz } from "@/lib/rbac";
import { authzFor } from "@/lib/grant-access";
import { answerMandate, askExtension } from "@/lib/mandates";
import { resolveAuthz } from "@/lib/rbac";
import { saveProfile } from "@/lib/firm-workspace";
import { getViewer } from "@/lib/console";
import { bookForFirm, fileInvoiceForFirm, linkForFirm, registerForFirm, registerLeadForFirm, type WorkspaceResult } from "@/lib/partner-workspace";
import { halfKey } from "@/lib/partner-workspace-rules";

/**
 * A firm's own actions: a mandate firm answering an offer, a firm's record,
 * and a channel partner's work (a buyer registered, a visit booked, a link
 * made). Every action reads the firm from the session and asks the person's
 * own keys in the firm; a partner's work then asks that the developer still
 * has the firm on its desk before the developer's own function runs.
 */

type Firm = { userId: string; orgId: string; orgType: "MANDATE_FIRM" | "CHANNEL_PARTNER"; authz: Authz };

async function firm(): Promise<Firm | null> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const state = await getUserOrgState(session.user.id);
  if (state.kind !== "MEMBER" || state.via || (state.orgType !== "MANDATE_FIRM" && state.orgType !== "CHANNEL_PARTNER")) return null;
  // The same resolver as the console, so a phone session holds the same tier here.
  const { authz } = await authzFor(session.user.id, state, session.method ?? "oauth");
  return { userId: session.user.id, orgId: state.orgId, orgType: state.orgType, authz };
}

const done = () => {
  revalidatePath("/dashboard", "layout");
};

/**
 * A mandate firm answers an offer from its Developers screen. Only somebody
 * who may manage the firm answers for it; the database function then
 * refuses anything that is not this firm's own offer.
 */
export async function answerMandateAction(input: { mandateId: string; accept: boolean }): Promise<{ ok: boolean; message: string }> {
  const f = await firm();
  if (!f || f.orgType !== "MANDATE_FIRM") return { ok: false, message: "That offer is not here." };
  if (!f.authz.can("org:manage")) return { ok: false, message: "Only your firm's admin can answer an offer." };
  const res = await answerMandate({ firmOrgId: f.orgId, userId: f.userId, mandateId: input.mandateId, accept: input.accept });
  if (res.ok) done();
  return res;
}

/**
 * A mandate firm asks a developer to run a live mandate longer, from its
 * own Developers screen or from the developer's console through the
 * mandate. Asked for the firm by whoever may manage it, in the firm's own
 * roles either way; the database function refuses anything not the firm's.
 */
export async function askExtensionAction(input: { mandateId: string }): Promise<{ ok: boolean; message: string }> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const state = await getUserOrgState(session.user.id);
  if (state.kind !== "MEMBER") return { ok: false, message: "That mandate is not here." };
  const firmOrgId = state.via ? state.via.firmOrgId : state.orgType === "MANDATE_FIRM" ? state.orgId : null;
  if (!firmOrgId || (session.method ?? "oauth") === "phone") return { ok: false, message: "That mandate is not here." };
  const own = await resolveAuthz(session.user.id, firmOrgId);
  if (!own.can("org:manage")) return { ok: false, message: "Only your firm's admin can ask." };
  const res = await askExtension({ firmOrgId, userId: session.user.id, mandateId: input.mandateId });
  if (res.ok) done();
  return res;
}

export type WorkspaceFormState = { ok: boolean; message: string; errors?: Record<string, string> } | null;

export async function saveProfileAction(_: WorkspaceFormState, fd: FormData): Promise<WorkspaceFormState> {
  const f = await firm();
  if (!f) return { ok: false, message: "That firm is not here." };
  if (!f.authz.can("org:manage")) return { ok: false, message: "Only your firm's admin changes its record." };
  const text = (k: string) => String(fd.get(k) ?? "");
  const res = await saveProfile({
    orgId: f.orgId,
    userId: f.userId,
    input: { reraNo: text("reraNo"), reraTill: text("reraTill"), city: text("city"), phone: text("phone") },
    keepPhone: f.orgType === "CHANNEL_PARTNER",
  });
  if (res.ok) done();
  return res;
}

// ---------------------------------------------------------------------------
// A channel partner's work
// ---------------------------------------------------------------------------

/** The partner's own person in its own console, holding `key`; null for anybody else. */
async function partner(key: string) {
  const viewer = await getViewer();
  if (!viewer) redirect("/signin");
  if (viewer.orgType !== "CHANNEL_PARTNER" || viewer.via || !viewer.authz.can(key)) return null;
  return { orgId: viewer.state.org.id, userId: viewer.userId, name: viewer.name, authz: viewer.authz };
}

/** `<developer org>:<node>`, as the forms' selects post it. */
const pair = (raw: FormDataEntryValue | null): [string, string] | null => {
  const [a, b] = String(raw ?? "").split(":");
  return a && b ? [a, b] : null;
};

export async function registerBuyerAction(_: WorkspaceResult | null, fd: FormData): Promise<WorkspaceResult> {
  const v = await partner("partner:register");
  if (!v) return { ok: false, message: "Your role can't register buyers." };
  const where = pair(fd.get("project"));
  if (!where) return { ok: false, message: "Choose the project." };
  const phone = String(fd.get("phone") ?? "").trim();
  if (!phone) return { ok: false, message: "Enter the buyer's mobile number." };
  const res = await registerForFirm({
    cpOrgId: v.orgId,
    userId: v.userId,
    agentName: v.name,
    devOrgId: where[0],
    projectId: where[1],
    phone,
    buyerName: String(fd.get("name") ?? "").trim() || null,
  });
  done();
  return res;
}

export async function bookVisitAction(_: WorkspaceResult | null, fd: FormData): Promise<WorkspaceResult> {
  const v = await partner("partner:register");
  if (!v) return { ok: false, message: "Your role can't book visits." };
  const tower = pair(fd.get("tower"));
  if (!tower) return { ok: false, message: "Choose the tower." };
  const res = await bookForFirm({
    cpOrgId: v.orgId,
    userId: v.userId,
    devOrgId: tower[0],
    registrationId: String(fd.get("registration") ?? ""),
    towerId: tower[1],
    date: String(fd.get("date") ?? ""),
    time: String(fd.get("time") ?? ""),
  });
  if (res.ok) done();
  return res;
}

export async function makeLinkAction(input: { devOrgId: string; towerId: string }): Promise<{ ok: boolean; message: string }> {
  const v = await partner("partner:register");
  if (!v) return { ok: false, message: "Your role can't make links." };
  const res = await linkForFirm({ cpOrgId: v.orgId, userId: v.userId, devOrgId: input.devOrgId, towerId: input.towerId });
  if (!res.ok) return { ok: false, message: res.message };
  done();
  return { ok: true, message: `Your link is ready: ${res.code}.` };
}

/** One of the partner's own leads, registered with a developer from the lead's page. */
export async function registerLeadAction(input: { leadId: string; project: string }): Promise<WorkspaceResult> {
  const v = await partner("partner:register");
  if (!v) return { ok: false, message: "Your role can't register buyers." };
  const [devOrgId, projectId] = String(input?.project ?? "").split(":");
  if (!devOrgId || !projectId) return { ok: false, message: "Choose the project." };
  // A developer not on Sales Desk: the registration is emailed to it from here.
  if (devOrgId === "out") {
    const { registerOutsideLead } = await import("@/lib/outside");
    const r = await registerOutsideLead({
      orgId: v.orgId,
      userId: v.userId,
      leadId: String(input?.leadId ?? ""),
      projectId,
      mayRead: (path) => v.authz.canAt("lead:read", path),
      mayRegisterAt: (path) => v.authz.canAt("partner:register", path) || v.authz.canAt("lead:update", path),
    });
    done();
    return { ok: r.ok, message: r.message, tone: r.ok ? "ok" : "risk" };
  }
  const res = await registerLeadForFirm({
    cpOrgId: v.orgId,
    userId: v.userId,
    agentName: v.name,
    leadId: String(input?.leadId ?? ""),
    devOrgId,
    projectId,
    mayRead: (path) => v.authz.canAt("lead:read", path),
  });
  done();
  return res;
}

// ---------------------------------------------------------------------------
// A firm's own invoice, filed with a developer
// ---------------------------------------------------------------------------

/**
 * A channel partner files its brokerage invoice, or a mandate firm its
 * commission invoice, from its own console. It asks the person's keys in the
 * firm (the amounts are money, so `payout:read`, and filing is
 * `partner:register`, the desk's own key for it); the developer's side then
 * asks that the half is the firm's, owed and with nothing on file.
 */
export async function fileFirmInvoiceAction(_: WorkspaceResult | null, fd: FormData): Promise<WorkspaceResult> {
  const f = await firm();
  if (!f) return { ok: false, message: "That booking is not yours to invoice." };
  if (!f.authz.can("payout:read") || !f.authz.can("partner:register")) return { ok: false, message: "Your role can't send invoices." };
  const key = halfKey(String(fd.get("key") ?? ""));
  if (!key) return { ok: false, message: "That booking is not yours to invoice." };
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) return { ok: false, message: "Attach the invoice." };
  const text = (k: string) => String(fd.get(k) ?? "").trim();
  const res = await fileInvoiceForFirm({
    firmOrgId: f.orgId,
    userId: f.userId,
    kind: f.orgType === "CHANNEL_PARTNER" ? "PARTNER" : "MANDATE",
    devOrgId: text("devOrgId") || null,
    payoutId: text("payoutId"),
    key,
    invoiceNo: text("invoiceNo"),
    invoiceDate: text("invoiceDate"),
    amount: Number(text("amount").replace(/[^\d]/g, "")),
    bytes: Buffer.from(await file.arrayBuffer()),
    mediaType: file.type,
    today: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
  });
  if (res.ok) done();
  return res;
}
