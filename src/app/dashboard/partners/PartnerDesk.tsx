"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { PageHead } from "@/components/shell/PageHead";
import { Alert, ArrowUpRight, Check, ChevronDown, Clock, Close, Partners as PartnersIcon, Search } from "@/components/icons";
import { rupees, rupeesShort, showDate } from "@/lib/lead-rules";
import { showPhone } from "@/lib/call-rules";
import {
  DORMANT_AFTER,
  GST_RATE,
  LATE_AFTER,
  PAY_STATE,
  REG_STATE,
  REGISTRATION_DAYS,
  RELEASE_AT,
  TDS_RATE,
  VISIT_EXTENDS,
  commissionOn,
  daysBetween,
  daysLeft,
  daysOwed,
  docState,
  isDormant,
  isOwed,
  ladder,
  MATCHED_BY_LABEL,
  netAfterAdjustments,
  ordinal,
  pct,
  payNext,
  regState,
  validUntil,
  type Booking,
  type DocState,
  type Firm,
  type FirmProject,
  type PayState,
  type RegState,
  type RefuseReason,
  type Registration,
  type Rung,
} from "@/lib/partner-rules";
import type { FirmOption, PartnerAgent, PartnerLink, PartnerPost, PartnerSettings, ProjectOption } from "@/lib/partners";
import { findRegistrationAction } from "@/app/actions/partners";
import {
  AddProjects,
  AgentsPanel,
  BookingDates,
  EditFirmDialog,
  EmpanelDialog,
  GrantControls,
  HalfActions,
  InvoiceForm,
  InvoiceLink,
  LinksPanel,
  PassBack,
  RegisterDialog,
  RevealNumber,
  SettingsRow,
  TermsDialog,
  VisitForm,
  LinkClaimForm,
} from "./PartnerForms";
import { AppointDialog, MandatesView } from "./Mandates";
import type { MandateProject, MandateRow } from "@/lib/mandates";

export type DeskView = "firms" | "buyers" | "payouts" | "mandates";

const TABS: Record<DeskView, string> = {
  firms: "Channel partners",
  buyers: "Buyers registered",
  payouts: "Payouts",
  mandates: "Mandate firms",
};

export type Can = {
  approve: boolean;
  unmask: boolean;
  empanel: boolean;
  suspend: boolean;
  register: boolean;
  pay: boolean;
  schedule: boolean;
  settings: boolean;
  mandate: boolean;
};
type Stage = Booking["progress"]["M1"]["stage"];

/** The desk as drawn: real rows once a firm exists, the sample before. */
export type DeskData = {
  real: boolean;
  firms: Firm[];
  registrations: (Registration & { projectId?: string; live?: boolean; leadId?: string | null; canReveal?: boolean; linkable?: boolean })[];
  bookings: Booking[];
  projects: ProjectOption[];
  firmOptions: FirmOption[];
  settings: PartnerSettings;
  people: { id: string; name: string }[];
  /** Booked leads no partner is paid on, for linking a registration by hand. */
  unclaimedBookings?: { id: string; label: string }[];
  agents?: PartnerAgent[];
  links?: PartnerLink[];
  posts?: PartnerPost[];
  mandates?: MandateRow[];
  mandateProjects?: MandateProject[];
};

const count = (n: number) => n.toLocaleString("en-IN");
const ago = (iso: string | null, today: string) => {
  if (!iso) return "Never";
  const d = daysBetween(iso, today);
  return d === 0 ? "Today" : d === 1 ? "Yesterday" : `${d} days ago`;
};

