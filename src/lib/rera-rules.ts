/**
 * The regulatory rules, in code rather than in a table.
 *
 * A tenant must not be able to widen its own exemption threshold or soften
 * the combinator, which is exactly what a configurable row would allow. This
 * is the same argument as the permission catalog: the values live where a
 * change needs review, not where an admin can tick a box.
 *
 * Every value below names where it came from. `doc/rera-states.md` holds the
 * research behind them, dated, with the source for each.
 *
 * Database-free, so `npm run check:logic` exercises it directly.
 */

import { isDevelopment } from "./app-env.ts";

export type ReraStatus = "VERIFIED" | "EXEMPT" | "BLOCKED";

export type StateRule = {
  code: string;
  name: string;
  /** What the state's authority calls itself, on a screen and in a refusal. */
  authority: string;
  /**
   * Section 3(2)(a) exempts land "not exceeding five hundred square metres or
   * eight apartments". Whether that "or" is disjunctive is contested, so each
   * state carries its own authority's reading:
   *
   *   OR   exempt when EITHER limit is met. Maharashtra (MahaRERA Circular
   *        25/2019 and Order 25A/2023), Tamil Nadu (Madras High Court,
   *        Devinarayan Housing v. Manu Karan, 20 September 2023) and Goa
   *        (its SOP of 27 January 2023).
   *   AND  exempt only when BOTH are met. Every other state: where an
   *        authority has spoken it said this (Telangana, Delhi, Rajasthan,
   *        Andhra Pradesh, West Bengal), and where none has, AND is the strict
   *        reading. Getting this wrong in the loose direction exposes the
   *        promoter to a Section 12 refund claim with interest, so the two
   *        errors do not cost the same.
   */
  combinator: "AND" | "OR";
  landSqm: number;
  apartments: number;
  /** Where the threshold and the reading come from, for the record. */
  exemptionSource: string;
  /**
   * Registration number shape, only where every number the authority's own
   * register lists matches it. Guessing at the rest would refuse valid
   * numbers, which is worse than accepting an odd one: the portal is the
   * real arbiter.
   */
  pattern?: RegExp;
  /**
   * A real number of the state's shape, for a placeholder. Only where one was
   * read off the authority's own register: an invented one gets typed in.
   */
  patternHint?: string;
};

const ACT = { landSqm: 500, apartments: 8 };
const STRICT = "No authority reading found; the strict one is used.";

