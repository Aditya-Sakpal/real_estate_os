"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Search, ChevronRight, ChevronDown, Alert, Check, Plus } from "@/components/icons";
import { switchOrgAction } from "@/app/actions/org";
import { signOutAction } from "@/app/actions/auth";
import type { PlaceCard } from "@/lib/queue";
import { crumbsFor, type NavItem } from "@/lib/nav";

export type OrgChoice = {
  id: string;
  displayName: string;
  legalName: string;
  type: string;
  role: string;
  /** The firm whose mandate reaches this developer, when it is not a membership. */
  via?: string;
};

type Props = {
  initials: string;
  email: string;
  roleLabel: string;
  /** Count of projects that cannot legally be advertised. 0 hides the chip. */
  blockedCount: number;
  orgs: OrgChoice[];
  currentOrgId: string;
  /** Every project and tower, for the jump control. */
  places: PlaceCard[];
  /** The sections the rail keeps off a phone's tab bar. */
  secondary: NavItem[];
  /** The firm this person works through, when the org is a developer they reach by mandate. */
  viaFirm?: string;
  /** That firm's own org, which its workspace is. */
  viaFirmId?: string;
};

const TYPE_LABEL: Record<string, string> = {
  DEVELOPER: "Developer",
  CHANNEL_PARTNER: "Channel partner",
  MANDATE_FIRM: "Mandate firm",
  AGENCY: "Agency",
  CALL_CENTER: "Call centre",
  PLATFORM: "Platform",
};

function roleWords(role: string): string {
  return role.toLowerCase().replace(/_/g, " ");
}

/**
 * The bar carries three things: where you are, where else you could be, and
 * who you are.
 *
 * The scope path is real now. It used to be the organisation name followed by
 * buttons that announced a menu and opened nothing, which is the shape of
 * control this product's own rules refuse: a control that does nothing must
 * not exist. Every segment is a link to the thing it names, and the last
 * segment is not a link because it is the page you are on.
 *
 * The jump box searches places. The box that stood here searched leads, which
 * do not exist yet, so typing into it produced a panel saying so. Places are
 * what the console holds today, so that is what it finds.
 */
