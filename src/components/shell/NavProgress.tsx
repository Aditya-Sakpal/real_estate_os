"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Answers a click on a link the moment it lands, before the server does.
 *
 * Every console page reads the database, so a press can take a few hundred
 * milliseconds to come back, and a press that changes nothing on screen for
 * that long reads as a press that missed. So this listens for clicks on links
 * the router will handle and, in the same frame, starts a thin bar across the
 * top and marks the pressed link (`data-pending`, which the rail and the
 * sub-tabs style as the new "you are here"). Both clear when the address
 * changes, or after a ceiling, because a link to a file downloads rather than
 * navigates and would otherwise leave the bar running.
 *
 * It listens on the document in the capture phase rather than wrapping
 * `<Link>`, so every link in the console is covered, including the ones
 * inside cards and tables that nobody will remember to wrap.
 */
const CEILING_MS = 10_000;

/** Route handlers that answer with a file, not a page. */
const FILE_ROUTE = /\/(zip|file|media|backdrop|reference|templates|fonts|reels|stop|send|action)(\/|$)|\/post\/[^/]+\/\d+$/;

export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const marked = useRef<Element[]>([]);
  const ceiling = useRef<ReturnType<typeof setTimeout> | null>(null);

  function unmark() {
    for (const el of marked.current) {
      el.removeAttribute("data-pending");
      el.removeAttribute("data-navigating");
    }
    marked.current = [];
    if (ceiling.current) clearTimeout(ceiling.current);
    ceiling.current = null;
  }

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download")) return;
      if (a.target && a.target !== "_self") return;

      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      if (FILE_ROUTE.test(to.pathname)) return;
      // A link to where we already are, or to an anchor on this page, moves
      // nothing, so nothing would ever clear the bar.
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;

      unmark();
      a.setAttribute("data-pending", "");
      const group = a.closest(".rail, nav");
      if (group) group.setAttribute("data-navigating", "");
      marked.current = group ? [a, group] : [a];
      setState("busy");
      ceiling.current = setTimeout(() => {
        unmark();
        setState("idle");
      }, CEILING_MS);
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // The address changed: the new page is on its way or already here.
  useEffect(() => {
    if (marked.current.length === 0) return;
    unmark();
    setState("done");
    const t = setTimeout(() => setState("idle"), 260);
    return () => clearTimeout(t);
  }, [pathname, search]);

  return <div className="navbar" data-state={state} aria-hidden="true" />;
}
