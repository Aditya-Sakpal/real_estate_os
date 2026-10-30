"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Building, ChevronDown, Clock, Close, Dots, Search } from "@/components/icons";
import {
  FIELDS,
  PATH,
  STAGES,
  applyMove,
  isPath,
  nextFor,
  nowTimeOn,
  pathIndex,
  planMove,
  rupees,
  rupeesShort,
  stageLabel,
  valueOf,
  type FieldKey,
  type MoveInput,
  type MovePlan,
  type Stage,
  type StageKey,
} from "@/lib/lead-rules";
import type { SampleLead, Temperature } from "@/lib/lead-sample";
import { moveLeadAction } from "@/app/actions/leads";
import { MoveDialog } from "./MoveDialog";
import "./board.css";

const TEMP_LABEL: Record<Temperature, string> = { HOT: "Hot", WARM: "Warm", COLD: "Cold" };
const TEMP_TONE: Record<Temperature, string> = {
  HOT: "pill--risk",
  WARM: "pill--warn",
  COLD: "pill--blue",
};
const TEMP_OF: Record<string, Temperature> = { Hot: "HOT", Warm: "WARM", Cold: "COLD" };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/**
 * How far along the path a stage sits, drawn as a filling wedge. Booked is a
 * tick and the two side lanes carry their own marks, so the wedge only ever
 * means "this far to a booking".
 */
