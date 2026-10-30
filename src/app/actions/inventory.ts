"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { importUnits, sheetRows, towerOf } from "@/lib/inventory";
import { saveFeed } from "@/lib/inventory-feed";
import { MAX_XLSX_BYTES } from "@/lib/xlsx-read";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/**
 * A tower's availability sheet, imported. `inventory:manage` at that tower,
 * checked against the tower read back inside the tenant, never against the
 * id the form carried.
 */
export async function importAvailabilityAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("inventory:manage", "/dashboard/leads");
  const tower = await towerOf(orgId, String(formData.get("tower") ?? ""));
  if (!tower || !authz.canAt("inventory:manage", tower.path)) return { ok: false, message: "You cannot update this tower's availability." };
  const file = formData.get("sheet");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the availability sheet, as Excel or CSV." };
  if (file.size > MAX_XLSX_BYTES) return { ok: false, message: "The file is over 5 MB. Send one tower's sheet at a time." };
  const rows = sheetRows(Buffer.from(await file.arrayBuffer()));
  if (!rows.ok) return { ok: false, message: rows.message };
  const r = await importUnits({ orgId, userId, nodeId: tower.id, rows: rows.rows });
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/dashboard/leads/availability");
  const parts = [
    r.added ? `${r.added} added` : null,
    r.changed ? `${r.changed} changed` : null,
    r.same ? `${r.same} unchanged` : null,
    r.crm ? `${r.crm} left to the CRM` : null,
    r.refused ? `${r.refused} ${r.refused === 1 ? "line" : "lines"} skipped` : null,
  ].filter(Boolean);
  const skipped = r.refusedLines.slice(0, 3).map((x) => `Line ${x.line}: ${x.reason}`);
  const more = r.refusedLines.length > 3 ? [`and ${r.refusedLines.length - 3} more.`] : [];
  const said = [`${tower.name}: ${parts.join(", ") || "nothing in the sheet"}.`, ...skipped, ...more].join(" ");
  redirect(`/dashboard/leads/availability?tower=${tower.id}&${flash(r.refused ? "error" : "done", said)}`);
}

/**
 * A live sheet set, changed or removed on a tower or its project.
 * `inventory:manage` at that place, asked again inside `saveFeed()`.
 */
export async function saveFeedAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("inventory:manage", "/dashboard/leads");
  const tower = String(formData.get("tower") ?? "");
  const r = await saveFeed({
    orgId,
    userId,
    authz,
    nodeId: String(formData.get("covers") ?? ""),
    url: formData.get("remove") ? "" : String(formData.get("url") ?? "").slice(0, 2000),
    fromTower: tower,
  });
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/dashboard/leads/availability");
  redirect(`/dashboard/leads/availability?tower=${encodeURIComponent(tower)}&${flash("done", r.message)}`);
}
