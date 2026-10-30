"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A value somebody pastes into another product: its name, the value, and
 * Copy. Where the browser will not copy (a plain http address, a locked-down
 * machine), the value is selected and the button says to press Ctrl+C, so
 * the press never does nothing.
 */
export function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [done, setDone] = useState<"copied" | "selected" | null>(null);

  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(null), 2400);
    return () => window.clearTimeout(t);
  }, [done]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone("copied");
    } catch {
      input.current?.focus();
      input.current?.select();
      setDone("selected");
    }
  }

  return (
    <div className="copyfield">
      <label htmlFor={id}>{label}</label>
      <input
        ref={input}
        id={id}
        type="text"
        readOnly
        value={value}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={copy}
        aria-label={`Copy ${label}`}
        data-copied={done === "copied" ? "true" : undefined}
      >
        <CopyMark />
        {done === "copied" ? "Copied" : done === "selected" ? "Press Ctrl+C" : "Copy"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {done === "copied" ? `${label} copied.` : done === "selected" ? "Selected. Press Ctrl+C to copy." : ""}
      </span>
    </div>
  );
}

/** Two sheets, one over the other. Drawn to the console's icon grid. */
function CopyMark() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.4" />
      <path d="M15.5 5.6V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h.1" />
    </svg>
  );
}
