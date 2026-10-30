"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { requireAnyPermission, requirePermission } from "@/lib/guard";
import {
  addAgent,
  agentFirm,
  changeGrant,
  deskOf,
  empanelFirm,
  findRegistrations,
  fileInvoice,
  grantProjects,
  isId,
  linkPath,
  makeLink,
  mandateFor,
  moveMilestone,
  payoutPath,
  readFirm,
  recordBookingDates,
  registerBuyer,
  removeAgent,
  retireLink,
  revealRegistration,
  saveSettings,
  saveTerms,
  setPassBack,
  updateFirm,
  type GrantAction,
  type MilestoneMove,
} from "@/lib/partners";
import { bookPartnerVisit } from "@/lib/lead-engine";
import { isCrossProject, isLadderPeriod, isRejectReason, parseSteps, type LadderPeriod, type Terms } from "@/lib/partner-rules";
import { deskOwns, type Desk } from "@/lib/grant-rules";
import { firmPeople } from "@/lib/grant-access";
import { longDay } from "@/lib/mandate-rules";

/**
 * The partner desk's actions. Each names a permission and checks it at the
 * node it touches: a relationship manager for one region empanels onto that
 * region's projects and nowhere else. Every id from the form is read back
 * inside the tenant before anything is written.
 *
 * Each also asks the desk. The developer works its own partners; a mandate
 * firm working through its mandate works the partners it empanelled, and
 * neither reaches the other's, whatever key either holds.
 */

export type PartnerFormState = { ok: boolean; message: string; errors?: Record<string, string> } | null;

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function pathsOf(orgId: string, ids: string[], kind: "PROJECT" | "PHASE"): Promise<Map<string, string>> {
  const clean = ids.filter(isId);
  if (!clean.length) return new Map();
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; path: string }[]>`
    SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = ${kind} AND id = ANY(${clean})`);
  return new Map(rows.map((r) => [r.id, r.path]));
}

async function firmPaths(orgId: string, firmId: string): Promise<string[] | null> {
  if (!isId(firmId)) return null;
  return withTenant(orgId, async (sql) => {
    const [f] = await sql<{ cp_org_id: string }[]>`SELECT cp_org_id FROM partner_firms WHERE org_id = ${orgId} AND id = ${firmId}`;
    if (!f) return null;
    const rows = await sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM grants g JOIN scope_nodes n ON n.id = g.scope_node_id
      WHERE g.org_id = ${orgId} AND g.grantee_org_id = ${f.cp_org_id}`;
    return rows.map((r) => r.path);
  });
}

async function rootPath(orgId: string): Promise<string> {
  const [r] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
    SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`);
  return r?.path ?? "";
}

const done = () => revalidatePath("/dashboard/partners");

type Kind = Parameters<typeof deskOf>[1];

/** Whether the row is on the desk this person works from. */
async function onMyDesk(g: { orgId: string; desk: Desk }, kind: Kind, id: string): Promise<boolean> {
  const d = await deskOf(g.orgId, kind, id);
  return !!d && deskOwns(g.desk, d.mandateId);
}

/** Who may look after a firm: the developer's members, or a mandate firm's own people. */
async function rmChoices(g: { via?: { firmOrgId: string } }): Promise<string[] | undefined> {
  return g.via ? (await firmPeople(g.via.firmOrgId)).map((p) => p.id) : undefined;
}

// ---------------------------------------------------------------------------
// Firms and their empanelment
// ---------------------------------------------------------------------------

export async function empanelAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const g = await requirePermission("partner:empanel");
  const projectIds = fd.getAll("projectId").map(String);
  const paths = await pathsOf(g.orgId, projectIds, "PROJECT");
  // Every problem at once, the firm's fields and the projects together.
  const read = readFirm(Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])));
  const errors = { ...(read.ok ? {} : read.errors), ...(projectIds.length ? {} : { projects: "Choose at least one project." }) };
  if (Object.keys(errors).length || !read.ok) return { ok: false, message: "Check the highlighted fields.", errors };
  if ([...paths.values()].some((p) => !g.authz.canAt("partner:empanel", p)) || paths.size !== new Set(projectIds).size) {
    return { ok: false, message: "You cannot empanel on one of those projects." };
  }
  const under = await mandateFor(g.orgId, g.desk, projectIds);
  if (!under.ok) return { ok: false, message: under.message, errors: { projects: under.message } };
  const validTo = text(fd, "validTo");
  if (under.lastDay && validTo > under.lastDay) {
    const said = `Your mandate ends on ${longDay(under.lastDay)}. Pick that day or earlier.`;
    return { ok: false, message: said, errors: { validTo: said } };
  }
  const res = await empanelFirm({
    orgId: g.orgId,
    userId: g.userId,
    firm: read.firm,
    rmId: text(fd, "rmId") || null,
    projectIds,
    validTo,
    mandateId: under.mandateId,
    rmChoices: await rmChoices(g),
  });
  if (res.ok) done();
  return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.message, errors: res.errors };
}

