import Link from "next/link";
import { availabilityForLead } from "@/lib/inventory";
import { crmStateForLead } from "@/lib/crm-sync";
import { crmLabel } from "@/lib/crm-rules";
import "./lead-crm.css";

/**
 * Two lines on a lead's card: how many flats of what the buyer asked for are
 * still for sale in their tower, and where the lead stands in the CRM. Each
 * shows only when there is something true to say: no inventory recorded, or
 * no CRM connected, and the line is not there.
 */
export async function LeadCrmRows({
  orgId,
  leadId,
  towerId,
  config,
  mayReadInventory,
}: {
  orgId: string;
  leadId: string;
  towerId: string;
  config: string | null;
  mayReadInventory: boolean;
}) {
  const [avail, crm] = await Promise.all([
    mayReadInventory ? availabilityForLead(orgId, towerId, config) : Promise.resolve(null),
    crmStateForLead(orgId, leadId),
  ]);
  const left = avail
    ? avail.label
      ? `${avail.label}: ${avail.available.toLocaleString("en-IN")} of ${avail.total.toLocaleString("en-IN")} left`
      : `${avail.all.reduce((n, a) => n + a.available, 0).toLocaleString("en-IN")} flats left`
    : null;
  const label = crm ? crmLabel(crm.provider) : null;
  const crmText = crm
    ? { linked: `In ${label}`, queued: `Going to ${label}`, waiting: `Waiting on a match to go to ${label}`, refused: `${label} refused it`, removed: `Removed in ${label}` }[crm.state]
    : null;

  return (
    <>
      {left && (
        <div>
          <dt>Availability</dt>
          <dd>
            <Link href={`/dashboard/leads/availability?tower=${towerId}`} className="ld-link tnum" data-lead-availability>
              {left}
            </Link>
          </dd>
        </div>
      )}
      {crmText && (
        <div>
          <dt>CRM</dt>
          <dd data-lead-crm={crm!.state}>
            <span className={`pill ${crm!.state === "refused" ? "pill--risk" : crm!.state === "waiting" ? "pill--warn" : "pill--quiet"}`}>{crmText}</span>
            {crm!.note && <small className="ld-crm-why">{crm!.note}</small>}
          </dd>
        </div>
      )}
    </>
  );
}
