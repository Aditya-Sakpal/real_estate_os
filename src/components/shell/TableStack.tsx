"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * A data table read on a phone is a list of cards: the first cell is the
 * card's title, and every other cell carries its column's heading as its own
 * label. Scrolled sideways, the status, the money and the next step sat off
 * the right edge of the card with nothing to say they were there.
 *
 * This copies each column heading onto the cells under it (`data-label`) and
 * marks the table (`data-stack`), which `mobile.css` lays out as cards below
 * 760px. Above that nothing changes. A table that is a comparison rather
 * than a list (a plan matrix) opts out with `data-keep`, and the tables that
 * already lay themselves out on a phone (`.rp-stack`, `.pt-table`) are left
 * alone.
 */
export function TableStack() {
  const pathname = usePathname();

  useEffect(() => {
    const main = document.getElementById("main");
    if (!main) return;

    const label = (table: HTMLTableElement) => {
      if (table.hasAttribute("data-keep") || table.closest("[data-keep]")) return;
      if (table.classList.contains("rp-stack") || table.classList.contains("pt-table")) return;
      const head = table.tHead?.rows[table.tHead.rows.length - 1];
      if (!head) return;
      const names: string[] = [];
      for (const cell of Array.from(head.cells)) {
        const span = Math.max(1, cell.colSpan);
        const text = (cell.textContent ?? "").trim();
        for (let i = 0; i < span; i++) names.push(text);
      }
      if (names.length < 3) return;
      for (const body of Array.from(table.tBodies)) {
        for (const row of Array.from(body.rows)) {
          let col = 0;
          for (const cell of Array.from(row.cells)) {
            const name = names[col] ?? "";
            if (cell.getAttribute("data-label") !== name) cell.setAttribute("data-label", name);
            col += Math.max(1, cell.colSpan);
          }
        }
      }
      if (!table.hasAttribute("data-stack")) table.setAttribute("data-stack", "");
    };

    const run = () => main.querySelectorAll("table").forEach((t) => label(t as HTMLTableElement));
    // Never before the page has hydrated: an attribute added to server HTML
    // that React has not adopted yet reads to it as a mismatch. A page that
    // has finished loading has hydrated; a client navigation renders fresh.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      run();
      obs.observe(main, { childList: true, subtree: true });
    };
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        run();
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onLoad = () => {
      timer = setTimeout(start, 400);
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => {
      window.removeEventListener("load", onLoad);
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, [pathname]);

  return null;
}
