/**
 * What makes a legal entity acceptable, decided without a database.
 *
 * An ENTITY node is the SPV, and its name is the **RERA promoter of record**:
 * the legal person the portal matches a registration against. That is why it
 * is the one field here that has to be exact rather than presentable. "Godrej
 * Properties" is the brand; "GP Pune Projects LLP" is who actually files.
 *
 * Kept database-free so `npm run check:logic` can exercise it directly.
 */

import { slugify } from "./scope.ts";
import { validatePan } from "./gstin.ts";

export type EntityRefusal =
  | "NAME_TOO_SHORT"
  | "NAME_TOO_LONG"
  | "NAME_UNUSABLE"
  | "PAN_INVALID"
  | "REGISTRATION_INVALID";

export type EntityInput =
  | { ok: true; legalName: string }
  | { ok: false; code: EntityRefusal; message: string };

const MIN = 3;
const MAX = 200;

export function validateEntityName(raw: unknown): EntityInput {
  const legalName = String(raw ?? "").trim().replace(/\s+/g, " ");

  if (legalName.length < MIN) {
    return {
      ok: false,
      code: "NAME_TOO_SHORT",
      message: "Enter the entity's registered legal name.",
    };
  }
  if (legalName.length > MAX) {
    return {
      ok: false,
      code: "NAME_TOO_LONG",
      message: `Keep the name under ${MAX} characters.`,
    };
  }
  // An ltree label is letters, digits and underscores only. A name made
  // entirely of punctuation or non-Latin script reduces to nothing, and a
  // path segment has to survive.
  if (!slugify(legalName) || slugify(legalName) === "org") {
    return {
      ok: false,
      code: "NAME_UNUSABLE",
      message: "That name needs at least one letter or digit.",
    };
  }

  return { ok: true, legalName };
}

/**
 * A path segment for this entity, unique among its siblings.
 *
 * The slug is stable for the life of the node: renaming an entity changes its
 * display, never its path, because the path is what every ancestor and
 * descendant query is written against.
 */
export function entitySlug(legalName: string, takenSiblings: ReadonlySet<string>): string {
  const base = slugify(legalName);
  if (!takenSiblings.has(base)) return base;

  for (let n = 2; n < 100; n++) {
    const candidate = `${base}_${n}`;
    if (!takenSiblings.has(candidate)) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Registration number: CIN for a company, LLPIN for an LLP
// ---------------------------------------------------------------------------

/**
 * CIN is 21 characters and says a great deal on its own:
 *
 *   U 45200 MH 2015 PTC 123456
 *   │ │     │  │    │   └ registration number with the RoC
 *   │ │     │  │    └ ownership: PTC private, PLC public, and so on
 *   │ │     │  └ year of incorporation
 *   │ │     └ state of the Registrar of Companies
 *   │ └ industry code
 *   └ L listed, U unlisted
 *
 * LLPIN is shorter and carries none of that: three letters and four digits,
 * usually written AAB-1234.
 */
const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
const LLPIN_RE = /^[A-Z]{3}[0-9]{4}$/;

export type RegistrationKind = "CIN" | "LLPIN";

export type RegistrationResult =
  | { ok: true; value: null }
  | { ok: true; value: { no: string; kind: RegistrationKind } }
  | { ok: false; code: "REGISTRATION_INVALID"; message: string };

/**
 * Blank is allowed: a sole proprietorship or a partnership firm holds neither
 * number, and those do promote small projects.
 */
export function validateRegistrationNo(raw: unknown): RegistrationResult {
  const cleaned = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return { ok: true, value: null };

  if (CIN_RE.test(cleaned)) return { ok: true, value: { no: cleaned, kind: "CIN" } };
  if (LLPIN_RE.test(cleaned)) return { ok: true, value: { no: cleaned, kind: "LLPIN" } };

  return {
    ok: false,
    code: "REGISTRATION_INVALID",
    message:
      "That is not a valid CIN or LLPIN. A CIN is 21 characters (U45200MH2015PTC123456); an LLPIN is three letters and four digits (AAB-1234).",
  };
}

export type EntityDetailsInput =
  | {
      ok: true;
      legalName: string;
      pan: string;
      registration: { no: string; kind: RegistrationKind } | null;
      registeredAddress: string | null;
    }
  | { ok: false; code: EntityRefusal; message: string };

/** Everything an entity needs, validated together. */
export function validateEntity(raw: {
  legalName?: unknown;
  pan?: unknown;
  registrationNo?: unknown;
  registeredAddress?: unknown;
}): EntityDetailsInput {
  const name = validateEntityName(raw.legalName);
  if (!name.ok) return name;

  const pan = validatePan(String(raw.pan ?? ""));
  if (!pan.ok) {
    return { ok: false, code: "PAN_INVALID", message: pan.error };
  }

  const registration = validateRegistrationNo(raw.registrationNo);
  if (!registration.ok) {
    return { ok: false, code: "REGISTRATION_INVALID", message: registration.message };
  }

  const address = String(raw.registeredAddress ?? "").trim().replace(/\s+/g, " ").slice(0, 400);

  return {
    ok: true,
    legalName: name.legalName,
    pan: pan.pan,
    registration: registration.value,
    registeredAddress: address || null,
  };
}
