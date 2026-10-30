/**
 * Site visits: the states, the clock they run on, and what needs a person.
 *
 * Pure, so the screen and `check:logic` read the same answers. There is no
 * site_visit table yet; the states are the ones section 02 of the product
 * flow doc draws, named the way a sales gallery says them.
 *
 * Capacity is per project, per hour, per day: a gallery has so many closing
 * managers on the floor, and a visit takes one of them for the better part of
 * an hour. Weekends are the peak, so weekends carry more hosts.
 */

import { addDays, showDate, showTime, type INTEREST, type OBJECTIONS } from "./lead-rules.ts";
import type { Shown } from "./mask-rules.ts";

export type VisitStatus =
  | "requested"
  | "confirmed"
  | "blocked"
  | "on_site"
  | "visited"
  | "no_show"
  | "lapsed"
  | "moved"
  | "cancelled";

export type Tone = "ok" | "blue" | "warn" | "risk" | "quiet";

export const STATUS: Record<VisitStatus, { label: string; tone: Tone }> = {
  requested: { label: "Awaiting reply", tone: "warn" },
  confirmed: { label: "Confirmed", tone: "quiet" },
  blocked: { label: "Blocked", tone: "risk" },
  on_site: { label: "On site", tone: "blue" },
  visited: { label: "Visited", tone: "ok" },
  no_show: { label: "No-show", tone: "warn" },
  lapsed: { label: "Lapsed", tone: "quiet" },
  moved: { label: "Moved", tone: "quiet" },
  cancelled: { label: "Cancelled", tone: "quiet" },
};

export type Temperature = "HOT" | "WARM" | "COLD";

/** The lead board's lists, so a visit records what a lead move would. */
export { OBJECTIONS, INTEREST as INTERESTS } from "./lead-rules.ts";
export type Objection = (typeof OBJECTIONS)[number];
export type Interest = (typeof INTEREST)[number];

/** What happens next, as a host would pick it on the way out. */
export const NEXT_STEPS = [
  "Send the payment plan",
  "Revisit with family",
  "Share the loan offer",
  "Hold a unit for 48 hours",
  "Call back in a week",
  "Nothing planned",
] as const;

export type Outcome = {
  interest: Interest;
  objection: Objection;
  next: string;
  /** Units walked, by number. */
  shown: string[];
  /** The host's voice note, as heard. */
  note?: string;
};

export type Blocked = "cp_tag" | "registration" | "consent";

export const BLOCKED_WHY: Record<Blocked, string> = {
  cp_tag: "Two partners claim this buyer",
  registration: "The tower cannot be advertised",
  consent: "No consent to message this number",
};

export type Visit = {
  id: string;
  buyer: string;
  /** The lead, for a reveal. Null on a sample visit. */
  leadId?: string | null;
  /** The buyer's number as this viewer may see it. The whole number stays on the server. */
  phone: Shown;
  /** Civil date, IST. */
  date: string;
  /** `HH:MM`, on the half hour. */
  time: string;
  project: string;
  /** The full place label, `Sath Heights · Tower C`. */
  place: string;
  config: string;
  budget: string;
  lang: string;
  temp: Temperature;
  /** People coming, the buyer included. */
  party: number;
  /** Whether whoever signs is coming. */
  decider: boolean;
  /** 1 is the first visit, 2 onward a revisit. */
  visitNo: number;
  source: string;
  cp: { firm: string; agent: string; tagDaysLeft: number } | null;
  bookedVia: string;
  bookedOn: string;
  host: string | null;
  status: VisitStatus;
  /** `HH:MM` the QR was scanned at the gallery. */
  arrivedAt?: string;
  /** For a visit that has happened. */
  outcome?: Outcome;
  /** The buyer took a new slot. */
  movedTo?: { date: string; time: string };
  blocked?: Blocked;
  /** Why the admission gate stopped a real visit, in its own words. */
  blockedWhy?: string;
  /** The two-hour reminder carries a cab offer; some take it. */
  cab?: boolean;
  /** Units the host is going to walk them through. */
  toShow: string[];
  /** Said by the buyer or the partner when booking. */
  ask?: string;
};

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export const OPEN = "10:00";
export const CLOSE = "19:00";

/** Hours a gallery takes visits in, as `HH:00`. The last starts at 18:00. */
export const HOURS: string[] = Array.from({ length: 9 }, (_, i) => `${String(10 + i).padStart(2, "0")}:00`);

