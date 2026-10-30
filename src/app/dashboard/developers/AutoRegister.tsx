"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useKeptSubmit } from "@/components/KeptForm";
import { autoRegisterAction, linkOwnProjectAction, type ClaimFormState } from "@/app/actions/partner-claims";

/** The firm's own switch: register its captured leads with the developer as they come in. */
export function AutoRegisterSwitch({ on, linked }: { on: boolean; linked: number }) {
  const router = useRouter();
  const [state, submit, pending] = useActionState<ClaimFormState, FormData>(autoRegisterAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={submit} onSubmit={keep} className="fw-open__row" style={{ listStyle: "none" }}>
      <input type="hidden" name="on" value={on ? "OFF" : "ON"} />
      <span className="fw-open__what">
        <span className="fw-open__dev">{on ? "New leads are registered with the developer" : "Register new leads yourself"}</span>
        <span className="fw-open__line">
          {linked === 0
            ? "Link one of your projects to a developer's project below first."
            : on
              ? `Leads in your ${linked === 1 ? "linked project are" : `${linked} linked projects are`} registered as they come in.`
              : "Or have every new lead in a linked project registered as it comes in."}
        </span>
      </span>
      <button type="submit" className={on ? "btn btn--ghost btn--sm" : "btn btn--ink btn--sm"} disabled={pending || (!on && linked === 0)}>
        {pending ? "Saving" : on ? "Stop" : "Register them for me"}
      </button>
      {state && !state.ok && (
        <p className="mv-err" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Which of the firm's own projects is this developer's project. */
export function OwnProjectLink({
  devOrgId,
  devProjectId,
  current,
  projects,
}: {
  devOrgId: string;
  devProjectId: string;
  current: string | null;
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [state, submit, pending] = useActionState<ClaimFormState, FormData>(linkOwnProjectAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  const id = `own-${devProjectId}`;
  return (
    <form action={submit} onSubmit={keep} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
      <input type="hidden" name="devOrgId" value={devOrgId} />
      <input type="hidden" name="devProjectId" value={devProjectId} />
      <label htmlFor={id} className="fw-buyer__line">
        Your project for these leads
      </label>
      <select id={id} name="ownProjectId" className="cl-select" defaultValue={current ?? ""} key={current ?? ""}>
        <option value="">None</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="submit" className="btn btn--ghost btn--sm" disabled={pending}>
        {pending ? "Saving" : "Save"}
      </button>
      {state && !state.ok && (
        <p className="mv-err" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
