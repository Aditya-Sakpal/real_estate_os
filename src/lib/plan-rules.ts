import { isPostKind, MAX_SLIDES, MIN_SLIDES, type PostKind } from "./compose-rules.ts";
import { currentTemplateKey, templateFits } from "./template-rules.ts";

/**
 * What a schedule makes on each occasion it fires, and how that goes out.
 *
 * Pure and free of Node imports, because the schedule form reads it in the
 * browser as well as the server reading it on save: the calendar a person
 * builds and the plan the server stores are parsed by the same function.
 *
 * Two ways to repeat. WEEKLY is the week plan: a kind per weekday, between
 * two dates. DATES is a list of days a person picked on a calendar, each with
 * its own kind and time, for the campaign that is not a rhythm: a launch
 * week, a site-visit weekend, a festival.
 *
 * Every entry also says how it goes out. POST is organic, AD is a paid ad on
 * the project's own ad account, BOTH is both from the one creative. The
 * choice is per entry, because "Saturday's carousel as an ad" is the ordinary
 * request and a schedule-wide switch could not say it.
 */

export type Repeat = "WEEKLY" | "DATES";

export const REPEATS: { key: Repeat; label: string }[] = [
  { key: "WEEKLY", label: "Every week" },
  { key: "DATES", label: "On chosen dates" },
];

export const isRepeat = (raw: unknown): raw is Repeat => raw === "WEEKLY" || raw === "DATES";

export type Outlet = "POST" | "AD" | "BOTH";

export const OUTLETS: { key: Outlet; label: string }[] = [
  { key: "POST", label: "Organic" },
  { key: "AD", label: "Ad" },
  { key: "BOTH", label: "Organic and ad" },
];

export const isOutlet = (raw: unknown): raw is Outlet => raw === "POST" || raw === "AD" || raw === "BOTH";
export const usesAd = (o: Outlet): boolean => o === "AD" || o === "BOTH";
export const usesPost = (o: Outlet): boolean => o === "POST" || o === "BOTH";

/**
 * One day picked on the calendar. `on` is the IST date, `at` minutes from
 * IST midnight. `style` is this date's own look; without one it takes the
 * schedule's style for its kind.
 */
export type DatedPost = { on: string; at: number; kind: PostKind; outlet: Outlet; style?: PostStyle | null };

/**
 * How many dates one schedule may hold. A ceiling on a fan-out a person
 * controls: every date is a paid run, and a calendar clicked across a year
 * is a bill nobody meant.
 */
export const MAX_DATED_POSTS = 60;

/** How long a scheduled ad runs, in days. */
export const AD_DAYS_MIN = 3;
export const AD_DAYS_MAX = 30;
export const AD_DAYS_DEFAULT = 10;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date as `YYYY-MM-DD`, or null. 2026-02-30 is not one. */
export function isoDate(raw: unknown): string | null {
  const m = typeof raw === "string" ? ISO_DATE.exec(raw.trim()) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * The calendar as the form posts it, kept to what can run: real dates,
 * minutes inside the day, kinds and outlets the catalog knows. The same date
 * and minute twice is one entry, the later winning, because two posts at one
 * instant would be one run slot. Sorted, and cut at `MAX_DATED_POSTS`.
 */
export function pickDated(raw: unknown): DatedPost[] {
  return readDated(raw).slice(0, MAX_DATED_POSTS);
}

/**
 * Why a calendar cannot be saved as posted, or null. The cut in `pickDated()`
 * is a bound for reading; a person who picked 61 dates is told, rather than
 * finding the last one quietly gone.
 */
export function datedOverflow(raw: unknown): string | null {
  const n = readDated(raw).length;
  return n > MAX_DATED_POSTS ? `At most ${MAX_DATED_POSTS} dates; this has ${n}.` : null;
}

function readDated(raw: unknown): DatedPost[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const byInstant = new Map<string, DatedPost>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const on = isoDate(r.on);
    const at = typeof r.at === "number" ? r.at : Number(r.at);
    const kind = typeof r.kind === "string" && isPostKind(r.kind) ? r.kind : null;
    const outlet = isOutlet(r.outlet) ? r.outlet : "POST";
    if (!on || !Number.isInteger(at) || at < 0 || at > 1439 || !kind) continue;
    byInstant.set(`${on} ${at}`, { on, at, kind, outlet, style: looseStyle(r.style) });
  }
  return [...byInstant.values()].sort((a, b) => (a.on === b.on ? a.at - b.at : a.on < b.on ? -1 : 1));
}

