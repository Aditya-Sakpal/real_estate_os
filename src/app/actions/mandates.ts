"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { changeMandate, findMandateFirm, isId, mandatePaths, offerMandate, type MandateChange } from "@/lib/mandates";
import { readRate, readTail } from "@/lib/mandate-rules";

/**
 * Appointing a mandate firm. `mandate:manage` is asked at every project the
 * mandate covers, so a sales head for one region offers that region's
 * projects and nowhere else, and every id from the form is read back inside
 * the tenant before anything is written.
 */

export type MandateFormState = { ok: boolean; message: string; errors?: Record<string, string> } | null;

const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const done = () => revalidatePath("/dashboard/partners");

/** Is this PAN a mandate firm already on Sales Desk? Its name, or nothing. */
export async function lookupMandateFirmAction(pan: string): Promise<{ name: string } | null> {
  const g = await requirePermission("mandate:manage");
  const firm = await findMandateFirm(g.orgId, String(pan ?? ""));
  return firm ? { name: firm.name } : null;
}

export async function offerMandateAction(_: MandateFormState, fd: FormData): Promise<MandateFormState> {
  const g = await requirePermission("mandate:manage");
  const projectIds = [...new Set(fd.getAll("projectId").map(String).filter(isId))];
  const rows = projectIds.length
    ? await withTenant(g.orgId, (sql) => sql<{ path: string }[]>`
        SELECT path::text AS path FROM scope_nodes WHERE org_id = ${g.orgId} AND kind = 'PROJECT' AND id = ANY(${projectIds})`)
    : [];
  if (rows.length !== projectIds.length || rows.some((r) => !g.authz.canAt("mandate:manage", r.path))) {
    return { ok: false, message: "You cannot offer a mandate on one of those projects.", errors: { projects: "Choose from the list." } };
  }
  const res = await offerMandate({
    orgId: g.orgId,
    userId: g.userId,
    input: {
      pan: text(fd, "pan"),
      firmName: text(fd, "firmName"),
      contactName: text(fd, "contactName") || null,
      contactEmail: text(fd, "contactEmail") || null,
      rate: readRate(text(fd, "rate")),
      projectIds,
      validTo: text(fd, "validTo"),
      tailDays: readTail(text(fd, "tailDays")),
    },
  });
  if (res.ok) done();
  return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.message, errors: res.errors };
}

export async function changeMandateAction(input: { mandateId: string; kind: MandateChange["kind"]; validTo?: string }): Promise<{ ok: boolean; message: string }> {
  const g = await requirePermission("mandate:manage");
  const paths = await mandatePaths(g.orgId, String(input.mandateId ?? ""));
  if (!paths.length || paths.some((p) => !g.authz.canAt("mandate:manage", p))) return { ok: false, message: "You cannot change this mandate." };
  const change: MandateChange =
    input.kind === "renew" ? { kind: "renew", validTo: String(input.validTo ?? "") } : input.kind === "end" ? { kind: "end" } : { kind: "withdraw" };
  const res = await changeMandate({ orgId: g.orgId, userId: g.userId, mandateId: input.mandateId, change });
  if (res.ok) done();
  return res;
}
