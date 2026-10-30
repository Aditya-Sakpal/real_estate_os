"use client";

import { Fragment, useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Close, Partners as PartnersIcon, Plus, Search } from "@/components/icons";
import { useKeptSubmit } from "@/components/KeptForm";
import { rupees } from "@/lib/lead-rules";
import { MANDATE_DEFAULT_RATE, MANDATE_STATE, TAIL_CHOICES, lastDay, longDay, showRate, tailLine, type MandateState } from "@/lib/mandate-rules";
import type { MandateProject, MandateRow } from "@/lib/mandates";
import { changeMandateAction, lookupMandateFirmAction, offerMandateAction, type MandateFormState } from "@/app/actions/mandates";
import "./partners.css";

/**
 * The developer's mandate firms: who holds which project, at what rate,
 * until when, and what they have earned. One firm per project at a time;
 * an offer waits for the firm to accept it from its own workspace.
 */

const plusYear = (today: string) => {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
};

const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const WAITING: MandateState[] = ["invited", "offered"];
const RUNNING: MandateState[] = ["live", "not_started"];

function F({ id, label, error, optional, wide, children }: { id: string; label: string; error?: string; optional?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`mv-field${wide ? " mv-field--wide" : ""}`}>
      <label className="mv-label" htmlFor={id}>
        {label}
        {optional && <span className="mv-optional"> (optional)</span>}
      </label>
      {children}
      {error && (
        <p className="mv-err" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appointing a firm
// ---------------------------------------------------------------------------

export function AppointDialog({ projects, today, primary = true }: { projects: MandateProject[]; today: string; primary?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [state, submit, pending] = useActionState<MandateFormState, FormData>(offerMandateAction, null);
  const keep = useKeptSubmit(submit);
  const [pan, setPan] = useState("");
  const [found, setFound] = useState<{ pan: string; name: string | null } | null>(null);
  const [looking, look] = useTransition();
  const free = projects.filter((p) => !p.heldBy);
  const errors = state?.ok ? undefined : state?.errors;
  const inv = (k: string) => (errors?.[k] ? { "aria-invalid": true as const, "aria-describedby": `ma-${k}-err` } : {});
  const cleanPan = pan.trim().toUpperCase();
  const panShape = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleanPan);
  const known = found && found.pan === cleanPan ? found : null;
  const onPlatform = !!known?.name;

  useEffect(() => {
    if (!panShape || found?.pan === cleanPan) return;
    const at = cleanPan;
    const t = setTimeout(
      () =>
        look(async () => {
          const r = await lookupMandateFirmAction(at);
          setFound({ pan: at, name: r?.name ?? null });
        }),
      250,
    );
    return () => clearTimeout(t);
  }, [cleanPan, panShape, found]);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setPan("");
      setFound(null);
      router.refresh();
    }
  }, [state, router]);

  const close = () => ref.current?.close();
  return (
    <>
      <button type="button" className={`btn ${primary ? "btn--ink" : "btn--ghost"}`} onClick={() => ref.current?.showModal()} disabled={!projects.length}>
        <Plus size={15} />
        Appoint a mandate firm
      </button>
      <dialog ref={ref} className="cl-dialog pf-dialog" aria-labelledby="ma-title">
        <form ref={formRef} action={submit} onSubmit={keep} className="cl-form" noValidate>
          <div className="cl-head">
            <h2 id="ma-title">Appoint a mandate firm</h2>
            <button type="button" className="btn btn--icon" aria-label="Close" onClick={close}>
              <Close size={14} />
            </button>
          </div>

          <div className="mv-grid">
            <F id="ma-pan" label="Firm's PAN" error={errors?.pan} wide>
              <input
                id="ma-pan"
                name="pan"
                className="mv-input pt-mono pf-narrow"
                required
                maxLength={10}
                placeholder="ABCFG1234H"
                autoCapitalize="characters"
                spellCheck={false}
                autoFocus
                value={pan}
                onChange={(e) => setPan(e.target.value)}
                {...inv("pan")}
              />
              {panShape && (
                <p className="mv-hint" role="status">
                  {looking && !known ? "Looking it up" : onPlatform ? (
                    <>
                      <strong>{known!.name}</strong> is on Sales Desk. They get the offer to accept.
                    </>
                  ) : known ? (
                    "Not on Sales Desk yet. We email them an invite to sign up and accept."
                  ) : null}
                </p>
              )}
            </F>

            {!onPlatform && (
              <>
                <F id="ma-firmName" label="Firm name" error={errors?.firmName} wide>
                  <input id="ma-firmName" name="firmName" className="mv-input" maxLength={160} placeholder="Guardians Real Estate Advisory" {...inv("firmName")} />
                </F>
                <F id="ma-contactName" label="Who to invite" error={errors?.contactName}>
                  <input id="ma-contactName" name="contactName" className="mv-input" maxLength={120} placeholder="Ramesh Kulkarni" {...inv("contactName")} />
                </F>
                <F id="ma-contactEmail" label="Their work email" error={errors?.contactEmail}>
                  <input id="ma-contactEmail" name="contactEmail" type="email" className="mv-input" maxLength={200} placeholder="ramesh@guardians.in" {...inv("contactEmail")} />
                </F>
              </>
            )}
          </div>

          <fieldset className="pf-fieldset" id="ma-projects" aria-invalid={errors?.projects ? true : undefined}>
            <legend className="mv-label">Projects</legend>
            <div className="checkset">
              {projects.map((p) => (
                <label key={p.id} className={`checkset__item${p.heldBy ? " is-disabled" : ""}`}>
                  <input type="checkbox" name="projectId" value={p.id} disabled={!!p.heldBy} defaultChecked={free.length === 1 && !p.heldBy} />
                  <span>
                    <strong>{p.name}</strong>
                    {p.heldBy && <small>With {p.heldBy}</small>}
                  </span>
                </label>
              ))}
            </div>
            {errors?.projects && <p className="mv-err">{errors.projects}</p>}
          </fieldset>

          <div className="mv-grid">
            <F id="ma-rate" label="Commission on every booking (%)" error={errors?.rate}>
              <input
                id="ma-rate"
                name="rate"
                className="mv-input pf-narrow tnum"
                inputMode="decimal"
                required
                defaultValue={String(+(MANDATE_DEFAULT_RATE * 100).toFixed(2))}
                placeholder="3"
                {...inv("rate")}
              />
            </F>
            <F id="ma-validTo" label="Last day" error={errors?.validTo}>
              <input id="ma-validTo" name="validTo" type="date" className="mv-input pf-narrow" required min={today} defaultValue={plusYear(today)} {...inv("validTo")} />
            </F>
            <F id="ma-tailDays" label="Booked after the last day, by buyers who came during it" error={errors?.tailDays} wide>
              <select id="ma-tailDays" name="tailDays" className="mv-input pf-narrow" defaultValue="0" {...inv("tailDays")}>
                {TAIL_CHOICES.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? "Owe the firm nothing" : `Owe the firm for ${d} days`}
                  </option>
                ))}
              </select>
            </F>
          </div>

          {state && (!state.errors || state.ok) && (
            <p className={`note ${state.ok ? "note--info" : "note--risk"}`} role="status">
              {state.message}
            </p>
          )}
          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={close}>
              {state?.ok ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending || !free.length}>
              {pending ? "Sending" : onPlatform ? "Send the offer" : "Send the invite"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// One mandate's controls
// ---------------------------------------------------------------------------

function MandateControls({ m, today }: { m: MandateRow; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [renewing, setRenewing] = useState(false);
  const [day, setDay] = useState("");
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const run = (kind: "withdraw" | "end" | "renew") =>
    start(async () => {
      const res = await changeMandateAction({ mandateId: m.id, kind, validTo: kind === "renew" ? day : undefined });
      setNote(res);
      if (res.ok) {
        setRenewing(false);
        setDay("");
        router.refresh();
      }
    });
  const waiting = WAITING.includes(m.state);
  const running = RUNNING.includes(m.state);
  if (!waiting && !running) return null;
  const minDay = lastDay(m.validTo) > today ? lastDay(m.validTo) : today;
  return (
    <div className="pf-grant">
      <div className="pf-grant__acts">
        <button type="button" className="ws-link" onClick={() => setRenewing(!renewing)} aria-expanded={renewing}>
          Run it longer
        </button>
        {waiting && (
          <button
            type="button"
            className="ws-link pf-danger"
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Withdraw the offer to ${m.firm}?`)) run("withdraw");
            }}
          >
            Withdraw the offer
          </button>
        )}
        {running && (
          <button
            type="button"
            className="ws-link pf-danger"
            disabled={pending}
            onClick={() => {
              const tail = m.tailDays
                ? `${tailLine(plusDays(today, m.tailDays))} Any other booking from now on owes them nothing.`
                : "Bookings from now on owe them nothing.";
              if (window.confirm(`End the mandate of ${m.firm} today? ${tail} The channel partners they empanelled on it stop too. What they already earned stays.`)) run("end");
            }}
          >
            End the mandate
          </button>
        )}
      </div>
      {renewing && (
        <form
          className="pf-inline"
          onSubmit={(e) => {
            e.preventDefault();
            run("renew");
          }}
        >
          <input aria-label="New last day" type="date" className="mv-input" min={minDay} value={day} onChange={(e) => setDay(e.target.value)} required />
          <button type="submit" className="btn btn--ink btn--sm" disabled={pending || !day}>
            {pending ? "Saving" : "Save the new last day"}
          </button>
        </form>
      )}
      {note && <p className={note.ok ? "mv-hint" : "mv-err"} role="status">{note.message}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function MandatesView({
  mandates,
  projects,
  today,
  canManage,
  seesMoney,
}: {
  mandates: MandateRow[];
  projects: MandateProject[];
  today: string;
  canManage: boolean;
  seesMoney: boolean;
}) {
  const [sub, setSub] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const VIEWS = [
    { key: "all", label: "All" },
    { key: "live", label: "Live" },
    { key: "waiting", label: "Waiting for an answer" },
    { key: "past", label: "Ended" },
  ];
  const q = query.trim().toLowerCase();
  const found = mandates.filter((m) => !q || m.firm.toLowerCase().includes(q) || m.projects.some((p) => p.name.toLowerCase().includes(q)));
  const inSub = (m: MandateRow, s: string) =>
    s === "all" ? true : s === "live" ? RUNNING.includes(m.state) : s === "waiting" ? WAITING.includes(m.state) : !RUNNING.includes(m.state) && !WAITING.includes(m.state);
  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, found.filter((m) => inSub(m, v.key)).length]));
  const rows = found.filter((m) => inSub(m, sub));

  // Nothing to filter yet: one line saying what to do. Appointing is the page's own button at the top.
  if (mandates.length === 0) {
    return (
      <section className="card pt-none" aria-label="Mandate firms">
        <span className="empty__mark pt-none__mark" aria-hidden>
          <PartnersIcon size={18} />
        </span>
        <span className="pt-none__text">
          <strong>No mandate firm yet</strong>
          <span>
            {canManage && projects.length > 0
              ? "Appoint one to sell a project for a commission on every booking."
              : canManage
                ? "Add a project first, then appoint a firm to sell it."
                : "A firm appointed to sell a project shows here."}
          </span>
        </span>
      </section>
    );
  }

  return (
    <section className="card pt-sheet" aria-label="Mandate firms">
      <div className="pt-sheet__top">
        <div className="ws-views" role="group" aria-label="Show">
          {VIEWS.map((x) => (
            <button key={x.key} type="button" className="ws-view" aria-pressed={sub === x.key} onClick={() => setSub(x.key)}>
              {x.label}
              <span className="ws-view__n tnum">{(counts[x.key] ?? 0).toLocaleString("en-IN")}</span>
            </button>
          ))}
        </div>
        <label className="kb-search pt-find">
          <Search size={15} />
          <span className="sr-only">Search</span>
          <input type="search" placeholder="Firm or project" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="empty ws-empty">
          <span className="empty__mark" aria-hidden>
            <PartnersIcon size={20} />
          </span>
          <p>No mandates match these filters.</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSub("all");
              setQuery("");
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="ws-scroll">
          <table className="ws-table pt-table">
            <thead>
              <tr>
                <th scope="col">Firm</th>
                <th scope="col">Projects</th>
                <th scope="col" className="ws-num">Commission</th>
                <th scope="col">Last day</th>
                <th scope="col" className="ws-num">Bookings</th>
                {seesMoney && <th scope="col" className="ws-num">To pay</th>}
                <th scope="col">Status</th>
                <th scope="col" className="ws-chev"><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const open = openId === m.id;
                const st = MANDATE_STATE[m.state];
                return (
                  <Fragment key={m.id}>
                    <tr id={`pt-row-${m.id}`} className={`ws-row${open ? " is-open" : ""}`} onClick={() => setOpenId((c) => (c === m.id ? null : m.id))}>
                      <td className="pt-firm">
                        <button
                          type="button"
                          id={`pt-btn-${m.id}`}
                          className="ws-name"
                          aria-expanded={open}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenId((c) => (c === m.id ? null : m.id));
                          }}
                        >
                          {m.firm}
                        </button>
                        <span className="ws-sub pt-mono">{m.pan}</span>
                      </td>
                      <td>
                        <span className="pt-cell">{m.projects.map((p) => p.name).join(", ")}</span>
                      </td>
                      <td className="ws-num tnum" data-label="Commission">{showRate(m.rate)}</td>
                      <td className="tnum" data-label="Last day">
                        {m.endedOn && m.endedOn < lastDay(m.validTo) ? longDay(m.endedOn) : longDay(lastDay(m.validTo))}
                        {m.endedOn && m.endedOn < lastDay(m.validTo) && <span className="ws-sub">Ended early</span>}
                        {m.extensionAskedOn && <span className="ws-sub">They asked to run longer</span>}
                      </td>
                      <td className="ws-num tnum" data-label="Bookings">{m.bookings.toLocaleString("en-IN")}</td>
                      {seesMoney && <td className="ws-num tnum" data-label="To pay">{m.owed ? rupees(m.owed) : "Nothing"}</td>}
                      <td>
                        <span className={`pill pill--${st.tone}`}>
                          <span className="pill__dot" />
                          {st.label}
                        </span>
                      </td>
                      <td className="ws-chev" aria-hidden><ChevronDown size={14} /></td>
                    </tr>
                    {open && (
                      <tr className="ws-detailrow">
                        <td colSpan={seesMoney ? 8 : 7}>
                          <div className="ws-open pt-open">
                            <section className="ws-sec" aria-label="The mandate">
                              <h3>The mandate</h3>
                              <dl className="ws-facts pt-facts">
                                <div className="ws-fact">
                                  <dt>Offered</dt>
                                  <dd className="tnum">{longDay(m.offeredOn)}</dd>
                                </div>
                                <div className="ws-fact">
                                  <dt>{m.state === "declined" ? "Declined" : "Accepted"}</dt>
                                  <dd className="tnum">{m.answeredOn ? longDay(m.answeredOn) : "Not yet"}</dd>
                                </div>
                                {m.endedOn && (
                                  <div className="ws-fact">
                                    <dt>{m.status === "WITHDRAWN" ? "Withdrawn" : "Ended"}</dt>
                                    <dd className="tnum">{longDay(m.endedOn)}</dd>
                                  </div>
                                )}
                                {!m.onPlatform && m.contactName && (
                                  <div className="ws-fact">
                                    <dt>Invited</dt>
                                    <dd>{m.contactName}</dd>
                                  </div>
                                )}
                                <div className="ws-fact">
                                  <dt>Commission</dt>
                                  <dd className="tnum">{showRate(m.rate)} of the agreement value, in two halves</dd>
                                </div>
                                {m.tailDays > 0 && (
                                  <div className="ws-fact">
                                    <dt>After the last day</dt>
                                    <dd className="tnum">
                                      {m.tailUntil
                                        ? `Its buyers' bookings until ${longDay(m.tailUntil)} still owe it`
                                        : `Its buyers' bookings for ${m.tailDays} days still owe it`}
                                    </dd>
                                  </div>
                                )}
                              </dl>
                              {canManage && <MandateControls m={m} today={today} />}
                            </section>
                          </div>
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
    </section>
  );
}
