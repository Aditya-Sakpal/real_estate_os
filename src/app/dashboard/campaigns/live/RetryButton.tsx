"use client";

import { useFormStatus } from "react-dom";

/** Try again takes as long as the platform does, so it says it is working. */
export function RetryButton({ id, tone }: { id: string; tone: "light" | "ghost" }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn btn--${tone} btn--sm`} data-retry={id} disabled={pending} aria-busy={pending}>
      {pending ? "Trying again" : "Try again"}
    </button>
  );
}
