import { parseDelimited } from "./csv-rules.ts";
import { UNIT_CONFIGS, configLabel } from "./unit-rules.ts";

/**
 * Inventory, as rules: reading a developer's availability sheet, and
 * deciding what an import changes.
 *
 * A unit TYPE is a product (the 2 BHK of 682 sq ft, signed, on an
 * advertisement). A UNIT is one flat, C-1203, with a floor, a facing and a
 * status that is true for about an hour. So this is fast and unsigned, and
 * nothing that builds an advertisement reads it. Three rules.
 *
 * 1. **Forgiving about shape, strict about outcome**, the rule the team
 *    import follows. The columns are found whatever the sheet calls them,
 *    and a row whose status or unit number cannot be read is refused with
 *    its line, never guessed at.
 * 2. **The CRM's rows are the CRM's.** An import never overwrites a flat the
 *    CRM sync wrote; it is counted as skipped and says why.
 * 3. **A flat matches a unit type or says it does not.** By configuration,
 *    and by carpet area when a tower sells two of one configuration. A flat
 *    that matches nothing is still counted, flagged as unmatched.
 *
 * Pure, so `check:logic` covers it.
 */

export type UnitStatus = "AVAILABLE" | "BLOCKED" | "BOOKED";
export const UNIT_STATUSES: UnitStatus[] = ["AVAILABLE", "BLOCKED", "BOOKED"];
export const STATUS_LABEL: Record<UnitStatus, string> = { AVAILABLE: "Available", BLOCKED: "Blocked", BOOKED: "Booked" };

export type Facing = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/** Rows one import takes. A tower has a few hundred flats; a township sends one sheet per tower. */
export const MAX_IMPORT_ROWS = 3000;

/** The words a sheet's header uses for each column, lower case, spaces squeezed. */
const HEADERS: Record<keyof ReadRow, string[]> = {
  unitNo: ["unit", "unit no", "unit number", "unit no.", "flat", "flat no", "flat no.", "flat number", "apartment", "apt", "unit id"],
  wing: ["wing", "block", "tower", "building"],
  floor: ["floor", "floor no", "floor no.", "level"],
  config: ["configuration", "config", "type", "unit type", "bhk", "typology"],
  carpet: ["carpet", "carpet area", "rera carpet", "rera carpet area", "carpet area (sq ft)", "carpet (sq ft)", "carpet sqft", "carpet area sqft"],
  facing: ["facing", "direction", "orientation"],
  status: ["status", "availability", "inventory status", "unit status"],
};

type ReadRow = {
  unitNo: string;
  wing: string;
  floor: string;
  config: string;
  carpet: string;
  facing: string;
  status: string;
};

const squeeze = (s: string) => s.toLowerCase().replace(/[_\s]+/g, " ").trim();

/** Which column holds what, from the header row. Null when there is no unit or status column. */
export function sheetColumns(header: readonly string[]): Partial<Record<keyof ReadRow, number>> | null {
  const cols: Partial<Record<keyof ReadRow, number>> = {};
  header.forEach((raw, i) => {
    const h = squeeze(raw);
    for (const [key, words] of Object.entries(HEADERS) as [keyof ReadRow, string[]][]) {
      if (cols[key] === undefined && words.includes(h)) cols[key] = i;
    }
  });
  return cols.unitNo !== undefined && cols.status !== undefined ? cols : null;
}

/** "Available", "unsold", "OPEN" and the rest, or null when it is none of them. */
export function readStatus(raw: string): UnitStatus | null {
  const s = squeeze(raw);
  if (/^(available|avail|open|unsold|vacant|for sale|free)$/.test(s)) return "AVAILABLE";
  if (/^(blocked|block|hold|on hold|reserved|held|mgmt hold|management hold|not for sale)$/.test(s)) return "BLOCKED";
  if (/^(booked|sold|allotted|alloted|registered|agreement done|token received)$/.test(s)) return "BOOKED";
  return null;
}

/** "2BHK", "2 bhk", "2.5 BHK", "Studio", or the catalog key itself. Null when unreadable. */
export function readConfig(raw: string): string | null {
  const s = squeeze(raw).replace(/\s+/g, "");
  if (!s) return null;
  const byKey = UNIT_CONFIGS.find((c) => c.key.toLowerCase() === s);
  if (byKey) return byKey.key;
  const byLabel = UNIT_CONFIGS.find((c) => c.label.toLowerCase().replace(/\s+/g, "") === s);
  if (byLabel) return byLabel.key;
  const m = /^(\d(?:\.5)?)(?:bhk|bedroom|bed|br|rk)$/.exec(s);
  if (m) {
    const beds = Number(m[1]);
    return UNIT_CONFIGS.find((c) => c.beds === beds)?.key ?? (beds > 4 ? "4PLUS" : null);
  }
  return null;
}

