"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { askExtensionAction } from "./actions";

/** Ask the developer to run a live mandate longer. Asks once more, because the developer is emailed. */
export function AskLonger({ mandateId }: { mandateId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sure, setSure] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const go = () =>
    start(async () => {
      const res = await askExtensionAction({ mandateId });
      setNote(res);
      setSure(false);
      if (res.ok) router.refresh();
    });
  if (note?.ok) return <span className="pill pill--ok">{note.message}</span>;
  return (
    <span className="fw-ctl">
      {sure ? (
        <>
          <button type="button" className="btn btn--ink btn--sm" disabled={pending} onClick={go}>
            {pending ? "Asking" : "Yes, ask them"}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={pending} onClick={() => setSure(false)}>
            Not now
          </button>
        </>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSure(true)}>
          Ask to run it longer
        </button>
      )}
      {note && !note.ok && (
        <span className="mv-err" role="alert">
          {note.message}
        </span>
      )}
    </span>
  );
}
