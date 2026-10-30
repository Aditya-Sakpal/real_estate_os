"use client";

import { Fragment, useMemo, useState } from "react";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight, ChevronDown } from "@/components/icons";
import { rupees, rupeesShort, showDate } from "@/lib/lead-rules";
import {
  GROUPS,
  apportion,
  costPer,
  DIMS,
  quarterCheck,
  RANK_FLOOR,
  SOURCES,
  STILL_BOOKING,
  biggestDrop,
  cancelRate,
  costPerBooking,
  count,
  funnel,
  matured,
  percent,
  rankable,
  rollup,
  total,
  type Counts,
  type Dim,
  type Group,
  type Source,
} from "@/lib/report-rules";
import { HOST_SHARE, landed, mondayOf, sampleReport, type ReportData, type Row } from "@/lib/report-sample";
import "./rollups.css";

type PeriodKey = "4" | "13" | "fy";

/** The first Monday of the Indian financial year this date falls in. */
function fyStart(today: string): { from: string; label: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, label: `FY ${start}-${String(start + 1).slice(2)}` };
}

const GROUP_TONE: Record<Group, string> = {
  partner: "rp-c--pink",
  digital: "rp-c--blue",
  portal: "rp-c--green",
  other: "rp-c--other",
};

const short = (iso: string) => showDate(iso).slice(4);