/**
 * How soon after saving a picked date may go out. The worker wakes about
 * every ten minutes, the post then takes a few minutes to make, and it goes
 * out on a later pass: a time closer than this was skipped without a word.
 */
export const MIN_LEAD_MINUTES = 30;

/** A picked date's moment, from its IST date and minute. */
function datedMs(d: Pick<DatedPost, "on" | "at">): number {
  const [y, m, day] = d.on.split("-").map(Number);
  return Date.UTC(y, m - 1, day) + (d.at - 330) * 60_000;
}

/**
 * The earliest IST minute a post may be picked for on `on`, rounded up to
 * five minutes: 0 on a day far enough ahead, null when the day has no time
 * left.
 */
export function earliestAt(on: string, now: Date): number | null {
  const [y, m, day] = on.split("-").map(Number);
  const dayStart = Date.UTC(y, m - 1, day) - 330 * 60_000;
  const minute = Math.ceil((now.getTime() + MIN_LEAD_MINUTES * 60_000 - dayStart) / 300_000) * 5;
  if (minute <= 0) return 0;
  return minute > 1439 ? null : minute;
}

/** Whether a picked date is closer than `MIN_LEAD_MINUTES` from now. */
export function tooSoon(d: Pick<DatedPost, "on" | "at">, now: Date): boolean {
  return datedMs(d) < now.getTime() + MIN_LEAD_MINUTES * 60_000;
}

/**
 * Why a calendar cannot be saved for its timing, or null. A date already
 * saved at that time is left alone: its run may already be under way.
 */
export function datedTooSoon(
  dated: readonly DatedPost[],
  now: Date,
  saved: readonly Pick<DatedPost, "on" | "at">[] = [],
): string | null {
  const kept = new Set(saved.map((d) => `${d.on} ${d.at}`));
  const first = dated.find((d) => tooSoon(d, now) && !kept.has(`${d.on} ${d.at}`));
  if (!first) return null;
  const earliest = earliestAt(first.on, now);
  return earliest === null
    ? `${showDate(first.on)} has no time left. A post needs ${MIN_LEAD_MINUTES} minutes to be made; pick a later day.`
    : `${showDate(first.on)} at ${showClock(first.at)} is too soon. Pick ${showClock(earliest)} or later: a post needs ${MIN_LEAD_MINUTES} minutes to be made.`;
}

/** A minute of the day as a 12-hour clock: "9:35 pm". */
export function showClock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** The most entries any one date holds, which is what that schedule's daily cap has to allow. */
export function busiestDay(dated: readonly DatedPost[]): number {
  const per = new Map<string, number>();
  for (const d of dated) per.set(d.on, (per.get(d.on) ?? 0) + 1);
  return Math.max(1, ...per.values());
}

/** A week of outlets as the form posts it, one per day, POST where nothing was said. */
export function outletsFrom(raw: readonly (string | null | undefined)[]): Outlet[] {
  return Array.from({ length: 7 }, (_, d) => (isOutlet(raw[d]) ? (raw[d] as Outlet) : "POST"));
}

/** Every outlet the plan actually uses: the days that post, or the dates. */
export function outletsInUse(plan: {
  repeat: Repeat;
  dayKinds: readonly (PostKind | null)[];
  dayOutlets: readonly Outlet[];
  dated: readonly DatedPost[];
}): Outlet[] {
  return plan.repeat === "DATES"
    ? plan.dated.map((d) => d.outlet)
    : plan.dayKinds.flatMap((k, d) => (k ? [plan.dayOutlets[d] ?? "POST"] : []));
}

