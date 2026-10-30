/**
 * A week of invented site visits to lay the visit sheet out with.
 *
 * There is no site_visit table. Section 02's slot ledger, admission gate,
 * reminders and no-show recovery are designed and not built, so every visit
 * here is invented and the screen says so. What is not invented is the shape:
 * a visit runs the states `visit-rules.ts` names, today's visits are placed
 * against the real clock (a visit at 11:00 is on site at 11:20 and visited by
 * 1 pm), weekends fill and weekdays do not, and a gallery never books more
 * visits into an hour than it has hosts on the floor.
 *
 * Seeded from the date, so the week is stable through a day. Six of the
 * buyers are the lead board's own, on the days the board has them visiting,
 * so the two screens tell one story.
 */

import { addDays } from "./lead-rules.ts";
import { shownPhone } from "./mask-rules.ts";

const masked = (e164: string) => shownPhone(e164, "MASKED");
import { FIRST_NAMES, SAMPLE_FIRMS, sampleName, samplePhone, seeded, type Rng } from "./seeded.ts";
import {
  HOURS,
  fromMin,
  hostsOnDuty,
  hourOf,
  isWeekend,
  toMin,
  type Interest,
  type Objection,
  type Outcome,
  type Temperature,
  type Visit,
} from "./visit-rules.ts";

/** Closing managers. The first three are the lead board's owners. */
export const SITE_HOSTS = ["Nikhil Rao", "Asha Menon", "Karan Mehta", "Rutuja Pawar", "Imtiaz Khan"];

/** The days the sheet covers, relative to today. */
export const WEEK = [-1, 0, 1, 2, 3, 4, 5];

export type Site = { name: string; places: string[]; big: boolean; hosts: string[] };

/**
 * Projects from the place labels the page was given. The first project is
 * the bigger launch and gets the bigger gallery.
 */
export function sitesFrom(places: string[]): Site[] {
  const by = new Map<string, string[]>();
  for (const p of places) {
    const name = p.split(" · ")[0];
    by.set(name, [...(by.get(name) ?? []), p]);
  }
  const names = [...by.keys()];
  return names.map((name, i) => ({
    name,
    places: by.get(name)!,
    big: i === 0,
    hosts: i === 0 ? SITE_HOSTS.slice(0, 3).concat(SITE_HOSTS[3]) : [SITE_HOSTS[4], SITE_HOSTS[1], SITE_HOSTS[3]],
  }));
}

// ---------------------------------------------------------------------------

const CONFIG_BUDGET: readonly (readonly [string, string, number])[] = [
  ["1 BHK", "Under Rs 60 lakh", 1],
  ["2 BHK", "Rs 60 to 90 lakh", 5],
  ["2.5 BHK", "Rs 60 to 90 lakh", 2],
  ["3 BHK", "Rs 90 lakh to 1.5 Cr", 3],
  ["4 BHK", "Above Rs 1.5 Cr", 1],
];

const SOURCES: readonly (readonly [string, number])[] = [
  ["Channel partner", 44],
  ["Meta ad", 16],
  ["Google ad", 11],
  ["99acres", 8],
  ["MagicBricks", 5],
  ["Housing.com", 5],
  ["Referral", 6],
];

const VIA: Record<string, string> = {
  "Channel partner": "the partner's WhatsApp",
  "Meta ad": "an AI voice call",
  "Google ad": "WhatsApp",
  "99acres": "an AI voice call",
  MagicBricks: "an AI voice call",
  "Housing.com": "WhatsApp",
  Referral: "a call from the sales team",
  "Walk-in": "a walk-in at the gallery",
};

/** Busier around late morning and early evening, the way galleries fill. */
const HOUR_WEIGHT = [4, 8, 9, 5, 4, 5, 8, 9, 6];

const ASKS = [
  "Wants a high floor, east facing",
  "Coming with parents, needs a lift near the flat",
  "Asked about the loan tie-up",
  "Comparing with a project in Wakad",
  "Wants to see the sample flat",
  "Asked for parking for two cars",
  "Needs possession before June",
  "Investor, asked about rental yield",
];