export const STATE_RULES: StateRule[] = [
  {
    code: "MH",
    name: "Maharashtra",
    authority: "MahaRERA",
    combinator: "OR",
    ...ACT,
    exemptionSource: "MahaRERA Circular 25/2019 and Order 25A/2023: either limit is enough.",
    // MahaRERA numbers are P followed by eleven digits.
    pattern: /^P[0-9]{11}$/,
    patternHint: "P52100012345",
  },
  {
    code: "KA",
    name: "Karnataka",
    authority: "Karnataka RERA",
    combinator: "AND",
    ...ACT,
    exemptionSource: STRICT,
    // All 8,982 numbers on the register on 28 September 2026, the 39 carried
    // over to a new promoter ("TOR/") included.
    pattern: /^(TOR\/)?PRM\/KA\/RERA\/\d{4}\/\d{3}\/PR\/\d{6}\/\d{6}$/,
    patternHint: "PRM/KA/RERA/1251/308/PR/250926/008969",
  },
  {
    code: "TN",
    name: "Tamil Nadu",
    authority: "TNRERA",
    combinator: "OR",
    ...ACT,
    exemptionSource: "Madras High Court, C.M.S.A. 23 and 24 of 2020, 20 September 2023: either limit is enough.",
    patternHint: "TNRERA/29/BLG/0002/2026",
  },
  {
    code: "DL",
    name: "Delhi",
    authority: "Delhi RERA",
    combinator: "AND",
    ...ACT,
    exemptionSource: "Delhi RERA guidelines 2023, clause 4(1), and public notice of 28 April 2022.",
    // All 131 numbers on the register on 28 September 2026.
    pattern: /^DLRERA\d{4}P\d{4}$/,
    patternHint: "DLRERA2026P0004",
  },
  {
    code: "HR",
    name: "Haryana",
    authority: "Haryana RERA",
    combinator: "AND",
    ...ACT,
    exemptionSource: STRICT,
    patternHint: "GGM/940/672/2025/43",
  },
  {
    code: "UP",
    name: "Uttar Pradesh",
    authority: "UP RERA",
    combinator: "AND",
    ...ACT,
    exemptionSource: STRICT,
    patternHint: "UPRERAPRJ304177/03/2025",
  },
  {
    code: "GJ",
    name: "Gujarat",
    authority: "GujRERA",
    combinator: "AND",
    ...ACT,
    exemptionSource: STRICT,
    patternHint: "PR/GJ/AHMEDABAD/AHMEDABAD CITY/AUDA/MAA12147/170823",
  },
  {
    code: "TG",
    name: "Telangana",
    authority: "TGRERA",
    combinator: "AND",
    ...ACT,
    exemptionSource: "TGRERA FAQ of 7 July 2023 and its alert of November 2024: both limits.",
    patternHint: "P02200003688",
  },
  {
    code: "WB",
    name: "West Bengal",
    authority: "WBRERA",
    combinator: "AND",
    // Reduced below the Act's by the state, as Section 3(2)(a) allows.
    landSqm: 200,
    apartments: 6,
    exemptionSource:
      "Housing Department Notification 42-H4/2M-01/2023 of 6 June 2023, read with circular 315 of 19 September 2024.",
    patternHint: "WBRERA/P/KOL/2026/004163",
  },
  {
    code: "RJ",
    name: "Rajasthan",
    authority: "RajRERA",
    combinator: "AND",
    ...ACT,
    exemptionSource: "RajRERA order F.1(31)RJ/RERA/2019/550 of 8 March 2022: both limits.",
    // Every registration on the register on 28 September 2026. Exemption
    // certificates sit in the same list and are deliberately not this shape.
    pattern: /^RAJ\/P\/\d{4}\/\d{3,4}(-[A-Z])?$/,
    patternHint: "RAJ/P/2026/5436",
  },
  {
    code: "AP",
    name: "Andhra Pradesh",
    authority: "APRERA",
    combinator: "AND",
    ...ACT,
    exemptionSource: "APRERA FAQ 23 and 24: both limits.",
    // All 7,131 numbers on the register on 28 September 2026.
    pattern: /^P[0-9]{11}$/,
    patternHint: "P03280080001",
  },
  {
    code: "GA",
    name: "Goa",
    authority: "Goa RERA",
    combinator: "OR",
    ...ACT,
    exemptionSource: "Goa RERA SOP F.1/RERA/SOP/2019/73 of 27 January 2023: either limit is enough.",
    patternHint: "PRGO05242234",
  },
  { code: "KL", name: "Kerala", authority: "Kerala RERA", combinator: "AND", ...ACT, exemptionSource: STRICT },
  { code: "MP", name: "Madhya Pradesh", authority: "MP RERA", combinator: "AND", ...ACT, exemptionSource: STRICT },
  { code: "PB", name: "Punjab", authority: "Punjab RERA", combinator: "AND", ...ACT, exemptionSource: STRICT },
];

export function stateRule(code: string): StateRule | undefined {
  return STATE_RULES.find((s) => s.code === code.toUpperCase());
}

/** Days an attested exemption stands before it has to be looked at again. */
export const EXEMPTION_DAYS = 90;

// ---------------------------------------------------------------------------
// Exemption
// ---------------------------------------------------------------------------

export type ExemptionVerdict =
  | { exempt: true; reason: string }
  | { exempt: false; reason: string };

/**
 * Both measures are taken ACROSS ALL PHASES. That is the point: a promoter
 * cannot slice a project into eight-apartment phases to stay under it.
 */