/** Whole rupees a day, or null. "Rs 1,500" and "1500" both read. */
export function parseRupees(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/rs\.?|₹|,|\s/gi, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return n > 0 ? n : null;
}

/**
 * What an ad-carrying plan is missing, in the form's words. Null when nothing
 * in it is an ad, or when the ad settings are complete.
 */
export function adProblem(input: {
  outlets: readonly Outlet[];
  hasAdAccount: boolean;
  dailyBudget: number | null;
  days: number | null;
}): string | null {
  if (!input.outlets.some(usesAd)) return null;
  if (!input.hasAdAccount) return "Ads need a Meta or Google Ads account connected for this project.";
  if (!input.dailyBudget) return "Set a daily budget for the ads.";
  if (
    input.days === null ||
    !Number.isInteger(input.days) ||
    input.days < AD_DAYS_MIN ||
    input.days > AD_DAYS_MAX
  ) {
    return `An ad runs for ${AD_DAYS_MIN} to ${AD_DAYS_MAX} days.`;
  }
  return null;
}

/** `Sat 4 Oct`, the way a picked date is read back. */
export function showDate(on: string): string {
  const d = isoDate(on);
  if (!d) return on;
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// ---------------------------------------------------------------------------
// The look of a scheduled post
// ---------------------------------------------------------------------------

/**
 * How a scheduled post looks and reads: the choices the studio offers, kept
 * on the schedule so every run makes what a person would have picked by hand.
 *
 * One style per kind is the schedule's own, so a person sets it once rather
 * than per date; a date or a weekday may carry its own instead. Empty lists
 * and nulls are "as the studio does by default": every language and buyer
 * the brief has, its first size, a template and a font the AI chooses, and a
 * carousel of a cover, its points and a close.
 */
export type PostStyle = {
  /** The brief's languages to write in; empty is all of them. */
  languages: string[];
  /** The buyers to write for, as segment keys; empty is all of them. */
  buyers: string[];
  /** One of the brief's sizes for this kind; null is its first. */
  size: string | null;
  /** A design template of this kind; null is the AI's choice. */
  template: string | null;
  /** A typeface key; null is the AI's choice. */
  font: string | null;
  /** A carousel's slides; null is one per selling point, with a cover and a close. */
  slides: number | null;
};

export const DEFAULT_STYLE: PostStyle = {
  languages: [],
  buyers: [],
  size: null,
  template: null,
  font: null,
  slides: null,
};

export type StyleSet = Record<PostKind, PostStyle>;

export function defaultStyles(): StyleSet {
  return { IMAGE: { ...DEFAULT_STYLE }, CAROUSEL: { ...DEFAULT_STYLE }, VIDEO: { ...DEFAULT_STYLE } };
}

/** What a style may hold for one brief. Anything else is dropped, never guessed. */
export type StyleOptions = {
  languages: readonly string[];
  buyers: readonly string[];
  sizes: Readonly<Record<PostKind, readonly string[]>>;
  templates: Readonly<Record<PostKind, readonly string[]>>;
  fonts: readonly string[];
};

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 80))] : [];
const text = (raw: unknown): string | null => (typeof raw === "string" && raw.length > 0 && raw.length < 120 ? raw : null);

/**
 * A style as stored or posted, kept to its shape and nothing more. The
 * catalog check is `pickStyle()`'s, on the server, where the brief is known.
 */
export function looseStyle(raw: unknown): PostStyle | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const slides = Number(r.slides);
  return {
    languages: strings(r.languages).slice(0, 12),
    buyers: strings(r.buyers).slice(0, 8),
    size: text(r.size),
    template: text(r.template),
    font: text(r.font),
    slides: r.slides === null || r.slides === undefined || !Number.isInteger(slides) ? null : slides,
  };
}

/**
 * A style kept to what this brief can make. A language the brief dropped, a
 * size it no longer has, a template or a face nobody offers, a slide count
 * outside the range: each is dropped back to its default rather than kept.
 * A list naming every option is stored empty, so a language added to the
 * brief later is written in too.
 */