export async function updateFirmAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const g = await requirePermission("partner:empanel");
  const firmId = text(fd, "firmId");
  if (!(await onMyDesk(g, "firm", firmId))) return { ok: false, message: "That firm is not on your desk." };
  if (!(await mayManageFirm(g, firmId, "partner:empanel"))) return { ok: false, message: "You cannot change this firm." };
  const read = readFirm(Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])));
  if (!read.ok) return { ok: false, message: "Check the highlighted fields.", errors: read.errors };
  const res = await updateFirm({ orgId: g.orgId, userId: g.userId, firmId, firm: read.firm, rmId: text(fd, "rmId") || null, rmChoices: await rmChoices(g) });
  if (res.ok) done();
  return res;
}

export async function grantProjectsAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const g = await requirePermission("partner:empanel");
  const projectIds = fd.getAll("projectId").map(String);
  const paths = await pathsOf(g.orgId, projectIds, "PROJECT");
  if (!projectIds.length) return { ok: false, message: "Choose at least one project." };
  if (paths.size !== new Set(projectIds).size || [...paths.values()].some((p) => !g.authz.canAt("partner:empanel", p))) {
    return { ok: false, message: "You cannot empanel on one of those projects." };
  }
  const firmId = text(fd, "firmId");
  const desk = await deskOf(g.orgId, "firm", firmId);
  if (!desk || !deskOwns(g.desk, desk.mandateId)) return { ok: false, message: "That firm is not on your desk." };
  const under = await mandateFor(g.orgId, g.desk, projectIds, desk.mandateId);
  if (!under.ok) return { ok: false, message: under.message };
  const validTo = text(fd, "validTo");
  if (under.lastDay && validTo > under.lastDay) return { ok: false, message: `Your mandate ends on ${longDay(under.lastDay)}. Pick that day or earlier.` };
  const res = await grantProjects({ orgId: g.orgId, userId: g.userId, firmId, projectIds, validTo });
  if (res.ok) done();
  return res;
}

export async function changeGrantAction(input: { grantId: string; kind: GrantAction["kind"]; reason?: string; validTo?: string }): Promise<{ ok: boolean; message: string }> {
  const key = input.kind === "suspend" || input.kind === "restore" ? "partner:suspend" : "partner:empanel";
  const g = await requirePermission(key);
  if (!isId(input.grantId)) return { ok: false, message: "That empanelment is not here." };
  const [row] = await withTenant(g.orgId, (sql) => sql<{ path: string }[]>`
    SELECT n.path::text AS path FROM grants x JOIN scope_nodes n ON n.id = x.scope_node_id
    WHERE x.org_id = ${g.orgId} AND x.id = ${input.grantId}`);
  if (!row || !g.authz.canAt(key, row.path) || !(await onMyDesk(g, "grant", input.grantId))) return { ok: false, message: "You cannot change this empanelment." };
  if (input.kind === "renew" && g.desk.kind === "MANDATE") {
    const [m] = await withTenant(g.orgId, (sql) => sql<{ last: string }[]>`
      SELECT to_char((m.valid_to - interval '1 second') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS last
      FROM grants x JOIN mandates m ON m.id = x.mandate_id WHERE x.org_id = ${g.orgId} AND x.id = ${input.grantId}`);
    if (m && String(input.validTo ?? "") > m.last) return { ok: false, message: `Your mandate ends on ${longDay(m.last)}. Pick that day or earlier.` };
  }
  const action: GrantAction =
    input.kind === "suspend"
      ? { kind: "suspend", reason: String(input.reason ?? "") }
      : input.kind === "renew"
        ? { kind: "renew", validTo: String(input.validTo ?? "") }
        : input.kind === "restore"
          ? { kind: "restore" }
          : { kind: "end" };
  const res = await changeGrant({ orgId: g.orgId, userId: g.userId, grantId: input.grantId, action });
  if (res.ok) done();
  return res;
}

