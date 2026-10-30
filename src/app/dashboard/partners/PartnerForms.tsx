"use client";

import { SECOND_HALF_LABEL, type SecondHalf } from "@/lib/loan-rules";
import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Close, Plus } from "@/components/icons";
import { useKeptSubmit } from "@/components/KeptForm";
import {
  addAgentAction,
  bookPartnerVisitAction,
  bookingDatesAction,
  changeGrantAction,
  empanelAction,
  fileInvoiceAction,
  grantProjectsAction,
  makeLinkAction,
  milestoneAction,
  passBackAction,
  registerAction,
  removeAgentAction,
  retireLinkAction,
  revealRegistrationAction,
  saveSettingsAction,
  saveTermsAction,
  updateFirmAction,
  type PartnerFormState,
  type RegisterState,
} from "@/app/actions/partners";
import { VISIT_SLOTS, rupees, showDate } from "@/lib/lead-rules";
import {
  CROSS_PROJECT_LABEL,
  DIRECT_WINS_LABEL,
  LADDER_PERIODS,
  LADDER_PERIOD_LABEL,
  MAX_STEPS,
  REJECT_REASONS,
  VERDICT_LABEL,
  describeSteps,
  type CrossProject,
  type Invoice,
  type RejectReason,
  type Verdict,
} from "@/lib/partner-rules";
import { linkClaimAction, type ClaimFormState } from "@/app/actions/partner-claims";
import type { FirmOption, PartnerAgent, PartnerLink, PartnerPost, PartnerSettings, ProjectOption } from "@/lib/partners";
import "./partners.css";

/**
 * The partner desk's forms. Dialogs for the three things that start from
 * the header (empanel, register, terms); everything that acts on one row is
 * inline in that row, beside what it changes. Every result is said next to
 * the button that produced it, and a refusal keeps what was typed.
 */

type Person = { id: string; name: string };

const plusYear = (today: string) => {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
};

/** On a mandate firm's desk, the latest day any of its mandates runs to. */
const lastOf = (projects: ProjectOption[]) => projects.map((p) => p.until).filter((d): d is string => !!d).sort().pop();

/** A year out, or the mandate's last day when that comes first. */
const tillFor = (today: string, projects: ProjectOption[]) => {
  const year = plusYear(today);
  const first = projects.map((p) => p.until).filter((d): d is string => !!d).sort()[0];
  return first && first < year ? first : year;
};

function Note({ state }: { state: { ok: boolean; message: string } | null }) {
  if (!state) return null;
  return (
    <p className={`note ${state.ok ? "note--info" : "note--risk"}`} role="status">
      {state.message}
    </p>
  );
}

