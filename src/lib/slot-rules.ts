/**
 * Visit capacity: which hour a visit takes, how many a gallery can host, the
 * three hours offered when the one asked for is full, who hosts, and whether
 * a visit may still go ahead. Pure and database-free, covered by
 * `check:logic`; `slots.ts` reads and writes.
 *
 * Capacity is per project, per day, per hour, because a gallery has so many
 * hosts on the floor and a visit takes one of them for the better part of an
 * hour. Visits start on the half hour (`VISIT_SLOTS`), so a 4:30 visit takes
 * the four o'clock hour.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { VISIT_SLOTS } from "./lead-rules.ts";
import { hostBounds, slotHoursOn, slotsOn, type VisitHours } from "./visit-hours-rules.ts";

const IST_MS = 330 * 60_000;
const MIN = 60_000;
const DAY_MS = 86_400_000;

/** A seat is held this long while the buyer picks one of the offered hours. */
export const HOLD_MINUTES = 10;
/** Hours offered in one message when the one asked for is full. */
export const OFFER_COUNT = 3;
/** How far ahead alternatives are looked for. */
export const OFFER_DAYS = 7;
/** An offer is never for a time closer than this, so the buyer can get there. */
export const OFFER_LEAD_MIN = 90;

/** Hosts per hour a project starts with until somebody sets its own. */
export const DEFAULT_HOSTS = { weekday: 2, weekend: 3 } as const;
export const MAX_HOSTS = 50;

/** The IST date, hour and half-hour label an instant starts in. */
export function slotOf(iso: string): { day: string; hour: number; time: string } {
  const d = new Date(Date.parse(iso) + IST_MS);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), time: d.toISOString().slice(11, 16) };
}

/** The instant an IST date and `HH:MM` name. */
export function istInstant(day: string, hhmm: string): string {
  return new Date(Date.parse(`${day}T${hhmm}:00Z`) - IST_MS).toISOString();
}

/** Saturday and Sunday, when most buyers visit. */
export function isWeekendDay(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Visits a project's gallery can host in one hour on a day. */
export function hostsOn(day: string, cap: { weekday: number; weekend: number }): number {
  return isWeekendDay(day) ? cap.weekend : cap.weekday;
}

/** The hours a visit may start in: 10 to 18, from the site's half-hour slots. */
export const SLOT_HOURS: number[] = [...new Set(VISIT_SLOTS.map((s) => Number(s.slice(0, 2))))];

/** Why hosts per hour typed on the visits screen cannot be saved, or null. */
export function hostsProblem(raw: string): string | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return "Enter a whole number, like 2.";
  if (Number(s) > MAX_HOSTS) return `At most ${MAX_HOSTS}.`;
  return null;
}

/** What one hour looks like to the picker: its capacity and what is used. */
export type HourState = { day: string; hour: number; capacity: number; taken: number; held: number };

export const freeSeats = (h: Pick<HourState, "capacity" | "taken" | "held">) => Math.max(0, h.capacity - h.taken - h.held);

/**
 * Three hours to offer instead of a full one: the nearest free hours to the
 * one asked for, the same day first, then the days after at the hour closest
 * to it, never sooner than `OFFER_LEAD_MIN` from now. Each is offered at the
 * minute the buyer asked for within the hour when that is a real slot (4:30
 * stays half past), else on the hour.
 *
 * `hourAt` answers an hour's state; an hour it has never seen is free at the
 * project's capacity for that day.
 */
