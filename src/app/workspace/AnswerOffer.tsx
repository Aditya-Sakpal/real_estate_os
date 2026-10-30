"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "@/components/icons";
import { answerMandateAction } from "./actions";

/**
 * Accept or decline one offer. Each asks once more, because neither can be
 * undone: accepting makes the mandate live and the developer is told.
 */
export function AnswerOffer({ mandateId, developer }: { mandateId: string; developer: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sure, setSure] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const go = (accept: boolean) =>
    start(async () => {
      const res = await answerMandateAction({ mandateId, accept });
      if (res.ok) {
        setDone(res.message);
        router.refresh();
      } else setNote(res.message);
    });
  if (done) return <span className="pill pill--ok">{done}</span>;
  return (
    <span className="fw-offer__acts">
      {accepting ? (
        <>
          <button type="button" className="btn btn--sm fw-offer__accept" disabled={pending} onClick={() => go(true)}>
            <Check size={13} />
            {pending ? "Accepting" : "Yes, accept and go live"}
          </button>
          <button type="button" className="btn btn--ghost btn--sm fw-offer__decline" disabled={pending} onClick={() => setAccepting(false)}>
            Not yet
          </button>
          <span className="fw-offer__line">{developer} is told, and you start work in their console.</span>
        </>
      ) : sure ? (
        <>
          <button type="button" className="btn btn--ghost btn--sm fw-offer__decline" disabled={pending} onClick={() => go(false)}>
            {pending ? "Declining" : "Yes, decline"}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={pending} onClick={() => setSure(false)}>
            Keep it
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn--sm fw-offer__accept" disabled={pending} onClick={() => setAccepting(true)}>
            <Check size={13} />
            Accept
          </button>
          <button type="button" className="btn btn--ghost btn--sm fw-offer__decline" disabled={pending} onClick={() => setSure(true)}>
            Decline
          </button>
        </>
      )}
      {note && <span className="fw-offer__err" role="alert">{note}</span>}
    </span>
  );
}
