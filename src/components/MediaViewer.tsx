"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Close } from "@/components/icons";

export type ViewerItem = {
  src: string;
  kind: "image" | "video";
  alt: string;
  /** Where a download of this one item goes. None: no download offered. */
  download?: string | null;
  /** A still for a video, shown while the clip loads. */
  poster?: string;
  /**
   * A small picture of the item for the strip under the stage. Without one the
   * strip loads the item itself: every slide at full size, or every clip.
   */
  thumb?: string;
};

/**
 * Media at the size of the screen: a post, a carousel's slides, a clip, or a
 * template's designs. Tiles in the studio are a few hundred pixels wide, and
 * a headline or a RERA number is not something a person can check at that
 * size.
 *
 * A native dialog, so the page behind is inert, Escape closes it and focus
 * returns to whatever opened it. Left and right step through a set; a press
 * on the dark around the media closes.
 */
export function MediaViewer({
  items,
  start,
  title,
  onClose,
  downloadAll,
}: {
  items: ViewerItem[];
  start: number;
  title: string;
  onClose: () => void;
  /** Where the whole set downloads as one file, for a carousel. None: not offered. */
  downloadAll?: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [at, setAt] = useState(Math.min(Math.max(0, start), items.length - 1));
  const many = items.length > 1;
  const item = items[at];

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const step = useCallback((by: number) => setAt((i) => (i + by + items.length) % items.length), [items.length]);

  // The pictures either side are fetched while this one is looked at, so
  // stepping through a set shows the next at once on a slow connection.
  useEffect(() => {
    if (items.length < 2) return;
    for (const n of [items[(at + 1) % items.length], items[(at - 1 + items.length) % items.length]]) {
      const src = n.kind === "image" ? n.src : n.poster;
      if (src) new Image().src = src;
    }
  }, [at, items]);

  if (!item) return null;
  return (
    <dialog
      ref={ref}
      className="viewer"
      aria-label={title}
      onClose={onClose}
      onKeyDown={(e) => {
        if (!many) return;
        if (e.key === "ArrowRight") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          step(-1);
        }
      }}
      onClick={(e) => {
        // The dark around the media is the dialog itself, or the stage.
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t.dataset.backdrop !== undefined) ref.current?.close();
      }}
      data-viewer
    >
      <div className="viewer__bar">
        <span className="viewer__title">
          {title}
          {many && <small>{`${at + 1} of ${items.length}`}</small>}
        </span>
        <span className="viewer__acts">
          {item.download && (
            <a href={item.download} className={downloadAll ? "viewer__download viewer__download--quiet" : "viewer__download"}>
              {downloadAll ? "This slide" : "Download"}
            </a>
          )}
          {downloadAll && (
            <a href={downloadAll} className="viewer__download" data-download-all>
              Download all {items.length} (ZIP)
            </a>
          )}
          <button type="button" className="viewer__round" aria-label="Close" onClick={() => ref.current?.close()} autoFocus>
            <Close size={18} />
          </button>
        </span>
      </div>

      <div className="viewer__stage" data-backdrop>
        {many && (
          <button type="button" className="viewer__round viewer__nav" aria-label="Previous" onClick={() => step(-1)}>
            <ChevronLeft size={22} />
          </button>
        )}
        {item.kind === "video" ? (
          <video key={item.src} src={item.src} poster={item.poster} className="viewer__media" controls autoPlay playsInline preload="auto" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={item.src} src={item.src} alt={item.alt} className="viewer__media" decoding="async" />
        )}
        {many && (
          <button type="button" className="viewer__round viewer__nav" aria-label="Next" onClick={() => step(1)}>
            <ChevronRight size={22} />
          </button>
        )}
      </div>

      {many && (
        <div className="viewer__thumbs" role="tablist" aria-label="All items">
          {items.map((it, i) => (
            <button
              key={it.src}
              type="button"
              role="tab"
              aria-selected={i === at}
              aria-label={it.alt}
              className={`viewer__thumb ${i === at ? "viewer__thumb--on" : ""}`}
              onClick={() => setAt(i)}
            >
              {it.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.thumb} alt="" loading="lazy" decoding="async" />
              ) : it.kind === "video" ? (
                <video src={`${it.src}#t=0.6`} muted playsInline preload="metadata" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.src} alt="" loading="lazy" />
              )}
            </button>
          ))}
        </div>
      )}
    </dialog>
  );
}

/**
 * The viewer as a hook: `open(items, index, title)` from any click, and
 * `viewer` rendered once in the component that owns the tiles.
 */
export function useMediaViewer(): {
  open: (items: ViewerItem[], index: number, title: string, opts?: { downloadAll?: string | null }) => void;
  viewer: ReactNode;
} {
  const [state, setState] = useState<
    { items: ViewerItem[]; index: number; title: string; downloadAll: string | null; n: number } | null
  >(null);
  const open = useCallback(
    (items: ViewerItem[], index: number, title: string, opts?: { downloadAll?: string | null }) =>
      setState((s) => ({ items, index, title, downloadAll: opts?.downloadAll ?? null, n: (s?.n ?? 0) + 1 })),
    [],
  );
  const viewer = state ? (
    <MediaViewer
      key={state.n}
      items={state.items}
      start={state.index}
      title={state.title}
      downloadAll={state.downloadAll}
      onClose={() => setState(null)}
    />
  ) : null;
  return { open, viewer };
}
