"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useKeptSubmit } from "@/components/KeptForm";
import { addOtherNumberAction, removeOtherNumberAction, type ClaimFormState } from "@/app/actions/partner-claims";

/** Add a co-applicant's or an alternate number: closed until asked for. */
export function AddOtherNumber({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, submit, pending] = useActionState<ClaimFormState, FormData>(addOtherNumberAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);
  if (!open) {
    return (
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
        Add a number
      </button>
    );
  }
  return (
    <form action={submit} onSubmit={keep} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input type="hidden" name="leadId" value={leadId} />
      <label className="sr-only" htmlFor={`on-kind-${leadId}`}>
        Whose number
      </label>
      <select id={`on-kind-${leadId}`} name="kind" className="cl-select" defaultValue="CO_APPLICANT">
        <option value="CO_APPLICANT">Co-applicant</option>
        <option value="ALTERNATE">Alternate number</option>
      </select>
      <label className="sr-only" htmlFor={`on-phone-${leadId}`}>
        Number
      </label>
      <input id={`on-phone-${leadId}`} name="phone" className="mv-input" inputMode="tel" maxLength={20} placeholder="98765 43210" required autoFocus />
      <button type="submit" className="btn btn--ink btn--sm" disabled={pending}>
        {pending ? "Adding" : "Add"}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {state && !state.ok && (
        <p className="mv-err" role="alert" style={{ flexBasis: "100%", margin: 0 }}>
          {state.message}
        </p>
      )}
    </form>
  );
}

export function RemoveOtherNumber({ leadId, id }: { leadId: string; id: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        style={{ marginLeft: 8 }}
        disabled={busy}
        onClick={() => {
          if (!window.confirm("Take this number off the lead?")) return;
          start(async () => {
            const r = await removeOtherNumberAction(leadId, id);
            if (r?.ok) router.refresh();
            else setErr(r?.message ?? "Could not take it off.");
          });
        }}
      >
        {busy ? "Taking off" : "Remove"}
      </button>
      {err && <span className="mv-err">{err}</span>}
    </>
  );
}