/** "Meta ads, Google Ads and 99acres". */
function listOf(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function ReportView({ today, projects, real }: { today: string; projects: string[]; real?: ReportData }) {
  const data = useMemo(() => real ?? sampleReport({ today, projects }), [real, today, projects]);
  const isReal = !!real;
  const fy = fyStart(today);
  const weeksInFy = data.weeks.filter((w) => w >= mondayOf(fy.from)).length;

  const [period, setPeriod] = useState<PeriodKey>("13");
  const [project, setProject] = useState<string>("all");
  const n = period === "4" ? 4 : period === "13" ? 13 : weeksInFy;
  const periodLabel = period === "fy" ? fy.label : `last ${n} weeks`;

  const inProject = (r: Row) => project === "all" || r.project === project;
  const nowWeeks = data.weeks.slice(-n);
  const beforeWeeks = data.weeks.slice(-2 * n, -n);
  const rows = useMemo(() => data.rows.filter((r) => inProject(r) && nowWeeks.includes(r.week)), [data, project, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const before = useMemo(() => data.rows.filter((r) => inProject(r) && beforeWeeks.includes(r.week)), [data, project, n]); // eslint-disable-line react-hooks/exhaustive-deps

  const bySource = (list: Row[]) => {
    const out = new Map<string, Counts>();
    for (const s of SOURCES) out.set(s.key, total(list.filter((r) => r.source === s.key).map((r) => r.counts)));
    return out;
  };
  const src = useMemo(() => bySource(rows), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const srcBefore = useMemo(() => bySource(before), [before]); // eslint-disable-line react-hooks/exhaustive-deps

  const media = SOURCES.filter((s) => s.paid === "media");
  const mediaNow = total(media.map((s) => src.get(s.key)!));
  const mediaBefore = total(media.map((s) => srcBefore.get(s.key)!));
  const steps = funnel(mediaNow, mediaNow.spend);
  const drop = biggestDrop(steps);
  const cpb = costPerBooking(mediaNow, "media");
  const cpbBefore = costPerBooking(mediaBefore, "media");
  const cpCost = costPerBooking(src.get("cp")!, "commission");
  const all = total([...src.values()]);
  const cancelled = cancelRate(all);
  // Only real figures can be empty: a period nobody enquired in.
  const empty = all.leads === 0;
  // The lead-week chart spans thirteen weeks whatever the period, so it can
  // still have something to say when the period itself is empty.
  const cohortLeads =
    empty && data.rows.some((r) => inProject(r) && r.counts.leads > 0 && data.weeks.slice(-13).includes(r.week));
  const mediaNames = isReal
    ? listOf(media.filter((s) => src.get(s.key)!.leads || src.get(s.key)!.spend).map((s) => s.label)) || "No paid media"
    : "Meta, Google and three portals";

  return (
    <div className="rp">
      <PageHead
        title={
          <>
            What a booking <span className="em">costs</span>
          </>
        }
        meta={
          isReal ? (
            <>
              <span className="tnum">{count(all.leads)}</span> {all.leads === 1 ? "lead" : "leads"}, {periodLabel}
            </>
          ) : (
            <>
              <span className="pill pill--warn" style={{ marginRight: 8 }}>
                <span className="pill__dot" />
                Sample data
              </span>
              These figures are invented.
            </>
          )
        }
        action={
          <div className="rp-controls">
            {projects.length > 1 && (
              <label className={`kb-chip kb-pick${project !== "all" ? " is-on" : ""}`}>
                <span className="sr-only">Project</span>
                <select value={project} onChange={(e) => setProject(e.target.value)}>
                  <option value="all">All projects</option>
                  {projects.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} />
              </label>
            )}
            <div className="seg" role="group" aria-label="Period">
              {(
                [
                  ["4", "4 weeks"],
                  ["13", "13 weeks"],
                  ["fy", fy.label],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" className="seg__opt" aria-pressed={period === k} onClick={() => setPeriod(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {empty ? (
        <section className="card" style={{ marginBottom: 14 }}>
          <div className="empty" style={{ padding: "34px 20px" }}>
            <p>No leads in this period.</p>
            {mediaNow.spend > 0 && (
              <p style={{ marginTop: 4 }}>
                <span className="tnum">{rupeesShort(mediaNow.spend)}</span> spent on ads.
              </p>
            )}
          </div>
        </section>
      ) : (
        <>
          {/* --- the funnel, priced ------------------------------------------ */}
          <section className="rp-top">
            <div className="card rp-ladder">
              <div className="card__head">
                <h2>Paid media, from spend to agreement</h2>
                <span className="ws-sub">
                  {mediaNames} · {periodLabel}
                </span>
              </div>

              {mediaNow.leads === 0 && mediaNow.spend === 0 ? (
                <div className="empty" style={{ padding: "26px 20px" }}>
                  No leads from paid media in this period.
                </div>
              ) : (
                <>
                  <ol className="rp-steps">
                    <li className="rp-step rp-step--spend">
                      <span className="rp-step__label">Spent</span>
                      <span className="rp-step__num">{mediaNow.spend > 0 ? rupeesShort(mediaNow.spend) : "None"}</span>
                      <span className="rp-step__cost">
                        {mediaNow.spend > 0 ? `${rupeesShort(mediaNow.spend / Math.max(1, n))} a week` : "None recorded"}
                      </span>
                      <span className="rp-step__bar rp-step__bar--spend" aria-hidden>
                        <span style={{ width: "100%" }} />
                      </span>
                    </li>
                    {steps.map((s) => (
                      <li key={s.key} className={`rp-step${s.key === "booked" ? " is-key" : ""}`}>
                        {s.rate !== null && (
                          <span
                            className={`rp-conv${s.key === drop ? " is-drop" : ""}`}
                            title={`${percent(s.rate)} of the step before`}
                          >
                            <span className="rp-conv__pct tnum">{percent(s.rate)}</span>
                            {s.key === drop && <span className="rp-conv__tag">Biggest drop</span>}
                            <span className="sr-only">of the step before</span>
                          </span>
                        )}
                        <span className="rp-step__label">{s.label}</span>
                        <span className="rp-step__num tnum">{count(s.count)}</span>
                        <span className="rp-step__cost">
                          {s.costPer !== null ? `${rupeesShort(s.costPer)} each` : mediaNow.spend > 0 ? "None yet" : "No spend"}
                        </span>
                        <span className="rp-step__bar" aria-hidden>
                          <span style={{ width: `${steps[0].count ? Math.max(1.5, (s.count / steps[0].count) * 100) : 0}%` }} />
                        </span>
                      </li>
                    ))}
                  </ol>

                  <p className="rp-ladder__foot">
                    {!isReal && (
                      <span>
                        First reply in <strong className="tnum">41 s</strong>, median
                      </span>
                    )}
                    {steps[0].count > 0 && (
                      <span>
                        <strong className="tnum">{percent(steps[4].count / steps[0].count, 1)}</strong> of leads booked
                      </span>
                    )}
                    {cancelled !== null && (
                      <span>
                        <strong className="tnum">{percent(cancelled)}</strong> of bookings cancelled
                      </span>
                    )}
                  </p>
                </>
              )}
            </div>

            <aside className="ws-dark rp-hero" aria-label="Cost per booking">
              <span className="ws-dark__label">Cost per booking, paid media</span>
              <span className="rp-hero__num">
                {cpb !== null ? rupees(cpb) : mediaNow.booked > 0 ? "No spend recorded" : "No bookings"}
              </span>
              <span
                className={`rp-hero__delta${cpb !== null && cpbBefore !== null ? (cpb <= cpbBefore ? " is-down" : " is-up") : ""}`}
              >
                {cpb !== null && cpbBefore !== null
                  ? cpb <= cpbBefore
                    ? `${rupees(cpbBefore - cpb)} less than the ${n} weeks before`
                    : `${rupees(cpb - cpbBefore)} more than the ${n} weeks before`
                  : "Nothing to compare with yet"}
              </span>
              {(!isReal || cpCost !== null) && (
                <span className="rp-hero__vs">
                  A partner booking costs <strong>{cpCost === null ? "nothing yet" : rupeesShort(cpCost)}</strong> in
                  commission
                </span>
              )}
              <span className="ws-dark__foot">
                <span className="ws-dark__sub">
                  {count(mediaNow.booked)} {mediaNow.booked === 1 ? "booking" : "bookings"}
                  {mediaNow.spend > 0 ? ` from ${rupeesShort(mediaNow.spend)}` : ""}
                </span>
                <a className="ws-dark__cta" href="#rp-sources">
                  By source
                  <ArrowUpRight size={13} />
                </a>
              </span>
            </aside>
          </section>

          {/* --- by source ----------------------------------------------------- */}
          <section className="rp-mid">
            <SourceTable src={src} />
            <Mix src={src} />
          </section>
        </>
      )}

      {(!empty || cohortLeads) && (
        <section className="rp-low" style={isReal ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
          <Cohorts data={data} project={project} real={isReal} />
          {/* The closing managers' split is invented; real visits carry no host yet. */}
          {!isReal && <Hosts visited={all.visited} booked={all.booked} />}
        </section>
      )}

      {!empty && <Rollups rows={rows} />}
      <QuarterCheck rows={data.rows.filter(inProject)} today={today} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// By source: what each one cost, in the money it costs
// ---------------------------------------------------------------------------

function SourceTable({ src }: { src: Map<string, Counts> }) {
  const cost = (s: Source) => costPerBooking(src.get(s.key)!, s.paid);
  // A source with no leads and no money in the period is a row of zeros.
  const used = (s: Source) => {
    const c = src.get(s.key)!;
    return c.leads > 0 || c.spend > 0 || c.commission > 0;
  };
  const media = SOURCES.filter((s) => s.paid === "media" && used(s)).sort((a, b) => {
    const ra = rankable(src.get(a.key)!);
    const rb = rankable(src.get(b.key)!);
    if (ra !== rb) return ra ? -1 : 1;
    return (cost(a) ?? Infinity) - (cost(b) ?? Infinity);
  });
  const partner = SOURCES.filter((s) => s.paid === "commission" && used(s));
  const free = SOURCES.filter((s) => s.paid === "none" && used(s));
  const max = Math.max(1, ...SOURCES.map((s) => cost(s) ?? 0));

  const row = (s: Source) => {
    const c = src.get(s.key)!;
    const cpb = cost(s);
    const ranked = rankable(c);
    const money = s.paid === "media" ? c.spend : s.paid === "commission" ? c.commission : 0;
    return (
      <tr key={s.key}>
        <th scope="row" className="rp-src">
          <span className={`rp-dot ${GROUP_TONE[s.group]}`} aria-hidden />
          {s.label}
        </th>
        <td className="ws-num tnum" data-label="Spent">
          {money ? rupeesShort(money) : <span className="rp-none">None</span>}
          {s.paid === "commission" && money > 0 && <span className="ws-sub">commission</span>}
        </td>
        <td className="ws-num tnum" data-label="Leads">{count(c.leads)}</td>
        <td className="ws-num tnum rp-c-hide">
          {s.paid === "media" && c.leads && c.spend ? rupees(c.spend / c.leads) : <span className="rp-none">None</span>}
        </td>
        <td className="ws-num tnum" data-label="Visits">{count(c.visited)}</td>
        <td className="ws-num tnum rp-strong" data-label="Bookings">{count(c.booked)}</td>
        <td className="rp-barcell rp-c-key">
          {cpb === null ? (
            <span className="rp-none">
              {s.paid === "none" ? "No spend" : c.booked === 0 ? "No bookings" : "No spend recorded"}
            </span>
          ) : (
            <span className="rp-bar">
              <span className="rp-bar__track" aria-hidden>
                <span className={`rp-bar__fill ${GROUP_TONE[s.group]}${ranked ? "" : " is-thin"}`} style={{ width: `${(cpb / max) * 100}%` }} />
              </span>
              <span className="rp-bar__v tnum">{rupeesShort(cpb)}</span>
              {!ranked && <span className="pill pill--quiet">Too few to rank</span>}
            </span>
          )}
        </td>
        <td className="ws-num tnum rp-c-hide">{c.leads ? percent(c.booked / c.leads, 1) : <span className="rp-none">None</span>}</td>
      </tr>
    );
  };

  return (
    <div className="card rp-sources" id="rp-sources">
      <div className="card__head">
        <h2>
          By <span className="em">source</span>
        </h2>
        <span className="ws-sub">Cheapest booking first</span>
      </div>
      <div className="ws-scroll">
        <table className="ws-table rp-table rp-stack">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col" className="ws-num">Spent</th>
              <th scope="col" className="ws-num">Leads</th>
              <th scope="col" className="ws-num">Per lead</th>
              <th scope="col" className="ws-num">Visits</th>
              <th scope="col" className="ws-num">Bookings</th>
              <th scope="col">Per booking</th>
              <th scope="col" className="ws-num">Lead to booking</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Paid media", media],
                ["Paid on booking", partner],
                ["No spend", free],
              ] as const
            ).map(([label, list]) =>
              list.length ? (
                <Fragment key={label}>
                  <tr className="rp-grp">
                    <th scope="rowgroup" colSpan={8}>
                      {label}
                    </th>
                  </tr>
                  {list.map(row)}
                </Fragment>
              ) : null,
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where the bookings came from
// ---------------------------------------------------------------------------

function Mix({ src }: { src: Map<string, Counts> }) {
  const by = GROUPS.map((g) => ({
    ...g,
    n: SOURCES.filter((s) => s.group === g.key).reduce((t, s) => t + src.get(s.key)!.booked, 0),
  }));
  const sum = by.reduce((t, g) => t + g.n, 0);
  const R = 54;
  const C = 2 * Math.PI * R;
  const GAP = 2.5;
  let at = 0;

  return (
    <div className="card rp-mix">
      <div className="card__head">
        <h2>Where bookings came from</h2>
      </div>
      <div className="rp-mix__body">
        <svg className="rp-donut" viewBox="0 0 140 140" role="img" aria-label={by.map((g) => `${g.label} ${g.n}`).join(", ")}>
          <defs>
            <pattern id="rp-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="#eceef2" />
              <line x1="0" y1="0" x2="0" y2="5" stroke="#9aa0ab" strokeWidth="2" />
            </pattern>
          </defs>
          <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-sunk)" strokeWidth="18" />
          {sum > 0 &&
            by.map((g) => {
              const len = (g.n / sum) * C;
              const seg = Math.max(0, len - GAP);
              const el = (
                <circle
                  key={g.key}
                  cx="70"
                  cy="70"
                  r={R}
                  fill="none"
                  className={`rp-arc ${GROUP_TONE[g.key]}`}
                  stroke={g.key === "other" ? "url(#rp-hatch)" : undefined}
                  strokeWidth="18"
                  strokeDasharray={`${seg} ${C - seg}`}
                  strokeDashoffset={-at}
                  transform="rotate(-90 70 70)"
                />
              );
              at += len;
              return el;
            })}
          <text x="70" y="68" textAnchor="middle" className="rp-donut__n">
            {sum}
          </text>
          <text x="70" y="86" textAnchor="middle" className="rp-donut__l">
            bookings
          </text>
        </svg>
        <ul className="rp-legend">
          {by.map((g) => (
            <li key={g.key}>
              <span className={`rp-dot ${GROUP_TONE[g.key]}`} aria-hidden />
              <span className="rp-legend__label">{g.label}</span>
              <span className="rp-legend__n tnum">{g.n}</span>
              <span className="rp-legend__pct tnum">{sum ? percent(g.n / sum) : "None"}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookings arrive late: the last thirteen lead weeks
// ---------------------------------------------------------------------------

function Cohorts({ data, project, real }: { data: ReportData; project: string; real: boolean }) {
  const [asTable, setAsTable] = useState(false);
  const cols = data.cohorts.slice(-13).map((c, i, arr) => {
    const ago = arr.length - 1 - i;
    const m = matured(ago);
    if (real) {
      // Real weeks are counted per project rather than shared out: what the
      // week's leads have booked, grossed up by how far through its booking
      // window the week is, and left as counted while too young to say.
      const mine = data.rows.filter((r) => r.week === c.week && (project === "all" || r.project === project));
      const leads = mine.reduce((t, r) => t + r.counts.leads, 0);
      const got = mine.reduce((t, r) => t + r.counts.booked, 0);
      return { week: c.week, ago, leads, got, expect: m >= 0.05 ? Math.round(got / m) : got, m };
    }
    // The cohorts are across projects; a project's share follows its leads.
    const share =
      project === "all"
        ? 1
        : (() => {
            const all = data.rows.filter((r) => r.week === c.week).reduce((t, r) => t + r.counts.leads, 0);
            const mine = data.rows.filter((r) => r.week === c.week && r.project === project).reduce((t, r) => t + r.counts.leads, 0);
            return all ? mine / all : 0;
          })();
    const scaled = { ...c, leads: Math.round(c.leads * share), eventual: c.eventual * share };
    return { week: c.week, ago, leads: scaled.leads, got: landed(scaled, ago), expect: Math.round(scaled.eventual), m };
  });
  // "About N in the end" only where there is more still to come.
  const guess = (c: (typeof cols)[number]) => c.m < STILL_BOOKING && (!real || c.expect > c.got);
  // The newest week that has finished booking is the one lit by default.
  const defaultHi = cols.reduce((at, c, i) => (c.m >= STILL_BOOKING ? i : at), cols.length - 1);
  const [hi, setHi] = useState<number | null>(null);
  const on = hi ?? defaultHi;
  const top = Math.max(1, ...cols.map((c) => Math.max(c.got, c.expect)));
  const sel = cols[on];

  return (
    <div className="card rp-cohort">
      <div className="card__head">
        <h2>Bookings by the week the lead came in</h2>
        <div className="seg seg--sm" role="group" aria-label="Show as">
          <button type="button" className="seg__opt" aria-pressed={!asTable} onClick={() => setAsTable(false)}>
            Chart
          </button>
          <button type="button" className="seg__opt" aria-pressed={asTable} onClick={() => setAsTable(true)}>
            Table
          </button>
        </div>
      </div>

      {asTable ? (
        <div className="ws-scroll">
          <table className="ws-table rp-table rp-table--tight">
            <thead>
              <tr>
                <th scope="col">Week of</th>
                <th scope="col" className="ws-num">Leads</th>
                <th scope="col" className="ws-num">Booked so far</th>
                <th scope="col" className="ws-num">Expected in the end</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => (
                <tr key={c.week}>
                  <th scope="row" className="tnum">{short(c.week)}</th>
                  <td className="ws-num tnum">{count(c.leads)}</td>
                  <td className="ws-num tnum">{c.got}</td>
                  <td className="ws-num tnum">{guess(c) ? `About ${c.expect}` : c.got}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <p className="rp-read" aria-live="polite">
            {sel && (
              <>
                Week of {short(sel.week)}: <strong className="tnum">{count(sel.leads)}</strong> leads,{" "}
                <strong className="tnum">{sel.got}</strong> {sel.got === 1 ? "booking" : "bookings"} so far
                {guess(sel) ? `, about ${sel.expect} in the end` : ""}
              </>
            )}
          </p>
          <div className="rp-cols" onMouseLeave={() => setHi(null)}>
            {cols.map((c, i) => {
              const young = c.m < STILL_BOOKING;
              return (
                <button
                  key={c.week}
                  type="button"
                  className={`rp-col${i === on ? " is-on" : ""}${young ? " is-young" : ""}`}
                  onMouseEnter={() => setHi(i)}
                  onFocus={() => setHi(i)}
                  onBlur={() => setHi(null)}
                  aria-label={`Week of ${short(c.week)}: ${c.leads} leads, ${c.got} bookings so far${guess(c) ? `, about ${c.expect} expected` : ""}`}
                >
                  <span className="rp-col__plot" aria-hidden>
                    {guess(c) && <span className="rp-col__expect" style={{ height: `${(c.expect / top) * 100}%` }} />}
                    <span className="rp-col__fill" style={{ height: `${Math.max(2, (c.got / top) * 100)}%` }}>
                      {i === on && <span className="rp-col__tag tnum">{c.got}</span>}
                    </span>
                  </span>
                  <span className="rp-col__day" aria-hidden>
                    {i % 2 === (cols.length - 1) % 2 ? (i === cols.length - 1 ? "This week" : short(c.week)) : ""}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="rp-key" aria-hidden>
            <span>
              <span className="rp-key__sw rp-key__sw--done" /> Booked
            </span>
            <span>
              <span className="rp-key__sw rp-key__sw--young" /> Still booking
            </span>
            <span>
              <span className="rp-key__sw rp-key__sw--expect" /> Expected
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Closing managers
// ---------------------------------------------------------------------------

function Hosts({ visited, booked }: { visited: number; booked: number }) {
  // Both columns are the page's own totals shared out, so they add up to the
  // visits and bookings everything else on the page reports.
  const visits = apportion(visited, HOST_SHARE.map((h) => h.share));
  const books = apportion(booked, HOST_SHARE.map((h, i) => visits[i] * h.converts));
  const rows = HOST_SHARE.map((h, i) => ({
    ...h,
    visits: visits[i],
    booked: books[i],
    revisits: Math.round(visits[i] * h.revisit),
    rate: visits[i] ? books[i] / visits[i] : null,
  })).sort((a, b) => b.booked - a.booked);
  const best = Math.max(0.01, ...rows.map((r) => r.rate ?? 0));

  return (
    <div className="card rp-team">
      <div className="card__head">
        <h2>Closing managers</h2>
      </div>
      <table className="ws-table rp-table rp-table--tight">
        <thead>
          <tr>
            <th scope="col">Host</th>
            <th scope="col" className="ws-num">Visits</th>
            <th scope="col" className="ws-num">Bookings</th>
            <th scope="col">Visit to booking</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.host}>
              <th scope="row" className="rp-host">
                {r.host}
                <span className="ws-sub tnum">{r.revisits} revisits</span>
              </th>
              <td className="ws-num tnum">{r.visits}</td>
              <td className="ws-num tnum rp-strong">{r.booked}</td>
              <td className="rp-rate">
                <span className="rp-rate__bar" aria-hidden>
                  <span style={{ width: `${((r.rate ?? 0) / best) * 100}%` }} />
                </span>
                <span className="tnum">{percent(r.rate)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where the money went: one table, five ways to cut it
// ---------------------------------------------------------------------------

function Rollups({ rows }: { rows: Row[] }) {
  const [dim, setDim] = useState<Dim>("campaign");
  const [open, setOpen] = useState(false);
  const list = useMemo(() => rollup(rows, dim), [rows, dim]);
  const unranked = list.filter((x) => !rankable(x.c)).length;
  const shown = open ? list : list.slice(0, 8);
  const label = DIMS.find((d) => d.key === dim)!.label;
  const money = (n: number | null) => (n === null ? <span className="rp-none">None</span> : rupeesShort(n));

  return (
    <section className="card rp-camps" aria-labelledby="rp-roll-h">
      <div className="card__head rp-roll__head">
        <h2 id="rp-roll-h">
          Where the money <span className="em">went</span>
        </h2>
        <div className="seg" role="group" aria-label="Cut by">
          {DIMS.map((d) => (
            <button
              key={d.key}
              type="button"
              className="seg__opt"
              aria-pressed={dim === d.key}
              onClick={() => {
                setDim(d.key);
                setOpen(false);
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      {list.length > 0 && (
        <p className="ws-sub rp-roll__note">
          {unranked ? `${unranked} with fewer than ${RANK_FLOOR} bookings are not ranked` : "All ranked"}. Paid media only.
        </p>
      )}
      <div className="ws-scroll">
        <table className="ws-table rp-table rp-stack">
          <thead>
            <tr>
              <th scope="col">{label}</th>
              <th scope="col" className="ws-num">Spent</th>
              <th scope="col" className="ws-num">Leads</th>
              <th scope="col" className="ws-num">Per lead</th>
              <th scope="col" className="ws-num">Per qualified</th>
              <th scope="col" className="ws-num">Per visit</th>
              <th scope="col" className="ws-num">Bookings</th>
              <th scope="col" className="ws-num">Per booking</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="rp-none" style={{ padding: "20px 12px", textAlign: "center" }}>
                  No paid media in this period.
                </td>
              </tr>
            )}
            {shown.map((x) => {
              const cpb = costPerBooking(x.c, "media");
              return (
                <tr key={x.key}>
                  <th scope="row" className="rp-camp">
                    {x.label}
                    {x.sub && <span className="ws-sub">{x.sub}</span>}
                  </th>
                  <td className="ws-num tnum" data-label="Spent">
                    {x.c.spend ? rupeesShort(x.c.spend) : <span className="rp-none">None</span>}
                  </td>
                  <td className="ws-num tnum" data-label="Leads">{count(x.c.leads)}</td>
                  <td className="ws-num tnum rp-c-hide">{money(costPer(x.c, "leads"))}</td>
                  <td className="ws-num tnum rp-c-hide">{money(costPer(x.c, "qualified"))}</td>
                  <td className="ws-num tnum" data-label="Per visit">{money(costPer(x.c, "visited"))}</td>
                  <td className="ws-num tnum rp-strong" data-label="Bookings">{count(x.c.booked)}</td>
                  <td className="ws-num tnum rp-c-key">
                    {!rankable(x.c) ? (
                      <span className="pill pill--quiet">Too few to rank</span>
                    ) : cpb === null ? (
                      <span className="rp-none">No spend recorded</span>
                    ) : (
                      rupeesShort(cpb)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.length > 8 && (
        <div className="ws-foot">
          <p className="ws-sub">
            Showing {shown.length} of {list.length}
          </p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen((o) => !o)}>
            {open ? "Show fewer" : `Show all ${list.length}`}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Each quarter: do the leads we call qualified go on to book?
// ---------------------------------------------------------------------------

function QuarterCheck({ rows, today }: { rows: Row[]; today: string }) {
  const { quarter, bookRate, lines } = useMemo(() => quarterCheck(rows, today), [rows, today]);
  const rarely = lines.filter((l) => l.verdict === "RARELY_BOOKS");
  if (!lines.length) return null;
  return (
    <section className="card rp-quarter" id="rp-quarter" aria-labelledby="rp-q-h">
      <div className="card__head">
        <h2 id="rp-q-h">Do qualified leads book?</h2>
        <span className="pill pill--quiet">Leads from {quarter.label}</span>
      </div>
      <p className={`rp-quarter__say${rarely.length ? " is-warn" : ""}`}>
        {rarely.length
          ? `Qualified leads from ${rarely.length === 1 ? "1 campaign" : `${rarely.length} campaigns`} rarely book. Check what the agent asks to qualify a buyer before changing the ad.`
          : bookRate === null
            ? "No qualified leads from that quarter yet."
            : `${percent(bookRate)} of qualified leads booked. No campaign stands out.`}
      </p>
      <div className="ws-scroll">
        <table className="ws-table rp-table rp-stack">
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col" className="ws-num">Leads</th>
              <th scope="col" className="ws-num">Qualified</th>
              <th scope="col" className="ws-num">Qualified that booked</th>
              <th scope="col">Check</th>
            </tr>
          </thead>
          <tbody>
            {lines.slice(0, 10).map((l) => (
              <tr key={`${l.project}|${l.campaign}`}>
                <th scope="row" className="rp-camp">
                  {l.campaign}
                  <span className="ws-sub">{l.project}</span>
                </th>
                <td className="ws-num tnum" data-label="Leads">{count(l.leads)}</td>
                <td className="ws-num tnum" data-label="Qualified">
                  {count(l.qualified)} <span className="ws-sub">{percent(l.qualifiedRate)}</span>
                </td>
                <td className="ws-num tnum" data-label="Booked">
                  {count(l.booked)} <span className="ws-sub">{percent(l.bookRate)}</span>
                </td>
                <td className="rp-c-key">
                  {l.verdict === "RARELY_BOOKS" ? (
                    <span className="pill pill--warn">Rarely book</span>
                  ) : l.verdict === "BOOKS" ? (
                    <span className="pill pill--ok">Book as expected</span>
                  ) : (
                    <span className="pill pill--quiet">Too few to judge</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

