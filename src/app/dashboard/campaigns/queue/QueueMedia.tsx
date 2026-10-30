"use client";

import { useMediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { MediaThumb, withVariant } from "@/components/MediaThumb";
import { Expand, Play } from "@/components/icons";

/**
 * The post a person is approving, every slide of it, each opening full size.
 * Approving from a thumbnail is approving something nobody could read.
 */
export function QueueMedia({
  creativeId,
  headline,
  media,
}: {
  creativeId: string;
  headline: string;
  media: { type: string; width: number; height: number }[];
}) {
  const { open, viewer } = useMediaViewer();
  const src = (i: number) => `/dashboard/campaigns/queue/media/${creativeId}/${i}`;
  const items: ViewerItem[] = media.map((m, i) => ({
    src: m.type === "video/mp4" ? withVariant(src(i), "preview") : src(i),
    kind: m.type === "video/mp4" ? "video" : "image",
    alt: i === 0 ? headline : `Slide ${i + 1}`,
  }));
  return (
    <div className="postcard__media">
      {media.map((m, i) => (
        <button
          key={i}
          type="button"
          className="mediabtn"
          style={{ aspectRatio: `${m.width} / ${m.height}` }}
          aria-label={media.length > 1 ? `View slide ${i + 1}` : "View full size"}
          onClick={() => open(items, i, headline)}
          data-view-queue
        >
          {m.type === "video/mp4" ? (
            <>
              <MediaThumb src={src(i)} video />
              <span className="mediabtn__play" aria-hidden="true">
                <Play size={22} />
              </span>
            </>
          ) : (
            <MediaThumb src={src(i)} video={false} alt={items[i].alt} />
          )}
          <span className="mediabtn__zoom" aria-hidden="true">
            <Expand size={15} />
          </span>
        </button>
      ))}
      {viewer}
    </div>
  );
}
