"use client";

import { useActionState } from "react";
import { recordMilestoneAction, type MilestoneResult } from "@/app/actions/attribution";

/**
 * The next thing a booked lead can record: the agreement, then the
 * registration. One date and one button, which says what it saves.
 */
export function MilestoneForm({ leadId, kind, label, today }: { leadId: string; kind: string; label: string; today: string }) {
  const [said, action, busy] = useActionState<MilestoneResult | null, FormData>(recordMilestoneAction, null);
  const id = `ld-ms-${kind}`;
  return (
    <form action={action} className="ld-ms">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="kind" value={kind} />
      <label htmlFor={id} className="ld-ms__label">
        {label} on
      </label>
      <div className="ld-ms__row">
        <input id={id} className="mv-input ld-ms__date tnum" type="date" name="day" max={today} defaultValue={today} required />
        <button type="submit" className="btn btn--ink btn--sm" disabled={busy}>
          {busy ? "Saving" : kind === "REGISTERED" ? "Record the registration" : "Record the agreement"}
        </button>
      </div>
      {said && !said.ok && (
        <p className="ld-ms__err" role="alert">
          {said.message}
        </p>
      )}
    </form>
  );
}
