/**
 * Naming rules for the nodes beneath an entity.
 *
 * A project's name is display copy, not a legal identifier: the RERA promoter
 * check matches the ENTITY, and the registration number attaches to a PHASE.
 * So the bar here is only that the name reduces to a usable ltree label and
 * reads like something a person typed on purpose.
 */

import { slugify } from "./scope.ts";

export type NodeRefusal = "NAME_TOO_SHORT" | "NAME_TOO_LONG" | "NAME_UNUSABLE";

export type NodeNameResult =
  | { ok: true; name: string }
  | { ok: false; code: NodeRefusal; message: string };

function validateNodeName(raw: unknown, what: string, min: number): NodeNameResult {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");

  if (name.length < min) {
    return { ok: false, code: "NAME_TOO_SHORT", message: `Enter the ${what}.` };
  }
  if (name.length > 120) {
    return { ok: false, code: "NAME_TOO_LONG", message: `Keep the ${what} under 120 characters.` };
  }
  const slug = slugify(name);
  if (!slug || slug === "org") {
    return {
      ok: false,
      code: "NAME_UNUSABLE",
      message: `That ${what} needs at least one letter or digit.`,
    };
  }
  return { ok: true, name };
}

export function validateProjectName(raw: unknown): NodeNameResult {
  return validateNodeName(raw, "project name", 2);
}

/**
 * The city becomes a REGION node.
 *
 * A developer thinks in cities, not in "region nodes", so the form asks for a
 * city and the tree gets its middle layer without anyone having to learn what
 * it is called. Two projects in the same city share one region rather than
 * each growing their own.
 */
export function validateCity(raw: unknown): NodeNameResult {
  return validateNodeName(raw, "city", 2);
}
