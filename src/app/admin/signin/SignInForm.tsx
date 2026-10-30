"use client";

import { useActionState } from "react";
import { requestLink, type SignInState } from "./actions";

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(requestLink, { sent: false });
  if (state.sent) {
    return <p className="adm-note-line">If that address may sign in, a link is on its way. Open it on this device.</p>;
  }
  return (
    <form action={action} className="adm-form">
      <label htmlFor="email">Your email</label>
      <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@salesdesk.app" />
      {state.error && <p className="adm-note-line adm-note-line--risk">{state.error}</p>}
      <button type="submit" className="btn btn--ink" disabled={pending}>
        {pending ? "Sending" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
