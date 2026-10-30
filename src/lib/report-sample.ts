/**
 * A year of invented weekly figures to lay the reports out with.
 *
 * There is no lead, visit or booking table and no ad-account connector, so
 * every figure here is invented and the screen says so. What is not invented
 * is the shape. Cost per lead, reach, qualification, visit and booking rates
 * sit inside the ranges Indian developers report for each source: Google
 * leads cost more and book better than Meta's, portal leads are shared with
 * other developers and book worst, partners bring most bookings and cost a
 * commission rather than media, and a referral books best of all. Recent
 * weeks run a festive push. Bookings land weeks after their leads.
 *
 * Seeded from the date, so the reports are stable through a day.
 */

import { addDays } from "./lead-rules.ts";
import { seeded } from "./seeded.ts";
import { ZERO, matured, type Counts } from "./report-rules.ts";

export type Row = {
  week: string;
  project: string;
  source: string;
  campaign: string;
  /** The ad itself, for bought media; the campaign again otherwise. */
  creative: string;
  /** The city the tower sits in: its REGION node. */
  market: string;
  tower: string;
  counts: Counts;
};

export type Cohort = { week: string; leads: number; eventual: number };

export type ReportData = {
  /** Monday of each week, oldest first. The last is this week, still running. */
  weeks: string[];
  rows: Row[];
  cohorts: Cohort[];
};

type Profile = {
  /** Weekly media spend, or 0 for a source that is not bought. */
  spend: number;
  /** Cost per lead, for bought sources; leads a week otherwise. */
  cpl: number;
  leadsPerWeek?: number;
  reach: number;
  qualify: number;
  visit: number;
  book: number;
};

/** Sath Heights-sized: two projects, about Rs 7 lakh of media a month. */
const PROFILE: Record<string, Profile> = {
  meta: { spend: 58_000, cpl: 470, reach: 0.78, qualify: 0.32, visit: 0.3, book: 0.17 },
  google: { spend: 46_000, cpl: 880, reach: 0.86, qualify: 0.41, visit: 0.35, book: 0.2 },
  "99acres": { spend: 28_000, cpl: 1_120, reach: 0.7, qualify: 0.3, visit: 0.28, book: 0.15 },
  magicbricks: { spend: 17_000, cpl: 1_240, reach: 0.68, qualify: 0.28, visit: 0.27, book: 0.14 },
  housing: { spend: 15_000, cpl: 960, reach: 0.72, qualify: 0.3, visit: 0.28, book: 0.15 },
  cp: { spend: 0, cpl: 0, leadsPerWeek: 86, reach: 0.95, qualify: 0.6, visit: 0.45, book: 0.18 },
  walkin: { spend: 0, cpl: 0, leadsPerWeek: 7, reach: 1, qualify: 0.72, visit: 1, book: 0.11 },
  referral: { spend: 0, cpl: 0, leadsPerWeek: 5, reach: 0.95, qualify: 0.62, visit: 0.52, book: 0.26 },
};

/**
 * Campaigns per source, with their share of its spend and how well their
 * leads convert relative to the source. `from` is how many weeks ago the
 * campaign started, for the ones that have not always run.
 */
const CAMPAIGNS: Record<string, { name: string; share: number; quality: number; from?: number }[]> = {
  meta: [
    { name: "Launch, lead form", share: 0.45, quality: 0.85 },
    { name: "Festive offer, lead form", share: 0.35, quality: 0.8, from: 6 },
    { name: "Click to WhatsApp", share: 0.2, quality: 1.35 },
  ],
  google: [
    { name: "Search, 2 BHK near Hinjewadi", share: 0.45, quality: 1.1 },
    { name: "Search, brand name", share: 0.2, quality: 1.7 },
    { name: "Performance Max", share: 0.35, quality: 0.7 },
  ],
  "99acres": [{ name: "Premium listing", share: 1, quality: 1 }],
  magicbricks: [{ name: "Featured listing", share: 1, quality: 1 }],
  housing: [{ name: "Listing boost", share: 1, quality: 1 }],
  cp: [{ name: "Partner network", share: 1, quality: 1 }],
  walkin: [{ name: "Walk-in", share: 1, quality: 1 }],
  referral: [{ name: "Buyer referral", share: 1, quality: 1 }],
};

/** Average agreement value, for what a partner booking costs in commission. */
const AVG_AGREEMENT = 88_00_000;
const AVG_RATE = 0.025;

export const WEEKS = 52;

/** The formats a sample ad rotates through, so the creative view has something to split. */
const SAMPLE_FORMATS = ["image", "carousel", "video"];

/** Monday on or before a civil date. */
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}

