"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Close, Plus, Trash } from "@/components/icons";
import { addCompetitorAdAction, saveMarketWeightAction, type LearningResult } from "@/app/actions/learning";

type Place = { id: string; label: string; pictures: number; videos: number };

const PLATFORMS: [string, string][] = [
  ["META", "Facebook or Instagram"],
  ["GOOGLE", "Google"],
  ["YOUTUBE", "YouTube"],
  ["PORTAL", "Property portal"],
  ["PRINT", "Print or hoarding"],
  ["OTHER", "Somewhere else"],
];

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/** "Add an ad": one form in a dialog, the file first, then what a person knows about it. */
export function AddAd({
  places,
  caps,
  maxBytes,
}: {
  places: Place[];
  caps: { pictures: number; videos: number };
  maxBytes: { picture: number; video: number };
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [state, submit, pending] = useActionState<LearningResult | null, FormData>(addCompetitorAdAction, null);
  // Starts unchosen unless there is only one: a default files the ad under
  // whichever project happened to come first.
  const [placeId, setPlaceId] = useState(places.length === 1 ? places[0].id : "");
  const [isVideo, setIsVideo] = useState(false);
  // Said here, before the upload: a file past the server's body limit never
  // reaches the action, and the screen would fail instead of saying why.
  const [tooBig, setTooBig] = useState<string | null>(null);
  const place = places.find((p) => p.id === placeId);
  const left = place ? (isVideo ? caps.videos - place.videos : caps.pictures - place.pictures) : 0;

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setIsVideo(false);
      setTooBig(null);
      router.refresh();
    }
  }, [state, router]);

  return (
    <>
      <button type="button" className="btn btn--ink" onClick={() => ref.current?.showModal()}>
        <Plus size={15} />
        Add an ad
      </button>
      <dialog ref={ref} className="cl-dialog" aria-labelledby="mk-title">
        <form ref={formRef} action={submit} className="cl-form">
          <div className="cl-head">
            <h2 id="mk-title">Add a competitor&apos;s ad</h2>
            <button type="button" className="btn btn--icon" aria-label="Close" onClick={() => ref.current?.close()}>
              <Close size={14} />
            </button>
          </div>

          <div className="field">
            <label htmlFor="mk-file">Picture or video of the ad</label>
            <input
              id="mk-file"
              name="file"
              type="file"
              required
              className="mk-file"
              accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,.png,.jpg,.jpeg,.webp,.mp4,.mov,.webm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                const video = !!f?.type.startsWith("video/");
                setIsVideo(video);
                setTooBig(
                  !f
                    ? null
                    : video
                      ? f.size > maxBytes.video
                        ? `A video can be up to ${Math.round(maxBytes.video / 1048576)} MB.`
                        : null
                      : f.size > maxBytes.picture
                        ? `A picture can be up to ${Math.round(maxBytes.picture / 1048576)} MB.`
                        : null,
                );
              }}
            />
          </div>

          <div className="cl-grid">
            <div className="field">
              <label htmlFor="mk-who">Whose ad</label>
              <input id="mk-who" name="competitor" type="text" required maxLength={120} placeholder="Lodha" />
            </div>
            <div className="field">
              <label htmlFor="mk-project">
                Their project <span className="mv-optional">(optional)</span>
              </label>
              <input id="mk-project" name="projectName" type="text" maxLength={120} placeholder="Lodha Amara" />
            </div>
            <div className="field">
              <label htmlFor="mk-loc">
                Locality <span className="mv-optional">(optional)</span>
              </label>
              <input id="mk-loc" name="locality" type="text" maxLength={120} placeholder="Thane West" />
            </div>
            <div className="field">
              <label htmlFor="mk-where">Where you saw it</label>
              <select id="mk-where" name="platform" className="cl-select" defaultValue="META" required>
                {PLATFORMS.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mk-since">
                Running since <span className="mv-optional">(optional)</span>
              </label>
              <input id="mk-since" name="runningSince" type="date" max={today()} className="mv-input tnum" />
            </div>
            <div className="field">
              <label htmlFor="mk-for">Compare with</label>
              <select id="mk-for" name="nodeId" className="cl-select" value={placeId} onChange={(e) => setPlaceId(e.target.value)} required>
                <option value="" disabled>
                  Choose a project
                </option>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!isVideo && (
            <label className="switch">
              <input type="checkbox" name="carousel" />
              <span>
                <span className="switch__name">It is one slide of a carousel</span>
              </span>
            </label>
          )}

          {place && (
            <p className={`mk-left${left <= 0 ? " is-out" : ""}`}>
              {left > 0
                ? `${left} ${isVideo ? (left === 1 ? "video" : "videos") : left === 1 ? "picture" : "pictures"} left to read for this project this month`
                : `No ${isVideo ? "videos" : "pictures"} left to read for this project this month`}
            </p>
          )}

          {tooBig ? (
            <p className="note note--risk" role="status">
              {tooBig}
            </p>
          ) : (
            state && (
              <p className={`note ${state.ok ? "note--info" : "note--risk"}`} role="status">
                {state.message}
              </p>
            )
          )}

          <div className="cl-actions">
            <button type="button" className="btn btn--ghost" onClick={() => ref.current?.close()}>
              {state?.ok ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="btn btn--ink" disabled={pending || left <= 0 || !!tooBig}>
              {pending ? "Reading the ad" : "Save and read"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/** How much the market counts: read-only for most, one number and Save for whoever may change it. */
export function WeightForm({ value, editable }: { value: number; editable: boolean }) {
  const [state, submit, pending] = useActionState<LearningResult | null, FormData>(saveMarketWeightAction, null);
  const [n, setN] = useState(String(value));
  if (!editable) {
    return (
      <p className="mk-weight">
        The market counts like <strong className="tnum">{value}</strong> qualified buyers of your own
      </p>
    );
  }
  // Compared with the saved value only: after a save the page brings the new
  // value back, so the next edit offers Save again.
  const changed = n !== String(value);
  return (
    <form action={submit} className="mk-weight">
      <label htmlFor="mk-weight">The market counts like</label>
      <input
        id="mk-weight"
        name="marketWeight"
        inputMode="numeric"
        className="mv-input tnum mk-weight__n"
        value={n}
        onChange={(e) => setN(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
        aria-describedby="mk-weight-unit"
      />
      <span id="mk-weight-unit">qualified buyers of your own</span>
      {changed && (
        <button type="submit" className="btn btn--ink btn--sm" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </button>
      )}
      {state && !state.ok && (
        <span className="mk-weight__err" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}

/** A circular remove button that asks first. */
export function RemoveButton({ who }: { who: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn--icon mk-remove"
      aria-label={`Remove ${who}'s ad`}
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(`Remove ${who}'s ad? It stops counting in what your next creative is made from.`)) e.preventDefault();
      }}
    >
      <Trash size={14} />
    </button>
  );
}
