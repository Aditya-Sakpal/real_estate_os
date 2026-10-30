import Link from "next/link";
import { ArrowUpRight, Building } from "@/components/icons";
import type { PortalSummary } from "@/lib/portal-leads";

/**
 * Property portals as one card on Connected accounts: how many leads each
 * portal sent in the last 30 days, and the one thing to do when a portal
 * names a project nobody has matched to a tower.
 */
export function PortalsCard({ summary, dark }: { summary: PortalSummary; dark: boolean }) {
  const started = summary.counts.length > 0;
  const pill = summary.waiting
    ? { tone: "warn", text: `${summary.waiting} waiting` }
    : started
      ? { tone: "ok", text: "Receiving" }
      : { tone: "quiet", text: "Not set up" };
  return (
    <section className={`conn wa-conn${dark ? " conn--needs" : ""}`} data-provider="portals">
      <header className="conn__head">
        <span className="conn__mark" aria-hidden="true">
          <Building size={18} />
        </span>
        <div className="conn__id">
          <h2>
            <Link href="/dashboard/settings/connections/portals" className="conn__title">
              Property portals
            </Link>
          </h2>
          <p>99acres, MagicBricks, Housing.com and NoBroker.</p>
        </div>
        <span className={`pill pill--${pill.tone}`}>
          <span className="pill__dot" />
          {pill.text}
        </span>
      </header>
      {started ? (
        <ul className="conn__rows">
          {summary.counts.map((c) => (
            <li key={c.portal} className="conn__row">
              <span className="conn__kind">{c.label}</span>
              <strong className="conn__name">
                {c.leads.toLocaleString("en-IN")} {c.leads === 1 ? "lead" : "leads"}
              </strong>
              <span className="conn__where">Last 30 days</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="conn__none">No portal leads received yet.</p>
      )}
      <footer className="conn__foot">
        <span className="conn__who" />
        {summary.waiting ? (
          <Link href="/dashboard/settings/connections/portals?edit=1" className="btn btn--ink btn--sm" data-open="portals">
            Match projects
            <ArrowUpRight size={13} />
          </Link>
        ) : (
          <Link href="/dashboard/settings/connections/portals" className={started ? "conn__open" : "btn btn--ink btn--sm"} data-open="portals">
            {started ? "Open" : "Set up"}
            {!started && <ArrowUpRight size={13} />}
          </Link>
        )}
      </footer>
    </section>
  );
}
