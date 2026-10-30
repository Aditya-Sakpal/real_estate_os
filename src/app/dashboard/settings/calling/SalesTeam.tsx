"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  addTeamMemberAction,
  removeTeamMemberAction,
  setOnDutyAction,
  type CallingFormState,
} from "@/app/actions/calling";
import { showPhone } from "@/lib/call-rules";
import type { SalesPerson } from "@/lib/calling";
import { ConfirmAction } from "@/components/ConfirmAction";
import { useKeptSubmit } from "@/components/KeptForm";

/**
 * Who a ready buyer is put through to. Each call goes to whoever on duty is
 * free and has waited longest; with nobody on duty, to the hand-off number.
 */
export function SalesTeam({ team, fallback }: { team: SalesPerson[]; fallback: string | null }) {
  const [state, add, pending] = useActionState<CallingFormState, FormData>(addTeamMemberAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  // A refused name and number stay in the boxes; an added one clears them.
  const keep = useKeptSubmit(add);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const onDuty = team.filter((p) => p.onDuty).length;

  return (
    <section className="card cs cset" aria-labelledby="team-title" data-sales-team>
      <div className="cset__head">
        <h2 id="team-title">Sales team</h2>
        <span className="pill pill--quiet">
          {team.length ? `${onDuty} of ${team.length} on duty` : "Nobody yet"}
        </span>
      </div>

      {team.length === 0 && (
        <p className="cs-row__sub cst-empty">
          {fallback
            ? `Every ready buyer goes to ${showPhone(fallback)} until somebody is added.`
            : "Add the people who take ready buyers."}
        </p>
      )}

      {team.map((p) => (
        <div className="cs-row" key={p.id} data-member={p.phone}>
          <div>
            <p className="cs-row__name">{p.name}</p>
            <p className="cs-row__sub tnum">{showPhone(p.phone)}</p>
          </div>
          <div className="cst-acts">
            <form action={setOnDutyAction}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="onDuty" value={p.onDuty ? "false" : "true"} />
              <button
                type="submit"
                className={`pill ${p.onDuty ? "pill--ok" : "pill--quiet"} cst-duty`}
                aria-label={p.onDuty ? `Take ${p.name} off duty` : `Put ${p.name} on duty`}
              >
                <span className="pill__dot" />
                {p.onDuty ? "On duty" : "Off duty"}
              </button>
            </form>
            <ConfirmAction
              label="Remove"
              title={`Remove ${p.name} from the sales team?`}
              body={<p>Ready buyers are no longer put through to {showPhone(p.phone)}.</p>}
              confirmLabel="Remove from team"
              action={removeTeamMemberAction}
              fields={{ id: p.id }}
              tone="risk"
              testId="remove-salesperson"
            />
          </div>
        </div>
      ))}

      <form ref={formRef} action={add} onSubmit={keep} className="cst-add">
        <div className="field">
          <label htmlFor="team-name">Name</label>
          <input id="team-name" name="name" type="text" maxLength={120} required placeholder="Asha Menon" />
        </div>
        <div className="field">
          <label htmlFor="team-phone">Phone</label>
          <input id="team-phone" name="phone" type="text" inputMode="tel" required placeholder="+91 98765 43210" />
        </div>
        <button type="submit" className="btn btn--ink btn--sm" disabled={pending}>
          {pending ? "Adding" : "Add to team"}
        </button>
      </form>
      {state && !state.ok && (
        <p className="note note--risk" role="alert">
          {state.message}
        </p>
      )}
    </section>
  );
}
