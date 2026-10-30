"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { PageHead } from "@/components/shell/PageHead";
import { saveCallingSettingsAction, type CallingFormState } from "@/app/actions/calling";
import { saveAutomationAction, type ActionResult } from "@/app/actions/leads";
import { useKeptSubmit } from "@/components/KeptForm";
import { showPhone } from "@/lib/call-rules";
import type { CallingPolicy } from "@/lib/calling-rules";
import "./calling.css";

export type ProjectMinutes = { projectId: string; name: string; used: number };

type Editing = null | "rules" | "automation";

const count = (n: number) => n.toLocaleString("en-IN");

/**
 * Two cards, each read-only until its own "Change". Only one can be open at
 * a time, so there is only ever one save button on the page: the rules save
 * from the head, the automation from its own card.
 */
export function CallingForm({
  policy,
  optOuts,
  usage,
  month,
  planned = false,
}: {
  policy: CallingPolicy;
  optOuts: number;
  usage: ProjectMinutes[];
  /** This IST month's name, for the minutes used. */
  month: string;
  /** Plans have been sold: each project's minutes and calls at once come from its plan. */
  planned?: boolean;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [state, submit, pending] = useActionState<CallingFormState, FormData>(saveCallingSettingsAction, null);
  const [autoState, submitAuto, autoPending] = useActionState<ActionResult | null, FormData>(saveAutomationAction, null);
  // A refusal keeps what was typed: React would otherwise reset both forms
  // after every submit, refused or not.
  const keepRules = useKeptSubmit(submit);
  const keepAuto = useKeptSubmit(submitAuto);
  // The answer that was current when a card was opened. An old refusal is not
  // shown again the next time somebody presses Change.
  const [seen, setSeen] = useState<{ rules: CallingFormState; auto: ActionResult | null }>({ rules: null, auto: null });

  useEffect(() => {
    if (state?.ok) setEditing(null);
  }, [state]);
  useEffect(() => {
    if (autoState?.ok) setEditing(null);
  }, [autoState]);

  const open = (card: Exclude<Editing, null>) => {
    setSeen({ rules: state, auto: autoState });
    setEditing(card);
  };

  const rulesError = editing === "rules" && state && !state.ok && state !== seen.rules ? state.message : null;
  const autoError = editing === "automation" && autoState && !autoState.ok && autoState !== seen.auto ? autoState.message : null;

  const action =
    editing === "rules" ? (
      <>
        <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)} disabled={pending}>
          Cancel
        </button>
        <button type="submit" form="calling-form" className="btn btn--ink" disabled={pending}>
          {pending ? "Saving" : "Save rules"}
        </button>
      </>
    ) : editing === null ? (
      <button type="button" className="btn btn--ghost" onClick={() => open("rules")} data-change-rules>
        Change rules
      </button>
    ) : null;

  return (
    <>
      <PageHead
        back={{ label: "Settings", href: "/dashboard/settings" }}
        title={
          <>
            Calling <span className="em">rules</span>
          </>
        }
        meta="How the AI agent calls your leads, and where leads come in."
        action={action}
      />

      {rulesError && (
        <p className="note note--risk" role="alert" style={{ marginBottom: 14 }}>
          {rulesError}
        </p>
      )}

      {/* --- on every call ----------------------------------------------- */}
      <section className="card cs" aria-labelledby="rules-title">
        <div className="cset__head">
          <h2 id="rules-title">On every call</h2>
        </div>
        {editing !== "rules" ? (
          <>
            <Row name="Ask for consent before calling" on={policy.consentRequired}>
              {policy.consentRequired
                ? "Calls a lead within 7 days of their enquiry, or later with consent on file."
                : "Calls a lead within 7 days of their enquiry. Later, only with consent on file."}
            </Row>
            <Row name="Say the call is recorded" on={policy.announceRecording}>
              {policy.announceRecording
                ? policy.recordingLine ?? "This call is recorded for quality and training."
                : "The agent does not mention recording."}
            </Row>
            <Row name="Say it is an AI assistant" on={policy.announceAi}>
              {policy.announceAi
                ? "The agent introduces itself as an AI assistant."
                : "The agent introduces itself by name only."}
            </Row>
            <div className="cs-row">
              <div>
                <p className="cs-row__name">Hand-off number</p>
                <p className="cs-row__sub">A ready buyer goes here when nobody on the sales team is on duty.</p>
              </div>
              <span className={`pill ${policy.handoffNumber ? "pill--quiet" : "pill--warn"} tnum`}>
                {policy.handoffNumber ? showPhone(policy.handoffNumber) : "Not set"}
              </span>
            </div>
            <div className="cs-row cs-row--fixed">
              <div>
                <p className="cs-row__name">Always on</p>
                <p className="cs-row__sub">
                  Numbers that asked not to be called are never called again ({count(optOuts)} so far). Calls go out
                  between 10 am and 9 pm.
                </p>
              </div>
            </div>
          </>
        ) : (
          <form id="calling-form" action={submit} onSubmit={keepRules} className="cset__form">
            <label className="switch">
              <input type="checkbox" name="consentRequired" defaultChecked={policy.consentRequired} />
              <span>
                <span className="switch__name">Ask for consent before calling</span>
                <span className="switch__why">After 7 days, a call always needs consent on file.</span>
              </span>
            </label>
            <label className="switch">
              <input type="checkbox" name="announceRecording" defaultChecked={policy.announceRecording} />
              <span>
                <span className="switch__name">Say the call is recorded</span>
              </span>
            </label>
            <div className="field">
              <label htmlFor="recordingLine">Recording notice, in your words</label>
              <input
                id="recordingLine"
                name="recordingLine"
                type="text"
                maxLength={200}
                defaultValue={policy.recordingLine ?? ""}
                placeholder="This call is recorded for quality and training."
              />
            </div>
            <label className="switch">
              <input type="checkbox" name="announceAi" defaultChecked={policy.announceAi} />
              <span>
                <span className="switch__name">Say it is an AI assistant</span>
              </span>
            </label>
            <div className="field">
              <label htmlFor="handoff">Hand-off number</label>
              <input
                id="handoff"
                name="handoff"
                type="text"
                inputMode="tel"
                defaultValue={policy.handoffNumber ? showPhone(policy.handoffNumber) : ""}
                placeholder="+91 98765 43210"
              />
            </div>
          </form>
        )}
      </section>

      {/* --- automation --------------------------------------------------- */}
      <section className="card cs cset" aria-labelledby="automation-title" data-automation>
        <div className="cset__head">
          <h2 id="automation-title">Automation</h2>
          {editing === "automation" ? (
            <>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)} disabled={autoPending}>
                Cancel
              </button>
              <button type="submit" form="automation-form" className="btn btn--ink btn--sm" disabled={autoPending}>
                {autoPending ? "Saving" : "Save automation"}
              </button>
            </>
          ) : editing === null ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => open("automation")}
              aria-label="Change automation"
              data-change-automation
            >
              Change
            </button>
          ) : null}
        </div>

        {autoError && (
          <p className="note note--risk cset__note" role="alert">
            {autoError}
          </p>
        )}

        {editing !== "automation" ? (
          <>
            <Row name="Call and message new leads" on={policy.autoOutreach}>
              {policy.autoOutreach
                ? "Each new lead is called and sent a WhatsApp message as it arrives."
                : "New leads wait for somebody on the team to call them."}
            </Row>
            {planned ? (
              <div className="cs-row" data-minutes-planned>
                <div>
                  <p className="cs-row__name">AI call minutes and calls at once</p>
                  <p className="cs-row__sub">Set by each project&rsquo;s plan.</p>
                </div>
                <Link href="/dashboard/settings/billing" className="btn btn--ghost btn--sm">
                  Plan and usage
                </Link>
              </div>
            ) : (
              <>
                <div className="cs-row">
                  <div>
                    <p className="cs-row__name">AI call minutes a month</p>
                    <p className="cs-row__sub">Per project. A project that reaches it stops calling until the 1st.</p>
                  </div>
                  <span className="pill pill--quiet tnum">{count(policy.minuteAllowance)}</span>
                </div>
                <Usage usage={usage} allowance={policy.minuteAllowance} month={month} />
                <div className="cs-row">
                  <div>
                    <p className="cs-row__name">Calls at once</p>
                    <p className="cs-row__sub">Per project.</p>
                  </div>
                  <span className="pill pill--quiet tnum">{count(policy.channelLimit)}</span>
                </div>
              </>
            )}
          </>
        ) : (
          <form id="automation-form" action={submitAuto} onSubmit={keepAuto} className="cset__form">
            <label className="switch">
              <input type="checkbox" name="autoOutreach" defaultChecked={policy.autoOutreach} />
              <span>
                <span className="switch__name">Call and message new leads</span>
                <span className="switch__why">Off leaves new leads for somebody on the team.</span>
              </span>
            </label>
            {!planned && <div className="roleform__pair">
              <div className="field">
                <label htmlFor="minuteAllowance">AI call minutes a month, per project</label>
                <input
                  id="minuteAllowance"
                  name="minuteAllowance"
                  type="text"
                  inputMode="numeric"
                  required
                  defaultValue={count(policy.minuteAllowance)}
                  placeholder="1,500"
                />
              </div>
              <div className="field">
                <label htmlFor="channelLimit">Calls at once, per project</label>
                <input
                  id="channelLimit"
                  name="channelLimit"
                  type="text"
                  inputMode="numeric"
                  required
                  defaultValue={String(policy.channelLimit)}
                  placeholder="3"
                />
              </div>
            </div>}
          </form>
        )}
      </section>
    </>
  );
}

