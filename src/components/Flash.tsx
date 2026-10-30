"use client";

import { useEffect, type CSSProperties } from "react";

/**
 * The banner for a message a redirect carried (read and verified on the
 * server with `readFlash()`). Once shown, the message leaves the address, so
 * a later action on the same page re-renders without it rather than leaving
 * last time's error standing beside this time's result.
 */
export function Flash({
  text,
  name,
  tone = "risk",
  style,
  className,
}: {
  text: string | null | undefined;
  /** The query parameter it came in, so it can be taken out of the address. */
  name: string;
  tone?: "risk" | "info";
  style?: CSSProperties;
  className?: string;
}) {
  useEffect(() => {
    if (!text) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(name)) return;
    url.searchParams.delete(name);
    url.searchParams.delete(`${name}_s`);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [text, name]);

  if (!text) return null;
  return (
    <div className={`note note--${tone}${className ? ` ${className}` : ""}`} style={style} role={tone === "risk" ? "alert" : "status"}>
      {text}
    </div>
  );
}
