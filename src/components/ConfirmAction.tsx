"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * A button that asks once before it does something that is hard to undo:
 * disconnecting an account, switching an ad's spend on.
 *
 * The question names exactly what will happen, and the confirming button
 * says it again, so nobody confirms a sentence they did not read. The form
 * that does the work lives inside the dialog, so the first button can never
 * submit it.
 */
export function ConfirmAction({
  label,
  title,
  body,
  confirmLabel,
  action,
  fields,
  tone = "ink",
  size = "sm",
  testId,
}: {
  label: ReactNode;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  action: (formData: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  tone?: "ink" | "risk" | "ghost" | "light";
  size?: "sm" | "md";
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const trigger =
    tone === "risk" ? "btn btn--ghost btn--danger" : tone === "light" ? "btn btn--light" : tone === "ghost" ? "btn btn--ghost" : "btn btn--ink";

  return (
    <>
      <button
        type="button"
        className={`${trigger}${size === "sm" ? " btn--sm" : ""}`}
        onClick={() => setOpen(true)}
        data-confirm={testId}
      >
        {label}
      </button>
      <dialog
        ref={ref}
        className="mv confirm"
        aria-labelledby={`${testId ?? "confirm"}-title`}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // A press on the backdrop is a press on the dialog itself.
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        <form action={action} className="mv-form">
          {Object.entries(fields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <div className="mv-head">
            <h2 id={`${testId ?? "confirm"}-title`}>{title}</h2>
          </div>
          <div className="mv-body confirm__body">{body}</div>
          <div className="mv-foot">
            <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
              Keep it as it is
            </button>
            <Submit tone={tone === "risk" ? "risk" : "ink"} label={confirmLabel} testId={testId} />
          </div>
        </form>
      </dialog>
    </>
  );
}

function Submit({ tone, label, testId }: { tone: "risk" | "ink"; label: string; testId?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`btn ${tone === "risk" ? "btn--risk" : "btn--ink"}`}
      disabled={pending}
      data-confirmed={testId}
    >
      {pending ? "Working" : label}
    </button>
  );
}
