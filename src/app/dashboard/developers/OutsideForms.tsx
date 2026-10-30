"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useKeptSubmit } from "@/components/KeptForm";
import {
  answerOutsideAction,
  cancelBookingAction,
  makeInvoiceAction,
  recordBookingAction,
  recordPaidAction,
  registerOutsideAction,
  resendOutsideAction,
  saveSetupAction,
  type OutsideFormState,
} from "@/app/actions/outside";

function Note({ state }: { state: OutsideFormState }) {
  if (!state) return null;
  return (
    <p className={`note ${state.ok ? "note--info" : "note--risk"}`} role={state.ok ? "status" : "alert"}>
      {state.message}
    </p>
  );
}

const fieldError = (state: OutsideFormState, k: string) =>
  state && !state.ok && state.errors?.[k] ? (
    <span className="mv-err" role="alert">
      {state.errors[k]}
    </span>
  ) : null;

/** Where a developer not on Sales Desk takes registrations, and who an invoice is made out to. */
export function SetupForm({
  entityId,
  initial,
  states,
  doneHref,
}: {
  entityId: string;
  initial: { regEmail: string; regCc: string; validityDays: string; rate: string; gstin: string; billAddress: string; stateCode: string };
  states: { code: string; name: string }[];
  doneHref: string;
}) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState<OutsideFormState, FormData>(saveSetupAction, null);
  const onSubmit = useKeptSubmit(dispatch);
  useEffect(() => {
    if (state?.ok) router.push(doneHref);
  }, [state, router, doneHref]);
  return (
    <form action={dispatch} onSubmit={onSubmit} className="fw-form" noValidate>
      <Note state={state} />
      <input type="hidden" name="entityId" value={entityId} />
      <label className="fw-field">
        <span className="mv-label">Registrations go to</span>
        <input name="regEmail" type="email" className="mv-input" placeholder="cp.desk@developer.in" defaultValue={initial.regEmail} required />
        {fieldError(state, "regEmail")}
      </label>
      <label className="fw-field">
        <span className="mv-label">Copy to</span>
        <input name="regCc" inputMode="email" autoCapitalize="none" className="mv-input" placeholder="rm@developer.in, sales@developer.in" defaultValue={initial.regCc} />
        {fieldError(state, "regCc")}
      </label>
      <label className="fw-field">
        <span className="mv-label">Days a registration holds</span>
        <input name="validityDays" type="number" min={7} max={365} className="mv-input" defaultValue={initial.validityDays} />
        {fieldError(state, "validityDays")}
      </label>
      <label className="fw-field">
        <span className="mv-label">Brokerage rate (%)</span>
        <input name="rate" inputMode="decimal" className="mv-input" placeholder="2" defaultValue={initial.rate} required />
        {fieldError(state, "rate")}
      </label>
      <label className="fw-field">
        <span className="mv-label">Developer&rsquo;s GSTIN</span>
        <input name="gstin" className="mv-input" placeholder="27AAPFU0939F1ZV" defaultValue={initial.gstin} autoComplete="off" autoCapitalize="characters" />
        {fieldError(state, "gstin")}
      </label>
      <label className="fw-field">
        <span className="mv-label">Billing address</span>
        <input name="billAddress" className="mv-input" placeholder="Office no., building, road, city, PIN" defaultValue={initial.billAddress} />
        {fieldError(state, "billAddress")}
      </label>
      <label className="fw-field">
        <span className="mv-label">State</span>
        <select name="stateCode" className="mv-input" defaultValue={initial.stateCode}>
          <option value="">Choose</option>
          {states.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
        {fieldError(state, "stateCode")}
      </label>
      <div className="fw-form__acts">
        <Link href={doneHref} className="btn btn--ghost">
          Cancel
        </Link>
        <button type="submit" className="btn btn--ink" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </button>
      </div>
    </form>
  );
}

export type OutsideProject = { value: string; developer: string; project: string };