export function evaluateExemption(opts: {
  stateCode: string;
  landAreaSqm: number;
  apartmentCount: number;
}): ExemptionVerdict {
  const rule = stateRule(opts.stateCode);
  if (!rule) {
    return { exempt: false, reason: "No threshold is configured for that state." };
  }

  const underLand = opts.landAreaSqm <= rule.landSqm;
  const underUnits = opts.apartmentCount <= rule.apartments;
  const exempt = rule.combinator === "AND" ? underLand && underUnits : underLand || underUnits;

  const measures =
    `${opts.landAreaSqm} sq m (limit ${rule.landSqm}) and ` +
    `${opts.apartmentCount} apartments (limit ${rule.apartments})`;

  if (exempt) {
    return {
      exempt: true,
      reason:
        rule.combinator === "OR"
          ? `${measures}. Exempt in ${rule.name}, where one limit is enough.`
          : `${measures}. Exempt in ${rule.name}, which needs both limits.`,
    };
  }
  return {
    exempt: false,
    reason:
      rule.combinator === "OR"
        ? `${measures}. Over both limits, so every phase needs registering.`
        : `${measures}. Over the threshold, so every phase needs registering.`,
  };
}

export function exemptionExpiry(attestedAt: Date): Date {
  return new Date(attestedAt.getTime() + EXEMPTION_DAYS * 86_400_000);
}

// ---------------------------------------------------------------------------
// Registration numbers
// ---------------------------------------------------------------------------

/**
 * One spelling of a registration number, the way it is stored.
 *
 * Upper case and no stray spaces. Two states need more:
 *
 *   HR  an advertisement prints Gurugram's number with the prefix its own
 *       specimen uses ("RC/REP/HARERA/GGM/...") and the register prints it
 *       with its date ("GGM/940/672/2025/43 DATED 01.05.2025"); neither is
 *       part of the number.
 *   GJ  the number carries the district, the taluka and the authority by
 *       name ("AHMEDABAD CITY"), so the spaces inside it are real and only
 *       runs of them are collapsed.
 */
