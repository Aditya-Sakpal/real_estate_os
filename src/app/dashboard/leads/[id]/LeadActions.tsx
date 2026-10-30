"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Close, Phone } from "@/components/icons";
import { callLeadNowAction, sendLocationAction, type ActionResult } from "@/app/actions/leads";
import { useKeptSubmit } from "@/components/KeptForm";
import { ProxyCall } from "./ProxyCall";

/** A control the viewer may use, and why it cannot be pressed right now. */
type Control = { blocked: string | null };

/**
 * The lead's actions, at the top of the page: the call first, the location
 * beside it. Each is left out when the viewer may not do it at this tower,
 * and drawn disabled with the reason when it cannot be done right now. What
 * the server said about the last press sits under both, because a refusal
 * ("outside calling hours") only helps next to the button that caused it.
 */
export function LeadActions({
  leadId,
  leadName,
  call,
  goals,
  towers = [],
  enquired = null,
  location,
  proxy = null,
}: {
  leadId: string;
  leadName: string;
  /** Null when the viewer may not call this lead. */
  call: Control | null;
  /** Goals to suggest for a call. Null when calls with a goal are not switched on. */
  goals: string[] | null;
  /** The towers this person may call about, for a call with a goal. */
  towers?: { id: string; label: string }[];
  /** The tower the buyer enquired about. */
  enquired?: string | null;
  /** Null when the viewer may not message this lead. */
  location: Control | null;
  /** Calling from one's own phone through our number. Null when the viewer may not call. */
  proxy?: (Control & { own: string | null }) | null;
}) {
  const [callState, callAction, calling] = useActionState<ActionResult | null, FormData>(callLeadNowAction, null);
  const [locState, locAction, sending] = useActionState<ActionResult | null, FormData>(sendLocationAction, null);
  const [said, setSaid] = useState<ActionResult | null>(null);

  // Whichever answered last is the one on screen.
  useEffect(() => {
    if (callState) setSaid(callState);
  }, [callState]);
  useEffect(() => {
    if (locState) setSaid(locState);
  }, [locState]);

  const reasons = [...new Set([call?.blocked, location?.blocked, proxy?.blocked].filter((r): r is string => Boolean(r)))];
  const whyId = `ld-why-${leadId}`;

  return (
    <div className="ld-acts">
      <div className="ld-acts__row">
        {call && (
          <form action={callAction}>
            <input type="hidden" name="leadId" value={leadId} />
            <button
              type="submit"
              className="btn btn--ink"
              disabled={Boolean(call.blocked) || calling}
              aria-describedby={call.blocked ? whyId : undefined}
            >
              <Phone size={15} />
              {calling ? "Calling" : "Call now"}
            </button>
          </form>
        )}
        {call && goals && (
          <GoalCall
            leadId={leadId}
            leadName={leadName}
            suggestions={goals}
            towers={towers}
            enquired={enquired}
            blocked={call.blocked}
            whyId={whyId}
            onSaid={setSaid}
          />
        )}
        {proxy && (
          <ProxyCall leadId={leadId} leadName={leadName} own={proxy.own} blocked={proxy.blocked} whyId={whyId} />
        )}
        {location && (
          <form action={locAction}>
            <input type="hidden" name="leadId" value={leadId} />
            <button
              type="submit"
              className="btn btn--ghost"
              disabled={Boolean(location.blocked) || sending}
              aria-describedby={location.blocked ? whyId : undefined}
            >
              {sending ? "Sending" : "Send site location on WhatsApp"}
            </button>
          </form>
        )}
      </div>
      {reasons.length > 0 && (
        <p id={whyId} className="ld-acts__why">
          {reasons.join(". ")}
        </p>
      )}
      <div role="status" aria-live="polite">
        {said && <p className={`ld-acts__said ${said.ok ? "is-ok" : "is-err"}`}>{said.message}</p>}
      </div>
    </div>
  );
}

/**
 * Call with a goal: the agent is sent to do one thing, in the person's own
 * words, with the usual goals as chips. A native dialog, so it traps focus
 * and Escape closes it; the result is said inside it, next to the button.
 */
function GoalCall({
  leadId,
  leadName,
  suggestions,
  towers,
  enquired,
  blocked,
  whyId,
  onSaid,
}: {
  leadId: string;
  leadName: string;
  suggestions: string[];
  towers: { id: string; label: string }[];
  enquired: string | null;
  blocked: string | null;
  whyId: string;
  onSaid: (r: ActionResult) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [goal, setGoal] = useState("");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(callLeadNowAction, null);
  const keep = useKeptSubmit(action);
  const first = leadName.trim().split(/\s+/)[0] || leadName;

  useEffect(() => {
    if (!state) return;
    onSaid(state);
    if (state.ok) {
      setGoal("");
      ref.current?.close();
    }
  }, [state, onSaid]);

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost"
        disabled={Boolean(blocked)}
        aria-describedby={blocked ? whyId : undefined}
        onClick={() => ref.current?.showModal()}
      >
        Call with a goal
      </button>
      <dialog ref={ref} className="cl-dialog" aria-labelledby={`gc-title-${leadId}`}>
        <form action={action} onSubmit={keep} className="cl-form">
          <div className="cl-head">
            <h2 id={`gc-title-${leadId}`}>Call {first} with a goal</h2>
            <button type="button" className="btn btn--icon" aria-label="Close" onClick={() => ref.current?.close()}>
              <Close size={14} />
            </button>
          </div>
          <input type="hidden" name="leadId" value={leadId} />
          <div>
            <label htmlFor={`gc-goal-${leadId}`}>What should the call do?</label>
            <textarea
              id={`gc-goal-${leadId}`}
              name="goal"
              className="formfield__input gc-goal"
              rows={3}
              maxLength={240}
              required
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Invite them for a site visit tomorrow evening"
            />
            <div className="hookfield__chips">
              {suggestions.map((s) => {
                const chosen = goal.trim().toLowerCase() === s.toLowerCase();
                return (
                  <button
                    key={s}
                    type="button"
                    className={`hookchip${chosen ? " hookchip--on" : ""}`}
                    aria-pressed={chosen}
                    onClick={() => setGoal(chosen ? "" : s)}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
          {towers.length > 1 && enquired && towers.some((t) => t.id === enquired) && (
            <div>
              <label htmlFor={`gc-about-${leadId}`}>About which project?</label>
              <select id={`gc-about-${leadId}`} name="about" className="cl-select" defaultValue={enquired}>
                {towers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id === enquired ? `${t.label} (enquired about)` : t.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {state && !state.ok && (
            <p className="note note--risk" role="status">
              {state.message}
            </p>
          )}
          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={() => ref.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending || !goal.trim()}>
              <Phone size={15} />
              {pending ? "Calling" : "Call now"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/** A form's submit button that says it is working while the form is. */
export function PendingButton({
  children,
  pending,
  className,
}: {
  children: ReactNode;
  /** What the button says while the form is being sent. */
  pending: string;
  className: string;
}) {
  const { pending: busy } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={busy}>
      {busy ? pending : children}
    </button>
  );
}

/** While a call is ringing or talking, look again every ten seconds. */
export function LiveRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
