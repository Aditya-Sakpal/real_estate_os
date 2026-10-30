"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeKey, inGroup, onTabBar, type NavItem, type NavKey } from "@/lib/nav";
import {
  Ask,
  Inbox,
  Leads,
  Visit,
  Partners,
  Campaign,
  Library,
  Project,
  Report,
  Settings,
  Team,
  Mark,
  Building,
  Headset,
  Wallet,
  Phone,
  Grid,
  Close,
} from "@/components/icons";

const ICON: Record<NavKey, (p: { size?: number }) => React.ReactNode> = {
  today: Inbox,
  ask: Ask,
  agents: Headset,
  leads: Leads,
  desk: Phone,
  loans: Wallet,
  visits: Visit,
  partners: Partners,
  developers: Building,
  campaigns: Campaign,
  library: Library,
  projects: Project,
  team: Team,
  reports: Report,
  settings: Settings,
};

/**
 * Derived rail. `items` already arrives filtered by the viewer's roles, so
 * this component never decides visibility -- it only renders what
 * authorization resolved.
 *
 * Two groups. The work sits at the top and administration at the foot. On a
 * phone the rail becomes a tab bar carrying the first five of the work this
 * viewer reaches; the rest are marked here and hidden there, and the account
 * menu carries them instead.
 */
export function Rail({
  items,
  queueCount,
  orgName,
}: {
  items: NavItem[];
  queueCount: number;
  orgName: string;
}) {
  const pathname = usePathname();
  const current = activeKey(pathname);

  const work = inGroup(items, "work");
  const admin = inGroup(items, "admin");
  // A phone's bar holds four of the work and "More", which opens the rest as
  // a sheet: a fifth section that only the account menu reached was a section
  // nobody on a phone found. With nothing else to hold, five fit.
  const tabs = onTabBar(items);
  const hasMore = items.length > tabs.length;
  const barList = hasMore ? tabs.slice(0, 4) : tabs;
  const bar = new Set(barList.map((i) => i.key));
  const rest = items.filter((i) => !bar.has(i.key));
  const [sheet, setSheet] = useState(false);
  const restActive = current !== null && rest.some((i) => i.key === current);

  useEffect(() => setSheet(false), [pathname]);
  useEffect(() => {
    if (!sheet) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    document.addEventListener("keydown", esc);
    document.documentElement.classList.add("sheet-open");
    return () => {
      document.removeEventListener("keydown", esc);
      document.documentElement.classList.remove("sheet-open");
    };
  }, [sheet]);

  function row(item: NavItem) {
    const Icon = ICON[item.key];
    const active = current === item.key;
    return (
      <Link
        key={item.key}
        href={item.href}
        className="nav__item"
        aria-current={active ? "page" : undefined}
        data-offbar={item.group === "work" && !bar.has(item.key) ? "" : undefined}
      >
        <Icon size={17} />
        <span className="nav__text">{item.label}</span>
        {item.key === "today" && queueCount > 0 && (
          <span className="nav__count" aria-label={`${queueCount} waiting`}>
            {queueCount}
          </span>
        )}
      </Link>
    );
  }

  return (
    <aside className="rail">
      <div className="brand">
        <span className="brand__glyph">
          <Mark />
        </span>
        <span className="brand__name">Sales Desk</span>
      </div>

      <nav className="nav nav--work" aria-label="Sections">
        {work.map(row)}
      </nav>

      {hasMore && (
        <button
          type="button"
          className="nav__item rail__more"
          aria-haspopup="dialog"
          aria-expanded={sheet}
          aria-current={restActive ? "page" : undefined}
          onClick={() => setSheet(true)}
        >
          <Grid size={17} />
          <span className="nav__text">More</span>
        </button>
      )}

      {sheet && (
        <div className="msheet" role="dialog" aria-modal="true" aria-label="All sections">
          <button type="button" className="msheet__scrim" aria-label="Close" onClick={() => setSheet(false)} />
          <div className="msheet__panel">
            <div className="msheet__grip" aria-hidden />
            <div className="msheet__head">
              <span className="msheet__title">{orgName}</span>
              <button type="button" className="msheet__close" aria-label="Close" onClick={() => setSheet(false)}>
                <Close size={18} />
              </button>
            </div>
            <nav className="msheet__grid" aria-label="More sections">
              {rest.map((item) => {
                const Icon = ICON[item.key];
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    className="msheet__tile"
                    aria-current={current === item.key ? "page" : undefined}
                    onClick={() => setSheet(false)}
                  >
                    <span className="msheet__icon"><Icon size={20} /></span>
                    <span className="msheet__label">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      <div className="rail__foot">
        {admin.length > 0 && (
          <nav className="nav nav--admin" aria-label="Administration">
            {admin.map(row)}
          </nav>
        )}
        <div className="rail__org" title={orgName}>
          {orgName}
        </div>
      </div>
    </aside>
  );
}
