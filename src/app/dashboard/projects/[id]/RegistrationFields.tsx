"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { ArrowUpRight } from "@/components/icons";
import { lookupRegistrationAction } from "@/app/actions/rera";

export type StateOption = {
  code: string;
  name: string;
  authority: string;
  /** A real number of the state's shape, when one is known. */
  hint: string | null;
  /** The portal is asked about the number while the person waits. */
  checked: boolean;
  /** The state prints the local building permit number on every ad. */
  permit: boolean;
};

/**
 * The registration form's fields, which follow the state chosen.
 *
 * The number's placeholder is that state's own shape, because a Karnataka
 * number looks nothing like a Maharashtra one and a placeholder showing the
 * wrong one reads as an instruction. Telangana's ads carry the building
 * permit number, so its field appears only there. The inputs stay
 * uncontrolled: the form posts what is in them, whatever set it.
 */
export function RegistrationFields({
  phases,
  states,
  entityName,
  phaseId,
  known = {},
}: {
  phases: { id: string; name: string }[];
  states: StateOption[];
  entityName: string;
  /** The phase to start on, when the person came here for one. */
  phaseId?: string;
  /** What an attached certificate printed, per phase. */
  known?: Record<string, { number: string | null; validTo: string | null; registeredOn?: string | null }>;
}) {
  const first = phaseId ?? phases[0]?.id ?? "";
  const [fromCert, setFromCert] = useState(!!known[first]?.number);
  const [code, setCode] = useState("MH");
  const state = states.find((s) => s.code === code) ?? states[0];
  const phaseRef = useRef<HTMLSelectElement>(null);
  const numberRef = useRef<HTMLInputElement>(null);
  const validRef = useRef<HTMLInputElement>(null);
  const regOnRef = useRef<HTMLInputElement>(null);
  const promoterRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const [looking, startLook] = useTransition();
  const [found, setFound] = useState<{ ok: boolean; text: string } | null>(null);

  // Fill the boxes from the authority's own record. Every box stays editable,
  // and recording asks the portal again.
  const lookUp = (auto = false) => {
    const registrationNo = numberRef.current?.value.trim() ?? "";
    if (!registrationNo) {
      setFound({ ok: false, text: "Type the registration number first." });
      return;
    }
    startLook(async () => {
      const r = await lookupRegistrationAction({ phaseId: phaseRef.current?.value ?? "", stateCode: code, registrationNo });
      if (!r.ok) {
        // An automatic check on a form the certificate already filled stays
        // quiet when the portal did not answer: the boxes are right as they are.
        setFound(auto && r.unknown ? null : { ok: false, text: r.message });
        return;
      }
      const f = r.fill;
      const put = (el: HTMLInputElement | null, v: string | null) => {
        if (el && v) el.value = v;
      };
      put(validRef.current, f.validTo);
      put(regOnRef.current, f.registeredOn);
      put(promoterRef.current, f.promoterName);
      put(reasonRef.current, f.reason);
      const what = [f.projectName, f.promoterName ? `by ${f.promoterName}` : null].filter(Boolean).join(" ");
      setFound(
        f.otherPromoter
          ? { ok: false, text: `Found ${what}. That is not ${entityName}, so it cannot be recorded here.` }
          : { ok: true, text: `Found ${what || registrationNo}. Check the details below, then record.` },
      );
    });
  };

  // A number read off an attached certificate is looked up at once, so the
  // dates and the promoter come from the authority's record, not the person.
  const [asked, setAsked] = useState<string | null>(null);
  const [phase, setPhase] = useState(first);
  useEffect(() => {
    const n = numberRef.current?.value.trim() ?? "";
    const key = `${phaseRef.current?.value ?? ""}:${n}`;
    if (!fromCert || !n || !state?.checked || asked === key) return;
    setAsked(key);
    lookUp(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromCert, code, asked, phase]);

  return (
    <>
      <div className="roleform__pair">
        <div className="field">
          <label htmlFor="phaseId">Phase</label>
          <select
            id="phaseId"
            name="phaseId"
            className="select-field"
            defaultValue={phaseId}
            required
            ref={phaseRef}
            onChange={(e) => {
              // Another phase starts from its own certificate, or from nothing.
              const k = known[e.target.value];
              if (numberRef.current) numberRef.current.value = k?.number ?? "";
              if (validRef.current) validRef.current.value = k?.validTo ?? "";
              if (regOnRef.current) regOnRef.current.value = k?.registeredOn ?? "";
              if (reasonRef.current && !k?.number) reasonRef.current.value = "";
              else if (reasonRef.current && k?.number && !reasonRef.current.value) reasonRef.current.value = "Read on the RERA certificate";
              setFromCert(!!k?.number);
              setPhase(e.target.value);
              setFound(null);
            }}
          >
            {phases.map((ph) => (
              <option key={ph.id} value={ph.id}>
                {ph.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="stateCode">State</label>
          <select
            id="stateCode"
            name="stateCode"
            className="select-field"
            defaultValue="MH"
            required
            onChange={(e) => {
              setCode(e.target.value);
              setFound(null);
            }}
          >
            {states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="roleform__pair">
        <div className="field">
          <label htmlFor="registrationNo">Registration number</label>
          <div className="reglookup">
            <input
              id="registrationNo"
              type="text"
              name="registrationNo"
              placeholder={state.hint ?? "As printed on the certificate"}
              maxLength={130}
              required
              ref={numberRef}
              defaultValue={known[first]?.number ?? ""}
              onChange={() => {
                setFound(null);
                setFromCert(false);
              }}
            />
            {state.checked && (
              <button type="button" className="btn btn--ghost" onClick={() => lookUp()} disabled={looking} aria-busy={looking}>
                {looking ? `Reading ${state.authority}` : "Fill from number"}
              </button>
            )}
          </div>
          {found ? (
            <p className={found.ok ? "hint" : "hint hint--warn"} role="status">
              {found.text}
            </p>
          ) : fromCert ? (
            <p className="hint">{looking ? `From the certificate you attached. Checking it with ${state.authority}.` : "From the certificate you attached."}</p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="validTo">Valid to</label>
          <input id="validTo" type="date" name="validTo" required className="select-field" ref={validRef} defaultValue={known[first]?.validTo ?? ""} />
        </div>
      </div>

      <div className="roleform__pair">
        <div className="field">
          <label htmlFor="registeredOn">Registered on (optional)</label>
          <input id="registeredOn" type="date" name="registeredOn" className="select-field" ref={regOnRef} defaultValue={known[first]?.registeredOn ?? ""} />
        </div>
        {state.permit ? (
          <div className="field">
            <label htmlFor="permitNo">Building permit number</label>
            <input
              id="permitNo"
              type="text"
              name="permitNo"
              placeholder="As printed on the HMDA, GHMC or DTCP permit"
              maxLength={80}
            />
          </div>
        ) : (
          <div className="field" aria-hidden="true" />
        )}
      </div>

      <div className="field">
        <label htmlFor="promoterName">Promoter name, as it reads on the portal</label>
        <input
          id="promoterName"
          type="text"
          name="promoterName"
          placeholder={entityName}
          defaultValue={entityName}
          maxLength={200}
          required
          ref={promoterRef}
        />
        <p className="hint">Must match {entityName}.</p>
      </div>

      <div className="field">
        <label htmlFor="reason">What you checked</label>
        <input
          id="reason"
          type="text"
          name="reason"
          placeholder="Read on the certificate, status active"
          defaultValue={known[first]?.number ? "Read on the RERA certificate" : ""}
          maxLength={300}
          required
          ref={reasonRef}
        />
        <p className="hint">Recorded with your name.</p>
      </div>

      <Submit checking={state.checked ? state.authority : null} />
    </>
  );
}

/**
 * Recording a number asks the state's portal first, which can take several
 * seconds, and a button that sat there unchanged for that long read as a
 * press that had not landed.
 */
function Submit({ checking }: { checking: string | null }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn--ink" disabled={pending} aria-busy={pending}>
      {pending ? (checking ? `Checking ${checking}` : "Recording") : "Record as verified"}
      {!pending && <ArrowUpRight size={14} />}
    </button>
  );
}
