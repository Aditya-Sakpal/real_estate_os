/**
 * Invented channel-partner firms, the buyers they registered and the
 * bookings they are owed for, to lay the partner desk out with.
 *
 * There is no partner, registration or payout table: section 07 of the
 * product flow doc designs them and nothing stores them yet, so every row
 * here is invented and the screen says so. What is not invented is the
 * shape. The money runs through `partner-rules.ts`, registrations lapse on
 * the real clock, a few firms do most of the booking the way they do in
 * practice, and the firms, buyers and towers are the ones the lead board and
 * the visit sheet already show, so the three screens tell one story.
 *
 * Seeded from the date, so the desk is stable through a day.
 */

import { addDays } from "./lead-rules.ts";
import { SAMPLE_FIRMS, sampleName, samplePhone, seeded, type Rng } from "./seeded.ts";
import {
  DEFAULT_STEPS,
  nextStep,
  rateFor,
  validUntil,
  type Booking,
  type Firm,
  type MilestoneKey,
  type Registration,
} from "./partner-rules.ts";

export type { Firm };

export type Desk = {
  firms: Firm[];
  registrations: Registration[];
  bookings: Booking[];
};

/** The developer's own people who look after partners. */
export const PARTNER_RMS = ["Tanmay Kulkarni", "Shweta Rane"];

const MORE_FIRMS = [
  "Aundh Realty Hub",
  "Magarpatta Home Advisors",
  "Kharadi Keys Realty",
  "Viman Nagar Estates",
  "Sinhgad Road Realtors",
  "Trident Property Advisors",
  "Nest and Key Realtors",
  "Swaraj Estate Consultants",
  "Omkar Realty Services",
  "Ashtavinayak Properties",
  "Prime Square Realty",
  "Pashan Home Partners",
];

const AREAS = ["Baner", "Wakad", "Hinjewadi", "Kharadi", "Aundh", "Kothrud", "Viman Nagar", "Hadapsar", "Pimple Saudagar", "Balewadi"];

/**
 * How much each firm books, most to least. A handful of firms do most of the
 * work and a long tail does almost none, which is what every developer's
 * partner ledger looks like.
 */
const ACTIVITY = [30, 24, 18, 13, 10, 8, 7, 6, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 0.5, 0.4, 0.3, 0.2, 0.1];

function pan(r: Rng, name: string): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const L = () => letters[r.int(0, letters.length - 1)];
  const initial = name.replace(/[^A-Z]/g, "").charAt(0) || "K";
  return `${L()}${L()}${L()}F${initial}${r.int(1000, 9999)}${L()}`;
}

function utr(r: Rng, on: string): string {
  const [y, m, d] = on.split("-");
  return `HDFCN${y.slice(2)}${m}${d}${String(r.int(0, 99999)).padStart(5, "0")}`;
}

/**
 * The sample desk as of `today`. `places` are the tenant's towers or the
 * sample ones, labelled `Project · Tower`.
 */
