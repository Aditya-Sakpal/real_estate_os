import { SubTabs } from "@/components/shell/SubTabs";
import { Clock, Plus, Receipt, Wallet } from "@/components/icons";

const BASE = "/dashboard/settings/billing";

/** Plan and usage, Top up, Auto top-up and Invoices: one section, four views. Top up only for whoever may buy. */
export function BillingTabs({ current, canManage }: { current: "usage" | "top-up" | "auto" | "invoices"; canManage: boolean }) {
  const items = [
    { href: BASE, label: "Plan and usage", icon: <Wallet size={15} /> },
    ...(canManage ? [{ href: `${BASE}/top-up`, label: "Top up", icon: <Plus size={15} /> }] : []),
    { href: `${BASE}/auto`, label: "Auto top-up", icon: <Clock size={15} /> },
    { href: `${BASE}/invoices`, label: "Invoices", icon: <Receipt size={15} /> },
  ];
  const href = current === "usage" ? BASE : `${BASE}/${current}`;
  return <SubTabs label="Billing views" current={href} items={items} />;
}
