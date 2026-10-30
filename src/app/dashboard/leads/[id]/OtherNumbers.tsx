import { otherNumbers } from "@/lib/lead-phones";
import { OTHER_NUMBER_LABEL } from "@/lib/partner-rules";
import type { LeadAt, Lens } from "@/lib/mask-rules";
import { AddOtherNumber, RemoveOtherNumber } from "./OtherNumberForm";

/**
 * A co-applicant's or alternate number on the lead, one row each, shown
 * through the viewer's lens like the lead's own number. A partner's
 * registration on any of them counts when the buyer books.
 */
export async function OtherNumbers({
  orgId,
  leadId,
  lens,
  at,
  canUpdate,
}: {
  orgId: string;
  leadId: string;
  lens: Lens;
  at: LeadAt;
  canUpdate: boolean;
}) {
  const rows = await otherNumbers(orgId, leadId);
  if (!rows.length && !canUpdate) return null;
  return (
    <>
      {rows.map((r) => {
        const shown = lens.phone(r.phone, at);
        return (
          <div key={r.id}>
            <dt>{OTHER_NUMBER_LABEL[r.kind]}</dt>
            <dd>
              <span className="tnum">{shown.text || "Hidden"}</span>
              {canUpdate && <RemoveOtherNumber leadId={leadId} id={r.id} />}
            </dd>
          </div>
        );
      })}
      {canUpdate && (
        <div>
          <dt>Other numbers</dt>
          <dd>
            <AddOtherNumber leadId={leadId} />
          </dd>
        </div>
      )}
    </>
  );
}
