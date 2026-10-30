"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";

/**
 * Forms that keep what a person typed.
 *
 * React 19 resets a form after every form action, refused or not: text goes
 * blank, a select falls back to its first option, a file picker empties. A
 * refusal therefore threw away the whole form, and on Projects the entity
 * select quietly went back to the first entity, so pressing again filed the
 * project under the wrong company.
 *
 * Submitting through `onSubmit` inside a transition skips the reset and keeps
 * `useFormStatus` working, because React still marks the form pending when a
 * submit it was handed is prevented and a transition started in that event.
 * `action` stays on the form so a press before hydration still posts.
 *
 * A button carrying its own `formAction` (a Reset or Delete beside Save) is
 * marked `data-own-action` and keeps React's own path: this handler could
 * only send the form's action, not the button's.
 */
export function useKeptSubmit(dispatch: (formData: FormData) => void) {
  return (e: FormEvent<HTMLFormElement>) => {
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | HTMLInputElement | null;
    if (submitter?.hasAttribute("data-own-action")) return;
    e.preventDefault();
    const formData = new FormData(e.currentTarget, submitter);
    startTransition(() => dispatch(formData));
  };
}

/** What an action hands back to a kept form. `null` or nothing means nothing to say. */
export type FormResult = { ok: boolean; message: string } | null;

/**
 * A form whose refusal is shown beside it rather than by redirect, and whose
 * fields survive the refusal. For a server component page: wrap the fields it
 * already renders. The action returns `{ ok: false, message }` to refuse and
 * may still `redirect()` when it succeeds.
 */
export function KeptForm({
  action,
  clearOnSuccess = false,
  children,
  messageAt = "top",
  ...rest
}: {
  action: (formData: FormData) => Promise<FormResult | void>;
  /** Empty the fields once it worked: an add-a-person form, not an editor. */
  clearOnSuccess?: boolean;
  children: ReactNode;
  messageAt?: "top" | "bottom";
} & Omit<ComponentProps<"form">, "action" | "onSubmit" | "children">) {
  const ref = useRef<HTMLFormElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const [state, dispatch] = useActionState<FormResult, FormData>(
    async (_prev, formData) => (await action(formData)) ?? null,
    null,
  );
  const onSubmit = useKeptSubmit(dispatch);

  useEffect(() => {
    if (state?.ok && clearOnSuccess) ref.current?.reset();
  }, [state, clearOnSuccess]);

  // The answer sits at one end of the form, and the button pressed may be a
  // long way down it. Bring it into view, or a refusal reads as a dead button.
  useEffect(() => {
    if (state?.message) noteRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [state]);

  const note = state?.message ? (
    <p ref={noteRef} className={`note ${state.ok ? "note--info" : "note--risk"}`} role={state.ok ? "status" : "alert"}>
      {state.message}
    </p>
  ) : null;

  return (
    <form ref={ref} action={dispatch} onSubmit={onSubmit} {...rest}>
      {messageAt === "top" && note}
      {children}
      {messageAt === "bottom" && note}
    </form>
  );
}
