"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { editCopyAction, type EditState } from "@/app/actions/studio";
import { Pencil } from "@/components/icons";

/** Matches `MAX_EDIT_CHARS` on the server; the gate's budget is the real limit. */
const MAX_CHARS = 300;

type Copy = { headline: string; body: string; cta: string };

/**
 * One card, read by default, and editable in place from the pencil beside
 * its verdict. What is typed is gated on the server like anything a model
 * wrote; a refusal keeps the words and says why.
 */
export function EditableCard({
  briefId,
  copyId,
  seenAt,
  copy,
  language,
  attrs,
  tags,
  label,
  reasons,
  acts,
  editable,
}: {
  briefId: string;
  copyId: string;
  /** When this version of the card was written, so a rewrite meanwhile is caught. */
  seenAt: string;
  copy: Copy;
  language: string;
  attrs: Record<string, string>;
  label: ReactNode;
  tags: ReactNode;
  reasons: ReactNode;
  acts: ReactNode;
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Copy>(copy);
  const [state, action, pending] = useActionState<EditState, FormData>(editCopyAction, null);
  const first = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const wasEditing = useRef(false);

  useEffect(() => {
    if (state?.ok) setEditing(false);
  }, [state]);
  // Into the form, focus its first field; out of it, back to the pencil.
  useEffect(() => {
    if (editing) first.current?.focus();
    else if (wasEditing.current) opener.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const open = () => {
    setDraft(copy);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(copy);
  };
  const changed = draft.headline !== copy.headline || draft.body !== copy.body || draft.cta !== copy.cta;
  const field = (k: keyof Copy) => ({
    value: draft[k],
    onChange: (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value })),
    maxLength: MAX_CHARS,
    lang: langCode(language),
  });

  return (
    <article className="copyblock" {...attrs} data-editing={editing || undefined}>
      <header className="copyblock__head">
        {label}
        <span className="copyblock__tags">
          {tags}
          {editable && !editing && (
            <button
              ref={opener}
              type="button"
              className="copyblock__edit"
              onClick={open}
              aria-label="Edit this card"
              title="Edit this card"
              data-edit-card={copyId}
            >
              <Pencil size={14} />
            </button>
          )}
        </span>
      </header>

      {editing ? (
        <form
          action={action}
          className="copyblock__form"
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
          }}
        >
          <input type="hidden" name="briefId" value={briefId} />
          <input type="hidden" name="copyId" value={copyId} />
          <input type="hidden" name="seenAt" value={seenAt} />
          <label className="copyblock__field">
            <span>Headline</span>
            <input ref={first} name="headline" className="formfield__input" required {...field("headline")} />
          </label>
          <label className="copyblock__field">
            <span>Line under it</span>
            <textarea name="body" className="formfield__input" rows={2} {...field("body")} />
          </label>
          <label className="copyblock__field">
            <span>Call to action</span>
            <input name="cta" className="formfield__input" {...field("cta")} />
          </label>
          {state && !state.ok && (
            <div className="copyblock__why copyblock__why--risk" role="alert" data-edit-refused>
              <strong>{state.message}</strong>
              {state.reasons && state.reasons.length > 0 && (
                <ul>
                  {[...new Set(state.reasons)].map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="copyblock__acts">
            <button type="submit" className="btn btn--ink btn--sm" disabled={pending || !changed || !draft.headline.trim()}>
              {pending ? "Checking" : "Save"}
            </button>
            <button type="button" className="copyblock__rewritebtn" onClick={cancel} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <h3 className="copyblock__headline">{copy.headline}</h3>
          <p className="copyblock__body">{copy.body}</p>
          <p className="copyblock__cta">{copy.cta}</p>
          {state?.ok && (
            <p className="copyblock__saved" role="status">
              {state.message}
            </p>
          )}
          {reasons}
          {acts}
        </>
      )}
    </article>
  );
}

/** The `lang` a field carries, so the right keyboard and spell check come up. */
function langCode(language: string): string | undefined {
  return { English: "en", Hindi: "hi", Marathi: "mr", Gujarati: "gu", Tamil: "ta", Telugu: "te", Kannada: "kn", Bengali: "bn", Malayalam: "ml" }[language];
}
