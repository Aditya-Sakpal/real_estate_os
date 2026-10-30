/**
 * Home loans and price history, as a call may say them (10 October 2026).
 *
 * A buyer stretching for a home is comforted by the EMI, and one who owns a
 * flat already asks whether property still grows. Both are numbers, so code
 * works every one out: the EMI from the approved prices at a rate the
 * developer signed (or the published market rate), on what a bank lends
 * under the RBI's loan-to-value limits; the growth from an official price
 * index for the project's city. The agent says them as written, as "about",
 * and the price history always as past data and never a promise.
 *
 * The two tables below are dated and sourced. They are refreshed by hand
 * from the lenders' own rate pages and the index publishers; a table older
 * than its `staleAfterDays` stops being said rather than say an old rate.
 *
 * Pure: no database, no network. Covered by `check:logic`.
 */

import { emi, loanAmountFor } from "./visit-note-rules.ts";

export type LenderRate = {
  /** As a buyer hears it: "SBI", "HDFC Bank". */
  name: string;
  /** The lowest rate the lender publishes for a salaried borrower, % a year. */
  fromRate: number;
  source: string;
};

export type LoanMarket = {
  /** The day the rates were read from the lenders' pages. */
  readOn: string;
  staleAfterDays: number;
  repoRate: number;
  lenders: LenderRate[];
};

export type CityGrowth = {
  city: string;
  /** Other spellings of the city a scope tree may carry. */
  aliases: string[];
  /** The index the growth is read from, as said: "the RBI House Price Index". */
  index: string;
  /** The window the growth is over, in years, and its last quarter. */
  years: number;
  upTo: string;
  /** Compound growth a year over the window, %. */
  cagr: number;
  source: string;
};

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

// Read 10 October 2026 from each lender's own rate page. Only lenders whose
// published rate already stands on the repo rate of 7 October 2026 (5.50%)
// are listed: SBI, Axis, Kotak and Canara still showed tables on the old
// 5.25% repo that day, and are added back once their pages move.
export const LOAN_MARKET: LoanMarket = {
  readOn: "2026-10-10",
  staleAfterDays: 45,
  repoRate: 5.5,
  lenders: [
    { name: "Union Bank of India", fromRate: 7.4, source: "unionbankofindia.bank.in/pdf/retail_roi.pdf, w.e.f. 8 Oct 2026, salaried, CIC 825+" },
    { name: "Bank of Baroda", fromRate: 7.45, source: "bankofbaroda.bank.in retail loan rates, BRLLR 8.15% w.e.f. 8 Oct 2026 less 0.70%, salaried" },
    { name: "HDFC Bank", fromRate: 8.0, source: "homeloans.hdfc.bank.in home-loan-interest-rates, repo 5.50% + 2.50%" },
    { name: "ICICI Bank", fromRate: 8.75, source: "icici.bank.in home loan interest rates, repo effective 8 Oct 2026, salaried, score 750+" },
  ],
};

