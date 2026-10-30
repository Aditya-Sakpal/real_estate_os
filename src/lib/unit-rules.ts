/**
 * Unit types, decided without a database.
 *
 * A developer does not sell "Tower C". They sell a 1 BHK of 452 sq ft and a
 * 2 BHK of 682 sq ft in the same tower, at different prices, to different
 * people. Everything in this file exists because the product could not say
 * that, and two real failures followed: a creative for the 1 BHK could carry
 * the 2 BHK's living room, and the copy gate cleared "2 BHK from Rs 48 lakh"
 * whenever Rs 48 lakh was a signed price anywhere on that tower.
 *
 * What lives here is the catalog, the approval hash, the price rule, and the
 * reader that works out which configurations a piece of copy actually names.
 * Kept database-free so `npm run check:logic` exercises it directly.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

import { createHash } from "node:crypto";
import type { ScopeKind } from "./roles.ts";

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export type ConfigDef = {
  key: string;
  label: string;
  /**
   * How many bedrooms the name claims, where the name is a number.
   *
   * This is what lets the gate read "1 & 2 BHK" out of a headline. A villa
   * and a shop carry no number and are found by name instead.
   */
  beds: number | null;
  /**
   * How copy names it when it carries no number: the word as a regular
   * expression, singular and plural. Absent on a numbered one.
   */
  names?: string;
  /**
   * A word ordinary copy also uses for something else ("20 minutes to your
   * office", "shops nearby", "a yoga studio"), so it names the product only
   * where it reads as one: a price or "from" after it, a size, a BHK or
   * "commercial" before it. A villa or a penthouse is never anything but the
   * product, so it is matched by its word alone.
   */
  weak?: boolean;
  /** The word right before the name that makes it something else: a SITE office. */
  not?: string;
  /** Whether it may record a plot area: a plot, and a house on its own plot. */
  plot?: boolean;
};

/**
 * The configurations a tower can be sold in.
 *
 * In code rather than in the database for the reason the asset categories
 * and the permission keys are. Free text here would mean "2BHK", "2 bhk" and
 * "Two BHK" are three products, and the gate would be comparing a price
 * against whichever spelling the person who typed it used that day.
 */
export const UNIT_CONFIGS: ConfigDef[] = [
  {
    key: "STUDIO",
    label: "Studio",
    beds: null,
    names: "studios?",
    weak: true,
    not: "yoga|dance|music|fitness|recording|art|photo|pilates|design|film|gym|tattoo",
  },
  // One room and a kitchen, Mumbai's smallest flat. It counts as half a
  // bedroom, so `bedCountsIn()` reads "1 RK" and no BHK is ever taken for it.
  { key: "1RK", label: "1 RK", beds: 0.5 },
  { key: "1BHK", label: "1 BHK", beds: 1 },
  { key: "1_5BHK", label: "1.5 BHK", beds: 1.5 },
  { key: "2BHK", label: "2 BHK", beds: 2 },
  { key: "2_5BHK", label: "2.5 BHK", beds: 2.5 },
  { key: "3BHK", label: "3 BHK", beds: 3 },
  { key: "3_5BHK", label: "3.5 BHK", beds: 3.5 },
  { key: "4BHK", label: "4 BHK", beds: 4 },
  { key: "4_5BHK", label: "4.5 BHK", beds: 4.5 },
  { key: "5BHK", label: "5 BHK", beds: 5 },
  // Anything from four up. Named by its label, or by any count above four.
  { key: "4PLUS", label: "4+ BHK", beds: null },
  { key: "PENTHOUSE", label: "Penthouse", beds: null, names: "penthouses?|pent ?houses?" },
  // Two flats sold as one, the wall between them taken out.
  { key: "JODI", label: "Jodi flat", beds: null, names: "jodi(?: flats?| apartments?| homes?)?|jodis" },
  { key: "VILLA", label: "Villa", beds: null, names: "villas?", plot: true },
  { key: "ROWHOUSE", label: "Row house", beds: null, names: "row ?houses?|row-houses?", plot: true },
  { key: "PLOT", label: "Plot", beds: null, names: "plots?", weak: true, plot: true },
  {
    key: "SHOP",
    label: "Shop",
    beds: null,
    names: "shops?",
    weak: true,
    not: "coffee|tea|repair|barber|grocery|medical|chemist|sweet|pet|book|gift|flower|wine|liquor|convenience|kirana|pan|your|to|near",
  },
  {
    key: "OFFICE",
    label: "Office",
    beds: null,
    names: "offices?",
    weak: true,
    not: "site|sales|marketing|post|head|registered|corporate|back|booking|experience|government|tax|passport|your|to|near",
  },
];

