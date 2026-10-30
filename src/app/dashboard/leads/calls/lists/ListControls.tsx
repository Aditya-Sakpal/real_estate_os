"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";

/** A submit button that says what is happening while its form is sent. */
export function PendingButton({ children, pendingLabel, className = "btn btn--ink", disabled }: { children: ReactNode; pendingLabel: string; className?: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}

/** The consent tick and the one button that starts a list. The button waits for the tick. */
export function StartFields({ people, developer }: { people: number; developer: string }) {
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="cls-start">
      <label className="switch">
        <input type="checkbox" name="consent" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          <span className="switch__name">Everyone on this list agreed to be contacted by {developer} by call and WhatsApp</span>
        </span>
      </label>
      <PendingButton pendingLabel="Starting" disabled={!agreed}>
        Call {people.toLocaleString("en-IN")} {people === 1 ? "person" : "people"}
      </PendingButton>
    </div>
  );
}

/** While a list is calling, the page reads itself again every ten seconds. */
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [router]);
  return null;
}

export type QuestionView = { id: string; text: string; options: string[]; about: string };

/**
 * The list's open questions, one block each: the suggested answers, the
 * person's own words, or "Decide for me". One button sends them all.
 */
export function QuestionFields({ questions }: { questions: QuestionView[] }) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const ready = questions.every((q) => chosen[q.id]);
  return (
    <div className="cls-qs">
      <h2 className="cls-qs__title">
        {questions.length === 1 ? "One question" : `${questions.length} questions`} before calling
      </h2>
      {questions.map((q, i) => (
        <fieldset key={q.id} className="cls-q">
          <legend className="cls-q__text">
            <span className="cls-q__n">{i + 1}</span>
            {q.text}
          </legend>
          <p className="cls-q__about">{q.about}</p>
          <div className="cls-q__opts">
            {[...q.options.map((o) => ({ v: o, label: o })), { v: "__other", label: "Something else" }, { v: "__skip", label: "Decide for me" }].map((o) => (
              <label key={o.v} className={`cls-opt${chosen[q.id] === o.v ? " cls-opt--on" : ""}`}>
                <input type="radio" name={`q:${q.id}`} value={o.v} checked={chosen[q.id] === o.v} onChange={() => setChosen((c) => ({ ...c, [q.id]: o.v }))} />
                {o.label}
              </label>
            ))}
          </div>
          {chosen[q.id] === "__other" && (
            <input className="cls-q__other" name={`other:${q.id}`} maxLength={300} placeholder="Your answer" aria-label="Your answer" required autoFocus />
          )}
        </fieldset>
      ))}
      <PendingButton pendingLabel="Reading the list again" disabled={!ready}>
        Save answers
      </PendingButton>
    </div>
  );
}

/**
 * Where the sheet's people came from: they enquired, they never did, or a
 * mix the remarks decide. Nothing is chosen for the person.
 */
export function SourcePicker({ initial, options }: { initial?: string; options: { value: string; label: string; hint: string }[] }) {
  const [picked, setPicked] = useState(initial ?? "");
  return (
    <fieldset className="cls-src">
      <legend className="cls-src__q">Did these people enquire?</legend>
      <div className="cls-src__opts">
        {options.map((o) => (
          <label key={o.value} className={`cls-opt cls-src__opt${picked === o.value ? " cls-opt--on" : ""}`}>
            <input type="radio" name="source" value={o.value} required checked={picked === o.value} onChange={() => setPicked(o.value)} />
            <span>
              <span className="cls-src__label">{o.label}</span>
              <span className="cls-src__hint">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
