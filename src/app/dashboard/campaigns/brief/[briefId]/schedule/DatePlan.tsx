"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Close } from "@/components/icons";
import {
  earliestAt,
  showClock,
  showDate,
  tooSoon,
  MIN_LEAD_MINUTES,
  usesAd,
  MAX_DATED_POSTS,
  OUTLETS,
  type DatedPost,
  type Outlet,
} from "@/lib/plan-rules";
import type { PostKind } from "@/lib/compose-rules";

/**
 * The calendar a person picks posting days from, and the list of what each
 * picked day makes.
 *
 * A day is picked by pressing it and unpicked by pressing it again; the list
 * beside the month is where its kind, time and outlet are set. Days before
 * today in IST are not offered, and neither is a new day once the plan holds
 * `MAX_DATED_POSTS`. A time closer than `MIN_LEAD_MINUTES` is flagged on its
 * row, and the server refuses it, unless the schedule already had it saved.
 */

const NONE: DatedPost[] = [];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** How far ahead the month control goes. */
const MONTHS_AHEAD = 12;

/** Today's date on an IST wall clock, as `YYYY-MM-DD`. */
function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function minuteOf(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

export default function DatePlan({
  id,
  value,
  onChange,
  kinds,
  adsAvailable,
  renderStyle,
  saved = NONE,
}: {
  id: string;
  value: DatedPost[];
  onChange: (next: DatedPost[]) => void;
  /** The kinds this brief can make. */
  kinds: { key: PostKind; label: string }[];
  adsAvailable: boolean;
  /** A date's own style, drawn under its row while it is open. */
  renderStyle?: (date: DatedPost, close: () => void) => ReactNode;
  /** The dates the schedule already holds, which keep their time. */
  saved?: DatedPost[];
}) {
  // The clock the too-soon check reads, moved on each half minute.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const kept = useMemo(() => new Set(saved.map((d) => `${d.on} ${d.at}`)), [saved]);
  // The date whose style is open, as `on at`.
  const [open, setOpen] = useState<string | null>(null);
  const today = useMemo(istToday, []);
  const [ty, tm] = today.split("-").map(Number);
  const [month, setMonth] = useState(() => {
    // Open on the month of the first upcoming pick, or this month.
    const first = value.find((d) => d.on >= today);
    const [y, m] = (first?.on ?? today).split("-").map(Number);
    return { y, m: m - 1 };
  });

  const offset = (month.y - ty) * 12 + (month.m - (tm - 1));
  const lead = new Date(Date.UTC(month.y, month.m, 1)).getUTCDay();
  const days = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate();
  const title = new Date(Date.UTC(month.y, month.m, 1)).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
  const picked = new Set(value.map((d) => d.on));
  const full = value.length >= MAX_DATED_POSTS;
  const fallbackKind = kinds[0]?.key ?? "IMAGE";

  const shift = (by: number) =>
    setMonth(({ y, m }) => {
      const t = y * 12 + m + by;
      return { y: Math.floor(t / 12), m: t % 12 };
    });

  const toggle = (on: string) => {
    if (picked.has(on)) {
      onChange(value.filter((d) => d.on !== on));
      return;
    }
    if (full) return;
    // A new day follows the last one picked, so a run of launch days is a
    // run of presses rather than a form per day.
    const last = value[value.length - 1];
    // Today starts at the earliest time a post can still be made for.
    const earliest = earliestAt(on, now) ?? 0;
    const next: DatedPost = {
      on,
      at: Math.max(last?.at ?? 600, earliest),
      kind: last?.kind ?? fallbackKind,
      outlet: adsAvailable ? (last?.outlet ?? "POST") : "POST",
      // A run of launch days in one look: the last day's own style comes too.
      style: last?.style ?? null,
    };
    onChange([...value, next].sort((a, b) => (a.on === b.on ? a.at - b.at : a.on < b.on ? -1 : 1)));
  };

  const update = (on: string, at: number, patch: Partial<DatedPost>) =>
    onChange(value.map((d) => (d.on === on && d.at === at ? { ...d, ...patch } : d)));

  return (
    <div className="dateplan">
      <div className="dateplan__cal">
        <div className="dateplan__head">
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => shift(-1)}
            disabled={offset <= 0}
            aria-label="Previous month"
          >
            <ChevronLeft size={15} />
          </button>
          <strong aria-live="polite" id={`${id}-month`}>
            {title}
          </strong>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => shift(1)}
            disabled={offset >= MONTHS_AHEAD}
            aria-label="Next month"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        <div className="dateplan__grid" role="group" aria-labelledby={`${id}-month`}>
          {WEEKDAYS.map((w) => (
            <span key={w} className="dateplan__wd" aria-hidden>
              {w.slice(0, 2)}
            </span>
          ))}
          {Array.from({ length: lead }, (_, i) => (
            <span key={`pad-${i}`} aria-hidden />
          ))}
          {Array.from({ length: days }, (_, i) => {
            const on = iso(month.y, month.m, i + 1);
            const isPicked = picked.has(on);
            const past = on < today || (on === today && !picked.has(on) && earliestAt(on, now) === null);
            const ad = isPicked && value.some((d) => d.on === on && usesAd(d.outlet));
            return (
              <button
                key={on}
                type="button"
                className={[
                  "dateplan__day",
                  isPicked ? "dateplan__day--on" : "",
                  on === today ? "dateplan__day--today" : "",
                ].join(" ")}
                disabled={past || (!isPicked && full)}
                aria-pressed={isPicked}
                aria-label={showDate(on)}
                onClick={() => toggle(on)}
                data-date={on}
              >
                {i + 1}
                {ad && <span className="dateplan__admark" aria-hidden />}
              </button>
            );
          })}
        </div>

        <p className="dateplan__count">
          {value.length
            ? `${value.length} ${value.length === 1 ? "date" : "dates"}${full ? `, the most one schedule holds` : ""}`
            : "Pick the days a post goes out"}
        </p>
      </div>

      {value.length > 0 && (
        <ol className="dateplan__list">
          {value.map((d) => {
            const name = showDate(d.on);
            const key = `${d.on} ${d.at}`;
            const soon = tooSoon(d, now) && !kept.has(key);
            const earliest = soon ? earliestAt(d.on, now) : null;
            const floor = d.on === today ? earliestAt(d.on, now) : null;
            return (
              <Fragment key={key}>
              <li className={`dateplan__row${adsAvailable ? " dateplan__row--ads" : ""}${renderStyle ? " dateplan__row--styled" : ""}`} data-dated={d.on}>
                <span className="dateplan__date">{name}</span>
                <select
                  className="select-field dateplan__kind"
                  value={d.kind}
                  // A style belongs to a kind: a date that changes kind takes the new kind's.
                  onChange={(e) => update(d.on, d.at, { kind: e.target.value as PostKind, style: null })}
                  aria-label={`${name}: what goes out`}
                >
                  {kinds.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <input
                  type="time"
                  className="formfield__input"
                  value={clock(d.at)}
                  onChange={(e) => {
                    const at = minuteOf(e.target.value);
                    if (at !== null && !value.some((o) => o.on === d.on && o.at === at)) update(d.on, d.at, { at });
                  }}
                  aria-label={`${name}: time it goes out`}
                  aria-invalid={soon || undefined}
                  min={floor !== null && !kept.has(key) ? clock(floor) : undefined}
                  required
                />
                {adsAvailable && (
                  <select
                    className="select-field dateplan__outlet"
                    value={d.outlet}
                    onChange={(e) => update(d.on, d.at, { outlet: e.target.value as Outlet })}
                    aria-label={`${name}: how it goes out`}
                  >
                    {OUTLETS.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
                {renderStyle && (
                  <button
                    type="button"
                    className={`stylebtn dateplan__stylebtn${d.style ? " stylebtn--own" : ""}`}
                    aria-expanded={open === key}
                    onClick={() => setOpen((o) => (o === key ? null : key))}
                    data-date-style={d.on}
                  >
                    {d.style ? "Own style" : "Style"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--icon dateplan__remove"
                  onClick={() => onChange(value.filter((o) => !(o.on === d.on && o.at === d.at)))}
                  aria-label={`Remove ${name}`}
                >
                  <Close size={14} />
                </button>
              </li>
              {soon && (
                <li className="dateplan__soon" role="alert">
                  {earliest === null
                    ? `Too late for ${name}. A post needs ${MIN_LEAD_MINUTES} minutes to be made; pick a later day.`
                    : `Too soon. Pick ${showClock(earliest)} or later.`}
                </li>
              )}
              {renderStyle && open === key && (
                <li className="dateplan__style" aria-label={`${name}: style`}>
                  {renderStyle(d, () => setOpen(null))}
                </li>
              )}
              </Fragment>
            );
          })}
        </ol>
      )}
    </div>
  );
}
