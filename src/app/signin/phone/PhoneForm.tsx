"use client";

import { useActionState } from "react";
import { phoneSignInAction, type PhoneSignInState } from "./actions";

/** The number, then the code. One field and one button at a time, sized for a thumb. */
export function PhoneForm() {
  const [state, submit, pending] = useActionState<PhoneSignInState, FormData>(phoneSignInAction, { step: "PHONE", phone: "" });

  if (state.step === "CODE") {
    return (
      <form action={submit} className="phonesign">
        <input type="hidden" name="phone" value={state.phone} />
        <input type="hidden" name="challengeId" value={state.challengeId} />
        <div className="note note--info" role="status">
          {state.message}
        </div>
        <div className="field">
          <label htmlFor="ps-code">6-digit code</label>
          <input
            id="ps-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            required
            autoFocus
            placeholder="123456"
            className="phonesign__input tnum"
          />
          {state.error && (
            <p className="fielderr" role="alert">
              {state.error}
            </p>
          )}
        </div>
        <button type="submit" name="intent" value="verify" className="btn btn--ink phonesign__go" disabled={pending}>
          {pending ? "Signing in" : "Sign in"}
        </button>
        <button type="submit" name="intent" value="send" className="phonesign__again" disabled={pending} formNoValidate>
          Send a new code
        </button>
      </form>
    );
  }

  return (
    <form action={submit} className="phonesign">
      <div className="field">
        <label htmlFor="ps-phone">Your WhatsApp number</label>
        <input
          id="ps-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          autoFocus
          defaultValue={state.phone}
          placeholder="98765 43210"
          className="phonesign__input tnum"
        />
        {state.error && (
          <p className="fielderr" role="alert">
            {state.error}
          </p>
        )}
      </div>
      <button type="submit" name="intent" value="send" className="btn btn--ink phonesign__go" disabled={pending}>
        {pending ? "Sending" : "Send code on WhatsApp"}
      </button>
    </form>
  );
}
