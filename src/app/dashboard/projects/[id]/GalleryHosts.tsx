"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { saveCapacityAction, saveHostHoursAction, type ActionResult } from "@/app/actions/leads";
import { saveVisitHoursAction } from "@/app/actions/project-life";
import type { GalleryHost } from "@/lib/slots";
import { WEEK_ORDER, WEEKDAY_LABEL, WEEKDAY_SHORT, hourLabel, shiftLabel } from "@/lib/slot-rules";
import { ANY_VISIT_SLOTS, DEFAULT_VISIT_HOURS, dayLabel, hostBounds, timeLabel, type VisitHours } from "@/lib/visit-hours-rules";

/**
 * How many buyers the gallery can host in one hour. Once any host has
 * working hours, an hour takes one visit for each host on the floor and a
 * booked visit is given one of them; until then the project's own numbers
 * for weekdays and the weekend stand. Read-only until "Change" or "Set
 * hours".
 */
export function GalleryHosts({
  projectId,
  capacity,
  hosts,
  canEdit,
}: {
  projectId: string;
  capacity: { weekday: number; weekend: number; set: boolean; hours?: VisitHours };
  hosts: GalleryHost[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<null | "numbers" | "hours" | "open">(null);
  const [capState, submitCap, capPending] = useActionState<ActionResult | null, FormData>(saveCapacityAction, null);
  const [hourState, submitHours, hourPending] = useActionState<ActionResult | null, FormData>(saveHostHoursAction, null);
  const [openState, submitOpen, openPending] = useActionState<ActionResult | null, FormData>(saveVisitHoursAction, null);
  const open = capacity.hours ?? DEFAULT_VISIT_HOURS;
  const bounds = hostBounds(open);
  const [seen, setSeen] = useState<ActionResult | null>(null);
  const withHours = hosts.filter((h) => h.hours.length > 0);
  const byHours = withHours.length > 0;
  const [hostId, setHostId] = useState<string>(withHours[0]?.id ?? hosts[0]?.id ?? "");

  useEffect(() => {
    if (!capState?.ok && !hourState?.ok && !openState?.ok) return;
    setEditing(null);
    router.refresh();
  }, [capState, hourState, openState, router]);

  const state = editing === "hours" ? hourState : editing === "open" ? openState : capState;
  const pending = capPending || hourPending || openPending;
  const error = editing && state && !state.ok && state !== seen ? state.message : null;
  const per = (n: number) => `${n} ${n === 1 ? "visit" : "visits"} an hour`;
  const start = (which: "numbers" | "hours" | "open") => {
    setSeen(which === "hours" ? hourState : which === "open" ? openState : capState);
    setEditing(which);
  };
  const chosen = hosts.find((h) => h.id === hostId);

  return (
    <section className="card siteloc" aria-labelledby="hosts-title" data-gallery-hosts>
      <div className="card__head">
        <h2 id="hosts-title">Visits per hour</h2>
        {!editing && (byHours ? <span className="pill pill--blue">By hosts' hours</span> : !capacity.set && <span className="pill pill--quiet">Default</span>)}
        {/* Every button is keyed: unkeyed, React reused "Set a host's hours"
            as the Save button in the same click, its type turned to submit
            mid-click, and the empty form saved itself at once. */}
        {editing ? (
          <>
            <button key="cancel" type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </button>
            <button
              key="save"
              type="submit"
              form={editing === "hours" ? "host-hours-form" : editing === "open" ? "open-hours-form" : "hosts-form"}
              className="btn btn--ink btn--sm"
              disabled={pending}
            >
              {pending ? "Saving" : editing === "hours" || editing === "open" ? "Save hours" : "Save"}
            </button>
          </>
        ) : canEdit ? (
          <>
            {!byHours && (
              <button key="change" type="button" className="btn btn--ghost btn--sm" onClick={() => start("numbers")} aria-label="Change visits per hour">
                Change
              </button>
            )}
            {hosts.length > 0 && (
              <button key="set-hours" type="button" className="btn btn--ghost btn--sm" onClick={() => start("hours")}>
                Set a host's hours
              </button>
            )}
            <button key="open-hours" type="button" className="btn btn--ghost btn--sm" onClick={() => start("open")} data-open-hours>
              Opening hours
            </button>
          </>
        ) : null}
      </div>

      {error && (
        <p className="note note--risk siteloc__note" role="alert">
          {error}
        </p>
      )}

      {editing === "open" ? (
        <form id="open-hours-form" action={submitOpen} className="siteloc__form">
          <input type="hidden" name="projectId" value={projectId} />
          {(
            [
              ["weekday", "Monday to Friday"],
              ["weekend", "Saturday and Sunday"],
            ] as const
          ).map(([k, label]) => (
            <fieldset key={k} className="hosthours__day">
              <legend>{label}</legend>
              <select name={`${k}Open`} aria-label={`${label}, opens`} defaultValue={open[k].open}>
                {ANY_VISIT_SLOTS.map((t) => (
                  <option key={t} value={t}>
                    {timeLabel(t)}
                  </option>
                ))}
              </select>
              <span className="hosthours__to">last visit</span>
              <select name={`${k}Last`} aria-label={`${label}, last visit`} defaultValue={open[k].last}>
                {ANY_VISIT_SLOTS.map((t) => (
                  <option key={t} value={t}>
                    {timeLabel(t)}
                  </option>
                ))}
              </select>
            </fieldset>
          ))}
        </form>
      ) : editing === "numbers" ? (
        <form id="hosts-form" action={submitCap} className="siteloc__form">
          <input type="hidden" name="projectId" value={projectId} />
          <div className="field">
            <label htmlFor="hosts-weekday">Monday to Friday</label>
            <input id="hosts-weekday" name="weekday" type="number" min={0} max={50} inputMode="numeric" required defaultValue={capacity.weekday} />
          </div>
          <div className="field">
            <label htmlFor="hosts-weekend">Saturday and Sunday</label>
            <input id="hosts-weekend" name="weekend" type="number" min={0} max={50} inputMode="numeric" required defaultValue={capacity.weekend} />
          </div>
        </form>
      ) : editing === "hours" ? (
        <form id="host-hours-form" action={submitHours} className="hosthours__form" key={hostId}>
          <input type="hidden" name="projectId" value={projectId} />
          <div className="field">
            <label htmlFor="host-pick">Host</label>
            <select id="host-pick" name="hostId" value={hostId} onChange={(e) => setHostId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
          <div className="hosthours__days">
            {WEEK_ORDER.map((d) => {
              const kept = chosen?.hours.find((x) => x.weekday === d);
              return (
                <fieldset key={d} className="hosthours__day">
                  <legend>{WEEKDAY_LABEL[d]}</legend>
                  <select name={`from-${d}`} aria-label={`${WEEKDAY_LABEL[d]}, starts`} defaultValue={kept ? String(kept.from) : ""}>
                    <option value="">Off</option>
                    {range(bounds.open, bounds.close - 1).map((h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                  <span className="hosthours__to">to</span>
                  <select name={`to-${d}`} aria-label={`${WEEKDAY_LABEL[d]}, finishes`} defaultValue={kept ? String(kept.to) : ""}>
                    <option value="">Off</option>
                    {range(bounds.open + 1, bounds.close).map((h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                </fieldset>
              );
            })}
          </div>
        </form>
      ) : (
        <>
          <dl className="hosts-read" data-open-hours-read>
            <div>
              <dt>Open Monday to Friday</dt>
              <dd className="tnum">{dayLabel(open.weekday)}</dd>
            </div>
            <div>
              <dt>Open Saturday and Sunday</dt>
              <dd className="tnum">{dayLabel(open.weekend)}</dd>
            </div>
          </dl>
          {!byHours && (
            <dl className="hosts-read">
              <div>
                <dt>Monday to Friday</dt>
                <dd className="tnum">{per(capacity.weekday)}</dd>
              </div>
              <div>
                <dt>Saturday and Sunday</dt>
                <dd className="tnum">{per(capacity.weekend)}</dd>
              </div>
            </dl>
          )}
          {byHours && (
            <div className="ws-scroll hosthours__read">
              <table className="ws-table" data-host-hours>
                <thead>
                  <tr>
                    <th scope="col">Host</th>
                    {WEEK_ORDER.map((d) => (
                      <th key={d} scope="col">
                        {WEEKDAY_SHORT[d]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {withHours.map((h) => (
                    <tr key={h.id}>
                      <th scope="row">{h.name}</th>
                      {WEEK_ORDER.map((d) => {
                        const x = h.hours.find((y) => y.weekday === d);
                        return (
                          <td key={d} className={`tnum${x ? "" : " hosthours__off"}`}>
                            {x ? shiftLabel(x.from, x.to) : "Off"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
