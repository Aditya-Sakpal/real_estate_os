import { SubTabs } from "@/components/shell/SubTabs";
import { Building, Report, Wallet } from "@/components/icons";
import type { Authz } from "@/lib/rbac-rules";

/** The loan desk's three views: the loans, the banks, and how both stand. */
export function LoanTabs({ current, authz }: { current: string; authz: Pick<Authz, "can"> }) {
  const works = authz.can("loan:update");
  return (
    <SubTabs
      label="Home loans views"
      current={current}
      items={[
        ...(works ? [{ href: "/dashboard/loans", label: "Loans", icon: <Wallet size={15} /> }] : []),
        { href: "/dashboard/loans/banks", label: "Banks", icon: <Building size={15} /> },
        ...(works ? [{ href: "/dashboard/loans/reports", label: "Reports", icon: <Report size={15} /> }] : []),
      ]}
    />
  );
}
