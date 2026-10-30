"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { useKeptSubmit } from "@/components/KeptForm";
import { Close } from "@/components/icons";
import type { WorkspaceResult } from "@/lib/partner-workspace";
import { fileFirmInvoiceAction } from "./actions";

/**
 * A firm's invoice for one half that is owed, sent to the developer from the
 * firm's own console. One button in the half's cell; the form opens over the
 * page, and the half reads "Invoice with the developer" once it lands.
 */
export function SendInvoice({
  payoutId,
  half,
  devOrgId,
  gross,
  what,
  today,
}: {
  payoutId: string;
  half: "M1" | "M2";
  /** The developer, for a channel partner's brokerage; a mandate firm's is found on the server. */
  devOrgId?: string;
  /** What the half comes to, GST included, shown as the placeholder for the total. */
  gross: string;
  /** Which booking and which half, in the dialog's heading. */
  what: string;
  today: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [state, dispatch, pending] = useActionState<WorkspaceResult | null, FormData>(fileFirmInvoiceAction, null);
  const onSubmit = useKeptSubmit(dispatch);
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state, router]);
  const close = () => ref.current?.close();
  return (
    <>
      <button type="button" className="btn btn--ink btn--sm" onClick={() => ref.current?.showModal()} data-invoice={`${payoutId}:${half}`}>
        Send invoice
      </button>
      <dialog ref={ref} className="cl-dialog" aria-labelledby={`${id}-t`}>
        <form ref={formRef} action={dispatch} onSubmit={onSubmit} className="cl-form" noValidate>
          <div className="cl-head">
            <h2 id={`${id}-t`}>Send your invoice</h2>
            <button type="button" className="btn btn--icon" aria-label="Close" onClick={close}>
              <Close size={14} />
            </button>
          </div>
          <p className="fw-book__line">{what}</p>
          <input type="hidden" name="payoutId" value={payoutId} />
          <input type="hidden" name="key" value={half} />
          {devOrgId && <input type="hidden" name="devOrgId" value={devOrgId} />}
          <label className="fw-field">
            <span className="mv-label">Invoice number</span>
            <input name="invoiceNo" className="mv-input" maxLength={40} required placeholder="SK/26-27/041" autoComplete="off" />
          </label>
          <label className="fw-field">
            <span className="mv-label">Invoice date</span>
            <input name="invoiceDate" type="date" className="mv-input" max={today} defaultValue={today} required />
          </label>
          <label className="fw-field">
            <span className="mv-label">Total on the invoice</span>
            <span className="mv-money">
              <span aria-hidden>Rs</span>
              <input name="amount" className="mv-input" inputMode="numeric" required placeholder={gross} autoComplete="off" />
            </span>
          </label>
          <label className="fw-field">
            <span className="mv-label">The invoice (PDF, JPEG or PNG)</span>
            <input name="file" type="file" className="mv-input" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" required />
          </label>
          {state && (
            <p className={`note ${state.ok ? "note--info" : "note--risk"}`} role={state.ok ? "status" : "alert"}>
              {state.message}
            </p>
          )}
          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={close}>
              {state?.ok ? "Done" : "Cancel"}
            </button>
            {!state?.ok && (
              <button type="submit" className="btn btn--ink" disabled={pending}>
                {pending ? "Sending" : "Send invoice"}
              </button>
            )}
          </div>
        </form>
      </dialog>
    </>
  );
}
