"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { saveLeadRulesAction, type ActionResult } from "@/app/actions/leads";
import { ConfirmAction } from "@/components/ConfirmAction";
import type { LeadRules as Rules } from "@/lib/lead-settings";

const WEIGHTS: { key: keyof Rules["weights"]; label: string }[] = [
  { key: "timeline", label: "When they will buy" },
  { key: "budget", label: "Budget fits" },
  { key: "decision_maker", label: "Decides themselves" },
  { key: "funding", label: "How they pay" },
  { key: "configuration", label: "Wants what is sold" },
  { key: "purpose", label: "To live in" },
  { key: "micro_market", label: "Knows the area" },
];

/**
 * One card per rule, each read-only until "Change" and saved from its own
 * head, so an edit to one never carries half-typed values in another.
 */
export function LeadRules({ rules }: { rules: Rules }) {
  const desk = rules.members.filter((m) => rules.nriDesk.includes(m.id));
  return (
    <div className="lr">
      <RuleCard
        part="ownership"
        title="A buyer who comes back"
        read={
          <p className="lr-read">
            An open lead quiet for more than <strong className="tnum">{rules.lookbackDays} days</strong> is closed when the buyer enquires again,
            and the new enquiry is its own lead.
          </p>
        }
        edit={
          <div className="field lr-narrow">
            <label htmlFor="lr-lookback">Quiet for more than (days)</label>
            <input id="lr-lookback" name="lookback" type="number" min={7} max={365} inputMode="numeric" required defaultValue={rules.lookbackDays} />
          </div>
        }
      />

      <RuleCard
        part="scoring"
        title="Hot, warm and cold"
        read={
          <>
            <p className="lr-read">
              Hot from <strong className="tnum">{rules.floors.hot}</strong>, warm from <strong className="tnum">{rules.floors.warm}</strong>, out of 100.
            </p>
            <dl className="lr-weights">
              {WEIGHTS.map((w) => (
                <div key={w.key}>
                  <dt>{w.label}</dt>
                  <dd className="tnum">{rules.weights[w.key]}</dd>
                </div>
              ))}
            </dl>
          </>
        }
        edit={
          <>
            <div className="lr-grid">
              <div className="field">
                <label htmlFor="lr-hot">Hot from</label>
                <input id="lr-hot" name="hot" type="number" min={0} max={100} inputMode="numeric" required defaultValue={rules.floors.hot} />
              </div>
              <div className="field">
                <label htmlFor="lr-warm">Warm from</label>
                <input id="lr-warm" name="warm" type="number" min={0} max={100} inputMode="numeric" required defaultValue={rules.floors.warm} />
              </div>
            </div>
            <div className="lr-grid lr-grid--weights">
              {WEIGHTS.map((w) => (
                <div className="field" key={w.key}>
                  <label htmlFor={`lr-w-${w.key}`}>{w.label}</label>
                  <input id={`lr-w-${w.key}`} name={`w_${w.key}`} type="number" min={0} max={100} inputMode="numeric" required defaultValue={rules.weights[w.key]} />
                </div>
              ))}
            </div>
          </>
        }
      />

      <RuleCard
        part="places"
        title="Areas and rival projects"
        read={
          <dl className="lr-lists">
            <div>
              <dt>Areas buyers name</dt>
              <dd>{rules.microMarkets.length ? rules.microMarkets.join(", ") : "None yet"}</dd>
            </div>
            <div>
              <dt>Projects buyers compare</dt>
              <dd>{rules.competitors.length ? rules.competitors.join(", ") : "None yet"}</dd>
            </div>
          </dl>
        }
        edit={
          <div className="lr-grid">
            <div className="field">
              <label htmlFor="lr-markets">Areas buyers name</label>
              <textarea id="lr-markets" name="microMarkets" rows={4} defaultValue={rules.microMarkets.join("\n")} placeholder={"Baner\nBalewadi\nAundh"} />
            </div>
            <div className="field">
              <label htmlFor="lr-rivals">Projects buyers compare</label>
              <textarea id="lr-rivals" name="competitors" rows={4} defaultValue={rules.competitors.join("\n")} placeholder={"Riverside Towers\nGreen Acres"} />
            </div>
          </div>
        }
      />

      <RuleCard
        part="nri"
        title="Buyers calling from abroad"
        read={
          <p className="lr-read">
            {desk.length
              ? <>Not called by the AI. Given to <strong>{desk.map((m) => m.name).join(", ")}</strong>.</>
              : "Not called by the AI. Given to the lead's owner."}
          </p>
        }
        edit={
          <fieldset className="lr-people">
            <legend>Who takes them</legend>
            {rules.members.map((m) => (
              <label key={m.id} className="lr-person">
                <input type="checkbox" name="nriDesk" value={m.id} defaultChecked={rules.nriDesk.includes(m.id)} />
                {m.name}
              </label>
            ))}
          </fieldset>
        }
      />

    </div>
  );
}

function RuleCard({ part, title, read, edit }: { part: string; title: string; read: ReactNode; edit: ReactNode }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [state, submit, pending] = useActionState<ActionResult | null, FormData>(saveLeadRulesAction, null);
  const [seen, setSeen] = useState<ActionResult | null>(null);

  useEffect(() => {
    if (!state?.ok) return;
    setEditing(false);
    router.refresh();
  }, [state, router]);

  const error = editing && state && !state.ok && state !== seen ? state.message : null;
  const formId = `lr-${part}`;

  return (
    <section className="card lr-card" aria-labelledby={`${formId}-title`}>
      <div className="card__head">
        <h2 id={`${formId}-title`}>{title}</h2>
        {editing ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
            <button type="submit" form={formId} className="btn btn--ink btn--sm" disabled={pending}>
              {pending ? "Saving" : "Save"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSeen(state);
              setEditing(true);
            }}
            aria-label={`Change ${title.toLowerCase()}`}
          >
            Change
          </button>
        )}
      </div>
      {error && (
        <p className="note note--risk lr-note" role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <form id={formId} action={submit} className="lr-form">
          <input type="hidden" name="part" value={part} />
          {edit}
        </form>
      ) : (
        read
      )}
    </section>
  );
}