/** A product sold by name, as an ad's price line names it: "Plots starting at". */
const PLURALS: Record<string, string> = {
  STUDIO: "Studios",
  PENTHOUSE: "Penthouses",
  JODI: "Jodi flats",
  VILLA: "Villas",
  ROWHOUSE: "Row houses",
  PLOT: "Plots",
  SHOP: "Shops",
  OFFICE: "Offices",
};

/**
 * What an ad's price line calls a configuration: "Plots starting at", never
 * "Plot starting at", the way the trade writes a product sold by name. A
 * numbered one ("1 RK", "2 BHK") and one with a variant's name keep their
 * label.
 */
export function priceLineLabel(c: { config?: string; label: string }): string {
  if (!c.config || c.label.trim() !== configLabel(c.config)) return c.label;
  return PLURALS[c.config] ?? c.label;
}

export function isUnitConfig(raw: string | null | undefined): boolean {
  return UNIT_CONFIGS.some((c) => c.key === raw);
}

export function configDef(key: string): ConfigDef | undefined {
  return UNIT_CONFIGS.find((c) => c.key === key);
}

export function configLabel(key: string): string {
  return configDef(key)?.label ?? key;
}

/**
 * The rooms a picture can be of.
 *
 * A column on `assets` rather than eight more asset categories, because
 * nothing about the compliance behaviour changes between a bedroom and a
 * kitchen: same artist's impression line, same level rule, same approval. A
 * category earns its place by changing one of those.
 */
export const ROOMS = [
  "Living room",
  "Bedroom",
  "Kitchen",
  "Bathroom",
  "Balcony",
  "Dining",
  "Study",
  "Entrance",
] as const;

export type Room = (typeof ROOMS)[number];

export function isRoom(raw: string | null | undefined): raw is Room {
  return ROOMS.includes((raw ?? "") as Room);
}