export function TopBar({
  initials,
  email,
  roleLabel,
  blockedCount,
  orgs,
  currentOrgId,
  places,
  secondary,
  viaFirm,
  viaFirmId,
}: Props) {
  const [query, setQuery] = useState("");
  const [showResult, setShowResult] = useState(false);
  const [open, setOpen] = useState<null | "org" | "me">(null);
  const boxRef = useRef<HTMLElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setShowResult(false);
        setOpen(null);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setShowResult(false);
        setOpen(null);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return places
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.under ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [places, query]);

  const crumbs = useMemo(
    () =>
      crumbsFor(pathname, (id) => places.find((p) => p.id === id)?.name ?? null),
    [pathname, places],
  );
  const here = crumbs[crumbs.length - 1];

  return (
    <header className="bar" ref={boxRef}>
      <nav className="crumbs" aria-label="Where you are">
        {crumbs.map((c, i) => (
          <span key={c.label + i} className="crumbs__seg">
            {i > 0 && <ChevronRight size={12} className="crumb__sep" />}
            {c.href ? (
              <Link href={c.href} className="crumb">
                {c.label}
              </Link>
            ) : (
              <span className="crumb crumb--here" aria-current="page">
                {c.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div className="search">
        <Search className="search__icon" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShowResult(e.target.value.trim().length > 0);
          }}
          onFocus={() => setShowResult(query.trim().length > 0)}
          placeholder={places.length ? "Jump to a project or tower" : "Nothing to jump to yet"}
          disabled={places.length === 0}
          aria-label="Jump to a project or tower"
        />
        {showResult && (
          <div
            className="menu"
            role="listbox"
            aria-label="Places"
            style={{ top: "calc(100% + 6px)", left: 0, right: 0, minWidth: 0 }}
          >
            {hits.length === 0 ? (
              <div className="menu__note">No project or tower by that name.</div>
            ) : (
              hits.map((p) => (
                <Link
                  key={p.id}
                  href={p.href}
                  role="option"
                  aria-selected={false}
                  className="menu__item"
                  onClick={() => {
                    setShowResult(false);
                    setQuery("");
                  }}
                >
                  <span className="menu__body">
                    <span className="menu__name">{p.name}</span>
                    <span className="menu__meta">
                      {p.kind === "PHASE" ? `Tower · ${p.under ?? ""}` : "Project"}
                    </span>
                  </span>
                </Link>
              ))
            )}
          </div>
        )}
      </div>

      <div className="bar__actions">
        <button
          type="button"
          className="crumb crumb--org"
          aria-haspopup="menu"
          aria-expanded={open === "org"}
          onClick={() => setOpen((v) => (v === "org" ? null : "org"))}
        >
          {orgs.find((o) => o.id === currentOrgId)?.displayName ?? "Organisation"}
          <ChevronDown size={12} />
        </button>

        {viaFirm && (
          <span className="pill pill--blue" title={`Working through ${viaFirm}'s mandate`}>
            Through {viaFirm}
          </span>
        )}

        {blockedCount > 0 && (
          <Link
            href="/dashboard"
            className="pill pill--risk"
            title="Towers that cannot be advertised"
            aria-label={`${blockedCount} ${blockedCount === 1 ? "tower" : "towers"} blocked`}
          >
            <Alert size={13} />
            {blockedCount}
            <span className="bar__blocked-text"> {blockedCount === 1 ? "tower" : "towers"} blocked</span>
          </Link>
        )}

        <button
          type="button"
          className="avatar"
          onClick={() => setOpen((v) => (v === "me" ? null : "me"))}
          aria-haspopup="menu"
          aria-expanded={open === "me"}
          title={`${email} · ${roleLabel}`}
        >
          {initials}
        </button>
      </div>

      {open === "org" && (
        <div className="menu menu--right" role="menu">
          <div className="menu__label">
            {orgs.length === 1 ? "Organisation" : `Organisations · ${orgs.length}`}
          </div>

          {orgs.map((o) => {
            const current = o.id === currentOrgId;
            return (
              <form key={o.id} action={switchOrgAction}>
                <input type="hidden" name="orgId" value={o.id} />
                <button
                  type="submit"
                  className="menu__item"
                  role="menuitem"
                  aria-current={current}
                  disabled={current}
                >
                  <span className="menu__body">
                    <span className="menu__name">{o.displayName}</span>
                    <span className="menu__meta">
                      {o.via ? `Mandate, through ${o.via}` : `${TYPE_LABEL[o.type] ?? o.type} · ${roleWords(o.role)}`}
                    </span>
                  </span>
                  {current && <Check size={14} className="menu__tick" />}
                </button>
              </form>
            );
          })}

          <div className="menu__sep" />

          <Link
            href="/onboarding?another=1"
            className="menu__item menu__item--add"
            role="menuitem"
            onClick={() => setOpen(null)}
          >
            <Plus size={15} />
            Create a new organisation
          </Link>
        </div>
      )}

      {open === "me" && (
        <div className="menu menu--right" role="menu">
          <div style={{ padding: "8px 10px 10px" }}>
            <div style={{ fontSize: 13, fontWeight: 570, wordBreak: "break-all" }}>{email}</div>
            <div style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 2 }}>{roleLabel}</div>
          </div>

          {/* The rail's tab bar carries the work and nothing else on a phone,
              so the rest of the console is reached from here. On a desktop the
              rail already shows them and this section is hidden. */}
          {secondary.length > 0 && (
            <div className="menu__phone">
              <div className="menu__sep" />
              {secondary.map((s) => (
                <Link
                  key={s.key}
                  href={s.href}
                  className="menu__item"
                  role="menuitem"
                  onClick={() => setOpen(null)}
                >
                  {s.label}
                </Link>
              ))}
            </div>
          )}

          {viaFirm && viaFirmId && (
            <>
              <div className="menu__sep" />
              <form action={switchOrgAction}>
                <input type="hidden" name="orgId" value={viaFirmId} />
                <button type="submit" className="menu__item" role="menuitem">
                  Back to {viaFirm}
                </button>
              </form>
            </>
          )}

          <div className="menu__sep" />
          <form action={signOutAction}>
            <SignOutButton />
          </form>
        </div>
      )}

      <span className="sr-only" aria-live="polite">
        {here ? `You are in ${here.label}` : ""}
      </span>
    </header>
  );
}

/** Says "Signing out" the moment it is pressed, so the wait never reads as a dead button. */
function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="menu__item" role="menuitem" disabled={pending} aria-busy={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
