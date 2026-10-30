import Link from "next/link";
import { redirect } from "next/navigation";
import { ExportWithCode } from "./ExportWithCode";
import { getViewer } from "@/lib/console";
import { PageHead } from "@/components/shell/PageHead";
import { SubTabs } from "@/components/shell/SubTabs";
import { Board, Phone, Building } from "@/components/icons";
import { listBoard, ownersFor } from "@/lib/leads";
import { LeadBoard } from "./LeadBoard";

/**
 * The lead pipeline, as a board.
 *
 * A tenant with no leads yet sees the empty board on its own towers, never
 * invented leads: a client's console holds only its own data.
 *
 * "Today" is fixed here, on the server, in Asia/Kolkata. Every date rule in
 * a move reads it, and a browser in another timezone must not disagree with
 * the page about which day it is.
 *
 * `?needs=1` opens the board filtered to the leads waiting on a person, which
 * is where Today and the rest of the console link to.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ needs?: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:read")) redirect("/dashboard");

  const orgId = viewer.state.org.id;
  const [{ needs }, board, owners] = await Promise.all([
    searchParams,
    listBoard(orgId, viewer.authz.scopesFor("lead:read")),
    ownersFor(orgId, null),
  ]);
  const needsOnly = needs === "1";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  // A portal's export, for leads the forwarded emails did not bring.
  const importPortal = viewer.authz.can("lead:create") ? (
    <Link href="/dashboard/leads/portals" className="btn btn--ghost" data-portal-import>
      Import portal leads
    </Link>
  ) : null;

  const tabs = (
    <SubTabs
      label="Leads views"
      current="/dashboard/leads"
      items={[
        { href: "/dashboard/leads", label: "Pipeline", icon: <Board size={15} /> },
        { href: "/dashboard/leads/calls", label: "Calls", icon: <Phone size={15} /> },
        ...(viewer.authz.can("inventory:read")
          ? [{ href: "/dashboard/leads/availability", label: "Availability", icon: <Building size={15} /> }]
          : []),
      ]}
    />
  );

  if (board.leads.length > 0) {
    const open = board.leads.filter((l) => l.stage !== "booked" && l.stage !== "lost").length;
    const towers = board.places.length;
    return (
      <>
        <PageHead
          title={
            <>
              Lead <span className="em">pipeline</span>
            </>
          }
          meta={`${open.toLocaleString("en-IN")} open ${open === 1 ? "lead" : "leads"} across ${towers} ${towers === 1 ? "tower" : "towers"}`}
          action={
            <>
              {importPortal}
              {viewer.authz.can("lead:export") ? (
                <a href="/dashboard/leads/export" className="btn btn--ghost" download>
                  Export
                </a>
              ) : viewer.stepUpAt("lead:export") ? (
                <ExportWithCode />
              ) : null}
            </>
          }
        />
        {tabs}
        <LeadBoard
          live
          leads={board.leads}
          places={board.places}
          today={today}
          team={owners.map((p) => p.name)}
          needsOnly={needsOnly}
          canMove={viewer.authz.can("lead:update")}
        />
      </>
    );
  }

  const places = viewer.state.places
    .filter((p) => p.kind === "PHASE")
    .map((p) => (p.under ? `${p.under} · ${p.name}` : p.name));

  return (
    <>
      <PageHead
        title={
          <>
            Lead <span className="em">pipeline</span>
          </>
        }
        meta="No leads yet. They appear here as they come in."
        action={importPortal}
      />
      {tabs}
      <LeadBoard
        live
        leads={[]}
        places={places}
        today={today}
        team={owners.map((p) => p.name)}
        needsOnly={needsOnly}
        canMove={viewer.authz.can("lead:update")}
      />
    </>
  );
}