const FACINGS: Record<string, Facing> = {
  n: "N", north: "N", ne: "NE", "north east": "NE", northeast: "NE", "north-east": "NE",
  e: "E", east: "E", se: "SE", "south east": "SE", southeast: "SE", "south-east": "SE",
  s: "S", south: "S", sw: "SW", "south west": "SW", southwest: "SW", "south-west": "SW",
  w: "W", west: "W", nw: "NW", "north west": "NW", northwest: "NW", "north-west": "NW",
};

export function readFacing(raw: string): Facing | null {
  return FACINGS[squeeze(raw).replace(/ facing$/, "")] ?? null;
}

/** "682", "682.5 sq ft", "682 sqft", "1,050". Square feet only: a sheet in square metres says so in the header. */
export function readCarpet(raw: string): number | null {
  const m = /^([\d,]+(?:\.\d+)?)\s*(?:sq\.?\s*ft\.?|sqft|sft)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n >= 80 && n <= 40_000 ? Math.round(n * 100) / 100 : null;
}

/** "12", "12th", "G" or "Ground" (0), "LG" (-1). */
export function readFloor(raw: string): number | null {
  const s = squeeze(raw);
  if (!s) return null;
  if (/^(g|gr|grd|ground)$/.test(s)) return 0;
  if (/^(lg|lower ground|b1|basement)$/.test(s)) return -1;
  const m = /^(-?\d{1,3})(?:st|nd|rd|th)?$/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= -5 && n <= 200 ? n : null;
}

/**
 * One flat as the sheet gives it. A field is `undefined` when the sheet has
 * no column for it at all, and then the stored value is kept: a sheet of just
 * unit numbers and statuses updates statuses and wipes nothing else.
 */
export type SheetUnit = {
  line: number;
  wing: string | null;
  unitNo: string;
  floor?: number | null;
  config?: string | null;
  carpetSqft?: number | null;
  facing?: Facing | null;
  status: UnitStatus;
};

export type SheetRead =
  | { ok: true; units: SheetUnit[]; refused: { line: number; reason: string }[] }
  | { ok: false; message: string };

/**
 * A sheet, already split into rows, to flats. The header row is the first
 * row that names a unit column and a status column, so a title row or two
 * above the table is fine.
 */
export function readSheet(rows: readonly (readonly string[])[]): SheetRead {
  const headerAt = rows.slice(0, 10).findIndex((r) => sheetColumns(r) !== null);
  if (headerAt < 0) return { ok: false, message: "The sheet needs a column for the unit number and one for its status." };
  const cols = sheetColumns(rows[headerAt])!;
  const body = rows.slice(headerAt + 1).map((r, i) => ({ r, line: headerAt + 2 + i })).filter(({ r }) => r.some((c) => c.trim()));
  if (!body.length) return { ok: false, message: "The sheet has a header and no flats under it." };
  if (body.length > MAX_IMPORT_ROWS) return { ok: false, message: `The sheet has ${body.length} flats. Send at most ${MAX_IMPORT_ROWS} at a time, one tower per sheet.` };

  const cell = (r: readonly string[], k: keyof ReadRow) => (cols[k] === undefined ? "" : (r[cols[k]!] ?? "").trim());
  const units: SheetUnit[] = [];
  const refused: { line: number; reason: string }[] = [];
  const seen = new Set<string>();
  for (const { r, line } of body) {
    const unitNo = cell(r, "unitNo").replace(/\s+/g, " ").slice(0, 40);
    if (!unitNo) {
      refused.push({ line, reason: "No unit number." });
      continue;
    }
    const status = readStatus(cell(r, "status"));
    if (!status) {
      refused.push({ line, reason: `Status "${cell(r, "status") || "blank"}" is not available, blocked or booked.` });
      continue;
    }
    const wing = cell(r, "wing").slice(0, 40) || null;
    const key = `${(wing ?? "").toLowerCase()}|${unitNo.toLowerCase()}`;
    if (seen.has(key)) {
      refused.push({ line, reason: `${wing ? `${wing} ` : ""}${unitNo} appears twice.` });
      continue;
    }
    seen.add(key);
    const has = (k: keyof ReadRow) => cols[k] !== undefined;
    const configRaw = cell(r, "config");
    const carpetRaw = cell(r, "carpet");
    units.push({
      line,
      wing,
      unitNo,
      ...(has("floor") ? { floor: readFloor(cell(r, "floor")) } : {}),
      ...(has("config") ? { config: configRaw ? readConfig(configRaw) : null } : {}),
      ...(has("carpet") ? { carpetSqft: carpetRaw ? readCarpet(carpetRaw) : null } : {}),
      ...(has("facing") ? { facing: readFacing(cell(r, "facing")) } : {}),
      status,
    });
  }
  return { ok: true, units, refused };
}