export function sampleDesk(opts: { today: string; places: string[] }): Desk {
  const { today, places } = opts;
  const r = seeded(`partners|${today}`);
  const projects = [...new Set(places.map((p) => p.split(" · ")[0]))];

  // --- firms ---------------------------------------------------------------
  const names = [...SAMPLE_FIRMS, ...MORE_FIRMS].slice(0, ACTIVITY.length);
  const firms: Firm[] = names.map((name, i) => {
    const principal = sampleName(r).name;
    const reraTill =
      name === "Deccan Estates" ? addDays(today, 9) : name === "Wakad Property Point" ? addDays(today, -6) : addDays(today, r.int(120, 1600));
    const competencyTill = name === "Blue Door Realtors" ? null : addDays(today, r.int(200, 900));
    const bookingsYear = Math.max(0, Math.round(ACTIVITY[i] * 0.55 + r.int(-1, 1)));
    return {
      id: `CP-${String(101 + i)}`,
      name,
      area: AREAS[i % AREAS.length],
      principal,
      phone: samplePhone(r),
      rm: PARTNER_RMS[i % 2],
      rera: `A5${r.pick(["17", "18", "21"])}${String(r.int(0, 99_999_999)).padStart(8, "0")}`,
      reraTill,
      competencyTill,
      pan: pan(r, name),
      gstin: ACTIVITY[i] >= 2 || r.chance(0.5) ? "" : null,
      agents: Math.max(1, Math.round(ACTIVITY[i] / 2) + r.int(0, 3)),
      projects: (i < 16 ? projects : projects.slice(0, 1)).map((p) => ({
        name: p,
        status: "live" as const,
        validTo: addDays(today, r.int(60, 330)),
        booked: 0,
        rate: DEFAULT_STEPS[0].rate,
        next: nextStep(DEFAULT_STEPS, 0),
      })),
      joinedOn: addDays(today, -r.int(90, 900)),
      bookingsYear,
    };
  });
  for (const f of firms) {
    // 27 is Maharashtra; the PAN sits inside every GSTIN.
    if (f.gstin === "") f.gstin = `27${f.pan}1Z${r.pick(["5", "8", "2", "X"])}`;
  }
  const firmByName = new Map(firms.map((f) => [f.name, f]));

  // --- registrations -------------------------------------------------------
  const registrations: Registration[] = [];
  const weightTotal = ACTIVITY.reduce((s, w) => s + w, 0);
  let serial = 5200;
  for (let d = 110; d >= 0; d--) {
    const on = addDays(today, -d);
    const count = r.int(2, 6);
    for (let k = 0; k < count; k++) {
      // Pick a firm by activity. The quiet tail has not registered anybody
      // lately, which is what makes it the quiet tail.
      let pickW = r.next() * weightTotal;
      let fi = 0;
      for (; fi < ACTIVITY.length - 1; fi++) {
        pickW -= ACTIVITY[fi];
        if (pickW <= 0) break;
      }
      if (fi >= 16 && d < 45) fi = fi % 8;
      const firm = firms[fi];
      const { name } = sampleName(r);
      const visitRoll = r.next();
      const bookRoll = r.next();
      const visitedOn = d > 3 && visitRoll < 0.38 ? addDays(on, r.int(2, Math.min(d, 25))) : null;
      const bookedOn = visitedOn && bookRoll < 0.12 ? addDays(visitedOn, r.int(1, 10)) : null;
      registrations.push({
        id: `RG-${serial++}`,
        buyer: name,
        phone: samplePhone(r),
        firm: firm.name,
        agent: sampleName(r).name,
        project: r.pick(firm.projects).name,
        registeredOn: on,
        via: r.weighted([
          ["Buyer tapped the partner's link", 5],
          ["Partner on WhatsApp", 4],
          ["Entered by the relationship manager", 1],
        ] as const),
        visitedOn: visitedOn && visitedOn <= today ? visitedOn : null,
        bookedOn: bookedOn && bookedOn <= today ? bookedOn : null,
        refused: null,
      });
    }
  }

  // A firm with a booking this year registered that buyer at some point, so
  // none of them reads "never registered". The quiet tail did it long ago.
  for (const f of firms) {
    if (f.bookingsYear === 0 || registrations.some((x) => x.firm === f.name)) continue;
    const on = addDays(today, -r.int(55, 110));
    registrations.push({
      id: `RG-${serial++}`,
      buyer: sampleName(r).name,
      phone: samplePhone(r),
      firm: f.name,
      agent: sampleName(r).name,
      project: f.projects[0].name,
      registeredOn: on,
      via: "Partner on WhatsApp",
      visitedOn: addDays(on, r.int(3, 12)),
      bookedOn: null,
      refused: null,
    });
  }

  // A share of attempts are refused because somebody got there first. The
  // partner is told the date, never the other firm's name; the desk sees both.
  for (let i = 0; i < 16; i++) {
    const on = addDays(today, -r.int(0, 28));
    const holder = r.pick(
      registrations.filter((x) => x.registeredOn < on && validUntil(x) > on && !x.refused && !x.bookedOn),
    );
    const byOther = r.chance(0.75);
    const firm = r.pick(firms.slice(0, 12).filter((f) => f.name !== holder.firm));
    registrations.push({
      id: `RG-${serial++}`,
      buyer: holder.buyer,
      phone: holder.phone,
      firm: firm.name,
      agent: sampleName(r).name,
      project: holder.project,
      registeredOn: on,
      via: "Partner on WhatsApp",
      visitedOn: null,
      bookedOn: null,
      refused: byOther
        ? { reason: "firm", holderFirm: holder.firm, heldUntil: validUntil(holder) }
        : { reason: "direct" },
    });
  }

  // The lead board's partner conflict: Keystone holds Pooja Nair, and Urban
  // Nest says they brought her first.
  const project2 = (places[1] ?? places[0]).split(" · ")[0];
  const keystoneOn = addDays(today, -19);
  registrations.push(
    {
      id: "RG-5101",
      buyer: "Pooja Nair",
      phone: "+919890512029",
      firm: "Keystone Realty",
      agent: "Sagar Kale",
      project: project2,
      registeredOn: keystoneOn,
      via: "Buyer tapped the partner's link",
      visitedOn: addDays(keystoneOn, 6),
      bookedOn: null,
      refused: null,
    },
    {
      id: "RG-5102",
      buyer: "Pooja Nair",
      phone: "+919890512029",
      firm: "Urban Nest Realtors",
      agent: "Mayur Sawant",
      project: project2,
      registeredOn: today,
      via: "Partner on WhatsApp",
      visitedOn: null,
      bookedOn: null,
      refused: { reason: "firm", holderFirm: "Keystone Realty", heldUntil: addDays(keystoneOn, 36) },
      disputed: true,
    },
  );
  // A second dispute, against a buyer who enquired directly first.
  const direct = registrations.find((x) => x.refused?.reason === "direct");
  if (direct) direct.disputed = true;

  // --- bookings -------------------------------------------------------------
  const bookings: Booking[] = [];
  const letter = (place: string) => {
    const tower = place.split(" · ")[1] ?? place;
    return (tower.match(/([A-Z])\s*$/)?.[1] ?? tower.charAt(0)).toUpperCase();
  };
  const booked = registrations.filter((x) => x.bookedOn).slice(-22);
  let bn = 800;
  const mk = (b: {
    buyer: string;
    firm: string;
    agent: string;
    place: string;
    bookedOn: string;
    agreement: number;
    collected?: number;
    stage?: Partial<Booking["progress"]>;
    cancelled?: boolean;
    registeredAfter?: number;
    unit?: string;
  }): Booking => {
    const f = firmByName.get(b.firm)!;
    const age = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${b.bookedOn}T00:00:00Z`)) / 86_400_000));
    const regAfter = b.registeredAfter ?? r.int(21, 45);
    const registeredOn = !b.cancelled && age >= regAfter ? addDays(b.bookedOn, regAfter) : null;
    // Construction-linked: ten per cent at booking, the next tranche with the
    // agreement, then slab by slab.
    const collected = b.collected ?? Math.min(0.55, 0.1 + (registeredOn ? 0.1 : 0) + Math.max(0, age - 60) * 0.0022);
    const crossedOn = collected >= 0.3 ? addDays(b.bookedOn, Math.min(age, 60 + Math.round((0.3 - 0.2) / 0.0022))) : null;
    const stageFor = (owedSince: string | null, key: MilestoneKey) => {
      const given = b.stage?.[key];
      if (given) return given;
      if (!owedSince) return { stage: "none" as const };
      const owed = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${owedSince}T00:00:00Z`)) / 86_400_000);
      const roll = r.next();
      // Nobody waits half a year: past four months it has been paid.
      if (owed > 120 || (owed > 75 && roll < 0.85)) {
        const paidOn = addDays(owedSince, r.int(38, 70));
        return { stage: "paid" as const, paidOn, utr: utr(r, paidOn) };
      }
      if (owed > 40) return roll < 0.5 ? { stage: "verified" as const } : { stage: "invoice" as const };
      if (owed > 12) return roll < 0.4 ? { stage: "invoice" as const } : roll < 0.7 ? { stage: "verified" as const } : { stage: "approved" as const };
      return { stage: "none" as const };
    };
    const projectOf = (place: string) => place.split(" · ")[0];
    const bookingNo =
      bookings.filter((x) => x.firm === b.firm && projectOf(x.place) === projectOf(b.place) && !x.cancelled).length + 1;
    return {
      id: `BK-${bn++}`,
      unit: b.unit ?? `${letter(b.place)}-${r.int(3, 22)}${String(r.int(1, 8)).padStart(2, "0")}`,
      buyer: b.buyer,
      place: b.place,
      firm: b.firm,
      agent: b.agent,
      gstRegistered: f.gstin !== null,
      agreement: b.agreement,
      rate: rateFor(DEFAULT_STEPS, bookingNo),
      bookingNo,
      bookedOn: b.bookedOn,
      registeredOn,
      collected,
      crossedOn,
      cancelled: !!b.cancelled,
      progress: {
        M1: stageFor(registeredOn, "M1"),
        M2: stageFor(crossedOn, "M2"),
      },
    };
  };

  // Older bookings, from before the registrations above began.
  for (let i = 0; i < 9; i++) {
    const f = firms[r.weighted(ACTIVITY.slice(0, 10).map((w, j) => [j, w] as const))];
    bookings.push(
      mk({
        buyer: sampleName(r).name,
        firm: f.name,
        agent: sampleName(r).name,
        place: r.pick(places),
        bookedOn: addDays(today, -r.int(115, 260)),
        agreement: r.int(62, 158) * 1_00_000 + r.int(0, 9) * 10_000,
      }),
    );
  }
  for (const x of booked) {
    const place = places.find((p) => p.startsWith(x.project)) ?? places[0];
    bookings.push(
      mk({
        buyer: x.buyer,
        firm: x.firm,
        agent: x.agent,
        place,
        bookedOn: x.bookedOn!,
        agreement: r.int(58, 152) * 1_00_000 + r.int(0, 9) * 10_000,
        cancelled: r.chance(0.06),
      }),
    );
  }

  // Section 07's own example: the first half paid on 12 July with a UTR, the
  // second held at 18 per cent collected.
  const julyPaid = `${today.slice(0, 4)}-07-12`;
  bookings.push(
    mk({
      buyer: "Manasi Gokhale",
      firm: "Shree Ganesh Realty",
      agent: "Rohit Pawar",
      place: places[0],
      bookedOn: addDays(julyPaid, -52),
      registeredAfter: 14,
      agreement: 1_25_00_000,
      collected: 0.18,
      stage: { M1: { stage: "paid", paidOn: julyPaid, utr: "HDFCN26071204417" } },
    }),
  );
  // The lead board's Nitin Gupta: booked five days ago through Keystone.
  bookings.push(
    mk({
      buyer: "Nitin Gupta",
      firm: "Keystone Realty",
      agent: "Sagar Kale",
      place: places[0],
      bookedOn: addDays(today, -5),
      agreement: 85_40_000,
      unit: "C-803",
    }),
  );

  // A firm's year can only be at least what the ledger shows it booked.
  const yearAgo = addDays(today, -365);
  for (const f of firms) {
    const shown = bookings.filter((b) => b.firm === f.name && !b.cancelled && b.bookedOn > yearAgo).length;
    f.bookingsYear = Math.max(f.bookingsYear, shown);
  }

  // Where each firm stands on each project's ladder, from the ledger above.
  for (const f of firms) {
    for (const p of f.projects) {
      p.booked = bookings.filter((b) => b.firm === f.name && b.place.split(" · ")[0] === p.name && !b.cancelled).length;
      p.rate = rateFor(DEFAULT_STEPS, p.booked + 1);
      p.next = nextStep(DEFAULT_STEPS, p.booked);
    }
  }

  bookings.sort((a, b) => (a.bookedOn < b.bookedOn ? 1 : -1));
  registrations.sort((a, b) => (a.registeredOn < b.registeredOn ? 1 : -1));
  return { firms, registrations, bookings };
}
