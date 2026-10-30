"use client";

import { useMediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { MediaThumb, withVariant } from "@/components/MediaThumb";
import { Expand, Play } from "@/components/icons";

type Pic = { id: string; nodeId: string; title: string; category: string; place: string; video: boolean };

/**
 * The pictures waiting for approval, each opening full size with the rest a
 * step away. Approving a picture from a tile is approving something nobody
 * could see properly.
 */
export function ReviewPictures({ pictures }: { pictures: Pic[] }) {
  const { open, viewer } = useMediaViewer();
  const src = (p: Pic) => `/dashboard/library/${p.nodeId}/file/${p.id}`;
  const items: ViewerItem[] = pictures.map((p) => ({
    src: p.video ? withVariant(src(p), "preview") : src(p),
    kind: p.video ? "video" : "image",
    alt: p.title,
    poster: p.video ? withVariant(src(p), "poster") : undefined,
    thumb: withVariant(src(p), p.video ? "poster" : "thumb"),
  }));
  return (
    <>
      <ul className="rv-tiles">
        {pictures.map((p, i) => (
          <li key={p.id} className="rv-tile">
            <button
              type="button"
              className="rv-thumb mediabtn"
              aria-label={`View ${p.title} full size`}
              onClick={() => open(items, i, "Pictures to approve")}
              data-view-review
            >
              <MediaThumb src={src(p)} video={p.video} alt={p.title} />
              {p.video && (
                <span className="mediabtn__play" aria-hidden="true">
                  <Play size={22} />
                </span>
              )}
              <span className="mediabtn__zoom" aria-hidden="true">
                <Expand size={15} />
              </span>
            </button>
            <strong className="rv-tile__title">{p.title}</strong>
            <span className="rv-meta">
              {p.category} · {p.place}
            </span>
          </li>
        ))}
      </ul>
      {viewer}
    </>
  );
}
