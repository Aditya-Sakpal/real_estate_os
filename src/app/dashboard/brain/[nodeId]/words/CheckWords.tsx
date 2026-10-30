"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { checkWordsAction } from "@/app/actions/pronounce";
import type { FormResult } from "@/components/KeptForm";

function Go({ count }: { count: number }) {
  const { pending } = useFormStatus();
  const words = `${count} ${count === 1 ? "word" : "words"}`;
  return (
    <button type="submit" className="btn btn--light btn--sm" disabled={pending} data-check-words="">
      {pending && <span className="checkwords__spin" aria-hidden />}
      {pending ? `Checking ${words}` : `Check ${words}`}
    </button>
  );
}

/**
 * The page's one primary action: say every word not checked yet in the call
 * voice and hear each back. `count` is what one press takes.
 */
export default function CheckWords({ nodeId, count }: { nodeId: string; count: number }) {
  const [state, action] = useActionState<FormResult, FormData>(checkWordsAction, null);
  return (
    <form action={action} className="checkwords" aria-live="polite">
      <input type="hidden" name="nodeId" value={nodeId} />
      <Go count={count} />
      {state?.message && <p className={`checkwords__note${state.ok ? "" : " checkwords__note--risk"}`}>{state.message}</p>}
    </form>
  );
}
