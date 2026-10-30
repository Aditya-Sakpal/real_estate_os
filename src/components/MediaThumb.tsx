"use client";

import { useEffect, useRef, useState } from "react";

/** A media address with its lighter copy asked for (`?v=`). */
export function withVariant(src: string, v: "thumb" | "poster" | "preview"): string {
  return `${src}${src.includes("?") ? "&" : "?"}v=${v}`;
}

/**
 * A tile's picture: the small copy of an image, or a video's still, never the
 * file itself. A video whose still is not made yet falls back to the video
 * (its first half second, as tiles always showed it); an image whose small
 * copy fails falls back to the image.
 */
export function MediaThumb({ src, video, alt = "" }: { src: string; video: boolean; alt?: string }) {
  const [fallback, setFallback] = useState(false);
  const img = useRef<HTMLImageElement>(null);

  // An image that failed before the page woke up never fires onError.
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setFallback(true);
  }, []);

  if (fallback) {
    return video ? (
      <video src={`${src}#t=0.6`} muted playsInline preload="metadata" />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt} loading="lazy" decoding="async" />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={img}
      src={withVariant(src, video ? "poster" : "thumb")}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFallback(true)}
    />
  );
}
