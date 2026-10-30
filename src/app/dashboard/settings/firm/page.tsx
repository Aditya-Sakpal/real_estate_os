import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { withTenant } from "@/lib/db";
import { longDay, sellsForOthers } from "@/lib/mandate-rules";
import { showPhone } from "@/lib/call-rules";
import { PageHead } from "@/components/shell/PageHead";
import { ProfileCard } from "@/app/workspace/Forms";
import "@/app/workspace/workspace.css";

/**
 * A mandate firm's own record: the MahaRERA agent registration it sells
 * under, its city and phone. The legal name, PAN and GSTIN it signed up
 * with are shown, never edited here.
 */
export default async function FirmPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!sellsForOthers(viewer.orgType) || viewer.via || !(viewer.authz.can("org:read") || viewer.authz.can("org:manage"))) redirect("/dashboard/settings");

  const orgId = viewer.state.org.id;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [p] = await withTenant(orgId, (sql) => sql<{ rera_agent_no: string; rera_valid_till: Date | null; city: string | null; phone: string | null }[]>`
    SELECT rera_agent_no, rera_valid_till, city, phone FROM firm_profiles WHERE org_id = ${orgId}`);
  // A date column comes back as midnight UTC, so its own day is the date.
  const till = p?.rera_valid_till ? p.rera_valid_till.toISOString().slice(0, 10) : null;
  const org = viewer.state.org;
  // A channel partner's number was proved at sign-up, so it is not changed from here.
  const partner = viewer.orgType === "CHANNEL_PARTNER";

  const facts = (
    <dl className="fw-facts">
      <div>
        <dt>Registered name</dt>
        <dd>{org.legalName}</dd>
      </div>
      <div>
        <dt>PAN</dt>
        <dd className="pt-mono">{org.pan}</dd>
      </div>
      <div>
        <dt>GSTIN</dt>
        <dd className={org.gstin ? "pt-mono" : undefined}>{org.gstin ?? "Not registered"}</dd>
      </div>
      <div>
        <dt>MahaRERA agent number</dt>
        <dd className="pt-mono">{p?.rera_agent_no ?? "Not on file"}</dd>
      </div>
      <div>
        <dt>Registration valid until</dt>
        <dd>
          {till ? longDay(till) : "Not on file"}
          {till && till < today ? (
            <span className="pill pill--risk" style={{ marginLeft: 8 }}>
              Lapsed
            </span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>{partner ? "WhatsApp number" : "Phone number"}</dt>
        <dd className="tnum">{p?.phone ? showPhone(p.phone) : "Not on file"}</dd>
      </div>
      <div>
        <dt>City</dt>
        <dd>{p?.city ?? "Not on file"}</dd>
      </div>
    </dl>
  );

  return (
    <>
      <PageHead
        back={{ label: "Settings", href: "/dashboard/settings" }}
        title={
          <>
            Your <span className="em">firm</span>
          </>
        }
        meta={org.displayName}
      />
      <ProfileCard
        facts={facts}
        values={{ reraNo: p?.rera_agent_no ?? "", reraTill: till ?? "", city: p?.city ?? "", phone: p?.phone ? showPhone(p.phone) : "" }}
        canEdit={viewer.authz.can("org:manage")}
        phoneFixed={partner}
        phoneLabel={partner ? "WhatsApp number" : "Phone number"}
        today={today}
      />
    </>
  );
}
