"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building, Headset, Inbox, Leads, Mark, Receipt, Report, Shield, Team, Wallet, Campaign, Alert } from "@/components/icons";

type Item = { href: string; label: string; icon: (p: { size?: number }) => React.ReactNode; count?: number };

const BUSINESS: Item[] = [
  { href: "/", label: "Overview", icon: Inbox },
  { href: "/clients", label: "Clients", icon: Building },
  { href: "/plans", label: "Plans and revenue", icon: Receipt },
  { href: "/usage", label: "Usage and cost", icon: Report },
  { href: "/vendors", label: "Vendors", icon: Wallet },
];

const ACTIVITY: Item[] = [
  { href: "/calls", label: "AI calls", icon: Headset },
  { href: "/leads", label: "Leads", icon: Leads },
  { href: "/content", label: "Posts and videos", icon: Campaign },
];

/** The operator console's rail, in the console's own shell. */
export function AdminRail({ problems }: { problems: number }) {
  const raw = usePathname() ?? "/";
  // On admin.salesdesk.app the address has no /admin; inside the rewrite it may.
  const path = raw.replace(/^\/admin(?=\/|$)/, "") || "/";
  const on = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  let shown = 0;

  function row(item: Item, count?: number) {
    const Icon = item.icon;
    shown += 1;
    return (
      <Link
        key={item.href}
        href={item.href}
        className="nav__item"
        aria-current={on(item.href) ? "page" : undefined}
        data-offbar={shown > 5 ? "" : undefined}
      >
        <Icon size={17} />
        <span className="nav__text">{item.label}</span>
        {!!count && (
          <span className="nav__count" aria-label={`${count} problems`}>
            {count}
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
        <span className="brand__name">
          Sales Desk <span className="adm-brand-tag">Admin</span>
        </span>
      </div>

      <nav className="nav nav--work" aria-label="Sections">
        <div className="nav__label">Business</div>
        {BUSINESS.map((i) => row(i))}
        <div className="nav__label">Activity</div>
        {ACTIVITY.map((i) => row(i))}
      </nav>

      <div className="rail__foot">
        <nav className="nav nav--admin" aria-label="System">
          {row({ href: "/health", label: "System health", icon: Alert }, problems)}
          {row({ href: "/operators", label: "Operators", icon: Team })}
        </nav>
        <div className="rail__org adm-rail-note">
          <Shield size={13} /> Sales Desk staff only
        </div>
      </div>
    </aside>
  );
}
