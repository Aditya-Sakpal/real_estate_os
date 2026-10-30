"use client";

import { useActionState, useEffect, useState } from "react";
import { setOccasionsAction, type PostState } from "@/app/actions/post";
import { useKeptSubmit } from "@/components/KeptForm";
import { PageHead } from "@/components/shell/PageHead";

type Row = {
  key: string;
  name: string;
  onDate: string;
  kind: "BUYING" | "GREETING";
  regions: string[];
  verified: boolean;
  optedIn: boolean;
};

/**
 * The opt-in list, saved by one button.
 *
 * One form and one press, the rule the brand kit screen learned the hard way:
 * a page of tick boxes with a save beside each group loses whatever somebody
 * ticked in the other groups.
 *
 * The opt-in is per OCCASION rather than per occurrence, so ticking Diwali
 * covers every year in the calendar. Two rows for the same festival therefore
 * share one box, and the dates sit beside it as what they are, a reading.
 */
export default function OccasionForm({
  occasions,
  mayWrite,
  meta,
}: {
  occasions: Row[];
  mayWrite: boolean;
  /** The header's one line of state. */
  meta: string;
}) {
  const [state, submit, pending] = useActionState<PostState, FormData>(
    setOccasionsAction,
    null,
  );
  // The boxes stay as they were ticked, whatever the save says.
  const keep = useKeptSubmit(submit);
  // Save is pressable only once something was ticked or unticked.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (state?.ok) setDirty(false);
  }, [state]);

  // One box per festival, with its dates gathered behind it.
  const byKey = new Map<string, Row[]>();
  for (const o of occasions) {
    byKey.set(o.key, [...(byKey.get(o.key) ?? []), o]);
  }
  const keys = [...byKey.entries()].sort(
    (a, b) => (a[1][0].onDate < b[1][0].onDate ? -1 : 1),
  );
  const buying = keys.filter(([, rows]) => rows[0].kind === "BUYING");
  const greeting = keys.filter(([, rows]) => rows[0].kind === "GREETING");

  return (
    <form action={submit} onSubmit={keep} onChange={() => setDirty(true)}>
      {/* The header sits inside the form, so its one action saves the ticks
          below it and can say it is saving. */}
      <PageHead
        title={
          <>
            Occasions you <span className="em">mark</span>
          </>
        }
        meta={meta}
        back={{ label: "Campaigns", href: "/dashboard/campaigns" }}
        action={
          mayWrite ? (
            <button
              type="submit"
              className="btn btn--ink"
              disabled={pending || !dirty}
              data-save
            >
              {pending ? "Saving" : dirty ? "Save changes" : "Saved"}
            </button>
          ) : null
        }
      />

      {state && (
        <div
          className={`note note--${state.ok ? "info" : "risk"}`}
          style={{ marginBottom: 16 }}
          role={state.ok ? "status" : "alert"}
        >
          {state.message}
        </div>
      )}

      <div className="stack">
        <Group
          title="Buying occasions"
          note="An offer may go out with these."
          rows={buying}
          mayWrite={mayWrite}
        />
        <Group
          title="Greetings"
          note="No price and no offer appears on these."
          rows={greeting}
          mayWrite={mayWrite}
        />
      </div>

    </form>
  );
}

function Group({
  title,
  note,
  rows,
  mayWrite,
}: {
  title: string;
  note: string;
  rows: [string, Row[]][];
  mayWrite: boolean;
}) {
  if (!rows.length) return null;
  return (
    <section className="card">
      <div className="card__head">
        <h2>{title}</h2>
        <span className="pill pill--quiet">{note}</span>
      </div>
      <div className="occasions">
        {rows.map(([key, dates]) => {
          const head = dates[0];
          const usable = dates.some((d) => d.verified);
          return (
            <label key={key} className={`occasion ${usable ? "" : "occasion--unusable"}`}>
              <input
                type="checkbox"
                name="occasions"
                value={key}
                defaultChecked={head.optedIn}
                disabled={!mayWrite || !usable}
              />
              <span className="occasion__body">
                <strong>{head.name}</strong>
                <small>
                  {dates.map((d) => onDate(d.onDate)).join(" · ")}
                  {head.regions.length ? ` · ${head.regions.join(", ")}` : ""}
                </small>
                {!usable && <span className="pill pill--warn">Date not confirmed</span>}
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function onDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