export function PartnerDesk({
  today,
  view: initial,
  views,
  can,
  desk,
  via,
}: {
  today: string;
  view: DeskView;
  views: DeskView[];
  can: Can;
  desk: DeskData;
  /** Set when a mandate firm works its own desk on a developer's projects. */
  via?: { firm: string; developer: string };
}) {
  const real = desk.real;
  const seesMoney = views.includes("payouts");
  const seesFirms = views.includes("firms");

  const [view, setViewState] = useState<DeskView>(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sub, setSub] = useState<string>("all");
  const [query, setQuery] = useState("");
  // What people did on the sample, laid over it. Nothing is saved there.
  const [stages, setStages] = useState<Record<string, Stage>>({});
  const [rulings, setRulings] = useState<Record<string, "keep" | "split">>({});
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);

  const bookings = useMemo(
    () =>
      desk.bookings.map((b) => {
        const m1 = stages[`${b.id}|M1`];
        const m2 = stages[`${b.id}|M2`];
        if (!m1 && !m2) return b;
        return {
          ...b,
          progress: {
            M1: m1 ? { ...b.progress.M1, stage: m1 } : b.progress.M1,
            M2: m2 ? { ...b.progress.M2, stage: m2 } : b.progress.M2,
          },
        };
      }),
    [desk.bookings, stages],
  );

  const go = (v: DeskView, opts?: { sub?: string; open?: string }) => {
    setViewState(v);
    setSub(opts?.sub ?? "all");
    setQuery("");
    setOpenId(opts?.open ?? null);
    try {
      window.history.replaceState(null, "", `?view=${v}`);
    } catch {
      /* the address is a convenience; the view has already changed */
    }
    if (opts?.open) {
      requestAnimationFrame(() =>
        document.getElementById(`pt-row-${opts.open}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const id = openId;
      setOpenId(null);
      document.getElementById(`pt-btn-${id}`)?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId]);

  const setStage = (b: Booking, key: "M1" | "M2", stage: Stage, text: string) => {
    const before = stages;
    setStages({ ...stages, [`${b.id}|${key}`]: stage });
    setToast({ text, undo: () => setStages(before) });
  };
  const rule = (reg: Registration, how: "keep" | "split", text: string) => {
    const before = rulings;
    setRulings({ ...rulings, [reg.id]: how });
    setToast({ text, undo: () => setRulings(before) });
  };

  // --- the measures --------------------------------------------------------
  const since30 = (iso: string | null) => !!iso && daysBetween(iso, today) <= 30 && daysBetween(iso, today) >= 0;
  const firmStats = useMemo(() => {
    const out = new Map<string, { live: number; visits30: number; last: string | null; owed: number; paidYear: number }>();
    for (const f of desk.firms) out.set(f.id, { live: 0, visits30: 0, last: null, owed: 0, paidYear: 0 });
    const idOf = new Map(desk.firms.map((f) => [f.name, f.id]));
    for (const r of desk.registrations) {
      const s = out.get(r.firmId ?? idOf.get(r.firm) ?? "");
      if (!s || r.refused) continue;
      const st = regState(r, today);
      if (st === "live" || st === "lapsing" || st === "visited") s.live++;
      if (since30(r.visitedOn)) s.visits30++;
      if (!s.last || r.registeredOn > s.last) s.last = r.registeredOn;
    }
    for (const b of bookings) {
      const s = out.get(b.firmId ?? idOf.get(b.firm) ?? "");
      if (!s) continue;
      for (const r of ladder(b)) {
        if (isOwed(r)) s.owed += r.invoice.net;
        if (r.state === "paid" && r.paidOn && daysBetween(r.paidOn, today) <= 365) s.paidYear += r.invoice.net;
      }
    }
    return out;
  }, [desk, bookings, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = desk.firms.filter((f) => !isDormant(firmStats.get(f.id)?.last ?? null, today)).length;
  const regs30 = desk.registrations.filter((r) => since30(r.registeredOn));
  const refused30 = regs30.filter((r) => r.refused).length;
  const cp90 = bookings.filter((b) => !b.cancelled && daysBetween(b.bookedOn, today) <= 90).length;
  const live = desk.registrations.filter((r) => ["live", "lapsing", "visited"].includes(regState(r, today))).length;
  const rungs = bookings.flatMap((b) => ladder(b).map((r) => ({ b, r })));
  const owed = rungs.filter(({ r }) => isOwed(r));
  const owedTotal = owed.reduce((s, { r }) => s + r.invoice.net, 0);
  const late = owed.filter(({ r }) => (daysOwed(r, today) ?? 0) > LATE_AFTER);
  const paidRecent = rungs.filter(({ r }) => r.state === "paid" && r.paidOn && r.owedSince && daysBetween(r.paidOn, today) <= 180);
  const daysToPay = paidRecent.length
    ? Math.round(paidRecent.reduce((s, { r }) => s + daysBetween(r.owedSince!, r.paidOn!), 0) / paidRecent.length)
    : null;
  const disputes = desk.registrations.filter((r) => r.disputed && !rulings[r.id]);
  const mandates = desk.mandates ?? [];
  const mandatesLive = mandates.filter((m) => m.state === "live").length;
  const mandatesWaiting = mandates.filter((m) => m.state === "offered" || m.state === "invited").length;

  return (
    <div className="pt">
      <PageHead
        title={
          via ? (
            <>
              Your channel <span className="em">partners</span>
            </>
          ) : (
            <>
              Sales <span className="em">partners</span>
            </>
          )
        }
        meta={
          via && real ? (
            <>
              On {via.developer}&rsquo;s projects · {count(desk.firms.length)} {desk.firms.length === 1 ? "channel partner" : "channel partners"} · {count(live)} {live === 1 ? "buyer" : "buyers"} held
            </>
          ) : view === "mandates" ? (
            <>
              {count(mandates.length)} {mandates.length === 1 ? "mandate" : "mandates"} · {count(mandatesLive)} live
            </>
          ) : real ? (
            <>
              {count(desk.firms.length)} {desk.firms.length === 1 ? "channel partner" : "channel partners"} · {count(live)} {live === 1 ? "buyer" : "buyers"} held
            </>
          ) : (
            <>
              <span className="pill pill--warn" style={{ marginRight: 8 }}>
                <span className="pill__dot" />
                Sample data
              </span>
              These channel partners, buyers and payouts are invented. Nothing done here is saved.
            </>
          )
        }
        action={
          view === "mandates" ? (
            can.mandate && (desk.mandateProjects ?? []).length > 0 && <AppointDialog projects={desk.mandateProjects ?? []} today={today} />
          ) : (can.empanel || can.register) && (
            <div className="pf-actions">
              {can.empanel && desk.projects.length > 0 && real && <TermsDialog projects={desk.projects} />}
              {can.empanel && (
                <EmpanelDialog projects={desk.projects} people={desk.people} today={today} primary={!real || !can.register || desk.firmOptions.length === 0} />
              )}
              {/* Registering needs a firm to register for; with none, empanelling is the one thing to do. */}
              {can.register && real && desk.firmOptions.length > 0 && <RegisterDialog firms={desk.firmOptions} projects={desk.projects} primary />}
            </div>
          )
        }
      />

      {views.length > 1 && (
        <div className="subtabs pt-tabs">
          <div className="subtabs__nav" role="tablist" aria-label="Partner views">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              className="subtabs__tab"
              aria-selected={view === v}
              onClick={() => go(v)}
            >
              {TABS[v]}
              {/* Said, not only counted: a bare number beside "Payouts" read as how many payouts there are. */}
              {v === "payouts" && late.length > 0 && <span className="pt-tabs__n tnum">{late.length} late</span>}
              {v === "buyers" && disputes.length > 0 && <span className="pt-tabs__n tnum">{disputes.length} disputed</span>}
              {v === "mandates" && mandatesWaiting > 0 && <span className="pt-tabs__n tnum">{mandatesWaiting} waiting</span>}
            </button>
          ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {view !== "mandates" && (
      <section className="ws-strip" aria-label="The network">
        <div className="ws-stats">
          <div className="ws-stat">
            <p className="ws-stat__label">Active channel partners</p>
            <p className="ws-stat__num tnum">
              {active}
              <span className="ws-stat__of">of {desk.firms.length}</span>
            </p>
            <p className="ws-stat__sub">Registered a buyer in {DORMANT_AFTER} days</p>
            <span className="ws-meter" aria-hidden>
              <span style={{ width: `${desk.firms.length ? (active / desk.firms.length) * 100 : 0}%` }} />
            </span>
          </div>
          <div className="ws-stat">
            <p className="ws-stat__label">Buyers registered</p>
            <p className="ws-stat__num tnum">{count(regs30.length - refused30)}</p>
            <p className="ws-stat__sub">
              In 30 days · {refused30} refused
            </p>
          </div>
          <div className="ws-stat">
            <p className="ws-stat__label">Bookings through partners</p>
            <p className="ws-stat__num tnum">{count(cp90)}</p>
            <p className="ws-stat__sub">In 90 days</p>
          </div>
          {seesMoney ? (
            <div className="ws-stat">
              <p className="ws-stat__label">Days to pay</p>
              <p className="ws-stat__num tnum">{daysToPay ?? "None yet"}</p>
              <p className="ws-stat__sub">Average from owed to paid · promised in 30</p>
            </div>
          ) : (
            <div className="ws-stat">
              <p className="ws-stat__label">Visits from partners</p>
              <p className="ws-stat__num tnum">
                {count(desk.registrations.filter((r) => since30(r.visitedOn)).length)}
              </p>
              <p className="ws-stat__sub">In 30 days</p>
            </div>
          )}
        </div>

        {seesMoney ? (
          <button
            type="button"
            className="ws-dark"
            aria-pressed={view === "payouts" && sub === "late"}
            onClick={() => go("payouts", { sub: "late" })}
          >
            <span className="ws-dark__label">Owed to partners</span>
            <span className="ws-dark__num">{rupeesShort(owedTotal)}</span>
            <span className="ws-dark__foot">
              <span className="ws-dark__sub">
                {late.length ? (
                  <>
                    <span className="ws-dark__dot" aria-hidden />
                    {late.length} late, past {LATE_AFTER} days
                  </>
                ) : (
                  "Nothing late"
                )}
              </span>
              <span className="ws-dark__cta">
                {view === "payouts" && sub === "late" ? "Showing them" : "Show them"}
                <ArrowUpRight size={13} />
              </span>
            </span>
          </button>
        ) : real ? (
          <button
            type="button"
            className="ws-dark"
            aria-pressed={view === "buyers" && sub === "lapsing"}
            onClick={() => go("buyers", { sub: "lapsing" })}
          >
            <span className="ws-dark__label">Lapsing this week</span>
            <span className="ws-dark__num tnum">{desk.registrations.filter((r) => regState(r, today) === "lapsing").length}</span>
            <span className="ws-dark__foot">
              <span className="ws-dark__sub">Buyers a partner holds, not yet on site</span>
              <span className="ws-dark__cta">
                Show them
                <ArrowUpRight size={13} />
              </span>
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="ws-dark"
            aria-pressed={view === "buyers" && sub === "refused"}
            onClick={() => go("buyers", { sub: "refused" })}
          >
            <span className="ws-dark__label">Disputes to settle</span>
            <span className="ws-dark__num tnum">{disputes.length}</span>
            <span className="ws-dark__foot">
              <span className="ws-dark__sub">A partner says they were first</span>
              <span className="ws-dark__cta">
                Show them
                <ArrowUpRight size={13} />
              </span>
            </span>
          </button>
        )}
      </section>
      )}

      {view === "firms" && seesFirms && (
        <FirmsView
          real={real}
          links={desk.links ?? []}
          posts={desk.posts ?? []}
          agents={desk.agents ?? []}
          options={desk.firmOptions}
          projects={desk.projects}
          people={desk.people}
          settings={desk.settings}
          firms={desk.firms}
          stats={firmStats}
          registrations={desk.registrations}
          rungs={rungs}
          disputes={disputes}
          today={today}
          seesMoney={seesMoney}
          can={can}
          sub={sub}
          setSub={setSub}
          query={query}
          setQuery={setQuery}
          openId={openId}
          setOpenId={setOpenId}
          go={go}
        />
      )}
      {view === "buyers" && seesFirms && (
        <BuyersView
          real={real}
          projects={desk.projects}
          registrations={desk.registrations}
          unclaimed={desk.unclaimedBookings ?? []}
          today={today}
          can={can}
          rulings={rulings}
          rule={rule}
          sub={sub}
          setSub={setSub}
          query={query}
          setQuery={setQuery}
          openId={openId}
          setOpenId={setOpenId}
        />
      )}
      {view === "mandates" && (
        <MandatesView mandates={mandates} projects={desk.mandateProjects ?? []} today={today} canManage={can.mandate} seesMoney={seesMoney} />
      )}
      {view === "payouts" && seesMoney && (
        <PayoutsView
          real={real}
          bookings={bookings}
          today={today}
          can={can}
          setStage={setStage}
          sub={sub}
          setSub={setSub}
          query={query}
          setQuery={setQuery}
          openId={openId}
          setOpenId={setOpenId}
        />
      )}

      <div className="kb-toast-slot" role="status" aria-live="polite">
        {toast && (
          <div className="kb-toast">
            <span>{toast.text}</span>
            <button
              type="button"
              onClick={() => {
                toast.undo();
                setToast(null);
              }}
            >
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

type ListProps = {
  sub: string;
  setSub: (s: string) => void;
  query: string;
  setQuery: (q: string) => void;
  openId: string | null;
  setOpenId: (fn: (cur: string | null) => string | null) => void;
};

function Views({
  items,
  sub,
  setSub,
  counts,
  ink,
}: {
  items: { key: string; label: string }[];
  sub: string;
  setSub: (s: string) => void;
  counts: Record<string, number>;
  ink?: string;
}) {
  return (
    <div className="ws-views" role="group" aria-label="Show">
      {items.map((x) => (
        <button
          key={x.key}
          type="button"
          className={`ws-view${x.key === ink ? " ws-view--ink" : ""}`}
          aria-pressed={sub === x.key}
          onClick={() => setSub(x.key)}
        >
          {x.label}
          <span className="ws-view__n tnum">{count(counts[x.key] ?? 0)}</span>
        </button>
      ))}
    </div>
  );
}

function Finder({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="kb-search pt-find">
      <Search size={15} />
      <span className="sr-only">Search</span>
      <input type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Empty({ onClear, filtered, what }: { onClear: () => void; filtered: boolean; what: string }) {
  return (
    <div className="empty ws-empty">
      <span className="empty__mark" aria-hidden>
        <PartnersIcon size={20} />
      </span>
      {filtered ? (
        <>
          <p>No {what} match these filters.</p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>
            Clear filters
          </button>
        </>
      ) : (
        <p>No {what} yet.</p>
      )}
    </div>
  );
}

const DOC_LABEL: Record<DocState, { text: (till: string | null, today: string) => string; tone: string }> = {
  ok: { text: (till) => `Valid till ${till ? showDate(till).slice(4) : ""} ${till?.slice(0, 4) ?? ""}`, tone: "ok" },
  expiring: { text: (till, today) => `Expires in ${till ? daysBetween(today, till) : 0} days`, tone: "warn" },
  expired: { text: (till, today) => `Lapsed ${till ? daysBetween(till, today) : 0} days ago`, tone: "risk" },
  missing: { text: () => "Not on file", tone: "warn" },
};

// ---------------------------------------------------------------------------
// Firms
// ---------------------------------------------------------------------------

type FirmStat = { live: number; visits30: number; last: string | null; owed: number; paidYear: number };

function FirmsView({
  real,
  links,
  agents,
  posts,
  options,
  projects,
  people,
  settings,
  firms,
  stats,
  registrations,
  rungs,
  disputes,
  today,
  seesMoney,
  can,
  sub,
  setSub,
  query,
  setQuery,
  openId,
  setOpenId,
  go,
}: ListProps & {
  real: boolean;
  links: PartnerLink[];
  agents: PartnerAgent[];
  posts: PartnerPost[];
  options: FirmOption[];
  projects: ProjectOption[];
  people: { id: string; name: string }[];
  settings: PartnerSettings;
  firms: Firm[];
  stats: Map<string, FirmStat>;
  registrations: Registration[];
  rungs: { b: Booking; r: Rung }[];
  disputes: Registration[];
  today: string;
  seesMoney: boolean;
  can: Can;
  go: (v: DeskView, opts?: { sub?: string; open?: string }) => void;
}) {
  const [allItems, setAllItems] = useState(false);
  const docsDue = (f: Firm) => docState(f.reraTill, today) !== "ok" || docState(f.competencyTill, today) !== "ok";

  // --- what needs a person, most serious first -----------------------------
  type Item = { id: string; tone: "risk" | "warn" | "info"; title: string; why: string; act: string; onAct: () => void };
  const items: Item[] = [];
  for (const d of disputes) {
    items.push({
      id: `d-${d.id}`,
      tone: "risk",
      title: `${d.firm} disputes a refusal: ${d.buyer}`,
      why:
        d.refused?.reason === "firm"
          ? `${d.refused.holderFirm} registered this buyer first and holds them until ${showDate(d.refused.heldUntil!)}. ${d.firm} says they brought the buyer to the gallery.`
          : `The buyer enquired directly before ${d.firm} registered them. ${d.firm} says the enquiry came through their link.`,
      act: "Settle it",
      onAct: () => go("buyers", { sub: "refused", open: d.id }),
    });
  }
  for (const f of firms) {
    const rera = docState(f.reraTill, today);
    if (!f.rera) {
      items.push({
        id: `r-${f.id}`,
        tone: "risk",
        title: `No MahaRERA agent number for ${f.name}`,
        why: "Buyers from this firm are refused until it is on file.",
        act: "Open the firm",
        onAct: () => go("firms", { open: f.id }),
      });
    } else if (rera === "expired" && f.reraTill) {
      items.push({
        id: `r-${f.id}`,
        tone: "risk",
        title: `${f.name}'s RERA registration lapsed`,
        why: `It ended ${daysBetween(f.reraTill, today)} days ago. New buyers from this firm are refused until it is renewed.`,
        act: "Open the firm",
        onAct: () => go("firms", { open: f.id }),
      });
    } else if (rera === "expiring" && f.reraTill) {
      items.push({
        id: `r-${f.id}`,
        tone: "warn",
        title: `${f.name}'s RERA registration expires in ${daysBetween(today, f.reraTill)} days`,
        why: `Ask ${f.principal ?? "the firm"} for the renewal before ${showDate(f.reraTill)}, or their registrations stop that day.`,
        act: "Open the firm",
        onAct: () => go("firms", { open: f.id }),
      });
    }
    for (const p of f.projects) {
      const left = p.validTo ? daysBetween(today, p.validTo) : null;
      if (p.status === "live" && left !== null && left <= 30) {
        items.push({
          id: `g-${f.id}-${p.name}`,
          tone: "warn",
          title: `${f.name}'s empanelment on ${p.name} ends in ${left} ${left === 1 ? "day" : "days"}`,
          why: `Renew it before ${showDate(p.validTo!)}, or new buyers from this firm are refused there.`,
          act: "Open the firm",
          onAct: () => go("firms", { open: f.id }),
        });
      }
    }
    if (!f.competencyTill) {
      items.push({
        id: `c-${f.id}`,
        tone: "warn",
        title: `No certificate of competency for ${f.name}`,
        why: "Ask for it before their next buyer is registered.",
        act: "Open the firm",
        onAct: () => go("firms", { open: f.id }),
      });
    }
  }
  if (seesMoney) {
    const lateRungs = rungs
      .filter(({ r }) => isOwed(r) && (daysOwed(r, today) ?? 0) > LATE_AFTER)
      .sort((a, b) => (daysOwed(b.r, today) ?? 0) - (daysOwed(a.r, today) ?? 0));
    for (const { b, r } of lateRungs.slice(0, 2)) {
      items.push({
        id: `p-${b.id}-${r.key}`,
        tone: "warn",
        title: `${b.firm} owed ${daysOwed(r, today)} days for ${b.unit}`,
        why: `${r.key}, ${rupees(r.invoice.net)} after TDS. ${PAY_STATE[r.state].label}.`,
        act: "Open the payout",
        onAct: () => go("payouts", { open: b.id }),
      });
    }
    // An invoice the firm still has to confirm on WhatsApp is not finance's to verify yet.
    const toVerify = rungs.filter(({ b, r }) => r.state === "verify" && !(b.firmOnWhatsApp && !b.progress[r.key].invoice?.attestedOn));
    if (toVerify.length) {
      items.push({
        id: "verify",
        tone: "info",
        title: `${toVerify.length} ${toVerify.length === 1 ? "invoice" : "invoices"} to verify`,
        why: `${rupeesShort(toVerify.reduce((s, { r }) => s + r.invoice.gross, 0))} invoiced, GST included.`,
        act: "Show them",
        onAct: () => go("payouts", { sub: "verify" }),
      });
    }
  }
  const quiet = firms.filter((f) => isDormant(stats.get(f.id)?.last ?? null, today));
  if (quiet.length) {
    items.push({
      id: "quiet",
      tone: "info",
      title: quiet.length === 1 ? `${quiet[0].name} has registered nobody in ${DORMANT_AFTER} days` : `${quiet.length} firms have registered nobody in ${DORMANT_AFTER} days`,
      why: real ? "Send them something to work with." : `${quiet.reduce((s, f) => s + f.agents, 0)} agents between them are still on your WhatsApp.`,
      act: "Show them",
      onAct: () => setSub("quiet"),
    });
  }
  const rank = { risk: 0, warn: 1, info: 2 };
  items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  const QUEUE_FIRST = 6;
  const queue = allItems ? items : items.slice(0, QUEUE_FIRST);

  // --- the table -----------------------------------------------------------
  const VIEWS = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "quiet", label: "Quiet" },
    { key: "docs", label: "Documents due" },
  ];
  const q = query.trim().toLowerCase();
  const has = (v: string | null) => !!v && v.toLowerCase().includes(q);
  const found = firms.filter((f) => !q || has(f.name) || has(f.area) || has(f.principal) || has(f.rera));
  const inSub = (f: Firm, s: string) =>
    s === "all" ||
    (s === "active" && !isDormant(stats.get(f.id)?.last ?? null, today)) ||
    (s === "quiet" && isDormant(stats.get(f.id)?.last ?? null, today)) ||
    (s === "docs" && docsDue(f));
  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, found.filter((f) => inSub(f, v.key)).length]));
  const rows = found.filter((f) => inSub(f, sub)).sort((a, b) => b.bookingsYear - a.bookingsYear);
  const cols = seesMoney ? 9 : 8;

  return (
    <>
      {items.length > 0 && (
        <section className="card pt-needs" aria-label="Needs you">
          <div className="card__head">
            <h2>
              Needs <span className="em">you</span>
            </h2>
            <span className="ws-sub">{items.length} to do</span>
          </div>
          <ul className="pt-queue">
            {queue.map((it) => (
              <li key={it.id} className="pt-q">
                <span className={`qi__mark qi__mark--${it.tone}`} aria-hidden>
                  {it.tone === "info" ? <Clock size={15} /> : <Alert size={15} />}
                </span>
                <span className="pt-q__body">
                  <span className="pt-q__title">{it.title}</span>
                  <span className="pt-q__why">{it.why}</span>
                </span>
                <button type="button" className="pt-q__do" onClick={it.onAct}>
                  {it.act}
                  <ArrowUpRight size={13} />
                </button>
              </li>
            ))}
          </ul>
          {items.length > QUEUE_FIRST && (
            <div className="pt-needs__more">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAllItems((v) => !v)}>
                {allItems ? "Show fewer" : `Show ${items.length - QUEUE_FIRST} more`}
              </button>
            </div>
          )}
        </section>
      )}

      <section className="card pt-sheet" aria-label="Channel partners">
        <div className="pt-sheet__top">
          <Views items={VIEWS} sub={sub} setSub={setSub} counts={counts} />
          <Finder value={query} onChange={setQuery} placeholder="Firm, area, principal or RERA number" />
        </div>
        {rows.length === 0 ? (
          <Empty filtered={sub !== "all" || !!q} what="firms" onClear={() => { setSub("all"); setQuery(""); }} />
        ) : (
          <div className="ws-scroll">
            <table className="ws-table pt-table">
              <thead>
                <tr>
                  <th scope="col">Firm</th>
                  <th scope="col">Next booking earns</th>
                  <th scope="col">RERA</th>
                  <th scope="col" className="ws-num">Live buyers</th>
                  <th scope="col" className="ws-num">Visits, 30 days</th>
                  <th scope="col" className="ws-num">Bookings, 12 months</th>
                  {seesMoney && <th scope="col" className="ws-num">Owed</th>}
                  <th scope="col">Last registered</th>
                  <th scope="col" className="ws-chev"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const s = stats.get(f.id)!;
                  const open = openId === f.id;
                  const lead = leadProject(f);
                  const rera = docState(f.reraTill, today);
                  return (
                    <Fragment key={f.id}>
                      <tr id={`pt-row-${f.id}`} className={`ws-row${open ? " is-open" : ""}`} onClick={() => setOpenId((c) => (c === f.id ? null : f.id))}>
                        <td className="pt-firm">
                          <button
                            type="button"
                            id={`pt-btn-${f.id}`}
                            className="ws-name"
                            aria-expanded={open}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenId((c) => (c === f.id ? null : f.id));
                            }}
                          >
                            {f.name}
                          </button>
                          <span className="ws-sub">
                            {[f.area, f.agents ? `${f.agents} ${f.agents === 1 ? "agent" : "agents"}` : null].filter(Boolean).join(" · ") || "No buyers yet"}
                          </span>
                        </td>
                        <td className="pt-c-tier">
                          {lead ? (
                            <>
                              <span className="pt-cell tnum">{pct(lead.rate)}</span>
                              <span className="ws-sub">{f.projects.length > 1 ? `${lead.name} · ${f.projects.length} projects` : lead.name}</span>
                            </>
                          ) : (
                            <span className="ws-sub">No project</span>
                          )}
                        </td>
                        <td className="pt-k">
                          <span className={`pill pill--${DOC_LABEL[rera].tone}`}>
                            <span className="pill__dot" />
                            {rera === "ok" ? "Valid" : DOC_LABEL[rera].text(f.reraTill, today)}
                          </span>
                        </td>
                        <td className="ws-num tnum" data-label="Live buyers">{s.live}</td>
                        <td className="ws-num tnum" data-label="Visits">{s.visits30}</td>
                        <td className="ws-num tnum pt-strong" data-label="Bookings">{f.bookingsYear}</td>
                        {seesMoney && <td className={`ws-num tnum${s.owed ? " pt-strong" : " pt-none"}`} data-label="Owed">{s.owed ? rupeesShort(s.owed) : "Nothing"}</td>}
                        <td className={isDormant(s.last, today) ? "pt-quiet" : undefined} data-label="Last registered">{ago(s.last, today)}</td>
                        <td className="ws-chev" aria-hidden><ChevronDown size={14} /></td>
                      </tr>
                      {open && (
                        <tr className="ws-detailrow">
                          <td colSpan={cols}>
                            <FirmOpen
                              f={f}
                              s={s}
                              option={real ? options.find((o) => o.id === f.id) : undefined}
                              links={links.filter((l) => l.firmId === f.id)}
                              agents={agents.filter((a) => a.firmId === f.id)}
                              posts={posts}
                              projects={projects}
                              people={people}
                              registrations={registrations}
                              today={today}
                              seesMoney={seesMoney}
                              can={can}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {real && can.settings && <SettingsRow settings={settings} />}
    </>
  );
}

/** The project a firm's row speaks for: its busiest live one. */
function leadProject(f: Firm): FirmProject | null {
  const live = f.projects.filter((p) => p.status === "live");
  const pool = live.length ? live : f.projects;
  return [...pool].sort((a, b) => b.booked - a.booked)[0] ?? null;
}

const GRANT_PILL: Record<FirmProject["status"], { label: (p: FirmProject) => string; tone: string }> = {
  live: { label: (p) => (p.validTo ? `Live till ${showDate(p.validTo).slice(4)} ${p.validTo.slice(0, 4)}` : "Live"), tone: "ok" },
  on_hold: { label: () => "On hold", tone: "warn" },
  ended: { label: () => "Ended", tone: "quiet" },
  not_started: { label: () => "Not started", tone: "blue" },
};

function FirmOpen({
  f,
  s,
  option,
  links,
  agents,
  posts,
  projects,
  people,
  registrations,
  today,
  seesMoney,
  can,
}: {
  f: Firm;
  s: FirmStat;
  /** The firm's own record, when it is a real one. */
  option?: FirmOption;
  links: PartnerLink[];
  agents: PartnerAgent[];
  posts: PartnerPost[];
  projects: ProjectOption[];
  people: { id: string; name: string }[];
  registrations: Registration[];
  today: string;
  seesMoney: boolean;
  can: Can;
}) {
  const reraState: DocState = f.rera ? docState(f.reraTill, today) : "missing";
  const docs: { k: string; v: string; state: DocState; mono?: boolean; note?: string }[] = [
    {
      k: "MahaRERA agent",
      v: f.rera ?? "Not on file",
      mono: !!f.rera,
      state: reraState,
      note: f.rera ? DOC_LABEL[reraState].text(f.reraTill, today) : "Buyers are refused until it is",
    },
    {
      k: "Certificate of competency",
      v: f.competencyTill ? "On file" : "Not on file",
      state: docState(f.competencyTill, today),
      note: f.competencyTill ? DOC_LABEL[docState(f.competencyTill, today)].text(f.competencyTill, today) : "Ask before the next registration",
    },
    { k: "PAN", v: f.pan, mono: true, state: "ok" },
    { k: "GSTIN", v: f.gstin ?? "Not registered", mono: !!f.gstin, state: "ok", note: f.gstin ? undefined : "Invoices carry no GST" },
  ];
  const recent = registrations.filter((r) => (r.firmId ? r.firmId === f.id : r.firm === f.name)).slice(0, 4);
  const towers = option
    ? projects
        .filter((p) => option.grants.some((g) => g.projectId === p.id && g.live))
        .flatMap((p) => p.phases.map((ph) => ({ id: ph.id, name: `${p.name} · ${ph.name}`, projectId: p.id })))
    : [];
  const grantFor = (name: string) => option?.grants.find((g) => g.project === name && g.status !== "ENDED") ?? option?.grants.find((g) => g.project === name);

  return (
    <div className="ws-open pt-open">
      <div className="pt-open__grid">
        <section className="ws-sec" aria-label="Documents">
          <div className="ws-sec__head">
            <h3>Documents</h3>
            {option && can.empanel && <EditFirmDialog firm={option} people={people} />}
          </div>
          <ul className="pt-docs">
            {docs.map((d) => (
              <li key={d.k} className={`pt-doc pt-doc--${d.state}`}>
                <span className="pt-doc__mark" aria-hidden>
                  {d.state === "ok" ? <Check size={11} /> : d.state === "expired" ? <Close size={10} /> : <Alert size={11} />}
                </span>
                <span className="pt-doc__body">
                  <span className="pt-doc__k">{d.k}</span>
                  <span className={`pt-doc__v${d.mono ? " pt-mono" : ""}`}>{d.v}</span>
                  {d.note && <span className="ws-sub">{d.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="ws-sec" aria-label="Projects">
          <h3>Projects</h3>
          {f.projects.length === 0 ? (
            <p className="ws-sub">Not empanelled on any project.</p>
          ) : (
            <ul className="pf-projects">
              {f.projects.map((p) => {
                const pill = GRANT_PILL[p.status];
                const grant = grantFor(p.name);
                return (
                  <li key={p.grantId ?? p.name} className="pf-project">
                    <span className="pf-project__top">
                      <span className="pf-project__name">{p.name}</span>
                      <span className={`pill pill--${pill.tone}`}>
                        <span className="pill__dot" />
                        {pill.label(p)}
                      </span>
                    </span>
                    <span className="ws-sub tnum">
                      {p.booked} {p.booked === 1 ? "booking" : "bookings"} · the {ordinal(p.booked + 1)} earns {pct(p.rate)}
                      {p.next ? `, ${pct(p.next.rate)} after ${p.next.more} more` : ""}
                    </span>
                    {grant?.reason && p.status === "on_hold" && <span className="ws-sub">{grant.reason}</span>}
                    {grant && (can.suspend || can.empanel) && <GrantControls grant={grant} today={today} can={can} />}
                  </li>
                );
              })}
            </ul>
          )}
          {option && can.empanel && <AddProjects firm={option} projects={projects} today={today} />}
          <dl className="ws-facts pt-facts">
            <div className="ws-fact">
              <dt>Bookings, 12 months</dt>
              <dd className="tnum">{f.bookingsYear}</dd>
            </div>
            {seesMoney && (
              <div className="ws-fact">
                <dt>Paid this year</dt>
                <dd className="tnum">{s.paidYear ? rupeesShort(s.paidYear) : "Nothing yet"}</dd>
              </div>
            )}
          </dl>
        </section>

        <section className="ws-sec" aria-label="Latest buyers">
          <h3>Latest buyers</h3>
          {recent.length === 0 ? (
            <p className="ws-sub">Nobody registered yet.</p>
          ) : (
            <ul className="pt-mini">
              {recent.map((r) => {
                const st = regState(r, today);
                return (
                  <li key={r.id}>
                    <span className="pt-mini__name">{r.buyer}</span>
                    <span className="ws-sub">{showDate(r.registeredOn)}</span>
                    <span className={`pill pill--${REG_STATE[st].tone}`}>{REG_STATE[st].label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {option && (
        <div className="pf-pair">
          <AgentsPanel firmId={f.id} agents={agents} canAdd={can.empanel} canRemove={can.empanel || can.suspend} />
          <LinksPanel firmId={f.id} links={links} posts={posts} towers={towers} canMake={can.register} />
        </div>
      )}

      <dl className="ws-meta pt-meta">
        <div>
          <dt>Principal</dt>
          <dd>{f.principal ?? "Not on file"}</dd>
        </div>
        <div>
          <dt>Principal&rsquo;s number</dt>
          <dd className="tnum ws-meta__num">{f.phone ? showPhone(f.phone) : "Not on file"}</dd>
        </div>
        <div>
          <dt>Looked after by</dt>
          <dd>{f.rm ?? "Nobody yet"}</dd>
        </div>
        <div>
          <dt>Empanelled</dt>
          <dd className="tnum">{showDate(f.joinedOn).slice(4)} {f.joinedOn.slice(0, 4)}</dd>
        </div>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buyers registered
// ---------------------------------------------------------------------------

function BuyersView({
  real,
  projects,
  registrations,
  unclaimed,
  today,
  can,
  rulings,
  rule,
  sub,
  setSub,
  query,
  setQuery,
  openId,
  setOpenId,
}: ListProps & {
  real: boolean;
  projects: ProjectOption[];
  registrations: DeskData["registrations"];
  unclaimed: { id: string; label: string }[];
  today: string;
  can: Can;
  rulings: Record<string, "keep" | "split">;
  rule: (r: Registration, how: "keep" | "split", text: string) => void;
}) {
  const VIEWS: { key: string; label: string }[] = [
    { key: "all", label: "All" },
    { key: "live", label: "Live" },
    { key: "lapsing", label: "Lapsing" },
    { key: "visited", label: "Visited" },
    { key: "booked", label: "Booked" },
    { key: "refused", label: "Refused" },
    { key: "lapsed", label: "Lapsed" },
  ];
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  // The page holds masked numbers only, so a whole number is looked up on the server.
  const [byNumber, setByNumber] = useState<{ digits: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!real || digits.length < 10) return;
    let live = true;
    findRegistrationAction({ number: digits }).then((ids) => {
      if (live) setByNumber({ digits, ids: new Set(ids) });
    });
    return () => {
      live = false;
    };
  }, [real, digits]);
  const found = registrations.filter(
    (r) =>
      !q ||
      r.buyer.toLowerCase().includes(q) ||
      r.firm.toLowerCase().includes(q) ||
      r.agent.toLowerCase().includes(q) ||
      (digits.length >= 10 && byNumber?.digits === digits ? byNumber.ids.has(r.id) : digits.length >= 2 && r.phone.includes(digits)),
  );
  const inSub = (r: Registration, s: string) => s === "all" || regState(r, today) === s;
  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, found.filter((r) => inSub(r, v.key)).length]));
  // A dispute waiting on a ruling reads first, then the newest.
  const rows = found
    .filter((r) => inSub(r, sub))
    .sort((a, b) => Number(!!b.disputed && !rulings[b.id]) - Number(!!a.disputed && !rulings[a.id]));
  const [limit, setLimit] = useState(40);
  const shown = rows.slice(0, limit);

  return (
    <section className="card pt-sheet" aria-label="Buyers registered">
      <div className="pt-sheet__top">
        <Views items={VIEWS} sub={sub} setSub={setSub} counts={counts} ink="refused" />
        <Finder value={query} onChange={setQuery} placeholder="Buyer, number, firm or agent" />
      </div>
      {rows.length === 0 ? (
        <Empty filtered={sub !== "all" || !!q} what="buyers" onClear={() => { setSub("all"); setQuery(""); }} />
      ) : (
        <>
          <div className="ws-scroll">
            <table className="ws-table pt-table">
              <thead>
                <tr>
                  <th scope="col">Buyer</th>
                  <th scope="col">Partner</th>
                  <th scope="col">Project</th>
                  <th scope="col">Registered</th>
                  <th scope="col">Runs for</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="ws-chev"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const st = regState(r, today);
                  const open = openId === r.id;
                  const left = daysLeft(r, today);
                  const waiting = !!r.disputed && !rulings[r.id];
                  return (
                    <Fragment key={r.id}>
                      <tr id={`pt-row-${r.id}`} className={`ws-row${open ? " is-open" : ""}`} onClick={() => setOpenId((c) => (c === r.id ? null : r.id))}>
                        <td className="pt-firm">
                          <button
                            type="button"
                            id={`pt-btn-${r.id}`}
                            className="ws-name"
                            aria-expanded={open}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenId((c) => (c === r.id ? null : r.id));
                            }}
                          >
                            {r.buyer}
                          </button>
                          <span className="ws-sub tnum">{r.phone}</span>
                        </td>
                        <td className="pt-firm">
                          <span className="pt-cell">{r.firm}</span>
                          <span className="ws-sub">{r.agent}</span>
                        </td>
                        <td className="pt-c-sub">{r.project}</td>
                        <td className="tnum pt-c-sub">{showDate(r.registeredOn)}</td>
                        <td className="pt-c-wide">
                          {r.refused ? (
                            <span className="ws-sub">{REFUSED_SHORT[r.refused.reason](r.refused.holderFirm)}</span>
                          ) : st === "booked" ? (
                            <span className="ws-sub">Booked {showDate(r.bookedOn!)}</span>
                          ) : (
                            <span className="pt-clock">
                              <span className={`pt-clock__bar${left < 7 ? " is-low" : ""}`} aria-hidden>
                                <span style={{ width: `${Math.min(100, (left / (REGISTRATION_DAYS + VISIT_EXTENDS)) * 100)}%` }} />
                              </span>
                              <span className="tnum">{left ? `${left} days` : "Lapsed"}</span>
                            </span>
                          )}
                        </td>
                        <td className="pt-k">
                          {waiting ? (
                            <span className="pill pill--risk"><span className="pill__dot" />Disputed</span>
                          ) : (
                            <span className={`pill pill--${REG_STATE[st].tone}`}>
                              <span className="pill__dot" />
                              {r.disputed && rulings[r.id] ? (rulings[r.id] === "split" ? "Split" : "Settled") : REG_STATE[st].label}
                            </span>
                          )}
                        </td>
                        <td className="ws-chev" aria-hidden><ChevronDown size={14} /></td>
                      </tr>
                      {open && (
                        <tr className="ws-detailrow">
                          <td colSpan={7}>
                            <RegOpen
                              r={r}
                              today={today}
                              can={can}
                              ruling={rulings[r.id]}
                              rule={rule}
                              phases={real ? projects.find((p) => p.id === r.projectId)?.phases ?? [] : null}
                              unclaimed={real && can.approve && r.linkable && !r.bookedOn ? unclaimed : []}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="ws-foot">
            <p className="ws-sub">
              Showing {count(shown.length)} of {count(rows.length)}
            </p>
            {rows.length > shown.length && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((n) => n + 40)}>
                Show {Math.min(40, rows.length - shown.length)} more
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

const REFUSED_SHORT: Record<RefuseReason, (holder?: string) => string> = {
  firm: (holder) => (holder ? `Held by ${holder}` : "Another firm holds them"),
  direct: () => "Came direct first",
  no_grant: () => "Not empanelled here",
  agent_rera: () => "Agent registration missing",
  rate_limited: () => "Day's registrations used up",
};

function refusedWhy(r: Registration): string {
  const x = r.refused!;
  switch (x.reason) {
    case "firm":
      return x.holderFirm
        ? `${x.holderFirm} registered this buyer first and holds them until ${showDate(x.heldUntil!)}.`
        : `Another firm holds this buyer${x.heldUntil ? ` until ${showDate(x.heldUntil)}` : ""}.`;
    case "direct":
      return "The buyer had already enquired directly, before this registration.";
    case "no_grant":
      return `${r.firm} is not empanelled on ${r.project}${x.heldUntil ? `; that ended ${showDate(x.heldUntil)}` : ""}.`;
    case "agent_rera":
      return `${r.firm}'s MahaRERA agent registration is missing or lapsed.`;
    case "rate_limited":
      return `${r.firm} had used up the day's registrations.`;
  }
}

function RegOpen({
  r,
  today,
  can,
  ruling,
  rule,
  phases,
  unclaimed,
}: {
  r: DeskData["registrations"][number];
  today: string;
  can: Can;
  ruling: "keep" | "split" | undefined;
  rule: (r: Registration, how: "keep" | "split", text: string) => void;
  /** The project's towers, on the real desk; null on the sample. */
  phases: { id: string; name: string }[] | null;
  /** Bookings this registration may be linked to by hand; empty when it may not be. */
  unclaimed: { id: string; label: string }[];
}) {
  const until = validUntil(r);
  const steps: { label: string; when: string; done: boolean }[] = [
    { label: `Registered, ${r.via.toLowerCase()}`, when: showDate(r.registeredOn), done: true },
  ];
  if (!r.refused) {
    if (r.visitedOn) steps.push({ label: "Visited the site, registration extended", when: showDate(r.visitedOn), done: true });
    if (r.bookedOn) steps.push({ label: "Booked", when: showDate(r.bookedOn), done: true });
    else steps.push({ label: daysBetween(today, until) < 0 ? "Lapsed" : "Lapses unless they visit or book", when: showDate(until), done: daysBetween(today, until) < 0 });
  }
  const holder = r.refused?.reason === "firm" ? r.refused.holderFirm : null;
  const bookable = phases && r.live && !r.visitedOn && !r.bookedOn && can.schedule;

  return (
    <div className="ws-open pt-open">
      <div className="pt-open__grid pt-open__grid--two">
        <section className="ws-sec" aria-label="The claim">
          <h3>{r.refused ? "Why it was refused" : "The claim"}</h3>
          {r.refused ? (
            <>
              <p className="pt-body">
                {refusedWhy(r)} {r.refused.reason === "firm" && `${r.firm} was told the date, not who holds the buyer.`}
              </p>
              {r.disputed && (
                <div className="pt-rule">
                  {ruling ? (
                    <p className="pt-body">
                      <Check size={13} />{" "}
                      {ruling === "keep"
                        ? holder
                          ? `Settled: the buyer stays with ${holder}.`
                          : "Settled: the buyer stays direct."
                        : `Settled: commission split equally between ${holder ?? "the developer"} and ${r.firm}.`}
                    </p>
                  ) : (
                    <>
                      <p className="pt-body pt-body--ink">{r.firm} says they were first. How should it be settled?</p>
                      <div className="pt-rule__acts">
                        <button
                          type="button"
                          className="btn btn--ink"
                          onClick={() => rule(r, "keep", holder ? `${r.buyer} stays with ${holder}` : `${r.buyer} stays direct`)}
                        >
                          {holder ? `Keep with ${holder}` : "Keep it direct"}
                          <Check size={14} />
                        </button>
                        {holder && (
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => rule(r, "split", `Commission on ${r.buyer} split between ${holder} and ${r.firm}`)}
                          >
                            Split the commission
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <ol className="sv-steps">
                {steps.map((st, i) => (
                  <li key={i} className={`sv-step sv-step--${st.done ? "done" : "due"}`}>
                    <span className="sv-step__mark" aria-hidden>{st.done ? <Check size={11} /> : null}</span>
                    <span className="sv-step__body">
                      <span className="sv-step__label">{st.label}</span>
                      <span className="ws-sub tnum">{st.when}</span>
                    </span>
                  </li>
                ))}
              </ol>
              {bookable && <VisitForm registrationId={r.id} phases={phases} today={today} />}
              {unclaimed.length > 0 && <LinkClaimForm registrationId={r.id} bookings={unclaimed} />}
              {phases && r.leadId && (
                <a className="ws-link" href={`/dashboard/leads/${r.leadId}`}>
                  Open the lead
                </a>
              )}
            </>
          )}
        </section>

        <section className="ws-sec" aria-label="Details">
          <h3>Details</h3>
          <dl className="ws-facts pt-facts">
            <div className="ws-fact">
              <dt>Partner</dt>
              <dd>{r.firm}</dd>
            </div>
            <div className="ws-fact">
              <dt>Agent</dt>
              <dd>{r.agent || "Not named"}</dd>
            </div>
            <div className="ws-fact">
              <dt>Project</dt>
              <dd>{r.project}</dd>
            </div>
            <div className="ws-fact">
              <dt>Buyer&rsquo;s number</dt>
              <dd className="tnum ws-meta__num">
                {r.canReveal ? <RevealNumber registrationId={r.id} masked={r.phone} /> : r.phone}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

function PayoutsView({
  real,
  bookings,
  today,
  can,
  setStage,
  sub,
  setSub,
  query,
  setQuery,
  openId,
  setOpenId,
}: ListProps & {
  real: boolean;
  bookings: Booking[];
  today: string;
  can: Can;
  setStage: (b: Booking, key: "M1" | "M2", stage: Stage, text: string) => void;
}) {
  const VIEWS: { key: string; label: string }[] = [
    { key: "all", label: "All" },
    { key: "late", label: "Late" },
    { key: "approved", label: "To pay" },
    { key: "approve", label: "To approve" },
    { key: "verify", label: "Invoices to verify" },
    { key: "no_invoice", label: "Invoice awaited" },
    { key: "held", label: "Held" },
    { key: "paid", label: "Paid" },
  ];
  const q = query.trim().toLowerCase();
  const found = bookings.filter(
    (b) => !q || b.buyer.toLowerCase().includes(q) || b.firm.toLowerCase().includes(q) || b.unit.toLowerCase().includes(q),
  );
  const inSub = (b: Booking, s: string) => {
    const rs = ladder(b);
    if (s === "all") return true;
    if (s === "late") return rs.some((r) => isOwed(r) && (daysOwed(r, today) ?? 0) > LATE_AFTER);
    if (s === "paid") return rs.every((r) => r.state === "paid");
    return rs.some((r) => r.state === (s as PayState));
  };
  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, found.filter((b) => inSub(b, v.key)).length]));
  // What somebody has to act on reads first: the longest owed, then what is
  // waiting on finance, then what is waiting on the partner, then the rest.
  const RANK: Record<PayState, number> = { approve: 1, verify: 2, no_invoice: 3, approved: 4, held: 5, paid: 6, void: 7 };
  const priority = (b: Booking) => {
    const open = ladder(b).filter((r) => isOwed(r));
    const worst = Math.max(0, ...open.map((r) => daysOwed(r, today) ?? 0));
    if (worst > LATE_AFTER) return [0, -worst];
    const states = ladder(b).map((r) => RANK[r.state]);
    return [Math.min(...states), -worst];
  };
  const rows = found
    .filter((b) => inSub(b, sub))
    .map((b) => ({ b, p: priority(b) }))
    .sort((x, y) => x.p[0] - y.p[0] || x.p[1] - y.p[1])
    .map((x) => x.b);

  return (
    <section className="card pt-sheet" aria-label="Payouts">
      <div className="pt-sheet__top">
        <Views items={VIEWS} sub={sub} setSub={setSub} counts={counts} ink="late" />
        <Finder value={query} onChange={setQuery} placeholder="Buyer, firm or unit" />
      </div>
      {rows.length === 0 ? (
        <Empty filtered={sub !== "all" || !!q} what="payouts" onClear={() => { setSub("all"); setQuery(""); }} />
      ) : (
        <div className="ws-scroll">
          <table className="ws-table pt-table pt-pay">
            <thead>
              <tr>
                <th scope="col">Booking</th>
                <th scope="col">Partner</th>
                <th scope="col" className="ws-num">Agreement</th>
                <th scope="col" className="ws-num">Commission</th>
                <th scope="col">Payout</th>
                <th scope="col">Next</th>
                <th scope="col" className="ws-chev"><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const rs = ladder(b);
                const open = openId === b.id;
                const nxt = payNext(b, today);
                return (
                  <Fragment key={b.id}>
                    <tr id={`pt-row-${b.id}`} className={`ws-row${open ? " is-open" : ""}${b.cancelled ? " pt-void" : ""}`} onClick={() => setOpenId((c) => (c === b.id ? null : b.id))}>
                      <td className="pt-firm">
                        <button
                          type="button"
                          id={`pt-btn-${b.id}`}
                          className="ws-name"
                          aria-expanded={open}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenId((c) => (c === b.id ? null : b.id));
                          }}
                        >
                          {b.unit} · {b.buyer}
                        </button>
                        <span className="ws-sub">Booked {showDate(b.bookedOn)}</span>
                      </td>
                      <td className="pt-firm">
                        <span className="pt-cell">{b.firm}</span>
                        {b.mandate ? <span className="ws-sub">Mandate</span> : <span className="ws-sub">{b.agent}</span>}
                      </td>
                      <td className="ws-num tnum pt-c-sub" data-label="Agreement">{rupeesShort(b.agreement)}</td>
                      <td className="ws-num pt-c-sub" data-label="Commission">
                        <span className="pt-cell tnum">{rupees(commissionOn(b.agreement, b.rate, b.passBack))}</span>
                        <span className="ws-sub tnum">
                          {pct(b.rate - (b.passBack ?? 0))}
                          {b.bookingNo ? ` · ${ordinal(b.bookingNo)} booking` : ""}
                        </span>
                      </td>
                      <td className="pt-c-wide">
                        <span className="pt-ladder" aria-label={rs.map((r) => `${r.key} ${PAY_STATE[r.state].label}`).join(", ")}>
                          {rs.map((r, i) => (
                            <Fragment key={r.key}>
                              {i > 0 && <span className="pt-ladder__rule" aria-hidden />}
                              <span className={`pt-rung pt-rung--${r.state}`} aria-hidden>
                                <span className="pt-rung__k">{r.key}</span>
                                {PAY_STATE[r.state].label}
                              </span>
                            </Fragment>
                          ))}
                        </span>
                      </td>
                      <td className={`pt-nextcell pt-c-wide ws-tone--${nxt.tone}`}>{nxt.text}</td>
                      <td className="ws-chev" aria-hidden><ChevronDown size={14} /></td>
                    </tr>
                    {open && (
                      <tr className="ws-detailrow">
                        <td colSpan={7}>
                          <PayOpen b={b} today={today} can={can} setStage={setStage} real={real} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PayOpen({
  b,
  today,
  can,
  setStage,
  real,
}: {
  b: Booking;
  today: string;
  can: Can;
  setStage: (b: Booking, key: "M1" | "M2", stage: Stage, text: string) => void;
  real: boolean;
}) {
  const rs = ladder(b);
  const toward = b.collected === null ? (b.crossedOn ? 1 : 0) : Math.min(1, b.collected / RELEASE_AT);
  const passBack = b.passBack ?? 0;
  const untouched = b.progress.M1.stage === "none" && b.progress.M2.stage === "none";

  return (
    <div className="ws-open pt-open">
      <div className="pt-open__grid">
        <section className="ws-sec" aria-label="The booking">
          <h3>The booking</h3>
          <dl className="ws-facts pt-facts">
            <div className="ws-fact">
              <dt>Agreement value</dt>
              <dd className="tnum">{rupees(b.agreement)}</dd>
            </div>
            <div className="ws-fact">
              <dt>Commission</dt>
              <dd className="tnum">
                {pct(b.rate)}
                {passBack > 0 && `, less ${pct(passBack)} given back`}, {rupees(commissionOn(b.agreement, b.rate, passBack))}
              </dd>
            </div>
            <div className="ws-fact">
              <dt>Agreement registered</dt>
              <dd className="tnum">{b.registeredOn ? showDate(b.registeredOn) : b.cancelled ? "Never" : "Not yet"}</dd>
            </div>
            <div className="ws-fact">
              <dt>Where</dt>
              <dd>{b.place}</dd>
            </div>
            {b.matchedBy && (
              <div className="ws-fact">
                <dt>Registration found by</dt>
                <dd>{MATCHED_BY_LABEL[b.matchedBy]}</dd>
              </div>
            )}
          </dl>
          {b.clawback && b.clawback.amount > 0 && (
            <p className="pt-half__line">
              {rupees(b.clawback.amount)} paid on this booking comes back from {b.firm}&rsquo;s next payouts
              {b.clawback.outstanding > 0 ? ` · ${rupees(b.clawback.outstanding)} still to come off` : " · all of it taken off"}
            </p>
          )}
          {!b.cancelled && (
            <div className="pt-collect">
              <span className="ws-sub">
                {b.collected !== null ? (
                  <>
                    Collected <strong className="tnum">{Math.round(b.collected * 100)}%</strong> of the price · the second half releases at{" "}
                    {Math.round(RELEASE_AT * 100)}%
                  </>
                ) : b.crossedOn ? (
                  <>
                    {Math.round(RELEASE_AT * 100)}% collected on <strong className="tnum">{showDate(b.crossedOn)}</strong>
                  </>
                ) : (
                  <>Not yet at {Math.round(RELEASE_AT * 100)}% collected · the second half releases then</>
                )}
              </span>
              <span className="pt-collect__bar" aria-hidden>
                <span style={{ width: `${toward * 100}%` }} />
              </span>
            </div>
          )}
          {real && !b.cancelled && can.approve && (
            <>
              <BookingDates
                payoutId={b.id}
                registeredOn={b.registeredOn}
                crossedOn={b.crossedOn}
                today={today}
                locked={{ M1: b.progress.M1.stage !== "none", M2: b.progress.M2.stage !== "none" }}
              />
              {untouched && !b.mandate && <PassBack payoutId={b.id} passBack={passBack} />}
            </>
          )}
        </section>

        {rs.map((r) => {
          const d = daysOwed(r, today);
          const p = b.progress[r.key];
          return (
            <section key={r.key} className="ws-sec pt-half" aria-label={`${r.key}, ${r.trigger}`}>
              <div className="ws-sec__head">
                <h3>
                  {r.key} · {r.trigger}
                </h3>
                <span className={`pill pill--${PAY_STATE[r.state].tone}`}>
                  <span className="pill__dot" />
                  {PAY_STATE[r.state].label}
                </span>
              </div>
              {r.state === "void" ? (
                <p className="pt-half__line">Nothing more is owed on a cancelled booking.</p>
              ) : (
                <dl className="pt-inv">
                  <div>
                    <dt>Half the commission</dt>
                    <dd className="tnum">{rupees(r.invoice.base)}</dd>
                  </div>
                  <div>
                    <dt>{b.gstRegistered ? `GST at ${Math.round(GST_RATE * 100)}%` : "GST"}</dt>
                    <dd className="tnum">{b.gstRegistered ? `+ ${rupees(r.invoice.gst)}` : "Not registered"}</dd>
                  </div>
                  <div>
                    <dt>Invoice total</dt>
                    <dd className="tnum">{rupees(r.invoice.gross)}</dd>
                  </div>
                  <div>
                    <dt>TDS at {Math.round(TDS_RATE * 100)}%, on the amount before GST</dt>
                    <dd className="tnum">&minus; {rupees(r.invoice.tds)}</dd>
                  </div>
                  {(b.adjusted?.[r.key] ?? []).map((a, i) => (
                    <div key={i}>
                      <dt>Adjusted against booking {a.against}</dt>
                      <dd className="tnum">&minus; {rupees(a.amount)}</dd>
                    </div>
                  ))}
                  <div className="pt-inv__net">
                    <dt>{r.state === "paid" ? "Paid" : "To pay"}</dt>
                    <dd className="tnum">{rupees(netAfterAdjustments(b, r.key, r.invoice.net))}</dd>
                  </div>
                </dl>
              )}
              {r.state !== "void" && (
                <p className="pt-half__line">
                  {r.state === "paid" && r.paidOn ? (
                    <>
                      Paid {showDate(r.paidOn)} · UTR <span className="pt-mono">{r.utr}</span>
                    </>
                  ) : r.why ? (
                    r.why
                  ) : d !== null ? (
                    <span className={d > LATE_AFTER ? "pt-late" : undefined}>
                      Owed {d === 0 ? "from today" : `for ${d} ${d === 1 ? "day" : "days"}`}, since {showDate(r.owedSince!)}
                    </span>
                  ) : null}
                </p>
              )}
              {real && p.invoice && <InvoiceLink id={p.invoice.id} no={p.invoice.no} date={p.invoice.date} attestedOn={p.invoice.attestedOn} />}
              {real && p.invoice && p.invoice.amount !== r.invoice.gross && r.state === "verify" && (
                <p className="mv-err">
                  The invoice says {rupees(p.invoice.amount)}; {rupees(r.invoice.gross)} is owed.
                </p>
              )}
              {real && p.id && r.state === "no_invoice" && can.register && <InvoiceForm milestoneId={p.id} invoice={r.invoice} today={today} />}
              {real && p.id && (r.state === "verify" || r.state === "approve" || r.state === "approved") && (
                <HalfActions
                  milestoneId={p.id}
                  state={r.state}
                  net={netAfterAdjustments(b, r.key, r.invoice.net)}
                  can={can}
                  today={today}
                  waitingOnFirm={!!b.firmOnWhatsApp && r.state === "verify" && !p.invoice?.attestedOn}
                />
              )}
              {!real && can.approve && r.state === "verify" && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setStage(b, r.key, "verified", `${b.firm}'s ${r.key} invoice verified`)}
                >
                  Invoice matches, mark verified
                </button>
              )}
              {!real && can.approve && r.state === "approve" && (
                <button
                  type="button"
                  className="btn btn--ink"
                  onClick={() => setStage(b, r.key, "approved", `${rupees(r.invoice.net)} to ${b.firm} approved`)}
                >
                  Approve {rupees(r.invoice.net)}
                  <Check size={14} />
                </button>
              )}
              {!can.approve && (r.state === "verify" || r.state === "approve") && (
                <p className="ws-sub">Waiting on finance to {r.state === "verify" ? "verify the invoice" : "approve it"}.</p>
              )}
              {!can.pay && r.state === "approved" && <p className="ws-sub">Approved. Waiting on finance to pay it.</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
