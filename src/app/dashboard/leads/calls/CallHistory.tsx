"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { PageHead } from "@/components/shell/PageHead";
import { SubTabs } from "@/components/shell/SubTabs";
import {
  ArrowUpRight,
  Board,
  ChevronDown,
  Close,
  Download,
  Phone,
  Search,
  Building,
} from "@/components/icons";
import {
  AGENTS,
  GOAL_STATUS,
  LANGUAGE_LABEL,
  verdictOf,
  PERIODS,
  VIEWS,
  agentLabel,
  callMetrics,
  count,
  durationLabel,
  followUpAt,
  inView,
  pickedUp,
  istDate,
  istTime,
  matchesQuery,
  nextLabel,
  pageItems,
  percent,
  periodDays,
  showPhone,
  whenLabel,
  type AgentKind,
  type CallRecord,
  type Turn,
  type Period,
  type View,
} from "@/lib/call-rules";
import { showDate, showTime } from "@/lib/lead-rules";
import { useRouter } from "next/navigation";
import { CallLeadDialog } from "./CallLeadDialog";
import { RevealPhone } from "@/components/RevealPhone";
import { Recording } from "../[id]/Recording";
import { findNumberAction } from "@/app/actions/mask";

const PAGE = 40;

const TABS = [
  { href: "/dashboard/leads", label: "Pipeline", icon: <Board size={15} /> },
  { href: "/dashboard/leads/calls", label: "Calls", icon: <Phone size={15} /> },
];

const TEMP_LABEL = { HOT: "Hot", WARM: "Warm", COLD: "Cold" } as const;
const TEMP_TONE = { HOT: "pill--risk", WARM: "pill--warn", COLD: "pill--blue" } as const;