export function normaliseRegistrationNo(stateCode: string, raw: unknown): string {
  let v = String(raw ?? "").normalize("NFKC").trim().toUpperCase();
  const state = stateCode.toUpperCase();
  if (state === "HR") {
    v = v.replace(/^RC\s*\/\s*REP\s*\/\s*HARERA\s*\//, "").replace(/\s+DATED\b.*$/, "");
  }
  if (state === "GJ") return v.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
  return v.replace(/\s+/g, "");
}

/**
 * The part of a number that identifies the registration, for comparing two
 * spellings of it.
 *
 *   GJ  the serial (`MAA12147`). GujRERA issues a NEW number when a project is
 *       altered or extended (`.../MAA12147/EX1/290918`), so the number a
 *       client recorded last year is not the one on the register this year,
 *       while the serial is the same project.
 *   TN  numeric parts without their padding, because the authority writes
 *       the serial as 002 in one list and 0002 in another.
 *
 * Everything else compares as stored.
 */
export function registrationKey(stateCode: string, raw: unknown): string {
  const state = stateCode.toUpperCase();
  const v = normaliseRegistrationNo(state, raw);
  if (state === "GJ") {
    // "MAA12147" mostly, and "MN94AA09994" for a few hundred: every serial on
    // the register of 28 September 2026 has this shape and none repeats.
    const serial = v.split("/").find((part) => /^[A-Z]{1,3}\d{0,4}AA\d{4,}$/.test(part));
    return serial ?? v;
  }
  if (state === "TN") {
    // Typed with a space, "Regularisation Layout" arrives here without it;
    // the portal writes it with a hyphen. One spelling.
    return v
      .replace(/REGULARISATION-?LAYOUT/g, "REGULARISATION-LAYOUT")
      .split("/")
      .map((part) => (/^\d+$/.test(part) ? String(Number(part)) : part))
      .join("/");
  }
  return v;
}

export type NumberResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

export function validateRegistrationNumber(stateCode: string, raw: unknown): NumberResult {
  const value = normaliseRegistrationNo(stateCode, raw);
  if (value.length < 6) {
    return { ok: false, message: "Enter the registration number from the RERA portal." };
  }
  // Gujarat's numbers carry the district, the taluka and the authority by
  // name; the longest on its register runs to 111 characters.
  if (value.length > 130) {
    return { ok: false, message: "That is too long to be a registration number." };
  }

  const rule = stateRule(stateCode);
  // Only where a state publishes a stable shape. Guessing at the rest would
  // reject valid numbers, which is worse than accepting an odd one: the
  // portal check is the real arbiter.
  if (rule?.pattern && !rule.pattern.test(value)) {
    return {
      ok: false,
      message: `${rule.name} numbers look like ${rule.patternHint}.`,
    };
  }
  return { ok: true, value };
}

/**
 * Normalised comparison of the portal's promoter against the entity's legal
 * name. Case, punctuation and the usual suffix spellings differ constantly,
 * and none of that is a mismatch worth stopping a campaign for.
 */
export function promoterMatches(portalName: string, entityLegalName: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      // Portals prefix a firm with "M/s." or "Messrs", which is a courtesy
      // and not part of anybody's legal name.
      .replace(/^\s*(m\s*\/\s*s\.?|messrs\.?)\s*/, "")
      .replace(/&/g, " and ")
      .replace(/\b(private|pvt)\b/g, "pvt")
      .replace(/\b(limited|ltd)\b/g, "ltd")
      .replace(/\b(llp)\b/g, "llp")
      .replace(/[^a-z0-9]+/g, "");
  return norm(portalName) === norm(entityLegalName) && norm(portalName).length > 0;
}

// ---------------------------------------------------------------------------
// Extensions every registration got at once
// ---------------------------------------------------------------------------

/**
 * An extension an authority granted to every registration it holds at once,
 * with no application from anybody.
 *
 * The Ministry of Housing and Urban Affairs advised every authority on 31
 * July 2026 to treat the West Asia situation as war for force majeure and
 * extend completion by four months. Those that did are below, each from its
 * own order. The client's typed date does not move when an authority does
 * this, so without these a phase that is lawfully advertisable would lapse
 * on its old date.
 *
 * Only orders read in the authority's own words or reported with a date and
 * a scope are here. Haryana's was reported for one of its two authorities
 * without saying which, and is left out: an extension applied to the wrong
 * authority advertises a lapsed registration, and a missing one is fixed by
 * recording the new date.
 */
export type BlanketExtension = {
  state: string;
  /** The order, as a person would cite it. Shown on the phase. */
  ref: string;
  /** Completion dates from here, inclusive. */
  completionFrom: string;
  /** Completion dates to here, inclusive, where the order stops. */
  completionTo?: string;
  /** Registrations made on or after this day are excluded. */
  registeredBefore: string;
  /** Either four months more, or a fixed new date. */
  months?: number;
  until?: string;
};

export const BLANKET_EXTENSIONS: BlanketExtension[] = [
  {
    state: "MH",
    ref: "MahaRERA Order 66/2026 of 7 August 2026",
    completionFrom: "2026-02-28",
    registeredBefore: "2026-08-01",
    months: 4,
  },
  {
    state: "KA",
    ref: "K-RERA Circular KRERA/ADMIN/10/2026 of 10 August 2026",
    completionFrom: "2026-02-28",
    registeredBefore: "2026-08-01",
    months: 4,
  },
  {
    state: "TN",
    // The circular extends "registered Real Estate Projects" and names no
    // cut-off, so registrations made after the day it was signed are left out.
    ref: "TNRERA Circular TNRERA/A2/2552/2026 of 10 August 2026",
    completionFrom: "2026-02-28",
    registeredBefore: "2026-08-11",
    months: 4,
  },
  {
    state: "TG",
    // A window and a fixed date rather than four months each. What it does
    // for a date after 31 July is not said, so nothing is assumed.
    ref: "TGRERA order of 31 July 2026",
    completionFrom: "2026-02-28",
    completionTo: "2026-07-31",
    registeredBefore: "2026-08-01",
    until: "2026-11-30",
  },
];

/** A date-only string, read as that day. */
function day(v: Date | string): string {
  return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
}

function addMonths(isoDay: string, months: number): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  // The same day of the month, or the last day when the month is shorter:
  // 30 June plus four months is 30 October, 31 October plus four is 28 or
  // 29 February.
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/**
 * The extension an authority's own order gives this registration, or null.
 *
 * `registeredOn` is the authority's date when it is known. When it is not,
 * the day the registration was first recorded here stands in, because a
 * registration cannot have been recorded before it existed: recorded before
 * the cut-off proves it was registered before it too. Recorded after the
 * cut-off with no date from the authority proves nothing, and nothing is
 * extended, which is the direction that never advertises a lapsed number.
 */
export function blanketExtension(opts: {
  stateCode: string | null;
  validTo: Date | string | null;
  registeredOn?: Date | string | null;
  recordedAt?: Date | string | null;
}): { until: string; ref: string } | null {
  if (!opts.stateCode || !opts.validTo) return null;
  const valid = day(opts.validTo);
  const before = opts.registeredOn ? day(opts.registeredOn) : opts.recordedAt ? day(opts.recordedAt) : null;

  for (const ext of BLANKET_EXTENSIONS) {
    if (ext.state !== opts.stateCode.toUpperCase()) continue;
    if (valid < ext.completionFrom) continue;
    if (ext.completionTo && valid > ext.completionTo) continue;
    if (!before || before >= ext.registeredBefore) continue;
    const until = ext.until ?? addMonths(valid, ext.months ?? 0);
    if (until <= valid) continue;
    return { until, ref: ext.ref };
  }
  return null;
}

/** The date a registration actually runs to: its own, or a later extension. */
export function effectiveValidTo(
  validTo: Date | string | null | undefined,
  extendedUntil?: Date | string | null,
): string | null {
  const a = validTo ? day(validTo) : null;
  const b = extendedUntil ? day(extendedUntil) : null;
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------

/** Has a verified registration run out? */
export function isExpired(validTo: Date | string | null, now = new Date()): boolean {
  if (!validTo) return false;
  const d = validTo instanceof Date ? validTo : new Date(validTo);
  return d.getTime() < now.getTime();
}

/**
 * The single question every campaign asks. Advertising an unregistered phase
 * is barred by Section 3, with penalties of Rs 10,000 to Rs 50,000 per
 * advertisement, so this fails closed on anything it is unsure about.
 */
export function canAdvertise(record: {
  status: ReraStatus;
  validTo?: Date | string | null;
  /** An extension on the record, from an order or from a person. */
  extendedUntil?: Date | string | null;
  exemptionExpiresAt?: Date | string | null;
}, now = new Date(), { lapsedOk = isDevelopment() }: { lapsedOk?: boolean } = {}): { ok: boolean; why: string } {
  // `why` is shown to the client (the phase list, the Today card), so it says
  // what is so and what to do, never which section of the Act says it.
  if (record.status === "VERIFIED") {
    if (isExpired(effectiveValidTo(record.validTo, record.extendedUntil), now)) {
      // Development advertises a registration past its date (the client, 30
      // October 2026), so a pilot's lapsed tower can be built on; production
      // never does.
      if (lapsedOk) return { ok: true, why: "Registration expired. Allowed in development only." };
      return { ok: false, why: "Registration expired. Renew it or apply for an extension." };
    }
    return { ok: true, why: "Registration is verified and in date." };
  }
  if (record.status === "EXEMPT") {
    if (isExpired(record.exemptionExpiresAt ?? null, now)) {
      return { ok: false, why: "The exemption attestation is over 90 days old. Re-attest it." };
    }
    return { ok: true, why: "Exempt, and the attestation is in date." };
  }
  return { ok: false, why: "Not registered yet, so it can't be advertised." };
}