function StageGlyph({ stage, index }: { stage: Stage; index: number }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": true,
    className: `kb-glyph kb-glyph--${stage.key}`,
  } as const;
  if (stage.key === "booked") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="m5 8.2 2 2 4-4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (stage.key === "nurture") {
    return (
      <svg {...common} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M13 8a5 5 0 1 1-1.6-3.7" />
        <path d="M13.2 2.6v2.6h-2.6" strokeLinejoin="round" />
      </svg>
    );
  }
  if (stage.key === "lost") {
    return (
      <svg {...common} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="6.3" />
        <path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" />
      </svg>
    );
  }
  // Six steps before booked; the wedge fills a seventh per step, so the last
  // one before booking is nearly whole.
  const fraction = (index + 1) / 7;
  const r = 2.8;
  const c = 2 * Math.PI * r;
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" opacity="0.4" />
      <circle
        cx="8"
        cy="8"
        r={r}
        stroke="currentColor"
        strokeWidth={r * 2}
        strokeDasharray={`${c * fraction} ${c}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/** A one-line account of a move, for the card and the toast. */
function moveText(plan: MovePlan, input: MoveInput): string {
  if (plan.cancelsBooking) return `Booking cancelled: ${input.reason}`;
  if (plan.kind === "back") return `Back from ${stageLabel(plan.from)}: ${input.reason}`;
  if (plan.kind === "reopen") return `Reopened from ${stageLabel(plan.from)}`;
  return "";
}

/** The move dialog's own words for the fields it asks outside the facts. */
const EXTRA_LABEL: Record<string, string> = {
  reason: "Reason",
  followUp: "Follow up on",
  note: "Note",
};

/** "Assign to: Karan Mehta is not on the team at this tower." */
function fieldErrors(errors: Record<string, string> | undefined): string[] {
  if (!errors) return [];
  return Object.entries(errors).map(([k, v]) => {
    const label = k in FIELDS ? FIELDS[k as FieldKey].label : (EXTRA_LABEL[k] ?? k);
    return `${label}: ${v}`;
  });
}

type Toast = {
  text: string;
  /** The board before a sample move, for Undo. A saved move has no undo. */
  before?: SampleLead[];
  /** A move the server refused, and what it said about each field. */
  error?: boolean;
  details?: string[];
};

type MoveResult = { ok: boolean; message: string; errors?: Record<string, string> };

export function LeadBoard({
  leads,
  places,
  today,
  team,
  live = false,
  needsOnly = false,
  canMove = true,
}: {
  leads: SampleLead[];
  places: string[];
  today: string;
  team: readonly string[];
  /** Real leads: a move is saved, and a card opens the lead's own page. */
  live?: boolean;
  /** Open filtered to the leads waiting on a person. */
  needsOnly?: boolean;
  /** False for a viewer who may see leads and not move them: no drag, no move menu. */
  canMove?: boolean;
}) {
  const [board, setBoard] = useState<SampleLead[]>(leads);
  const [query, setQuery] = useState("");
  const [temp, setTemp] = useState<Temperature | null>(null);
  const [place, setPlace] = useState<number | null>(null);
  const [mine, setMine] = useState(needsOnly);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<StageKey | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pending, setPending] = useState<{ lead: SampleLead; plan: MovePlan } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // Cards whose move is still on its way to the server. A second move on the
  // same card waits, because the server plans it from the stored lead.
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());

  // A saved move refreshes the page, and the server's copy of the board is
  // the one that counts from then on.
  useEffect(() => {
    if (live) setBoard(leads);
  }, [live, leads]);

  const changed = board !== leads;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return board.filter(
      (l) =>
        (!q ||
          l.name.toLowerCase().includes(q) ||
          l.id.toLowerCase().includes(q) ||
          l.source.toLowerCase().includes(q)) &&
        (!temp || l.temp === temp) &&
        (place === null || l.place === place) &&
        (!mine || Boolean(l.needsYou)),
    );
  }, [board, query, temp, place, mine]);

  const needsYouCount = board.filter((l) => l.needsYou).length;
  const filtered = Boolean(query.trim() || temp || place !== null || mine);

  /** Ask the rules what the move needs; open the dialog only when it needs something. */
  const requestMove = (id: string, to: StageKey) => {
    if (!canMove || saving.has(id)) return;
    const lead = board.find((l) => l.id === id);
    if (!lead) return;
    const plan = planMove(lead, to, today, team, nowTimeOn(today));
    if (plan.kind === "none") return;
    if (plan.needsDialog) setPending({ lead, plan });
    else commit(lead, plan, { facts: {} });
  };

  const commit = (lead: SampleLead, plan: MovePlan, input: MoveInput) => {
    const moved = applyMove(lead, plan, input);
    const interest = input.facts.interest;
    const next: SampleLead = {
      ...moved,
      temp: interest && TEMP_OF[interest] ? TEMP_OF[interest] : lead.temp,
      config: moved.facts.config ?? lead.config,
      budget: moved.facts.budget ?? lead.budget,
      // The person acted, so whatever it was waiting on them for is settled,
      // and the hand-written line described a moment that has passed.
      needsYou: undefined,
      note: undefined,
      touched: "just now",
      lastMove: moveText(plan, input)
        ? { text: moveText(plan, input), note: input.note }
        : input.note
          ? { text: "Note", note: input.note }
          : undefined,
    };
    const before = board;
    setBoard((prev) => [next, ...prev.filter((l) => l.id !== lead.id)]);
    setPending(null);
    if (!live) {
      setToast({ text: `${lead.name} moved to ${stageLabel(plan.to)}`, before });
      return;
    }
    setToast({ text: `${lead.name} moved to ${stageLabel(plan.to)}` });
    setSaving((s) => new Set(s).add(lead.id));
    void save(lead, next, plan, input, before);
  };

  /**
   * Send a move to the server. The card has already landed; if the server
   * refuses, it goes back where it was and the toast says why.
   */
  const save = async (lead: SampleLead, next: SampleLead, plan: MovePlan, input: MoveInput, before: SampleLead[]) => {
    let res: MoveResult;
    try {
      res = await moveLeadAction({ leadId: lead.id, to: plan.to, move: { ...input, seen: plan.from } });
    } catch {
      res = { ok: false, message: "The move was not saved. Check the connection and try again." };
    }
    setSaving((s) => {
      const n = new Set(s);
      n.delete(lead.id);
      return n;
    });
    if (res.ok) return;

    const at = before.findIndex((l) => l.id === lead.id);
    setBoard((prev) => {
      // Only this move is undone. If the card has changed since (the page
      // refreshed, or it was moved again), what is on the board stands.
      if (prev.find((l) => l.id === lead.id) !== next) return prev;
      const rest = prev.filter((l) => l.id !== lead.id);
      rest.splice(Math.max(0, Math.min(at, rest.length)), 0, lead);
      return rest;
    });
    setToast({
      text: `${lead.name} stays in ${stageLabel(lead.stage)}. ${res.message}`,
      error: true,
      details: fieldErrors(res.errors),
    });
  };

  // The toast is also the screen reader's account of the move. A refusal
  // stays up longer, because it has to be read and acted on.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 12000 : 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Which stage a phone is looking at, read off the board's scroll so a swipe
  // moves the strip with it.
  const [shown, setShown] = useState<StageKey>("new");
  const boardRef = useRef<HTMLDivElement>(null);
  const onBoardScroll = () => {
    const el = boardRef.current;
    if (!el) return;
    const left = el.getBoundingClientRect().left;
    let best: { key: StageKey; d: number } | null = null;
    for (const col of Array.from(el.querySelectorAll<HTMLElement>("[data-stage]"))) {
      const d = Math.abs(col.getBoundingClientRect().left - left);
      if (!best || d < best.d) best = { key: col.dataset.stage as StageKey, d };
    }
    if (best && best.key !== shown) setShown(best.key);
  };
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const on = strip?.querySelector<HTMLElement>(`[aria-selected="true"]`);
    if (!strip || !on || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollTo({ left: on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2, behavior: "smooth" });
  }, [shown]);

  const main = STAGES.filter((s) => !s.side);
  const side = STAGES.filter((s) => s.side);

  const column = (stage: Stage, index: number) => {
    const inStage = visible.filter((l) => l.stage === stage.key);
    const total = stage.sumsValue
      ? inStage.reduce((sum, l) => sum + (valueOf(l)?.amount ?? 0), 0)
      : 0;
    const over = overStage === stage.key && dragId !== null;
    return (
      <section
        key={stage.key}
        id={`kbc-${stage.key}`}
        data-stage={stage.key}
        className={`kb-col${over ? " is-over" : ""}${stage.side ? " kb-col--side" : ""}`}
        aria-labelledby={`kb-${stage.key}`}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (overStage !== stage.key) setOverStage(stage.key);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverStage(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData("text/plain") || dragId;
          setDragId(null);
          setOverStage(null);
          if (id) requestMove(id, stage.key);
        }}
      >
        <header className="kb-col__head">
          <StageGlyph stage={stage} index={index} />
          <h2 id={`kb-${stage.key}`} className="kb-col__title">
            {stage.label}
          </h2>
          <span className="kb-col__count tnum">{inStage.length}</span>
          {stage.sumsValue && total > 0 && (
            <span className="kb-col__sum tnum">{rupeesShort(total)}</span>
          )}
        </header>

        <div className="kb-col__list">
          {inStage.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              today={today}
              place={places[lead.place] ?? places[0]}
              dragging={dragId === lead.id}
              menuOpen={menuFor === lead.id}
              onMenu={(open) => setMenuFor(open ? lead.id : null)}
              onMove={(to) => {
                setMenuFor(null);
                requestMove(lead.id, to);
              }}
              onDragStart={() => setDragId(lead.id)}
              onDragEnd={() => {
                setDragId(null);
                setOverStage(null);
              }}
              href={live ? `/dashboard/leads/${lead.id}` : undefined}
              movable={canMove}
            />
          ))}
          {inStage.length === 0 && (
            <p className="kb-col__empty">{over ? "Drop here" : filtered ? "No matches" : "Nothing here"}</p>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="kb">
      <div className="kb-tools" role="group" aria-label="Filter leads">
        <label className="kb-search">
          <Search size={15} />
          <span className="sr-only">Search leads</span>
          <input
            type="search"
            placeholder="Name, lead id or source"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <button
          type="button"
          className={`kb-chip kb-chip--ink${mine ? " is-on" : ""}`}
          aria-pressed={mine}
          onClick={() => setMine((v) => !v)}
        >
          Needs you
          <span className="kb-chip__n tnum">{needsYouCount}</span>
        </button>

        <span className="kb-tools__rule" aria-hidden />

        {(["HOT", "WARM", "COLD"] as Temperature[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`kb-chip${temp === t ? " is-on" : ""}`}
            aria-pressed={temp === t}
            onClick={() => setTemp((cur) => (cur === t ? null : t))}
          >
            <span className={`kb-chip__dot kb-chip__dot--${t.toLowerCase()}`} aria-hidden />
            {TEMP_LABEL[t]}
          </button>
        ))}

        {places.length > 1 && (
          <label className={`kb-chip kb-pick${place !== null ? " is-on" : ""}`}>
            <span className="sr-only">Tower</span>
            <select
              value={place ?? ""}
              onChange={(e) => setPlace(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">All towers</option>
              {places.map((p, i) => (
                <option key={p} value={i}>
                  {p}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
        )}

        <div className="kb-tools__end">
          {filtered && (
            <button
              type="button"
              className="kb-clear"
              onClick={() => {
                setQuery("");
                setTemp(null);
                setPlace(null);
                setMine(false);
              }}
            >
              <Close size={12} />
              Clear filters
            </button>
          )}
          {!live && changed && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setBoard(leads)}>
              Reset board
            </button>
          )}
        </div>
      </div>

      {/* A phone shows one stage at a time: the strip names every stage with
          its count, and a tap or a swipe moves between them. */}
      <div className="kb-stages" ref={stripRef} role="tablist" aria-label="Stages">
        {STAGES.map((st) => {
          const n = visible.filter((l) => l.stage === st.key).length;
          return (
            <button
              key={st.key}
              type="button"
              role="tab"
              aria-selected={shown === st.key}
              className={`kb-stage${st.side ? " kb-stage--side" : ""}`}
              onClick={() => {
                setShown(st.key);
                document.getElementById(`kbc-${st.key}`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
              }}
            >
              {st.label}
              <span className="kb-stage__n tnum">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="kb-board" ref={boardRef} onScroll={onBoardScroll}>
        {main.map((s, i) => column(s, i))}
        <div className="kb-board__split" aria-hidden />
        {side.map((s, i) => column(s, main.length + i))}
      </div>

      <div className="kb-toast-slot" role="status" aria-live="polite">
        {toast &&
          (toast.error ? (
            <div className="kb-toast kb-toast--error">
              <span className="kb-toast__dot" aria-hidden />
              <div className="kb-toast__body">
                <p>{toast.text}</p>
                {toast.details && toast.details.length > 0 && (
                  <ul className="kb-toast__list">
                    {toast.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="button" onClick={() => setToast(null)}>
                Dismiss
              </button>
            </div>
          ) : toast.before ? (
            <div className="kb-toast">
              <span>{toast.text}</span>
              <button
                type="button"
                onClick={() => {
                  if (toast.before) setBoard(toast.before);
                  setToast(null);
                }}
              >
                Undo
              </button>
            </div>
          ) : (
            <div className="kb-toast kb-toast--plain">
              <span>{toast.text}</span>
            </div>
          ))}
      </div>

      {pending && (
        <MoveDialog
          key={`${pending.lead.id}-${pending.plan.to}`}
          lead={pending.lead}
          plan={pending.plan}
          today={today}
          people={team}
          onCancel={() => setPending(null)}
          onConfirm={(input) => commit(pending.lead, pending.plan, input)}
        />
      )}
    </div>
  );
}

function LeadCard({
  lead,
  today,
  place,
  dragging,
  menuOpen,
  onMenu,
  onMove,
  onDragStart,
  onDragEnd,
  href,
  movable,
}: {
  lead: SampleLead;
  today: string;
  place: string;
  dragging: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onMove: (to: StageKey) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** The lead's own page. Absent on the sample board, which has none. */
  href?: string;
  movable: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Fixed to the viewport rather than to the card: the board scrolls
  // sideways, and a scrolling box clips anything positioned inside it.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // The handlers read the latest callback through a ref, so the listeners are
  // attached once per opening rather than on every render of the board.
  const onMenuRef = useRef(onMenu);
  onMenuRef.current = onMenu;

  useEffect(() => {
    if (!menuOpen) {
      setPos(null);
      return;
    }
    const b = buttonRef.current?.getBoundingClientRect();
    if (b) {
      const menuHeight = 380;
      const below = b.bottom + 6;
      const top = below + menuHeight > window.innerHeight ? Math.max(8, b.top - 6 - menuHeight) : below;
      setPos({ top, right: Math.max(8, window.innerWidth - b.right) });
    }
    const close = () => onMenuRef.current(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) onMenuRef.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onMenuRef.current(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (pos) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [pos]);

  // The menu is grouped by what the move means, so "back" is never a
  // surprise buried between two steps forward.
  const at = pathIndex(lead.stage);
  const groups: { title: string; stages: StageKey[] }[] = isPath(lead.stage)
    ? [
        { title: "Move ahead", stages: PATH.filter((s) => pathIndex(s) > at) },
        { title: "Move back", stages: PATH.filter((s) => pathIndex(s) < at).reverse() },
        { title: "Take off the path", stages: ["nurture", "lost"] },
      ]
    : [
        { title: "Reopen in", stages: [...PATH] },
        { title: "Move to", stages: lead.stage === "lost" ? ["nurture"] : ["lost"] },
      ];

  const owner = lead.facts.owner ?? null;
  const value = valueOf(lead);
  const nextText = lead.note ?? nextFor(lead, today);
  const tone = lead.needsYou
    ? "due"
    : lead.stage === "visit_scheduled"
      ? "soon"
      : lead.stage === "booked" || lead.stage === "lost"
        ? "done"
        : "wait";

  return (
    <article
      className={`kb-card${dragging ? " is-dragging" : ""}${lead.needsYou ? " kb-card--needs" : ""}`}
      draggable={movable}
      onDragStart={(e) => {
        if (!movable) return;
        e.dataTransfer.setData("text/plain", lead.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      aria-label={`${lead.name}, ${lead.stage === "visit_scheduled" ? "Visit booked" : TEMP_LABEL[lead.temp]}`}
    >
      {lead.needsYou && (
        <p className="kb-card__needs">
          <span className="kb-card__needs-dot" aria-hidden />
          {lead.needsYou}
        </p>
      )}

      <div className="kb-card__top">
        {/* A buyer with a visit booked is past hot, warm or cold (the client, 18 October 2026). */}
        {lead.stage === "visit_scheduled" ? (
          <span className="pill pill--ok">Visit booked</span>
        ) : (
          <span className={`pill ${TEMP_TONE[lead.temp]}`}>{TEMP_LABEL[lead.temp]}</span>
        )}
        {lead.cp ? (
          <span
            className="pill kb-cp"
            title={`Channel partner ${lead.cp.firm}${lead.cp.daysLeft > 0 ? `, tag valid ${lead.cp.daysLeft} more days` : ""}`}
          >
            {lead.cp.firm}
            {lead.cp.daysLeft > 0 && <span className="tnum">· {lead.cp.daysLeft}d</span>}
          </span>
        ) : (
          <span className="pill pill--quiet">{lead.source}</span>
        )}
        <div className="kb-card__menu">
          {movable && (
            <button
              ref={buttonRef}
              type="button"
              className="kb-card__more"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Move ${lead.name}`}
              onClick={() => onMenu(!menuOpen)}
            >
              <Dots size={16} />
            </button>
          )}
          {movable && menuOpen && pos && (
            <div
              ref={menuRef}
              className="kb-menu"
              role="menu"
              aria-label="Move to"
              style={{ top: pos.top, right: pos.right }}
            >
              {groups
                .filter((g) => g.stages.length > 0)
                .map((g) => (
                  <div key={g.title} role="group" aria-label={g.title} className="kb-menu__group">
                    <p className="kb-menu__head">{g.title}</p>
                    {g.stages.map((s) => (
                      <button key={s} type="button" role="menuitem" onClick={() => onMove(s)}>
                        {stageLabel(s)}
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      <h3 className="kb-card__name">
        {href ? (
          // Not draggable itself, so a drag that starts on the name still
          // carries the card rather than the link.
          <Link href={href} className="kb-card__link" draggable={false}>
            {lead.name}
          </Link>
        ) : (
          lead.name
        )}
      </h3>
      <p className="kb-card__want">
        {lead.config} · {lead.budget}
      </p>
      <p className="kb-card__place">
        <Building size={13} />
        <span>{place}</span>
      </p>

      {lead.score !== null && (
        <div className="kb-score">
          <span className="kb-score__label">Score</span>
          <span className="kb-score__track" aria-hidden>
            <span className="kb-score__fill" style={{ width: `${lead.score}%` }} />
          </span>
          <span className="kb-score__n tnum">{lead.score}</span>
        </div>
      )}

      {value && (
        <p className="kb-card__value tnum">
          <span>{value.label}</span>
          {rupees(value.amount)}
        </p>
      )}

      {lead.exit && (
        <p className="kb-card__exit">
          {lead.exit.reason}
          {lead.stage === "nurture" && <span> · left at {stageLabel(lead.pathStage)}</span>}
        </p>
      )}

      <p className={`kb-next kb-next--${tone}`}>
        <Clock size={13} />
        <span>{nextText}</span>
      </p>

      {lead.lastMove && (
        <p className="kb-card__moved">
          {lead.lastMove.text}
          {lead.lastMove.note && <q>{lead.lastMove.note}</q>}
        </p>
      )}

      <footer className="kb-card__foot">
        <span className={`kb-owner${owner ? "" : " kb-owner--agent"}`} aria-hidden>
          {owner ? initials(owner) : "AI"}
        </span>
        <span className="kb-card__who">{owner ?? "Agent"}</span>
        <span className="kb-card__when">
          {lead.lang} · {lead.touched}
        </span>
      </footer>
    </article>
  );
}

