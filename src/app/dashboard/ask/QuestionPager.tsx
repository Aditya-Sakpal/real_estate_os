"use client";

import { useEffect, useRef, useState } from "react";
import type { Question } from "@/lib/ask-actions-rules";
import { Check, ChevronLeft } from "@/components/icons";

/**
 * A card's questions, one at a time.
 *
 * Three questions stacked under each other read as a form to fill in, and the
 * second and third sat below the fold of a narrow chat. So a card with more
 * than one question shows a step strip (each question's short name, ticked
 * once answered), the one question in hand, and Back and Next. Picking an
 * option of a pick-one question moves on by itself; the last step's button
 * sends every answer at once, and is the card's only way forward.
 */

export type Picks = Record<string, string[]>;
export type Others = Record<string, string | null>;

/** The picks a fresh set of questions starts with: each one's obvious answer. */
export function startingPicks(questions: readonly Question[]): Picks {
  const out: Picks = {};
  for (const q of questions) {
    if (q.kind === "many" && q.defaults?.length) out[q.input] = [...q.defaults];
    else if (q.default) out[q.input] = [q.default];
  }
  return out;
}

export function isAnswered(q: Question, picks: Picks, others: Others): boolean {
  const o = others[q.input];
  if (o !== null && o !== undefined) return o.trim().length > 0;
  return (picks[q.input] ?? []).length > 0;
}

