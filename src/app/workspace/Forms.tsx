"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { saveProfileAction, type WorkspaceFormState } from "./actions";

function Note({ state }: { state: WorkspaceFormState }) {
  if (!state) return null;
  return (
    <p className={`note ${state.ok ? "note--info" : "note--risk"}`} role="status">
      {state.message}
    </p>
  );
}

const err = (state: WorkspaceFormState, k: string) => (state && !state.ok ? state.errors?.[k] : undefined);

export type ProfileValues = { reraNo: string; reraTill: string; city: string; phone: string };

/** The firm's record. It opens read-only; changing it is a decision. */
export function ProfileCard({
  facts,
  values,
  canEdit,
  phoneFixed,
  phoneLabel,
  today,
}: {
  facts: React.ReactNode;
  values: ProfileValues;
  canEdit: boolean;
  phoneFixed: boolean;
  phoneLabel: string;
  today: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [state, submit, pending] = useActionState<WorkspaceFormState, FormData>(saveProfileAction, null);
  useEffect(() => {
    if (state?.ok) {
      setEditing(false);
      router.refresh();
    }
  }, [state, router]);
  return (
    <section className="card fw-card" aria-label="Your firm">
      <div className="fw-card__head">
        <h2>Your firm</h2>
        {canEdit && !editing && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <form action={submit} className="fw-profile" noValidate>
          <label className="fw-field">
            <span className="mv-label">MahaRERA agent number</span>
            <input name="reraNo" className="mv-input pt-mono" defaultValue={values.reraNo} placeholder="A51700012345" autoCapitalize="characters" autoComplete="off" aria-invalid={!!err(state, "reraNo")} required />
            {err(state, "reraNo") && <span className="mv-err">{err(state, "reraNo")}</span>}
          </label>
          <label className="fw-field">
            <span className="mv-label">Registration valid until</span>
            <input name="reraTill" type="date" className="mv-input" min={today} defaultValue={values.reraTill} aria-invalid={!!err(state, "reraTill")} />
            {err(state, "reraTill") && <span className="mv-err">{err(state, "reraTill")}</span>}
          </label>
          <label className="fw-field">
            <span className="mv-label">City</span>
            <input name="city" className="mv-input" defaultValue={values.city} placeholder="Pune" />
          </label>
          {!phoneFixed && (
            <label className="fw-field">
              <span className="mv-label">{phoneLabel}</span>
              <input name="phone" type="tel" className="mv-input" defaultValue={values.phone} placeholder="98765 43210" aria-invalid={!!err(state, "phone")} />
              {err(state, "phone") && <span className="mv-err">{err(state, "phone")}</span>}
            </label>
          )}
          {state && !state.ok && !state.errors && <Note state={state} />}
          <div className="fw-profile__acts">
            <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending}>
              {pending ? "Saving" : "Save"}
            </button>
          </div>
        </form>
      ) : (
        facts
      )}
    </section>
  );
}