export async function saveTermsAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const g = await requirePermission("partner:empanel");
  const projectId = text(fd, "projectId");
  const path = (await pathsOf(g.orgId, [projectId], "PROJECT")).get(projectId);
  if (!path || !g.authz.canAt("partner:empanel", path)) return { ok: false, message: "You cannot set terms on this project." };
  const under = await mandateFor(g.orgId, g.desk, [projectId]);
  if (!under.ok) return { ok: false, message: under.message };
  const froms = fd.getAll("stepFrom").map((x) => Number(x));
  const rates = fd.getAll("stepRate").map((x) => Number(String(x).replace(/%/g, "")) / 100);
  const steps = parseSteps(froms.map((from, i) => ({ from, rate: rates[i] })).filter((s) => Number.isFinite(s.from) && s.rate > 0));
  if (!steps) return { ok: false, message: "Each step starts after the one before it, and never pays less." };
  const terms: Terms = {
    steps,
    passBackMax: Number(text(fd, "passBackMax").replace(/%/g, "")) / 100,
    registrationDays: Number(text(fd, "registrationDays")),
    visitExtendsDays: Number(text(fd, "visitExtendsDays")),
    ...(isLadderPeriod(text(fd, "ladderPeriod")) ? { ladderPeriod: text(fd, "ladderPeriod") as LadderPeriod } : {}),
    ...(text(fd, "secondHalf") === "COLLECTED" || text(fd, "secondHalf") === "COLLECTED_OR_BANK"
      ? { secondHalf: text(fd, "secondHalf") as "COLLECTED" | "COLLECTED_OR_BANK" }
      : {}),
  };
  const res = await saveTerms({ orgId: g.orgId, userId: g.userId, projectId, terms, mandateId: under.mandateId });
  if (res.ok) done();
  return res;
}

export async function saveSettingsAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const g = await requirePermission("org:manage");
  if (g.via) return { ok: false, message: "Only the developer sets this." };
  const dial = text(fd, "dialPolicy") === "LOGGED" ? "LOGGED" : "AFTER_VISIT";
  const cross = text(fd, "crossProject");
  const direct = text(fd, "directWins");
  const res = await saveSettings({
    orgId: g.orgId,
    userId: g.userId,
    settings: {
      dialPolicy: dial,
      dailyRegistrations: Number(text(fd, "dailyRegistrations")),
      ...(isCrossProject(cross) ? { crossProject: cross } : {}),
      ...(fd.has("clawback") ? { clawback: text(fd, "clawback") === "ON" } : {}),
      ...(direct === "ENQUIRY" || direct === "VISIT" ? { directWins: direct } : {}),
      ...(fd.has("shareLoanStage") ? { shareLoanStage: text(fd, "shareLoanStage") === "ON" } : {}),
    },
  });
  if (res.ok) done();
  return res;
}

// ---------------------------------------------------------------------------
// Registration and the partner's visit
// ---------------------------------------------------------------------------

export type RegisterState = { ok: boolean; message: string; verdict?: string } | null;

export async function registerAction(_: RegisterState, fd: FormData): Promise<RegisterState> {
  const g = await requirePermission("partner:register");
  const projectId = text(fd, "projectId");
  const path = (await pathsOf(g.orgId, [projectId], "PROJECT")).get(projectId);
  if (!path || !g.authz.canAt("partner:register", path)) return { ok: false, message: "You cannot register buyers on this project." };
  if (!(await onMyDesk(g, "firm", text(fd, "firmId")))) return { ok: false, message: "That firm is not on your desk." };
  const res = await registerBuyer({
    orgId: g.orgId,
    userId: g.userId,
    firmId: text(fd, "firmId"),
    projectId,
    phone: text(fd, "phone"),
    buyerName: text(fd, "buyerName") || null,
    agentName: text(fd, "agentName") || null,
    via: "CONSOLE",
  });
  if (!res.ok) return res;
  done();
  return { ok: res.verdict === "REGISTERED", message: res.message, verdict: res.verdict };
}

