"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight, Check, ChevronDown, Close, Search, Visit as VisitIcon } from "@/components/icons";
import { moveVisitAction, visitAction, visitHoursAction, visitNoteAction } from "@/app/actions/leads";
import type { NoteView } from "@/lib/visit-notes";
import { VoiceNote } from "./VoiceNote";
import { addDays, showDate, showTime } from "@/lib/lead-rules";
import { RevealPhone } from "@/components/RevealPhone";
import "./visits.css";
import {
  HOURS,
  INTERESTS,
  NEXT_STEPS,
  OBJECTIONS,
  STATUS,
  VIEWS,
  arrivalLabel,
  countDay,
  dayCapacity,
  dayWord,
  holdsSlot,
  hostsOnDuty,
  hourOf,
  inView,
  isWeekend,
  journey,
  matchesQuery,
  needsYou,
  nextLine,
  showRate,
  toMin,
  fromMin,
  type Interest,
  type Objection,
  type Outcome,
  type Step as JourneyStep,
  type Visit,
  type View,
} from "@/lib/visit-rules";
import { SITE_HOSTS, WEEK, sampleVisits, sitesFrom } from "@/lib/visit-sample";

type Can = { checkIn: boolean; outcome: boolean; schedule: boolean; partners: boolean };

/** One thing the engine did or will do for a real visit, and whether it falls before the slot. */
export type LadderStep = JourneyStep & { before: boolean };

type VisitMove = "CHECK_IN" | "VISITED" | "NO_SHOW" | "CANCEL";

const DIRECT = "direct";
const PARTNER = "partner";

const count = (n: number) => n.toLocaleString("en-IN");
const hourLabel = (h: string) => showTime(h).replace(":00", "");
const istMin = (iso: string) => toMin(new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16));
/** What the lead record leaves blank reads as nothing, not as "Not known" in a row. */
const known = (s: string) => s !== "" && s !== "Not known";

