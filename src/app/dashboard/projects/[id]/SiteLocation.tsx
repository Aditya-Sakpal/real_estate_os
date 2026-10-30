"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { saveSiteLocationAction, type ActionResult } from "@/app/actions/leads";
import { addGalleryAction, removeGalleryAction } from "@/app/actions/project-life";
import { ConfirmAction } from "@/components/ConfirmAction";
import type { LocationView } from "@/lib/visits";
import { ArrowUpRight } from "@/components/icons";
import "./site-location.css";

/**
 * Where the site is: what a buyer gets as directions when a visit is booked.
 * Read-only until "Change", then the Maps link and the address, saved from
 * the card's own head.
 */
export function SiteLocation({
  nodeId,
  location,
  galleries = [],
  canEdit,
}: {
  nodeId: string;
  location: LocationView | null;
  /** This node's own galleries, the first one being `location` when it is its own. */
  galleries?: LocationView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<false | "main" | "add">(false);
  const [mainState, submitMain, mainPending] = useActionState<ActionResult | null, FormData>(saveSiteLocationAction, null);
  const [addState, submitAdd, addPending] = useActionState<ActionResult | null, FormData>(addGalleryAction, null);
  const adding = editing === "add";
  const state = adding ? addState : mainState;
  const submit = adding ? submitAdd : submitMain;
  const pending = mainPending || addPending;
  // The answer current when the form was opened, so an old refusal is not shown again.
  const [seen, setSeen] = useState<ActionResult | null>(null);

  useEffect(() => {
    if (!mainState?.ok && !addState?.ok) return;
    setEditing(false);
    router.refresh();
  }, [mainState, addState, router]);

  const own = adding ? null : location && !location.inherited ? location : null;
  const others = galleries.filter((g) => g.id !== location?.id);
  const error = editing && state && !state.ok && state !== seen ? state.message : null;

  return (
    <section className="card siteloc" aria-labelledby="siteloc-title" data-site-location>
      <div className="card__head">
        <h2 id="siteloc-title">Site location</h2>
        {location?.inherited && !editing && <span className="pill pill--quiet">From {location.from}</span>}
        {editing ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
            <button type="submit" form="siteloc-form" className="btn btn--ink btn--sm" disabled={pending}>
              {pending ? "Saving" : adding ? "Save gallery" : "Save location"}
            </button>
          </>
        ) : canEdit ? (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setSeen(mainState);
                setEditing("main");
              }}
              aria-label={location ? "Change site location" : undefined}
              data-change-location
            >
              {location ? "Change" : "Add location"}
            </button>
            {own && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setSeen(addState);
                  setEditing("add");
                }}
                data-add-gallery
              >
                Add a gallery
              </button>
            )}
          </>
        ) : null}
      </div>

      {error && (
        <p className="note note--risk siteloc__note" role="alert">
          {error}
        </p>
      )}

      {editing ? (
        <form id="siteloc-form" action={submit} className="siteloc__form" key={editing}>
          <input type="hidden" name="nodeId" value={nodeId} />
          {adding ? (
            <div className="field">
              <label htmlFor="siteloc-label">Gallery name</label>
              <input id="siteloc-label" name="label" type="text" required maxLength={60} autoComplete="off" placeholder="e.g. Baner Road gallery" />
            </div>
          ) : (
            own && <input type="hidden" name="label" value={own.label} />
          )}
          <div className="field">
            <label htmlFor="siteloc-link">Google Maps link</label>
            <input
              id="siteloc-link"
              name="link"
              type="text"
              inputMode="url"
              required
              autoComplete="off"
              defaultValue={own?.mapsUrl ?? ""}
              placeholder="https://maps.app.goo.gl/… or 18.5591, 73.7868"
            />
          </div>
          <div className="field">
            <label htmlFor="siteloc-address">Address</label>
            <input
              id="siteloc-address"
              name="address"
              type="text"
              maxLength={300}
              defaultValue={own?.address ?? ""}
              placeholder="Survey No. 42, Baner Road, Pune 411045"
            />
          </div>
        </form>
      ) : location ? (
        <div className="siteloc__read">
          <span className="siteloc__mark" aria-hidden="true">
            <PinMark />
          </span>
          <span className="siteloc__what">
            {others.length > 0 && <span className="siteloc__addr">{location.label}</span>}
            <span className={location.address ? "siteloc__addr" : "siteloc__addr siteloc__addr--none"}>
              {location.address ?? "No address recorded"}
            </span>
            {location.latitude !== null && location.longitude !== null && (
              <span className="siteloc__pin tnum">
                {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
              </span>
            )}
          </span>
          <a href={location.mapsUrl} target="_blank" rel="noreferrer" className="siteloc__open">
            Open in Maps
            <ArrowUpRight size={12} />
          </a>
        </div>
      ) : (
        <p className="siteloc__none">Not set.</p>
      )}

      {!editing && others.length > 0 && (
        <ul className="siteloc__more" data-galleries>
          {others.map((g) => (
            <li key={g.id} className="siteloc__read">
              <span className="siteloc__what">
                <span className="siteloc__addr">{g.label}</span>
                <span className={g.address ? "siteloc__pin" : "siteloc__pin siteloc__addr--none"}>{g.address ?? "No address recorded"}</span>
              </span>
              <a href={g.mapsUrl} target="_blank" rel="noreferrer" className="siteloc__open">
                Open in Maps
                <ArrowUpRight size={12} />
              </a>
              {canEdit && (
                <ConfirmAction
                  label="Remove"
                  title={`Remove ${g.label}?`}
                  body="Visits booked there get directions to the first gallery instead."
                  confirmLabel="Remove gallery"
                  action={removeGalleryAction}
                  fields={{ nodeId, locationId: g.id, back: `/dashboard/projects/${nodeId}` }}
                  tone="risk"
                  testId="remove-gallery"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PinMark() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  );
}