export async function bookPartnerVisitAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const g = await requirePermission("visit:schedule");
  const phaseId = text(fd, "phaseId");
  const path = (await pathsOf(g.orgId, [phaseId], "PHASE")).get(phaseId);
  if (!path || !g.authz.canAt("visit:schedule", path)) return { ok: false, message: "You cannot book visits at this tower." };
  if (!(await onMyDesk(g, "registration", text(fd, "registrationId")))) return { ok: false, message: "That buyer is not on your desk." };
  const res = await bookPartnerVisit({
    orgId: g.orgId,
    userId: g.userId,
    registrationId: text(fd, "registrationId"),
    phaseId,
    date: text(fd, "date"),
    time: text(fd, "time"),
  });
  if (res.ok) {
    done();
    revalidatePath("/dashboard/visits");
    revalidatePath("/dashboard/leads");
  }
  return { ok: res.ok, message: res.message };
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

async function payoutGuard(key: string, kind: "payout" | "milestone", id: string) {
  const g = await requirePermission(key);
  const path = await payoutPath(g.orgId, kind, id);
  if (!path || !g.authz.canAt(key, path) || !(await onMyDesk(g, kind, id))) return null;
  return g;
}

export async function bookingDatesAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const payoutId = text(fd, "payoutId");
  const g = await payoutGuard("payout:approve", "payout", payoutId);
  if (!g) return { ok: false, message: "You cannot change this booking." };
  const res = await recordBookingDates({
    orgId: g.orgId,
    userId: g.userId,
    payoutId,
    agreementRegisteredOn: text(fd, "agreementRegisteredOn") || null,
    collectedOn: text(fd, "collectedOn") || null,
    today: todayIst(),
  });
  if (res.ok) done();
  return res;
}

export async function passBackAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const payoutId = text(fd, "payoutId");
  const g = await payoutGuard("payout:approve", "payout", payoutId);
  if (!g) return { ok: false, message: "You cannot change this booking." };
  const pct = Number(text(fd, "passBack").replace(/%/g, ""));
  if (!Number.isFinite(pct)) return { ok: false, message: "Enter a percentage, like 1." };
  const res = await setPassBack({ orgId: g.orgId, userId: g.userId, payoutId, passBack: pct / 100 });
  if (res.ok) done();
  return res;
}

export async function fileInvoiceAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const milestoneId = text(fd, "milestoneId");
  const g = await payoutGuard("partner:register", "milestone", milestoneId);
  if (!g) return { ok: false, message: "You cannot file an invoice here." };
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) return { ok: false, message: "Attach the invoice." };
  const res = await fileInvoice({
    orgId: g.orgId,
    userId: g.userId,
    milestoneId,
    invoiceNo: text(fd, "invoiceNo"),
    invoiceDate: text(fd, "invoiceDate"),
    amount: Number(text(fd, "amount").replace(/[^\d]/g, "")),
    bytes: Buffer.from(await file.arrayBuffer()),
    mediaType: file.type,
    today: todayIst(),
  });
  if (res.ok) done();
  return res;
}

export async function milestoneAction(input: { milestoneId: string; kind: MilestoneMove["kind"]; utr?: string; paidOn?: string; reason?: string }): Promise<{ ok: boolean; message: string }> {
  const key = input.kind === "pay" ? "payout:pay" : "payout:approve";
  const g = await payoutGuard(key, "milestone", input.milestoneId);
  if (!g) return { ok: false, message: "You cannot do this here." };
  const move: MilestoneMove =
    input.kind === "pay"
      ? { kind: "pay", utr: String(input.utr ?? ""), paidOn: String(input.paidOn ?? "") }
      : input.kind === "reject"
        ? { kind: "reject", reason: isRejectReason(input.reason) ? input.reason : "OTHER" }
        : { kind: input.kind };
  const res = await moveMilestone({ orgId: g.orgId, userId: g.userId, milestoneId: input.milestoneId, move, today: todayIst() });
  if (res.ok) done();
  return res;
}

// ---------------------------------------------------------------------------
// A partner's link
// ---------------------------------------------------------------------------

