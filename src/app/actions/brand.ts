"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { flash } from "@/lib/flash";
import { resolveScopeNode } from "@/lib/scope-nodes";
import { isNodeId } from "@/lib/scope-rules";
import { putBrandFile, removeBrandFile, saveBrandKit } from "@/lib/brand";
import {
  brandFileProblems,
  brandFileType,
  isBrandFileRole,
  parseBrandInput,
  BRAND_FILE_ROLES,
  TYPEFACE_LANGUAGES,
  type BrandInput,
} from "@/lib/brand-rules";

/**
 * Writing the brand kit.
 *
 * Every action reads its node back inside the tenant before writing, the same
 * rule scoped invites, the Brain and campaign briefs follow. A node id from a
 * form is a string somebody sent us, not a node. And holding `brand:manage`
 * somewhere is not holding it here: an entity's marketing lead may change
 * that entity's kit, not the organisation's above it.
 */

/** Back to the kit being edited. Only a signed message is ever shown. */
function back(nodeId: string, message?: { name: "error" | "notice"; text: string }): never {
  const node = isNodeId(nodeId) ? `node=${nodeId}&edit=1` : "";
  const note = message ? flash(message.name, message.text) : "";
  const q = [node, note].filter(Boolean).join("&");
  redirect(q ? `/dashboard/library/branding?${q}` : "/dashboard/library/branding");
}

export type BrandState = { ok: boolean; message: string } | null;

const NOT_HERE = "You cannot change the branding here.";

/**
 * Save the kit, marks and all, in one submit.
 *
 * There used to be five forms on this screen: one per file slot and one for
 * the text. A person would choose three logos, type a tagline and a colour,
 * press one slot's Upload, and HTML would do exactly what it should, which is
 * submit that form and discard the other four. Everything else cleared on the
 * re-render and it read as the page eating their work. The file inputs now
 * belong to this form through the `form` attribute, so one button saves
 * everything that was filled in.
 *
 * It returns rather than redirects, for the reason the asset upload does: a
 * redirect to the same URL is a full navigation and the page blinks.
 */
export async function saveBrandAction(
  _previous: BrandState,
  formData: FormData,
): Promise<BrandState> {
  const { userId, orgId, authz } = await requirePermission("brand:manage");

  const nodeId = String(formData.get("nodeId") ?? "");
  const node = await resolveScopeNode(orgId, nodeId);
  if (!node) return { ok: false, message: "That is not a place in this organisation." };
  if (!authz.canAt("brand:manage", node.path)) return { ok: false, message: NOT_HERE };

  const str = (k: string) => String(formData.get(k) ?? "") || null;
  const input: BrandInput = {
    tagline: str("tagline"),
    colourPrimary: str("colourPrimary"),
    colourAccent: str("colourAccent"),
    typefaceName: str("typefaceName"),
    typefaceLanguages: TYPEFACE_LANGUAGES.filter((l) =>
      formData.getAll("typefaceLanguages").map(String).includes(l),
    ),
    logoMinPx: str("logoMinPx"),
    logoClearRatio: str("logoClearRatio"),
    salesPhone: str("salesPhone"),
    salesEmail: str("salesEmail"),
    website: str("website"),
    privacyUrl: str("privacyUrl"),
    officeAddress: str("officeAddress"),
    instagram: str("instagram"),
    facebook: str("facebook"),
    youtube: str("youtube"),
    disclaimer: str("disclaimer"),
  };

  // Whatever marks were chosen, in the same submit. A slot nobody touched is
  // not a slot to empty.
  const chosen = BRAND_FILE_ROLES.flatMap((role) => {
    const file = formData.get(`file_${role.key}`);
    return file instanceof File && file.size > 0 ? [{ role, file }] : [];
  });

  // Everything is asked before anything is written: the fields, then every
  // file's type and size. A refusal leaves the kit exactly as it was, and the
  // form keeps what was typed and chosen so the one wrong thing can be fixed.
  const parsed = parseBrandInput(input);
  const problems = [
    ...(parsed.ok ? [] : parsed.problems),
    ...brandFileProblems(
      chosen.map(({ role, file }) => ({
        role: role.key,
        name: file.name || null,
        type: file.type,
        bytes: file.size,
      })),
    ),
  ];
  if (problems.length) return { ok: false, message: `Nothing was saved. ${problems.join(" ")}` };

  const result = await saveBrandKit({ orgId, actorUserId: userId, nodeId, input });
  if (!result.ok) return { ok: false, message: result.message };

  let uploaded = 0;
  for (const { role, file } of chosen) {
    const put = await putBrandFile({
      orgId,
      actorUserId: userId,
      nodeId,
      role: role.key,
      media: {
        bytes: Buffer.from(await file.arrayBuffer()),
        // The browser often has no idea what a font is, so the extension
        // answers for fonts and never for images.
        type: brandFileType(role.key, file.name || null, file.type) ?? file.type,
        name: file.name || null,
      },
    });
    // The text is already saved, so say what did land before what did not.
    if (!put.ok) {
      revalidatePath("/dashboard/library/branding");
      return {
        ok: false,
        message: uploaded
          ? `Saved, and ${uploaded} file(s) uploaded, then ${role.label} was refused. ${put.message}`
          : `Saved, but ${role.label} was refused. ${put.message}`,
      };
    }
    uploaded += 1;
  }

  revalidatePath("/dashboard/library/branding");
  return {
    ok: true,
    message: uploaded
      ? `Saved, with ${uploaded} file${uploaded === 1 ? "" : "s"} uploaded.`
      : "Saved.",
  };
}

/**
 * Take one mark off one node, behind a confirmation on the screen.
 *
 * It sits outside the kit's form, never inside it: a form inside a form is
 * not HTML, the browser drops the inner one, and the button quietly submitted
 * nothing.
 */
export async function removeBrandFileAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("brand:manage");

  const nodeId = String(formData.get("nodeId") ?? "");
  const role = String(formData.get("role") ?? "");
  const node = await resolveScopeNode(orgId, nodeId);
  if (!node) back("", { name: "error", text: "That is not a place in this organisation." });
  if (!authz.canAt("brand:manage", node.path)) back(nodeId, { name: "error", text: NOT_HERE });

  const result = await removeBrandFile({ orgId, actorUserId: userId, nodeId, role });
  if (!result.ok) back(nodeId, { name: "error", text: result.message });

  revalidatePath("/dashboard/library/branding");
  const label = isBrandFileRole(role) ? BRAND_FILE_ROLES.find((r) => r.key === role)?.label : null;
  back(nodeId, { name: "notice", text: `${label ?? "That file"} removed from ${node.name}.` });
}