export function CallHistory({
  today,
  nowIso,
  places,
  developer,
  real,
  phases,
  canCall,
  availability = false,
  canExport = false,
}: {
  today: string;
  nowIso: string;
  places: string[];
  developer: string;
  /** Calls the agent really made. */
  real: CallRecord[];
  /** Towers a call can be about. */
  phases: { id: string; label: string }[];
  canCall: boolean;
  /** Whether this person may read flat availability, which is the third view. */
  availability?: boolean;
  /** Whether this person may export the calls on screen. */
  canExport?: boolean;
}) {
  const all = real;
  const towers = useMemo(
    () => (real.length === 0 ? places : [...new Set(real.map((c) => c.place))]),
    [places, real],
  );

  // While a real call is ringing or talking, look again every ten seconds so
  // its result lands without anybody pressing reload.
  const router = useRouter();
  const anyLive = real.some((c) => c.live);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [anyLive, router]);

  const [period, setPeriod] = useState<Period>("month");
  const [view, setView] = useState<View>("all");
  const [agent, setAgent] = useState<AgentKind | "all">("all");
  const [place, setPlace] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const logRef = useRef<HTMLElement>(null);
  // A whole number typed into the search is answered by the server, which
  // holds the numbers; the browser holds only what this person may see.
  const [numberLeads, setNumberLeads] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const digits = query.replace(/\D/g, "");
    if (real.length === 0 || digits.length < 10) {
      setNumberLeads(null);
      return;
    }
    let live = true;
    findNumberAction(digits).then((ids) => {
      if (live) setNumberLeads(new Set(ids));
    });
    return () => {
      live = false;
    };
  }, [query, real.length]);

  const days = useMemo(() => periodDays(period, today), [period, today]);

  // Period, agent and tower decide what the numbers describe. The view and
  // the search only narrow the list, so the numbers above it hold still
  // while somebody clicks through them.
  const scoped = useMemo(() => {
    const inDays = new Set(days);
    return all.filter(
      (c) =>
        inDays.has(istDate(c.startedAt)) &&
        (agent === "all" || c.agent === agent) &&
        (place === "all" || c.place === place),
    );
  }, [all, days, agent, place]);

  const metrics = useMemo(() => callMetrics(scoped, days, nowIso), [scoped, days, nowIso]);
  const rangOut = useMemo(
    () => scoped.filter((c) => c.outcome === "HANDED_OFF" && c.next.kind === "callback").length,
    [scoped],
  );

  const searched = useMemo(
    () => scoped.filter((c) => matchesQuery(c, query, numberLeads)),
    [scoped, query, numberLeads],
  );
  const viewCounts = useMemo(() => {
    const out = {} as Record<View, number>;
    for (const v of VIEWS) out[v.key] = searched.filter((c) => inView(c, v.key)).length;
    return out;
  }, [searched]);

  const rows = useMemo(() => {
    const list = searched.filter((c) => inView(c, view));
    // Follow-ups are a queue, so they read in the order they fall due, the
    // most overdue first. Everything else reads newest first.
    if (view === "followup") {
      return [...list].sort(
        (x, y) => Date.parse(followUpAt(x) ?? x.startedAt) - Date.parse(followUpAt(y) ?? y.startedAt),
      );
    }
    return list;
  }, [searched, view]);

  const filtered = view !== "all" || agent !== "all" || place !== "all" || query.trim() !== "";
  const noun = PERIODS.find((p) => p.key === period)?.noun ?? "";

  // Anything that changes the list starts it from the top again.
  useEffect(() => {
    setPage(1);
  }, [period, view, agent, place, query]);

  // Escape folds the open call and hands focus back to the row it came from.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const id = openId;
      setOpenId(null);
      document.getElementById(`call-btn-${id}`)?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId]);

  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  const pickView = (v: View) => setView((cur) => (cur === v && v !== "all" ? "all" : v));
  const clear = () => {
    setView("all");
    setAgent("all");
    setPlace("all");
    setQuery("");
  };

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages);
  const first = (current - 1) * PAGE;
  const shown = rows.slice(first, first + PAGE);

  // A new page starts closed and at the top of the log, not wherever the
  // last page was scrolled to.
  const goTo = (n: number) => {
    setPage(n);
    setOpenId(null);
    logRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="ch">
      <PageHead
        title={
          <>
            Call <span className="em">history</span>
          </>
        }
        meta="Every call the AI agent made."
        action={
          canCall && phases.length > 0 ? (
            <>
              <Link href="/dashboard/leads/calls/lists" className="btn btn--ghost">
                Call from a list
              </Link>
              <CallLeadDialog phases={phases} developer={developer} />
            </>
          ) : undefined
        }
      />

      <SubTabs
        label="Leads views"
        current="/dashboard/leads/calls"
        items={availability ? [...TABS, { href: "/dashboard/leads/availability", label: "Availability", icon: <Building size={15} /> }] : TABS}
        end={
          <div className="seg" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                className="seg__opt"
                aria-pressed={period === p.key}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      {/* ---------------------------------------------------------------- */}
      <section className="ch-strip" aria-label={`Calls ${noun}`}>
        <div className="ch-stats">
          <div className="ch-stat ch-stat--wide">
            <div className="ch-stat__body">
              <p className="ch-stat__label">Calls {noun}</p>
              <p className="ch-stat__num tnum">{count(metrics.total)}</p>
              <p className="ch-stat__sub">
                {metrics.avgTalk === null
                  ? "No conversations yet"
                  : `Average call ${durationLabel(metrics.avgTalk)}`}
              </p>
            </div>
            <Spark calls={scoped} period={period} days={days} nowIso={nowIso} />
          </div>

          <button
            type="button"
            className="ch-stat ch-stat--link"
            aria-pressed={view === "picked"}
            onClick={() => pickView("picked")}
          >
            <span className="ch-stat__body">
              <span className="ch-stat__label">Pickup rate</span>
              <span className="ch-stat__num tnum">{percent(metrics.pickup)}</span>
              <span className="ch-stat__sub">
                {count(metrics.connected)} of {count(metrics.total)} picked up
              </span>
            </span>
            <ArrowUpRight size={14} className="ch-stat__go" />
          </button>

          <button
            type="button"
            className="ch-stat ch-stat--link"
            aria-pressed={view === "qualified"}
            onClick={() => pickView("qualified")}
          >
            <span className="ch-stat__body">
              <span className="ch-stat__label">Hot or warm</span>
              <span className="ch-stat__num tnum">{count(metrics.qualified)}</span>
              <span className="ch-stat__sub">
                {metrics.connected
                  ? `${percent(metrics.qualified / metrics.connected)} of picked-up calls`
                  : "None yet"}
              </span>
            </span>
            <ArrowUpRight size={14} className="ch-stat__go" />
          </button>

          <button
            type="button"
            className="ch-stat ch-stat--link"
            aria-pressed={view === "handed"}
            onClick={() => pickView("handed")}
          >
            <span className="ch-stat__body">
              <span className="ch-stat__label">Handed to sales</span>
              <span className="ch-stat__num tnum">{count(metrics.handed)}</span>
              <span className="ch-stat__sub">
                {rangOut ? `Sales missed ${rangOut}, calling back` : metrics.handed ? "Sales picked up all" : "None yet"}
              </span>
            </span>
            <ArrowUpRight size={14} className="ch-stat__go" />
          </button>
        </div>

        <button
          type="button"
          className="ch-due"
          aria-pressed={view === "followup"}
          onClick={() => pickView("followup")}
        >
          <span className="ch-due__label">Follow-ups due</span>
          <span className="ch-due__num tnum">{count(metrics.followUps)}</span>
          <span className="ch-due__foot">
            <span className="ch-due__sub">
              {metrics.overdue ? (
                <>
                  <span className="ch-due__dot" aria-hidden />
                  {metrics.overdue} overdue
                </>
              ) : (
                "Nothing overdue"
              )}
            </span>
            <span className="ch-due__cta">
              {view === "followup" ? "Showing them" : "Show them"}
              <ArrowUpRight size={13} />
            </span>
          </span>
        </button>
      </section>

      {/* ---------------------------------------------------------------- */}
      <div className="kb-tools ch-tools" role="group" aria-label="Filter calls">
        <label className="kb-search">
          <Search size={15} />
          <span className="sr-only">Search calls</span>
          <input
            type="search"
            placeholder="Name, number or tower"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <label className={`kb-chip kb-pick${view !== "all" ? " is-on" : ""}`}>
          <span className="sr-only">Show</span>
          <select value={view} onChange={(e) => setView(e.target.value as View)}>
            {VIEWS.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label} ({count(viewCounts[v.key])})
              </option>
            ))}
          </select>
          <ChevronDown size={12} />
        </label>

        <label className={`kb-chip kb-pick${agent !== "all" ? " is-on" : ""}`}>
          <span className="sr-only">Agent</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind | "all")}>
            <option value="all">All agents</option>
            {AGENTS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
          <ChevronDown size={12} />
        </label>

        {towers.length > 1 && (
          <label className={`kb-chip kb-pick${place !== "all" ? " is-on" : ""}`}>
            <span className="sr-only">Tower</span>
            <select value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="all">All towers</option>
              {towers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
        )}

        {(filtered || canExport) && (
          <div className="kb-tools__end">
            {filtered && (
              <button type="button" className="kb-clear" onClick={clear}>
                <Close size={12} />
                Clear filters
              </button>
            )}
            {canExport && (
              // The calls on screen after the filters, every page of them, in
              // this order. The server reads them again inside its own scope.
              <form method="post" action="/dashboard/leads/calls/export" className="ch-export">
                <input type="hidden" name="ids" value={JSON.stringify(rows.map((c) => c.id))} />
                <span className="ch-export__label">
                  <Download size={14} />
                  Export {count(rows.length)} {rows.length === 1 ? "call" : "calls"}
                </span>
                <button type="submit" name="format" value="xlsx" className="kb-chip" disabled={rows.length === 0}>
                  Excel
                </button>
                <button type="submit" name="format" value="csv" className="kb-chip" disabled={rows.length === 0}>
                  CSV
                </button>
              </form>
            )}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      <section className="card ch-log" aria-label="Calls" ref={logRef}>

        {rows.length === 0 ? (
          <div className="empty ch-empty">
            <span className="empty__mark" aria-hidden>
              <Phone size={20} />
            </span>
            {all.length === 0 ? (
              <p>No calls yet. Calls appear here as the agents make them.</p>
            ) : (
              <>
                <p>No calls match these filters {noun}.</p>
                <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
                  Clear filters
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="ch-scroll">
            <table className="ch-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Lead</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="ch-num">
                    Length
                  </th>
                  <th scope="col">Next step</th>
                  <th scope="col" className="ch-chev">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const open = openId === c.id;
                  const w = whenLabel(c.startedAt, today);
                  const o = verdictOf(c);
                  const next = nextLabel(c, today, nowIso);
                  const missed = !pickedUp(c);
                  return (
                    <Fragment key={c.id}>
                      <tr className={`ch-row${open ? " is-open" : ""}`} onClick={() => toggle(c.id)}>
                        <td className="ch-when">
                          <span className="ch-when__t tnum">{w.time}</span>
                          <span className="ch-sub">{w.day}</span>
                        </td>
                        <td className="ch-lead">
                          <button
                            type="button"
                            id={`call-btn-${c.id}`}
                            className="ch-lead__name"
                            aria-expanded={open}
                            aria-controls={`call-${c.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(c.id);
                            }}
                          >
                            {c.leadName}
                          </button>
                          <span className="ch-sub">
                            {c.place}
                            {c.phone.text && (
                              <>
                                {" "}
                                · <span className="tnum">{c.phone.text}</span>
                              </>
                            )}
                          </span>
                        </td>
                        <td className="ch-agent">
                          <span>{agentLabel(c.agent)}</span>
                          <span className="ch-sub">
                            {missed ? `Try ${c.attempt} of ${c.maxAttempts}` : LANGUAGE_LABEL[c.language]}
                          </span>
                        </td>
                        <td className="ch-out">
                          <span className={`pill pill--${o.tone}`}>
                            <span className="pill__dot" />
                            {o.label}
                          </span>
                        </td>
                        <td className={`ch-num tnum${missed ? " is-none" : ""}`}>
                          {durationLabel(c.duration)}
                        </td>
                        <td className={`ch-next ch-next--${next.tone}`}>{next.text}</td>
                        <td className="ch-chev" aria-hidden>
                          <ChevronDown size={14} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="ch-detailrow">
                          <td colSpan={7}>
                            <CallDetail
                              call={c}
                              today={today}
                              nowIso={nowIso}
                              leadHref={`/dashboard/leads/${c.leadId}`}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 && (
          <div className="ch-foot">
            <p className="ch-sub tnum">
              {rows.length === 1
                ? "1 call"
                : `${count(first + 1)} to ${count(first + shown.length)} of ${count(rows.length)} calls`}
            </p>
            {pages > 1 && (
              <nav className="pager" aria-label="Pages">
                <button
                  type="button"
                  className="pager__step"
                  disabled={current === 1}
                  aria-label="Previous page"
                  onClick={() => goTo(current - 1)}
                >
                  <ChevronDown size={12} className="pager__prev" />
                  <span className="pager__label">Previous</span>
                </button>
                {pageItems(current, pages).map((n, i) =>
                  n === "gap" ? (
                    <span key={`gap-${i}`} className="pager__gap" aria-hidden>
                      ...
                    </span>
                  ) : (
                    <button
                      key={n}
                      type="button"
                      className="pager__num tnum"
                      aria-current={n === current ? "page" : undefined}
                      aria-label={`Page ${n}`}
                      onClick={() => goTo(n)}
                    >
                      {n}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  className="pager__step"
                  disabled={current === pages}
                  aria-label="Next page"
                  onClick={() => goTo(current + 1)}
                >
                  <span className="pager__label">Next</span>
                  <ChevronDown size={12} className="pager__next" />
                </button>
              </nav>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calls per day, today's column lit
// ---------------------------------------------------------------------------

function Spark({
  calls,
  period,
  days,
  nowIso,
}: {
  calls: CallRecord[];
  period: Period;
  days: string[];
  nowIso: string;
}) {
  // A single day reads by the hour across the calling window instead, or the
  // chart would be one bar.
  const bars = useMemo(() => {
    if (period !== "today") {
      const by = new Map<string, number>();
      for (const c of calls) by.set(istDate(c.startedAt), (by.get(istDate(c.startedAt)) ?? 0) + 1);
      return days.map((d) => ({ key: d, n: by.get(d) ?? 0 }));
    }
    const hours = Array.from({ length: 11 }, (_, i) => 10 + i);
    const by = new Map<number, number>();
    for (const c of calls) {
      const h = Number(istTime(c.startedAt).slice(0, 2));
      by.set(h, (by.get(h) ?? 0) + 1);
    }
    const nowHour = Number(istTime(nowIso).slice(0, 2));
    return hours.filter((h) => h <= Math.max(nowHour, 10)).map((h) => ({ key: String(h), n: by.get(h) ?? 0 }));
  }, [calls, period, days, nowIso]);

  const max = Math.max(1, ...bars.map((b) => b.n));
  return (
    <span className={`ch-spark ch-spark--${bars.length > 12 ? "many" : "few"}`} aria-hidden>
      {bars.map((b, i) => (
        <span
          key={b.key}
          className={`ch-spark__bar${i === bars.length - 1 ? " is-now" : ""}`}
          style={{ height: `${Math.max(6, (b.n / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One call, unfolded
// ---------------------------------------------------------------------------

const MISSED_LINE = {
  NO_ANSWER: "The phone rang and nobody picked up.",
  BUSY: "The line was busy.",
  DECLINED: "The phone rang and they cut the call.",
  SCREENED: "The phone's call screener answered and the person did not come on.",
  NO_REPLY: "Someone picked up, but the agent heard nobody speak.",
  NOT_IN_SERVICE: "The number is not in service.",
  SWITCHED_OFF: "The phone was switched off or out of coverage.",
  FAILED: "The call did not go through.",
  NOT_PLACED: "The call was not placed.",
} as const;

function CallDetail({
  call: c,
  today,
  nowIso,
  leadHref,
}: {
  call: CallRecord;
  today: string;
  nowIso: string;
  /** The lead's own page. Null for a sample call, which has none. */
  leadHref: string | null;
}) {
  const connected = c.connectivity === "connected";
  const said = c.facts.filter((f) => f.value !== null).length;
  const next = nextLabel(c, today, nowIso);
  const ref = useRef<HTMLDivElement>(null);

  // A row near the bottom of the window unfolds out of sight; bring the top
  // of it into view, and no further.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  return (
    <div className="ch-open" id={`call-${c.id}`} ref={ref}>
      {c.goal && (
        <section className="ch-sec ch-goal">
          <div className="ch-sec__head">
            <h3>The goal</h3>
            {c.goal.status && (
              <span className={`pill pill--${GOAL_STATUS[c.goal.status].tone}`}>
                <span className="pill__dot" />
                {GOAL_STATUS[c.goal.status].label}
              </span>
            )}
          </div>
          <p className="ch-summary">{c.goal.text}</p>
          {c.goal.note && <p className="ch-goal__note">{c.goal.note}</p>}
        </section>
      )}
      {connected ? (
        <div className="ch-open__grid">
          <div className="ch-open__read">
            <section className="ch-sec">
              <h3>What it was about</h3>
              <p className="ch-summary">{c.summary ?? "The agent left no summary for this call."}</p>
              {c.keyPoints.length > 0 && (
                <ul className="ch-points">
                  {c.keyPoints.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </section>

            {c.facts.length > 0 && (
              <section className="ch-sec">
                <div className="ch-sec__head">
                  <h3>{c.agent === "qualifier" || c.agent === "goal" ? "What they told us" : "The visit"}</h3>
                  {(c.agent === "qualifier" || c.agent === "goal") && (
                    <span className="ch-sub tnum">
                      {said} of {c.facts.length} answered
                    </span>
                  )}
                  {c.temp && (
                    <span className={`pill ${TEMP_TONE[c.temp]}`}>{TEMP_LABEL[c.temp]} lead</span>
                  )}
                </div>
                <dl className="ch-facts">
                  {c.facts.map((f) => (
                    <div key={f.label} className="ch-fact">
                      <dt>{f.label}</dt>
                      <dd className={f.value === null ? "is-unsaid" : undefined}>{f.value ?? "Not said"}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>

          <div className="ch-open__listen">
            <div className="ch-rec-wrap">
              <Recording url={c.recordingUrl} duration={c.duration ?? 0} />
              {!c.recordingUrl && <p className="ch-rec__none">No recording for this call.</p>}
            </div>
            <Transcript call={c} />
          </div>
        </div>
      ) : (
        <div className="ch-missed">
          <p>
            {c.outcome === "NO_REPORT"
              ? "The result has not come back yet. It is fetched again when this page opens, so check back in a minute."
              : `${MISSED_LINE[c.outcome as keyof typeof MISSED_LINE] ?? "Nobody picked up."} ${next.text}.`}
          </p>
        </div>
      )}

      <dl className="ch-meta">
        {leadHref && (
          <div>
            <dt>Lead</dt>
            <dd>
              <Link href={leadHref} className="ch-link">
                {c.leadName}
              </Link>
            </dd>
          </div>
        )}
        <div>
          <dt>Started</dt>
          <dd className="tnum">
            {showDate(istDate(c.startedAt))}, {showTime(istTime(c.startedAt))}
          </dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd className="tnum">{connected ? durationLabel(c.duration) : "Not connected"}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>
            {agentLabel(c.agent)}, version {c.agentVersion}
          </dd>
        </div>
        <div>
          <dt>Try</dt>
          <dd className="tnum">
            {c.attempt} of {c.maxAttempts}
          </dd>
        </div>
        <div>
          <dt>Lead&rsquo;s number</dt>
          <dd className="tnum ch-meta__num">
            <RevealPhone leadId={c.leadId} shown={c.phone} linkClass="ch-link" />
          </dd>
        </div>
        <div>
          <dt>Called from</dt>
          <dd className="tnum">{showPhone(c.from)}</dd>
        </div>
        <div>
          <dt>Call ID</dt>
          <dd>
            <code>{c.id}</code>
          </dd>
        </div>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

function Transcript({ call: c }: { call: CallRecord }) {
  // The list leaves the turns out; they are fetched when the call is opened.
  const [loaded, setLoaded] = useState<Turn[] | null>(c.transcriptLater ? null : c.transcript);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!c.transcriptLater) {
      setLoaded(c.transcript);
      return;
    }
    let live = true;
    setLoaded(null);
    setFailed(false);
    fetch(`/dashboard/leads/calls/transcript/${encodeURIComponent(c.id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { turns: Turn[] | null }) => {
        if (live) setLoaded(j.turns ?? []);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [c.id, c.transcriptLater, c.transcript]);
  const turns = loaded ?? [];
  const hasOriginal = turns.some((t) => t.role !== "event" && t.indic);
  const [show, setShow] = useState<"original" | "en">("original");
  const lang = hasOriginal ? show : "en";
  const first = c.leadName.split(" ")[0];

  return (
    <section className="ch-tx" aria-label="Transcript">
      <div className="ch-sec__head">
        <h3>Transcript</h3>
        {hasOriginal && (
          <div className="seg seg--sm" role="group" aria-label="Transcript language">
            <button
              type="button"
              className="seg__opt"
              aria-pressed={lang === "original"}
              onClick={() => setShow("original")}
            >
              {LANGUAGE_LABEL[c.language]}
            </button>
            <button
              type="button"
              className="seg__opt"
              aria-pressed={lang === "en"}
              onClick={() => setShow("en")}
            >
              English
            </button>
          </div>
        )}
      </div>
      {loaded === null && (
        <p className="ch-rec__none" role="status">
          {failed ? "The transcript could not be loaded. Open the call again." : "Loading the transcript"}
        </p>
      )}
      {loaded !== null && turns.length === 0 && <p className="ch-rec__none">No transcript for this call.</p>}
      {turns.length > 0 && (
      <ol className="ch-tx__list" tabIndex={0} aria-label="Conversation, turn by turn">
        {turns.map((t, i) =>
          t.role === "event" ? (
            <li key={i} className="ch-tx__event">
              <span>{t.en}</span>
            </li>
          ) : (
            <li key={i} className={`ch-tx__turn ch-tx__turn--${t.role}`}>
              <span className="ch-tx__who">{t.role === "agent" ? "Agent" : first}</span>
              <p lang={lang === "original" && t.indic ? c.language : "en"}>
                {lang === "original" && t.indic ? t.indic : t.en}
              </p>
            </li>
          ),
        )}
      </ol>
      )}
    </section>
  );
}
