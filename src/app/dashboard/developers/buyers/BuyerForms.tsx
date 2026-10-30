"use client";

import { useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useKeptSubmit } from "@/components/KeptForm";
import type { WorkspaceResult } from "@/lib/partner-workspace";
import { bookVisitAction, registerBuyerAction } from "@/app/workspace/actions";

function Note({ state }: { state: WorkspaceResult | null }) {
  if (!state) return null;
  const tone = state.tone === "ok" ? "note--info" : state.tone === "info" ? "note--warn" : state.ok ? "note--info" : "note--risk";
  return (
    <p className={`note ${tone}`} role={state.ok ? "status" : "alert"}>
      {state.message}
    </p>
  );
}

export type ProjectChoice = { value: string; developer: string; project: string };

/**
 * Register a buyer on a project the firm is empanelled on. The verdict is
 * the developer's own and comes back as it is decided: registered with the
 * day it runs to, already the firm's, or refused and why. The project stays
 * chosen for the next buyer; the name and number clear.
 */
export function RegisterForm({ projects }: { projects: ProjectChoice[] }) {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [state, dispatch, pending] = useActionState<WorkspaceResult | null, FormData>(registerBuyerAction, null);
  const onSubmit = useKeptSubmit(dispatch);
  useEffect(() => {
    if (!state) return;
    router.refresh();
    if (state.ok && ref.current) {
      for (const n of ["name", "phone"]) {
        const el = ref.current.elements.namedItem(n);
        if (el instanceof HTMLInputElement) el.value = "";
      }
    }
  }, [state, router]);
  const developers = [...new Set(projects.map((p) => p.developer))];
  return (
    <form ref={ref} action={dispatch} onSubmit={onSubmit} className="fw-form" noValidate>
      <Note state={state} />
      <label className="fw-field">
        <span className="mv-label">Project</span>
        <select name="project" className="mv-input" defaultValue={projects.length === 1 ? projects[0].value : ""} required>
          {projects.length > 1 && (
            <option value="" disabled>
              Choose
            </option>
          )}
          {developers.map((d) => (
            <optgroup key={d} label={d}>
              {projects
                .filter((p) => p.developer === d)
                .map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.project}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="fw-field">
        <span className="mv-label">Buyer&rsquo;s name</span>
        <input name="name" className="mv-input" placeholder="Priya Sharma" maxLength={120} autoComplete="off" />
      </label>
      <label className="fw-field">
        <span className="mv-label">Buyer&rsquo;s mobile</span>
        <input name="phone" type="tel" inputMode="tel" className="mv-input" placeholder="98765 43210" required autoComplete="off" />
      </label>
      <div className="fw-form__acts">
        <Link href="/dashboard/developers/buyers" className="btn btn--ghost">
          Close
        </Link>
        <button type="submit" className="btn btn--ink" disabled={pending}>
          {pending ? "Registering" : "Register buyer"}
        </button>
      </div>
    </form>
  );
}

/** A site visit for one of the firm's live buyers, at a tower of that buyer's project. */
export function BookForm({
  registrationId,
  towers,
  slots,
  today,
}: {
  registrationId: string;
  towers: { value: string; name: string }[];
  slots: { value: string; label: string }[];
  today: string;
}) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState<WorkspaceResult | null, FormData>(bookVisitAction, null);
  const onSubmit = useKeptSubmit(dispatch);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  if (state?.ok) {
    return (
      <div className="fw-form">
        <Note state={state} />
        <div className="fw-form__acts">
          <Link href="/dashboard/developers/buyers" className="btn btn--ink">
            Done
          </Link>
        </div>
      </div>
    );
  }
  return (
    <form action={dispatch} onSubmit={onSubmit} className="fw-form" noValidate>
      <Note state={state} />
      <input type="hidden" name="registration" value={registrationId} />
      <label className="fw-field">
        <span className="mv-label">Tower</span>
        <select name="tower" className="mv-input" defaultValue={towers.length === 1 ? towers[0].value : ""} required>
          {towers.length > 1 && (
            <option value="" disabled>
              Choose
            </option>
          )}
          {towers.map((t) => (
            <option key={t.value} value={t.value}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="fw-field">
        <span className="mv-label">Day</span>
        <input name="date" type="date" className="mv-input" min={today} defaultValue="" required />
      </label>
      <label className="fw-field">
        <span className="mv-label">Time</span>
        <select name="time" className="mv-input" defaultValue="" required>
          <option value="" disabled>
            Choose
          </option>
          {slots.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="fw-form__acts">
        <Link href="/dashboard/developers/buyers" className="btn btn--ghost">
          Cancel
        </Link>
        <button type="submit" className="btn btn--ink" disabled={pending}>
          {pending ? "Booking" : "Book the visit"}
        </button>
      </div>
    </form>
  );
}
