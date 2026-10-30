/**
 * When a project's gallery takes visits: an opening and a last start for
 * weekdays and for the weekend, on the half hour, inside 8 am and 8:30 pm.
 * The default is the site day every project had before (10 am to a last
 * start of 6:30 pm), so a project nobody set keeps it.
 *
 * Pure and client-safe; covered by `check:logic`. `slots.ts` reads a
 * project's hours and every booking path passes them in.
 *
 * Relative imports: `check:logic` loads this from source.
 */

/** One kind of day: the first and the last half hour a visit may start, "HH:MM". */
export type DayHours = { open: string; last: string };
export type VisitHours = { weekday: DayHours; weekend: DayHours };

/** The earliest opening and the latest start any project may set. */
export const EARLIEST_OPEN = "08:00";
export const LATEST_START = "20:30";

export const DEFAULT_DAY: DayHours = { open: "10:00", last: "18:30" };
export const DEFAULT_VISIT_HOURS: VisitHours = { weekday: DEFAULT_DAY, weekend: DEFAULT_DAY };

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Every half hour from `open` to `last`, both included. */
export function slotsBetween(h: DayHours): string[] {
  const out: string[] = [];
  for (let m = toMinutes(h.open); m <= toMinutes(h.last); m += 30) out.push(fromMinutes(m));
  return out;
}

/** Every half hour a project of any hours could take: the widest a picker needs. */
export const ANY_VISIT_SLOTS: string[] = slotsBetween({ open: EARLIEST_OPEN, last: LATEST_START });

/** Saturday and Sunday. */
const weekend = (day: string) => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
};

/** The hours that apply on an IST date. */
export function hoursOnDay(hours: VisitHours | null | undefined, day: string): DayHours {
  const h = hours ?? DEFAULT_VISIT_HOURS;
  return weekend(day) ? h.weekend : h.weekday;
}

/** The half hours a visit may start on an IST date. */
export const slotsOn = (hours: VisitHours | null | undefined, day: string) => slotsBetween(hoursOnDay(hours, day));

/** The hours of the clock a visit may start in on a date. */
export const slotHoursOn = (hours: VisitHours | null | undefined, day: string) =>
  [...new Set(slotsOn(hours, day).map((s) => Number(s.slice(0, 2))))];

/** Whether a visit may start at `time` on `day`. */
export const opensAt = (hours: VisitHours | null | undefined, day: string, time: string) => slotsOn(hours, day).includes(time);

/** Every half hour either kind of day takes, in order, for one project's picker. */
export function slotsOfProject(hours: VisitHours | null | undefined): string[] {
  const h = hours ?? DEFAULT_VISIT_HOURS;
  return [...new Set([...slotsBetween(h.weekday), ...slotsBetween(h.weekend)])].sort();
}

/** The first hour a host may start and the hour the last visit ends by, for the host's week. */
export function hostBounds(hours: VisitHours | null | undefined): { open: number; close: number } {
  const h = hours ?? DEFAULT_VISIT_HOURS;
  const open = Math.floor(Math.min(toMinutes(h.weekday.open), toMinutes(h.weekend.open)) / 60);
  const close = Math.floor(Math.max(toMinutes(h.weekday.last), toMinutes(h.weekend.last)) / 60) + 1;
  return { open, close };
}

/** `10 am`, `6:30 pm`. */
export function timeLabel(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);
  return `${h % 12 === 0 ? 12 : h % 12}${m === "00" ? "" : `:${m}`} ${h >= 12 ? "pm" : "am"}`;
}

/** `10 am to 6:30 pm`: the first and the last start. */
export const dayLabel = (h: DayHours) => `${timeLabel(h.open)} to ${timeLabel(h.last)}`;

/** The sentence a refused time gets. */
export function closedMessage(hours: VisitHours | null | undefined, day: string): string {
  const h = hoursOnDay(hours, day);
  return `Visits that day start between ${timeLabel(h.open)} and ${timeLabel(h.last)}.`;
}

/** Minutes from midnight, as stored. */
export const hoursToRow = (h: VisitHours) => ({
  weekday_open: toMinutes(h.weekday.open),
  weekday_last: toMinutes(h.weekday.last),
  weekend_open: toMinutes(h.weekend.open),
  weekend_last: toMinutes(h.weekend.last),
});

