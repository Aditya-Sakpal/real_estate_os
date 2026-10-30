"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { addAssetsAction, beginAssetUpload, finishAssetUpload, type UploadState } from "@/app/actions/asset";

type Cat = { key: string; label: string; detail: string; dated?: boolean; photographic?: boolean };

/**
 * The one place on this page that takes a file.
 *
 * There used to be nine forms with nine file pickers, one per category. A
 * person would fill four of them, click a single Upload, and HTML would do
 * exactly what it should: submit that form and discard the rest. Every other
 * picker cleared on the re-render and it read as losing work. One picker on
 * the page cannot do that.
 *
 * It owns the form rather than sitting inside one, because the result comes
 * back through `useActionState` instead of through a redirect. A redirect to
 * the same URL is a full navigation, and on an upload that takes seconds it
 * reads as the page dying and coming back; returning a result re-renders the
 * list in place and says what happened beside the button.
 */
export default function UploadPanel({
  nodeId,
  categories,
  accept,
  today,
}: {
  nodeId: string;
  categories: Cat[];
  accept: string;
  /** Today in India, YYYY-MM-DD: the latest a photo can have been taken. */
  today: string;
}) {
  const [category, setCategory] = useState(categories[0]?.key ?? "");
  const [count, setCount] = useState(0);
  const chosen = categories.find((c) => c.key === category);

  const [state, action] = useActionState<UploadState, FormData>(addAssetsAction, null);
  const files = useRef<HTMLInputElement>(null);
  // A batch sent straight to the file store, file by file: what it says, and how far it got.
  const [said, setSaid] = useState<UploadState>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Clear the picker once the files are in, so the same batch cannot be sent
  // twice by pressing again. Only the picker: the kind and the date are
  // usually the same for the next batch.
  const clear = () => {
    if (files.current) files.current.value = "";
    setCount(0);
  };
  useEffect(() => {
    if (state?.ok) clear();
    if (state) setSaid(null);
  }, [state]);

  // Each file goes to its own upload link, because a request through the
  // server is capped far below a batch of renders. Submitted without React's
  // reset, which emptied the whole form on a refusal while the category
  // state kept the old choice.
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const picked = Array.from(files.current?.files ?? []).filter((f) => f.size > 0);
    if (!picked.length || busy) return;
    const capturedOn = String(formData.get("capturedOn") ?? "") || null;
    const photograph = formData.get("photograph") !== null;
    setSaid(null);
    setBusy("Checking the files");
    try {
      const plan = await beginAssetUpload({
        nodeId,
        category,
        capturedOn,
        files: picked.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      });
      if (plan.state === "refused") return setSaid({ ok: false, message: plan.message });
      if (plan.state === "direct") return startTransition(() => action(formData));
      let added = 0;
      for (let i = 0; i < picked.length; i++) {
        const file = picked[i];
        const slot = plan.files[i];
        setBusy(picked.length > 1 ? `Uploading ${i + 1} of ${picked.length}` : "Uploading");
        const put = await fetch(slot.url, { method: "PUT", headers: { "content-type": file.type }, body: file }).catch(() => null);
        const r = put?.ok
          ? await finishAssetUpload({ nodeId, category, capturedOn, photograph, key: slot.key, name: file.name, type: file.type })
          : { ok: false, message: `${file.name} did not upload. Check the connection and try again.` };
        if (!r.ok) {
          return setSaid({ ok: false, message: added ? `${added} uploaded, then ${r.message}` : r.message });
        }
        added += 1;
      }
      clear();
      setSaid({ ok: true, message: added === 1 ? "1 file uploaded." : `${added} files uploaded.` });
    } catch {
      setSaid({ ok: false, message: "The upload stopped. Try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <form action={action} onSubmit={onSubmit}>
      <input type="hidden" name="nodeId" value={nodeId} />

      <div className="uploader__row">
        <label className="uploader__field">
          <span>What kind</span>
          <select
            name="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
          >
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="uploader__field uploader__field--grow">
          <span>Files</span>
          <input
            ref={files}
            type="file"
            name="media"
            multiple
            required
            accept={accept}
            onChange={(e) => setCount(e.target.files?.length ?? 0)}
          />
        </label>

        {chosen?.dated && (
          <label className="uploader__field">
            <span>Taken on</span>
            <input type="date" name="capturedOn" required max={today} />
          </label>
        )}
      </div>

      {chosen && !chosen.photographic && (
        <label className="checkset__item uploader__flag">
          <input type="checkbox" name="photograph" />
          <span>
            <strong>These are photographs</strong>
            <small>Leave unticked for renders.</small>
          </span>
        </label>
      )}

      <Submit count={count} state={said ?? state} busy={busy} />
    </form>
  );
}

/**
 * The button, and what it says while the upload is in flight.
 *
 * `useFormStatus` has to be inside the form it reports on, which is why this
 * is its own component rather than a branch above.
 */
function Submit({ count, state, busy }: { count: number; state: UploadState; busy: string | null }) {
  const pending = useFormStatus().pending || busy !== null;
  return (
    <div className="uploader__go">
      <button type="submit" className="btn btn--ink" disabled={pending} data-add>
        {pending
          ? busy ?? "Uploading, this can take a moment"
          : count > 1
            ? `Upload ${count} files`
            : "Upload"}
      </button>
      {pending ? (
        <span className="uploader__wait" aria-live="polite">Do not close this tab.</span>
      ) : (
        state && (
          <span
            className={state.ok ? "uploader__said" : "uploader__said uploader__said--bad"}
            role="status"
            data-result
          >
            {state.message}
          </span>
        )
      )}
    </div>
  );
}