export function sampleReport(opts: { today: string; projects: string[] }): ReportData {
  const { today, projects } = opts;
  const thisWeek = mondayOf(today);
  const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(thisWeek, -7 * (WEEKS - 1 - i)));
  // The week still running has only had some of its days.
  const daysIn = Math.min(7, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${thisWeek}T00:00:00Z`)) / 86_400_000) + 1);
  const projectShare = projects.length > 1 ? [0.64, 0.36, 0.2].slice(0, projects.length) : [1];
  const shareTotal = projectShare.reduce((s, x) => s + x, 0);

  const rows: Row[] = [];
  const cohorts: Cohort[] = weeks.map((week) => ({ week, leads: 0, eventual: 0 }));
  // Whole people from fractional expectations, carrying each series' remainder
  // into its next week, so any run of weeks adds up to what the rates say
  // rather than swinging a quarter's bookings by a third on rounding.
  const owed = new Map<string, number>();
  const carry = (key: string, x: number) => {
    const acc = (owed.get(key) ?? 0) + x;
    const n = Math.floor(acc);
    owed.set(key, acc - n);
    return n;
  };

  weeks.forEach((week, wi) => {
    const ago = WEEKS - 1 - wi;
    const partial = ago === 0 ? daysIn / 7 : 1;
    // The festive push: Meta spend up and every source busier.
    const festive = ago <= 5 ? 1.3 : 1;
    projects.forEach((project, pi) => {
      const pShare = projectShare[pi] / shareTotal;
      for (const [source, prof] of Object.entries(PROFILE)) {
        for (const [ci, c] of CAMPAIGNS[source].entries()) {
          if (c.from !== undefined && ago > c.from) continue;
          const r = seeded(`${today}|${week}|${project}|${source}|${c.name}`);
          const round = (x: number) => Math.floor(x + r.next());
          const wobble = 0.85 + r.next() * 0.3;
          const push = source === "meta" ? festive * 1.1 : festive;
          const spend = Math.round(prof.spend * c.share * pShare * push * wobble * partial);
          const leadsExact = prof.spend
            ? spend / prof.cpl
            : (prof.leadsPerWeek ?? 0) * pShare * c.share * festive * wobble * partial;
          // Each stage comes from its own expectation, never above the stage
          // before it.
          const q = Math.min(0.95, prof.qualify * c.quality);
          const b = Math.min(0.6, prof.book * Math.sqrt(c.quality));
          const k = `${project}|${source}|${c.name}`;
          const leads = carry(`${k}|l`, leadsExact);
          const reached = Math.min(leads, carry(`${k}|r`, leadsExact * prof.reach));
          const qualified = Math.min(reached, carry(`${k}|q`, leadsExact * prof.reach * q));
          const visited = Math.min(qualified, carry(`${k}|v`, leadsExact * prof.reach * q * prof.visit));
          const bookedAll = Math.min(visited, carry(`${k}|b`, leadsExact * prof.reach * q * prof.visit * b));
          const cancelled = Math.min(bookedAll, carry(`${k}|c`, bookedAll * 0.1));
          const booked = bookedAll - cancelled;
          // An agreement follows the booking by three weeks or so.
          const agreement = ago >= 3 ? booked : round(booked * (ago / 4));
          const commission = source === "cp" ? Math.round(booked * AVG_AGREEMENT * AVG_RATE * (0.85 + r.next() * 0.3)) : 0;
          rows.push({
            week,
            project,
            source,
            campaign: c.name,
            creative: prof.spend && (source === "meta" || source === "google") ? `${c.name}, ${SAMPLE_FORMATS[(ci + wi) % 3]}` : c.name,
            market: "Pune",
            tower: `Tower ${"ABC"[(pi + ci) % 3]}`,
            counts: { ...ZERO, spend, commission, leads, reached, qualified, visited, booked, agreement, cancelled },
          });

          // What this week's leads will book in the end, landed or not.
          cohorts[wi].leads += leads;
          cohorts[wi].eventual += leadsExact * prof.reach * q * prof.visit * b;
        }
      }
    });
  });

  return { weeks, rows, cohorts };
}

/** Bookings a lead week has produced so far. */
export function landed(c: Cohort, weeksAgo: number): number {
  return Math.round(c.eventual * matured(weeksAgo));
}

/** Closing managers, and how the visits of a period fell to them. */
export const HOST_SHARE: { host: string; share: number; converts: number; revisit: number }[] = [
  { host: "Nikhil Rao", share: 0.26, converts: 0.21, revisit: 0.34 },
  { host: "Asha Menon", share: 0.24, converts: 0.17, revisit: 0.29 },
  { host: "Karan Mehta", share: 0.2, converts: 0.24, revisit: 0.37 },
  { host: "Rutuja Pawar", share: 0.16, converts: 0.12, revisit: 0.22 },
  { host: "Imtiaz Khan", share: 0.14, converts: 0.15, revisit: 0.26 },
];
