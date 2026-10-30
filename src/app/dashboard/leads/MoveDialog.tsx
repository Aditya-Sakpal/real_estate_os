"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, ChevronRight, Close } from "@/components/icons";
import {
  FIELDS,
  VISIT_SLOTS,
  addDays,
  describeStage,
  digits,
  isPath,
  nowTimeOn,
  pathIndex,
  rupees,
  rupeesShort,
  showDate,
  showTime,
  stageLabel,
  validateMove,
  type Facts,
  type FieldKey,
  type MoveInput,
  type MovePlan,
  type PathStage,
} from "@/lib/lead-rules";
import type { SampleLead } from "@/lib/lead-sample";

/** The verb a move is, which is also what its button says. */
function actionFor(plan: MovePlan): string {
  if (plan.cancelsBooking) return "Cancel the booking";
  switch (plan.kind) {
    case "back":
      return `Move back to ${stageLabel(plan.to)}`;
    case "reopen":
      return `Reopen in ${stageLabel(plan.to)}`;
    case "exit":
    case "switch":
      return plan.to === "lost" ? "Mark as lost" : "Move to nurture";
    default:
      break;
  }
  const verbs: Record<PathStage, string> = {
    new: "Move to New",
    contacted: "Mark as contacted",
    qualified: "Qualify this lead",
    visit_scheduled: "Schedule the visit",
    visit_done: "Record the visit",
    negotiation: "Start negotiating",
    booked: "Record the booking",
  };
  return verbs[plan.to as PathStage];
}

/**
 * What the dialog opens holding. A value that is already known is offered
 * rather than asked for twice: the configuration the buyer came in for, the
 * owner as the host, the quote as the agreement value.
 */
function prefill(plan: MovePlan, lead: SampleLead, today: string): Facts {
  const f = lead.facts;
  const out: Facts = {};
  const pastVisit = isPath(plan.to) && pathIndex(plan.to) > pathIndex("visit_scheduled");
  for (const k of plan.sections.flatMap((s) => s.fields)) {
    switch (k) {
      case "contactedOn":
      case "bookedOn":
        out[k] = today;
        break;
      case "config":
      case "budget": {
        // Only a value the list offers. The board's own "not known" line is
        // not one, and a select handed it shows the first option while the
        // form still holds the placeholder, which the check then refuses.
        const v = f[k] ?? (k === "config" ? lead.config : lead.budget);
        out[k] = v && FIELDS[k].options?.includes(v) ? v : "";
        break;
      }
      case "visitDate":
        // A visit being recorded as done most likely happened today; an
        // upcoming one is a new choice, so it opens blank.
        out[k] = pastVisit ? (f.visitDate && f.visitDate <= today ? f.visitDate : today) : "";
        break;
      case "visitHost":
        out[k] = f.visitHost ?? f.owner ?? "";
        break;
      case "interest":
        out[k] = { HOT: "Hot", WARM: "Warm", COLD: "Cold" }[lead.temp];
        break;
      case "agreement":
        out[k] = f.quote ?? "";
        break;
      default:
        out[k] = f[k] ?? "";
    }
  }
  return out;
}

