import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { todaysPasses } from "@/lib/checkin";
import { Scanner } from "./Scanner";
import "./scan.css";

/**
 * The gate: the site team's own phone scans the pass a buyer's confirmation
 * carried. Built for a basement with no signal: a scan made offline is kept
 * on the phone with its time and position and sent when the signal is back,
 * and today's names come down with the page so the screen can still say
 * whose pass it read.
 */
export const dynamic = "force-dynamic";

export default async function ScanPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("visit:confirm")) redirect("/dashboard/visits");

  const today = await todaysPasses(viewer.state.org.id, viewer.authz.scopesFor("visit:confirm"));
  return <Scanner owner={`${viewer.state.org.id}:${viewer.userId}`} today={today} />;
}