/** This month's minutes, one line per project, against the monthly limit. */
function Usage({ usage, allowance, month }: { usage: ProjectMinutes[]; allowance: number; month: string }) {
  return (
    <div className="cset-use">
      <p className="cset-use__cap">Used in {month}</p>
      {usage.length === 0 ? (
        <p className="cset-use__none">No projects yet.</p>
      ) : (
        <ul className="cset-use__list">
          {usage.map((p) => {
            const share = allowance > 0 ? p.used / allowance : p.used > 0 ? 1 : 0;
            const full = share >= 1;
            const near = !full && share >= 0.8;
            return (
              <li
                key={p.projectId}
                className={`cset-use__row${full ? " cset-use__row--full" : near ? " cset-use__row--near" : ""}`}
                data-minutes={p.projectId}
              >
                <span className="cset-use__name">{p.name}</span>
                <span className="cset-use__bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
                </span>
                <span className="cset-use__n tnum">
                  <strong>{count(p.used)}</strong> of {count(allowance)}
                  {full && <span className="pill pill--risk">Used up</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Row({ name, on, children }: { name: string; on: boolean; children: React.ReactNode }) {
  return (
    <div className="cs-row">
      <div>
        <p className="cs-row__name">{name}</p>
        <p className="cs-row__sub">{children}</p>
      </div>
      <span className={`pill ${on ? "pill--ok" : "pill--quiet"}`}>
        <span className="pill__dot" />
        {on ? "On" : "Off"}
      </span>
    </div>
  );
}