export function alternatives(o: {
  askedIso: string;
  nowIso: string;
  hourAt: (day: string, hour: number) => HourState;
  count?: number;
  /** The project's opening hours; the default site day without them. */
  hours?: VisitHours | null;
}): { day: string; hour: number; startsAt: string }[] {
  const want = slotOf(o.askedIso);
  const minute = want.time.slice(3);
  const earliest = Date.parse(o.nowIso) + OFFER_LEAD_MIN * MIN;
  const out: { day: string; hour: number; startsAt: string }[] = [];
  const count = o.count ?? OFFER_COUNT;
  for (let d = 0; d <= OFFER_DAYS && out.length < count; d++) {
    const day = new Date(Date.parse(`${want.day}T00:00:00Z`) + d * DAY_MS).toISOString().slice(0, 10);
    const open = slotsOn(o.hours, day);
    const hours = slotHoursOn(o.hours, day).sort((a, b) => Math.abs(a - want.hour) - Math.abs(b - want.hour) || a - b);
    for (const hour of hours) {
      if (out.length >= count) break;
      if (d === 0 && hour === want.hour) continue;
      const hh = String(hour).padStart(2, "0");
      // The minute asked for when it is a real start that day, else the hour's first.
      const time = open.includes(`${hh}:${minute}`) ? `${hh}:${minute}` : open.find((t) => t.startsWith(`${hh}:`));
      if (!time) continue;
      const startsAt = istInstant(day, time);
      if (Date.parse(startsAt) < earliest) continue;
      if (freeSeats(o.hourAt(day, hour)) <= 0) continue;
      out.push({ day, hour, startsAt });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hosts with their own hours
// ---------------------------------------------------------------------------

/**
 * One host's hours on one weekday at a project: a visit may start in any
 * hour from `from` up to but not including `to`. 0 is Sunday.
 */
export type HostHours = { userId: string; weekday: number; from: number; to: number };

/** The first hour a visit may start in, and the hour the last one ends by. */
export const HOURS_OPEN = 10;
export const HOURS_CLOSE = 19;

/** Monday first, the way a week plan reads. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The weekday an IST date falls on, 0 for Sunday. */
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** The hosts on the floor for a visit starting in `hour` on `day`. */
export function hostsOnShift(hours: readonly HostHours[], day: string, hour: number): string[] {
  const dow = weekdayOf(day);
  return [...new Set(hours.filter((h) => h.weekday === dow && h.from <= hour && hour < h.to).map((h) => h.userId))];
}

/**
 * How many visits an hour takes: one for each host on the floor once any
 * host at the project has hours, else the project's own number for the day.
 */
export function capacityAt(
  day: string,
  hour: number,
  cap: { weekday: number; weekend: number },
  hours: readonly HostHours[],
  /** The project's opening hours: an hour no visit may start in takes nobody. */
  open?: VisitHours | null,
): number {
  if (open !== undefined && !slotHoursOn(open, day).includes(hour)) return 0;
  if (!hours.length) return hostsOn(day, cap);
  return Math.min(MAX_HOSTS, hostsOnShift(hours, day, hour).length);
}

/** `10 am`, `1 pm`, the way an hour is named on the screen. */
export function hourLabel(h: number): string {
  return `${h % 12 === 0 ? 12 : h % 12} ${h >= 12 ? "pm" : "am"}`;
}

/** `10 am to 7 pm`, one day's hours as the screen says them. */
export const shiftLabel = (from: number, to: number) => `${hourLabel(from)} to ${hourLabel(to)}`;

/**
 * A host's week as typed on the project page: for each weekday (0 Sunday)
 * a start and an end hour, or both empty for a day off. The rows to store,
 * or the first problem in the screen's own words.
 */
export function readWeek(
  userId: string,
  raw: Partial<Record<number, { from: string; to: string }>>,
  /** The project's opening hours, which bound a host's; the default site day without them. */
  open?: VisitHours | null,
): { ok: true; rows: HostHours[] } | { ok: false; message: string } {
  const bounds = open === undefined ? { open: HOURS_OPEN, close: HOURS_CLOSE } : hostBounds(open);
  const rows: HostHours[] = [];
  for (const d of WEEK_ORDER) {
    const f = (raw[d]?.from ?? "").trim();
    const t = (raw[d]?.to ?? "").trim();
    if (!f && !t) continue;
    if (!/^\d{1,2}$/.test(f) || !/^\d{1,2}$/.test(t)) {
      return { ok: false, message: `${WEEKDAY_LABEL[d]}: choose when they start and finish, or leave both empty.` };
    }
    const from = Number(f);
    const to = Number(t);
    if (from < bounds.open || to > bounds.close) return { ok: false, message: `${WEEKDAY_LABEL[d]}: visits run ${shiftLabel(bounds.open, bounds.close)}.` };
    if (to <= from) return { ok: false, message: `${WEEKDAY_LABEL[d]}: they finish after they start.` };
    rows.push({ userId, weekday: d, from, to });
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// Who hosts
// ---------------------------------------------------------------------------

export type HostCandidate = {
  id: string;
  name: string;
  /** Holds the key across the whole organisation rather than at the project or tower. */
  wide: boolean;
  /** Visits already theirs in the same hour, and on the same day. */
  sameHour: number;
  sameDay: number;
  /** On the floor that hour by their own hours. Left out where the project keeps no hours. */
  onShift?: boolean;
};

/**
 * The least-loaded host at the tower for that hour: somebody free that
 * hour (and on the floor by their own hours, where the project keeps
 * them), people placed at the project or the tower before anybody placed
 * across the organisation (a sales head is not everybody's host), fewest
 * visits that day, then by name. Null when nobody is free.
 */
export function pickHost(candidates: readonly HostCandidate[]): HostCandidate | null {
  // Where hosts keep hours, only somebody on the floor that hour hosts.
  const shifts = candidates.some((c) => c.onShift !== undefined);
  const free = candidates.filter((c) => c.sameHour === 0 && (!shifts || c.onShift === true));
  const local = free.filter((c) => !c.wide);
  const pool = local.length ? local : free;
  return [...pool].sort((a, b) => a.sameDay - b.sameDay || a.name.localeCompare(b.name))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Whether a visit may go ahead
// ---------------------------------------------------------------------------

export type AdmissionInput = {
  /** The visit holds a seat in the ledger. */
  seated: boolean;
  /** The tower may be advertised now (`canPublish()`). */
  advertisable: boolean;
  /** The buyer asked not to be contacted. */
  optedOut: boolean;
  /** A channel partner's claim on the buyer is unsettled. Always false until the partners' claim rules say otherwise. */
  claimDisputed: boolean;
};

export type Admission = { ok: true } | { ok: false; reason: string };

/**
 * Section 02's admission gate, asked when a visit is booked and again a day
 * and two hours before it: a seat, a tower that may be advertised, a buyer
 * who has not opted out, and nobody else's claim in dispute. A visit that
 * fails is barred, its reminders are not sent, and a person is told why.
 */
export function admit(i: AdmissionInput): Admission {
  if (i.optedOut) return { ok: false, reason: "The buyer asked not to be contacted." };
  if (!i.advertisable) return { ok: false, reason: "The tower cannot be advertised right now." };
  if (!i.seated) return { ok: false, reason: "The visit holds no seat at the gallery." };
  if (i.claimDisputed) return { ok: false, reason: "Two partners claim this buyer." };
  return { ok: true };
}

/** The moments the admission gate is asked again before a visit, in minutes before it. */
export const ADMISSION_CHECKS = [24 * 60, 120] as const;

/** `Sat 4 Oct, 11:30 am`, the way an offer names an hour. */
export function offerLabel(startsAtIso: string): string {
  const d = new Date(Date.parse(startsAtIso) + IST_MS);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${day}, ${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "pm" : "am"}`;
}

/** The payload a quick-reply button carries: the hold it books. */
export const holdPayload = (holdId: string) => `slot:${holdId}`;

export function holdFromPayload(payload: string | null | undefined): string | null {
  const m = /^slot:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec((payload ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}