/** Register a buyer with a developer not on Sales Desk: the email goes to the developer from here. */
export function OutsideRegisterForm({ projects }: { projects: OutsideProject[] }) {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [state, dispatch, pending] = useActionState<OutsideFormState, FormData>(registerOutsideAction, null);
  const onSubmit = useKeptSubmit(dispatch);
  useEffect(() => {
    if (!state) return;
    router.refresh();
    if (state.ok && ref.current) {
      for (const n of ["name", "phone"]) {
        const el = ref.current.elements.namedItem(n);
        if (el instanceof HTMLInputElement) el.value = "";
      }
    }
  }, [state, router]);
  const developers = [...new Set(projects.map((p) => p.developer))];
  return (
    <form ref={ref} action={dispatch} onSubmit={onSubmit} className="fw-form" noValidate>
      <Note state={state} />
      <label className="fw-field">
        <span className="mv-label">Project</span>
        <select name="projectId" className="mv-input" defaultValue={projects.length === 1 ? projects[0].value : ""} required>
          {projects.length > 1 && (
            <option value="" disabled>
              Choose
            </option>
          )}
          {developers.map((d) => (
            <optgroup key={d} label={d}>
              {projects
                .filter((p) => p.developer === d)
                .map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.project}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="fw-field">
        <span className="mv-label">Buyer&rsquo;s name</span>
        <input name="name" className="mv-input" placeholder="Priya Sharma" maxLength={120} autoComplete="off" required />
      </label>
      <label className="fw-field">
        <span className="mv-label">Buyer&rsquo;s mobile</span>
        <input name="phone" type="tel" inputMode="tel" className="mv-input" placeholder="98765 43210" required autoComplete="off" />
      </label>
      <div className="fw-form__acts">
        <Link href="/dashboard/developers/buyers" className="btn btn--ghost">
          Close
        </Link>
        <button type="submit" className="btn btn--ink" disabled={pending} data-register-outside>
          {pending ? "Sending" : "Register and email developer"}
        </button>
      </div>
    </form>
  );
}

/** One small action on a row: confirmed, refused, withdraw, send again, cancel, make the invoice. */
export function RowAction({
  label,
  run,
  tone = "ghost",
  testId,
}: {
  label: string;
  run:
    | { kind: "answer"; id: string; answer: "CONFIRMED" | "REFUSED" | "WITHDRAWN" }
    | { kind: "resend"; id: string }
    | { kind: "cancel"; id: string }
    | { kind: "invoice"; bookingId: string };
  tone?: "ghost" | "ink";
  testId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<OutsideFormState>(null);
  return (
    <span className="fw-rowact">
      <button
        type="button"
        className={`btn btn--${tone} btn--sm`}
        disabled={pending}
        data-row-action={testId}
        onClick={() =>
          start(async () => {
            const r =
              run.kind === "answer"
                ? await answerOutsideAction({ id: run.id, answer: run.answer })
                : run.kind === "resend"
                  ? await resendOutsideAction({ id: run.id })
                  : run.kind === "cancel"
                    ? await cancelBookingAction({ id: run.id })
                    : await makeInvoiceAction({ bookingId: run.bookingId });
            setSaid(r);
            router.refresh();
          })
        }
      >
        {pending ? "Saving" : label}
      </button>
      {said && !said.ok && (
        <span className="mv-err" role="alert">
          {said.message}
        </span>
      )}
    </span>
  );
}

/** A booking: from a registration, or typed in with its project. */
export function BookingForm({
  registrationId,
  projects,
  today,
  defaultRate,
  closeHref,
}: {
  registrationId: string | null;
  projects: OutsideProject[];
  today: string;
  defaultRate: string;
  closeHref: string;
}) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState<OutsideFormState, FormData>(recordBookingAction, null);
  const onSubmit = useKeptSubmit(dispatch);
  useEffect(() => {
    if (state?.ok) router.push(closeHref);
  }, [state, router, closeHref]);
  return (
    <form action={dispatch} onSubmit={onSubmit} className="fw-form" noValidate>
      <Note state={state} />
      {registrationId ? (
        <input type="hidden" name="registrationId" value={registrationId} />
      ) : (
        <>
          <label className="fw-field">
            <span className="mv-label">Project</span>
            <select name="projectId" className="mv-input" defaultValue={projects.length === 1 ? projects[0].value : ""} required>
              {projects.length > 1 && (
                <option value="" disabled>
                  Choose
                </option>
              )}
              {projects.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.project} · {p.developer}
                </option>
              ))}
            </select>
          </label>
          <label className="fw-field">
            <span className="mv-label">Buyer&rsquo;s name</span>
            <input name="buyerName" className="mv-input" placeholder="Priya Sharma" maxLength={120} autoComplete="off" />
          </label>
        </>
      )}
      <label className="fw-field">
        <span className="mv-label">Unit</span>
        <input name="unit" className="mv-input" placeholder="C-803" maxLength={40} autoCapitalize="characters" />
      </label>
      <label className="fw-field">
        <span className="mv-label">Booked on</span>
        <input name="bookedOn" type="date" className="mv-input" max={today} defaultValue={today} required />
      </label>
      <label className="fw-field">
        <span className="mv-label">Agreement value</span>
        <input name="agreement" className="mv-input" placeholder="1.25 Cr or 1,25,00,000" required />
      </label>
      <label className="fw-field">
        <span className="mv-label">Brokerage rate (%)</span>
        <input name="rate" inputMode="decimal" className="mv-input" placeholder={defaultRate || "2"} />
      </label>
      <div className="fw-form__acts">
        <Link href={closeHref} className="btn btn--ghost">
          Cancel
        </Link>
        <button type="submit" className="btn btn--ink" disabled={pending} data-record-booking>
          {pending ? "Saving" : "Record booking"}
        </button>
      </div>
    </form>
  );
}

/** The developer paid an invoice: the day, the amount and the bank's reference. */
export function PaidForm({ invoiceId, today, net, closeHref }: { invoiceId: string; today: string; net: string; closeHref: string }) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState<OutsideFormState, FormData>(recordPaidAction, null);
  const onSubmit = useKeptSubmit(dispatch);
  useEffect(() => {
    if (state?.ok) router.push(closeHref);
  }, [state, router, closeHref]);
  return (
    <form action={dispatch} onSubmit={onSubmit} className="fw-form" noValidate>
      <Note state={state} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <label className="fw-field">
        <span className="mv-label">Paid on</span>
        <input name="paidOn" type="date" className="mv-input" max={today} defaultValue={today} required />
      </label>
      <label className="fw-field">
        <span className="mv-label">Amount received</span>
        <input name="amount" className="mv-input" defaultValue={net} required />
      </label>
      <label className="fw-field">
        <span className="mv-label">UTR or cheque number</span>
        <input name="utr" className="mv-input" placeholder="HDFCN52026101312345" required autoComplete="off" autoCapitalize="characters" />
      </label>
      <div className="fw-form__acts">
        <Link href={closeHref} className="btn btn--ghost">
          Cancel
        </Link>
        <button type="submit" className="btn btn--ink" disabled={pending} data-record-paid>
          {pending ? "Saving" : "Record payment"}
        </button>
      </div>
    </form>
  );
}
