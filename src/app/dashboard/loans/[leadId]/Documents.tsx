"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { saveDocumentsAction, type LoanResult } from "@/app/actions/loans";
import type { DocGroup } from "@/lib/loan-rules";

const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

/**
 * What the desk has collected for this buyer. Tick what came in; the save
 * button appears once something changed, and says so once it is saved.
 */
export function Documents({
  leadId,
  groups,
  received,
  progress,
  canUpdate,
}: {
  leadId: string;
  groups: DocGroup[];
  received: Record<string, string>;
  progress: { done: number; of: number };
  canUpdate: boolean;
}) {
  const router = useRouter();
  const [said, save, saving] = useActionState<LoanResult | null, FormData>(saveDocumentsAction, null);
  const start = useMemo(() => new Set(Object.keys(received)), [received]);
  const [ticked, setTicked] = useState<Set<string>>(start);
  const dirty = ticked.size !== start.size || [...ticked].some((k) => !start.has(k));

  useEffect(() => setTicked(new Set(Object.keys(received))), [received]);
  useEffect(() => {
    if (said?.ok) router.refresh();
  }, [said, router]);

  const toggle = (k: string) =>
    setTicked((t) => {
      const n = new Set(t);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <section className="card lf-card" aria-labelledby="lf-docs-h">
      <form action={save}>
        <input type="hidden" name="leadId" value={leadId} />
        <div className="card__head">
          <h2 id="lf-docs-h">Documents</h2>
          <span className={`pill ${progress.done === progress.of ? "pill--ok" : "pill--quiet"} tnum`}>
            {progress.done} of {progress.of}
          </span>
          {canUpdate && (
            <button type="submit" className="btn btn--ink btn--sm" disabled={!dirty || saving}>
              {saving ? "Saving" : dirty ? "Save documents" : "Saved"}
            </button>
          )}
        </div>
        {said && !said.ok && (
          <p className="note note--risk lf-note" role="alert">
            {said.message}
          </p>
        )}
        <div className="lf-docs">
          {groups.map((g) => (
            <fieldset key={g.key}>
              <legend>{g.label}</legend>
              {g.items.map((i) => (
                <label key={i.key} className={`lf-doc${i.optional ? " lf-doc--opt" : ""}`}>
                  <input type="checkbox" name="doc" value={i.key} checked={ticked.has(i.key)} onChange={() => toggle(i.key)} disabled={!canUpdate} />
                  <span>{i.label}</span>
                  {received[i.key] && ticked.has(i.key) && <small className="tnum">{day(received[i.key])}</small>}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </form>
    </section>
  );
}
