"use client";

import { useEffect, useRef } from "react";

/** Sends the ticket at once; the button is there if the browser holds back. */
export function AutoSubmit({ action, ticket, test }: { action: (fd: FormData) => Promise<void>; ticket: string; test: boolean }) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.requestSubmit();
  }, []);
  return (
    <form ref={ref} action={action} style={{ marginTop: 18 }}>
      <input type="hidden" name="t" value={ticket} />
      {test && <input type="hidden" name="test" value="1" />}
      <button type="submit" className="btn btn--ink" style={{ width: "100%" }}>
        Continue
      </button>
    </form>
  );
}
