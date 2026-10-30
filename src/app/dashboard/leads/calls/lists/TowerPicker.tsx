"use client";

import { useEffect, useRef, useState } from "react";

export type TowerGroup = { project: string; towers: { id: string; name: string; ok: boolean }[] };

/**
 * Which towers a list is about: a whole project with one tick, or towers
 * across projects one by one. The order they were ticked in is kept, and
 * the first is the one a person is called about when their row says
 * nothing that picks another.
 */
export function TowerPicker({ groups }: { groups: TowerGroup[] }) {
  const all = groups.flatMap((g) => g.towers).filter((t) => t.ok);
  const [picked, setPicked] = useState<string[]>(all.length === 1 ? [all[0].id] : []);
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const toggle = (ids: string[], on: boolean) =>
    setPicked((p) => (on ? [...p, ...ids.filter((id) => !p.includes(id))] : p.filter((id) => !ids.includes(id))));
  const nameOf = (id: string) => {
    const g = groups.find((x) => x.towers.some((t) => t.id === id));
    const t = g?.towers.find((x) => x.id === id);
    return g && t ? `${g.project} · ${t.name}` : "";
  };
  const summary = !picked.length
    ? "Choose towers"
    : picked.length === 1
      ? nameOf(picked[0])
      : all.length > 1 && all.every((t) => picked.includes(t.id))
        ? `Every tower (${picked.length})`
        : `${nameOf(picked[0])} and ${picked.length - 1} more`;

  return (
    <details ref={ref} className="tp">
      <summary className="tp__button" aria-label="Towers this list is about">
        <span className={picked.length ? "" : "tp__empty"}>{summary}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className="tp__chev">
          <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="tp__panel" role="group" aria-label="Towers">
        {groups.map((g) => {
          // A tower the RERA gate stops is shown and never chosen.
          const ids = g.towers.filter((t) => t.ok).map((t) => t.id);
          const n = ids.filter((id) => picked.includes(id)).length;
          return (
            <div key={g.project} className="tp__group">
              <label className="tp__row tp__row--project">
                <input
                  type="checkbox"
                  checked={ids.length > 0 && n === ids.length}
                  disabled={!ids.length}
                  ref={(el) => {
                    if (el) el.indeterminate = n > 0 && n < ids.length;
                  }}
                  onChange={(e) => toggle(ids, e.target.checked)}
                />
                <span>{g.project}</span>
                <span className="tp__count">{!ids.length ? "Not advertisable" : ids.length === 1 ? "1 tower" : `All ${ids.length} towers`}</span>
              </label>
              {g.towers.map((t) => (
                <label key={t.id} className={`tp__row${t.ok ? "" : " tp__row--off"}`}>
                  <input type="checkbox" checked={picked.includes(t.id)} disabled={!t.ok} onChange={(e) => toggle([t.id], e.target.checked)} />
                  <span>{t.name}</span>
                  {!t.ok && <span className="tp__count">Not advertisable</span>}
                  {picked[0] === t.id && picked.length > 1 && <span className="pill pill--blue tp__first">Default</span>}
                </label>
              ))}
            </div>
          );
        })}
      </div>
      {picked.map((id) => (
        <input key={id} type="hidden" name="towerIds" value={id} />
      ))}
    </details>
  );
}
