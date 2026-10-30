"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { flash } from "@/lib/flash";
import { resolveScopeNode } from "@/lib/scope-nodes";
import { isNodeId } from "@/lib/scope-rules";
import type { FormResult } from "@/components/KeptForm";
import {
  addUnitType,
  approveUnitType,
  copyUnitTypesTo,
  removeUnitType,
  reviseUnitType,
  tagAsset,
  unitPlace,
} from "@/lib/unit";
import { assetPlace } from "@/lib/asset";
import { isAreaUnit, isRoom, toSqft, type AreaUnit, type PriceBasis } from "@/lib/unit-rules";

/**
 * Writing unit types.
 *
 * `unit:manage` records and revises. Approving is `brain.price:approve`,
 * which is held by somebody else, because the number a configuration
 * produces is a price and the Brain's three-way signature split exists so
 * that whoever sets a price is not also the one who declares it fit to
 * advertise.
 *
 * Every action asks its key AT the tower it touches. An id from a form can
 * name any tower in the organisation, and holding a key on one is not
 * holding it on the next.
 */

/** Back to one node's library. Only a signed message is ever shown. */
function back(nodeId: string, error?: string): never {
  const base = isNodeId(nodeId) ? `/dashboard/library/${nodeId}` : "/dashboard/library";
  redirect(error ? `${base}?${flash("error", error)}` : base);
}

const GONE = "That configuration is no longer recorded.";
const NOT_HERE = "You cannot change what this tower sells.";