const NOTES: Record<string, readonly string[]> = {
  Price: [
    "Liked the layout, stuck on the price. Wants the payment plan before the family sees it.",
    "Said the rate is a lakh over what they planned. Asked if floor rise can be waived.",
  ],
  Loan: ["Keen, but the loan is not sanctioned yet. Asked which banks we work with."],
  Location: ["Worried about the commute to Hinjewadi at peak hour. Wants to drive it once."],
  Family: ["Wife liked it, parents have not seen it. Coming back on Sunday with them."],
  "Possession date": ["Rent ends in March. Asked whether the tower will really be ready by then."],
  "Carpet area": ["Felt the second bedroom is small. Asked to see the 2.5 BHK instead."],
  Layout: ["Did not like the kitchen opening onto the living room. Asked for the other stack."],
  None: ["Very positive. Wants to block the unit on the 12th floor this week."],
  Other: ["Asked about maintenance charges and the club house fee."],
};

const NEXT_FOR: Record<string, string> = {
  Price: "Send the payment plan",
  Loan: "Share the loan offer",
  Location: "Call back in a week",
  Family: "Revisit with family",
  "Possession date": "Call back in a week",
  "Carpet area": "Revisit with family",
  Layout: "Call back in a week",
  None: "Hold a unit for 48 hours",
  Other: "Call back in a week",
};

function unitIn(r: Rng, place: string): string {
  const tower = place.split(" · ")[1] ?? place;
  const letter = (tower.match(/([A-Z])\s*$/)?.[1] ?? tower.charAt(0)).toUpperCase();
  return `${letter}-${r.int(3, 22)}${String(r.int(1, 8)).padStart(2, "0")}`;
}

function outcomeFor(r: Rng, temp: Temperature, place: string): Outcome {
  const objection = r.weighted<Objection>([
    ["Price", 30],
    ["Loan", 12],
    ["Location", 9],
    ["Family", 15],
    ["Possession date", 9],
    ["Carpet area", 8],
    ["Layout", 5],
    ["None", temp === "HOT" ? 20 : 6],
    ["Other", 4],
  ]);
  const interest: Interest =
    temp === "HOT" ? r.weighted([["Hot", 7], ["Warm", 3]]) : temp === "WARM" ? r.weighted([["Hot", 2], ["Warm", 6], ["Cold", 2]]) : r.weighted([["Warm", 3], ["Cold", 7]]);
  const shown = Array.from({ length: r.int(1, 3) }, () => unitIn(r, place));
  return {
    interest,
    objection,
    next: interest === "Cold" ? "Call back in a week" : NEXT_FOR[objection],
    shown: [...new Set(shown)],
    note: r.pick(NOTES[objection]),
  };
}

type Fate = "show" | "no_show" | "moved" | "cancelled" | "requested" | "blocked";

type Draft = Omit<Visit, "status" | "arrivedAt" | "outcome" | "movedTo"> & { fate: Fate; walkIn?: boolean };

/**
 * A visit's state at `nowMin` on `today`, from what was always going to happen
 * to it. Today's visits move through the day with the real clock.
 */