/** A pasted or uploaded CSV to rows. */
export const csvRows = (text: string): string[][] => parseDelimited(text);

// ---------------------------------------------------------------------------
// Matching a flat to a unit type
// ---------------------------------------------------------------------------

export type TypeForMatch = { id: string; config: string; carpetSqft: number | null };

/**
 * The configuration decides; carpet area settles it when the tower sells
 * two of one configuration, within two per cent. Anything else is no match
 * rather than the nearest one.
 */
export function matchUnitType(u: { config?: string | null; carpetSqft?: number | null }, types: readonly TypeForMatch[]): string | null {
  if (!u.config) return null;
  const same = types.filter((t) => t.config === u.config);
  if (same.length === 1) return same[0].id;
  if (!same.length || !u.carpetSqft) return null;
  const close = same.filter((t) => t.carpetSqft && Math.abs(t.carpetSqft - u.carpetSqft!) / t.carpetSqft <= 0.02);
  return close.length === 1 ? close[0].id : null;
}

// ---------------------------------------------------------------------------
// What an import changes
// ---------------------------------------------------------------------------

export type StoredUnit = {
  id: string;
  wing: string | null;
  unitNo: string;
  floor: number | null;
  config: string | null;
  carpetSqft: number | null;
  facing: string | null;
  status: UnitStatus;
  source: "CRM" | "IMPORT";
  unitTypeId: string | null;
};

/** A flat as it will be written: every field settled. */
export type PlannedUnit = {
  line: number;
  wing: string | null;
  unitNo: string;
  floor: number | null;
  config: string | null;
  carpetSqft: number | null;
  facing: Facing | null;
  status: UnitStatus;
  unitTypeId: string | null;
};

export type ImportPlan = {
  add: PlannedUnit[];
  change: (PlannedUnit & { id: string; statusChanged: boolean })[];
  same: number;
  /** Flats the CRM owns. */
  crm: number;
};

const unitKey = (wing: string | null, unitNo: string) => `${(wing ?? "").toLowerCase()}|${unitNo.toLowerCase()}`;

/**
 * The diff between the sheet and what is stored. Flats missing from the
 * sheet are left alone. `writer` is who is writing: a sheet (the import or a
 * live sheet) never overwrites a flat the CRM wrote; the CRM overwrites
 * anything, because a flat the CRM wrote wins over a sheet.
 */