export const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export const fromMin = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** The hour a visit's time falls in. */
export const hourOf = (hhmm: string) => `${hhmm.slice(0, 2)}:00`;

/** Saturday and Sunday, when most of India visits. */
export function isWeekend(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Hosts on the floor for one project in one hour. A bigger launch staffs a
 * bigger gallery; the weekend staffs both up.
 */
export function hostsOnDuty(iso: string, bigSite: boolean): number {
  const weekend = isWeekend(iso);
  if (bigSite) return weekend ? 5 : 3;
  return weekend ? 3 : 2;
}

/** A day's capacity across the projects given, as visits. */
export function dayCapacity(projects: readonly { big: boolean }[], iso: string): number {
  return projects.reduce((n, p) => n + hostsOnDuty(iso, p.big) * HOURS.length, 0);
}

/** `in 25 min`, `12 min late`, `now`. For a visit expected today. */
export function arrivalLabel(time: string, nowMin: number): string {
  const d = toMin(time) - nowMin;
  if (Math.abs(d) < 3) return "now";
  if (d > 0) return d < 60 ? `in ${d} min` : `in ${Math.floor(d / 60)} h ${d % 60 ? `${d % 60} min` : ""}`.trim();
  const late = -d;
  if (late < 60) return `${late} min late`;
  return `${Math.floor(late / 60)} h${late % 60 ? ` ${late % 60} min` : ""} late`;
}

/** `Today`, `Tomorrow`, `Yesterday`, else `Sat 26 Sep`. */
export function dayWord(iso: string, today: string): string {
  if (iso === today) return "Today";
  if (iso === addDays(today, 1)) return "Tomorrow";
  if (iso === addDays(today, -1)) return "Yesterday";
  return showDate(iso);
}

// ---------------------------------------------------------------------------
// The journey, as the buyer lived it
// ---------------------------------------------------------------------------

export type StepState = "done" | "due" | "missed" | "off";
export type Step = { label: string; when: string; state: StepState };

/**
 * Where the minute is, relative to the visit. Negative days are the past.
 * `nowMin` is minutes since midnight, IST.
 */
function beforeOrAfter(v: Visit, today: string, nowMin: number, offsetMin: number): "past" | "future" {
  const target = dayIndex(v.date, today) * 1440 + toMin(v.time) + offsetMin;
  return target <= nowMin ? "past" : "future";
}

function dayIndex(iso: string, today: string): number {
  const a = Date.parse(`${iso}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/** `Wed 23 Sep, 4:30 pm`, or `today, 4:30 pm`. The minute is offset from the visit. */
function at(v: Visit, today: string, offsetMin: number): string {
  const total = toMin(v.time) + offsetMin;
  const days = Math.floor(total / 1440);
  const iso = addDays(v.date, days);
  const word = dayWord(iso, today);
  return `${word === "Today" || word === "Tomorrow" || word === "Yesterday" ? word.toLowerCase() : word}, ${showTime(fromMin(total))}`;
}

/**
 * The reminders and the arrival, in order. Section 02's ladder: a day ahead
 * with the pin, two hours ahead with live location and a cab, then the QR
 * at the gallery, then the host's voice note.
 */
export function journey(v: Visit, today: string, nowMin: number): Step[] {
  const steps: Step[] = [
    { label: `Booked on ${v.bookedVia}`, when: showDate(v.bookedOn), state: "done" },
  ];

  if (v.status === "requested") {
    steps.push({ label: "Waiting for them to confirm on WhatsApp", when: "Hold lasts 10 minutes after each offer", state: "due" });
    return steps;
  }
  if (v.status === "blocked" || v.status === "cancelled") return steps;

  steps.push({ label: "Confirmed on WhatsApp", when: showDate(v.bookedOn), state: "done" });

  const dayBefore = beforeOrAfter(v, today, nowMin, -24 * 60);
  steps.push({
    label: "Reminder with the site pin",
    when: at(v, today, -24 * 60),
    state: dayBefore === "past" ? "done" : "due",
  });
  const twoBefore = beforeOrAfter(v, today, nowMin, -120);
  steps.push({
    label: v.cab ? "Live location sent, cab booked" : "Live location sent, cab offered",
    when: at(v, today, -120),
    state: twoBefore === "past" ? "done" : "due",
  });

  if (v.status === "confirmed") {
    steps.push({ label: "Check in at the gallery", when: `Expected ${showTime(v.time)}`, state: "due" });
    return steps;
  }

  if (v.status === "no_show" || v.status === "lapsed" || v.status === "moved") {
    steps.push({ label: "Did not arrive", when: at(v, today, 30), state: "missed" });
    return [...steps, ...recovery(v, today, nowMin)];
  }

  steps.push({
    label: "Checked in by QR at the gallery",
    when: v.arrivedAt ? showTime(v.arrivedAt) : "",
    state: "done",
  });
  steps.push({
    label: "Host's voice note",
    when: v.outcome ? "Recorded" : "After the visit",
    state: v.outcome ? "done" : "due",
  });
  return steps;
}

/** Offsets from the missed slot, in minutes, of each recovery step. */
export const RECOVERY = [
  { label: "Three open slots sent on WhatsApp", offset: 30 },
  { label: "AI call to rebook", offset: 150 },
  { label: "WhatsApp nudge", offset: 24 * 60 + 30 },
  { label: "Lapses if nobody replies", offset: 72 * 60 + 30 },
] as const;

/** The no-show ladder from section 02, with what has run and what is due. */
export function recovery(v: Visit, today: string, nowMin: number): Step[] {
  if (v.status === "moved" && v.movedTo) {
    return [
      { label: RECOVERY[0].label, when: at(v, today, RECOVERY[0].offset), state: "done" },
      {
        label: `Rebooked for ${dayWord(v.movedTo.date, today).replace("Today", "today")}, ${showTime(v.movedTo.time)}`,
        when: "Buyer picked a slot",
        state: "done",
      },
    ];
  }
  return RECOVERY.map((r, i) => {
    const past = beforeOrAfter(v, today, nowMin, r.offset) === "past";
    const last = i === RECOVERY.length - 1;
    return {
      label: last && past ? "Lapsed, nobody replied" : r.label,
      when: at(v, today, r.offset),
      state: past ? (last ? "missed" : "done") : "due",
    };
  });
}

/** How far the no-show ladder has run: 0 to 4 steps. */
export function recoveryStep(v: Visit, today: string, nowMin: number): number {
  if (v.status !== "no_show" && v.status !== "lapsed") return 0;
  return RECOVERY.filter((r) => beforeOrAfter(v, today, nowMin, r.offset) === "past").length;
}

// ---------------------------------------------------------------------------
// What needs a person
// ---------------------------------------------------------------------------

/**
 * Why a person has to act on this visit, or null when the agents have it.
 *
 * Kept short enough to read in a row: the screen shows it beside the name,
 * and the unfolded visit says the rest.
 */
export function needsYou(v: Visit, today: string, nowMin: number): string | null {
  const d = dayIndex(v.date, today);
  if (v.status === "blocked" && (v.blockedWhy || v.blocked)) return v.blockedWhy ?? BLOCKED_WHY[v.blocked!];
  if (overdue(v, today, nowMin)) return "Not checked in";
  if (v.status === "requested" && d >= 0 && d <= 1) return "Not confirmed yet";
  if ((v.status === "confirmed" || v.status === "requested") && !v.host && d >= 0 && d <= 1) return "No host assigned";
  if (v.status === "on_site" && v.arrivedAt && nowMin - toMin(v.arrivedAt) >= 75) return "Record how it went";
  if (v.status === "no_show" && v.temp === "HOT" && recoveryStep(v, today, nowMin) >= 2) {
    return "Hot buyer, call them yourself";
  }
  return null;
}

/** The next thing that happens, for the row. */
export function nextLine(v: Visit, today: string, nowMin: number): { text: string; tone: "due" | "plain" | "done" | "stop" } {
  const d = dayIndex(v.date, today);
  switch (v.status) {
    case "requested":
      return { text: "Waiting for a reply", tone: "due" };
    case "confirmed": {
      if (d === 0) {
        const label = arrivalLabel(v.time, nowMin);
        return { text: label.endsWith("late") ? `Not in yet, ${label}` : `Arrives ${label}`, tone: "due" };
      }
      const dayBefore = d === 1 && nowMin < toMin(v.time) ? `Pin goes out today, ${showTime(v.time)}` : null;
      return { text: dayBefore ?? "Reminders scheduled", tone: "plain" };
    }
    case "blocked":
      return { text: v.blockedWhy ?? (v.blocked ? BLOCKED_WHY[v.blocked] : "Blocked"), tone: "stop" };
    case "on_site":
      return {
        text: v.arrivedAt ? `With ${v.host?.split(" ")[0] ?? "the host"} since ${showTime(v.arrivedAt)}` : "On site",
        tone: "due",
      };
    case "visited":
      return { text: v.outcome ? v.outcome.next : "Voice note due", tone: v.outcome ? "plain" : "due" };
    case "no_show": {
      const steps = recovery(v, today, nowMin);
      const due = steps.find((s) => s.state === "due");
      return { text: due ? `${due.label}, ${due.when}` : "Recovery ran", tone: "plain" };
    }
    case "lapsed":
      return { text: "Back to monthly nurture", tone: "done" };
    case "moved":
      return {
        text: v.movedTo ? `Rebooked ${dayWord(v.movedTo.date, today).toLowerCase()}, ${showTime(v.movedTo.time)}` : "Rebooked",
        tone: "done",
      };
    case "cancelled":
      return { text: "Cancelled by the buyer", tone: "done" };
  }
}

// ---------------------------------------------------------------------------
// Views and measures
// ---------------------------------------------------------------------------

export type View = "all" | "needs" | "upcoming" | "on_site" | "visited" | "missed";

export const VIEWS: { key: View; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs", label: "Needs you" },
  { key: "upcoming", label: "Upcoming" },
  { key: "on_site", label: "On site" },
  { key: "visited", label: "Visited" },
  { key: "missed", label: "No-shows" },
];

export function inView(v: Visit, view: View, today: string, nowMin: number): boolean {
  switch (view) {
    case "all":
      return true;
    case "needs":
      return needsYou(v, today, nowMin) !== null;
    case "upcoming":
      return v.status === "confirmed" || v.status === "requested" || v.status === "blocked";
    case "on_site":
      return v.status === "on_site";
    case "visited":
      return v.status === "visited";
    case "missed":
      return v.status === "no_show" || v.status === "lapsed" || v.status === "moved";
  }
}

/** Visits that hold a slot: everything except the ones that gave it back. */
export function holdsSlot(v: Visit): boolean {
  return v.status !== "cancelled" && v.status !== "moved";
}

export type DayCount = {
  booked: number;
  visited: number;
  onSite: number;
  missed: number;
  toCome: number;
};

export function countDay(visits: readonly Visit[]): DayCount {
  const out: DayCount = { booked: 0, visited: 0, onSite: 0, missed: 0, toCome: 0 };
  for (const v of visits) {
    if (holdsSlot(v)) out.booked++;
    if (v.status === "visited") out.visited++;
    if (v.status === "on_site") out.onSite++;
    if (v.status === "no_show" || v.status === "lapsed") out.missed++;
    if (v.status === "confirmed" || v.status === "requested") out.toCome++;
  }
  return out;
}

/**
 * The share of visits that happened, of those whose time has come. A visit
 * still to come has not had the chance to be missed, so it is not counted.
 */
/**
 * A confirmed visit half an hour past its slot, or on an earlier day, with
 * nobody checked in. It is not a no-show until the ladder says so, but it is
 * not a visit that turned up either, and somebody at the gallery should look.
 */
export const OVERDUE_MIN = 30;

export function overdue(v: Visit, today: string, nowMin: number): boolean {
  if (v.status !== "confirmed") return false;
  const d = dayIndex(v.date, today);
  return d < 0 || (d === 0 && nowMin - toMin(v.time) >= OVERDUE_MIN);
}

/**
 * Of the visits that were due, the share that turned up. With `today` and
 * `nowMin`, an overdue confirmed visit counts as due and not here, so a day
 * with three buyers missing cannot read "100% turned up".
 */
export function showRate(visits: readonly Visit[], today?: string, nowMin?: number): number | null {
  const shown = visits.filter((v) => v.status === "visited" || v.status === "on_site").length;
  const missed = visits.filter(
    (v) =>
      v.status === "no_show" ||
      v.status === "lapsed" ||
      v.status === "moved" ||
      (today !== undefined && nowMin !== undefined && overdue(v, today, nowMin)),
  ).length;
  return shown + missed === 0 ? null : shown / (shown + missed);
}

export function matchesQuery(v: Visit, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  return (
    v.buyer.toLowerCase().includes(q) ||
    v.place.toLowerCase().includes(q) ||
    (v.cp?.firm.toLowerCase().includes(q) ?? false) ||
    (v.host?.toLowerCase().includes(q) ?? false) ||
    (digits.length >= 3 && v.phone.text.replace(/\D/g, "").includes(digits))
  );
}
