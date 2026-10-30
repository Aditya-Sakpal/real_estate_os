/**
 * What a buyer pays on top of a flat's price: GST, stamp duty and the
 * registration fee, by state and city. Pure and database-free, covered by
 * `check:logic`; `quotes.ts` reads the place and writes the quote.
 *
 * Every row names its source and the day it was read, and a row nobody has
 * verified refuses a quote rather than guessing: a quote is a number a
 * buyer pays against, and a wrong one is a Section 12 exposure of its own.
 * Researched 28 September 2026 (`doc/lead-engine-gaps.md`, appendix C).
 *
 * Two things no row can know, and every quote says so: duty is charged on
 * the higher of the price and the government's reference value (ready
 * reckoner, guidance, circle or jantri rate), which we do not hold; and
 * council and panchayat areas differ from the city rows here.
 *
 * Relative imports: `check:logic` loads this from source.
 */

export type TaxRow = {
  key: string;
  /** The registering state's code, as registration records carry it. */
  state: string;
  /** City names this row covers, lower case; "*" for the whole state. */
  cities: readonly string[] | "*";
  label: string;
  /** Duty as a percentage of the agreement value, for a man and for a woman buying alone. */
  duty: (value: number, woman: boolean) => number;
  /** The registration fee, in rupees. */
  registration: (value: number, woman: boolean) => number;
  source: string;
  readOn: string;
  verified: boolean;
  /** Why an unverified row is not used. */
  doubt?: string;
  /**
   * The concession a woman buying alone is given, in the row's own words.
   * Absent where the row records none, and then a quote never applies one.
   */
  woman?: string;
};

const pct = (value: number, rate: number) => Math.round((value * rate) / 100);