export async function makeLinkAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const g = await requirePermission("partner:register");
  const phaseId = text(fd, "phaseId");
  const path = (await pathsOf(g.orgId, [phaseId], "PHASE")).get(phaseId);
  if (!path || !g.authz.canAt("partner:register", path)) return { ok: false, message: "You cannot make links for this tower." };
  if (!(await onMyDesk(g, "firm", text(fd, "firmId")))) return { ok: false, message: "That firm is not on your desk." };
  const res = await makeLink({ orgId: g.orgId, userId: g.userId, firmId: text(fd, "firmId"), phaseId, agentName: text(fd, "agentName") || null });
  if (!res.ok) return res;
  done();
  return { ok: true, message: `Link ${res.code} made.` };
}

export async function retireLinkAction(input: { linkId: string }): Promise<{ ok: boolean; message: string }> {
  const g = await requirePermission("partner:register");
  const path = await linkPath(g.orgId, input.linkId);
  if (!path || !g.authz.canAt("partner:register", path) || !(await onMyDesk(g, "link", input.linkId))) return { ok: false, message: "You cannot change this link." };
  const res = await retireLink({ orgId: g.orgId, userId: g.userId, linkId: input.linkId });
  if (res.ok) done();
  return res;
}

// ---------------------------------------------------------------------------
// The people at a firm who use your WhatsApp number
// ---------------------------------------------------------------------------

/** Whether this person may manage a firm's people: the empanel key where the firm is empanelled. */
async function mayManageFirm(
  g: { orgId: string; desk: Desk; authz: { can(p: string): boolean; canAt(p: string, path: string): boolean } },
  firmId: string,
  key: string,
): Promise<boolean> {
  if (!(await onMyDesk(g, "firm", firmId))) return false;
  const paths = await firmPaths(g.orgId, firmId);
  if (!paths) return false;
  if (paths.length) return paths.some((p) => g.authz.canAt(key, p));
  // A firm with no project left: the developer's desk asks at the root; a
  // mandate firm's own partner is its to look after wherever it holds the key.
  return g.desk.kind === "MANDATE" ? g.authz.can(key) : g.authz.canAt(key, await rootPath(g.orgId));
}

export async function addAgentAction(_: PartnerFormState, fd: FormData): Promise<PartnerFormState> {
  const g = await requirePermission("partner:empanel");
  const firmId = text(fd, "firmId");
  if (!(await mayManageFirm(g, firmId, "partner:empanel"))) return { ok: false, message: "You cannot change this firm." };
  const res = await addAgent({ orgId: g.orgId, userId: g.userId, firmId, name: text(fd, "name"), phone: text(fd, "phone") });
  if (res.ok) done();
  return res;
}

/** Taking somebody off is the lower bar: either key that can stop a firm. */
export async function removeAgentAction(input: { agentId: string }): Promise<{ ok: boolean; message: string }> {
  const g = await requireAnyPermission(["partner:empanel", "partner:suspend"]);
  const firmId = await agentFirm(g.orgId, input.agentId);
  if (!firmId) return { ok: false, message: "That person is not on the list." };
  const may = (await mayManageFirm(g, firmId, "partner:empanel")) || (await mayManageFirm(g, firmId, "partner:suspend"));
  if (!may) return { ok: false, message: "You cannot change this firm." };
  const res = await removeAgent({ orgId: g.orgId, userId: g.userId, agentId: input.agentId });
  if (res.ok) done();
  return res;
}

// ---------------------------------------------------------------------------
// A partner's buyer's number
// ---------------------------------------------------------------------------

export async function revealRegistrationAction(input: { registrationId: string }): Promise<{ ok: true; phone: string } | { ok: false; message: string }> {
  const g = await requirePermission("partner:read");
  if (!(await onMyDesk(g, "registration", input.registrationId))) return { ok: false, message: "That buyer is not on your desk." };
  return revealRegistration({
    orgId: g.orgId,
    userId: g.userId,
    registrationId: input.registrationId,
    mayAt: (path) => g.authz.canAt("partner:read", path) && g.authz.canAt("lead.phone:unmask", path),
  });
}

/** A whole number typed into the desk's search, looked up here rather than in the page. */
export async function findRegistrationAction(input: { number: string }): Promise<string[]> {
  const g = await requirePermission("partner:read");
  return findRegistrations(g.orgId, input.number, g.authz.scopesFor("partner:read"), g.desk);
}