/** An empty box is "not set", which is a different answer from zero. */
function numberOrNull(raw: FormDataEntryValue | null): number | null {
  const text = String(raw ?? "").replace(/[,\s]/g, "").trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * The plot area as typed, in the unit chosen beside it, as square feet. The
 * unit is read from the catalog's list and anything else is sq ft, so a stale
 * form cannot store a unit nobody offered.
 */
function plotFields(formData: FormData): {
  plotAreaSqft: number | null;
  areaUnit: AreaUnit | null;
  priceBasis: PriceBasis | null;
} {
  const raw = numberOrNull(formData.get("plotArea"));
  const unitRaw = String(formData.get("areaUnit") ?? "");
  const areaUnit: AreaUnit = isAreaUnit(unitRaw) ? unitRaw : "SQFT";
  const basis = String(formData.get("priceBasis") ?? "");
  return {
    plotAreaSqft: raw === null ? null : Number.isFinite(raw) ? toSqft(raw, areaUnit) : Number.NaN,
    areaUnit: raw === null ? null : areaUnit,
    priceBasis: basis === "PLOT" ? "PLOT" : basis === "CARPET" ? "CARPET" : null,
  };
}

export type UnitFormState = { ok: boolean; message: string } | null;

/**
 * Record a configuration.
 *
 * It returns rather than redirects, so the list re-renders in place and the
 * page does not blink. The same reason the asset upload does.
 */
export async function addUnitTypeAction(
  _previous: UnitFormState,
  formData: FormData,
): Promise<UnitFormState> {
  const { userId, orgId, authz } = await requirePermission("unit:manage");

  const nodeId = String(formData.get("nodeId") ?? "");
  const node = await resolveScopeNode(orgId, nodeId);
  if (!node) return { ok: false, message: "That is not a place in this organisation." };
  if (!authz.canAt("unit:manage", node.path)) return { ok: false, message: NOT_HERE };

  const result = await addUnitType({
    orgId,
    actorUserId: userId,
    nodeId,
    config: String(formData.get("config") ?? ""),
    variant: String(formData.get("variant") ?? "") || null,
    carpetAreaSqft: numberOrNull(formData.get("carpetAreaSqft")),
    balconyAreaSqft: numberOrNull(formData.get("balconyAreaSqft")),
    startingPrice: numberOrNull(formData.get("startingPrice")),
    ...plotFields(formData),
  });

  revalidatePath(`/dashboard/library/${nodeId}`);
  return result.ok
    ? { ok: true, message: "Configuration recorded. It starts unapproved." }
    : { ok: false, message: result.message };
}

/**
 * New numbers behind an existing configuration, as a version. It returns
 * rather than redirects, so a refusal is shown beside the numbers and the
 * numbers that were typed stay in their boxes.
 */
export async function reviseUnitTypeAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("unit:manage");

  const unitTypeId = String(formData.get("unitTypeId") ?? "");
  const place = await unitPlace(orgId, unitTypeId);
  if (!place) return { ok: false, message: GONE };
  if (!authz.canAt("unit:manage", place.path)) return { ok: false, message: NOT_HERE };

  const result = await reviseUnitType({
    orgId,
    actorUserId: userId,
    unitTypeId,
    carpetAreaSqft: numberOrNull(formData.get("carpetAreaSqft")),
    balconyAreaSqft: numberOrNull(formData.get("balconyAreaSqft")),
    startingPrice: numberOrNull(formData.get("startingPrice")),
    ...plotFields(formData),
  });

  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/dashboard/library/${place.nodeId}`);
  return { ok: true, message: "Saved as a new version." };
}

export async function approveUnitTypeAction(formData: FormData): Promise<void> {
  // Not `unit:manage`. Whoever recorded the price must not be the one who
  // signs it off, which is the whole of the Brain's three approve keys.
  const { userId, orgId, authz } = await requirePermission("brain.price:approve");

  const nodeId = String(formData.get("nodeId") ?? "");
  const unitTypeId = String(formData.get("unitTypeId") ?? "");
  const place = await unitPlace(orgId, unitTypeId);
  if (!place) back(nodeId, GONE);
  if (!authz.canAt("brain.price:approve", place.path)) {
    back(nodeId, "You cannot approve prices for this tower.");
  }

  const result = await approveUnitType({ orgId, actorUserId: userId, unitTypeId });
  if (!result.ok) back(nodeId, result.message);
  revalidatePath(`/dashboard/library/${place.nodeId}`);
}

export async function removeUnitTypeAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("unit:manage");

  const nodeId = String(formData.get("nodeId") ?? "");
  const unitTypeId = String(formData.get("unitTypeId") ?? "");
  const place = await unitPlace(orgId, unitTypeId);
  if (!place) back(nodeId, GONE);
  if (!authz.canAt("unit:manage", place.path)) back(nodeId, NOT_HERE);

  const result = await removeUnitType({ orgId, actorUserId: userId, unitTypeId });
  if (!result.ok) back(nodeId, result.message ?? GONE);
  revalidatePath(`/dashboard/library/${place.nodeId}`);
}

/**
 * Point a picture at a configuration, and say which room it is.
 *
 * Gated on `asset:manage` rather than `unit:manage`, because what this edits
 * is the asset. Somebody who may file renders may say which 2 BHK they show;
 * setting what that 2 BHK costs is a different power.
 */
export async function tagAssetAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("asset:manage");

  const assetId = String(formData.get("assetId") ?? "");
  const place = await assetPlace(orgId, assetId);
  if (!place) return { ok: false, message: "That picture is no longer in the library." };
  if (!authz.canAt("asset:manage", place.path)) {
    return { ok: false, message: "You cannot change the library here." };
  }

  const room = String(formData.get("room") ?? "");
  const result = await tagAsset({
    orgId,
    actorUserId: userId,
    assetId,
    unitTypeId: String(formData.get("unitTypeId") ?? "") || null,
    room: isRoom(room) ? room : null,
  });

  if (!result.ok) {
    return { ok: false, message: result.message ?? "That picture is no longer in the library." };
  }
  revalidatePath(`/dashboard/library/${place.nodeId}`);
  return null;
}

export type UnitCopyState = { ok: boolean; message: string } | null;

/**
 * Copy configurations, and optionally their pictures, to another tower.
 *
 * The reason this exists: Tower B sells the same 1 BHK and 2 BHK at the same
 * prices off the same plans. Approvals do not travel, for either, and the
 * panel says so before the button is pressed.
 */
export async function copyUnitTypesAction(
  _previous: UnitCopyState,
  formData: FormData,
): Promise<UnitCopyState> {
  const { userId, orgId, authz } = await requirePermission("unit:manage");

  const toNodeId = String(formData.get("toNodeId") ?? "");
  const unitTypeIds = formData.getAll("unitTypeIds").map(String);
  const withAssets = formData.get("withAssets") !== null;
  if (!unitTypeIds.length) return { ok: false, message: "Choose at least one configuration to copy." };
  if (!toNodeId) return { ok: false, message: "Choose which tower to copy them to." };

  // The key at the TARGET tower. The screen offers only towers this person
  // may record on, and the screen is presentation.
  const to = await resolveScopeNode(orgId, toNodeId);
  if (!to) return { ok: false, message: "That is not a place in this organisation." };
  if (!authz.canAt("unit:manage", to.path)) {
    return { ok: false, message: `You cannot record what ${to.name} sells.` };
  }
  // The pictures land in the target's library, which is its own key.
  if (withAssets && !authz.canAt("asset:manage", to.path)) {
    return {
      ok: false,
      message: `You cannot add pictures to ${to.name}. Untick "Bring the pictures" to copy the numbers only.`,
    };
  }

  const result = await copyUnitTypesTo({
    orgId,
    actorUserId: userId,
    unitTypeIds,
    toNodeId,
    withAssets,
    mayTakeFrom: (path) => authz.canAt("unit:read", path),
  });
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(`/dashboard/library/${toNodeId}`);
  const fromNodeId = String(formData.get("nodeId") ?? "");
  if (isNodeId(fromNodeId)) revalidatePath(`/dashboard/library/${fromNodeId}`);

  const parts = [
    result.copied === 1 ? "1 configuration copied" : `${result.copied} configurations copied`,
    result.assets ? `with ${result.assets} ${result.assets === 1 ? "picture" : "pictures"}` : null,
    result.skipped.length ? `${result.skipped.join(", ")} was already there` : null,
  ].filter((p): p is string => p !== null);

  return { ok: true, message: `${parts.join(", ")}. They arrive unapproved.` };
}
