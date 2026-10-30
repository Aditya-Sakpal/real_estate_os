"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  addBackdropAction,
  generateCopyAction,
  type StudioState,
} from "@/app/actions/studio";
import { Check, Plus } from "@/components/icons";
import { useKeptSubmit } from "@/components/KeptForm";
import { ConfirmPress } from "./ConfirmPress";
import { MAKE_EVENT } from "./PostsPanel";

/**
 * The two controls that cost money and take time.
 *
 * Both return rather than redirect. A run is a minute of somebody watching a
 * screen, so the button has to be able to say it is working, and a redirect
 * at the end of that minute blinks the page it was spent on.
 */

/**
 * Write cards, all of them or the ones named.
 *
 * `only` holds "Language|SEGMENT|ANGLE" keys. It exists so that changing the brief
 * updates the cards the change affected rather than paying to rewrite the
 * ones that were fine, and so a person who dislikes one card can replace that
 * card alone. Absent, it writes every card the brief asks for.
 */
export function WriteCopy({
  briefId,
  label,
  only,
  tone = "ink",
  formId = "writecopy",
  confirm,
}: {
  briefId: string;
  label: string;
  only?: string[];
  tone?: "ink" | "ghost";
  formId?: string;
  /** Ask first, naming what will be rewritten, when this replaces cards that exist. */
  confirm?: { title: string; body: string; confirmLabel: string };
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [stopping, setStopping] = useState(false);
  const [state, action, pending] = useActionState<StudioState, FormData>(
    (previous: StudioState, formData: FormData) => {
      setStopping(false);
      return generateCopyAction(previous, formData);
    },
    null,
  );

  // A plain request, not a server action. Next queues a page's actions one
  // behind another, so a stop sent as an action would wait for the run it
  // was meant to stop. The run notices within a second or two and returns,
  // and the result of the run is what the screen then reports.
  const stop = () => {
    setStopping(true);
    fetch(`/dashboard/campaigns/brief/${briefId}/studio/stop`, { method: "POST" }).catch(
      () => setStopping(false),
    );
  };

  return (
    <>
      <form action={action} id={formId} ref={formRef}>
        <input type="hidden" name="briefId" value={briefId} />
        {(only ?? []).map((k) => (
          <input key={k} type="hidden" name="only" value={k} />
        ))}
      </form>
      {pending && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={stop}
          disabled={stopping}
          data-stop
        >
          {stopping ? "Stopping" : "Stop writing"}
        </button>
      )}
      {confirm && !pending ? (
        <ConfirmPress
          label={label}
          className={`btn btn--${tone}`}
          title={confirm.title}
          body={<p>{confirm.body}</p>}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => formRef.current?.requestSubmit()}
          testId={`${formId}-confirm`}
        />
      ) : (
        <button
          type="submit"
          form={formId}
          className={`btn btn--${tone}`}
          disabled={pending}
          data-write={only?.length ? "some" : "all"}
        >
          {pending ? "Writing" : label}
          {!pending && tone === "ink" && <Check size={14} />}
        </button>
      )}
      {state && (
        <p className={`studionote ${state.ok ? "" : "studionote--risk"}`} role="status" data-wrote>
          {state.message}
        </p>
      )}
    </>
  );
}

export function DrawBackdrop({
  briefId,
  roles,
}: {
  briefId: string;
  /** Passed in rather than imported: the catalog's module reaches node:crypto,
      which a browser bundle cannot carry. */
  roles: readonly string[];
}) {
  const [state, action, pending] = useActionState<StudioState, FormData>(
    addBackdropAction,
    null,
  );
  const form = useRef<HTMLFormElement>(null);
  // A refusal keeps the words typed; a backdrop drawn empties the box for the next.
  const keep = useKeptSubmit(action);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);

  return (
    <>
      {state && (
        <div
          className={`note ${state.ok ? "note--info" : "note--risk"}`}
          style={{ marginBottom: 16 }}
          role="status"
          data-drawn
        >
          {state.message}
        </div>
      )}
      <form ref={form} action={action} onSubmit={keep} className="drawrow">
        <input type="hidden" name="briefId" value={briefId} />
        <input
          type="text"
          name="prompt"
          className="formfield__input"
          placeholder="Warm evening light, deep navy into amber"
          maxLength={240}
          required
          data-prompt
        />
        <select name="role" className="formfield__input drawrow__role" defaultValue="BACKDROP">
          {roles.map((role) => (
            <option key={role} value={role}>
              {role.charAt(0) + role.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn--light" disabled={pending} data-draw>
          {pending ? "Drawing" : "Draw"}
          {!pending && <Plus size={14} />}
        </button>
      </form>
    </>
  );
}

/**
 * Replace one card.
 *
 * The client decides whether a card is good enough, and this is how they say
 * it is not, without paying to rewrite the seven that were fine. It goes
 * through the same write-check-rewrite loop as a whole run.
 */
export function RewriteOne({ briefId, spec }: { briefId: string; spec: string }) {
  const [state, action, pending] = useActionState<StudioState, FormData>(
    generateCopyAction,
    null,
  );
  return (
    <form action={action} className="copyblock__rewrite">
      <input type="hidden" name="briefId" value={briefId} />
      <input type="hidden" name="only" value={spec} />
      <button type="submit" className="copyblock__rewritebtn" disabled={pending} data-rewrite-one={spec}>
        {pending ? "Rewriting" : "Rewrite"}
      </button>
      {state && !state.ok && (
        <span className="copyblock__rewritenote" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}


/**
 * A cleared card's own way to a post: it opens the maker for this card,
 * which lives with the posts further down the page.
 */
export function MakePostButton({ cardId }: { cardId: string }) {
  return (
    <button
      type="button"
      className="btn btn--ink btn--sm copyblock__make"
      onClick={() => window.dispatchEvent(new CustomEvent(MAKE_EVENT, { detail: cardId }))}
      data-make-post={cardId}
    >
      Make a post
    </button>
  );
}
