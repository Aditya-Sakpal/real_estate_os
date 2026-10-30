import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getViewer } from "@/lib/console";
import { PageHead } from "@/components/shell/PageHead";
import { Board, Check, Clock, Inbox, Pause, Person, Phone, Play, Visit as VisitIcon } from "@/components/icons";
import { loadLead, otherEnquiries, type LeadDetail } from "@/lib/leads";
import { LeadCrmRows } from "./LeadCrmRows";
import { OtherNumbers } from "./OtherNumbers";
import { listLeadMessages, type MessageView } from "@/lib/messaging";
import { listCalls, towersToCall } from "@/lib/calling";
import { isDevelopment } from "@/lib/app-env";
import { lensFor, type LeadAt } from "@/lib/mask";
import { RevealPhone } from "@/components/RevealPhone";
import { ownPhone } from "@/lib/otp";
import { maskPhone } from "@/lib/mask-rules";
import { after } from "next/server";
import { settleCallsSoon } from "@/lib/lead-engine";
import { goalCallsOn } from "@/lib/sarvam";
import { leadVisits } from "@/lib/visits";
import { leadOutcomes } from "@/lib/attribution";
import { OUTCOME_LABEL, uploadLine } from "@/lib/attribution-rules";
import { resolveScopeNode } from "@/lib/scope-nodes";
import { PURPOSE_LABEL, inCallingHours, type Purpose } from "@/lib/cadence-rules";
import {
  GOAL_STATUS,
  LANGUAGE_LABEL,
  OUTCOME,
  verdictOf,
  agentLabel,
  durationLabel,
  istDate,
  istTime,
  momentLabel,
  type CallRecord,
} from "@/lib/call-rules";
import {
  FIELDS,
  addDays,
  digits,
  rupees,
  showDate,
  showTime,
  stageLabel,
  type FieldKey,
  type StageKey,
} from "@/lib/lead-rules";
import { STATUS as VISIT_STATUS } from "@/lib/visit-rules";
import { destinationDef, isDestination } from "@/lib/connect-rules";
import { clearNeedsAction, recordDndAction, setLeadAutomationAction } from "@/app/actions/leads";
import { dndVerdict, type DndStatus } from "@/lib/dnd-rules";
import { FIELD_WORDS, MIN_CONFIDENCE, QUAL_FIELDS, ROUTE_WORDS, valueWords } from "@/lib/qualification-rules";
import { listQuotes, quoteChoices } from "@/lib/quotes";
import { paymentAccount } from "@/lib/payments";
import { QuoteCard } from "./QuoteCard";
import { LeadActions, LiveRefresh, PendingButton } from "./LeadActions";
import { Recording } from "./Recording";
import { MilestoneForm } from "./Milestone";
import { LoanCard } from "./LoanCard";
import { loanFor } from "@/lib/loans";
import { RegisterWithDeveloper } from "./RegisterWithDeveloper";
import { partnerWork, registrationsForPhone } from "@/lib/partner-workspace";
import { outsideDevelopers, outsideForPhone } from "@/lib/outside";
import { longDay } from "@/lib/mandate-rules";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { eraseBuyerAction } from "@/app/actions/erasure";
import { enquiriesOfBuyer } from "@/lib/erasure";
import { erasureWarning } from "@/lib/erasure-rules";
import { isPacedNote } from "@/lib/wa-pacing-rules";
import "./lead.css";

/**
 * One lead: who it is, what the agent will do next, what we know, and
 * everything that has happened, newest first.
 *
 * The lead is read at its own tower. A viewer who holds `lead:read` somewhere
 * else in the tree gets a 404 here rather than a refusal, so a lead id says
 * nothing about a tower the viewer cannot see. Every other permission on the
 * page is asked at the same tower, and a control the viewer cannot use is
 * left out rather than drawn and refused.
 *
 * Every time on the page is Asia/Kolkata.
 */

type VisitRow = Awaited<ReturnType<typeof leadVisits>>[number];
type ActivityRow = LeadDetail["activity"][number];

type Item =
  | { kind: "call"; at: string; key: string; call: CallRecord }
  | { kind: "message"; at: string; key: string; message: MessageView }
  | { kind: "visit"; at: string; key: string; visit: VisitRow }
  | { kind: "activity"; at: string; key: string; activity: ActivityRow };

type NextItem = { key: string; sort: number; when: string; now: boolean; what: string; detail?: string };

const TEMP = {
  HOT: { label: "Hot", tone: "pill--risk" },
  WARM: { label: "Warm", tone: "pill--warn" },
  COLD: { label: "Cold", tone: "pill--blue" },
} as const;