export function VisitDay({
  today,
  nowIso,
  places,
  real,
  ladder,
  can,
}: {
  today: string;
  nowIso: string;
  places: string[];
  /** The week's real visits. Absent, the sheet is laid out with invented ones. */
  real?: Visit[];
  /** What went out for each real visit, by visit id. */
  ladder?: Record<string, LadderStep[]>;
  can: Can;
}) {
  const router = useRouter();
  const isReal = real !== undefined;

  // Real visits run on the gallery's clock, so the minute moves while the
  // page is open. The sample stays pinned to the render, as it always was.
  const [clock, setClock] = useState(nowIso);
  useEffect(() => {
    if (!isReal) return;
    setClock(nowIso);
    const t = setInterval(() => setClock(new Date().toISOString()), 60_000);
    return () => clearInterval(t);
  }, [isReal, nowIso]);
  const nowMin = useMemo(() => istMin(isReal ? clock : nowIso), [isReal, clock, nowIso]);

  const sites = useMemo(() => sitesFrom(places), [places]);
  const generated = useMemo(
    () => real ?? sampleVisits({ today, nowIso, places }),
    [real, today, nowIso, places],
  );

  // What people did on this screen, laid over the visits. On the sample
  // nothing is saved and undo puts the previous layer back. On real visits
  // it is the answer shown before the server's arrives, and a fresh read
  // from the server replaces it.
  const [edits, setEdits] = useState<Record<string, Partial<Visit>>>({});
  const all = useMemo(() => generated.map((v) => (edits[v.id] ? { ...v, ...edits[v.id] } : v)), [generated, edits]);
  useEffect(() => {
    if (real) setEdits({});
  }, [real]);
  const [busy, setBusy] = useState<string | null>(null);

  const [day, setDay] = useState(today);
  const [site, setSite] = useState<string>("all");
  const [view, setView] = useState<View>("all");
  const [host, setHost] = useState<string>("all");
  const [source, setSource] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // The buyer just checked in from the hero stays in it until somebody moves
  // on. Swapping straight to the next buyer put a stranger's visit under the
  // same button a second press would land on.
  const [justIn, setJustIn] = useState<string | null>(null);
  // `before` is the sample's undo. A real visit has no undo, and a refusal
  // from the server is shown as one.
  const [toast, setToast] = useState<{ text: string; before?: Record<string, Partial<Visit>>; bad?: boolean } | null>(
    null,
  );

  const chosenSites = site === "all" ? sites : sites.filter((s) => s.name === site);
  const inSite = (v: Visit) => site === "all" || v.project === site;

  // The sample's hosts are its own roster. Real hosts are whoever is named
  // on this week's visits; with none, there is nothing to filter by.
  const hosts = useMemo(
    () => (isReal ? [...new Set(all.map((v) => v.host).filter((h): h is string => !!h))].sort() : SITE_HOSTS),
    [isReal, all],
  );

  // Project and day decide what the numbers describe. Host, source, search
  // and the view only narrow the sheet, so the numbers above it hold still.
  const dayVisits = useMemo(() => all.filter((v) => v.date === day && inSite(v)), [all, day, site]); // eslint-disable-line react-hooks/exhaustive-deps
  const tally = useMemo(() => countDay(dayVisits), [dayVisits]);
  const capacity = dayCapacity(chosenSites, day);
  const rate = day === today ? showRate(dayVisits, today, nowMin) : showRate(dayVisits);
  // Confirmed visits whose time has passed with nobody checked in: they are
  // due, so the line under the tally cannot say nobody was.
  const overdue = day === today ? dayVisits.filter((v) => v.status === "confirmed" && toMin(v.time) < nowMin).length : 0;

  const narrowed = useMemo(
    () =>
      dayVisits.filter(
        (v) =>
          (host === "all" || v.host === host) &&
          (source === "all" || (source === PARTNER ? v.cp !== null : v.cp === null)) &&
          matchesQuery(v, query),
      ),
    [dayVisits, host, source, query],
  );
  const viewCounts = useMemo(() => {
    const out = {} as Record<View, number>;
    for (const x of VIEWS) out[x.key] = narrowed.filter((v) => inView(v, x.key, today, nowMin)).length;
    return out;
  }, [narrowed, today, nowMin]);
  const rows = useMemo(() => narrowed.filter((v) => inView(v, view, today, nowMin)), [narrowed, view, today, nowMin]);

  const week = useMemo(
    () =>
      WEEK.map((o) => {
        const date = addDays(today, o);
        const booked = all.filter((v) => v.date === date && inSite(v) && holdsSlot(v)).length;
        return { date, booked, cap: dayCapacity(chosenSites, date) };
      }),
    [all, today, site], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Real galleries have not told us how many hosts they staff, so a real
  // week is drawn against its own busiest day rather than an invented cap.
  const busiest = Math.max(1, ...week.map((d) => d.booked));

  // The next person through the gallery door today, in the project chosen.
  const todays = all.filter((v) => v.date === today && inSite(v));
  const held = justIn ? todays.find((v) => v.id === justIn && v.status === "on_site") : undefined;
  const next = todays
    .filter((v) => v.status === "confirmed" && toMin(v.time) >= nowMin - 45)
    .sort((a, b) => toMin(a.time) - toMin(b.time))[0];

  const filtered = view !== "all" || host !== "all" || source !== "all" || query.trim() !== "";
  const clear = () => {
    setView("all");
    setHost("all");
    setSource("all");
    setQuery("");
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const id = openId;
      setOpenId(null);
      document.getElementById(`sv-btn-${id}`)?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId]);

  const change = (v: Visit, patch: Partial<Visit>, text: string) => {
    const before = edits;
    setEdits({ ...edits, [v.id]: { ...(edits[v.id] ?? {}), ...patch } });
    setToast({ text, before });
  };

  const lay = (id: string, p: Partial<Visit>) => setEdits((cur) => ({ ...cur, [id]: { ...(cur[id] ?? {}), ...p } }));
  const unlay = (id: string) =>
    setEdits((cur) => {
      const next = { ...cur };
      delete next[id];
      return next;
    });

  /**
   * A real visit changes on the server. Check-in and no-show show at once
   * and step back if the server refuses; recording waits for the answer, so
   * a refusal never throws away what the host typed.
   */
  const send = async (
    v: Visit,
    action: VisitMove,
    opts: { now?: Partial<Visit>; after?: Partial<Visit>; outcome?: Outcome; from?: FromNote },
  ) => {
    if (busy) return;
    setBusy(v.id);
    if (opts.now) lay(v.id, opts.now);
    let res: { ok: boolean; message: string };
    try {
      res = await visitAction({
        visitId: v.id,
        action,
        outcome: opts.outcome
          ? {
              interest: opts.outcome.interest,
              objection: opts.outcome.objection,
              next: opts.outcome.next,
              note: opts.outcome.note,
            }
          : undefined,
        noteId: opts.from?.noteId,
        unitIds: opts.from?.unitIds,
      });
    } catch {
      res = { ok: false, message: "That did not save. Check the connection and try again." };
    }
    if (res.ok && opts.after) lay(v.id, opts.after);
    if (!res.ok && opts.now) unlay(v.id);
    setToast({ text: `${v.buyer}: ${res.message}`, bad: !res.ok });
    setBusy(null);
    if (res.ok) router.refresh();
  };

  const nowHHMM = fromMin(nowMin);
  const act: Act = isReal
    ? {
        checkIn: (v) => send(v, "CHECK_IN", { now: { status: "on_site", arrivedAt: fromMin(istMin(new Date().toISOString())) } }),
        noShow: (v) => send(v, "NO_SHOW", { now: { status: "no_show" } }),
        record: (v, outcome, from) => send(v, "VISITED", { outcome, from, after: { status: "visited", outcome } }),
        cancel: (v) => send(v, "CANCEL", { now: { status: "cancelled" } }),
        move: async (v, date, time) => {
          if (busy) return false;
          setBusy(v.id);
          let res: { ok: boolean; message: string };
          try {
            res = await moveVisitAction({ visitId: v.id, date, time });
          } catch {
            res = { ok: false, message: "That did not save. Check the connection and try again." };
          }
          setToast({ text: `${v.buyer}: ${res.message}`, bad: !res.ok });
          setBusy(null);
          if (res.ok) router.refresh();
          return res.ok;
        },
      }
    : {
        checkIn: (v) =>
          change(v, { status: "on_site", arrivedAt: nowHHMM }, `${v.buyer} checked in at ${showTime(nowHHMM)}`),
        noShow: (v) => change(v, { status: "no_show" }, `${v.buyer} marked as a no-show. Recovery has started.`),
        confirm: (v) => change(v, { status: "confirmed" }, `${v.buyer} confirmed for ${showTime(v.time)}`),
        record: (v, outcome) => change(v, { status: "visited", outcome }, `${v.buyer}'s visit recorded`),
        host: (v, name) => change(v, { host: name }, `${name} is hosting ${v.buyer}`),
      };

  // Opening a row closes the one above it, and the page used to jump by the
  // height that closed while the pointer was still there, so a second press
  // landed on somebody else's visit. The clicked row stays where it was.
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const toggleRow = (id: string) => {
    const el = document.getElementById(`sv-row-${id}`);
    if (el) anchor.current = { id, top: el.getBoundingClientRect().top };
    setOpenId((cur) => (cur === id ? null : id));
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    const el = document.getElementById(`sv-row-${a.id}`);
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - a.top);
  }, [openId]);

  const openVisit = (v: Visit) => {
    setDay(v.date);
    setView("all");
    setOpenId(v.id);
    requestAnimationFrame(() =>
      document.getElementById(`sv-row-${v.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  };

  // The gallery's hours, plus any hour a real visit was booked outside them,
  // so no visit falls off the sheet for being early or late.
  const hours = [...new Set([...HOURS, ...rows.map((v) => hourOf(v.time))])].sort();
  const byHour = hours.map((h) => ({
    hour: h,
    visits: rows.filter((v) => hourOf(v.time) === h),
    booked: dayVisits.filter((v) => hourOf(v.time) === h && holdsSlot(v)).length,
    cap: chosenSites.reduce((n, s) => n + hostsOnDuty(day, s.big), 0),
  }));

  return (
    <div className="sv">
      <PageHead
        title={
          <>
            Site <span className="em">visits</span>
          </>
        }
        meta={
          isReal ? (
            "Every visit booked with your buyers."
          ) : (
            <>
              <span className="pill pill--warn" style={{ marginRight: 8 }}>
                <span className="pill__dot" />
                Sample data
              </span>
              These visits are invented. Checking someone in is not saved.
            </>
          )
        }
        action={
          sites.length > 1 || (isReal && can.checkIn) ? (
            <>
            {isReal && can.checkIn && (
              <Link href="/dashboard/visits/scan" className="btn btn--ink">
                Scan a pass
                <ArrowUpRight size={14} />
              </Link>
            )}
            {sites.length > 1 && (
            <div className="seg" role="group" aria-label="Project">
              <button type="button" className="seg__opt" aria-pressed={site === "all"} onClick={() => setSite("all")}>
                All projects
              </button>
              {sites.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  className="seg__opt"
                  aria-pressed={site === s.name}
                  onClick={() => setSite(s.name)}
                >
                  {s.name}
                </button>
              ))}
            </div>
            )}
            </>
          ) : null
        }
      />

      {/* ------------------------------------------------------------------ */}
      <section className="sv-strip" aria-label="The week">
        <div className="sv-week">
          <div className="sv-cols" role="group" aria-label="Pick a day">
            {week.map((d) => {
              const pct = isReal ? d.booked / busiest : d.cap ? Math.min(1, d.booked / d.cap) : 0;
              const on = d.date === day;
              return (
                <button
                  key={d.date}
                  type="button"
                  className={`sv-col${on ? " is-on" : ""}${d.date === today ? " is-today" : ""}`}
                  aria-pressed={on}
                  aria-label={
                    isReal
                      ? `${dayWord(d.date, today)}, ${d.booked} ${d.booked === 1 ? "visit" : "visits"} booked`
                      : `${dayWord(d.date, today)}, ${d.booked} of ${d.cap} slots booked`
                  }
                  onClick={() => {
                    setDay(d.date);
                    setOpenId(null);
                  }}
                >
                  <span className="sv-col__n tnum">{d.booked}</span>
                  <span className="sv-col__track" aria-hidden>
                    <span className="sv-col__fill" style={{ height: `${Math.max(4, pct * 100)}%` }} />
                  </span>
                  <span className="sv-col__day">
                    {d.date === today ? "Today" : showDate(d.date).slice(0, 6).trim()}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="sv-sum">
            <p className="sv-sum__day">
              {dayWord(day, today) === showDate(day) ? showDate(day) : `${dayWord(day, today)}, ${showDate(day).slice(4)}`}
              {isWeekend(day) && <span className="pill pill--blue">Weekend</span>}
            </p>
            <p className="sv-sum__big">
              <span className="sv-sum__num">{count(tally.booked)}</span>
              <span className="sv-sum__of">
                {isReal
                  ? tally.booked === 1
                    ? "visit booked"
                    : "visits booked"
                  : `of ${count(capacity)} slots booked`}
              </span>
            </p>
            {!isReal && (
              <span className="sv-meter" aria-hidden>
                <span style={{ width: `${capacity ? Math.min(100, (tally.booked / capacity) * 100) : 0}%` }} />
              </span>
            )}
            <dl className="sv-tally">
              <div>
                <dt>Visited</dt>
                <dd className="tnum">{tally.visited}</dd>
              </div>
              <div>
                <dt>On site</dt>
                <dd className="tnum">{tally.onSite}</dd>
              </div>
              <div>
                <dt>To come</dt>
                <dd className="tnum">{tally.toCome}</dd>
              </div>
              <div>
                <dt>No-shows</dt>
                <dd className="tnum">{tally.missed}</dd>
              </div>
            </dl>
            <p className="sv-sum__foot">
              {rate !== null
                ? `${Math.round(rate * 100)}% of those due turned up${overdue ? `, ${overdue} not in yet` : ""}`
                : overdue
                  ? `${overdue} due and not checked in yet`
                  : "Nobody was due before now"}
            </p>
          </div>
        </div>

        <NextArrival
          next={next}
          held={held}
          onRelease={() => setJustIn(null)}
          todays={todays}
          nowMin={nowMin}
          isReal={isReal}
          busy={busy !== null}
          canCheckIn={can.checkIn}
          onCheckIn={(v) => {
            setJustIn(v.id);
            act.checkIn(v);
          }}
          onOpen={openVisit}
          onMissed={() => {
            setDay(today);
            setView("missed");
          }}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      <div className="kb-tools sv-tools" role="group" aria-label="Filter visits">
        <label className="kb-search">
          <Search size={15} />
          <span className="sr-only">Search visits</span>
          <input
            type="search"
            placeholder={isReal ? "Name, number or host" : "Name, number, firm or host"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        {hosts.length > 0 && (
          <label className={`kb-chip kb-pick${host !== "all" ? " is-on" : ""}`}>
            <span className="sr-only">Host</span>
            <select value={host} onChange={(e) => setHost(e.target.value)}>
              <option value="all">All hosts</option>
              {hosts.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
        )}

        {/* No partner has brought a real visit yet, so there is nothing to split by. */}
        {!isReal && (
          <label className={`kb-chip kb-pick${source !== "all" ? " is-on" : ""}`}>
            <span className="sr-only">Came through</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="all">Partners and direct</option>
              <option value={PARTNER}>Brought by partners</option>
              <option value={DIRECT}>Came direct</option>
            </select>
            <ChevronDown size={12} />
          </label>
        )}

        {filtered && (
          <div className="kb-tools__end">
            <button type="button" className="kb-clear" onClick={clear}>
              <Close size={12} />
              Clear filters
            </button>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      <section className="card sv-sheet" aria-label={`Visits, ${dayWord(day, today)}`}>
        <div className="ws-views" role="group" aria-label="Show">
          {VIEWS.map((x) => (
            <button
              key={x.key}
              type="button"
              className={`ws-view${x.key === "needs" ? " ws-view--ink" : ""}`}
              aria-pressed={view === x.key}
              onClick={() => setView(x.key)}
            >
              {x.label}
              <span className="ws-view__n tnum">{count(viewCounts[x.key])}</span>
            </button>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="empty ws-empty">
            <span className="empty__mark" aria-hidden>
              <VisitIcon size={20} />
            </span>
            {dayVisits.length === 0 ? (
              <p>No visits booked {dayWord(day, today) === "Today" ? "today" : `for ${showDate(day)}`}.</p>
            ) : (
              <>
                <p>No visits match these filters.</p>
                <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
                  Clear filters
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="sv-head" aria-hidden>
              <span>Time</span>
              <span>Buyer</span>
              <span>Came through</span>
              <span>Host</span>
              <span>Status</span>
              <span>Next</span>
            </div>
            <ol className="sv-hours">
              {byHour
                .filter((h) => h.visits.length > 0)
                .map((h) => (
                  <li key={h.hour} className="sv-hour">
                    <div className="sv-hour__head">
                      <span className="sv-hour__t">{hourLabel(h.hour)}</span>
                      {isReal ? (
                        <span className="sv-hour__cap tnum">{h.booked} booked</span>
                      ) : (
                        <>
                          <span className="sv-slots" aria-label={`${h.booked} of ${h.cap} hosts booked`}>
                            {Array.from({ length: h.cap }, (_, i) => (
                              <span key={i} className={i < h.booked ? "is-taken" : undefined} />
                            ))}
                          </span>
                          <span className="sv-hour__cap tnum">
                            {h.booked >= h.cap ? "Full" : `${h.cap - h.booked} free`}
                          </span>
                        </>
                      )}
                    </div>
                    <ul className="sv-list">
                      {h.visits.map((v) => (
                        <VisitRow
                          key={v.id}
                          v={v}
                          open={openId === v.id}
                          today={today}
                          nowMin={nowMin}
                          can={can}
                          onToggle={() => toggleRow(v.id)}
                          act={act}
                          ladder={ladder ? (ladder[v.id] ?? []) : null}
                          busy={busy}
                        />
                      ))}
                    </ul>
                  </li>
                ))}
            </ol>
          </>
        )}
      </section>

      <div className="kb-toast-slot" role="status" aria-live="polite">
        {toast && (
          <div className={`kb-toast${isReal ? " sv-toast" : ""}${toast.bad ? " sv-toast--bad" : ""}`}>
            {toast.bad && <span className="sv-toast__dot" aria-hidden />}
            <span>{toast.text}</span>
            {toast.before ? (
              <button
                type="button"
                onClick={() => {
                  if (toast.before) setEdits(toast.before);
                  setToast(null);
                }}
              >
                Undo
              </button>
            ) : (
              <button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>
                <Close size={11} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The near-black card: who walks in next
// ---------------------------------------------------------------------------

function NextArrival({
  next,
  held,
  onRelease,
  todays,
  nowMin,
  isReal,
  busy,
  canCheckIn,
  onCheckIn,
  onOpen,
  onMissed,
}: {
  next: Visit | undefined;
  held: Visit | undefined;
  onRelease: () => void;
  todays: Visit[];
  nowMin: number;
  isReal: boolean;
  busy: boolean;
  canCheckIn: boolean;
  onCheckIn: (v: Visit) => void;
  onOpen: (v: Visit) => void;
  onMissed: () => void;
}) {
  if (held) {
    return (
      <aside className="sv-next" aria-label="Checked in">
        <p className="sv-next__label">
          Checked in{held.arrivedAt ? <> · <span className="tnum">{showTime(held.arrivedAt)}</span></> : null}
        </p>
        <p className="sv-next__when">{held.host ? `With ${held.host.split(" ")[0]}` : "On site"}</p>
        <p className="sv-next__who">{held.buyer}</p>
        <p className="sv-next__meta">{held.place.split(" · ")[1] ?? held.project}</p>
        <div className="sv-next__foot">
          <span />
          <button type="button" className="sv-next__cta" onClick={onRelease}>
            {next ? `Next: ${next.buyer}` : "Done"}
            <ArrowUpRight size={13} />
          </button>
        </div>
      </aside>
    );
  }

  if (!next) {
    const t = countDay(todays);
    return (
      <aside className="sv-next" aria-label="Next arrival">
        <p className="sv-next__label">Next arrival</p>
        <p className="sv-next__who">Nobody else is due today</p>
        <p className="sv-next__meta">
          {t.visited} visited · {t.missed} {t.missed === 1 ? "no-show" : "no-shows"}
        </p>
        {t.missed > 0 && (
          <div className="sv-next__foot">
            <span />
            <button type="button" className="sv-next__cta" onClick={onMissed}>
              See the no-shows
              <ArrowUpRight size={13} />
            </button>
          </div>
        )}
      </aside>
    );
  }

  // The gallery checks somebody in from an hour before their slot.
  const early = toMin(next.time) - nowMin > 60;
  const tower = next.place.split(" · ")[1] ?? next.project;
  return (
    <aside className="sv-next" aria-label="Next arrival">
      <p className="sv-next__label">
        Next arrival · <span className="tnum">{showTime(next.time)}</span>
      </p>
      <p className="sv-next__when">{arrivalLabel(next.time, nowMin)}</p>
      <p className="sv-next__who">{next.buyer}</p>
      <p className="sv-next__meta">
        {isReal
          ? [known(next.config) ? next.config : null, tower, next.visitNo > 1 ? `revisit ${next.visitNo}` : null]
              .filter(Boolean)
              .join(" · ")
          : `${next.config} · ${tower} · ${next.party === 1 ? "alone" : `${next.party} people`}${
              next.visitNo > 1 ? ` · revisit ${next.visitNo}` : ""
            }`}
      </p>
      <p className="sv-next__meta">
        {next.host ? `Host ${next.host}` : "No host yet"} · {next.cp ? next.cp.firm : next.source}
      </p>
      <div className="sv-next__foot">
        {/* What the sample assumes went out. A real visit's messages are in the visit itself. */}
        <span className="sv-next__sub">{isReal ? "" : next.cab ? "Cab booked" : "Pin and live location sent"}</span>
        {canCheckIn && !early ? (
          <button type="button" className="sv-next__cta" disabled={busy} onClick={() => onCheckIn(next)}>
            Check in
            <Check size={13} />
          </button>
        ) : (
          <button type="button" className="sv-next__cta" onClick={() => onOpen(next)}>
            Open the visit
            <ArrowUpRight size={13} />
          </button>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// One row, and the visit it unfolds into
// ---------------------------------------------------------------------------

/**
 * What this screen can do to a visit. A real visit can be checked in,
 * marked a no-show and recorded, and nothing else, so `confirm` and `host`
 * exist only on the sample and their controls are drawn only when they do.
 */
/** The voice note a recorded outcome was confirmed from. */
type FromNote = { noteId: string; unitIds: string[] };

type Act = {
  checkIn: (v: Visit) => void;
  noShow: (v: Visit) => void;
  record: (v: Visit, o: Outcome, from?: FromNote) => void;
  confirm?: (v: Visit) => void;
  host?: (v: Visit, name: string) => void;
  cancel?: (v: Visit) => void;
  move?: (v: Visit, date: string, time: string) => Promise<boolean>;
};

/**
 * The road a real visit has taken: booked, what went out before the slot,
 * whether they came, and what went out after. The messages and calls are the
 * engine's own record of what it sent, not what the clock says it should have.
 */
function realJourney(v: Visit, ladder: LadderStep[], today: string): JourneyStep[] {
  const bare = ({ label, when, state }: LadderStep): JourneyStep => ({ label, when, state });
  const steps: JourneyStep[] = [{ label: `Booked on ${v.bookedVia}`, when: showDate(v.bookedOn), state: "done" }];
  steps.push(...ladder.filter((s) => s.before).map(bare));
  switch (v.status) {
    case "confirmed":
      steps.push({ label: "Check in at the gallery", when: `Expected ${showTime(v.time)}`, state: "due" });
      break;
    case "on_site":
    case "visited":
      steps.push({ label: "Arrived at the gallery", when: v.arrivedAt ? showTime(v.arrivedAt) : "", state: "done" });
      break;
    case "no_show":
    case "lapsed":
      steps.push({ label: "Did not arrive", when: `Expected ${showTime(v.time)}`, state: "missed" });
      break;
    case "moved": {
      const word = v.movedTo ? dayWord(v.movedTo.date, today) : "";
      const day = word === "Today" || word === "Tomorrow" || word === "Yesterday" ? word.toLowerCase() : word;
      steps.push({
        label: v.movedTo ? `Moved to ${day}, ${showTime(v.movedTo.time)}` : "Moved to another slot",
        when: "",
        state: "done",
      });
      break;
    }
    case "cancelled":
      steps.push({ label: "Cancelled", when: "", state: "off" });
      break;
    default:
      break;
  }
  steps.push(...ladder.filter((s) => !s.before).map(bare));
  if (v.status === "on_site") steps.push({ label: "Record how it went", when: "After the visit", state: "due" });
  return steps;
}

function VisitRow({
  v,
  open,
  today,
  nowMin,
  can,
  onToggle,
  act,
  ladder,
  busy,
}: {
  v: Visit;
  open: boolean;
  today: string;
  nowMin: number;
  can: Can;
  onToggle: () => void;
  act: Act;
  /** Null on the sample. */
  ladder: LadderStep[] | null;
  busy: string | null;
}) {
  const s = STATUS[v.status];
  const flag = needsYou(v, today, nowMin);
  const nxt = nextLine(v, today, nowMin);
  const tower = v.place.split(" · ")[1] ?? v.project;
  const quiet = v.status === "cancelled" || v.status === "moved" || v.status === "lapsed";
  const sub = ladder
    ? [known(v.config) ? v.config : null, tower, v.visitNo > 1 ? `Revisit ${v.visitNo}` : null].filter(Boolean).join(" · ")
    : `${v.config} · ${tower}${v.visitNo > 1 ? ` · Revisit ${v.visitNo}` : ""}`;

  return (
    <li id={`sv-row-${v.id}`} className={`sv-item${open ? " is-open" : ""}${quiet ? " is-quiet" : ""}`}>
      <div className="sv-row" onClick={onToggle}>
        <span className="sv-time tnum">{showTime(v.time)}</span>
        <span className="sv-who">
          <button
            type="button"
            id={`sv-btn-${v.id}`}
            className="sv-who__name"
            aria-expanded={open}
            aria-controls={`sv-open-${v.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {v.buyer}
          </button>
          <span className="ws-sub">{sub}</span>
        </span>
        <span className="sv-src">
          <span className="sv-src__name">{v.cp ? v.cp.firm : v.source}</span>
          <span className="ws-sub">{v.cp ? v.cp.agent : "Direct"}</span>
        </span>
        <span className={`sv-host${v.host ? "" : " is-none"}`}>{v.host ?? "No host"}</span>
        <span className="sv-state">
          <span className={`pill pill--${s.tone}`}>
            <span className="pill__dot" />
            {s.label}
          </span>
        </span>
        <span className={`sv-nextline${flag ? " is-flag" : ` ws-tone--${nxt.tone}`}`}>
          {flag ?? nxt.text}
        </span>
        <span className="sv-chev" aria-hidden>
          <ChevronDown size={14} />
        </span>
      </div>
      {open && <VisitOpen v={v} today={today} nowMin={nowMin} can={can} act={act} ladder={ladder} busy={busy} />}
    </li>
  );
}

function VisitOpen({
  v,
  today,
  nowMin,
  can,
  act,
  ladder,
  busy,
}: {
  v: Visit;
  today: string;
  nowMin: number;
  can: Can;
  act: Act;
  ladder: LadderStep[] | null;
  busy: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [recording, setRecording] = useState(false);
  const [moving, setMoving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [draft, setDraft] = useState<NoteView | null>(null);
  const isReal = ladder !== null;
  const steps = ladder ? realJourney(v, ladder, today) : journey(v, today, nowMin);
  const isToday = v.date === today;
  const due = toMin(v.time) <= nowMin;
  // Any change in flight on this screen holds every control, so two presses
  // cannot race each other to the server.
  const held = busy !== null;
  const saving = busy === v.id;


  const canHost =
    !!act.host && can.schedule && (v.status === "confirmed" || v.status === "requested" || v.status === "on_site");
  // The sample offers a no-show only once today's slot has passed. A real
  // visit left confirmed on an earlier day can be closed as one too.
  const canNoShow =
    v.status === "confirmed" && can.outcome && (isToday ? due : isReal && v.date < today);
  // A note read while this screen was closed comes back as its draft.
  // A host may also leave one on the day, before the buyer is checked in.
  const noteBefore = isReal && v.status === "confirmed" && isToday && can.outcome;
  const canNote = (isReal && v.status === "on_site" && can.outcome) || noteBefore;
  useEffect(() => {
    if (!canNote) return;
    let live = true;
    visitNoteAction({ visitId: v.id })
      .then((n) => live && n?.state === "DRAFTED" && setDraft(n))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [canNote, v.id]);

  // A real visit still to come can be moved or called off.
  const canChange =
    isReal && can.schedule && (v.status === "confirmed" || v.status === "requested" || v.status === "no_show" || v.status === "blocked");

  return (
    <div className="sv-open" id={`sv-open-${v.id}`} ref={ref}>
      <div className="sv-open__grid">
        <section className="ws-sec" aria-label="For the host">
          <div className="ws-sec__head">
            <h3>For the host</h3>
            <span className={`pill ${v.temp === "HOT" ? "pill--risk" : v.temp === "WARM" ? "pill--warn" : "pill--blue"}`}>
              {v.temp === "HOT" ? "Hot" : v.temp === "WARM" ? "Warm" : "Cold"} lead
            </span>
          </div>
          <dl className="ws-facts sv-facts">
            <Fact k="Looking for" v={v.config} />
            <Fact k="Budget" v={v.budget} />
            <Fact k="Speaks" v={v.lang} />
            {/* Who is coming is not asked on a real booking yet, so it is not shown. */}
            {!isReal && <Fact k="Coming" v={v.party === 1 ? "Alone" : `${v.party} people`} />}
            {!isReal && <Fact k="Decision maker" v={v.decider ? "Coming" : "Not coming"} warn={!v.decider} />}
            <Fact k="Visit" v={v.visitNo === 1 ? "First" : `Revisit ${v.visitNo}`} />
          </dl>
          {v.ask && <p className="sv-ask">{v.ask}</p>}
          {!isReal && v.toShow.length > 0 && v.status !== "visited" && (
            <div className="sv-units">
              <span className="ws-sub">Units to show</span>
              <span className="sv-units__list">
                {v.toShow.map((u) => (
                  <span key={u} className="pill pill--quiet tnum">
                    {u}
                  </span>
                ))}
              </span>
            </div>
          )}
          {v.cp && (
            <div className="sv-cp">
              <p>
                Brought by <strong>{v.cp.firm}</strong>, {v.cp.agent}
              </p>
              <p className="ws-sub">
                {v.status === "blocked" && v.blocked === "cp_tag"
                  ? "Another firm registered the same buyer. The visit waits until the claim is settled."
                  : `Their registration runs ${v.cp.tagDaysLeft} more days. Checking in credits it to them.`}
              </p>
              {v.status === "blocked" && v.blocked === "cp_tag" && can.partners && (
                <Link href="/dashboard/partners" className="ws-link">
                  Settle it in Partners
                </Link>
              )}
            </div>
          )}
        </section>

        <section className="ws-sec" aria-label="Reminders and arrival">
          <h3>{v.status === "no_show" || v.status === "lapsed" || v.status === "moved" ? "Getting them back" : "Before they arrive"}</h3>
          <ol className="sv-steps">
            {steps.map((st, i) => (
              <li key={i} className={`sv-step sv-step--${st.state}`}>
                <span className="sv-step__mark" aria-hidden>
                  {st.state === "done" ? <Check size={11} /> : st.state === "missed" ? <Close size={10} /> : null}
                </span>
                <span className="sv-step__body">
                  <span className="sv-step__label">{st.label}</span>
                  {st.when && <span className="ws-sub tnum">{st.when}</span>}
                </span>
                <span className="sr-only">
                  {st.state === "done"
                    ? "Done"
                    : st.state === "missed"
                      ? "Missed"
                      : st.state === "off"
                        ? "Did not go out"
                        : "Coming up"}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="ws-sec" aria-label="How it went">
          <h3>How it went</h3>
          {v.outcome ? (
            <>
              <dl className="ws-facts sv-facts sv-facts--two">
                <Fact k="Interest" v={v.outcome.interest} />
                <Fact k="Held back by" v={v.outcome.objection === "None" ? "Nothing" : v.outcome.objection} />
                {!isReal && <Fact k="Shown" v={v.outcome.shown.join(", ") || "Not recorded"} />}
                <Fact k="Next" v={v.outcome.next} />
              </dl>
              {v.outcome.note && (
                <figure className="sv-note">
                  <blockquote>{v.outcome.note}</blockquote>
                  <figcaption className="ws-sub">
                    {isReal ? "After the visit" : `${v.host ?? "Host"}, after the visit`}
                  </figcaption>
                </figure>
              )}
            </>
          ) : v.status === "on_site" && can.outcome && (recording || draft) ? (
            <RecordForm
              v={v}
              saving={saving}
              held={held}
              draft={draft}
              onCancel={() => {
                setRecording(false);
                setDraft(null);
              }}
              onSave={(o) => act.record(v, o, draft?.draft ? { noteId: draft.id, unitIds: draft.draft.unitIds } : undefined)}
            />
          ) : noteBefore && draft ? (
            <p className="sv-none" data-note-before>Your note before the visit is read. It fills this in once they are checked in.</p>
          ) : canNote ? (
            <VoiceNote visitId={v.id} held={held} onDraft={setDraft} label={noteBefore ? "Record a note before they arrive" : undefined} />
          ) : (
            <p className="sv-none">
              {v.status === "on_site"
                ? "They are with the host now."
                : v.status === "no_show" || v.status === "lapsed"
                  ? "They did not come."
                  : v.status === "moved"
                    ? "They took another slot."
                    : v.status === "cancelled"
                      ? "They cancelled."
                      : v.status === "blocked"
                        ? "Nothing happens until it is unblocked."
                        : "Recorded here after the visit."}
            </p>
          )}
        </section>
      </div>

      {moving && act.move && (
        <MoveForm v={v} today={today} held={held} onCancel={() => setMoving(false)} onMove={async (d, t) => (await act.move!(v, d, t)) && setMoving(false)} />
      )}

      <div className="sv-open__foot">
        <dl className="ws-meta">
          {!isReal && (
            <div>
              <dt>Visit</dt>
              <dd>
                <code>{v.id}</code>
              </dd>
            </div>
          )}
          <div>
            <dt>Where</dt>
            <dd>{v.place}</dd>
          </div>
          <div>
            <dt>Buyer&rsquo;s number</dt>
            <dd className="tnum ws-meta__num">
              <RevealPhone leadId={v.leadId ?? ""} shown={v.phone} linkClass="ws-link" />
            </dd>
          </div>
        </dl>

        <div className="sv-acts">
          {canHost && act.host && (
            <label className="kb-chip kb-pick sv-hostpick">
              <span className="sr-only">Host</span>
              <select
                value={v.host ?? ""}
                onChange={(e) => e.target.value && act.host?.(v, e.target.value)}
              >
                {!v.host && <option value="">Pick a host</option>}
                {SITE_HOSTS.map((h) => (
                  <option key={h} value={h}>
                    Host: {h}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
          )}
          {canChange && act.cancel && !moving && (
            cancelling ? (
              <>
                <button type="button" className="btn btn--ghost" disabled={held} onClick={() => setCancelling(false)}>
                  Keep it
                </button>
                <button type="button" className="btn btn--ghost btn--danger" disabled={held} onClick={() => act.cancel?.(v)}>
                  Cancel and tell the buyer
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--ghost" disabled={held} onClick={() => setCancelling(true)}>
                Cancel visit
              </button>
            )
          )}
          {canChange && act.move && !moving && !cancelling && v.status !== "blocked" && (
            <button type="button" className="btn btn--ghost" disabled={held} onClick={() => setMoving(true)}>
              Move
            </button>
          )}
          {v.status === "requested" && can.schedule && act.confirm && (
            <button type="button" className="btn btn--ghost" onClick={() => act.confirm?.(v)}>
              They confirmed on the phone
            </button>
          )}
          {canNoShow && (
            <button type="button" className="btn btn--ghost" disabled={held} onClick={() => act.noShow(v)}>
              Mark as no-show
            </button>
          )}
          {v.status === "confirmed" && isToday && can.checkIn && toMin(v.time) - nowMin <= 60 && (
            <button type="button" className="btn btn--ink" disabled={held} onClick={() => act.checkIn(v)}>
              {saving ? "Checking in" : "Check in"}
              <Check size={14} />
            </button>
          )}
          {/* A buyer marked missed who turns up late is still checked in. */}
          {isReal && v.status === "no_show" && isToday && can.checkIn && (
            <button type="button" className="btn btn--ink" disabled={held} onClick={() => act.checkIn(v)}>
              {saving ? "Checking in" : "They came, check in"}
              <Check size={14} />
            </button>
          )}
          {v.status === "on_site" && can.outcome && !recording && !draft && (
            <button type="button" className="btn btn--ink" onClick={() => setRecording(true)}>
              Record how it went
              <ArrowUpRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Moving a real visit: a day, then a half hour in an hour with a host free.
 * Full hours are shown and cannot be picked. The buyer is told on WhatsApp.
 */
function MoveForm({
  v,
  today,
  held,
  onCancel,
  onMove,
}: {
  v: Visit;
  today: string;
  held: boolean;
  onCancel: () => void;
  onMove: (date: string, time: string) => void;
}) {
  const [date, setDate] = useState(v.date >= today ? v.date : today);
  const [hours, setHours] = useState<{ hour: number; free: number }[] | null>(null);
  const [time, setTime] = useState("");

  useEffect(() => {
    let live = true;
    setHours(null);
    setTime("");
    visitHoursAction({ visitId: v.id, day: date })
      .then((h) => live && setHours(h))
      .catch(() => live && setHours([]));
    return () => {
      live = false;
    };
  }, [v.id, date]);

  const nowMin = istMin(new Date().toISOString());
  const slots = (hours ?? []).flatMap((h) =>
    [0, 30]
      .map((m) => ({ time: `${String(h.hour).padStart(2, "0")}:${m ? "30" : "00"}`, free: h.free }))
      .filter((s) => s.time <= "18:30" && (date > today || toMin(s.time) > nowMin)),
  );

  return (
    <form
      className="sv-move"
      onSubmit={(e) => {
        e.preventDefault();
        if (time && !held) onMove(date, time);
      }}
    >
      <label className="sv-move__day">
        <span className="sv-rec__label">Day</span>
        <input type="date" className="sv-select" value={date} min={today} max={addDays(today, 30)} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </label>
      <fieldset className="sv-rec__set">
        <legend>Time</legend>
        {hours === null ? (
          <p className="sv-none">Finding free hours</p>
        ) : slots.length === 0 ? (
          <p className="sv-none">No time left on this day.</p>
        ) : (
          <div className="sv-chips">
            {slots.map((s) => (
              <button
                key={s.time}
                type="button"
                className={`kb-chip tnum${time === s.time ? " is-on" : ""}`}
                aria-pressed={time === s.time}
                disabled={s.free === 0}
                title={s.free === 0 ? "Full" : undefined}
                onClick={() => setTime(s.time)}
              >
                {showTime(s.time)}
              </button>
            ))}
          </div>
        )}
      </fieldset>
      <div className="sv-move__acts">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={held}>
          Back
        </button>
        <button type="submit" className="btn btn--ink" disabled={!time || held}>
          {time ? `Move to ${showTime(time)}` : "Pick a time"}
          <ArrowUpRight size={14} />
        </button>
      </div>
    </form>
  );
}

function Fact({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="ws-fact">
      <dt>{k}</dt>
      <dd className={warn ? "sv-warn" : undefined}>{v}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recording a visit
// ---------------------------------------------------------------------------

function RecordForm({
  v,
  saving,
  held,
  draft,
  onCancel,
  onSave,
}: {
  v: Visit;
  /** A voice note's draft: the form starts from it, and the host confirms or corrects it. */
  draft?: NoteView | null;
  /** This visit is on its way to the server. */
  saving: boolean;
  /** Something on the screen is; wait for it. */
  held: boolean;
  onCancel: () => void;
  onSave: (o: Outcome) => void;
}) {
  const d = draft?.draft ?? null;
  const [interest, setInterest] = useState<Interest | null>((INTERESTS as readonly string[]).includes(d?.interest ?? "") ? (d!.interest as Interest) : null);
  const [objection, setObjection] = useState<Objection | null>((OBJECTIONS as readonly string[]).includes(d?.objection ?? "") ? (d!.objection as Objection) : null);
  const [next, setNext] = useState<string>((NEXT_STEPS as readonly string[]).includes(d?.next ?? "") ? d!.next! : "");
  const [note, setNote] = useState("");
  const ready = interest !== null && objection !== null && next !== "";

  return (
    <form
      className="sv-rec"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || held) return;
        onSave({ interest: interest!, objection: objection!, next, shown: d?.shown.length ? d.shown : v.toShow, note: note.trim() || undefined });
      }}
    >
      {draft && (
        <div className="sv-heard">
          <p className="sv-heard__head">
            {draft.beforeVisit ? "From your note before the visit" : "From your voice note"}{d?.shown.length ? ` · shown ${d.shown.join(", ")}` : ""}
            <a className="ws-link" href={`/dashboard/visits/notes/${draft.id}`} target="_blank" rel="noopener noreferrer">
              Play
            </a>
          </p>
          {draft.transcript && <blockquote className="sv-heard__text">{draft.transcript}</blockquote>}
        </div>
      )}
      <fieldset className="sv-rec__set">
        <legend>Interest</legend>
        <div className="seg" role="group" aria-label="Interest">
          {INTERESTS.map((i) => (
            <button key={i} type="button" className="seg__opt" aria-pressed={interest === i} onClick={() => setInterest(i)}>
              {i}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="sv-rec__set">
        <legend>What held them back</legend>
        <div className="sv-chips">
          {OBJECTIONS.map((o) => (
            <button
              key={o}
              type="button"
              className={`kb-chip${objection === o ? " is-on" : ""}`}
              aria-pressed={objection === o}
              onClick={() => setObjection(o)}
            >
              {o === "None" ? "Nothing" : o}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="sv-rec__set">
        <span className="sv-rec__label">Next step</span>
        <select className="sv-select" value={next} onChange={(e) => setNext(e.target.value)} required>
          <option value="" disabled>
            Pick one
          </option>
          {NEXT_STEPS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="sv-rec__set">
        <span className="sv-rec__label">What they said</span>
        <textarea
          className="sv-text"
          rows={2}
          value={note}
          placeholder="Liked the 12th floor, wants the payment plan"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="sv-rec__acts">
        <button type="button" className="btn btn--ghost" disabled={saving} onClick={onCancel}>
          Not now
        </button>
        <button type="submit" className="btn btn--ink" disabled={!ready || held} aria-busy={saving}>
          {saving ? "Saving" : draft ? "Confirm and save the visit" : "Save the visit"}
          <Check size={14} />
        </button>
      </div>
    </form>
  );
}