export function planUnits(
  sheet: readonly SheetUnit[],
  stored: readonly StoredUnit[],
  types: readonly TypeForMatch[],
  writer: "IMPORT" | "CRM" = "IMPORT",
): ImportPlan {
  const byKey = new Map(stored.map((s) => [unitKey(s.wing, s.unitNo), s]));
  const plan: ImportPlan = { add: [], change: [], same: 0, crm: 0 };
  for (const u of sheet) {
    const have = byKey.get(unitKey(u.wing, u.unitNo));
    if (writer === "IMPORT" && have?.source === "CRM") {
      plan.crm++;
      continue;
    }
    const keep = <T>(v: T | undefined, stored: T | null | undefined): T | null => (v === undefined ? stored ?? null : v);
    const settled = {
      line: u.line,
      wing: u.wing,
      unitNo: u.unitNo,
      floor: keep(u.floor, have?.floor),
      config: keep(u.config, have?.config),
      carpetSqft: keep(u.carpetSqft, have?.carpetSqft),
      facing: keep(u.facing, have?.facing as Facing | null | undefined),
      status: u.status,
    };
    const unitTypeId = matchUnitType(settled, types);
    if (!have) {
      plan.add.push({ ...settled, unitTypeId });
      continue;
    }
    const differs =
      // The CRM taking over a flat a sheet wrote is a change even when nothing else moved.
      (writer === "CRM" && have.source !== "CRM") ||
      have.status !== settled.status ||
      have.floor !== settled.floor ||
      have.config !== settled.config ||
      (have.carpetSqft ?? null) !== settled.carpetSqft ||
      (have.facing ?? null) !== settled.facing ||
      have.unitTypeId !== unitTypeId;
    if (differs) plan.change.push({ ...settled, id: have.id, unitTypeId, statusChanged: have.status !== settled.status });
    else plan.same++;
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Availability, as a sales person reads it
// ---------------------------------------------------------------------------

export type Availability = { config: string; label: string; available: number; blocked: number; booked: number };

export function availabilityOf(units: readonly Pick<StoredUnit, "config" | "status">[]): Availability[] {
  const by = new Map<string, Availability>();
  for (const u of units) {
    const key = u.config ?? "";
    const row = by.get(key) ?? { config: key, label: key ? configLabel(key) : "Unmatched", available: 0, blocked: 0, booked: 0 };
    if (u.status === "AVAILABLE") row.available++;
    else if (u.status === "BLOCKED") row.blocked++;
    else row.booked++;
    by.set(key, row);
  }
  const order = (c: string) => {
    const i = UNIT_CONFIGS.findIndex((x) => x.key === c);
    return i < 0 ? 999 : i;
  };
  return [...by.values()].sort((a, b) => order(a.config) - order(b.config));
}

/** A lead's configuration ("2 BHK", the board's words) as the catalog key units carry. */
export function configKeyOf(leadConfig: string | null | undefined): string | null {
  return leadConfig ? readConfig(leadConfig) : null;
}

/** A sample sheet, for the empty state's download. */
export function exampleSheet(): string {
  return [
    "Wing,Unit No,Floor,Configuration,Carpet Area (sq ft),Facing,Status",
    "A,A-1201,12,2 BHK,682,East,Available",
    "A,A-1202,12,2 BHK,682,West,Booked",
    "A,A-1203,12,1 BHK,452,North,Blocked",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// A live sheet: a published sheet read every few minutes
// ---------------------------------------------------------------------------

/** A live sheet is read this often. The CRM worker runs every three minutes, so each pass reads it. */
export const FEED_EVERY_MS = 2 * 60_000;
/** A sheet that has not answered in this long is not going to. */
export const FEED_TIMEOUT_MS = 15_000;
/** A published sheet larger than this is not one tower's or one project's flats. */
export const FEED_MAX_BYTES = 2_000_000;
/** How long a worker holds a sheet it is reading. */
export const FEED_LEASE_MS = 2 * 60_000;

/** Hosts a live sheet may never be read from: this machine and private networks. */
function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^[0-9.]+$/.test(h) || h.includes(":")) return true;
  return false;
}

/**
 * The address a live sheet is read from. https only, never an address a
 * person could point at our own network. A Google Sheet published to the web
 * is read as CSV: a "pubhtml" link becomes its CSV twin. A Google Sheet's
 * editing link is refused, because it is not published and asks for a sign-in.
 */
export function feedUrl(raw: string | null | undefined): { ok: true; url: string } | { ok: false; why: string } {
  const t = (raw ?? "").trim();
  if (!t) return { ok: false, why: "Paste the sheet's published link." };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false, why: "That is not a link." };
  }
  if (u.protocol !== "https:") return { ok: false, why: "The link must start with https://." };
  if (u.username || u.password || privateHost(u.hostname)) return { ok: false, why: "That link cannot be read from here." };
  if (u.hostname === "docs.google.com" && u.pathname.startsWith("/spreadsheets/")) {
    if (!u.pathname.startsWith("/spreadsheets/d/e/")) {
      return { ok: false, why: "In Google Sheets, choose File, Share, Publish to web, pick CSV, and paste that link." };
    }
    u.pathname = u.pathname.replace(/\/pubhtml$/, "/pub");
    if (u.pathname.endsWith("/pub")) u.searchParams.set("output", "csv");
  }
  const url = u.toString();
  return url.length <= 2000 ? { ok: true, url } : { ok: false, why: "That link is too long." };
}

/** Whether a live sheet is due a read. */
export function feedDue(lastFetchedAt: Date | null, now: Date): boolean {
  return !lastFetchedAt || now.getTime() - lastFetchedAt.getTime() >= FEED_EVERY_MS;
}

const towerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * A project's sheet, split by tower. Each row names its tower in the sheet's
 * tower (or wing, or block) column, matched to a tower of the project by
 * name, "Tower C" or "C" alike. A row naming no tower of the project is
 * refused with its line rather than guessed.
 */
export function splitByTower(
  units: readonly SheetUnit[],
  towers: readonly { id: string; name: string }[],
): { byTower: Map<string, SheetUnit[]>; refused: { line: number; reason: string }[] } {
  const keyed = towers.map((t) => ({ id: t.id, keys: new Set([towerKey(t.name), towerKey(t.name.replace(/^(tower|wing|block|building)\s+/i, ""))]) }));
  const byTower = new Map<string, SheetUnit[]>();
  const refused: { line: number; reason: string }[] = [];
  for (const u of units) {
    const k = u.wing ? towerKey(u.wing) : "";
    const hit = k ? keyed.filter((t) => t.keys.has(k)) : [];
    if (hit.length !== 1) {
      refused.push({ line: u.line, reason: u.wing ? `"${u.wing}" is not a tower of this project.` : "No tower named." });
      continue;
    }
    byTower.set(hit[0].id, [...(byTower.get(hit[0].id) ?? []), { ...u, wing: null }]);
  }
  return { byTower, refused };
}
