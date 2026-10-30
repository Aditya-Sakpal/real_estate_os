"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Close, Phone } from "@/components/icons";
import { callLeadAction, type CallingFormState } from "@/app/actions/calling";
import { useKeptSubmit } from "@/components/KeptForm";
import { guessLanguage } from "@/lib/name-language-rules";

/**
 * Add a lead and have the agent call them now.
 *
 * A native dialog: it traps focus, Escape closes it, and the page behind
 * stays where it was. The result is said in the dialog itself, because a
 * refusal ("outside calling hours") is only useful next to the button that
 * produced it.
 */
export function CallLeadDialog({
  phases,
  developer,
}: {
  phases: { id: string; label: string }[];
  developer: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [state, submit, pending] = useActionState<CallingFormState, FormData>(callLeadAction, null);
  // A refusal keeps what was typed; only a placed call clears the form.
  const keep = useKeptSubmit(submit);
  // The language follows the name until somebody picks one: a Marathi
  // surname opens the call in Marathi.
  const [lang, setLang] = useState("hi");
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setLang("hi");
      setPicked(false);
      router.refresh();
    }
  }, [state, router]);

  return (
    <>
      <button type="button" className="btn btn--ink" onClick={() => ref.current?.showModal()}>
        <Phone size={15} />
        Call a lead
      </button>
      <dialog ref={ref} className="cl-dialog" aria-labelledby="cl-title">
        <form ref={formRef} action={submit} onSubmit={keep} className="cl-form">
          <div className="cl-head">
            <h2 id="cl-title">Call a lead</h2>
            <button type="button" className="btn btn--icon" aria-label="Close" onClick={() => ref.current?.close()}>
              <Close size={14} />
            </button>
          </div>

          <div className="cl-grid">
            <div className="field">
              <label htmlFor="cl-name">Name</label>
              <input
                id="cl-name"
                name="name"
                type="text"
                required
                maxLength={120}
                placeholder="Rohan Joshi"
                onChange={(e) => {
                  if (!picked) setLang(guessLanguage(e.target.value) ?? "hi");
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="cl-phone">Phone</label>
              <input id="cl-phone" name="phone" type="text" inputMode="tel" required placeholder="98765 43210" />
            </div>
            <div className="field">
              <label htmlFor="cl-phase">Tower they asked about</label>
              <select id="cl-phase" name="phaseId" required className="cl-select" defaultValue={phases[0]?.id}>
                {phases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cl-lang">Language</label>
              <select
                id="cl-lang"
                name="language"
                className="cl-select"
                value={lang}
                onChange={(e) => {
                  setLang(e.target.value);
                  setPicked(true);
                }}
              >
                <option value="hi">Hindi</option>
                <option value="mr">Marathi</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="field cl-wide">
              <label htmlFor="cl-source">Where the enquiry came from</label>
              <input id="cl-source" name="source" type="text" maxLength={60} placeholder="Facebook form" />
            </div>
          </div>

          <label className="switch">
            <input type="checkbox" name="consent" />
            <span>
              <span className="switch__name">They agreed to be contacted by call and WhatsApp</span>
            </span>
          </label>
          <input
            type="hidden"
            name="consentWording"
            value={`I agree to be contacted by ${developer} by call and WhatsApp about my enquiry.`}
          />

          {state && (
            <p className={`note ${state.ok ? "note--info" : "note--risk"}`} role="status">
              {state.message}
            </p>
          )}

          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={() => ref.current?.close()}>
              {state?.ok ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending}>
              {pending ? "Calling" : "Call now"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
