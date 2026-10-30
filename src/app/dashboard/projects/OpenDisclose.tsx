"use client";

import type { ReactNode } from "react";

/**
 * A button that opens a closed form card on this page and takes the person
 * to it, in the same frame as the press. Without script it is a link whose
 * address opens the card on the server.
 */
export function OpenDisclose({
  target,
  href,
  pick,
  focus,
  className,
  children,
}: {
  /** The id of the `<details>` card to open. */
  target: string;
  /** Where a press goes without script: an address that renders it open. */
  href: string;
  /** A select inside the card to set first, as [element id, value]. */
  pick?: [string, string];
  /** The field to put the cursor in, by element id. The first field otherwise. */
  focus?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        const card = document.getElementById(target);
        if (!(card instanceof HTMLDetailsElement)) return;
        e.preventDefault();
        card.open = true;
        if (pick) {
          const select = document.getElementById(pick[0]);
          if (select instanceof HTMLSelectElement) select.value = pick[1];
        }
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        card.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
        const field =
          (focus ? document.getElementById(focus) : null) ??
          card.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea");
        field?.focus({ preventScroll: true });
      }}
    >
      {children}
    </a>
  );
}
