import { sellsForOthers } from "@/lib/mandate-rules";
import type { getViewer } from "@/lib/console";
import type { SectionGroup, SectionIcon } from "@/components/shell/SectionFrame";

type Viewer = NonNullable<Awaited<ReturnType<typeof getViewer>>>;

export type SettingsItem = {
  key: string;
  label: string;
  href: string;
  /** One line under the label on the overview. What is there, never why. */
  line: string;
  icon: SectionIcon;
};

export type SettingsGroup = { key: string; label: string; items: SettingsItem[] };

/**
 * Every settings screen, grouped the way a person looks for them, and only
 * the ones this viewer may open. The overview and the side list both read
 * this, so the two can never offer different screens.
 */
export function settingsGroups(viewer: Viewer): SettingsGroup[] {
  const can = (p: string) => viewer.authz.can(p);
  const atRoot = (p: string) => viewer.authz.canAt(p, viewer.state.rootPath);
  const firm = sellsForOthers(viewer.orgType);

  const company: SettingsItem[] = [];
  if (firm && (can("org:read") || can("org:manage")))
    company.push({ key: "firm", label: "Your firm", href: "/dashboard/settings/firm", icon: "Building",
      line: "Your MahaRERA agent number, city and phone." });
  if (can("project:read") || can("project:create"))
    company.push({ key: "entities", label: firm ? "Developers’ legal details" : "Legal entities",
      href: "/dashboard/settings/entities", icon: "Building",
      line: firm ? "Each developer company, named as on its RERA registration." : "The companies that register your projects." });
  if (can("billing:read"))
    company.push({ key: "billing", label: "Plan and usage", href: "/dashboard/settings/billing", icon: "Wallet",
      line: "Each project’s plan, what is left this month, top-ups and invoices." });
  if (atRoot("audit:read"))
    company.push({ key: "audit", label: "Audit trail", href: "/dashboard/settings/audit", icon: "Receipt",
      line: "Who did what, and when." });

  const people: SettingsItem[] = [];
  if (can("role:read"))
    people.push({ key: "roles", label: "Roles and permissions", href: "/dashboard/settings/roles", icon: "Shield",
      line: "What each role may do. Change one or write your own." });
  if (atRoot("org:manage"))
    people.push({ key: "sso", label: "Single sign-on", href: "/dashboard/settings/sso", icon: "Shield",
      line: "Sign in through Okta, Entra ID or another SAML provider." });
  if (can("org:read"))
    people.push({ key: "phone-numbers", label: "Buyer phone numbers", href: "/dashboard/settings/phone-numbers", icon: "Team",
      line: "What each role sees of a buyer’s number and email." });

  const calls: SettingsItem[] = [];
  if (can("org:manage"))
    calls.push({ key: "calling", label: "Calling and sales team", href: "/dashboard/settings/calling", icon: "Phone",
      line: "Calling rules, who takes ready buyers, where leads come in." });
  if (can("integration:manage"))
    calls.push({ key: "calling-numbers", label: "Calling numbers", href: "/dashboard/settings/calling-numbers", icon: "Phone",
      line: "The numbers buyers see when you or the AI call." });
  if (can("org:manage"))
    calls.push({ key: "leads", label: "Lead rules", href: "/dashboard/settings/leads", icon: "Campaign",
      line: "Returning buyers, hot and warm scores, NRI desk, home-loan partners." });

  const accounts: SettingsItem[] = [];
  if (["integration:manage", "campaign:publish", "campaign.budget:manage"].some(can))
    accounts.push({ key: "connections", label: "Connected accounts", href: "/dashboard/settings/connections", icon: "Chat",
      line: "Meta, Google, CRM, WhatsApp and SMS." });
  if (can("integration:manage"))
    accounts.push({ key: "payments", label: "Token payments", href: "/dashboard/settings/payments", icon: "Wallet",
      line: "The Razorpay account a buyer pays their token into." });

  return [
    { key: "company", label: firm ? "Your firm" : "Your company", items: company },
    { key: "people", label: "People and access", items: people },
    { key: "calls", label: "Calls and leads", items: calls },
    { key: "accounts", label: "Accounts and payments", items: accounts },
  ].filter((g) => g.items.length > 0);
}

/** The same list, as the frame beside every settings screen draws it. */
export function settingsNav(groups: SettingsGroup[]): SectionGroup[] {
  return [
    { key: "home", items: [{ key: "overview", label: "Overview", href: "/dashboard/settings", icon: "Settings" }] },
    ...groups.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.map(({ key, label, href, icon }) => ({ key, label, href, icon })),
    })),
  ];
}