// NHB RESIDEX, read 10 October 2026: each city's compound growth a year over
// December 2015 to December 2025 on NHB's own linked FY2017-18 series, never
// spliced by us. The RBI index was rebased in 2025 and has no ten years.
export const PRICE_GROWTH: CityGrowth[] = [
  { city: "Mumbai", aliases: ["Bombay", "Mumbai Suburban", "Mumbai City"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 3.51, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 88.0 to Dec 2025 124.21" },
  { city: "Thane", aliases: [], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 3.16, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 96.0 to Dec 2025 131.03" },
  { city: "Navi Mumbai", aliases: ["New Bombay"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 3.07, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 100.0 to Dec 2025 135.28" },
  { city: "Pune", aliases: [], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 4.62, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 89.0 to Dec 2025 139.84" },
  { city: "Pimpri-Chinchwad", aliases: ["Pimpri Chinchwad", "PCMC"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 2.94, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 91.0 to Dec 2025 121.58" },
  { city: "Nagpur", aliases: [], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 3.57, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 87.0 to Dec 2025 123.54" },
  { city: "Nashik", aliases: ["Nasik"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 3.6, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 91.0 to Dec 2025 129.62" },
  { city: "Bengaluru", aliases: ["Bangalore"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 6.93, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 90.0 to Dec 2025 175.86" },
  { city: "Hyderabad", aliases: [], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 8.3, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 90.0 to Dec 2025 199.68" },
  { city: "Chennai", aliases: ["Madras"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 4.79, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 91.0 to Dec 2025 145.35" },
  { city: "Delhi", aliases: ["New Delhi"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 1.52, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 86.0 to Dec 2025 100.02" },
  { city: "Gurugram", aliases: ["Gurgaon"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 9.33, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 96.0 to Dec 2025 234.33" },
  { city: "Noida", aliases: ["Gautam Buddha Nagar", "Greater Noida"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 6.68, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 100.0 to Dec 2025 190.97" },
  { city: "Ahmedabad", aliases: [], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 9.7, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 90.0 to Dec 2025 227.11" },
  { city: "Kolkata", aliases: ["Calcutta"], index: "NHB RESIDEX, the National Housing Bank's official house price index", years: 10, upTo: "December 2025", cagr: 5.04, source: "residex.nhbonline.org.in, HPI at assessment prices, Dec 2015 96.0 to Dec 2025 156.96" },
];

// ---------------------------------------------------------------------------
// What a call says
// ---------------------------------------------------------------------------

/** How many lenders a call names, and how many homes it works the EMI for. */
const LENDERS_SAID = 3;
const EMI_HOMES = 3;
/** The tenure an EMI is quoted over. */
export const EMI_TENURE_YEARS = 20;

const DAY = 86_400_000;

/** Whether the market table may still be said on `today` (YYYY-MM-DD). */
export function marketCurrent(today: string, market: LoanMarket = LOAN_MARKET): boolean {
  if (!market.lenders.length) return false;
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${market.readOn}T00:00:00Z`)) / DAY;
  return Number.isFinite(age) && age >= 0 && age <= market.staleAfterDays;
}

/**
 * The rate an EMI is worked out at: the one the developer signed, else the
 * median of the published lowest rates, to two places. Never the lowest
 * alone, which few buyers get.
 */
export function emiRate(signed: number | null, market: LoanMarket = LOAN_MARKET): number | null {
  if (signed && signed > 0 && signed < 30) return signed;
  const rates = market.lenders.map((l) => l.fromRate).filter((r) => r > 0).sort((a, b) => a - b);
  if (!rates.length) return null;
  const mid = rates.length % 2 ? rates[(rates.length - 1) / 2] : (rates[rates.length / 2 - 1] + rates[rates.length / 2]) / 2;
  // To the nearest 0.05, the way a rate is said.
  return Math.round(mid * 20) / 20;
}

/** "8.5%", "7.25%": a rate as it is said, no trailing zeros. */
export function ratePct(r: number): string {
  return `${String(Math.round(r * 100) / 100)}%`;
}

const UNITS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function words(n: number): string {
  if (n < 20) return UNITS[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${UNITS[n % 10]}` : ""}`;
  return `${UNITS[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ""}`;
}

/**
 * An amount said "about", rounded DOWN so a buyer is never told the bank
 * lends more, or the EMI is less, than the arithmetic says: a lakh and more
 * to the lakh ("Rs 1.08 crore (one crore eight lakh)"), below it to the
 * thousand ("Rs 94,000 (ninety four thousand)").
 */
export function aboutRupees(n: number, round: "down" | "up" = "down"): string {
  const r = (x: number, step: number) => (round === "down" ? Math.floor(x / step) : Math.ceil(x / step)) * step;
  if (!(n > 0)) return "";
  if (n >= 1e5 && n < 1e6) {
    // An EMI above a lakh is still said to the thousand: Rs 1.35 lakh.
    const th = r(n, 1e3) / 1e3;
    const lakh = Math.floor(th / 100);
    const rest = th % 100;
    const fig = `Rs ${String(Math.round(th) / 100)} lakh`;
    return `${fig} (${words(lakh)} lakh${rest ? ` ${words(rest)} thousand` : ""})`;
  }
  if (n >= 1e5) {
    const lakhs = r(n, 1e5) / 1e5;
    const crore = Math.floor(lakhs / 100);
    const rest = lakhs % 100;
    const fig = crore ? `Rs ${String(Math.round((lakhs / 100) * 100) / 100)} crore` : `Rs ${lakhs} lakh`;
    const said = crore ? `${words(crore)} crore${rest ? ` ${words(rest)} lakh` : ""}` : `${words(lakhs)} lakh`;
    return `${fig} (${said})`;
  }
  const th = r(n, 1e3) / 1e3;
  return `Rs ${(th * 1000).toLocaleString("en-IN")} (${words(th)} thousand)`;
}

/**
 * The monthly instalment worked out the way the RBI says a bank lends: on
 * the loan-to-value share of the price, never the whole of it.
 */
export function emiFor(price: number, rate: number, years = EMI_TENURE_YEARS): { loan: number; emi: number } {
  const loan = loanAmountFor(price);
  return { loan, emi: emi(loan, rate, years) };
}

/**
 * The loan lines a call carries: the project's tie-ups as signed, what the
 * market's lenders publish (while the table is current), and the EMI on
 * the cheapest few homes. Empty when there is nothing true to say.
 */
export function loanLines(o: {
  banks: readonly string[];
  signedRate: number | null;
  homes: readonly { label: string; price: number | null }[];
  today?: string;
  market?: LoanMarket;
}): string[] {
  const market = o.market ?? LOAN_MARKET;
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  const current = marketCurrent(today, market);
  const out: string[] = [];
  const banks = [...new Set(o.banks.map((b) => b.trim()).filter(Boolean))].slice(0, 4);
  if (banks.length) out.push(`Home-loan tie-ups for this project: ${banks.join("; ")}.`);
  if (current) {
    const named = [...market.lenders].sort((a, b) => a.fromRate - b.fromRate).slice(0, LENDERS_SAID);
    out.push(
      `Home loans in India today start at about ${ratePct(named[0].fromRate)} a year (${named.map((l) => `${l.name} ${ratePct(l.fromRate)}`).join(", ")}, as each bank publishes it). Each bank decides a buyer's own rate.`,
    );
  }
  const rate = o.signedRate && o.signedRate > 0 ? o.signedRate : current ? emiRate(null, market) : null;
  const priced = o.homes.filter((h) => h.price && h.price > 0).slice(0, EMI_HOMES);
  if (rate && priced.length) {
    const parts = priced.map((h) => {
      const { loan, emi: m } = emiFor(h.price as number, rate);
      return `${h.label.trim()}: loan about ${aboutRupees(loan)}, EMI about ${aboutRupees(m, "up")} a month`;
    });
    out.push(
      `EMI at ${ratePct(rate)} for ${EMI_TENURE_YEARS} years, on what a bank lends (90% of the price while the loan is up to Rs 30 lakh, 80% while it is up to Rs 75 lakh, 75% above): ${parts.join("; ")}.`,
    );
  }
  return out;
}

const foldCity = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** The city's growth row, by its name or an alias, or null. */
export function growthFor(city: string | null, table: readonly CityGrowth[] = PRICE_GROWTH): CityGrowth | null {
  if (!city) return null;
  const c = foldCity(city);
  return table.find((g) => [g.city, ...g.aliases].some((n) => foldCity(n) === c)) ?? null;
}

/**
 * The price history line: the index's own growth for the city, and what a
 * Rs 1 crore home would be at that same past rate after the same number of
 * years, rounded down, ending that it is past data and not a guarantee.
 */
export function growthLine(city: string | null, table: readonly CityGrowth[] = PRICE_GROWTH): string | null {
  const g = growthFor(city, table);
  if (!g || !(g.cagr > 0) || !(g.years > 0)) return null;
  const then = 1e7 * (1 + g.cagr / 100) ** g.years;
  return `Price history: home prices in ${g.city} rose about ${ratePct(g.cagr)} a year over the ${words(g.years)} years to ${g.upTo} (${g.index}). At that same past rate, a Rs 1 crore home would be about ${aboutRupees(then)} after ${words(g.years)} years. This is past data, not a promise of future prices.`;
}
