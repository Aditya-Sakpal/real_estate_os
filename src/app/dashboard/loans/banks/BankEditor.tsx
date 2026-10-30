"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { saveBankAction, type LoanResult } from "@/app/actions/loans";

export type BankFormValue = {
  id: string | null;
  name: string;
  email: string;
  contactName: string | null;
  contactPhone: string | null;
  rateBp: number | null;
  feeNote: string | null;
  validUntil: string | null;
  projects: { id: string; apfNo: string | null }[];
};

/**
 * One bank's tie-up, as a form: who it is and where a buyer who says yes is
 * sent (written once), who to call there, what it offers and until when,
 * and the projects it approved with the approval number. Used to add a bank
 * and to change one.
 */
export function BankForm({
  bank,
  projects,
  today,
  onDone,
}: {
  bank: BankFormValue | null;
  projects: { id: string; name: string }[];
  today: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [said, save, saving] = useActionState<LoanResult | null, FormData>(saveBankAction, null);
  const [ticked, setTicked] = useState<Set<string>>(new Set(bank?.projects.map((p) => p.id) ?? []));
  const apf = new Map(bank?.projects.map((p) => [p.id, p.apfNo ?? ""]) ?? []);
  const key = bank?.id ?? "new";

  useEffect(() => {
    if (said?.ok) {
      onDone();
      router.refresh();
    }
  }, [said, router, onDone]);

  return (
    <form action={save} className="lf-form bk-form">
      {bank?.id && <input type="hidden" name="lenderId" value={bank.id} />}
      {said && !said.ok && (
        <p className="note note--risk lf-wide" role="alert">
          {said.message}
        </p>
      )}
      <div className="field">
        <label htmlFor={`bk-name-${key}`}>Bank</label>
        <input id={`bk-name-${key}`} name="name" maxLength={80} defaultValue={bank?.name ?? ""} placeholder="e.g. HDFC Bank, Baner branch" required />
      </div>
      <div className="field">
        <label htmlFor={`bk-email-${key}`}>Send buyers who say yes to</label>
        {bank ? (
          <>
            <input id={`bk-email-${key}`} value={bank.email} readOnly className="bk-fixed" />
            <input type="hidden" name="email" value={bank.email} />
          </>
        ) : (
          <input id={`bk-email-${key}`} name="email" type="email" maxLength={200} placeholder="loans@bank.example" required />
        )}
      </div>
      <div className="field">
        <label htmlFor={`bk-contact-${key}`}>Contact person (optional)</label>
        <input id={`bk-contact-${key}`} name="contactName" maxLength={80} defaultValue={bank?.contactName ?? ""} placeholder="e.g. Rahul Joshi" />
      </div>
      <div className="field">
        <label htmlFor={`bk-phone-${key}`}>Their phone (optional)</label>
        <input id={`bk-phone-${key}`} name="contactPhone" inputMode="tel" className="tnum" defaultValue={bank?.contactPhone ?? ""} placeholder="e.g. 98765 43210" />
      </div>
      <div className="field">
        <label htmlFor={`bk-rate-${key}`}>Rate from, % a year (optional)</label>
        <input id={`bk-rate-${key}`} name="rate" inputMode="decimal" className="tnum" defaultValue={bank?.rateBp ? String(bank.rateBp / 100) : ""} placeholder="e.g. 8.35" />
      </div>
      <div className="field">
        <label htmlFor={`bk-fee-${key}`}>Processing fee offer (optional)</label>
        <input id={`bk-fee-${key}`} name="feeNote" maxLength={120} defaultValue={bank?.feeNote ?? ""} placeholder="e.g. Waived for our buyers" />
      </div>
      <div className="field">
        <label htmlFor={`bk-until-${key}`}>Tie-up valid until (optional)</label>
        <input id={`bk-until-${key}`} name="validUntil" type="date" className="tnum" min={today} defaultValue={bank?.validUntil ?? ""} />
      </div>
      <fieldset className="lf-wide bk-projects">
        <legend>Projects it has approved</legend>
        {projects.length === 0 ? (
          <p className="lo-faint">No projects yet.</p>
        ) : (
          projects.map((p) => (
            <div key={p.id} className="bk-project">
              <label className="lf-doc">
                <input
                  type="checkbox"
                  name="project"
                  value={p.id}
                  checked={ticked.has(p.id)}
                  onChange={() =>
                    setTicked((t) => {
                      const n = new Set(t);
                      if (n.has(p.id)) n.delete(p.id);
                      else n.add(p.id);
                      return n;
                    })
                  }
                />
                <span>{p.name}</span>
              </label>
              {ticked.has(p.id) && (
                <input name={`apf:${p.id}`} aria-label={`${p.name} approval number`} maxLength={60} defaultValue={apf.get(p.id) ?? ""} placeholder="Approval no. (optional)" />
              )}
            </div>
          ))
        )}
      </fieldset>
      <div className="lf-acts">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDone} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn--ink btn--sm" disabled={saving}>
          {saving ? "Saving" : bank ? "Save bank" : "Add bank"}
        </button>
      </div>
    </form>
  );
}

/** "Add a bank": the button, and the form once pressed. */
export function AddBank({ projects, today }: { projects: { id: string; name: string }[]; today: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn btn--ink" onClick={() => setOpen(true)}>
        Add a bank
      </button>
    );
  }
  return (
    <section className="card lf-card bk-new" aria-label="Add a bank">
      <div className="card__head">
        <h2>Add a bank</h2>
      </div>
      <BankForm bank={null} projects={projects} today={today} onDone={() => setOpen(false)} />
    </section>
  );
}

/** "Edit" on a bank's card: the card's read view, or the form. */
export function EditableBank({
  bank,
  projects,
  today,
  canManage,
  remove,
  children,
}: {
  bank: BankFormValue;
  projects: { id: string; name: string }[];
  today: string;
  canManage: boolean;
  remove?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return editing ? (
    <BankForm bank={bank} projects={projects} today={today} onDone={() => setEditing(false)} />
  ) : (
    <>
      {children}
      {canManage && (
        <div className="bk-foot">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>
            Edit
          </button>
          {remove}
        </div>
      )}
    </>
  );
}