export function pickStyle(raw: unknown, kind: PostKind, options: StyleOptions): PostStyle {
  const s = looseStyle(raw) ?? DEFAULT_STYLE;
  const within = (xs: string[], allowed: readonly string[]) => {
    const kept = allowed.filter((a) => xs.includes(a));
    return kept.length === allowed.length ? [] : kept;
  };
  const size = s.size && options.sizes[kind].includes(s.size) ? s.size : null;
  // A template is kept only for a size it is drawn in: a banner design is
  // never a feed post's.
  const template = currentTemplateKey(s.template);
  const fits = !!template && templateFits(template, kind, size ?? options.sizes[kind][0] ?? "");
  return {
    languages: within(s.languages, options.languages),
    buyers: within(s.buyers, options.buyers),
    size,
    template: template && options.templates[kind].includes(template) && fits ? template : null,
    font: s.font && options.fonts.includes(s.font) ? s.font : null,
    slides: kind === "CAROUSEL" && s.slides !== null && s.slides >= MIN_SLIDES && s.slides <= MAX_SLIDES ? s.slides : null,
  };
}

/** The schedule's own style for each kind, as posted or stored. */
export function pickStyles(raw: unknown, options: StyleOptions): StyleSet {
  let r: unknown = raw;
  if (typeof raw === "string") {
    try {
      r = JSON.parse(raw);
    } catch {
      r = null;
    }
  }
  const o = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
  return {
    IMAGE: pickStyle(o.IMAGE, "IMAGE", options),
    CAROUSEL: pickStyle(o.CAROUSEL, "CAROUSEL", options),
    VIDEO: pickStyle(o.VIDEO, "VIDEO", options),
  };
}

/** The styles stored, read without a brief: their shape only. */
export function looseStyles(raw: unknown): StyleSet {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    IMAGE: looseStyle(o.IMAGE) ?? { ...DEFAULT_STYLE },
    CAROUSEL: looseStyle(o.CAROUSEL) ?? { ...DEFAULT_STYLE },
    VIDEO: looseStyle(o.VIDEO) ?? { ...DEFAULT_STYLE },
  };
}

/**
 * A weekday's own style, Sunday first, null where the day takes the
 * schedule's style for its kind or posts nothing. With `options` each is
 * kept to the brief; without, to its shape.
 */
export function pickDayStyles(
  raw: unknown,
  week: readonly (PostKind | null)[],
  options?: StyleOptions,
): (PostStyle | null)[] {
  let r: unknown = raw;
  if (typeof raw === "string") {
    try {
      r = JSON.parse(raw);
    } catch {
      r = null;
    }
  }
  const list = Array.isArray(r) ? r : [];
  return Array.from({ length: 7 }, (_, d) => {
    const kind = week[d];
    if (!kind || !list[d]) return null;
    return options ? pickStyle(list[d], kind, options) : looseStyle(list[d]);
  });
}

/** What one entry makes: its own style, or the schedule's for its kind. */
export function styleOf(
  entry: { kind: PostKind; style?: PostStyle | null },
  defaults: Partial<StyleSet> | null | undefined,
): PostStyle {
  return entry.style ?? defaults?.[entry.kind] ?? DEFAULT_STYLE;
}

/** Whether two styles make the same post. The order of a list does not matter. */
export function sameStyle(a: PostStyle, b: PostStyle): boolean {
  const sorted = (xs: string[]) => [...xs].sort().join("\u0000");
  return (
    sorted(a.languages) === sorted(b.languages) &&
    sorted(a.buyers) === sorted(b.buyers) &&
    a.size === b.size &&
    a.template === b.template &&
    a.font === b.font &&
    a.slides === b.slides
  );
}

/**
 * The languages a run writes in: the style's, as far as the brief still has
 * them, in the brief's order. None left (the brief dropped them since) is
 * every language the brief has, rather than nothing.
 */
export function writeIn(style: PostStyle, briefLanguages: readonly string[]): string[] {
  const kept = briefLanguages.filter((l) => style.languages.includes(l));
  return kept.length ? kept : [...briefLanguages];
}
