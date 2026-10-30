"use client";

import { useState, useTransition } from "react";
import { revealAction, sendStepUpAction } from "@/app/actions/mask";
import type { Shown } from "@/lib/mask-rules";

/**
 * A buyer's number as the policy lets this person see it, and, where they
 * may, one press to see the rest.
 *
 * The browser only ever holds what the server sent: `98XXXXXX21`, or the
 * whole number after a reveal the server logged. There is no local "show"
 * over a number already on the page, because there is no number on the page.
 *
 * Signed in by phone, the server first asks for a code sent to the person's
 * own WhatsApp; the box for it opens here, beside the number it is for.
 */
export function RevealPhone({
  leadId,
  shown,
  linkClass = "ch-link",
  label = "Show number",
}: {
  leadId: string;
  shown: Shown;
  /** The screen's own link style. */
  linkClass?: string;
  label?: string;
}) {
  const [full, setFull] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ challengeId: string; message: string } | null>(null);
  const [code, setCode] = useState("");
  const [pending, start] = useTransition();

  if (shown.state === "HIDDEN") return <span className="sub">Hidden</span>;

  const reveal = () =>
    start(async () => {
      const r = await revealAction(leadId, asking ? { challengeId: asking.challengeId, code } : undefined);
      if (r.ok) {
        setFull(r.phone);
        setAsking(null);
        return;
      }
      if (r.needsCode && !asking) {
        const sent = await sendStepUpAction("lead.phone:unmask", leadId);
        if (sent.ok) setAsking({ challengeId: sent.challengeId, message: sent.message });
        else setRefusal(sent.message);
        return;
      }
      if (r.needsCode && asking) {
        setAsking({ ...asking, message: r.message });
        return;
      }
      setRefusal(r.message);
    });

  return (
    <>
      <span className="tnum">{full ?? shown.text}</span>
      {shown.canReveal && !full && !refusal && !asking && (
        <button type="button" className={linkClass} disabled={pending} aria-busy={pending} onClick={reveal}>
          {pending ? "Showing" : label}
        </button>
      )}
      {asking && !full && (
        <span className="stepup" role="group" aria-label="Code for this number">
          <span className="sub" role="status">
            {asking.message}
          </span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            className="formfield__input tnum stepup__code"
            placeholder="123456"
            aria-label="Six-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="button" className="btn btn--ink" disabled={pending || code.replace(/\s/g, "").length !== 6} onClick={reveal}>
            {pending ? "Checking" : "Show number"}
          </button>
        </span>
      )}
      {refusal && (
        <span className="sub" role="status">
          {refusal}
        </span>
      )}
    </>
  );
}
