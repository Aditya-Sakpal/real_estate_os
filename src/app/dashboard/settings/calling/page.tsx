import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listTeam, minutesUsed, optOutCount, policyAt } from "@/lib/calling";
import { hasPlan } from "@/lib/billing";
import { captureEndpoint, orgCaptureKey } from "@/lib/capture";
import { listConnections } from "@/lib/connect";
import { sarvamConfig } from "@/lib/sarvam";
import { whatsappConnected } from "@/lib/wa-numbers";
import { CallingForm } from "./CallingForm";
import { LeadCapture, type MetaLeadForms, type TowerAddress } from "./LeadCapture";
import { SalesTeam } from "./SalesTeam";
import "./calling.css";

/**
 * The client's calling rules: consent, the two things the agent says first,
 * and where a qualified buyer is handed to a person. Under them, what runs by
 * itself, whether calls and WhatsApp are switched on, and where leads arrive.
 */
export default async function CallingSettingsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("org:manage")) redirect("/dashboard/settings");
  const orgId = viewer.state.org.id;

  const [policy, optOuts, usage, connections, team, whatsappOn, planned] = await Promise.all([
    policyAt(orgId, null),
    optOutCount(orgId),
    minutesUsed(orgId),
    listConnections(orgId),
    listTeam(orgId),
    whatsappConnected(orgId),
    hasPlan(orgId),
  ]);

  const month = new Date().toLocaleString("en-IN", { month: "long", timeZone: "Asia/Kolkata" });
  const callsOn = sarvamConfig().ok;

  // A key derived from the session secret, and an address only when this
  // server has a public one. Either missing, the card says so.
  let towers: TowerAddress[] | null = null;
  let googleKey: string | null = null;
  try {
    googleKey = orgCaptureKey(orgId);
    if (captureEndpoint(orgId)) {
      towers = viewer.state.places
        .filter((p) => p.kind === "PHASE")
        .map((p) => ({
          id: p.id,
          label: p.under ? `${p.under} · ${p.name}` : p.name,
          url: captureEndpoint(orgId, p.id) ?? "",
        }))
        .filter((t) => t.url);
    }
  } catch {
    towers = null;
    googleKey = null;
  }

  const metaConnection = connections.find((c) => c.provider === "META");
  const meta: MetaLeadForms = metaConnection
    ? {
        connected: true,
        broken: metaConnection.health === "broken" || metaConnection.health === "expired",
        pages: metaConnection.accounts
          .filter((a) => a.kind === "FACEBOOK_PAGE" && a.active)
          .map((a) => ({ id: a.id, name: a.name, leadForms: a.leadForms })),
      }
    : { connected: false };

  return (
    <div className="cs-board">
      <CallingForm policy={policy} optOuts={optOuts} usage={usage} month={month} planned={planned} />

      <SalesTeam team={team} fallback={policy.handoffNumber} />

      <section className="card cs cset" aria-labelledby="channels-title" data-channels>
        <div className="cset__head">
          <h2 id="channels-title">Channels</h2>
        </div>
        <Channel name="AI calls" on={callsOn} off="No call goes out, by hand or automatically." />
        <Channel name="WhatsApp" on={whatsappOn} off="No message goes out to a lead." />
      </section>

      <LeadCapture
        towers={towers}
        googleKey={googleKey}
        meta={meta}
        canConnect={viewer.authz.can("integration:manage")}
      />
    </div>
  );
}

function Channel({ name, on, off }: { name: string; on: boolean; off: string }) {
  return (
    <div className="cs-row" data-channel={name}>
      <div>
        <p className="cs-row__name">{name}</p>
        {!on && <p className="cs-row__sub">{off}</p>}
      </div>
      <span className={`pill ${on ? "pill--ok" : "pill--warn"}`}>
        <span className="pill__dot" />
        {on ? "Switched on" : "Not switched on"}
      </span>
    </div>
  );
}
