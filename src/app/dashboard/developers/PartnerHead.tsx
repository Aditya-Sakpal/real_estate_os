import Link from "next/link";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight } from "@/components/icons";

export type PartnerTab = "projects" | "buyers" | "payouts";

/**
 * A channel partner's Developers: one header over three views. The
 * projects it is empanelled on with its links and posts, the buyers it
 * registered with each developer, and the brokerage each booking owes it.
 */
export function PartnerHead({
  current,
  meta,
  counts,
  seesMoney,
  canRegister,
}: {
  current: PartnerTab;
  meta: string;
  counts: { buyers: number; toInvoice: number };
  seesMoney: boolean;
  canRegister: boolean;
}) {
  // `short` is the label on a phone, so all three tabs fit the width
  // ("Projects", "Buyers", "Brokerage") and none sits off the edge.
  const tab = (key: PartnerTab, href: string, label: string, note?: string, short?: string) => (
    <Link key={key} href={href} className="subtabs__tab" aria-current={current === key ? "page" : undefined}>
      {short ? (
        <>
          <span className="dv-tab-long">{label}</span>
          <span className="dv-tab-short">{short}</span>
        </>
      ) : (
        label
      )}
      {note ? <span className="pt-tabs__n tnum">{note}</span> : null}
    </Link>
  );
  return (
    <>
      <PageHead
        title={
          <>
            Developers you <span className="em">sell</span> for
          </>
        }
        meta={meta}
        action={
          canRegister ? (
            <Link href="/dashboard/developers/buyers?register=1" className="btn btn--ink">
              Register a buyer
              <ArrowUpRight size={14} />
            </Link>
          ) : null
        }
      />
      <div className="subtabs">
        <nav className="subtabs__nav" aria-label="Developers">
          {tab("projects", "/dashboard/developers", "Projects and links", undefined, "Projects")}
          {tab("buyers", "/dashboard/developers/buyers", "Registered buyers", counts.buyers ? String(counts.buyers) : undefined, "Buyers")}
          {seesMoney && tab("payouts", "/dashboard/developers/payouts", "Brokerage", counts.toInvoice ? `${counts.toInvoice} to invoice` : undefined)}
        </nav>
      </div>
    </>
  );
}
