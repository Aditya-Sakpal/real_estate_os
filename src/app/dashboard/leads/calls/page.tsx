import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listCalls } from "@/lib/calling";
import { lensFor } from "@/lib/mask";
import { after } from "next/server";
import { settleCallsSoon } from "@/lib/lead-engine";
import { CallHistory } from "./CallHistory";

/**
 * Every call the AI agent made, newest first.
 *
 * Real calls come from the calls table. Until the first one exists the log
 * is empty: a client's console holds only its own data.
 *
 * "Today" and "now" are fixed on the server, in Asia/Kolkata, so a browser in
 * another timezone does not disagree with the page about which calls were today.
 */
export default async function CallsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:read")) redirect("/dashboard");

  const places = viewer.state.places
    .filter((p) => p.kind === "PHASE")
    .map((p) => (p.under ? `${p.under} · ${p.name}` : p.name));
  const phases = viewer.state.places
    .filter((p) => p.kind === "PHASE")
    .map((p) => ({ id: p.id, label: p.under ? `${p.under} · ${p.name}` : p.name }));
  const canCall = viewer.authz.can("lead:call") && viewer.authz.can("lead:create");
  // Only towers this person reads leads on, and every number as the policy
  // lets them see it: nothing whole leaves the server unless it may.
  // Without each call's turns: they are fetched when a call is opened.
  const real = await listCalls(
    viewer.state.org.id,
    { lens: await lensFor(viewer.state.org.id, viewer.authz), scopes: viewer.authz.scopesFor("lead:read") },
    1000,
    null,
    { transcripts: false },
  );
  // A call whose result never arrived is asked of Sarvam after the page is
  // sent; the log looks again every ten seconds while one is live.
  const orgId = viewer.state.org.id;
  after(() => settleCallsSoon(orgId));
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  return (
    <CallHistory
      today={today}
      nowIso={now.toISOString()}
      places={places}
      developer={viewer.state.org.displayName}
      real={real}
      phases={phases}
      canCall={canCall}
      availability={viewer.authz.can("inventory:read")}
      canExport={viewer.authz.can("lead:export")}
    />
  );
}
