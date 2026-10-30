import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { NavProgress } from "@/components/shell/NavProgress";
import { Rail } from "@/components/shell/Rail";
import { TopBar } from "@/components/shell/TopBar";
import { TableStack } from "@/components/shell/TableStack";
import { offTabBar } from "@/lib/nav";
import "./layout-kit.css";

export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");

  const { state } = viewer;
  // Towers, not projects: Today lists each blocked tower, and the two counts
  // have to agree ("2 blocked" beside three towers on Today read as a bug).
  const blocked = state.readiness.filter((p) => p.blocked).length;

  // A phone's tab bar keeps the first five of the work, so the rest has to be
  // reachable from the bar or it is not reachable at all.
  const secondary = offTabBar(viewer.nav);

  return (
    <div className="shell">
      {/* First stop for a keyboard, and the only way past a rail of ten links
          on every page. Visible on focus, never otherwise. */}
      <a href="#main" className="skip">
        Skip to the page
      </a>

      <Suspense fallback={null}>
        <NavProgress />
      </Suspense>

      <Rail
        items={viewer.nav}
        queueCount={state.queue.length}
        orgName={state.org.legalName}
      />
      <TopBar
        initials={viewer.initials}
        email={viewer.email}
        roleLabel={viewer.primaryRoleLabel}
        blockedCount={blocked}
        orgs={viewer.orgs}
        currentOrgId={state.org.id}
        places={state.places}
        secondary={secondary}
        viaFirm={viewer.via?.firmName}
        viaFirmId={viewer.via?.firmOrgId}
      />
      <main className="main" id="main" tabIndex={-1}>
        <div className="wrap">{children}</div>
      </main>
      <TableStack />
    </div>
  );
}
