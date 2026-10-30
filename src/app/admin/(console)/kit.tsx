import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "@/components/icons";
import type { Day } from "@/lib/admin-data";
import { num } from "../fmt";

/* Building blocks of the operator console, drawn with the console's own
   classes (card, ws-dark, ws-table, pill, rp-donut) so the two read as one
   product. */

/** "+12% on last month", tinted by whether up is good. */
export function Delta({ now, before, upIsGood = true, unit = "on last month" }: { now: number; before: number; upIsGood?: boolean; unit?: string }) {
  if (!before && !now) return <span className="adm-delta">No change</span>;
  if (!before) return <span className="adm-delta adm-delta--new">New this month</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const good = pct === 0 ? null : pct > 0 === upIsGood;
  return (
    <span className={`adm-delta${good === null ? "" : good ? " adm-delta--good" : " adm-delta--bad"}`}>
      {pct > 0 ? "↑" : pct < 0 ? "↓" : ""} {Math.abs(pct)}% <span className="adm-delta__unit">{unit}</span>
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  delta,
  href,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <span className="adm-stat__label">{label}</span>
      <span className="adm-stat__num tnum">{value}</span>
      {delta}
      {sub && <span className="adm-stat__sub">{sub}</span>}
    </>
  );
  return href ? (
    <Link href={href} className="card adm-stat adm-stat--link">
      {body}
    </Link>
  ) : (
    <div className="card adm-stat">{body}</div>
  );
}

const SHORT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const dayLabel = (d: string) => SHORT.format(new Date(`${d}T00:00:00Z`));

/**
 * Thirty days as columns: the whole of each day soft, the part that counts
 * solid, today the one column in full colour (the references' highlighted
 * column). Hovering a column shows its numbers.
 */
export function Columns({
  days,
  a,
  b,
  money = false,
  height = 168,
}: {
  days: Day[];
  a: string;
  b?: string;
  money?: boolean;
  height?: number;
}) {
  const top = Math.max(1, ...days.map((d) => d.a));
  const fmt = (v: number) => (money ? `Rs ${Math.round(v / 100).toLocaleString("en-IN")}` : num(v));
  return (
    <div className="adm-cols" style={{ height }}>
      {days.map((d, i) => {
        const last = i === days.length - 1;
        return (
          <div key={d.day} className={`adm-col${last ? " is-now" : ""}`} tabIndex={0}>
            <span className="adm-col__tip">
              <strong>{dayLabel(d.day)}</strong>
              <span>
                {fmt(d.a)} {a}
              </span>
              {b && (
                <span>
                  {fmt(d.b)} {b}
                </span>
              )}
            </span>
            <span className="adm-col__plot">
              <span className="adm-col__a" style={{ height: `${d.a ? Math.max(3, (d.a / top) * 100) : 1.5}%` }}>
                {b && d.a > 0 && <span className="adm-col__b" style={{ height: `${(d.b / d.a) * 100}%` }} />}
              </span>
            </span>
            <span className="adm-col__day">{i % 7 === (days.length - 1) % 7 ? (last ? "Today" : dayLabel(d.day)) : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ColumnsKey({ a, b }: { a: string; b?: string }) {
  return (
    <div className="adm-key">
      <span>
        <span className="adm-key__sw adm-key__sw--a" /> {a}
      </span>
      {b && (
        <span>
          <span className="adm-key__sw adm-key__sw--b" /> {b}
        </span>
      )}
    </div>
  );
}

const TONES = ["rp-c--blue", "rp-c--pink", "rp-c--green", "adm-c--lilac", "adm-c--amber", "rp-c--other"];

/** A donut and its legend, in the Reports screen's own drawing. */
export function Donut({
  parts,
  centre,
  caption,
  money = false,
}: {
  parts: { label: string; n: number }[];
  centre: string;
  caption: string;
  money?: boolean;
}) {
  const shown = parts.filter((p) => p.n > 0);
  const sum = shown.reduce((s, p) => s + p.n, 0);
  const R = 54;
  const C = 2 * Math.PI * R;
  const GAP = shown.length > 1 ? 2.5 : 0;
  let at = 0;
  return (
    <div className="adm-donut">
      <svg className="rp-donut" viewBox="0 0 140 140" role="img" aria-label={shown.map((p) => `${p.label} ${p.n}`).join(", ")}>
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-sunk)" strokeWidth="18" />
        {sum > 0 &&
          shown.map((p, i) => {
            const len = (p.n / sum) * C;
            const seg = Math.max(0, len - GAP);
            const el = (
              <circle
                key={p.label}
                cx="70"
                cy="70"
                r={R}
                fill="none"
                className={`rp-arc ${TONES[Math.min(i, TONES.length - 1)]}`}
                strokeWidth="18"
                strokeDasharray={`${seg} ${C - seg}`}
                strokeDashoffset={-at}
                transform="rotate(-90 70 70)"
              />
            );
            at += len;
            return el;
          })}
        <text x="70" y="70" textAnchor="middle" className="rp-donut__n adm-donut__n">
          {centre}
        </text>
        <text x="70" y="88" textAnchor="middle" className="rp-donut__l">
          {caption}
        </text>
      </svg>
      <ul className="rp-legend">
        {shown.length ? (
          shown.map((p, i) => (
            <li key={p.label}>
              <span className={`rp-dot ${TONES[Math.min(i, TONES.length - 1)]}`} aria-hidden />
              <span className="rp-legend__label">{p.label}</span>
              <span className="rp-legend__n tnum">{money ? `Rs ${Math.round(p.n / 100).toLocaleString("en-IN")}` : num(p.n)}</span>
              <span className="rp-legend__pct tnum">{Math.round((p.n / sum) * 100)}%</span>
            </li>
          ))
        ) : (
          <li className="adm-faint">Nothing yet.</li>
        )}
      </ul>
    </div>
  );
}

/** A used-against-allowance bar, warned at 80% and red when used up. */
export function Meter({ used, of, label }: { used: number; of: number; label: string }) {
  const share = of > 0 ? used / of : 0;
  const tone = share >= 1 ? "risk" : share >= 0.8 ? "warn" : "ok";
  return (
    <div className="adm-meter">
      <div className="adm-meter__row">
        <span>{label}</span>
        <span className="tnum">
          <strong>{num(Math.round(used))}</strong> of {num(of)}
        </span>
      </div>
      <span className={`adm-meter__track adm-meter--${tone}`}>
        <span style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
    </div>
  );
}

/** A horizontal bar inside a table cell. */
export function CellBar({ value, max, label, tone = "blue" }: { value: number; max: number; label: string; tone?: string }) {
  return (
    <span className="adm-cellbar">
      <span className={`adm-cellbar__track adm-cellbar--${tone}`}>
        <span style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
      </span>
      <span className="tnum">{label}</span>
    </span>
  );
}

export function CardHead({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card__head">
      <div className="adm-head">
        <h2>{title}</h2>
        {sub && <span className="ws-sub">{sub}</span>}
      </div>
      {action}
    </div>
  );
}

export function GoLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="btn btn--light btn--sm adm-go">
      {children}
      <ArrowUpRight size={13} />
    </Link>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="adm-faint adm-empty">{children}</p>;
}
