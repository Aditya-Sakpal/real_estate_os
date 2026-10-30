import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Two or three views of one section, as underlined tabs under the page head.
 *
 * The Leads section holds the pipeline and the calls that feed it. They are
 * one section on the rail, because the phone's tab bar stops at five, and two
 * views here, so the tab that is on says which one this is.
 */
export function SubTabs({
  label,
  current,
  items,
  end,
}: {
  label: string;
  current: string;
  items: { href: string; label: string; icon: ReactNode }[];
  /** A control that belongs to this view only, set on the tabs' own line. */
  end?: ReactNode;
}) {
  return (
    <div className="subtabs">
      <nav className="subtabs__nav" aria-label={label}>
        {items.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="subtabs__tab"
            aria-current={t.href === current ? "page" : undefined}
          >
            {t.icon}
            {t.label}
          </Link>
        ))}
      </nav>
      {end && <div className="subtabs__end">{end}</div>}
    </div>
  );
}
