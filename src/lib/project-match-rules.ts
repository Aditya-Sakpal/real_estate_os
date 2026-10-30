/**
 * Which other projects a call may offer a buyer this one does not suit.
 *
 * Offered only when it closely fits what the buyer wants: in the same city,
 * selling the size they asked for, with a home inside their budget, nearest
 * their area first. What the buyer has not said yet does not narrow, so a
 * first call carries the city's projects and a later one only those that
 * fit. A mandate firm sells one developer's project on mandate and is never
 * offered another (`offersOtherProjects()`).
 *
 * Relative imports: `check:logic` loads this from source.
 */
import { configDef } from "./unit-rules.ts";

/** At most this many other projects ride on a call. */
export const OTHER_PROJECTS_MAX = 3;
/** A home this far over the buyer's budget still fits: "90 lakh" buys a 93 lakh flat with a stretch. */
export const BUDGET_STRETCH = 1.1;

export type Want = { beds: number[]; budgetMax: number | null; area: string | null; city: string | null };

export type Candidate = {
  name: string;
  city: string | null;
  location: string | null;
  units: { label: string; config: string | null; carpetSqft: number; price: number | null }[];
};

/** A mandate firm works one project at a time; a developer and a channel partner offer their others. */
export const offersOtherProjects = (orgType: string | null | undefined) => orgType !== "MANDATE_FIRM";

const BAND_MAX: Record<string, number | null> = {
  UNDER_60L: 60_00_000,
  "60L_90L": 90_00_000,
  "90L_1_5CR": 1_50_00_000,
  ABOVE_1_5CR: null,
  "Under Rs 60 lakh": 60_00_000,
  "Rs 60 to 90 lakh": 90_00_000,
  "Rs 90 lakh to 1.5 Cr": 1_50_00_000,
  "Above Rs 1.5 Cr": null,
};

/** The bedrooms a configuration means: "2BHK", "2_BHK" or "2 BHK" is 2; a plot, a villa or a shop is none. */
export function bedsOf(config: string | null | undefined): number | null {
  if (!config) return null;
  const key = config.replace(/\s+/g, "").toUpperCase();
  // "2BHK", "2_BHK", "2.5BHK", "2_5BHK", "2_5_BHK".
  const m = /^(\d+)(?:[._](5))?_?BHK$/.exec(key);
  if (m) return Number(m[1]) + (m[2] ? 0.5 : 0);
  const def = configDef(key);
  return def && typeof def.beds === "number" ? def.beds : null;
}

/**
 * What the buyer wants, from the lead's board fields and what calls heard
 * (the reading, when it was sure enough). The board wins: a person typed it.
 */
export function wantOf(o: {
  facts?: { config?: string; budget?: string } | null;
  heard?: { configuration?: { value: string; confidence: number }; budget_band?: { value: string; confidence: number }; micro_market?: { value: string; confidence: number; detail?: string } } | null;
  city: string | null;
}): Want {
  const sure = (h?: { confidence: number }) => !!h && h.confidence >= 0.5;
  const config = o.facts?.config ?? (sure(o.heard?.configuration) ? o.heard!.configuration!.value : null);
  const band = o.facts?.budget ?? (sure(o.heard?.budget_band) ? o.heard!.budget_band!.value : null);
  const beds = bedsOf(config);
  const area = sure(o.heard?.micro_market) ? (o.heard!.micro_market!.detail ?? o.heard!.micro_market!.value).trim() || null : null;
  return { beds: beds === null ? [] : [beds], budgetMax: band && band in BAND_MAX ? BAND_MAX[band] : null, area, city: o.city };
}

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The projects to offer, best first: in the buyer's city, each cut to the
 * homes that fit, dropped when none do, the buyer's own area first, then the
 * nearest price to their budget.
 */
export function pickProjectsFor(candidates: readonly Candidate[], want: Want): Candidate[] {
  const city = want.city ? fold(want.city) : null;
  const fits = candidates
    .filter((c) => !city || (c.city !== null && fold(c.city) === city))
    .map((c) => ({
      ...c,
      units: c.units.filter((u) => {
        if (want.beds.length) {
          const b = bedsOf(u.config) ?? bedsOf(u.label);
          if (b === null || !want.beds.includes(b)) return false;
        }
        if (want.budgetMax !== null && (u.price === null || u.price > want.budgetMax * BUDGET_STRETCH)) return false;
        return true;
      }),
    }))
    .filter((c) => c.units.length > 0);
  const area = want.area ? fold(want.area) : null;
  const inArea = (c: Candidate) => !!area && !!c.location && fold(c.location).includes(area);
  const cheapest = (c: Candidate) => Math.min(...c.units.map((u) => u.price ?? Infinity));
  const gap = (c: Candidate) => (want.budgetMax !== null ? Math.abs(want.budgetMax - cheapest(c)) : cheapest(c));
  return fits
    .sort((a, b) => Number(inArea(b)) - Number(inArea(a)) || gap(a) - gap(b) || a.name.localeCompare(b.name))
    .slice(0, OTHER_PROJECTS_MAX);
}
