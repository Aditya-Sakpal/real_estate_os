/**
 * GSTIN and PAN validation.
 *
 * GSTIN is the dedupe key that stops one company becoming two tenants, so it
 * is validated properly -- structure, embedded PAN, state code and the mod-36
 * check digit -- rather than by regex alone. A typo that passes a regex but
 * fails the checksum would silently create a duplicate tenant, and merging
 * tenants after leads have flowed is brutal.
 *
 * Layout of the 15 characters:
 *   [0..2)   state code        01-38, or 97 (other territory) / 99 (centre)
 *   [2..12)  PAN of the entity
 *   [12]     entity number for that PAN within the state
 *   [13]     'Z' by default
 *   [14]     mod-36 check digit
 */

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** GST state codes in use. 97 = other territory, 99 = centre. */
const VALID_STATE_CODES = new Set([
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")),
  "97",
  "99",
]);

/** 4th character of a PAN encodes holder type. */
const PAN_HOLDER_TYPE: Record<string, string> = {
  C: "Company",
  P: "Individual",
  H: "Hindu Undivided Family",
  F: "Firm / LLP",
  A: "Association of Persons",
  T: "Trust",
  B: "Body of Individuals",
  L: "Local Authority",
  J: "Artificial Juridical Person",
  G: "Government",
};

export function normalise(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** Mod-36 check digit over the first 14 characters. */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i]);
    if (value < 0) return "";
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

export type GstinResult =
  | {
      ok: true;
      gstin: string;
      pan: string;
      stateCode: string;
      holderType: string | null;
    }
  | { ok: false; error: string };

export function validateGstin(input: string): GstinResult {
  const gstin = normalise(input);

  if (gstin.length !== 15) {
    return { ok: false, error: "A GSTIN is exactly 15 characters." };
  }
  if (!GSTIN_RE.test(gstin)) {
    return { ok: false, error: "That is not a valid GSTIN format." };
  }

  const stateCode = gstin.slice(0, 2);
  if (!VALID_STATE_CODES.has(stateCode)) {
    return { ok: false, error: `${stateCode} is not a valid GST state code.` };
  }

  if (gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) {
    return {
      ok: false,
      error: "GSTIN check digit does not match -- please re-check the number.",
    };
  }

  const pan = gstin.slice(2, 12);
  return {
    ok: true,
    gstin,
    pan,
    stateCode,
    holderType: PAN_HOLDER_TYPE[pan[3]] ?? null,
  };
}

export type PanResult =
  | { ok: true; pan: string; holderType: string | null }
  | { ok: false; error: string };

export function validatePan(input: string): PanResult {
  const pan = normalise(input);
  if (!PAN_RE.test(pan)) {
    return { ok: false, error: "That is not a valid PAN (e.g. ABCCD1234E)." };
  }
  // The 4th character says what kind of holder it is, and only ten letters
  // are issued there. A PAN that passes the shape and fails this is a typo.
  const holderType = PAN_HOLDER_TYPE[pan[3]];
  if (!holderType) {
    return {
      ok: false,
      error: `${pan} is not a valid PAN: its 4th character, ${pan[3]}, is not one the tax department issues. Check the PAN.`,
    };
  }
  return { ok: true, pan, holderType };
}

/** The PAN embedded in a GSTIN must be the PAN the org claims. */
export function panMatchesGstin(pan: string, gstin: string): boolean {
  return normalise(gstin).slice(2, 12) === normalise(pan);
}