function F({
  id,
  label,
  error,
  optional,
  wide,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  optional?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`mv-field${wide ? " mv-field--wide" : ""}`}>
      <label className="mv-label" htmlFor={id}>
        {label}
        {optional && <span className="mv-optional"> (optional)</span>}
      </label>
      {children}
      {error && (
        <p className="mv-err" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** What failed, at the top of the form, focused, each linked to its field. */
function Problems({ errors, prefix }: { errors?: Record<string, string>; prefix: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const list = Object.entries(errors ?? {});
  useEffect(() => {
    if (list.length) ref.current?.focus();
  }, [errors]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return null;
  return (
    <div ref={ref} className="pf-problems" role="alert" tabIndex={-1} aria-labelledby={`${prefix}-problems`}>
      <p id={`${prefix}-problems`} className="pf-problems__title">
        {list.length === 1 ? "One thing to fix" : `${list.length} things to fix`}
      </p>
      <ul>
        {list.map(([k, v]) => (
          <li key={k}>
            <a href={`#${prefix}-${k}`}>{v}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  return { ref, open: () => ref.current?.showModal(), close: () => ref.current?.close() };
}

function DialogHead({ id, title, onClose }: { id: string; title: ReactNode; onClose: () => void }) {
  return (
    <div className="cl-head">
      <h2 id={id}>{title}</h2>
      <button type="button" className="btn btn--icon" aria-label="Close" onClick={onClose}>
        <Close size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A firm's details, shared by empanelling and editing
// ---------------------------------------------------------------------------

function FirmFields({ p, errors, firm, people, lockPan }: { p: string; errors?: Record<string, string>; firm?: FirmOption; people: Person[]; lockPan?: boolean }) {
  const inv = (k: string) => (errors?.[k] ? { "aria-invalid": true as const, "aria-describedby": `${p}-${k}-err` } : {});
  return (
    <div className="mv-grid">
      <F id={`${p}-name`} label="Firm name" error={errors?.name}>
        <input id={`${p}-name`} name="name" className="mv-input" required maxLength={120} defaultValue={firm?.name} placeholder="Keystone Realty" autoFocus {...inv("name")} />
      </F>
      <F id={`${p}-legalName`} label="Name on the PAN" error={errors?.legalName}>
        <input id={`${p}-legalName`} name="legalName" className="mv-input" required maxLength={160} defaultValue={firm?.legalName} placeholder="Keystone Realty LLP" {...inv("legalName")} />
      </F>
      <F id={`${p}-pan`} label="PAN" error={errors?.pan}>
        <input
          id={`${p}-pan`}
          name="pan"
          className="mv-input pt-mono"
          required
          maxLength={10}
          defaultValue={firm?.pan}
          readOnly={lockPan}
          placeholder="ABCFK1234L"
          autoCapitalize="characters"
          {...inv("pan")}
        />
      </F>
      <F id={`${p}-gstin`} label="GSTIN" optional error={errors?.gstin}>
        <input id={`${p}-gstin`} name="gstin" className="mv-input pt-mono" maxLength={15} defaultValue={firm?.gstin ?? ""} placeholder="27ABCFK1234L1Z5" autoCapitalize="characters" {...inv("gstin")} />
      </F>
      <F id={`${p}-reraNo`} label="MahaRERA agent number" error={errors?.reraNo}>
        <input id={`${p}-reraNo`} name="reraNo" className="mv-input pt-mono" maxLength={12} defaultValue={firm?.reraNo ?? ""} placeholder="A51700012345" autoCapitalize="characters" {...inv("reraNo")} />
      </F>
      <F id={`${p}-reraTill`} label="Agent registration valid till" error={errors?.reraTill}>
        <input id={`${p}-reraTill`} name="reraTill" type="date" className="mv-input" defaultValue={firm?.reraTill ?? ""} {...inv("reraTill")} />
      </F>
      <F id={`${p}-competencyTill`} label="Certificate of competency till" optional error={errors?.competencyTill}>
        <input id={`${p}-competencyTill`} name="competencyTill" type="date" className="mv-input" defaultValue={firm?.competencyTill ?? ""} {...inv("competencyTill")} />
      </F>
      <F id={`${p}-area`} label="Area" optional error={errors?.area}>
        <input id={`${p}-area`} name="area" className="mv-input" maxLength={80} defaultValue={firm?.area ?? ""} placeholder="Baner" {...inv("area")} />
      </F>
      <F id={`${p}-principalName`} label="Principal" optional error={errors?.principalName}>
        <input id={`${p}-principalName`} name="principalName" className="mv-input" maxLength={120} defaultValue={firm?.principalName ?? ""} placeholder="Sagar Kale" {...inv("principalName")} />
      </F>
      <F id={`${p}-principalPhone`} label="Principal's number" optional error={errors?.principalPhone}>
        <input id={`${p}-principalPhone`} name="principalPhone" className="mv-input" inputMode="tel" defaultValue={firm?.principalPhone ?? ""} placeholder="98765 43210" {...inv("principalPhone")} />
      </F>
      <F id={`${p}-rmId`} label="Looked after by" optional wide>
        <select id={`${p}-rmId`} name="rmId" className="cl-select" defaultValue={firm?.rmId ?? ""}>
          <option value="">Nobody yet</option>
          {people.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </F>
    </div>
  );
}

function ProjectPicks({ p, projects, name = "projectId", error, exclude = [] }: { p: string; projects: ProjectOption[]; name?: string; error?: string; exclude?: string[] }) {
  const open = projects.filter((x) => !exclude.includes(x.id));
  return (
    <fieldset className="pf-fieldset" id={`${p}-projects`} aria-invalid={error ? true : undefined}>
      <legend className="mv-label">Projects</legend>
      {open.length === 0 ? (
        <p className="mv-hint">Every project you look after already has this firm.</p>
      ) : (
        <div className="checkset">
          {open.map((x) => (
            <label key={x.id} className="checkset__item">
              <input type="checkbox" name={name} value={x.id} defaultChecked={open.length === 1} />
              <span>
                <strong>{x.name}</strong>
                <small>{describeSteps(x.terms.steps)}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {error && <p className="mv-err">{error}</p>}
    </fieldset>
  );
}

export function EmpanelDialog({ projects, people, today, primary }: { projects: ProjectOption[]; people: Person[]; today: string; primary: boolean }) {
  const d = useDialog();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(empanelAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state, router]);
  return (
    <>
      <button type="button" className={`btn ${primary ? "btn--ink" : "btn--ghost"}`} onClick={d.open} disabled={!projects.length} title={projects.length ? undefined : "No project to empanel on yet"}>
        <Plus size={15} />
        Empanel a channel partner
      </button>
      <dialog ref={d.ref} className="cl-dialog pf-dialog" aria-labelledby="pe-title">
        <form ref={formRef} action={submit} onSubmit={keep} className="cl-form" noValidate>
          <DialogHead id="pe-title" title="Empanel a channel partner" onClose={d.close} />
          <Problems errors={state?.ok ? undefined : state?.errors} prefix="pe" />
          <FirmFields p="pe" errors={state?.ok ? undefined : state?.errors} people={people} />
          <ProjectPicks p="pe" projects={projects} error={state?.ok ? undefined : state?.errors?.projects} />
          <F id="pe-validTo" label="Empanelled till" error={state?.ok ? undefined : state?.errors?.validTo}>
            <input id="pe-validTo" name="validTo" type="date" className="mv-input pf-narrow" required min={today} max={lastOf(projects)} defaultValue={tillFor(today, projects)} />
          </F>
          <Note state={state?.ok ? state : state && !state.errors ? state : null} />
          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={d.close}>
              {state?.ok ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending}>
              {pending ? "Empanelling" : "Empanel"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

export function EditFirmDialog({ firm, people }: { firm: FirmOption; people: Person[] }) {
  const d = useDialog();
  const router = useRouter();
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(updateFirmAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) {
      router.refresh();
      d.close();
    }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <button type="button" className="btn btn--ghost btn--sm" onClick={d.open}>
        Edit details
      </button>
      <dialog ref={d.ref} className="cl-dialog pf-dialog" aria-labelledby={`pf-${firm.id}-title`}>
        <form action={submit} onSubmit={keep} className="cl-form" noValidate>
          <DialogHead id={`pf-${firm.id}-title`} title={firm.name} onClose={d.close} />
          <input type="hidden" name="firmId" value={firm.id} />
          <Problems errors={state?.ok ? undefined : state?.errors} prefix={`pf${firm.id.slice(0, 6)}`} />
          <FirmFields p={`pf${firm.id.slice(0, 6)}`} errors={state?.ok ? undefined : state?.errors} firm={firm} people={people} lockPan />
          <Note state={state && !state.ok && !state.errors ? state : null} />
          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={d.close}>
              Cancel
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending}>
              {pending ? "Saving" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Registering a buyer
// ---------------------------------------------------------------------------

const VERDICT_TONE: Record<Verdict, "info" | "warn" | "risk"> = {
  REGISTERED: "info",
  ALREADY: "info",
  BLOCKED: "risk",
  DIRECT_FIRST: "risk",
  NO_GRANT: "risk",
  AGENT_RERA: "warn",
  RATE_LIMITED: "warn",
};

export function RegisterDialog({ firms, projects, primary }: { firms: FirmOption[]; projects: ProjectOption[]; primary: boolean }) {
  const d = useDialog();
  const router = useRouter();
  const buyerRef = useRef<HTMLDivElement>(null);
  const [firmId, setFirmId] = useState(firms[0]?.id ?? "");
  const [state, submit, pending] = useActionState<RegisterState, FormData>(registerAction, null);
  const keep = useKeptSubmit(submit);
  const firm = firms.find((f) => f.id === firmId);
  const theirs = projects.filter((p) => firm?.grants.some((g) => g.projectId === p.id));
  const offer = theirs.length ? theirs : projects;
  useEffect(() => {
    if (state?.verdict) router.refresh();
  }, [state, router]);
  return (
    <>
      <button type="button" className={`btn ${primary ? "btn--ink" : "btn--ghost"}`} onClick={d.open} disabled={!firms.length}>
        <Plus size={15} />
        Register a buyer
      </button>
      <dialog ref={d.ref} className="cl-dialog" aria-labelledby="pr-title">
        <form action={submit} onSubmit={keep} className="cl-form">
          <DialogHead id="pr-title" title="Register a buyer" onClose={d.close} />
          <div className="mv-grid">
            <F id="pr-firm" label="Partner">
              <select id="pr-firm" name="firmId" className="cl-select" value={firmId} onChange={(e) => setFirmId(e.target.value)}>
                {firms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </F>
            <F id="pr-project" label="Project">
              <select id="pr-project" name="projectId" className="cl-select" key={firmId} defaultValue={offer[0]?.id}>
                {offer.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </F>
            <div ref={buyerRef} className="mv-field--wide pf-sub-grid">
              <F id="pr-phone" label="Buyer's number">
                <input id="pr-phone" name="phone" className="mv-input" inputMode="tel" required placeholder="98123 45621" autoFocus />
              </F>
              <F id="pr-buyer" label="Buyer's name" optional>
                <input id="pr-buyer" name="buyerName" className="mv-input" maxLength={120} placeholder="Pooja Nair" />
              </F>
            </div>
            <F id="pr-agent" label="Agent at the firm" optional wide>
              <input id="pr-agent" name="agentName" className="mv-input" maxLength={120} placeholder="Mayur Sawant" />
            </F>
          </div>

          {state && (
            <div className={`pf-verdict pf-verdict--${state.verdict ? VERDICT_TONE[state.verdict as Verdict] : "risk"}`} role="status">
              {state.verdict && <span className="pf-verdict__label">{VERDICT_LABEL[state.verdict as Verdict]}</span>}
              <span>{state.message}</span>
            </div>
          )}

          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={d.close}>
              {state?.verdict ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending}>
              {pending ? "Checking" : "Register"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// A project's terms
// ---------------------------------------------------------------------------

export function TermsDialog({ projects }: { projects: ProjectOption[] }) {
  const d = useDialog();
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const project = projects.find((p) => p.id === projectId);
  const [steps, setSteps] = useState(() => project?.terms.steps ?? []);
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(saveTermsAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    setSteps(projects.find((p) => p.id === projectId)?.terms.steps ?? []);
  }, [projectId, projects]);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  if (!project) return null;
  const t = project.terms;
  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={d.open}>
        Commission terms
      </button>
      <dialog ref={d.ref} className="cl-dialog pf-dialog" aria-labelledby="pt-title">
        <form action={submit} onSubmit={keep} className="cl-form" key={projectId}>
          <DialogHead id="pt-title" title="Commission terms" onClose={d.close} />
          <F id="pt-project" label="Project">
            <select id="pt-project" name="projectId" className="cl-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} autoFocus>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </F>

          <fieldset className="pf-fieldset">
            <legend className="mv-label">What a firm&rsquo;s bookings here earn</legend>
            <ol className="pf-steps">
              {steps.map((s, i) => (
                <li key={i} className="pf-step">
                  <span className="pf-step__k">{i === 0 ? "From the 1st booking" : "From booking"}</span>
                  {i === 0 ? (
                    <span aria-hidden>
                      <input type="hidden" name="stepFrom" value={1} />
                    </span>
                  ) : (
                    <input
                      aria-label={`Step ${i + 1} starts at booking`}
                      name="stepFrom"
                      type="number"
                      min={2}
                      max={100}
                      className="mv-input pf-tiny"
                      value={s.from}
                      onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, from: Number(e.target.value) } : x)))}
                    />
                  )}
                  <span className="pf-pct">
                    <input
                      aria-label={`Step ${i + 1} rate`}
                      name="stepRate"
                      type="number"
                      step="0.05"
                      min={0.5}
                      max={5}
                      className="mv-input pf-tiny"
                      value={+(s.rate * 100).toFixed(3)}
                      onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) / 100 } : x)))}
                    />
                    <span aria-hidden>%</span>
                  </span>
                  {i > 0 ? (
                    <button type="button" className="btn btn--icon" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                      <Close size={12} />
                    </button>
                  ) : (
                    <span aria-hidden />
                  )}
                </li>
              ))}
            </ol>
            {steps.length < MAX_STEPS && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  const last = steps[steps.length - 1];
                  setSteps([...steps, { from: (last?.from ?? 0) + 1, rate: last?.rate ?? 0.02 }]);
                }}
              >
                <Plus size={13} />
                Add a step
              </button>
            )}
          </fieldset>

          <div className="mv-grid pf-three">
            <F id="pt-pass" label="Pass-back, at most">
              <span className="pf-pct">
                <input id="pt-pass" name="passBackMax" type="number" step="0.05" min={0} max={2} className="mv-input" defaultValue={+(t.passBackMax * 100).toFixed(3)} />
                <span aria-hidden>%</span>
              </span>
            </F>
            <F id="pt-days" label="Registration runs">
              <span className="pf-pct">
                <input id="pt-days" name="registrationDays" type="number" min={15} max={90} className="mv-input" defaultValue={t.registrationDays} />
                <span aria-hidden>days</span>
              </span>
            </F>
            <F id="pt-visit" label="A visit adds">
              <span className="pf-pct">
                <input id="pt-visit" name="visitExtendsDays" type="number" min={0} max={90} className="mv-input" defaultValue={t.visitExtendsDays} />
                <span aria-hidden>days</span>
              </span>
            </F>
          </div>

          <F id="pt-period" label="The ladder counts">
            <select id="pt-period" name="ladderPeriod" className="cl-select" defaultValue={t.ladderPeriod ?? "ALL"}>
              {LADDER_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {LADDER_PERIOD_LABEL[p]}
                </option>
              ))}
            </select>
          </F>

          <F id="pt-half" label="The second half falls due">
            <select id="pt-half" name="secondHalf" className="cl-select" defaultValue={t.secondHalf ?? "COLLECTED"}>
              {(Object.keys(SECOND_HALF_LABEL) as SecondHalf[]).map((k) => (
                <option key={k} value={k}>
                  {SECOND_HALF_LABEL[k]}
                </option>
              ))}
            </select>
          </F>

          <Note state={state} />
          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={d.close}>
              {state?.ok ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending}>
              {pending ? "Saving" : "Save terms"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// One firm's empanelment on each project
// ---------------------------------------------------------------------------

export function GrantControls({
  grant,
  today,
  can,
}: {
  grant: FirmOption["grants"][number];
  today: string;
  can: { suspend: boolean; empanel: boolean };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [ask, setAsk] = useState<null | "suspend" | "renew">(null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const run = (kind: "suspend" | "restore" | "end" | "renew") =>
    start(async () => {
      const res = await changeGrantAction({ grantId: grant.id, kind, reason: kind === "suspend" ? value : undefined, validTo: kind === "renew" ? value : undefined });
      setNote(res);
      if (res.ok) {
        setAsk(null);
        setValue("");
        router.refresh();
      }
    });
  if (grant.status === "ENDED") return null;
  return (
    <div className="pf-grant">
      <div className="pf-grant__acts">
        {grant.status === "ACTIVE" && can.suspend && (
          <button type="button" className="ws-link" onClick={() => setAsk(ask === "suspend" ? null : "suspend")} aria-expanded={ask === "suspend"}>
            Put on hold
          </button>
        )}
        {grant.status === "SUSPENDED" && can.suspend && (
          <button type="button" className="ws-link" disabled={pending} onClick={() => run("restore")}>
            Make live again
          </button>
        )}
        {grant.status === "ACTIVE" && can.empanel && (
          <button type="button" className="ws-link" onClick={() => setAsk(ask === "renew" ? null : "renew")} aria-expanded={ask === "renew"}>
            Renew
          </button>
        )}
        {can.empanel && (
          <button
            type="button"
            className="ws-link pf-danger"
            disabled={pending}
            onClick={() => {
              if (window.confirm(`End this firm's empanelment on ${grant.project}? A new empanelment starts from nothing.`)) run("end");
            }}
          >
            End
          </button>
        )}
      </div>
      {ask && (
        <form
          className="pf-inline"
          onSubmit={(e) => {
            e.preventDefault();
            run(ask);
          }}
        >
          {ask === "suspend" ? (
            <input
              aria-label="Why it is on hold"
              className="mv-input"
              maxLength={200}
              placeholder="Why, in a few words"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          ) : (
            <input aria-label="Empanelled till" type="date" className="mv-input" min={today} value={value} onChange={(e) => setValue(e.target.value)} required />
          )}
          <button type="submit" className="btn btn--ink btn--sm" disabled={pending}>
            {ask === "suspend" ? "Put on hold" : "Renew"}
          </button>
        </form>
      )}
      {note && !note.ok && <p className="mv-err">{note.message}</p>}
    </div>
  );
}

export function AddProjects({ firm, projects, today }: { firm: FirmOption; projects: ProjectOption[]; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(grantProjectsAction, null);
  const keep = useKeptSubmit(submit);
  const have = firm.grants.filter((g) => g.status !== "ENDED").map((g) => g.projectId);
  useEffect(() => {
    if (state?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);
  if (projects.every((p) => have.includes(p.id))) return null;
  return open ? (
    <form action={submit} onSubmit={keep} className="pf-card">
      <input type="hidden" name="firmId" value={firm.id} />
      <ProjectPicks p={`pa${firm.id.slice(0, 6)}`} projects={projects} exclude={have} />
      <div className="pf-inline">
        <label className="mv-label" htmlFor={`pa-${firm.id}`}>
          Empanelled till
        </label>
        <input id={`pa-${firm.id}`} name="validTo" type="date" className="mv-input pf-narrow" min={today} max={lastOf(projects)} defaultValue={tillFor(today, projects)} required />
        <button type="submit" className="btn btn--ink btn--sm" disabled={pending}>
          Add
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Note state={state && !state.ok ? state : null} />
    </form>
  ) : (
    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
      <Plus size={13} />
      Add a project
    </button>
  );
}

// ---------------------------------------------------------------------------
// The visit a partner's buyer is booked onto
// ---------------------------------------------------------------------------

const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`;
};

export function VisitForm({ registrationId, phases, today }: { registrationId: string; phases: { id: string; name: string }[]; today: string }) {
  const router = useRouter();
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(bookPartnerVisitAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  if (!phases.length) return <p className="ws-sub">This project has no tower yet.</p>;
  return (
    <form action={submit} onSubmit={keep} className="pf-visit">
      <input type="hidden" name="registrationId" value={registrationId} />
      <div className="pf-visit__row">
        <label className="sr-only" htmlFor={`pv-ph-${registrationId}`}>
          Tower
        </label>
        <select id={`pv-ph-${registrationId}`} name="phaseId" className="cl-select" defaultValue={phases[0].id}>
          {phases.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`pv-d-${registrationId}`}>
          Day
        </label>
        <input id={`pv-d-${registrationId}`} name="date" type="date" className="mv-input" min={today} defaultValue={today} required />
        <label className="sr-only" htmlFor={`pv-t-${registrationId}`}>
          Time
        </label>
        <select id={`pv-t-${registrationId}`} name="time" className="cl-select" defaultValue="11:00">
          {VISIT_SLOTS.map((s) => (
            <option key={s} value={s}>
              {timeLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn--ink btn--sm" disabled={pending}>
        {pending ? "Booking" : "Book the visit"}
      </button>
      <Note state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Payouts: the booking's dates, the pass-back, and each half's next step
// ---------------------------------------------------------------------------

export function BookingDates({ payoutId, registeredOn, crossedOn, today, locked }: { payoutId: string; registeredOn: string | null; crossedOn: string | null; today: string; locked: { M1: boolean; M2: boolean } }) {
  const router = useRouter();
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(bookingDatesAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  if (locked.M1 && locked.M2) return null;
  return (
    <form action={submit} onSubmit={keep} className="pf-dates">
      <input type="hidden" name="payoutId" value={payoutId} />
      <div className="pf-dates__row">
        <F id={`pd-a-${payoutId}`} label="Agreement registered on">
          <input
            id={`pd-a-${payoutId}`}
            name="agreementRegisteredOn"
            type="date"
            className="mv-input"
            max={today}
            defaultValue={registeredOn ?? ""}
            readOnly={locked.M1}
          />
        </F>
        <F id={`pd-c-${payoutId}`} label="30% collected on">
          <input id={`pd-c-${payoutId}`} name="collectedOn" type="date" className="mv-input" max={today} defaultValue={crossedOn ?? ""} readOnly={locked.M2} />
        </F>
      </div>
      <button type="submit" className="btn btn--ghost btn--sm" disabled={pending}>
        {pending ? "Saving" : "Save dates"}
      </button>
      <Note state={state && !state.ok ? state : null} />
    </form>
  );
}

export function PassBack({ payoutId, passBack }: { payoutId: string; passBack: number }) {
  const router = useRouter();
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(passBackAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={submit} onSubmit={keep} className="pf-inline">
      <input type="hidden" name="payoutId" value={payoutId} />
      <label className="mv-label" htmlFor={`pb-${payoutId}`}>
        Given back to the buyer
      </label>
      <span className="pf-pct">
        <input id={`pb-${payoutId}`} name="passBack" type="number" step="0.05" min={0} max={2} className="mv-input pf-tiny" defaultValue={+(passBack * 100).toFixed(3)} />
        <span aria-hidden>%</span>
      </span>
      <button type="submit" className="btn btn--ghost btn--sm" disabled={pending}>
        Save
      </button>
      <Note state={state && !state.ok ? state : null} />
    </form>
  );
}

export function InvoiceForm({ milestoneId, invoice, today }: { milestoneId: string; invoice: Invoice; today: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(fileInvoiceAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);
  if (!open) {
    return (
      <>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
          File the firm&rsquo;s invoice
        </button>
        <Note state={state?.ok ? state : null} />
      </>
    );
  }
  return (
    <form ref={formRef} action={submit} onSubmit={keep} className="pf-card">
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <div className="mv-grid pf-stack">
        <F id={`pi-n-${milestoneId}`} label="Invoice number">
          <input id={`pi-n-${milestoneId}`} name="invoiceNo" className="mv-input" maxLength={40} required placeholder="KR/26-27/041" />
        </F>
        <F id={`pi-d-${milestoneId}`} label="Invoice date">
          <input id={`pi-d-${milestoneId}`} name="invoiceDate" type="date" className="mv-input" max={today} defaultValue={today} required />
        </F>
        <F id={`pi-a-${milestoneId}`} label="Total on the invoice">
          <span className="mv-money">
            <span aria-hidden>Rs</span>
            <input id={`pi-a-${milestoneId}`} name="amount" className="mv-input" inputMode="numeric" required placeholder={invoice.gross.toLocaleString("en-IN")} />
          </span>
        </F>
        <F id={`pi-f-${milestoneId}`} label="The invoice">
          <input id={`pi-f-${milestoneId}`} name="file" type="file" className="pf-file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" required />
        </F>
      </div>
      <p className="mv-hint">Owed on this half: {rupees(invoice.gross)}, GST included.</p>
      <div className="pf-inline">
        <button type="submit" className="btn btn--ink btn--sm" disabled={pending}>
          {pending ? "Filing" : "File invoice"}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Note state={state && !state.ok ? state : null} />
    </form>
  );
}

export function HalfActions({
  milestoneId,
  state,
  net,
  can,
  today,
  waitingOnFirm = false,
}: {
  milestoneId: string;
  state: "verify" | "approve" | "approved";
  net: number;
  can: { approve: boolean; pay: boolean };
  today: string;
  /** The firm confirms its own invoice on WhatsApp before it is checked. */
  waitingOnFirm?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [utr, setUtr] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  // Sending an invoice back asks why, so the firm knows what to correct.
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<RejectReason | "">("");
  const go = (kind: "verify" | "reject" | "approve" | "pay") =>
    start(async () => {
      const res = await milestoneAction({ milestoneId, kind, utr, paidOn, reason: reason || undefined });
      setNote(res);
      if (res.ok) router.refresh();
    });
  return (
    <div className="pf-half">
      {state === "verify" && can.approve && !rejecting && (
        <div className="pf-inline">
          <button type="button" className="btn btn--ghost btn--sm" disabled={pending || waitingOnFirm} onClick={() => go("verify")}>
            <Check size={13} />
            Invoice matches
          </button>
          <button type="button" className="ws-link pf-danger" disabled={pending} onClick={() => setRejecting(true)}>
            Reject invoice
          </button>
        </div>
      )}
      {state === "verify" && can.approve && rejecting && (
        <div className="pf-inline">
          <select aria-label="Why it is sent back" className="mv-input" value={reason} onChange={(e) => setReason(e.target.value as RejectReason | "")}>
            <option value="">Why is it wrong?</option>
            {(Object.keys(REJECT_REASONS) as RejectReason[]).map((k) => (
              <option key={k} value={k}>
                {k === "OTHER" ? "Something else" : REJECT_REASONS[k]}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--ink btn--sm" disabled={pending || !reason} onClick={() => go("reject")}>
            Send it back
          </button>
          <button type="button" className="ws-link" disabled={pending} onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </div>
      )}
      {state === "approve" && can.approve && (
        <button type="button" className="btn btn--ink btn--sm" disabled={pending} onClick={() => go("approve")}>
          Approve {rupees(net)}
          <Check size={13} />
        </button>
      )}
      {state === "approved" && can.pay && (
        <form
          className="pf-inline"
          onSubmit={(e) => {
            e.preventDefault();
            go("pay");
          }}
        >
          <input aria-label="UTR" className="mv-input pt-mono" placeholder="UTR" value={utr} onChange={(e) => setUtr(e.target.value)} required maxLength={32} />
          <input aria-label="Paid on" type="date" className="mv-input pf-narrow" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required />
          <button type="submit" className="btn btn--ink btn--sm" disabled={pending}>
            Mark paid
          </button>
        </form>
      )}
      {state === "verify" && can.approve && waitingOnFirm && <p className="ws-sub">Waiting for the firm to confirm it on WhatsApp.</p>}
      {note && !note.ok && <p className="mv-err">{note.message}</p>}
    </div>
  );
}

export function InvoiceLink({ id, no, date, attestedOn }: { id: string; no: string; date: string; attestedOn?: string | null }) {
  return (
    <span className="pf-invoice">
      <a className="ws-link pt-mono" href={`/dashboard/partners/invoice/${id}`} target="_blank" rel="noreferrer">
        Invoice {no}, {showDate(date)}
      </a>
      {attestedOn && (
        <span className="pill pill--ok">
          <Check size={11} />
          Confirmed by the firm, {showDate(attestedOn)}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// A partner's buyer's whole number, asked of the server one at a time
// ---------------------------------------------------------------------------

export function RevealNumber({ registrationId, masked }: { registrationId: string; masked: string }) {
  const [shown, setShown] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      {shown ?? masked}
      {!shown && (
        <button
          type="button"
          className="ws-link"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await revealRegistrationAction({ registrationId });
              if (res.ok) {
                setShown(res.phone);
                setErr(null);
              } else setErr(res.message);
            })
          }
        >
          {pending ? "Showing" : "Show"}
        </button>
      )}
      {err && <span className="mv-err">{err}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// The people at a firm who use your WhatsApp number
// ---------------------------------------------------------------------------

export function AgentsPanel({
  firmId,
  agents,
  canAdd,
  canRemove,
}: {
  firmId: string;
  agents: PartnerAgent[];
  canAdd: boolean;
  canRemove: boolean;
}) {
  const router = useRouter();
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(addAgentAction, null);
  const keep = useKeptSubmit(submit);
  const form = useRef<HTMLFormElement>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();
  useEffect(() => {
    if (state?.ok) {
      form.current?.reset();
      router.refresh();
    }
  }, [state, router]);
  return (
    <section className="ws-sec pf-links" aria-label="On WhatsApp">
      <h3>On WhatsApp</h3>
      {agents.length === 0 && <p className="ws-sub">Nobody yet. Add the people who register buyers for this firm.</p>}
      <ul className="pf-projects">
        {agents.map((a) => (
          <li key={a.id} className="pf-project">
            <span className="pf-project__top">
              <span className="pf-project__name">{a.name}</span>
              <span className={`pill pill--${a.status === "ACTIVE" ? (a.muted ? "quiet" : "ok") : "blue"}`}>
                <span className="pill__dot" />
                {a.status === "WAITING"
                  ? "Waiting for their first message"
                  : a.muted
                    ? "Payout updates off"
                    : `On WhatsApp since ${showDate(a.since!)}`}
              </span>
            </span>
            <span className="pf-grant__acts">
              <span className="ws-sub tnum">
                {a.phone}
                {a.principal ? " · Principal" : ""}
              </span>
              {canRemove && (
                <button
                  type="button"
                  className="ws-link pf-danger"
                  disabled={busy}
                  onClick={() =>
                    start(async () => {
                      const res = await removeAgentAction({ agentId: a.id });
                      setNote(res.ok ? null : res);
                      if (res.ok) router.refresh();
                    })
                  }
                >
                  Remove
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {note && !note.ok && <p className="mv-err">{note.message}</p>}
      {canAdd && (
        <form ref={form} action={submit} onSubmit={keep} className="pf-inline pf-linkform">
          <input type="hidden" name="firmId" value={firmId} />
          <label className="sr-only" htmlFor={`pa-n-${firmId}`}>
            Name
          </label>
          <input id={`pa-n-${firmId}`} name="name" className="mv-input" maxLength={120} placeholder="Name" required />
          <label className="sr-only" htmlFor={`pa-p-${firmId}`}>
            WhatsApp number
          </label>
          <input id={`pa-p-${firmId}`} name="phone" className="mv-input" inputMode="tel" maxLength={20} placeholder="98765 43210" required />
          <button type="submit" className="btn btn--ghost btn--sm" disabled={pending}>
            {pending ? "Adding" : "Add"}
          </button>
        </form>
      )}
      <Note state={state} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The two settings a tenant sets once
// ---------------------------------------------------------------------------

export function SettingsRow({ settings }: { settings: PartnerSettings }) {
  const router = useRouter();
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(saveSettingsAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  // Set once and rarely changed, so it reads as its current values until opened.
  return (
    <details className="disclose pf-settings" aria-label="Partner settings">
      <summary>
        <span className="pf-settings__title">Partner rules</span>
        <span className="disclose__sub">
          {settings.dialPolicy === "LOGGED" ? "Their buyers may be called, and it is logged" : "Their buyers are called only after the site visit"} ·{" "}
          {settings.dailyRegistrations.toLocaleString("en-IN")} registrations a firm a day ·{" "}
          {DIRECT_WINS_LABEL[settings.directWins]}
        </span>
      </summary>
      <div className="disclose__body">
        <form action={submit} onSubmit={keep} className="pf-settings__form">
          <F id="ps-dial" label="Calling a partner's buyer">
            <select id="ps-dial" name="dialPolicy" className="cl-select" defaultValue={settings.dialPolicy}>
              <option value="AFTER_VISIT">Only after the site visit</option>
              <option value="LOGGED">Allowed, and logged</option>
            </select>
          </F>
          <F id="ps-daily" label="Registrations a firm may make a day">
            <input id="ps-daily" name="dailyRegistrations" type="number" min={1} max={1000} className="mv-input" defaultValue={settings.dailyRegistrations} />
          </F>
          <F id="ps-direct" label="A buyer who enquired directly">
            <select id="ps-direct" name="directWins" className="cl-select" defaultValue={settings.directWins}>
              <option value="ENQUIRY">Stays yours from the first enquiry</option>
              <option value="VISIT">Stays yours once they visit</option>
            </select>
          </F>
          <F id="ps-cross" label="Registered on one project, booked on another">
            <select id="ps-cross" name="crossProject" className="cl-select" defaultValue={settings.crossProject}>
              {(Object.keys(CROSS_PROJECT_LABEL) as CrossProject[]).map((k) => (
                <option key={k} value={k}>
                  {CROSS_PROJECT_LABEL[k]}
                </option>
              ))}
            </select>
          </F>
          <F id="ps-claw" label="A booking cancelled after a payout">
            <select id="ps-claw" name="clawback" className="cl-select" defaultValue={settings.clawback ? "ON" : "OFF"}>
              <option value="ON">Take it back from the firm&rsquo;s next payouts</option>
              <option value="OFF">Let the firm keep what was paid</option>
            </select>
          </F>
          <F id="ps-loan" label="Their buyer's home loan">
            <select id="ps-loan" name="shareLoanStage" className="cl-select" defaultValue={settings.shareLoanStage ? "ON" : "OFF"}>
              <option value="OFF">Not shown to the partner</option>
              <option value="ON">Stage shown, once the buyer agrees</option>
            </select>
          </F>
          <button type="submit" className="btn btn--ghost btn--sm" disabled={pending}>
            {pending ? "Saving" : "Save"}
          </button>
        </form>
        <Note state={state} />
      </div>
    </details>
  );
}



// ---------------------------------------------------------------------------
// A partner's links, and the posts each can carry
// ---------------------------------------------------------------------------

export function LinksPanel({
  firmId,
  links,
  posts,
  towers,
  canMake,
}: {
  firmId: string;
  links: PartnerLink[];
  posts: PartnerPost[];
  towers: { id: string; name: string; projectId: string }[];
  canMake: boolean;
}) {
  const router = useRouter();
  const [state, submit, pending] = useActionState<PartnerFormState, FormData>(makeLinkAction, null);
  const keep = useKeptSubmit(submit);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  const live = links.filter((l) => !l.retired);
  return (
    <section className="ws-sec pf-links" aria-label="Links">
      <h3>Links</h3>
      {live.length === 0 && <p className="ws-sub">No link yet.</p>}
      <ul className="pf-projects">
        {live.map((l) => {
          const mine = posts.filter((p) => p.projectId === l.projectId);
          return (
            <li key={l.id} className="pf-project">
              <span className="pf-project__top">
                <span className="pf-project__name pt-mono">{l.code}</span>
                <span className="ws-sub tnum">
                  {l.enquiries} {l.enquiries === 1 ? "enquiry" : "enquiries"} · {l.claims} registered
                </span>
              </span>
              <span className="ws-sub">
                {l.tower}
                {l.agent ? ` · ${l.agent}` : ""}
              </span>
              <span className="pf-grant__acts">
                {l.url && (
                  <button
                    type="button"
                    className="ws-link"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(l.url!);
                        setCopied(l.id);
                      } catch {
                        setCopied(null);
                      }
                    }}
                  >
                    {copied === l.id ? "Copied" : l.whatsapp ? "Copy WhatsApp link" : "Copy link"}
                  </button>
                )}
                {mine.length > 0 && (
                  <button type="button" className="ws-link" aria-expanded={open === l.id} onClick={() => setOpen(open === l.id ? null : l.id)}>
                    {open === l.id ? "Hide posts" : `Posts to share (${mine.length})`}
                  </button>
                )}
                {canMake && (
                  <button
                    type="button"
                    className="ws-link pf-danger"
                    disabled={busy}
                    onClick={() =>
                      start(async () => {
                        const res = await retireLinkAction({ linkId: l.id });
                        setNote(res.ok ? null : res);
                        if (res.ok) router.refresh();
                      })
                    }
                  >
                    Retire
                  </button>
                )}
              </span>
              {open === l.id && (
                <ul className="pf-posts">
                  {mine.map((p) => (
                    <li key={p.id} className="pf-post">
                      <span className="pf-post__what">
                        <span className="pt-cell">{p.headline}</span>
                        <span className="ws-sub">
                          {p.kind === "CAROUSEL" ? "Carousel" : "Image"} · {p.placement}
                        </span>
                      </span>
                      <span className="pf-post__dl">
                        {Array.from({ length: p.frames }, (_, i) => (
                          <a
                            key={i}
                            className="btn btn--ghost btn--sm"
                            href={`/dashboard/partners/links/${l.id}/post/${p.id}/${i}`}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={p.frames > 1 ? `Download slide ${i + 1}` : "Download"}
                          >
                            {p.frames > 1 ? i + 1 : "Download"}
                          </a>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {note && !note.ok && <p className="mv-err">{note.message}</p>}
      {canMake && towers.length > 0 && (
        <form action={submit} onSubmit={keep} className="pf-inline pf-linkform">
          <input type="hidden" name="firmId" value={firmId} />
          <label className="sr-only" htmlFor={`pl-t-${firmId}`}>
            Tower
          </label>
          <select id={`pl-t-${firmId}`} name="phaseId" className="cl-select" defaultValue={towers[0].id}>
            {towers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`pl-a-${firmId}`}>
            Agent
          </label>
          <input id={`pl-a-${firmId}`} name="agentName" className="mv-input" maxLength={120} placeholder="Agent (optional)" />
          <button type="submit" className="btn btn--ghost btn--sm" disabled={pending}>
            {pending ? "Making" : "Make a link"}
          </button>
        </form>
      )}
      <Note state={state && !state.ok ? state : null} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// A registration linked to a booking by hand
// ---------------------------------------------------------------------------

export function LinkClaimForm({ registrationId, bookings }: { registrationId: string; bookings: { id: string; label: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, submit, pending] = useActionState<ClaimFormState, FormData>(linkClaimAction, null);
  const keep = useKeptSubmit(submit);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  if (!bookings.length) return null;
  if (!open) {
    return (
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
        Link to a booking
      </button>
    );
  }
  return (
    <form
      action={submit}
      onSubmit={(e) => {
        if (!window.confirm("Link this registration to the booking? The firm's commission on it becomes owed.")) {
          e.preventDefault();
          return;
        }
        keep(e);
      }}
      className="cl-form pf-link-claim"
    >
      <input type="hidden" name="registrationId" value={registrationId} />
      <F id={`lc-lead-${registrationId}`} label="Booking">
        <select id={`lc-lead-${registrationId}`} name="leadId" className="cl-select" required defaultValue="">
          <option value="" disabled>
            Choose a booking
          </option>
          {bookings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </F>
      <F id={`lc-why-${registrationId}`} label="Why it is this firm's">
        <input
          id={`lc-why-${registrationId}`}
          name="reason"
          className="mv-input"
          maxLength={200}
          minLength={4}
          required
          placeholder="Booked under the spouse's number"
        />
      </F>
      <Note state={state} />
      <div className="cl-actions">
        <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
          {state?.ok ? "Done" : "Cancel"}
        </button>
        <button type="submit" className="btn btn--ink" disabled={pending || !!state?.ok}>
          {pending ? "Linking" : "Link and owe commission"}
        </button>
      </div>
    </form>
  );
}
