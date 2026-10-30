import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { WEEKS, mondayOf } from "@/lib/report-sample";
import { addDays } from "@/lib/lead-rules";
import { realReport } from "@/lib/lead-report";
import { ReportView } from "./ReportView";

/**
 * What a booking cost, and where the next rupee should go.
 *
 * Built from the tenant's own leads, calls, visits and bookings, and the ad
 * platforms' daily spend, inside the subtrees the viewer may read reports
 * for. A tenant with no leads yet sees its own empty figures, never invented
 * ones: a client's console holds only its own data.
 */
export default async function ReportsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("report:read")) redirect("/dashboard");

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const real = await realReport(viewer.state.org.id, today, viewer.authz.scopesFor("report:read"));

  // No leads yet: the same screen, every figure zero, on the tenant's own projects.
  const thisWeek = mondayOf(today);
  const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(thisWeek, -7 * (WEEKS - 1 - i)));
  const data = real ?? { weeks, rows: [], cohorts: weeks.map((week) => ({ week, leads: 0, eventual: 0 })) };
  const projects = real
    ? [...new Set(real.rows.map((r) => r.project))].sort((a, b) => a.localeCompare(b))
    : [...new Set(viewer.state.places.filter((p) => p.kind === "PHASE").map((p) => p.under ?? p.name))];
  return <ReportView today={today} projects={projects} real={data} />;
}
