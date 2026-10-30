"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LeadRegistration } from "@/lib/partner-workspace";
import { registerLeadAction } from "@/app/workspace/actions";

const STATE: Record<LeadRegistration["state"], { label: string; tone: string }> = {
  registered: { label: "Registered", tone: "blue" },
  booked: { label: "Booked", tone: "ok" },
  ran_out: { label: "Ran out", tone: "quiet" },
  refused: { label: "Not registered", tone: "risk" },
};

/**
 * A channel partner's own lead, registered with a developer that empanelled
 * it. A buyer is often shown two or three projects, so the same lead may be
 * registered with each. The verdict is the developer's own.
 */
export function RegisterWithDeveloper({
  leadId,
  projects,
  registrations,
  canRegister,
}: {
  leadId: string;
  projects: { value: string; label: string }[];
  /** With `until` already in words. */
  registrations: LeadRegistration[];
  canRegister: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [project, setProject] = useState(projects.length === 1 ? projects[0].value : "");
  const [note, setNote] = useState<{ ok: boolean; message: string; tone?: string } | null>(null);
  return (
    <section className="card ld-card" aria-labelledby="ld-dev-h">
      <div className="card__head">
        <h2 id="ld-dev-h" className="ld-h">
          Registered with developers
        </h2>
      </div>
      {registrations.length > 0 ? (
        <ul className="ld-out">
          {registrations.map((r) => (
            <li key={r.id} className="ld-task">
              <span className="ld-task__what">
                {r.project} <span className="ld-task__when">· {r.developer}</span>
              </span>
              <span className={`pill pill--${STATE[r.state].tone}`}>
                <span className="pill__dot" />
                {r.state === "registered" && r.until ? `Until ${r.until}` : STATE[r.state].label}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sub" style={{ margin: "0 0 12px" }}>
          Not registered with any developer yet.
        </p>
      )}
      {canRegister && projects.length > 0 && (
        <div className="ld-regdev">
          <label className="sr-only" htmlFor={`ld-regdev-${leadId}`}>
            Project
          </label>
          <select id={`ld-regdev-${leadId}`} className="mv-input" value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.length > 1 && (
              <option value="" disabled>
                Choose a project
              </option>
            )}
            {projects.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--ink"
            disabled={pending || !project}
            onClick={() =>
              start(async () => {
                const res = await registerLeadAction({ leadId, project });
                setNote(res);
                router.refresh();
              })
            }
          >
            {pending ? "Registering" : "Register with developer"}
          </button>
        </div>
      )}
      {note && (
        <p className={`note ${note.tone === "ok" ? "note--info" : note.tone === "info" ? "note--warn" : note.ok ? "note--info" : "note--risk"}`} role={note.ok ? "status" : "alert"}>
          {note.message}
        </p>
      )}
    </section>
  );
}