/** "2 BHK", or "2 BHK Optima" where a tower sells two of them. */
export function unitLabel(u: { config: string; variant: string | null }): string {
  const base = configLabel(u.config);
  const variant = u.variant?.trim();
  return variant ? `${base} ${variant}` : base;
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/** The units a plot is sold in. Stored in square feet; shown in the one chosen. */
export type AreaUnit = "SQFT" | "SQYD" | "SQM";

export const AREA_UNITS: { key: AreaUnit; label: string; sqft: number }[] = [
  { key: "SQFT", label: "sq ft", sqft: 1 },
  { key: "SQYD", label: "sq yd", sqft: 9 },
  { key: "SQM", label: "sq m", sqft: 10.7639 },
];

export function isAreaUnit(raw: unknown): raw is AreaUnit {
  return AREA_UNITS.some((u) => u.key === raw);
}

const unitOf = (u: AreaUnit | null | undefined) => AREA_UNITS.find((x) => x.key === u) ?? AREA_UNITS[0]!;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "200" sq yd as square feet, to two places: 1,800. */
export function toSqft(n: number, unit: AreaUnit | null | undefined): number {
  return round2(n * unitOf(unit).sqft);
}

/** Square feet back in the unit a person chose, to two places. */
export function fromSqft(sqft: number, unit: AreaUnit | null | undefined): number {
  return round2(sqft / unitOf(unit).sqft);
}

/** "200 sq yd", "1,800 sq ft". */
export function areaText(sqft: number, unit: AreaUnit | null | undefined): string {
  return `${fromSqft(sqft, unit).toLocaleString("en-IN", { maximumFractionDigits: 2 })} ${unitOf(unit).label}`;
}

/** Whether the signed rate is applied to the carpet area or to the plot. */
export type PriceBasis = "CARPET" | "PLOT";

/** A plot, a villa or a row house may record the plot it stands on. */
export function takesPlot(config: string): boolean {
  return !!configDef(config)?.plot;
}

export type UnitValues = {
  config: string;
  variant: string | null;
  /**
   * The carpet area. A plot has none, and its row carries the plot area here
   * too, so every reader that measures or prices by area reads the area sold.
   */
  carpetAreaSqft: number;
  balconyAreaSqft: number | null;
  /** Empty means "compute it from the signed rate per sq ft". */
  startingPrice: number | null;
  /** A plot's area, or the plot a villa stands on, in square feet. */
  plotAreaSqft?: number | null;
  /** The unit the plot area is shown in. */
  areaUnit?: AreaUnit | null;
  /** What the signed rate is applied to. A plot is always priced on its plot. */
  priceBasis?: PriceBasis | null;
};

/** What the rate applies to, read the same way everywhere. */
export function basisOf(u: { config?: string; plotAreaSqft?: number | null; priceBasis?: PriceBasis | null }): PriceBasis {
  if (!(u.plotAreaSqft && u.plotAreaSqft > 0)) return "CARPET";
  return u.config === "PLOT" || u.priceBasis === "PLOT" ? "PLOT" : "CARPET";
}

const money = (n: number | null): string =>
  n === null || !Number.isFinite(n) ? "" : n.toFixed(2);

/**
 * What an approver actually approved, as one string.
 *
 * The configuration and the variant are in it as well as the numbers. They
 * cannot be edited today, and hashing them anyway means that if an edit path
 * is ever added, every approval stops matching rather than quietly carrying
 * over onto what is now a different product.
 */
export function canonicalUnit(v: UnitValues): string {
  const lines = [
    v.config,
    (v.variant ?? "").trim(),
    money(v.carpetAreaSqft),
    money(v.balconyAreaSqft),
    money(v.startingPrice),
  ];
  // Appended only when there is a plot, so every row approved before plots
  // existed hashes exactly as it did and keeps its approval.
  if (v.plotAreaSqft && v.plotAreaSqft > 0) {
    lines.push(`plot ${money(v.plotAreaSqft)}`, `unit ${unitOf(v.areaUnit).key}`, `basis ${basisOf(v)}`);
  }
  return lines.join("\n");
}

export function unitHash(v: UnitValues): string {
  return createHash("sha256").update(canonicalUnit(v)).digest("hex");
}

/**
 * What this configuration starts at.
 *
 * Left empty, it is the carpet area times the phase's signed rate per sq ft,
 * so the one number that already carries a signature stays the source and
 * nobody retypes it into a second place where the two can disagree. Set, it
 * wins: a corner 2 BHK really is priced differently, and rounding that away
 * puts a figure on a hoarding that no quote will match.
 *
 * Rounded to the rupee. A price to two decimal places is not a price anybody
 * advertises.
 */
export function priceFor(
  unit: {
    config?: string;
    carpetAreaSqft: number;
    startingPrice: number | null;
    plotAreaSqft?: number | null;
    priceBasis?: PriceBasis | null;
  },
  basePsf: number | null,
): number | null {
  if (unit.startingPrice !== null && unit.startingPrice > 0) return unit.startingPrice;
  if (basePsf === null || !Number.isFinite(basePsf) || basePsf <= 0) return null;
  // A plot, or a villa whose rate is per square foot of its plot, is priced
  // on the plot; everything else on its carpet area.
  const area = basisOf(unit) === "PLOT" ? (unit.plotAreaSqft ?? 0) : unit.carpetAreaSqft;
  if (!Number.isFinite(area) || area <= 0) return null;
  return Math.round(area * basePsf);
}

/** "682 sq ft carpet", "200 sq yd plot", "2,400 sq ft carpet on a 300 sq yd plot". */
export function areaLine(u: {
  config: string;
  carpetAreaSqft: number;
  plotAreaSqft?: number | null;
  areaUnit?: AreaUnit | null;
}): string {
  const carpet = `${areaText(u.carpetAreaSqft, "SQFT")} carpet`;
  if (!(u.plotAreaSqft && u.plotAreaSqft > 0)) return carpet;
  const plot = areaText(u.plotAreaSqft, u.areaUnit);
  return u.config === "PLOT" ? `${plot} plot` : `${carpet} on a ${plot} plot`;
}

// ---------------------------------------------------------------------------
// Whether one may be written
// ---------------------------------------------------------------------------

/** Nobody sells a flat of four square feet, and nobody sells one of forty thousand. */
export const MIN_CARPET_SQFT = 80;
export const MAX_CARPET_SQFT = 40_000;

/** A plot is from about 33 sq yd to a few acres. */
export const MIN_PLOT_SQFT = 300;
export const MAX_PLOT_SQFT = 2_00_000;

export type UnitCheck =
  | { ok: true }
  | {
      ok: false;
      code: "CONFIG" | "WRONG_LEVEL" | "CARPET" | "BALCONY" | "PRICE" | "VARIANT" | "PLOT";
      message: string;
    };

/**
 * Whether a configuration may be recorded here, at all.
 *
 * The level rule is the one that matters. A configuration is a product inside
 * one tower, which is the same reason floor plans are pinned to a phase: one
 * tower's 3 BHK is not another's, and a project-level one would flow down and
 * price every tower off the cheapest.
 */
export function canAddUnitType(input: {
  config: string;
  variant: string | null;
  nodeKind: ScopeKind;
  carpetAreaSqft: number | null;
  balconyAreaSqft: number | null;
  startingPrice: number | null;
  /** Square feet, already converted from the unit typed. */
  plotAreaSqft?: number | null;
  areaUnit?: AreaUnit | null;
  priceBasis?: PriceBasis | null;
}): UnitCheck {
  if (!isUnitConfig(input.config)) {
    return { ok: false, code: "CONFIG", message: "Choose which configuration this is." };
  }
  if (input.nodeKind !== "PHASE") {
    return {
      ok: false,
      code: "WRONG_LEVEL",
      message: "A configuration belongs to one tower, so it goes on the phase.",
    };
  }
  if ((input.variant ?? "").trim().length > 40) {
    return { ok: false, code: "VARIANT", message: "Keep the variant name under 40 characters." };
  }
  const plot = input.plotAreaSqft ?? null;
  if (input.areaUnit != null && !isAreaUnit(input.areaUnit)) {
    return { ok: false, code: "PLOT", message: "Choose sq ft, sq yd or sq m for the plot area." };
  }
  if (plot !== null) {
    if (!takesPlot(input.config)) {
      return { ok: false, code: "PLOT", message: "Only a plot, a villa or a row house has a plot area." };
    }
    if (!Number.isFinite(plot) || plot < MIN_PLOT_SQFT || plot > MAX_PLOT_SQFT) {
      return {
        ok: false,
        code: "PLOT",
        message: Number.isFinite(plot) && plot > 0
          ? `A plot of ${areaText(plot, input.areaUnit)} is not one anybody sells.`
          : "Enter the plot area.",
      };
    }
  }
  if (input.config === "PLOT") {
    if (plot === null) return { ok: false, code: "PLOT", message: "Enter the plot area." };
    if (input.balconyAreaSqft !== null) {
      return { ok: false, code: "BALCONY", message: "A plot has no balcony area." };
    }
    const price = input.startingPrice;
    if (price !== null && (!Number.isFinite(price) || price <= 0)) {
      return { ok: false, code: "PRICE", message: "A starting price has to be a positive amount." };
    }
    return { ok: true };
  }
  if (input.priceBasis === "PLOT" && plot === null) {
    return { ok: false, code: "PLOT", message: "Enter the plot area the rate is for." };
  }
  const carpet = input.carpetAreaSqft;
  if (carpet === null || !Number.isFinite(carpet) || carpet <= 0) {
    return { ok: false, code: "CARPET", message: "Enter the carpet area in square feet." };
  }
  if (carpet < MIN_CARPET_SQFT || carpet > MAX_CARPET_SQFT) {
    return {
      ok: false,
      code: "CARPET",
      message: `A carpet area of ${carpet} sq ft is not a flat anybody sells.`,
    };
  }
  const balcony = input.balconyAreaSqft;
  if (balcony !== null && (!Number.isFinite(balcony) || balcony < 0 || balcony > carpet)) {
    return {
      ok: false,
      code: "BALCONY",
      message: "The balcony area has to be a positive number smaller than the carpet area.",
    };
  }
  const price = input.startingPrice;
  if (price !== null && (!Number.isFinite(price) || price <= 0)) {
    return { ok: false, code: "PRICE", message: "A starting price has to be a positive amount." };
  }
  if (price !== null && price < MIN_HOME_PRICE) {
    return {
      ok: false,
      code: "PRICE",
      message: `Rs ${Math.round(price).toLocaleString("en-IN")} looks like a rate per sq ft. Enter what the whole home starts at, or leave it empty to work it out from the rate.`,
    };
  }
  return { ok: true };
}

/**
 * Below this a home's starting price is a rate per sq ft typed in the wrong
 * box. Palm Grove' 1.5 BHK went in at Rs 31,500 on 17 October 2026 and its
 * film said "starting thirty one thousand five hundred rupees". The cheapest
 * new home a registered project sells is well above it.
 */
export const MIN_HOME_PRICE = 5_00_000;

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type UnitApprovalLike = {
  unitTypeId: string;
  sha256: string;
  byName: string | null;
  at: string;
};

export type UnitState = {
  approved: boolean;
  /** Approved once, then the numbers changed. The old approval is not it. */
  stale: boolean;
  byName: string | null;
  at: string | null;
};

/**
 * Whether this configuration may be advertised.
 *
 * The same shape as `assetState()`, and for the same reason: the approval
 * pins the values rather than the row, so a price rise leaves the approval
 * behind rather than carrying it forward. Putting the old numbers back makes
 * the original approval apply again, because that person really did approve
 * exactly those numbers.
 */
export function unitState(
  unit: { id: string; sha256: string },
  approvals: readonly UnitApprovalLike[],
): UnitState {
  const mine = approvals.filter((a) => a.unitTypeId === unit.id);
  const current = mine.find((a) => a.sha256 === unit.sha256);
  if (current) {
    return { approved: true, stale: false, byName: current.byName, at: current.at };
  }
  return { approved: false, stale: mine.length > 0, byName: null, at: null };
}

// ---------------------------------------------------------------------------
// Reading a configuration out of a line of copy
// ---------------------------------------------------------------------------

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Above this, a number sitting in front of a BHK is not a bedroom count. */
export const MAX_BEDS = 10;

/**
 * Every bedroom count a line of copy names.
 *
 * "1 & 2 BHK from Rs 48 lakh" is the ordinary way an Indian launch ad is
 * written, and reading only the 2 out of it would refuse a lawful headline
 * for quoting the 1 BHK's price. So the numbers in front of a BHK are all
 * collected, however they were joined: an ampersand, a slash, a comma or the
 * word "and".
 *
 * The text must already have had `toAsciiDigits()` run over it. That lives
 * beside the gate, and importing it here would tie the catalog to the gate in
 * a circle.
 */
export function bedCountsIn(raw: string): number[] {
  const text = fold(raw).replace(/\band\b/g, ",").replace(/&/g, ",");
  const found: { at: number; v: number }[] = [];
  const add = (at: number, v: number) => {
    if (!found.some((f) => f.v === v)) found.push({ at, v });
  };
  // "1 BED" and "2 bedrooms" name a configuration as surely as "1 BHK": the
  // film's big text is written that way, and so are many developers' ads.
  for (const m of text.matchAll(/([0-9][0-9\s.,+/-]*?)\s*(?:bhk|bed(?:room)?s?\b)/g)) {
    for (const n of (m[1] ?? "").matchAll(/\d+(?:\.\d+)?/g)) {
      const v = Number(n[0]);
      // Anything else that ran into the BHK is not a bedroom count. A phone
      // number on the line above reaches here, because digits, spaces and
      // commas are exactly what separates "1, 2" from "9876543210, 2", and
      // refusing a headline for advertising a 9876543210 BHK would be a worse
      // failure than the rule is worth.
      if (Number.isFinite(v) && v > 0 && v <= MAX_BEDS) add((m.index ?? 0) + (n.index ?? 0), v);
    }
  }
  // "1 RK", "1RK", "1 R.K.": a room and a kitchen, half a bedroom. Only one
  // is ever sold, so "2 RK" is read as nothing rather than as a 1.5 BHK.
  for (const m of text.matchAll(/(?<![\d.])(\d+)\s*r\.?\s?k\b/g)) {
    if (m[1] === "1") add(m.index ?? 0, 0.5);
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.v);
}

const AREA_WORDS =
  "sq\\.?\\s*(?:ft|feet|foot|yds?|yards?|m|mtrs?|metres?|meters?)\\b|sqft|sqyds?|sqm\\b|square\\s+(?:feet|foot|yards?|metres?|meters?)|acres?|gunthas?";
/** After the name: a price, "from", "starting", a size, or a noun that makes it a unit. */
const PRODUCT_AFTER = new RegExp(
  "^\\s*(?:(?:spaces?|units?|suites?|apartments?|homes?|flats?|sizes?)\\b" +
    "|(?:[\\p{L}]+\\s+){0,2}?(?:from|starting|starts|onwards|priced|available|for sale|on sale|launching|now selling)\\b" +
    "|(?:at\\s+)?(?:₹|rs\\b|rs\\.|inr\\b)" +
    `|(?:of\\s+)?\\d[\\d,.]*\\s*(?:${AREA_WORDS}))`,
  "u",
);
/**
 * Before the name: a size, a BHK, or a word that sells it. Not acres: "a
 * 12 acre plot" is the land a tower stands on, and "200 sq yd plots" are
 * what is sold.
 */
const PRODUCT_BEFORE = new RegExp(
  `(?:\\d[\\d,.]*\\s*(?:${AREA_WORDS.replace("|acres?", "")}|bhk|r\\.?\\s?k\\b)` +
    "|(?:^|[^\\p{L}])(?:residential|commercial|retail|n\\.?a\\.?|premium|luxury|independent|gated|buy|own|book|exclusive|limited|ready|signature|duplex|spacious|lavish))\\s*$",
  "u",
);
/** "villa-style", "penthouse-like": a look, not the product. */
const ONLY_A_LOOK = /^-?\s*(?:style|styled|like|inspired|esque)\b/;

/**
 * Whether the name of a configuration sold by name appears in `text` as the
 * thing for sale.
 *
 * A whole word, singular or plural, never inside another one: "plotted
 * development" is not a plot. A weak word ("office", "shop", "plot",
 * "studio") counts only where it reads as the product, which is what keeps
 * "20 minutes to your office" and "shops nearby" off a residential tower's
 * advertisement's list of what it offers. `asProduct` holds a strong word
 * (a villa, a penthouse) to the same reading, for the check that asks what
 * the copy OFFERS rather than which recorded product it means.
 */
function namesProduct(text: string, def: ConfigDef, asProduct: boolean): boolean {
  if (!def.names) return false;
  const word = new RegExp(`(?<![\\p{L}\\p{N}])(?:${def.names})(?![\\p{L}\\p{N}])`, "gu");
  const not = def.not ? new RegExp(`(?:^|[^\\p{L}])(?:${def.not})\\s*$`, "u") : null;
  for (const m of text.matchAll(word)) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 40), at);
    const after = text.slice(at + m[0].length, at + m[0].length + 60);
    if (ONLY_A_LOOK.test(after)) continue;
    if (not?.test(before)) continue;
    if (!def.weak && !asProduct) return true;
    if (PRODUCT_AFTER.test(after) || PRODUCT_BEFORE.test(before)) return true;
  }
  return false;
}

