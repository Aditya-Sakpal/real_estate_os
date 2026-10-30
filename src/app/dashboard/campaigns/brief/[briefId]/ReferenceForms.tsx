"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  addReferenceAction,
  removeReferenceAction,
  type ReferenceState,
} from "@/app/actions/campaign";
import type { ReferenceKind } from "@/lib/campaign-rules";
import { Plus } from "@/components/icons";
import { useKeptSubmit } from "@/components/KeptForm";
import { ConfirmAction } from "@/components/ConfirmAction";

/**
 * Filing a reference, in place.
 *
 * These were plain forms posting to an action that redirected. That is what
 * every other control on this screen does, and it is what made this one
 * destructive: the references sit BESIDE the brief form rather than inside
 * it, so the redirect re-rendered the brief from the database and threw away
 * everything typed into it but not yet saved. Uploading the video that worked
 * lost the audience, the micro-markets and the hook somebody had just
 * written, and the only sign of it was the page blanking and coming back
 * emptier.
 *
 * Now the action returns state and revalidates. React reconciles the page
 * rather than remounting it, so an uncontrolled input keeps whatever is in
 * it, and the new tile simply appears.
 *
 * Two things follow from an upload being slow, and both are the point of
 * these being client components rather than a smaller change to the action.
 * A 25 MB clip takes long enough that a button which does not say it is
 * working reads as a button that did nothing, so it is pressed twice. And a
 * picker still holding last time's file uploads it again on the next press,
 * which is the rule the brand kit already learned: a save that lands empties
 * the pickers.
 */
export function AddReference({
  briefId,
  kind,
  label,
  add,
  accept,
  placeholder,
}: {
  briefId: string;
  kind: ReferenceKind;
  label: string;
  add: string;
  accept: string;
  placeholder: string;
}) {
  const bound = addReferenceAction.bind(null, kind);
  const [state, submit, pending] = useActionState<ReferenceState, FormData>(bound, null);
  const form = useRef<HTMLFormElement>(null);
  // A refusal keeps the chosen file and the note; a success empties them.
  const keep = useKeptSubmit(submit);

  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);

  return (
    <>
      <form ref={form} action={submit} onSubmit={keep} className="refupload">
        <input type="hidden" name="briefId" value={briefId} />
        <input
          type="file"
          name="media"
          required
          accept={accept}
          className="refupload__file"
          aria-label={`${label}, file`}
        />
        <input
          type="text"
          name="note"
          maxLength={160}
          placeholder={placeholder}
          aria-label={`${label}, what this is`}
        />
        <button
          type="submit"
          className="btn btn--ink btn--sm"
          disabled={pending}
          data-add={kind}
        >
          {pending ? "Adding" : add}
          {!pending && <Plus size={13} />}
        </button>
      </form>

      {/* Beside the row it belongs to, rather than at the top of the page:
          two upload rows sharing one banner cannot say which one refused. */}
      {state && !state.ok && (
        <p className="refupload__said" role="alert">
          {state.message}
        </p>
      )}
    </>
  );
}

export function RemoveReference({
  briefId,
  referenceId,
}: {
  briefId: string;
  referenceId: string;
}) {
  const [state, submit] = useActionState<ReferenceState, FormData>(removeReferenceAction, null);

  return (
    <>
      <ConfirmAction
        label="Remove"
        title="Remove this reference?"
        body={<p>The file is deleted from this brief.</p>}
        confirmLabel="Remove it"
        action={submit}
        fields={{ briefId, referenceId }}
        tone="risk"
        testId={`remove-ref-${referenceId}`}
      />
      {state && !state.ok && (
        <span className="refupload__said" role="alert">
          {state.message}
        </span>
      )}
    </>
  );
}
