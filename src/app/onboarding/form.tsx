"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createOrgAction, joinExistingOrgAction, type OnboardingState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn--ink" type="submit" disabled={pending} style={{ width: "100%" }}>
      {pending ? "Creating organisation…" : "Create organisation"}
    </button>
  );
}

export function OrgForm({ another = false }: { another?: boolean }) {
  const [state, action] = useActionState<OnboardingState, FormData>(createOrgAction, {});
  const v = state.values;

  return (
    <>
      {state.error && !state.existing && (
        <div className="note note--risk" role="alert">
          {state.error}
        </div>
      )}

      {state.existing && (
        <div className="note note--info" role="alert">
          <strong>{state.existing.displayName} is already registered</strong>
          That GSTIN belongs to an organisation already on Sales Desk. Ask to be
          added instead of creating a second one.
          <form action={joinExistingOrgAction} style={{ marginTop: 12 }}>
            <input type="hidden" name="gstin" value={v?.gstin ?? ""} />
            <button type="submit" className="btn btn--ghost">Request access to {state.existing.displayName}</button>
          </form>
        </div>
      )}

      <form action={action}>
        {another && <input type="hidden" name="another" value="1" />}
        <div className="field">
          <label htmlFor="legalName">Registered legal name</label>
          <input
            id="legalName"
            name="legalName"
            type="text"
            required
            autoComplete="organization"
            defaultValue={v?.legalName}
            placeholder="Riverstone Homes Private Limited"
          />
          <p className="hint">Exactly as on the GST certificate.</p>
        </div>

        <div className="field">
          <label htmlFor="displayName">Display name</label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            defaultValue={v?.displayName}
            placeholder="Riverstone Homes"
          />
          <p className="hint">What your team sees in the console. Defaults to the legal name.</p>
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="gstin">GSTIN</label>
            <input
              id="gstin"
              name="gstin"
              type="text"
              maxLength={15}
              spellCheck={false}
              autoCapitalize="characters"
              defaultValue={v?.gstin}
              placeholder="27ABCCD1234E1Z5"
            />
            <p className="hint">Checked against the GST check digit.</p>
          </div>

          <div className="field">
            <label htmlFor="pan">PAN</label>
            <input
              id="pan"
              name="pan"
              type="text"
              required
              maxLength={10}
              spellCheck={false}
              autoCapitalize="characters"
              defaultValue={v?.pan}
              placeholder="ABCCD1234E"
            />
            <p className="hint">Must match the PAN inside the GSTIN.</p>
          </div>
        </div>

        <Submit />
      </form>

      <p className="foot">
        Next: add the companies your projects register under, then your first
        project.
      </p>
    </>
  );
}
