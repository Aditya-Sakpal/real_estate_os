"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { decideValueAction } from "@/app/actions/extract";
import type { FormResult } from "@/components/KeptForm";
import { Alert, ArrowUpRight, Close, Expand } from "@/components/icons";

export type ValueView = {
  id: string;
  label: string;
  /** The value as a person reads it: rupees grouped, dates written out. */
  shown: string;
  /** What goes in the correction box to start from. */
  raw: string;
  list: boolean;
  quote: string;
  from: string;
  page: number;
  crop: string;
  pageSrc: string;
  bbox: { x: number; y: number; w: number; h: number };
  unsure: boolean;
  inDraft: boolean;
  draftShown: string | null;
  flags: { tone: "risk" | "warn"; message: string }[];
  blocked: string | null;
  /** Where the thing blocking it is put right, in place of a refused Accept. */
  fix: { label: string; href: string } | null;
  placeholder: string;
};

function Press({ value, children, tone, disabled }: { value: string; children: React.ReactNode; tone: "ink" | "ghost"; disabled?: boolean }) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get("decision") === value;
  return (
    <button
      type="submit"
      name="decision"
      value={value}
      className={`btn btn--sm ${tone === "ink" ? "btn--ink" : "btn--ghost"}`}
      disabled={pending || disabled}
      data-decide={value}
    >
      {mine ? "Saving" : children}
    </button>
  );
}

/**
 * One value read from a document: what it says, the words on the page it
 * was read from, and the three decisions. The picture beside it is the part
 * of the page around those words, with them outlined; pressing it shows the
 * whole page.
 */
export default function ValueCard({ v, mayEdit }: { v: ValueView; mayEdit: boolean }) {
  const [state, action] = useActionState<FormResult, FormData>(decideValueAction, null);
  const [correcting, setCorrecting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const mark = useRef<HTMLSpanElement>(null);

  // The whole page is taller than the screen: open it on the words.
  const show = () => {
    dialog.current?.showModal();
    requestAnimationFrame(() => mark.current?.scrollIntoView({ block: "center" }));
  };

  useEffect(() => {
    if (correcting) box.current?.focus();
  }, [correcting]);

  const accept = v.inDraft ? "Accept" : v.list ? "Add it" : "Use this";
  const reject = v.inDraft ? "Reject" : v.list ? "Skip" : "Keep the draft's";

  return (
    <li className="val" data-value={v.id}>
      <button type="button" className="val__page" onClick={show} aria-label={`Show page ${v.page} of ${v.from}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={v.crop} alt={`Page ${v.page} of ${v.from}, where this was read`} loading="lazy" />
        <span className="val__zoom" aria-hidden>
          <Expand size={13} />
        </span>
      </button>

      <div className="val__body">
        <div className="val__head">
          <span className="val__label">{v.label}</span>
          {v.unsure && <span className="pill pill--warn">Check this one</span>}
          {v.inDraft ? <span className="pill pill--blue">In the draft</span> : v.draftShown ? <span className="pill pill--quiet">The draft says {v.draftShown}</span> : null}
        </div>
        <p className="val__value">{v.shown}</p>
        <p className="val__src">
          {v.from}, page {v.page}
          <span className="val__quote">&ldquo;{v.quote}&rdquo;</span>
        </p>
        {v.flags.map((f, i) => (
          <p key={i} className={`val__flag val__flag--${f.tone}`}>
            <Alert size={13} />
            {f.message}
          </p>
        ))}

        {mayEdit && (
          <form action={action} className="val__acts">
            <input type="hidden" name="proposalId" value={v.id} />
            {correcting ? (
              <>
                <label className="val__fix">
                  <span className="sr-only">Correct {v.label}</span>
                  <input ref={box} name="value" defaultValue={v.raw} placeholder={v.placeholder} className="formfield__input" required />
                </label>
                <Press value="correct" tone="ink">
                  Save correction
                </Press>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setCorrecting(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {v.blocked && v.fix ? (
                  <Link href={v.fix.href} className="btn btn--sm btn--ink">
                    {v.fix.label}
                    <ArrowUpRight size={12} />
                  </Link>
                ) : (
                  <Press value="accept" tone="ink" disabled={!!v.blocked}>
                    {accept}
                  </Press>
                )}
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setCorrecting(true)} data-correct="">
                  Correct
                </button>
                <Press value="reject" tone="ghost">
                  {reject}
                </Press>
              </>
            )}
          </form>
        )}
        {state && !state.ok && !v.flags.some((f) => f.message === state.message) && (
          <p className="val__flag val__flag--risk" role="alert">
            <Alert size={13} />
            {state.message}
          </p>
        )}
      </div>

      <dialog ref={dialog} className="pageview" onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        <div className="pageview__head">
          <span>
            {v.from}, page {v.page}
          </span>
          <button type="button" className="btn btn--icon" onClick={() => dialog.current?.close()} aria-label="Close">
            <Close size={14} />
          </button>
        </div>
        <div className="pageview__sheet">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={v.pageSrc}
            alt={`Page ${v.page} of ${v.from}`}
            loading="lazy"
            onLoad={() => dialog.current?.open && mark.current?.scrollIntoView({ block: "center" })}
          />
          <span
            ref={mark}
            className="pageview__box"
            style={{ left: `${v.bbox.x * 100}%`, top: `${v.bbox.y * 100}%`, width: `${v.bbox.w * 100}%`, height: `${v.bbox.h * 100}%` }}
            aria-hidden
          />
        </div>
      </dialog>
    </li>
  );
}
