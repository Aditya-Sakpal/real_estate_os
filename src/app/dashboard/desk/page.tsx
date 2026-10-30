import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { deskFeed } from "@/lib/call-desk";
import { lensFor } from "@/lib/mask";
import { CallDesk } from "./CallDesk";
import "./desk.css";

/**
 * The call desk: kept open by a sales person, it rings the moment a buyer is
 * put through to the team (the AI handing a call over, a hot buyer bridged,
 * a buyer ringing the developer's own number) and shows who they are and what
 * the AI already heard, so the phone is picked up knowing the buyer.
 */
export default async function DeskPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:read")) redirect("/dashboard");
  const orgId = viewer.state.org.id;
  const initial = await deskFeed({ orgId, userId: viewer.userId, authz: viewer.authz, lens: () => lensFor(orgId, viewer.authz) });
  return <CallDesk initial={initial} />;
}