export const TAX_ROWS: readonly TaxRow[] = [
  {
    key: "MH_MUMBAI",
    state: "MH",
    cities: ["mumbai", "mumbai city", "mumbai suburban", "greater mumbai"],
    label: "Mumbai",
    duty: (_v, woman) => (woman ? 5 : 6),
    woman: "Stamp duty 1 point less for a woman buying alone",
    registration: (v) => Math.min(30_000, pct(v, 1)),
    source: "IGR Maharashtra, Stamp Act schedule of 22 July 2026 and fee table",
    readOn: "2026-09-28",
    verified: true,
  },
  {
    key: "MH_CORPORATION",
    state: "MH",
    cities: ["pune", "pimpri-chinchwad", "pimpri chinchwad", "pcmc", "nagpur", "thane", "navi mumbai"],
    label: "Pune, PCMC, Nagpur, Thane, Navi Mumbai",
    duty: (_v, woman) => (woman ? 6 : 7),
    woman: "Stamp duty 1 point less for a woman buying alone",
    registration: (v) => Math.min(30_000, pct(v, 1)),
    source: "IGR Maharashtra, Stamp Act schedule of 22 July 2026 and fee table",
    readOn: "2026-09-28",
    verified: true,
  },
  {
    key: "KA_URBAN",
    state: "KA",
    cities: "*",
    label: "Karnataka, urban",
    duty: () => 5.6,
    registration: (v) => pct(v, 2),
    source: "Karnataka Gazette RD/46/MNMU/2025 (fee 2% from 31 August 2025)",
    readOn: "2026-09-28",
    verified: false,
    doubt: "The surcharge is from a secondary source, and first-sale concessions up to Rs 45 lakh are not modelled.",
  },
  {
    key: "TG",
    state: "TG",
    cities: "*",
    label: "Telangana",
    duty: () => 7.5,
    registration: (v) => pct(v, 0.5),
    source: "Telangana Ready Reckoner, G.O.Ms.No.59 of 2021",
    readOn: "2026-09-28",
    verified: false,
    doubt: "The published parts of the duty do not add up to the total; confirm before use.",
  },
  {
    key: "TN",
    state: "TN",
    cities: "*",
    label: "Tamil Nadu",
    duty: () => 7,
    registration: (v) => pct(v, 2),
    source: "Tamil Nadu single-window fee table, G.O.(Ms) No.34 of 2023",
    readOn: "2026-09-28",
    verified: false,
    doubt: "The deed structure for an under-construction flat is not confirmed.",
  },
  {
    key: "DL",
    state: "DL",
    cities: "*",
    label: "Delhi",
    duty: (v, woman) => (v > 25_00_000 ? (woman ? 5 : 7) : woman ? 4 : 6),
    woman: "Stamp duty 2 points less for a woman buying alone",
    registration: (v) => pct(v, 1) + 100,
    source: "Delhi Gazette on MCD transfer duty, 10 July 2023",
    readOn: "2026-09-28",
    verified: true,
  },
  {
    key: "HR_GURUGRAM",
    state: "HR",
    cities: ["gurugram", "gurgaon"],
    label: "Gurugram",
    duty: (_v, woman) => (woman ? 5 : 7),
    registration: () => 50_000,
    source: "Haryana stamp schedule and Gurugram notifications",
    readOn: "2026-09-28",
    verified: false,
    doubt: "The registration fee's slabs below Rs 50,000 are not held.",
  },
  {
    key: "UP_NOIDA",
    state: "UP",
    cities: ["noida", "greater noida", "gautam buddha nagar"],
    label: "Noida",
    duty: (v, woman) => (woman && v <= 1_00_00_000 ? 6 : 7),
    registration: (v) => pct(v, 1),
    source: "UP IGRS official calculator",
    readOn: "2026-09-28",
    verified: false,
    doubt: "The deed type at the agreement stage is not confirmed.",
  },
  {
    key: "GJ",
    state: "GJ",
    cities: "*",
    label: "Gujarat",
    duty: () => 4.9,
    registration: (v, woman) => (woman ? 0 : pct(v, 1)),
    woman: "No registration fee for a woman buying alone",
    source: "Gujarat Stamp Act, 2 April 2025, and the garvi calculator guide",
    readOn: "2026-09-28",
    verified: true,
  },
  {
    key: "WB_URBAN",
    state: "WB",
    cities: "*",
    label: "West Bengal, urban",
    duty: (v) => (v > 1_00_00_000 ? 7 : 6),
    registration: (v) => pct(v, 1),
    source: "West Bengal registration department (rebate withdrawn from 1 July 2024)",
    readOn: "2026-09-28",
    verified: true,
  },
];

/** The concession a woman buying alone gets here, when the verified row records one. */
export function womanConcession(state: string | null | undefined, city: string | null | undefined): string | null {
  const row = taxRowFor(state, city);
  return row?.verified && row.woman ? row.woman : null;
}

/** The row for a place, verified or not; null when nothing covers it. */
export function taxRowFor(state: string | null | undefined, city: string | null | undefined): TaxRow | null {
  const st = (state ?? "").trim().toUpperCase();
  const c = (city ?? "").trim().toLowerCase();
  const inState = TAX_ROWS.filter((r) => r.state === st);
  return inState.find((r) => r.cities !== "*" && r.cities.includes(c)) ?? inState.find((r) => r.cities === "*") ?? null;
}

/** The cities GST's affordable-housing rule calls metropolitan (Notification 03/2019). */
const METROS = ["mumbai", "mumbai city", "mumbai suburban", "greater mumbai", "thane", "navi mumbai", "delhi", "new delhi", "noida",
  "greater noida", "ghaziabad", "gurugram", "gurgaon", "faridabad", "bengaluru", "bangalore", "chennai", "hyderabad", "kolkata"];

export const SQFT_PER_SQM = 10.7639;

/**
 * GST on a flat, as a percentage of its price: none once the completion
 * certificate is issued or it is first occupied, 1% on an affordable one
 * (carpet up to 60 sq m in a metro or 90 sq m elsewhere, and up to Rs 45
 * lakh), 5% otherwise. Notifications 03/2019 and 11/2017-CT(Rate).
 */
