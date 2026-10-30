"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A button that asks once before it spends: writing every card again, making
 * a batch of posts.
 *
 * `ConfirmAction` is the same question for a form that posts and navigates.
 * These two keep working on this page after the press (a Stop button, a row
 * of placeholders filling in), so the dialog hands the press back and closes
 * at once rather than holding a form of its own open over the work.
 */
export function ConfirmPress({
  label,
  className,
  disabled,
  title,
  body,
  confirmLabel,
  onConfirm,
  testId,
}: {
  label: ReactNode;
  className: string;
  disabled?: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
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

  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => setOpen(true)} data-confirm={testId}>
        {label}
      </button>
      <dialog
        ref={ref}
        className="mv confirm"
        aria-labelledby={`${testId ?? "press"}-title`}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // A press on the backdrop is a press on the dialog itself.
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div className="mv-form">
          <div className="mv-head">
            <h2 id={`${testId ?? "press"}-title`}>{title}</h2>
          </div>
          <div className="mv-body confirm__body">{body}</div>
          <div className="mv-foot">
            <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
              Keep it as it is
            </button>
            <button
              type="button"
              className="btn btn--ink"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
              data-confirmed={testId}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
