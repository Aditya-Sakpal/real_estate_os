import Link from "next/link";
import type { CrmHealth } from "@/lib/crm-sync";
import { crmLabel } from "@/lib/crm-rules";
import { ArrowUpRight, Board } from "@/components/icons";
import "./crm/crm.css";

/**
 * The CRM, as one card beside the ad platforms: whether it works, what is
 * waiting on a person, and the one thing to do next. A CRM that stopped
 * working, or that holds leads nobody can send, is this group's dark card.
 */
export function CrmCard({ health }: { health: CrmHealth | null }) {
  const label = health ? crmLabel(health.provider) : null;
  const w = health?.waitingMappings;
  const waiting = w ? w.STAGE + w.PROJECT + w.USER : 0;
  const needs = !!health && (health.status === "BROKEN" || health.dead.length > 0 || waiting > 0);
  const pill = !health
    ? { tone: "quiet", text: "Not connected" }
    : health.status === "BROKEN"
      ? { tone: "risk", text: "Stopped working" }
      : needs
        ? { tone: "warn", text: "Needs you" }
        : { tone: "ok", text: "Working" };

  const rows: { k: string; v: string }[] = [];
  if (health) {
    if (health.account) rows.push({ k: "Account", v: health.account });
    rows.push({ k: "Leads matched", v: health.linked.toLocaleString("en-IN") });
    if (waiting) rows.push({ k: "Not matched", v: `${waiting.toLocaleString("en-IN")} of theirs` });
    if (health.dead.length) rows.push({ k: "Refused", v: `${health.dead.length.toLocaleString("en-IN")} ${health.dead.length === 1 ? "lead" : "leads"}` });
  }

  return (
    <section className={`conn crm-conn${needs ? " conn--needs" : ""}`} data-provider="crm" data-crm={health?.provider.toLowerCase() ?? "none"}>
      <header className="conn__head">
        <span className="conn__mark" aria-hidden="true">
          <Board size={18} />
        </span>
        <div className="conn__id">
          <h2>
            {health ? (
              <Link href="/dashboard/settings/connections/crm" className="conn__title">
                {label}
              </Link>
            ) : (
              "CRM"
            )}
          </h2>
          <p>{health ? (health.provider === "SELLDO" ? "New leads go to it." : "Leads go both ways.") : "LeadSquared, Sell.Do or LeadRat."}</p>
        </div>
        <span className={`pill pill--${pill.tone}`}>
          <span className="pill__dot" />
          {pill.text}
        </span>
      </header>

      {health?.status === "BROKEN" && health.lastError && (
        <p className="conn__error" role="alert">
          {health.lastError}
        </p>
      )}

      {rows.length ? (
        <ul className="conn__rows">
          {rows.map((r) => (
            <li key={r.k} className="conn__row">
              <span className="conn__kind">{r.k}</span>
              <strong className="conn__name">{r.v}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="conn__none">Not connected.</p>
      )}

      <footer className="conn__foot">
        <span className="conn__who">{health?.lastSyncedAt ? `Last synced ${health.lastSyncedAt.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}` : null}</span>
        {health ? (
          <Link href="/dashboard/settings/connections/crm" className={needs ? "btn btn--light btn--sm" : "conn__open"}>
            {needs ? (health.status === "BROKEN" ? "Reconnect" : "Open") : "Open"}
            {needs && <ArrowUpRight size={13} />}
          </Link>
        ) : (
          <Link href="/dashboard/settings/connections/crm" className="btn btn--ink btn--sm" data-connect="crm">
            Connect a CRM
            <ArrowUpRight size={13} />
          </Link>
        )}
      </footer>
    </section>
  );
}
