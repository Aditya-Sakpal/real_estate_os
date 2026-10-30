"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "@/components/icons";

/**
 * "Get this number" asks before it rents. A number is paid for the moment
 * it is rented and the same one may never come back, so the question names
 * the number and where it will be used, read from the form as it stands.
 * The form submits only from the dialog's own button.
 */
export function RentConfirm({ formId }: { formId: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<{ number: string; place: string } | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const form = () => document.getElementById(formId) as HTMLFormElement | null;

  function ask() {
    const f = form();
    if (!f) return;
    if (!f.reportValidity()) return;
    const radio = f.querySelector<HTMLInputElement>('input[name="pick"]:checked');
    const label = radio?.closest("label")?.querySelector("strong")?.textContent?.trim();
    const select = f.querySelector<HTMLSelectElement>('select[name="nodeId"]');
    const place = select?.value ? select.options[select.selectedIndex]?.text ?? "" : "";
    setPick({ number: label ?? "this number", place });
    setOpen(true);
  }

  function confirm() {
    const f = form();
    if (!f) return;
    setBusy(true);
    f.requestSubmit();
  }

  return (
    <>
      <button type="button" className="btn btn--ink" onClick={ask} data-rent-number>
        Get this number
        <ArrowUpRight size={14} />
      </button>
      <dialog
        ref={ref}
        className="mv confirm"
        aria-labelledby="rent-confirm-title"
        onClose={() => {
          setOpen(false);
          setBusy(false);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) setOpen(false);
        }}
      >
        <div className="mv-form">
          <div className="mv-head">
            <h2 id="rent-confirm-title">Get {pick?.number}?</h2>
          </div>
          <div className="mv-body confirm__body">
            <p>
              {pick?.number} is rented as soon as you confirm, and it is paid for every month
              {pick?.place ? `. Calls for ${pick.place} will go out from it.` : " until you release it."}
            </p>
            <p>Numbers are limited. Once released, you may not get this one back.</p>
          </div>
          <div className="mv-foot">
            <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)} disabled={busy}>
              Keep looking
            </button>
            <button type="button" className="btn btn--ink" onClick={confirm} disabled={busy} data-rent-confirmed>
              {busy ? "Getting the number" : `Get ${pick?.number ?? "this number"}`}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