export function gstRate(o: { price: number; carpetSqft: number; city: string | null; completed: boolean }): number {
  if (o.completed) return 0;
  const sqm = o.carpetSqft / SQFT_PER_SQM;
  const metro = METROS.includes((o.city ?? "").trim().toLowerCase());
  return sqm <= (metro ? 60 : 90) && o.price <= 45_00_000 ? 1 : 5;
}

/**
 * Whether a configuration can be quoted at all. A flat, a villa and a row
 * house take the residential rates above. A plot (GST turns on whether the
 * land is developed) and a shop or office (a different rate and a different
 * credit question) have no verified rate here, so they are refused rather
 * than guessed.
 */
export function gstForKind(config: string | null | undefined): { ok: true } | { ok: false; why: string } {
  return config === "PLOT" || config === "SHOP" || config === "OFFICE"
    ? { ok: false, why: "Quotes for plots and commercial units are not available yet." }
    : { ok: true };
}

/** Why the day an occupancy certificate was received is refused, or null. Blank clears it. */
export function ocDateProblem(raw: string, todayIst: string): string | null {
  const d = raw.trim();
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return "Enter the day the certificate was received.";
  if (d > todayIst) return "The day it was received cannot be after today.";
  return null;
}

/** A phase is complete for GST once its occupancy certificate was received on or before today, in India. */
export function completedOn(ocReceivedOn: string | null | undefined, todayIst: string): boolean {
  return !!ocReceivedOn && /^\d{4}-\d{2}-\d{2}$/.test(ocReceivedOn) && ocReceivedOn <= todayIst;
}

export type QuoteNumbers = {
  /** Charges outside the agreement value, GST and duty (the maintenance deposit, legal charges). */
  charges: number;
  agreement: number;
  gstRate: number;
  gst: number;
  dutyRate: number;
  stampDuty: number;
  registration: number;
  allIn: number;
  row: { key: string; label: string; source: string; readOn: string; woman?: string };
};

export type TaxResult = { ok: true; numbers: QuoteNumbers } | { ok: false; why: string };

/**
 * What a flat costs the buyer, all in. Duty and the fee are on the
 * agreement value before GST. Each amount is rounded to the rupee on its own.
 */
export function quoteNumbers(o: {
  price: number;
  carpetSqft: number;
  state: string | null;
  city: string | null;
  completed: boolean;
  woman?: boolean;
  /** Charges outside the agreement value: added to the total, never taxed. */
  charges?: number;
}): TaxResult {
  if (!(o.price > 0)) return { ok: false, why: "The flat has no approved price." };
  const row = taxRowFor(o.state, o.city);
  if (!row) return { ok: false, why: `No stamp duty is recorded for ${o.city || o.state || "this place"}.` };
  if (!row.verified) return { ok: false, why: `Stamp duty for ${row.label} is not confirmed yet. ${row.doubt ?? ""}`.trim() };
  const woman = !!o.woman;
  if (woman && !row.woman) return { ok: false, why: `No concession for a woman buyer is recorded for ${row.label}.` };
  const g = gstRate({ price: o.price, carpetSqft: o.carpetSqft, city: o.city, completed: o.completed });
  const dutyRate = row.duty(o.price, woman);
  const gst = pct(o.price, g);
  const stampDuty = pct(o.price, dutyRate);
  const registration = row.registration(o.price, woman);
  const charges = Math.max(0, Math.round(o.charges ?? 0));
  return {
    ok: true,
    numbers: {
      charges,
      agreement: Math.round(o.price),
      gstRate: g,
      gst,
      dutyRate,
      stampDuty,
      registration,
      allIn: Math.round(o.price) + gst + stampDuty + registration + charges,
      row: { key: row.key, label: row.label, source: row.source, readOn: row.readOn, ...(woman ? { woman: row.woman } : {}) },
    },
  };
}
