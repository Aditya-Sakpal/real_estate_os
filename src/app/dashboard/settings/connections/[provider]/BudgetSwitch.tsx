"use client";

import { useFormStatus } from "react-dom";
import { setAutoBudgetAction } from "@/app/actions/leads";

/**
 * One ad account's automatic budget moves, as a switch. Pressing it saves at
 * once; while it saves, it shows the state it is moving to.
 */
export function BudgetSwitch({ accountId, on, name }: { accountId: string; on: boolean; name: string }) {
  return (
    <form action={setAutoBudgetAction} className="bswitch-form">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="on" value={on ? "false" : "true"} />
      <Toggle on={on} name={name} />
    </form>
  );
}

function Toggle({ on, name }: { on: boolean; name: string }) {
  const { pending } = useFormStatus();
  const shown = pending ? !on : on;
  return (
    <button
      type="submit"
      role="switch"
      aria-checked={shown}
      aria-label={`Move budget to the ads that bring buyers, ${name}`}
      aria-busy={pending || undefined}
      className="bswitch"
      disabled={pending}
      data-auto-budget-switch={on ? "on" : "off"}
    >
      <span className="bswitch__track" aria-hidden="true">
        <span className="bswitch__thumb" />
      </span>
      <span className="bswitch__text">{shown ? "On" : "Off"}</span>
    </button>
  );
}
