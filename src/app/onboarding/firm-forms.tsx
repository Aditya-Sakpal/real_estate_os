"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  createMandateFirmAction,
  joinExistingOrgAction,
  partnerAction,
  type FirmState,
} from "./actions";

/**
 * The sign-up forms for a mandate firm and a channel partner. A refusal
 * keeps what was typed and names each field it is about; a channel partner
 * gives its WhatsApp number, gets a code on it, and types the code here.
 */

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn--ink" type="submit" disabled={pending} style={{ width: "100%" }}>
      {pending ? busy : label}
    </button>
  );
}

function Err({ text }: { text?: string }) {
  return text ? <p className="fielderr">{text}</p> : null;
}

function Existing({ state }: { state: FirmState }) {
  if (!state.existing) return null;
  const x = state.existing;
  const byNumber = x.matchedOn === "PAN" || x.matchedOn === "GSTIN";
  return (
    <div className="note note--info" role="alert">
      <strong>{byNumber ? state.error : `${x.displayName} is already on Sales Desk`}</strong>
      {byNumber
        ? `Check the ${x.matchedOn === "GSTIN" ? "numbers" : "PAN"}. If you work at ${x.displayName}, ask to be added instead.`
        : "Someone at your company set it up. Ask to be added instead of creating a second one."}
      <form action={joinExistingOrgAction} style={{ marginTop: 12 }}>
        <input type="hidden" name="gstin" value={state.values?.gstin ?? ""} />
        <input type="hidden" name="pan" value={state.values?.pan ?? ""} />
        <button type="submit" className="btn btn--ghost">Ask {x.displayName} to add me</button>
      </form>
    </div>
  );
}

function Fields({ state, phoneRequired }: { state: FirmState; phoneRequired: boolean }) {
  const v = state.values ?? {};
  const e = state.errors ?? {};
  // A broker firm reads like one: the example is the kind of company filling it in.
  const ex = phoneRequired
    ? { legal: "Keystone Realty LLP", display: "Keystone Realty", pan: "ABCFK1234L", gstin: "27ABCFK1234L1Z5" }
    : { legal: "Guardians Real Estate Advisory Private Limited", display: "Guardians", pan: "ABCFG1234H", gstin: "27ABCFG1234H1Z5" };
  return (
    <>
      <div className="field">
        <label htmlFor="legalName">Registered legal name</label>
        <input id="legalName" name="legalName" type="text" required defaultValue={v.legalName} placeholder={ex.legal} autoComplete="organization" />
        <Err text={e.legalName} />
      </div>
      <div className="field">
        <label htmlFor="displayName">Display name</label>
        <input id="displayName" name="displayName" type="text" defaultValue={v.displayName} placeholder={ex.display} />
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="pan">PAN</label>
          <input id="pan" name="pan" type="text" required maxLength={10} spellCheck={false} autoCapitalize="characters" defaultValue={v.pan} placeholder={ex.pan} />
          <Err text={e.pan} />
        </div>
        <div className="field">
          <label htmlFor="gstin">GSTIN (if registered)</label>
          <input id="gstin" name="gstin" type="text" maxLength={15} spellCheck={false} autoCapitalize="characters" defaultValue={v.gstin} placeholder={ex.gstin} />
          <Err text={e.gstin} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="reraNo">MahaRERA agent number</label>
          <input id="reraNo" name="reraNo" type="text" required maxLength={12} spellCheck={false} autoCapitalize="characters" defaultValue={v.reraNo} placeholder="A51700001835" />
          <Err text={e.reraNo} />
        </div>
        <div className="field">
          <label htmlFor="reraTill">Valid until</label>
          <input id="reraTill" name="reraTill" type="date" defaultValue={v.reraTill} />
          <Err text={e.reraTill} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="city">City</label>
          <input id="city" name="city" type="text" maxLength={80} defaultValue={v.city} placeholder="Pune" />
        </div>
        <div className="field">
          <label htmlFor="phone">{phoneRequired ? "Firm's WhatsApp number" : "Phone number"}</label>
          <input id="phone" name="phone" type="tel" inputMode="tel" required={phoneRequired} maxLength={20} defaultValue={v.phone} placeholder="98765 43210" />
          <Err text={e.phone} />
        </div>
      </div>
    </>
  );
}

export function MandateFirmForm({ another = false }: { another?: boolean }) {
  const [state, action] = useActionState<FirmState, FormData>(createMandateFirmAction, {});
  return (
    <>
      {state.error && !state.existing && (
        <div className="note note--risk" role="alert">
          {state.error}
        </div>
      )}
      <Existing state={state} />
      <form action={action}>
        {another && <input type="hidden" name="another" value="1" />}
        <Fields state={state} phoneRequired={false} />
        <Submit label="Create the mandate firm" busy="Creating…" />
      </form>
    </>
  );
}

export function PartnerForm({ another = false, skipCode = false }: { another?: boolean; skipCode?: boolean }) {
  const [state, action] = useActionState<FirmState, FormData>(partnerAction, {});

  if (state.challengeId) {
    const v = state.values ?? {};
    return (
      <>
        <div className="note note--info" role="status">
          <strong>Code sent on WhatsApp</strong>
          To {v.phone}. It is valid for five minutes.
          {state.claiming ? " A developer already added your firm; this claims it." : ""}
        </div>
        <form action={action}>
          {another && <input type="hidden" name="another" value="1" />}
          <input type="hidden" name="step" value="code" />
          <input type="hidden" name="challengeId" value={state.challengeId} />
          {Object.entries(v).map(([k, val]) => (
            <input key={k} type="hidden" name={k} value={val} />
          ))}
          <div className="field">
            <label htmlFor="code">6-digit code</label>
            <input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              required
              autoFocus
              placeholder="123456"
            />
            <Err text={state.errors?.code} />
          </div>
          <Submit label="Confirm and create the firm" busy="Confirming…" />
        </form>
      </>
    );
  }

  return (
    <>
      {state.error && !state.existing && (
        <div className="note note--risk" role="alert">
          {state.error}
        </div>
      )}
      <Existing state={state} />
      <form action={action}>
        {another && <input type="hidden" name="another" value="1" />}
        <Fields state={state} phoneRequired />
        {skipCode ? <Submit label="Set up the firm" busy="Setting up…" /> : <Submit label="Send the code" busy="Sending…" />}
      </form>
    </>
  );
}
