"use client";

import { useState } from "react";
import { MEASURES, defaultDay, type AdDay, type Measure } from "@/lib/ad-detail-rules";

/**
 * The ad's days as columns, one measure at a time. The last day that had
 * anything is lit until somebody points at another, and the line above
 * reads that day out. A table of the same days for anybody who would
 * rather read rows.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const rupees = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;
const count = (n: number) => n.toLocaleString("en-IN");
const show = (m: Measure, n: number) => (m === "spend" ? rupees(n) : count(n));

export function DayChart({ days, today }: { days: AdDay[]; today: string }) {
  const [measure, setMeasure] = useState<Measure>("spend");
  const [asTable, setAsTable] = useState(false);
  const [hi, setHi] = useState<number | null>(null);

  const on = hi ?? defaultDay(days, measure);
  const top = Math.max(1, ...days.map((d) => d[measure]));
  const sel = days[on];
  // One label in every few, so a two-month run does not print sixty dates.
  const every = days.length > 40 ? 7 : days.length > 20 ? 4 : days.length > 10 ? 2 : 1;
  const nothing = days.every((d) => d.spend === 0 && d.leads === 0 && d.clicks === 0);

  return (
    <div className="card ad-days">
      <div className="card__head">
        <h2>Day by day</h2>
        <div className="ad-days__ctl">
          {!asTable && (
            <div className="seg seg--sm" role="group" aria-label="Measure">
              {MEASURES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className="seg__opt"
                  aria-pressed={measure === m.key}
                  onClick={() => {
                    setMeasure(m.key);
                    setHi(null);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
          <div className="seg seg--sm" role="group" aria-label="Show as">
            <button type="button" className="seg__opt" aria-pressed={!asTable} onClick={() => setAsTable(false)}>
              Chart
            </button>
            <button type="button" className="seg__opt" aria-pressed={asTable} onClick={() => setAsTable(true)}>
              Table
            </button>
          </div>
        </div>
      </div>

      {nothing ? (
        <p className="ad-empty">Nothing spent or brought yet.</p>
      ) : asTable ? (
        <div className="ws-scroll">
          <table className="ws-table ad-days__table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="ws-num">Spend</th>
                <th scope="col" className="ws-num">Seen</th>
                <th scope="col" className="ws-num">Clicks</th>
                <th scope="col" className="ws-num">Leads</th>
                <th scope="col" className="ws-num">A lead</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}>
                  <th scope="row" className="tnum">{d.day === today ? "Today" : short(d.day)}</th>
                  <td className="ws-num tnum">{d.spend ? rupees(d.spend) : "None"}</td>
                  <td className="ws-num tnum">{count(d.impressions)}</td>
                  <td className="ws-num tnum">{count(d.clicks)}</td>
                  <td className="ws-num tnum">{count(d.leads)}</td>
                  <td className="ws-num tnum">{d.leads && d.spend ? rupees(d.spend / d.leads) : ""}</td>
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
                {sel.day === today ? "Today" : short(sel.day)}: <strong className="tnum">{sel.spend ? rupees(sel.spend) : "nothing"}</strong> spent,{" "}
                <strong className="tnum">{count(sel.leads)}</strong> {sel.leads === 1 ? "lead" : "leads"},{" "}
                <strong className="tnum">{count(sel.clicks)}</strong> {sel.clicks === 1 ? "click" : "clicks"}
                {sel.leads && sel.spend ? `, ${rupees(sel.spend / sel.leads)} a lead` : ""}
              </>
            )}
          </p>
          <div
            className={`ad-cols ad-cols--${measure}`}
            style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
            onMouseLeave={() => setHi(null)}
          >
            {days.map((d, i) => {
              const v = d[measure];
              const last = i === days.length - 1;
              return (
                <button
                  key={d.day}
                  type="button"
                  className={`ad-col${i === on ? " is-on" : ""}`}
                  onMouseEnter={() => setHi(i)}
                  onFocus={() => setHi(i)}
                  onBlur={() => setHi(null)}
                  aria-label={`${short(d.day)}: ${rupees(d.spend)} spent, ${d.leads} leads, ${d.clicks} clicks`}
                >
                  <span className="ad-col__plot" aria-hidden>
                    <span className="ad-col__fill" style={{ height: v ? `${Math.max(3, (v / top) * 100)}%` : "2px" }}>
                      {i === on && v > 0 && <span className="ad-col__tag tnum">{show(measure, v)}</span>}
                    </span>
                  </span>
                  <span className="ad-col__day" aria-hidden>
                    {last ? (d.day === today ? "Today" : short(d.day)) : (days.length - 1 - i) % every === 0 ? short(d.day) : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