export function hoursFromRow(r: { weekday_open: number; weekday_last: number; weekend_open: number; weekend_last: number } | null | undefined): VisitHours {
  if (!r) return DEFAULT_VISIT_HOURS;
  return {
    weekday: { open: fromMinutes(r.weekday_open), last: fromMinutes(r.weekday_last) },
    weekend: { open: fromMinutes(r.weekend_open), last: fromMinutes(r.weekend_last) },
  };
}

const LABEL = { weekdayOpen: "Monday to Friday opens", weekdayLast: "Monday to Friday last visit", weekendOpen: "Saturday and Sunday opens", weekendLast: "Saturday and Sunday last visit" } as const;

/**
 * Hours as typed on the project page, or the first problem in the screen's
 * words. Each is a half hour, "HH:MM", inside 8 am and 8:30 pm, and a day's
 * last visit is not before its opening.
 */
export function readVisitHours(raw: Record<keyof typeof LABEL, string>): { ok: true; hours: VisitHours } | { ok: false; message: string } {
  const lo = toMinutes(EARLIEST_OPEN);
  const hi = toMinutes(LATEST_START);
  const got: Partial<Record<keyof typeof LABEL, string>> = {};
  for (const k of Object.keys(LABEL) as (keyof typeof LABEL)[]) {
    const v = (raw[k] ?? "").trim();
    if (!/^\d{2}:\d{2}$/.test(v)) return { ok: false, message: `${LABEL[k]}: choose a time.` };
    const m = toMinutes(v);
    if (Number(v.slice(3)) % 30 !== 0 || m < lo || m > hi) {
      return { ok: false, message: `${LABEL[k]}: choose a half hour between ${timeLabel(EARLIEST_OPEN)} and ${timeLabel(LATEST_START)}.` };
    }
    got[k] = v;
  }
  if (toMinutes(got.weekdayLast!) < toMinutes(got.weekdayOpen!)) return { ok: false, message: "Monday to Friday: the last visit is after the opening." };
  if (toMinutes(got.weekendLast!) < toMinutes(got.weekendOpen!)) return { ok: false, message: "Saturday and Sunday: the last visit is after the opening." };
  return {
    ok: true,
    hours: { weekday: { open: got.weekdayOpen!, last: got.weekdayLast! }, weekend: { open: got.weekendOpen!, last: got.weekendLast! } },
  };
}

// ---------------------------------------------------------------------------
// Galleries
// ---------------------------------------------------------------------------

export const DEFAULT_GALLERY = "Main gallery";

/** A gallery's label, tidied, or why it cannot be saved. */
export function readGalleryLabel(raw: string | null | undefined): { ok: true; label: string } | { ok: false; message: string } {
  const label = String(raw ?? "").replace(/\s+/g, " ").trim() || DEFAULT_GALLERY;
  if (label.length > 60) return { ok: false, message: "Keep the gallery's name under 60 letters." };
  return { ok: true, label };
}

/**
 * The gallery a visit is at: the one it names when that one is still at or
 * above its tower, else the first at the deepest level that has any.
 * `galleries` are the ones at or above the tower, each with its depth.
 */
export function galleryFor<T extends { id: string; depth: number; createdAt: string }>(galleries: readonly T[], chosen: string | null | undefined): T | null {
  if (chosen) {
    const named = galleries.find((g) => g.id === chosen);
    if (named) return named;
  }
  return [...galleries].sort((a, b) => b.depth - a.depth || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null;
}

/** "10 am", "6:30 pm". */
export function clockWords(hhmm: string): string {
  const m = toMinutes(hhmm);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/**
 * A project's visiting hours as the agent is told them: "10 am to 6:30 pm,
 * every day", or the weekday and weekend hours when they differ. The last
 * start is said, because that is the latest a visit may begin.
 */
export function visitHoursWords(hours: VisitHours | null | undefined): string {
  const h = hours ?? DEFAULT_VISIT_HOURS;
  const span = (d: DayHours) => `${clockWords(d.open)} to ${clockWords(d.last)}`;
  if (h.weekday.open === h.weekend.open && h.weekday.last === h.weekend.last) return `${span(h.weekday)}, every day`;
  return `${span(h.weekday)} on weekdays, ${span(h.weekend)} on weekends`;
}