export function MoveDialog({
  lead,
  plan,
  today,
  people,
  onCancel,
  onConfirm,
}: {
  lead: SampleLead;
  plan: MovePlan;
  today: string;
  people: readonly string[];
  onCancel: () => void;
  onConfirm: (input: MoveInput) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [facts, setFacts] = useState<Facts>(() => prefill(plan, lead, today));
  const [reason, setReason] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    d.showModal();
    // The first question, not the close button the browser would pick.
    d.querySelector<HTMLElement>(".mv-body input, .mv-body select, .mv-body textarea")?.focus();
  }, []);

  const input: MoveInput = { facts, reason, followUp, note: note.trim() || undefined };
  const nowTime = nowTimeOn(today);
  const errors = validateMove(plan, lead, input, today, people, nowTime);
  const shown = tried ? errors : {};

  // A pick-the-person field needs the team; the catalog cannot hold it.
  const optionsFor = (k: FieldKey) =>
    k === "owner" || k === "visitHost" ? people : (FIELDS[k].options ?? []);

  const set = (k: FieldKey, v: string) => setFacts((cur) => ({ ...cur, [k]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length > 0) {
      // The invalid marks render on the next frame, so the focus waits for them.
      requestAnimationFrame(() =>
        ref.current
          ?.querySelector<HTMLElement>("input[aria-invalid='true'], select[aria-invalid='true'], [aria-invalid='true'] input")
          ?.focus(),
      );
      return;
    }
    onConfirm(input);
  };

  const action = actionFor(plan);
  const danger = plan.cancelsBooking || plan.to === "lost";
  const removes = plan.clears.map((s) => describeStage(s, lead.facts));

  // Date bounds follow the same rule as the check, so the picker cannot offer
  // a day the move would refuse.
  const dateBounds = (k: FieldKey): { min?: string; max?: string } => {
    if (k === "visitDate") return plan.to === "visit_scheduled" ? { min: today } : { max: today };
    if (k === "bookedOn") return { min: facts.visitDate ?? lead.facts.visitDate, max: today };
    if (k === "contactedOn") return { max: today };
    return {};
  };

  // The recorded value, when the move asks for a field that already had one.
  const was = (k: FieldKey): string | null => {
    const v = lead.facts[k];
    if (!v) return null;
    if (FIELDS[k].kind === "date") return `Recorded as ${showDate(v)}`;
    if (FIELDS[k].kind === "money") return `Recorded as ${rupees(Number(v))}`;
    if (FIELDS[k].kind === "time") return `Recorded as ${showTime(v)}`;
    return `Recorded as ${v}`;
  };

  const field = (k: FieldKey) => {
    const f = FIELDS[k];
    const id = `mv-${k}`;
    const err = shown[k];
    const hint = was(k);
    const common = {
      id,
      "aria-invalid": err ? ("true" as const) : ("false" as const),
      "aria-describedby": err ? `${id}-err` : hint ? `${id}-hint` : undefined,
    };
    let control: React.ReactNode;

    if (f.kind === "chips") {
      control = (
        <div
          className="mv-chips"
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-invalid={common["aria-invalid"]}
          aria-describedby={common["aria-describedby"]}
        >
          {optionsFor(k).map((o) => (
            <label key={o} className={`mv-chip${facts[k] === o ? " is-on" : ""}`}>
              <input
                type="radio"
                name={id}
                value={o}
                checked={facts[k] === o}
                onChange={() => set(k, o)}
              />
              {o}
            </label>
          ))}
        </div>
      );
    } else if (f.kind === "select" || f.kind === "time") {
      const opts = f.kind === "time" ? VISIT_SLOTS : optionsFor(k);
      // A slot already gone today is not offered for an upcoming visit.
      const gone = (o: string) =>
        f.kind === "time" && plan.to === "visit_scheduled" && !!nowTime && facts.visitDate === today && o <= nowTime;
      const value = facts[k] ?? "";
      control = (
        <select
          {...common}
          className="mv-input"
          value={opts.includes(value) ? value : ""}
          onChange={(e) => set(k, e.target.value)}
        >
          <option value="" disabled>
            Choose
          </option>
          {opts.map((o) => (
            <option key={o} value={o} disabled={gone(o)}>
              {f.kind === "time" ? showTime(o) : o}
            </option>
          ))}
        </select>
      );
    } else if (f.kind === "date") {
      control = (
        <input
          {...common}
          type="date"
          className="mv-input"
          value={facts[k] ?? ""}
          onChange={(e) => set(k, e.target.value)}
          {...dateBounds(k)}
        />
      );
    } else if (f.kind === "money") {
      const n = Number(digits(facts[k]));
      control = (
        <div className="mv-money">
          <span aria-hidden>Rs</span>
          <input
            {...common}
            type="text"
            inputMode="numeric"
            className="mv-input tnum"
            placeholder="0"
            value={n ? n.toLocaleString("en-IN") : ""}
            onChange={(e) => set(k, digits(e.target.value))}
          />
          {n >= 1_00_000 && <span className="mv-money__short tnum">{rupeesShort(n).slice(3)}</span>}
        </div>
      );
    } else {
      control = (
        <input
          {...common}
          type="text"
          className="mv-input"
          placeholder={f.placeholder}
          value={facts[k] ?? ""}
          onChange={(e) => set(k, e.target.value)}
        />
      );
    }

    return (
      <div key={k} className={`mv-field${f.wide ? " mv-field--wide" : ""}`}>
        <label htmlFor={f.kind === "chips" ? undefined : id} id={`${id}-label`} className="mv-label">
          {f.label}
        </label>
        {control}
        {err ? (
          <p id={`${id}-err`} className="mv-err">
            {err}
          </p>
        ) : (
          hint && (
            <p id={`${id}-hint`} className="mv-hint">
              {hint}
            </p>
          )
        )}
      </div>
    );
  };

  const route = (
    <span className="mv-route">
      <span>{stageLabel(plan.from)}</span>
      <ChevronRight size={12} />
      <span>{stageLabel(plan.to)}</span>
    </span>
  );

  return (
    <dialog
      ref={ref}
      className="mv"
      aria-labelledby="mv-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCancel();
      }}
    >
      <form onSubmit={submit} noValidate className="mv-form">
        <header className="mv-head">
          <div>
            <h2 id="mv-title">{action}</h2>
            <p className="mv-sub">
              {lead.name} · {route}
              {plan.skipped > 0 && (
                <span className="mv-skip">
                  {plan.skipped} {plan.skipped === 1 ? "stage" : "stages"} skipped
                </span>
              )}
            </p>
          </div>
          <button type="button" className="btn btn--icon" aria-label="Close" onClick={onCancel}>
            <Close size={14} />
          </button>
        </header>

        <div className="mv-body">
          {removes.length > 0 && (
            <div className={`mv-warn${plan.cancelsBooking ? " mv-warn--risk" : ""}`}>
              <Alert size={15} />
              <p>
                This removes {joinList(removes)}.
              </p>
            </div>
          )}

          {plan.sections.map((s) => (
            <fieldset key={s.stage} className="mv-section">
              <legend>{s.title}</legend>
              <div className="mv-grid">{s.fields.map(field)}</div>
            </fieldset>
          ))}

          {(plan.reason || plan.followUp) && (
            <fieldset className="mv-section">
              <legend>{plan.cancelsBooking ? "Cancellation" : plan.kind === "back" ? "Why" : "Reason"}</legend>
              <div className="mv-grid">
                {plan.reason && (
                  <div className="mv-field mv-field--wide">
                    <label htmlFor="mv-reason" className="mv-label">
                      {plan.reason.label}
                    </label>
                    <select
                      id="mv-reason"
                      className="mv-input"
                      value={reason}
                      aria-invalid={shown.reason ? "true" : "false"}
                      onChange={(e) => setReason(e.target.value)}
                    >
                      <option value="" disabled>
                        Choose a reason
                      </option>
                      {plan.reason.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                    {shown.reason && <p className="mv-err">{shown.reason}</p>}
                  </div>
                )}
                {plan.followUp && (
                  <div className="mv-field">
                    <label htmlFor="mv-follow" className="mv-label">
                      Follow up on
                    </label>
                    <input
                      id="mv-follow"
                      type="date"
                      className="mv-input"
                      min={addDays(today, 1)}
                      value={followUp}
                      aria-invalid={shown.followUp ? "true" : "false"}
                      onChange={(e) => setFollowUp(e.target.value)}
                    />
                    {shown.followUp && <p className="mv-err">{shown.followUp}</p>}
                  </div>
                )}
                {plan.reason && (
                  <div className="mv-field mv-field--wide">
                    <label htmlFor="mv-note" className="mv-label">
                      Note <span className="mv-optional">optional</span>
                    </label>
                    <textarea
                      id="mv-note"
                      className="mv-input"
                      rows={2}
                      maxLength={200}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </fieldset>
          )}

          {plan.sections.length === 0 && !plan.reason && !plan.followUp && removes.length === 0 && (
            <p className="mv-sub">Nothing else is needed.</p>
          )}
        </div>

        <footer className="mv-foot">
          {tried && Object.keys(errors).length > 0 && (
            <p className="mv-foot__left" role="alert">
              {Object.keys(errors).length} {Object.keys(errors).length === 1 ? "field" : "fields"} to fix
            </p>
          )}
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Keep it in {stageLabel(plan.from)}
          </button>
          <button type="submit" className={`btn ${danger ? "btn--risk" : "btn--ink"}`}>
            {plan.cancelsBooking ? `Cancel booking, move to ${stageLabel(plan.to)}` : action}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