/** A question's short name for the step strip: the words before its first comma or question mark, cut short. */
function shortName(q: Question): string {
  const t = q.title.replace(/^(which|what|is|does|do|the)\s+/i, "").split(/[?,:]/)[0].trim();
  const words = t.split(/\s+/).slice(0, 3).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function QuestionBlock({
  q,
  n,
  pick,
  other,
  onPick,
  onOther,
  live,
}: {
  q: Question;
  n: number;
  pick: string[];
  other: string | null;
  onPick: (values: string[]) => void;
  onOther: (text: string | null) => void;
  live: boolean;
}) {
  const rows = q.options.some((o) => o.detail);
  const typing = other !== null;
  const titleId = `q-${q.input}-${n}`;
  return (
    <div className="ask-q-block" role="group" aria-labelledby={titleId}>
      <p id={titleId} className="ask-q-block__title">
        {q.title}
      </p>
      {q.note && <p className="ask-q-block__note">{q.note}</p>}
      {q.kind !== "text" && q.options.length > 0 && (
        <div className={rows ? "ask-opts ask-opts--rows" : "ask-opts"} role={q.kind === "many" ? "group" : "radiogroup"} aria-labelledby={titleId}>
          {q.options.map((o, i) => {
            const on = pick.includes(o.value) && !typing;
            return (
              <button
                key={o.value}
                type="button"
                role={q.kind === "many" ? "checkbox" : "radio"}
                aria-checked={on}
                className={`ask-opt${rows ? " ask-opt--row" : ""}${on ? " is-on" : ""}`}
                disabled={!live || !!o.disabled}
                title={o.disabled ?? undefined}
                aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                onClick={() => {
                  onOther(null);
                  if (q.kind === "many") onPick(on ? pick.filter((v) => v !== o.value) : [...pick, o.value]);
                  else onPick([o.value]);
                }}
              >
                {rows && <span className={`ask-opt__mark${q.kind === "many" ? " is-box" : ""}`} aria-hidden />}
                <span className="ask-opt__text">
                  <span className="ask-opt__label">{o.label}</span>
                  {(o.detail || o.disabled) && <span className="ask-opt__detail">{o.disabled ?? o.detail}</span>}
                </span>
              </button>
            );
          })}
          {q.other && (
            <button
              type="button"
              role={q.kind === "many" ? "checkbox" : "radio"}
              aria-checked={typing}
              className={`ask-opt${rows ? " ask-opt--row" : ""}${typing ? " is-on" : ""}`}
              disabled={!live}
              onClick={() => {
                onPick([]);
                onOther(typing ? null : "");
              }}
            >
              {rows && <span className="ask-opt__mark" aria-hidden />}
              <span className="ask-opt__text">
                <span className="ask-opt__label">Other</span>
              </span>
            </button>
          )}
        </div>
      )}
      {(q.kind === "text" || typing) && (
        <input
          className="ask-q-block__input"
          type="text"
          disabled={!live}
          aria-label={q.title}
          placeholder={q.placeholder ?? "Type your answer"}
          value={other ?? ""}
          maxLength={300}
          autoFocus={typing || q.kind === "text"}
          onChange={(e) => onOther(e.target.value)}
        />
      )}
    </div>
  );
}

/**
 * The questions, paged. `onSubmit` is called once every question has an
 * answer and the last step's button is pressed.
 */
export function QuestionPager({
  questions,
  picks,
  others,
  onPick,
  onOther,
  live,
  working,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  questions: Question[];
  picks: Picks;
  others: Others;
  onPick: (input: string, values: string[]) => void;
  onOther: (input: string, text: string | null) => void;
  live: boolean;
  working: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  const [at, setAt] = useState(0);
  const key = questions.map((q) => q.input + q.title).join("|");
  const box = useRef<HTMLDivElement>(null);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new set of questions starts at the first.
  useEffect(() => {
    setAt(0);
  }, [key]);
  useEffect(() => () => {
    if (advance.current) clearTimeout(advance.current);
  }, []);

  const many = questions.length > 1;
  const page = Math.min(at, questions.length - 1);
  const q = questions[page];
  const done = questions.map((x) => isAnswered(x, picks, others));
  const ready = done.every(Boolean);
  const last = page === questions.length - 1;

  const go = (i: number) => {
    if (advance.current) clearTimeout(advance.current);
    setAt(Math.max(0, Math.min(questions.length - 1, i)));
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(".ask-opt.is-on, .ask-opt:not(:disabled), input")?.focus({ preventScroll: true }));
  };

  // Number keys pick an option on the question in hand, when nothing is being typed.
  useEffect(() => {
    if (!live || working || !q || q.kind === "text") return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const i = Number(e.key) - 1;
      if (!Number.isInteger(i) || i < 0 || i > 8) return;
      const o = q.options.filter((x) => !x.disabled)[i];
      if (!o) return;
      e.preventDefault();
      onOther(q.input, null);
      const now = picks[q.input] ?? [];
      onPick(q.input, q.kind === "many" ? (now.includes(o.value) ? now.filter((v) => v !== o.value) : [...now, o.value]) : [o.value]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, working, q, picks, onPick, onOther]);

  if (!q) return null;
  return (
    <div className="ask-pager" ref={box}>
      {many && (
        <ol className="ask-pager__steps" aria-label="Questions">
          {questions.map((x, i) => (
            <li key={x.input}>
              <button
                type="button"
                className={`ask-pager__step${i === page ? " is-now" : ""}${done[i] ? " is-done" : ""}`}
                aria-current={i === page ? "step" : undefined}
                onClick={() => go(i)}
                disabled={!live || working}
                title={x.title}
              >
                <span className="ask-pager__num" aria-hidden>
                  {done[i] && i !== page ? <Check size={11} /> : i + 1}
                </span>
                <span className="ask-pager__name">{shortName(x)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <QuestionBlock
        key={q.input}
        q={q}
        n={page}
        pick={picks[q.input] ?? []}
        other={others[q.input] ?? null}
        live={live && !working}
        onPick={(values) => {
          onPick(q.input, values);
          // A pick-one question moves on by itself, unless it is the last.
          if (many && q.kind === "one" && !last && values.length) {
            if (advance.current) clearTimeout(advance.current);
            advance.current = setTimeout(() => go(page + 1), 220);
          }
        }}
        onOther={(text) => onOther(q.input, text)}
      />
      {live && (
        <div className="ask-act__acts">
          {many && page > 0 && (
            <button type="button" className="btn btn--ghost btn--sm ask-pager__back" disabled={working} onClick={() => go(page - 1)}>
              <ChevronLeft size={12} />
              Back
            </button>
          )}
          {many && !last ? (
            <button type="button" className="btn btn--ink btn--sm" disabled={!done[page] || working} onClick={() => go(page + 1)}>
              Next
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--ink btn--sm"
              disabled={!done[page] || working}
              onClick={() => {
                if (!ready) {
                  go(done.findIndex((d) => !d));
                  return;
                }
                onSubmit();
              }}
            >
              {working ? "Checking…" : submitLabel}
            </button>
          )}
          {many && <span className="ask-pager__count">{`${page + 1} of ${questions.length}`}</span>}
          {onCancel && (
            <button type="button" className="btn btn--ghost btn--sm ask-pager__cancel" disabled={working} onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