/**
 * Which of this tower's configurations a piece of copy is talking about.
 *
 * A numbered one is matched on its bedroom count, so "2 BHK" finds the 2 BHK
 * however the sentence around it was built. A villa, a plot or a shop has no
 * number, so it is matched on its name.
 *
 * Returning nothing is an ordinary answer, not a failure. Plenty of copy
 * names no configuration at all, and there is then nothing for the price rule
 * to be about.
 */
export function configsNamedIn(
  raw: string,
  configs: readonly string[],
  opts: { asProduct?: boolean } = {},
): string[] {
  const text = fold(raw);
  const beds = bedCountsIn(raw);
  const named: string[] = [];
  for (const key of configs) {
    const def = configDef(key);
    if (!def) continue;
    const hit =
      def.beds !== null
        ? beds.includes(def.beds)
        : key === "4PLUS"
          ? text.includes("4+ bhk") || beds.some((b) => b > 4)
          : namesProduct(text, def, !!opts.asProduct);
    if (hit && !named.includes(key)) named.push(key);
  }
  return named;
}

/** The catalog's configurations sold by name: a villa, a plot, a shop. */
export const NAMED_CONFIGS = UNIT_CONFIGS.filter((c) => c.beds === null && !!c.names).map((c) => c.key);

/**
 * Every configuration sold by name that a piece of copy OFFERS, whether or
 * not this tower records it: "Plots starting at", "office spaces from",
 * "200 sq yd plots", a penthouse named as one. What the gate holds when
 * nobody recorded it.
 */
export function namedProductsIn(raw: string): string[] {
  return configsNamedIn(raw, NAMED_CONFIGS, { asProduct: true });
}

/** Whether a bedroom count is one of the configurations recorded: 4+ covers every count from four. */
export function bedsRecorded(beds: number, recorded: readonly string[]): boolean {
  if (recorded.some((k) => configDef(k)?.beds === beds)) return true;
  return beds >= 4 && recorded.includes("4PLUS");
}
