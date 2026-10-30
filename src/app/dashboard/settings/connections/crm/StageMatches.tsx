"use client";

import { useMemo, useState } from "react";
import { STAGES, stageLabel, type StageKey } from "@/lib/lead-rules";

/**
 * Their statuses against our nine stages, and, for each of ours, the status
 * of theirs we set when a lead moves there. Client-side only so the second
 * list follows the first as it is edited: a status offered for "Qualified"
 * is one just matched to Qualified, not one that was matched when the page
 * loaded. The server checks the pair again on save.
 */

export type StageRow = {
  id: string;
  label: string;
  parentId: string | null;
  parentLabel: string | null;
  externalId: string;
  stage: StageKey | null;
};

export function StageMatches({
  rows,
  push,
  editing,
  crm,
}: {
  rows: StageRow[];
  /** Our stage to the id of their row we set for it. */
  push: Partial<Record<StageKey, string>>;
  editing: boolean;
  crm: string;
}) {
  const [picked, setPicked] = useState<Record<string, StageKey | null>>(() => Object.fromEntries(rows.map((r) => [r.id, r.stage])));
  const parentOf = useMemo(() => new Map(rows.map((r) => [r.externalId, r])), [rows]);
  const inherited = (r: StageRow): StageKey | null => {
    if (picked[r.id]) return null;
    const p = r.parentId ? parentOf.get(r.parentId) : undefined;
    return p ? picked[p.id] ?? null : null;
  };

  return (
    <>
      <section className="card crm-card" aria-labelledby="crm-stages">
        <div className="card__head">
          <h2 id="crm-stages">Stages</h2>
          <span className="pill pill--quiet">{rows.length} in {crm}</span>
        </div>
        {rows.length === 0 ? (
          <p className="formfield__unset">{crm} listed no statuses yet.</p>
        ) : (
          <ul className="acct-list">
            {rows.map((r) => {
              const mine = picked[r.id];
              const from = inherited(r);
              return (
                <li key={r.id} className={`acct ${editing ? "" : "acct--read "}crm-row`} data-stage-row={r.label}>
                  <span className="acct__id">
                    <strong>{r.label}</strong>
                    {r.parentLabel && <small>Under {r.parentLabel}</small>}
                  </span>
                  {editing ? (
                    <label className="acct__where">
                      <span className="sr-only">Stage here for {r.label}</span>
                      <select
                        name={`m:${r.id}`}
                        className="select-field"
                        value={mine ? `stage:${mine}` : ""}
                        onChange={(e) => setPicked((p) => ({ ...p, [r.id]: (e.target.value.replace(/^stage:/, "") || null) as StageKey | null }))}
                      >
                        <option value="">{r.parentLabel ? `Same as ${r.parentLabel}` : "Not matched"}</option>
                        {STAGES.map((s) => (
                          <option key={s.key} value={`stage:${s.key}`}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : mine ? (
                    <span className="pill pill--quiet">{stageLabel(mine)}</span>
                  ) : from ? (
                    <span className="pill pill--quiet">{stageLabel(from)}, as {r.parentLabel}</span>
                  ) : (
                    <span className="pill pill--warn">Not matched</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card crm-card" aria-labelledby="crm-push">
        <div className="card__head">
          <h2 id="crm-push">When a lead moves here, set in {crm}</h2>
        </div>
        <ul className="acct-list">
          {STAGES.map((s) => {
            const options = rows.filter((r) => picked[r.id] === s.key);
            const chosen = push[s.key] && options.some((o) => o.id === push[s.key]) ? push[s.key]! : "";
            const shown = rows.find((r) => r.id === push[s.key]);
            return (
              <li key={s.key} className={`acct ${editing ? "" : "acct--read "}crm-row`} data-push-row={s.key}>
                <span className="acct__id">
                  <strong>{s.label}</strong>
                </span>
                {editing ? (
                  <label className="acct__where">
                    <span className="sr-only">Status set in {crm} for {s.label}</span>
                    <select name={`push:${s.key}`} className="select-field" defaultValue={chosen} key={options.map((o) => o.id).join()}>
                      <option value="">{options.length ? "Not chosen" : `Match a status to ${s.label} first`}</option>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.parentLabel ? `${o.parentLabel}: ${o.label}` : o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : shown ? (
                  <span className="pill pill--quiet">{shown.parentLabel ? `${shown.parentLabel}: ${shown.label}` : shown.label}</span>
                ) : (
                  <span className="pill pill--warn">Not chosen</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
