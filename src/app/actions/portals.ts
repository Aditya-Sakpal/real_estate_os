"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { importPortalSheet, removePortalAccount, rotatePortalKey, savePortalAccount, savePortalMatches } from "@/lib/portal-leads";
import { isPortalKey, portalLabel } from "@/lib/portal-rules";
import { isUuid } from "@/lib/capture-rules";
import { sheetRows } from "@/lib/inventory";
import { MAX_XLSX_BYTES } from "@/lib/xlsx-read";
import { processEvent } from "@/lib/lead-engine";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/** How many released or imported enquiries are worked straight after the answer; the worker takes the rest. */
const RUN_NOW = 25;

function runSoon(orgId: string, ids: string[]) {
  if (!ids.length) return;
  after(async () => {
    for (const id of ids.slice(0, RUN_NOW)) await processEvent(orgId, id).catch(() => null);
  });
}

/**
 * The towers a portal's wordings mean, saved by `integration:manage`. Every
 * enquiry waiting on a wording that now has a tower goes through capture.
 */
export async function savePortalMatchesAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("integration:manage", "/dashboard/settings/connections");
  const picks: { id: string; value: string }[] = [];
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string" && k.startsWith("m_")) picks.push({ id: k.slice(2), value: v.trim() });
  }
  if (!picks.length) redirect("/dashboard/settings/connections/portals");
  const r = await savePortalMatches(orgId, userId, picks);
  if (!r.ok) return { ok: false, message: r.message };
  runSoon(orgId, r.release);
  revalidatePath("/dashboard/settings/connections/portals");
  const said = r.release.length
    ? `Saved. ${r.release.length} waiting ${r.release.length === 1 ? "lead is" : "leads are"} on the board now.`
    : "Saved.";
  redirect(`/dashboard/settings/connections/portals?${flash("done", said)}`);
}

/** A new address and key: the old ones stop working at once. */
export async function rotatePortalKeyAction(): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage", "/dashboard/settings/connections");
  await rotatePortalKey(orgId, userId);
  revalidatePath("/dashboard/settings/connections/portals");
  redirect(
    `/dashboard/settings/connections/portals?${flash("done", "New address made. Update the forwarding in every portal account: the old address no longer works.")}`,
  );
}

/**
 * A portal's export, uploaded from Leads. `lead:create`, asked again where
 * each row would land.
 */
export async function importPortalSheetAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("lead:create", "/dashboard/leads");
  const portal = String(formData.get("portal") ?? "");
  if (!isPortalKey(portal)) return { ok: false, message: "Choose the portal the file came from." };
  const file = formData.get("sheet");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the portal's export, as Excel or CSV." };
  if (file.size > MAX_XLSX_BYTES) return { ok: false, message: "The file is over 5 MB. Export a shorter period." };
  const rows = sheetRows(Buffer.from(await file.arrayBuffer()));
  if (!rows.ok) return { ok: false, message: rows.message };
  const r = await importPortalSheet({ orgId, userId, portal, rows: rows.rows, scopes: authz.scopesFor("lead:create") });
  if (!r.ok) return { ok: false, message: r.message };
  runSoon(orgId, r.eventIds);
  revalidatePath("/dashboard/leads");
  const parts = [
    r.added ? `${r.added} new` : null,
    r.again ? `${r.again} already received` : null,
    r.refused.length ? `${r.refused.length} ${r.refused.length === 1 ? "row" : "rows"} skipped` : null,
  ].filter(Boolean);
  const skipped = r.refused.slice(0, 3).map((x) => `Line ${x.line}: ${x.reason}`);
  const more = r.refused.length > 3 ? [`and ${r.refused.length - 3} more.`] : [];
  const said = [`${portalLabel(portal)}: ${parts.join(", ") || "no enquiries in the file"}.`, ...skipped, ...more].join(" ");
  redirect(`/dashboard/leads/portals?${flash(r.refused.length ? "error" : "done", said)}`);
}

/**
 * A Housing.com account's id and secret key, saved by `integration:manage`
 * after Housing.com accepts them. Its leads are then read every ten minutes.
 */
export async function saveHousingAccountAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("integration:manage", "/dashboard/settings/connections");
  const r = await savePortalAccount(orgId, userId, {
    accountId: String(formData.get("accountId") ?? ""),
    key: String(formData.get("secretKey") ?? ""),
  });
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/dashboard/settings/connections/portals");
  const said = r.checked
    ? "Housing.com connected. Its leads arrive every ten minutes."
    : "Saved. Housing.com could not be reached to check it, so it is tried again in ten minutes.";
  redirect(`/dashboard/settings/connections/portals?${flash("done", said)}`);
}

/** Stops reading a Housing.com account and deletes its key. */
export async function removeHousingAccountAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage", "/dashboard/settings/connections");
  const id = String(formData.get("id") ?? "");
  if (isUuid(id)) await removePortalAccount(orgId, userId, id);
  revalidatePath("/dashboard/settings/connections/portals");
  redirect(`/dashboard/settings/connections/portals?${flash("done", "Housing.com removed. Its leads no longer arrive here.")}`);
}
