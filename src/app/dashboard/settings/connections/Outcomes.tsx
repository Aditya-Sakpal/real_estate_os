"use client";

import { useActionState } from "react";
import { saveValuesAction, type MilestoneResult } from "@/app/actions/attribution";

/**
 * What each outcome is worth to the ads, and how long a booking waits
 * before it is sent. Four numbers and one button, shown only to somebody
 * holding the budget key; everybody else reads the same four numbers.
 */
export function ValuesForm({ values }: { values: { qualified: number; visit: number; booking: number; holdDays: number } }) {
  const [said, action, busy] = useActionState<MilestoneResult | null, FormData>(saveValuesAction, null);
  const field = (name: string, label: string, value: number, suffix: string) => (
    <label className="out-val">
      <span className="out-val__label">{label}</span>
      <span className="out-val__row">
        {suffix === "Rs" && <span className="out-val__unit">Rs</span>}
        <input className="mv-input tnum" name={name} inputMode="numeric" defaultValue={value.toLocaleString("en-IN")} required />
        {suffix === "days" && <span className="out-val__unit">days</span>}
      </span>
    </label>
  );
  return (
    <form action={action} className="out-form">
      <div className="out-vals">
        {field("qualified", "Qualified lead", values.qualified, "Rs")}
        {field("visit", "Site visit done", values.visit, "Rs")}
        {field("booking", "Booking", values.booking, "Rs")}
        {field("holdDays", "Bookings wait", values.holdDays, "days")}
      </div>
      <div className="out-form__foot">
        {said && (
          <p className={said.ok ? "out-form__ok" : "out-form__err"} role={said.ok ? "status" : "alert"}>
            {said.message}
          </p>
        )}
        <button type="submit" className="btn btn--ink btn--sm" disabled={busy}>
          {busy ? "Saving" : "Save values"}
        </button>
      </div>
    </form>
  );
}
