"use client";

import { useRef, useState, useTransition } from "react";
import { Close, Phone } from "@/components/icons";
import { confirmPhoneAction, proxyCallAction, sendPhoneCodeAction } from "@/app/actions/proxy";

/**
 * Calling a buyer yourself, through our number. We ring your phone; you
 * pick up and are put through; the buyer sees our number and you never need
 * theirs. The first time, the dialog confirms your own number with a code.
 */
export function ProxyCall({
  leadId,
  leadName,
  own,
  blocked,
  whyId,
}: {
  leadId: string;
  leadName: string;
  /** The person's own confirmed number, masked, or null when they have none yet. */
  own: string | null;
  blocked: string | null;
  whyId: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mine, setMine] = useState(own);
  const [step, setStep] = useState<"CALL" | "NUMBER" | "CODE">(own ? "CALL" : "NUMBER");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; phone: string } | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const first = leadName.trim().split(/\s+/)[0] || leadName;

  const open = () => {
    setSaid(null);
    setStep(mine ? "CALL" : "NUMBER");
    ref.current?.showModal();
  };

  const ring = () =>
    start(async () => {
      const r = await proxyCallAction(leadId);
      setSaid({ ok: r.ok, text: r.message });
      if (r.needsPhone) {
        setMine(null);
        setStep("NUMBER");
      }
    });

  const send = () =>
    start(async () => {
      const r = await sendPhoneCodeAction(phone);
      if (r.ok && r.step === "CODE_SENT") {
        setChallenge({ id: r.challengeId, phone: r.phone });
        setCode("");
        setStep("CODE");
      }
      setSaid({ ok: r.ok, text: r.message });
    });

  const confirm = () =>
    start(async () => {
      if (!challenge) return;
      const r = await confirmPhoneAction(challenge.id, challenge.phone, code);
      if (r.ok && r.step === "CONFIRMED") {
        setMine(r.masked);
        setStep("CALL");
      }
      setSaid({ ok: r.ok, text: r.message });
    });

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost"
        disabled={Boolean(blocked)}
        aria-describedby={blocked ? whyId : undefined}
        onClick={open}
      >
        Call from my phone
      </button>
      <dialog ref={ref} className="cl-dialog" aria-labelledby={`pc-title-${leadId}`}>
        <div className="cl-form">
          <div className="cl-head">
            <h2 id={`pc-title-${leadId}`}>
              {step === "CALL" ? `Call ${first} from your phone` : "Your phone number"}
            </h2>
            <button type="button" className="btn btn--icon" aria-label="Close" onClick={() => ref.current?.close()}>
              <Close size={14} />
            </button>
          </div>

          {step === "CALL" && (
            <p className="sub">
              We ring <span className="tnum">{mine}</span>. Pick up and you are put through to {first}, who sees our
              number.
            </p>
          )}

          {step === "NUMBER" && (
            <div>
              <label htmlFor={`pc-phone-${leadId}`}>The phone we ring for your calls</label>
              <input
                id={`pc-phone-${leadId}`}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                className="formfield__input"
                placeholder="98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          )}

          {step === "CODE" && (
            <div>
              <label htmlFor={`pc-code-${leadId}`}>The six-digit code we sent on WhatsApp</label>
              <input
                id={`pc-code-${leadId}`}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                className="formfield__input tnum"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          )}

          <div role="status" aria-live="polite">
            {said && <p className={`note ${said.ok ? "note--info" : "note--risk"}`}>{said.text}</p>}
          </div>

          <div className="cl-actions">
            {step === "CALL" && (
              <button type="button" className="btn btn--ghost" onClick={() => setStep("NUMBER")}>
                Use another number
              </button>
            )}
            {step === "CODE" && (
              <button type="button" className="btn btn--ghost" onClick={() => setStep("NUMBER")}>
                Change number
              </button>
            )}
            {step === "CALL" && (
              <button type="button" className="btn btn--ink" disabled={pending} onClick={ring}>
                <Phone size={15} />
                {pending ? "Ringing" : "Ring my phone"}
              </button>
            )}
            {step === "NUMBER" && (
              <button type="button" className="btn btn--ink" disabled={pending || !phone.trim()} onClick={send}>
                {pending ? "Sending" : "Send code"}
              </button>
            )}
            {step === "CODE" && (
              <button type="button" className="btn btn--ink" disabled={pending || code.replace(/\s/g, "").length !== 6} onClick={confirm}>
                {pending ? "Checking" : "Confirm number"}
              </button>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