const MESSAGE_STATUS: Record<string, { label: string; tone: string }> = {
  QUEUED: { label: "Sending", tone: "pill--quiet" },
  SENT: { label: "Sent", tone: "pill--quiet" },
  DELIVERED: { label: "Delivered", tone: "pill--blue" },
  READ: { label: "Read", tone: "pill--ok" },
  FAILED: { label: "Not delivered", tone: "pill--risk" },
  REFUSED: { label: "Not sent", tone: "pill--warn" },
};

/** The order a buyer's facts are read in, which is the order they are learned. */
/** How an upload's state reads: sent, on its way, never going, refused. */
const SENT_TONE = { ok: "pill--ok", wait: "pill--blue", off: "pill--quiet", bad: "pill--risk" } as const;

const FACT_ORDER: FieldKey[] = [
  "config",
  "budget",
  "timeline",
  "contactChannel",
  "contactedOn",
  "visitDate",
  "visitTime",
  "visitHost",
  "interest",
  "objection",
  "unit",
  "quote",
  "bookedOn",
  "agreement",
  "token",
];

/** Where the move dialog's label is a question rather than a name for the answer. */
const FACT_LABEL: Partial<Record<FieldKey, string>> = {
  contactChannel: "First reached by",
  contactedOn: "First contacted",
  visitTime: "Visit time",
  interest: "Interest after the visit",
};

function factValue(k: FieldKey, v: string): string {
  switch (FIELDS[k].kind) {
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? showDate(v) : v;
    case "time":
      return /^\d{2}:\d{2}$/.test(v) ? showTime(v) : v;
    case "money": {
      const n = Number(digits(v));
      return n > 0 ? rupees(n) : v;
    }
    default:
      return v;
  }
}

function stageTone(s: StageKey): string {
  if (s === "booked") return "pill--ok";
  if (s === "nurture" || s === "lost") return "pill--quiet";
  return "pill--blue";
}

function dayWord(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date === addDays(today, -1)) return "Yesterday";
  return showDate(date);
}

/** `Today, 7:00 pm` or `Sat 26 Sep, 11:00 am`, in IST. */
function moment(iso: string, today: string): string {
  return `${dayWord(istDate(iso), today)}, ${showTime(istTime(iso))}`;
}

/** A speech bubble in the icon set's hand: 1.5px stroke, round caps. */
function Bubble({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.2 18.8 5.3 15a7.6 7.6 0 1 1 3 2.9z" />
      <path d="M9 11.5h.01M12.3 11.5h.01M15.6 11.5h.01" />
    </svg>
  );
}

const DND_STATE: Record<DndStatus, { text: string; pill: string | null }> = {
  DND: { text: "On the register", pill: "pill--risk" },
  CONSENT_REGISTERED: { text: "Consent registered", pill: "pill--ok" },
  CLEAR: { text: "Not on the register", pill: null },
};
const DND_CHOICES: { status: DndStatus; label: string }[] = [
  { status: "DND", label: "On the register" },
  { status: "CONSENT_REGISTERED", label: "Consent registered" },
  { status: "CLEAR", label: "Not on the register" },
];