function settle(d: Draft, r: Rng, today: string, nowMin: number): Visit {
  const { fate, walkIn, ...v } = d;
  const day = Math.round((Date.parse(`${v.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const at = toMin(v.time);
  const base: Visit = { ...v, status: "confirmed" };

  if (fate === "cancelled") return { ...base, status: "cancelled" };
  if (fate === "blocked") return { ...base, status: "blocked", blocked: v.blocked ?? "cp_tag" };
  if (fate === "requested") return { ...base, status: day < 0 ? "lapsed" : "requested" };

  const arrival = walkIn ? at : at + r.int(-10, 20);
  const stay = r.int(55, 95);
  if (fate === "show") {
    if (day > 0 || (day === 0 && nowMin < arrival)) return base;
    const arrivedAt = fromMin(arrival);
    if (day === 0 && nowMin < arrival + stay) return { ...base, status: "on_site", arrivedAt };
    return { ...base, status: "visited", arrivedAt, outcome: outcomeFor(r, v.temp, v.place) };
  }

  // A no-show is declared half an hour after the slot.
  if (day > 0 || (day === 0 && nowMin < at + 30)) return base;
  if (fate === "moved") {
    const to = addDays(today, r.int(1, 3));
    return { ...base, status: "moved", movedTo: { date: to, time: r.pick(["11:00", "12:30", "16:00", "17:30"]) } };
  }
  return { ...base, status: "no_show" };
}

/** The lead board's buyers, on the days the board has them. */
function pinned(today: string, places: string[]): Draft[] {
  const p = (i: number) => places[i % places.length];
  const project = (i: number) => p(i).split(" · ")[0];
  const common = { visitNo: 1, decider: true, cab: false, toShow: [] as string[] };
  return [
    {
      ...common, id: "SV-4172", buyer: "Priya Sharma", phone: masked("+919820144210"), date: today, time: "16:30",
      project: project(0), place: p(0), config: "2 BHK", budget: "Rs 60 to 90 lakh", lang: "Hindi", temp: "WARM",
      party: 3, source: "99acres", cp: null, bookedVia: VIA["99acres"], bookedOn: addDays(today, -3),
      host: "Asha Menon", fate: "show", ask: "Coming with parents, needs a lift near the flat", cab: true,
      toShow: [unitIn(seeded("priya"), p(0)), unitIn(seeded("priya2"), p(0))],
    },
    {
      ...common, id: "SV-4188", buyer: "Rahul Bhosale", phone: masked("+919763300188"), date: addDays(today, 1), time: "12:00",
      project: project(2), place: p(2), config: "2 BHK", budget: "Rs 60 to 90 lakh", lang: "Marathi", temp: "WARM",
      party: 2, source: "Channel partner", cp: { firm: "Keystone Realty", agent: "Sagar Kale", tagDaysLeft: 58 },
      bookedVia: VIA["Channel partner"], bookedOn: today, host: "Asha Menon", fate: "requested",
      ask: "Noon was full, three other slots sent",
    },
    {
      ...common, id: "SV-4191", buyer: "Pooja Nair", phone: masked("+919890512029"), date: addDays(today, 1), time: "11:30",
      project: project(1), place: p(1), config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", lang: "English", temp: "HOT",
      party: 2, source: "Channel partner", cp: { firm: "Keystone Realty", agent: "Sagar Kale", tagDaysLeft: 41 },
      bookedVia: VIA["Channel partner"], bookedOn: today, host: "Karan Mehta", fate: "blocked", blocked: "cp_tag",
    },
    {
      ...common, id: "SV-4203", buyer: "Siddharth Gokhale", phone: masked("+919922018443"), date: addDays(today, 3), time: "11:00",
      project: project(1), place: p(1), config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", lang: "Marathi", temp: "HOT",
      party: 4, source: "Meta ad", cp: null, bookedVia: VIA["Meta ad"], bookedOn: addDays(today, -1),
      host: "Nikhil Rao", fate: "show", ask: "Wants a high floor, east facing",
    },
    {
      ...common, id: "SV-4209", buyer: "Neha Agarwal", phone: masked("+919850077124"), date: addDays(today, 4), time: "12:00",
      project: project(1), place: p(1), config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", lang: "English", temp: "HOT",
      party: 3, visitNo: 2, source: "Walk-in", cp: null, bookedVia: "a call from the sales team", bookedOn: addDays(today, -2),
      host: "Karan Mehta", fate: "show", ask: "Revisit with her husband, who signs",
    },
    {
      ...common, id: "SV-4131", buyer: "Aditi Kale", phone: masked("+919545210962"), date: addDays(today, -1), time: "11:30",
      project: project(0), place: p(0), config: "2.5 BHK", budget: "Rs 60 to 90 lakh", lang: "Marathi", temp: "HOT",
      party: 2, source: "Google ad", cp: null, bookedVia: VIA["Google ad"], bookedOn: addDays(today, -4),
      host: "Nikhil Rao", fate: "show",
    },
    {
      ...common, id: "SV-4137", buyer: "Vivek Jadhav", phone: masked("+919881234570"), date: addDays(today, -1), time: "17:00",
      project: project(0), place: p(0), config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", lang: "Marathi", temp: "HOT",
      party: 2, source: "Meta ad", cp: null, bookedVia: VIA["Meta ad"], bookedOn: addDays(today, -2),
      host: "Karan Mehta", fate: "no_show",
    },
  ];
}

/** How many visits a project books on a day, before the capacity cap. */
function demand(r: Rng, iso: string, big: boolean): number {
  if (isWeekend(iso)) return big ? r.int(36, 42) : r.int(20, 24);
  return big ? r.int(10, 14) : r.int(5, 8);
}

/**
 * The sample week, as of `nowIso`. `today` is the IST civil date and `places`
 * are the tenant's towers, or the sample ones where it has fewer than three.
 */
export function sampleVisits(opts: { today: string; nowIso: string; places: string[] }): Visit[] {
  const { today, places } = opts;
  const nowMin = toMin(
    new Date(Date.parse(opts.nowIso) + 330 * 60_000).toISOString().slice(11, 16),
  );
  const sites = sitesFrom(places);
  const out: Visit[] = [];
  // Above the lead board's pinned visits, so no two visits share an id.
  let serial = 5000;

  const fixed = pinned(today, places);
  const taken = new Map<string, number>();
  const key = (project: string, date: string, hour: string) => `${project}|${date}|${hour}`;
  for (const f of fixed) {
    const k = key(f.project, f.date, hourOf(f.time));
    if (f.fate !== "blocked") taken.set(k, (taken.get(k) ?? 0) + 1);
  }

  for (const offset of WEEK) {
    const date = addDays(today, offset);
    for (const site of sites) {
      const r = seeded(`${today}|${date}|${site.name}`);
      const want = demand(r, date, site.big);
      const cap = hostsOnDuty(date, site.big);
      const drafts: Draft[] = [];

      for (let n = 0; n < want; n++) {
        // Pick an hour by weight among those with a host free.
        const open = HOURS.map((h, i) => [h, taken.get(key(site.name, date, h)) ?? 0, HOUR_WEIGHT[i]] as const).filter(
          ([, used]) => used < cap,
        );
        if (!open.length) break;
        const hour = r.weighted(open.map(([h, , w]) => [h, w] as const));
        taken.set(key(site.name, date, hour), (taken.get(key(site.name, date, hour)) ?? 0) + 1);
        const time = r.chance(0.5) ? hour : `${hour.slice(0, 2)}:30`;

        const { name, lang } = sampleName(r);
        const [config, budget] = r.weighted(CONFIG_BUDGET.map(([c, b, w]) => [[c, b] as const, w] as const));
        const temp = r.weighted<Temperature>([["HOT", 3], ["WARM", 5], ["COLD", 2]]);
        // Every draw is taken whether or not it is used, so the stream never
        // depends on the clock and the day does not reshuffle as it passes.
        // A walk-in exists only once its minute has gone by.
        const walkRoll = r.chance(0.08);
        const walkIn = walkRoll && (offset < 0 || (offset === 0 && toMin(time) + 5 < nowMin));
        const drawnSource = r.weighted(SOURCES);
        const source = walkIn ? "Walk-in" : drawnSource;
        const place = r.pick(site.places);
        const drawnCp = {
          firm: r.pick(SAMPLE_FIRMS),
          agent: `${r.pick(FIRST_NAMES)} ${sampleName(r).name.split(" ")[1]}`,
          tagDaysLeft: r.int(6, 84),
        };
        const cp = source === "Channel partner" ? drawnCp : null;

        const drawnFate =
          offset < 0
            ? r.weighted<Fate>([["show", 72], ["no_show", 12], ["moved", 8], ["cancelled", 5], ["requested", 3]])
            : offset === 0
              ? r.weighted<Fate>([["show", 78], ["no_show", 13], ["moved", 5], ["cancelled", 3]])
              : offset <= 2
                ? r.weighted<Fate>([["show", 86], ["requested", 9], ["cancelled", 3], ["blocked", 2]])
                : r.weighted<Fate>([["show", 94], ["cancelled", 4], ["blocked", 2]]);
        const fate: Fate = walkIn ? "show" : drawnFate;
        const lead = r.int(1, 6);

        drafts.push({
          id: `SV-${serial++}`,
          buyer: name,
          phone: masked(samplePhone(r)),
          date,
          time,
          project: site.name,
          place,
          config,
          budget,
          lang,
          temp,
          party: r.weighted([[1, 2], [2, 5], [3, 3], [4, 2]]),
          decider: r.chance(0.7),
          visitNo: r.weighted([[1, 7], [2, 2], [3, 1]]),
          source,
          cp,
          bookedVia: VIA[source],
          bookedOn: walkIn ? date : addDays(date, -lead),
          // Somebody always forgets one: an upcoming visit with no host.
          host: offset >= 0 && offset <= 1 && n === 3 && site.big ? null : site.hosts[n % site.hosts.length],
          fate,
          blocked: fate === "blocked" ? r.weighted([["cp_tag", 3], ["consent", 1]]) : undefined,
          cab: r.chance(0.25),
          toShow: Array.from({ length: r.int(2, 3) }, () => unitIn(r, place)),
          ask: r.chance(0.35) ? r.pick(ASKS) : undefined,
          walkIn,
        });
      }

      // Each visit settles on its own stream, so one visit finishing does not
      // move the next one's arrival.
      for (const d of drafts) out.push(settle(d, seeded(`${today}|${d.id}`), today, nowMin));
    }
  }

  for (const f of fixed) out.push(settle(f, seeded(f.id), today, nowMin));

  return out.sort((a, b) => (a.date === b.date ? toMin(a.time) - toMin(b.time) : a.date < b.date ? -1 : 1));
}
