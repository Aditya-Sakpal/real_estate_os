"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import * as Icons from "@/components/icons";
import "./section-frame.css";

export type SectionIcon = Exclude<keyof typeof Icons, never>;

export type SectionItem = {
  key: string;
  label: string;
  href: string;
  icon?: SectionIcon;
  /** Other addresses that belong to this item. */
  also?: string[];
  /** Items under this one (a project's towers), listed beneath it while it
   *  or one of them is open, so a tower is never mistaken for its project. */
  children?: SectionItem[];
  /** A number worth seeing from anywhere in the section. */
  count?: number;
  tone?: "risk" | "warn";
};

export type SectionGroup = { key: string; label?: string; items: SectionItem[] };

/**
 * A section with several screens: the list of them on the left, the screen
 * on the right. Settings, Campaigns and Library all use this one frame, so
 * moving between their screens works the same way everywhere.
 *
 * `skip` names the addresses that need the whole width (a campaign's studio),
 * where the list is not drawn.
 */
export function SectionFrame({
  label,
  groups,
  skip = [],
  children,
}: {
  label: string;
  groups: SectionGroup[];
  skip?: string[];
  children: ReactNode;
}) {
  const path = usePathname() ?? "";
  if (skip.some((s) => path === s || path.startsWith(`${s}/`))) return <>{children}</>;

  const items = groups.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])]));
  // The item whose address this page sits deepest under is the one we are on.
  // The section's first item is its overview, which only its own address opens.
  const overview = items[0]?.href;
  let active: string | undefined;
  let best = -1;
  for (const i of items) {
    for (const h of [i.href, ...(i.also ?? [])]) {
      const hit = h === overview ? path === h : path === h || path.startsWith(`${h}/`);
      if (hit && h.length > best) {
        best = h.length;
        active = i.key;
      }
    }
  }

  const link = (i: SectionItem, child = false, open = false) => {
    const Icon = i.icon ? (Icons[i.icon] as (p: { size?: number }) => ReactNode) : null;
    return (
      <Link
        key={i.key}
        href={i.href}
        className={`secnav__item${child ? " secnav__item--child" : ""}${open ? " secnav__item--open" : ""}`}
        aria-current={active === i.key ? "page" : undefined}
      >
        {Icon && <Icon size={15} />}
        <span className="secnav__text">{i.label}</span>
        {i.count !== undefined && i.count > 0 && (
          <span className={`secnav__count${i.tone ? ` secnav__count--${i.tone}` : ""}`}>{i.count}</span>
        )}
      </Link>
    );
  };

  return (
    <div className="secx">
      <nav className="secnav" aria-label={label}>
        {groups.map((g) => (
          <div key={g.key} className="secnav__group">
            {g.label && <p className="secnav__label">{g.label}</p>}
            {g.items.map((i) => {
              const kids = i.children ?? [];
              const childOn = kids.some((c) => c.key === active);
              const expanded = kids.length > 0 && (active === i.key || childOn);
              return (
                <div key={i.key} className="secnav__branch">
                  {link(i, false, childOn)}
                  {expanded && <div className="secnav__kids">{kids.map((c) => link(c, true))}</div>}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="secx__body">{children}</div>
    </div>
  );
}