/** What stands about the number and the DND register, and, for somebody who may, a way to record it. */
function DndState({ leadId, status, canChange }: { leadId: string; status: DndStatus | null; canChange: boolean }) {
  const state = status ? DND_STATE[status] : null;
  return (
    <>
      {state ? (
        state.pill ? <span className={`pill ${state.pill}`}>{state.text}</span> : state.text
      ) : (
        <span className="ld-unset">Not checked</span>
      )}
      {canChange && (
        <details className="ld-dnd">
          <summary>Change</summary>
          <div className="ld-dnd__choices">
            {DND_CHOICES.filter((c) => c.status !== status).map((c) => (
              <form key={c.status} action={recordDndAction}>
                <input type="hidden" name="leadId" value={leadId} />
                <input type="hidden" name="status" value={c.status} />
                <PendingButton className="btn btn--light btn--sm" pending="Saving">
                  {c.label}
                </PendingButton>
              </form>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:read")) redirect("/dashboard");

  const [{ id }, q] = await Promise.all([params, searchParams]);
  const orgId = viewer.state.org.id;
  const lead = await loadLead(orgId, id);
  if (!lead) notFound();
  const flashed = { error: readFlash(q, "error"), note: readFlash(q, "note") };
  if (lead.erasedAt) return <ErasedLead orgId={orgId} lead={lead} flashed={flashed} canRead={(path) => viewer.authz.canAt("lead:read", path)} />;
  // A call whose result never arrived is asked of Sarvam after the page is sent.
  after(() => settleCallsSoon(orgId));

  // Every number on this page goes through the viewer's lens, so what
  // reaches the browser is what the policy lets them see.
  const lens = await lensFor(orgId, viewer.authz);
  const [node, messages, calls, visits, outcomes] = await Promise.all([
    resolveScopeNode(orgId, lead.phaseId),
    listLeadMessages(orgId, lead.id),
    listCalls(orgId, { lens, scopes: viewer.authz.scopesFor("lead:read") }, 100, lead.id),
    leadVisits(orgId, lead.id),
    leadOutcomes(orgId, lead.id),
  ]);
  if (!node || !viewer.authz.canAt("lead:read", node.path)) notFound();

  const canCall = viewer.authz.canAt("lead:call", node.path);
  const canErase = viewer.authz.canAt("lead:erase", node.path);
  const enquiries = canErase ? await enquiriesOfBuyer(orgId, lead.id) : 0;
  // The same buyer's enquiries about other projects or towers, where this person may read them.
  const sameBuyer = (await otherEnquiries(orgId, lead.id)).filter((e) => viewer.authz.canAt("lead:read", e.path));
  const canUpdate = viewer.authz.canAt("lead:update", node.path);
  // A quote is for a buyer who has seen the site, and for whoever may draft or approve one here.
  const canDraft = viewer.authz.canAt("quote:create", node.path);
  const canApprove = viewer.authz.canAt("quote:approve", node.path);
  // A lost lead is read too: a cancelled token's refund is followed from its card.
  const quoting = (canDraft || canApprove) && ["visit_done", "negotiation", "booked", "lost"].includes(lead.stage);
  const [quotes, choices, payAccount] = quoting
    ? await Promise.all([listQuotes(orgId, lead.id), quoteChoices(orgId, lead.id), paymentAccount(orgId)])
    : [[], { units: [], flats: [], woman: null }, null];
  const lastQuote = quotes[0] ?? null;
  // Any part of the token paid: the card stays, so the parts can be cancelled and refunded.
  const tokenPaid = !!lastQuote && lastQuote.state === "SENT" && lastQuote.paid > 0;
  const showQuote = quoting && (lead.stage === "lost"
    ? !!lastQuote && (lastQuote.state === "CANCELLED" || tokenPaid)
    : lead.stage !== "booked" || quotes.length > 0);
  // A buyer's home loan: shown once one is recorded, and to whoever follows loans here.
  const canLoan = viewer.authz.canAt("loan:update", node.path);
  const loan = await loanFor(orgId, lead.id);
  const showLoan = !!loan || (canLoan && lead.stage !== "lost");
  const at: LeadAt = { path: node.path, stage: lead.pathStage };

  const now = new Date();
  const nowMs = now.getTime();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const paused = lead.automation === "PAUSED";
  const liveCall = calls.some((c) => c.live);

  // Why a control cannot be pressed right now, in the order the server
  // would refuse it: an opt-out is final, then a call already on the line,
  // then the hours nobody is called outside.
  const optedOutWhy = "This buyer opted out of calls and WhatsApp";
  const dndWhy = dndVerdict({ standing: lead.dnd, enquiredAt: lead.enquiredAt, nowIso: now.toISOString() }).ok
    ? null
    : "On the DND register, and the enquiry is over 7 days old";
  const callBlocked = lead.optedOut
    ? optedOutWhy
    : liveCall
      ? "A call is on the line now"
      : !isDevelopment() && !inCallingHours(now.toISOString())
        ? "Calls go out between 10 am and 9 pm"
        : dndWhy;
  const locationBlocked = lead.optedOut ? optedOutWhy : null;
  // A call from one's own phone is still a call to the buyer: the same
  // opt-out, hours and register. A live AI call does not hold it up.
  const proxyBlocked = lead.optedOut
    ? optedOutWhy
    : !isDevelopment() && !inCallingHours(now.toISOString())
      ? "Calls go out between 10 am and 9 pm"
      : dndWhy;
  const [own, towers] = canCall
    ? await Promise.all([
        ownPhone(orgId, viewer.userId),
        goalCallsOn() ? towersToCall(orgId, viewer.authz.scopesFor("lead:call")) : Promise.resolve([]),
      ])
    : [null, []];

  // A channel partner registers its own lead with the developers that empanelled it.
  const partner = viewer.orgType === "CHANNEL_PARTNER" && !viewer.via;
  const [work, onPlatform, outsideDevs, outsideRegs] = partner
    ? await Promise.all([
        partnerWork(orgId),
        registrationsForPhone(orgId, lead.phone),
        outsideDevelopers(orgId),
        outsideForPhone(orgId, lead.phone, istDate(new Date().toISOString())),
      ])
    : [null, [], [], []];
  // Developers on Sales Desk that empanelled the partner, and the ones it
  // added itself that take registrations by email.
  const registered = [...onPlatform, ...outsideRegs];
  const devProjects = [
    ...(work
      ? work.developers.flatMap((d) =>
          d.projects.filter((p) => p.status === "live").map((p) => ({ value: `${d.orgId}:${p.id}`, label: `${p.name} · ${d.name}` })),
        )
      : []),
    ...outsideDevs.filter((d) => d.setup).flatMap((d) => d.projects.map((p) => ({ value: `out:${p.id}`, label: `${p.name} · ${d.name}` }))),
  ];

  // ---- who it is ----------------------------------------------------------
  const phone = lens.phone(lead.phone, at);
  const email = lead.email ? lens.email(lead.email, at).text || null : null;
  const ad = lead.publication && isDestination(lead.publication.destination)
    ? `${destinationDef(lead.publication.destination).label}${lead.publication.headline ? `: “${lead.publication.headline}”` : ""}`
    : null;
  const firstEnquiry = istDate(lead.createdAt) !== istDate(lead.enquiredAt) ? lead.createdAt : null;

  // ---- what we know -------------------------------------------------------
  const facts: { label: string; value: string }[] = FACT_ORDER.flatMap((k) => {
    const v = lead.facts[k]?.trim();
    return v ? [{ label: FACT_LABEL[k] ?? FIELDS[k].label, value: factValue(k, v) }] : [];
  });
  if (lead.stage === "nurture" || lead.stage === "lost") {
    if (lead.exitReason) {
      facts.push({ label: lead.stage === "lost" ? "Lost because" : "In nurture because", value: lead.exitReason });
    }
    if (lead.followUpOn) facts.push({ label: "Follow up on", value: showDate(lead.followUpOn) });
  }
  // What the calls heard, each with the buyer's own words.
  // What a form said is shown as the form's, never as something a call heard.
  const heard = QUAL_FIELDS.flatMap((field) => {
    const h = lead.qualification[field];
    return h && h.detail !== "form" ? [{ field, value: valueWords(field, h), span: h.span, unsure: h.confidence < MIN_CONFIDENCE }] : [];
  });

  // ---- what happens next --------------------------------------------------
  const upcoming = (v: VisitRow) =>
    Date.parse(v.at) > nowMs && (v.status === "confirmed" || v.status === "requested");
  const next: NextItem[] = [
    ...lead.tasks
      .filter((t) => t.state === "DUE" || t.state === "WORKING")
      .map((t) => ({
        key: t.id,
        sort: Date.parse(t.dueAt),
        when: moment(t.dueAt, today),
        now: t.state === "WORKING" || (!paused && Date.parse(t.dueAt) <= nowMs),
        what: PURPOSE_LABEL[t.purpose as Purpose] ?? t.purpose,
        // A message held for the number's daily WhatsApp limit says so.
        detail: t.state === "DUE" && isPacedNote(t.result) ? t.result! : undefined,
      })),
    ...visits.filter(upcoming).map((v) => ({
      key: v.id,
      sort: Date.parse(v.at),
      when: moment(v.at, today),
      now: false,
      what: v.status === "requested" ? "Site visit, awaiting reply" : "Site visit",
      detail: v.host ? `Hosted by ${v.host}` : undefined,
    })),
  ].sort((a, b) => a.sort - b.sort);

  // ---- everything so far --------------------------------------------------
  // A visit still to come is in "next", not in the history. One that was
  // moved or cancelled before its day is told by the visit that replaced it
  // and by the stage change, so it is left out rather than dated ahead.
  const items: Item[] = [
    ...calls.map((c): Item => ({ kind: "call", at: c.startedAt, key: `c-${c.id}`, call: c })),
    ...messages.map((m): Item => ({ kind: "message", at: m.at, key: `m-${m.id}`, message: { ...m, body: lens.text(m.body, at) ?? "" } })),
    ...visits
      .filter((v) => Date.parse(v.at) <= nowMs)
      .map((v): Item => ({ kind: "visit", at: v.at, key: `v-${v.id}`, visit: v })),
    ...lead.activity.map((a, i): Item => ({ kind: "activity", at: a.at, key: `a-${i}-${a.at}`, activity: a })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const days: { date: string; items: Item[] }[] = [];
  for (const item of items) {
    const d = istDate(item.at);
    const last = days[days.length - 1];
    if (last && last.date === d) last.items.push(item);
    else days.push({ date: d, items: [item] });
  }

  const actions =
    canCall || canUpdate ? (
      <LeadActions
        leadId={lead.id}
        leadName={lead.name}
        call={canCall ? { blocked: callBlocked } : null}
        goals={
          canCall && goalCallsOn()
            ? [
                "Invite them for a site visit",
                ...(lead.stage === "visit_done" || lead.stage === "negotiation" ? ["Ask how their site visit went"] : []),
              ]
            : null
        }
        towers={towers}
        enquired={lead.phaseId}
        location={canUpdate ? { blocked: locationBlocked } : null}
        proxy={canCall ? { blocked: proxyBlocked, own: own ? maskPhone(own) : null } : null}
      />
    ) : undefined;

  return (
    <>
      <LiveRefresh active={liveCall} />
      <PageHead
        back={{ label: "Pipeline", href: "/dashboard/leads" }}
        title={lead.name}
        meta={
          <>
            <span className={`pill ${stageTone(lead.stage)}`} style={{ marginRight: 8 }}>
              {stageLabel(lead.stage)}
            </span>
            {lead.place} · enquired {momentLabel(lead.enquiredAt, today)}
          </>
        }
        action={actions}
      />
      <Flash text={flashed.error} name="error" tone="risk" style={{ marginBottom: 16 }} />

      {lead.needsPerson && (
        <section className="ld-needs" aria-label="Needs you">
          <span className="ld-needs__dot" aria-hidden />
          <div className="ld-needs__body">
            <p className="ld-needs__label">Needs you</p>
            <p className="ld-needs__text">{lens.text(lead.needsPerson, at)}</p>
          </div>
          {canUpdate && (
            <form action={clearNeedsAction} className="ld-needs__act">
              <input type="hidden" name="leadId" value={lead.id} />
              <PendingButton className="btn btn--light btn--sm" pending="Saving">
                Done
              </PendingButton>
            </form>
          )}
        </section>
      )}

      <div className="ld-grid">
        <div className="ld-col">
          {/* ---- who it is ---- */}
          <section className="card ld-card ld-about" aria-labelledby="ld-about-h">
            <div className="card__head">
              <h2 id="ld-about-h" className="ld-h">
                Lead
              </h2>
            </div>
            <dl className="ld-dl">
              <Row label="Phone">
                <span style={{ display: "inline-flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <RevealPhone leadId={lead.id} shown={phone} />
                </span>
                {lead.optedOut && <span className="pill pill--risk ld-dl__pill">Opted out</span>}
              </Row>
              <OtherNumbers orgId={orgId} leadId={lead.id} lens={lens} at={at} canUpdate={canUpdate} />
              <Row label="DND">
                <DndState leadId={lead.id} status={lead.dnd?.status ?? null} canChange={canUpdate} />
              </Row>
              {email && <Row label="Email">{email}</Row>}
              <Row label="Temperature">
                {lead.stage === "visit_scheduled" ? (
                  <span className="pill pill--ok">Visit booked</span>
                ) : lead.temperature ? (
                  <span className={`pill ${TEMP[lead.temperature].tone}`}>{TEMP[lead.temperature].label}</span>
                ) : (
                  <span className="ld-unset">Not known yet</span>
                )}
              </Row>
              <Row label="Language">{LANGUAGE_LABEL[lead.language] ?? lead.language}</Row>
              <Row label="Tower">{lead.place}</Row>
              <Row label="Source">{lead.source}</Row>
              {ad ? (
                <Row label="Ad">{ad}</Row>
              ) : (
                lead.lineage.utmCampaign && <Row label="Campaign">{lead.lineage.utmCampaign}</Row>
              )}
              <Row label="Owner">{lead.owner ?? <span className="ld-unset">AI agent</span>}</Row>
              <LeadCrmRows
                orgId={orgId}
                leadId={lead.id}
                towerId={lead.phaseId}
                config={lead.facts.config ?? null}
                mayReadInventory={viewer.authz.canAt("inventory:read", node.path)}
              />
              <Row label="Enquired">{moment(lead.enquiredAt, today)}</Row>
              {firstEnquiry && <Row label="First enquiry">{moment(firstEnquiry, today)}</Row>}
            </dl>
            {canErase && (
              <div className="ld-erase">
                <ConfirmAction
                  label="Erase this buyer's data"
                  title="Erase this buyer's data?"
                  body={<p>{erasureWarning(enquiries)}</p>}
                  confirmLabel="Erase for good"
                  action={eraseBuyerAction}
                  fields={{ leadId: lead.id }}
                  tone="risk"
                  testId="erase-buyer"
                />
              </div>
            )}
          </section>

          {/* ---- what we know ---- */}
          <section className="card ld-card ld-known" aria-labelledby="ld-known-h">
            <div className="card__head">
              <h2 id="ld-known-h" className="ld-h">
                What we know
              </h2>
              {lead.route && (
                <span className={`pill ${lead.route === "HOT" ? "pill--risk" : lead.route === "WARM" ? "pill--warn" : lead.route === "JUNK" ? "pill--quiet" : "pill--blue"}`}>
                  {ROUTE_WORDS[lead.route]}
                  {lead.score !== null && lead.route !== "JUNK" && <span className="tnum"> · {lead.score}</span>}
                </span>
              )}
            </div>
            {facts.length > 0 ? (
              <dl className="ld-dl">
                {facts.map((f) => (
                  <Row key={f.label} label={f.label}>
                    {f.value}
                  </Row>
                ))}
              </dl>
            ) : (
              <p className="ld-empty">Nothing recorded yet.</p>
            )}
            {lead.formAnswers.length > 0 && (
              <>
                <p className="ld-heard__h">On the form</p>
                <dl className="ld-dl">
                  {lead.formAnswers.map((a) => (
                    <Row key={a.question} label={a.question}>
                      {a.answer}
                    </Row>
                  ))}
                </dl>
              </>
            )}
            {heard.length > 0 && (
              <>
                <p className="ld-heard__h">Heard on the calls</p>
                <dl className="ld-dl">
                  {heard.map((h) => (
                    <Row key={h.field} label={FIELD_WORDS[h.field]}>
                      {h.value}
                      {h.unsure && <span className="pill pill--quiet ld-dl__pill">Not sure</span>}
                      <span className="ld-heard__said">&ldquo;{lens.text(h.span, at)}&rdquo;</span>
                    </Row>
                  ))}
                </dl>
              </>
            )}
          </section>

          {/* ---- milestones, and what the ad that bought it was told ---- */}
          {outcomes.outcomes.length > 0 && (
            <section className="card ld-card ld-miles" aria-labelledby="ld-miles-h">
              <div className="card__head">
                <h2 id="ld-miles-h" className="ld-h">
                  Milestones
                </h2>
                {outcomes.from.length > 0 && (
                  <span className={`pill ${outcomes.measured ? "pill--ok" : "pill--quiet"}`}>
                    {outcomes.measured ? "Agreed to ad measurement" : "No ad measurement consent"}
                  </span>
                )}
              </div>
              <ol className="ld-out">
                {outcomes.outcomes.map((o) => (
                  <li key={o.id} className="ld-task">
                    <span className="ld-task__what">{OUTCOME_LABEL[o.kind]}</span>
                    <span className="ld-task__when tnum">{showDate(istDate(o.at))}</span>
                    {o.uploads.length > 0 && (
                      <span className="ld-out__sent">
                        {o.uploads.map((u) => {
                          const line = uploadLine(u);
                          return (
                            <span key={u.platform} className={`pill ${SENT_TONE[line.tone]}`}>
                              {line.text}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              {canUpdate && outcomes.next && (
                <MilestoneForm leadId={lead.id} kind={outcomes.next.kind} label={outcomes.next.label} today={today} />
              )}
            </section>
          )}
        </div>

        <div className="ld-col">
          {showQuote && (
            <QuoteCard
              leadId={lead.id}
              quote={lastQuote}
              choices={choices}
              today={today}
              canDraft={canDraft && lead.stage !== "booked" && lead.stage !== "lost"}
              canApprove={canApprove}
              paymentsOn={payAccount?.status === "ACTIVE"}
            />
          )}

          {showLoan && <LoanCard leadId={lead.id} loan={loan} canUpdate={canLoan} />}

          {sameBuyer.length > 0 && (
            <section className="card ld-card" aria-labelledby="ld-same-h" data-same-buyer>
              <div className="card__head">
                <h2 id="ld-same-h" className="ld-h">
                  Same buyer, other projects
                </h2>
                <span className="pill pill--quiet">{sameBuyer.length}</span>
              </div>
              <ol className="ld-out">
                {sameBuyer.map((e) => (
                  <li key={e.id} className="ld-task">
                    <a href={`/dashboard/leads/${e.id}`} className="ld-task__what">
                      {e.place}
                    </a>
                    <span className="ld-task__when">
                      {stageLabel(e.stage as Parameters<typeof stageLabel>[0])} · {showDate(istDate(e.lastActivity))}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {partner && (devProjects.length > 0 || registered.length > 0) && (
            <RegisterWithDeveloper
              leadId={lead.id}
              projects={devProjects}
              registrations={registered.map((r) => ({ ...r, until: r.until ? longDay(r.until) : null }))}
              canRegister={viewer.authz.can("partner:register")}
            />
          )}

          {/* ---- what happens next ---- */}
          <section className={`card ld-card ld-next${paused ? " is-paused" : ""}`} aria-labelledby="ld-next-h">
            <div className="card__head">
              <h2 id="ld-next-h" className="ld-h">
                What happens next
              </h2>
              <span className={`pill ${paused ? "pill--warn" : "pill--blue"}`}>
                <span className="pill__dot" />
                {paused ? "Paused" : "Automatic"}
              </span>
            </div>
            {next.length > 0 ? (
              <ol className="ld-next__list">
                {next.map((n) => (
                  <li key={n.key} className="ld-task">
                    <span className="ld-task__what">{n.what}</span>
                    <span className={`ld-task__when tnum${n.now ? " is-now" : ""}`}>{n.now ? "Now" : n.when}</span>
                    {n.detail && <span className="ld-task__detail">{n.detail}</span>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="ld-empty">Nothing scheduled.</p>
            )}
            {(paused || canUpdate) && (
              <div className="ld-auto">
                {paused && <p className="ld-auto__state">Nothing goes out on its own while paused.</p>}
                {canUpdate && (
                  <form action={setLeadAutomationAction}>
                    <input type="hidden" name="leadId" value={lead.id} />
                    <input type="hidden" name="on" value={paused ? "true" : "false"} />
                    <PendingButton className="btn btn--ghost btn--sm" pending={paused ? "Resuming" : "Pausing"}>
                      {paused ? "Resume AI calls and messages" : "Pause AI calls and messages"}
                    </PendingButton>
                  </form>
                )}
              </div>
            )}
          </section>

          {/* ---- everything so far ---- */}
          <section className="card ld-card ld-history" aria-labelledby="ld-history-h">
            <div className="card__head">
              <h2 id="ld-history-h" className="ld-h">
                History
              </h2>
              {items.length > 0 && (
                <span className="ld-count tnum">
                  {items.length.toLocaleString("en-IN")} {items.length === 1 ? "event" : "events"}
                </span>
              )}
            </div>
            {days.length === 0 ? (
              <p className="ld-empty">Nothing yet.</p>
            ) : (
              days.map((d) => (
                <section key={d.date} className="ld-day" aria-label={dayWord(d.date, today)}>
                  <h3 className="ld-day__head">{dayWord(d.date, today)}</h3>
                  <ol className="ld-tl">
                    {d.items.map((item) => (
                      <HistoryItem key={item.key} item={item} />
                    ))}
                  </ol>
                </section>
              ))
            )}
          </section>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// One line of the history
// ---------------------------------------------------------------------------

function HistoryItem({ item }: { item: Item }) {
  const time = <span className="ld-ev__time tnum">{showTime(istTime(item.at))}</span>;

  if (item.kind === "call") {
    const c = item.call;
    const o = verdictOf(c);
    const connected = c.connectivity === "connected" && !c.live;
    const meta = c.live
      ? null
      : connected
        ? `${durationLabel(c.duration)} · ${LANGUAGE_LABEL[c.language] ?? c.language}`
        : c.outcome === "NOT_PLACED"
          ? null
          : `Try ${c.attempt} of ${c.maxAttempts}`;
    return (
      <li className="ld-ev">
        <span className="ld-ev__mark ld-ev__mark--call" aria-hidden>
          <Phone size={14} />
        </span>
        <div className="ld-ev__body">
          <div className="ld-ev__head">
            <p className="ld-ev__title">{agentLabel(c.agent)} call</p>
            <span className={`pill pill--${o.tone}`}>
              <span className="pill__dot" />
              {o.label}
            </span>
            {time}
          </div>
          {meta && <p className="ld-ev__meta tnum">{meta}</p>}
          {c.goal && (
            <p className="ld-ev__text">
              Goal: {c.goal.text}
              {c.goal.status ? ` (${GOAL_STATUS[c.goal.status].label.toLowerCase()})` : ""}
            </p>
          )}
          {c.summary && <p className="ld-ev__text">{c.summary}</p>}
          {connected && c.recordingUrl && <Recording url={c.recordingUrl} duration={c.duration ?? 0} className="ld-rec" />}
        </div>
      </li>
    );
  }

  if (item.kind === "message") {
    const m = item.message;
    const incoming = m.direction === "IN";
    const status = incoming ? null : MESSAGE_STATUS[m.status];
    const unsent = m.status === "REFUSED" || m.status === "FAILED";
    return (
      <li className="ld-ev">
        <span className="ld-ev__mark ld-ev__mark--msg" aria-hidden>
          <Bubble />
        </span>
        <div className="ld-ev__body">
          <div className="ld-ev__head">
            <p className="ld-ev__title">{incoming ? "Replied on WhatsApp" : `${m.channel === "SMS" ? "SMS" : "WhatsApp"}: ${m.label}`}</p>
            {status && <span className={`pill ${status.tone}`}>{status.label}</span>}
            {time}
          </div>
          {m.body && (
            <p className={`ld-bubble${incoming ? " ld-bubble--in" : ""}${unsent ? " is-unsent" : ""}`}>{m.body}</p>
          )}
          {unsent && m.error && (
            <p className={`ld-ev__why ld-ev__why--${m.status === "FAILED" ? "risk" : "warn"}`}>{m.error}</p>
          )}
        </div>
      </li>
    );
  }

  if (item.kind === "visit") {
    const v = item.visit;
    const s = VISIT_STATUS[v.status];
    const o = v.outcome;
    const said = o
      ? [
          o.interest && `Interest: ${o.interest}`,
          o.objection && `Objection: ${o.objection}`,
          o.next && `Next: ${o.next}`,
        ].filter((x): x is string => Boolean(x))
      : [];
    return (
      <li className="ld-ev">
        <span className="ld-ev__mark ld-ev__mark--visit" aria-hidden>
          <VisitIcon size={14} />
        </span>
        <div className="ld-ev__body">
          <div className="ld-ev__head">
            <p className="ld-ev__title">Site visit</p>
            <span className={`pill pill--${s.tone}`}>{s.label}</span>
            {time}
          </div>
          <p className="ld-ev__meta">
            {v.host ? `Hosted by ${v.host} · ` : ""}Booked through {v.bookedVia}
          </p>
          {said.length > 0 && <p className="ld-ev__text">{said.join(" · ")}</p>}
          {o?.note && <q className="ld-ev__note">{o.note}</q>}
        </div>
      </li>
    );
  }

  const a = item.activity;
  const mark =
    a.kind === "STAGE" ? (
      <Board size={14} />
    ) : a.kind === "CAPTURED" ? (
      <Inbox size={14} />
    ) : a.kind === "ASSIGNED" ? (
      <Person size={14} />
    ) : a.kind === "AUTOMATION" ? (
      /resumed/i.test(a.text) ? <Play size={13} /> : <Pause size={13} />
    ) : a.kind === "NOTE" ? (
      <Check size={14} />
    ) : a.kind === "CALL_IN" ? (
      <Phone size={14} />
    ) : (
      <Clock size={14} />
    );
  return (
    <li className="ld-ev">
      <span className={`ld-ev__mark${a.kind === "STAGE" ? " ld-ev__mark--stage" : ""}`} aria-hidden>
        {mark}
      </span>
      <div className="ld-ev__body">
        <div className="ld-ev__head">
          <p className="ld-ev__title ld-ev__title--plain">{a.text}</p>
          {time}
        </div>
        {a.note && <q className="ld-ev__note">{a.note}</q>}
      </div>
    </li>
  );
}

/**
 * A lead whose buyer asked to be erased: what is left is the record that an
 * enquiry happened, where, and how far it went. Nothing on it can be acted
 * on, because there is nobody left to act towards.
 */
async function ErasedLead({
  orgId,
  lead,
  flashed,
  canRead,
}: {
  orgId: string;
  lead: LeadDetail;
  flashed: { error: string | null; note: string | null };
  canRead: (path: string) => boolean;
}) {
  const node = await resolveScopeNode(orgId, lead.phaseId);
  if (!node || !canRead(node.path)) notFound();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return (
    <>
      <PageHead
        back={{ label: "Pipeline", href: "/dashboard/leads" }}
        title={lead.name}
        meta={
          <>
            <span className={`pill ${stageTone(lead.stage)}`} style={{ marginRight: 8 }}>
              {stageLabel(lead.stage)}
            </span>
            {lead.place} · enquired {momentLabel(lead.enquiredAt, today)}
          </>
        }
      />
      <Flash text={flashed.error} name="error" tone="risk" style={{ marginBottom: 16 }} />
      <Flash text={flashed.error ? null : flashed.note} name="note" tone="info" style={{ marginBottom: 16 }} />
      <section className="card ld-card" aria-labelledby="ld-erased-h">
        <div className="card__head">
          <h2 id="ld-erased-h" className="ld-h">
            Erased at the buyer's request
          </h2>
          <span className="pill pill--quiet">{lead.erasedAt ? momentLabel(lead.erasedAt, today) : ""}</span>
        </div>
        <dl className="ld-dl">
          <Row label="Tower">{lead.place}</Row>
          <Row label="Stage">{stageLabel(lead.stage)}</Row>
          <Row label="Source">{lead.source}</Row>
          <Row label="Owner">{lead.owner ?? <span className="ld-unset">Nobody</span>}</Row>
          <Row label="Contact">Never contacted again</Row>
        </dl>
      </section>
    </>
  );
}

