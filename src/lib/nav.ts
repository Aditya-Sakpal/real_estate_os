import type { ReactNode } from "react";
import type { Authz } from "@/lib/rbac";

/**
 * Console navigation, derived from PERMISSIONS rather than role names.
 *
 * The earlier version listed role keys per item, which meant a tenant could
 * not change what a role reaches without a deploy, and a role a tenant
 * invented could reach nothing at all. Keying the rail to the same
 * permissions the server actions check keeps one source of truth: if the
 * sidebar shows it, the page will open, and if it does not, typing the URL
 * will not help either.
 *
 * Two groups: the work, then administration at the foot where a work tool
 * puts it. There used to be a third, "Not built yet", holding Site visits,
 * Partners and Reports. Somebody new opened them and found a page saying the
 * product had not built them. All three now open onto their screens (laid out
 * with sample data, and the screens say so), so they sit with the work in
 * the order a buyer moves through it: a lead, a visit, the partner who
 * brought them, and what it all cost at the end.
 */

export type NavKey =
  | "today"
  | "ask"
  | "agents"
  | "team"
  | "leads"
  | "desk"
  | "loans"
  | "visits"
  | "partners"
  | "developers"
  | "campaigns"
  | "library"
  | "projects"
  | "reports"
  | "settings";

/**
 * `work` is the primary navigation. A phone's tab bar carries the first
 * `TAB_BAR_MAX` of it that the viewer can reach, and the account menu carries
 * the rest along with administration.
 */
export type NavGroup = "work" | "admin";

/**
 * The ceiling a thumb reaches comfortably, and the ceiling every platform's
 * own guidance names.
 *
 * Counted per viewer, after the permission filter, rather than per group.
 * Site team holds Today and Site visits and nothing else in the work group;
 * a fixed list of five would have given them a tab bar of one, on the device
 * they do the whole job from.
 */
export const TAB_BAR_MAX = 5;

export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
  group: NavGroup;
  /**
   * Any one of these opens the item. Empty means everyone: the queue is the
   * one screen every member has, whatever they hold.
   */
  anyOf: string[];
  /**
   * The kinds of company that have this section. Absent means every kind.
   * A mandate firm has Mandates, where developers' offers and its
   * commission are; a developer appoints firms from Partners instead.
   */
  kinds?: string[];
  /** False keeps it off a phone's tab bar: looked at, not worked from. */
  tabBar?: false;
};

export const NAV: NavItem[] = [
  // --- the work ------------------------------------------------------------
  { key: "today", label: "Today", href: "/dashboard", group: "work", anyOf: [] },
  // Everyone may ask. What each person is told is decided per question by the
  // keys they hold (`ask-rules.ts`), so the item needs none of its own. Second,
  // because a question is how most people will reach the rest of the console.
  { key: "ask", label: "Ask Jimmy", href: "/dashboard/ask", group: "work", anyOf: [] },
  // The AI team: what each agent does, its voice, and which the plan carries.
  // Everyone sees it; locked agents stay on show so a team knows what is next.
  { key: "agents", label: "AI agents", href: "/dashboard/agents", group: "work", anyOf: [], tabBar: false },
  // The pipeline board. Its leads are sample data until the capture flow
  // exists, and the page says so; the stages and the rules for moving between
  // them are real, which is why it sits with the work rather than below it.
  { key: "leads", label: "Leads", href: "/dashboard/leads", group: "work", anyOf: ["lead:read"] },
  // Kept open by the sales team: it rings when a buyer is put through and
  // shows who they are before the phone is picked up. Off the tab bar: on a
  // phone the call itself is the screen.
  { key: "desk", label: "Call desk", href: "/dashboard/desk", group: "work", anyOf: ["lead:read"], tabBar: false },
  // The loan desk: every buyer's home loan, the banks the developer has tie-ups
  // with, and how the loans and the banks' money stand. Its own section, not a
  // view under Leads: a loan executive works loans all day, and the banks are
  // the developer's arrangements, not a lead's.
  {
    key: "loans",
    label: "Home loans",
    href: "/dashboard/loans",
    group: "work",
    anyOf: ["loan:update", "loan:manage"],
    tabBar: false,
  },
  // The day at the site. Before Projects because this is the section a
  // closing manager opens between visits, on a phone, and the tab bar keeps
  // the first five.
  {
    key: "visits",
    label: "Site visits",
    href: "/dashboard/visits",
    group: "work",
    anyOf: ["visit:read"],
  },
  // Firms, the buyers they registered, and what they are owed. Either key
  // opens it: a payout approver works the payouts and nothing else.
  {
    key: "partners",
    label: "Partners",
    href: "/dashboard/partners",
    group: "work",
    anyOf: ["partner:read", "payout:read", "mandate:manage"],
    // A channel partner is the partner here: its developers are in Developers.
    kinds: ["DEVELOPER", "MANDATE_FIRM"],
  },
  // A mandate firm's and a channel partner's own: every developer it sells
  // for. A firm's offers and commission; a partner's empanelments, the
  // buyers it registered with each developer, its links and posts, and its
  // brokerage. Everyone at the firm sees it; money is its own permission.
  {
    key: "developers",
    label: "Developers",
    href: "/dashboard/developers",
    group: "work",
    anyOf: [],
    kinds: ["MANDATE_FIRM", "CHANNEL_PARTNER"],
  },
  {
    key: "projects",
    label: "Projects",
    href: "/dashboard/projects",
    group: "work",
    anyOf: ["project:read", "rera:read"],
  },
  // The renders, plans, marks and prices a creative is assembled from. Its own
  // section rather than a page inside Campaigns: a campaign is one push, and
  // the library outlives every campaign that draws on it.
  // `unit:read` is in the list because the person who approves a price holds
  // it and holds no asset key at all. Without it the rail hid the section
  // from the only role that has to reach the configurations to sign them off.
  {
    key: "library",
    label: "Library",
    href: "/dashboard/library",
    group: "work",
    anyOf: ["asset:read", "brand:read", "unit:read"],
  },
  {
    key: "campaigns",
    label: "Campaigns",
    href: "/dashboard/campaigns",
    group: "work",
    anyOf: ["campaign:read"],
  },
  // What a booking cost. Last in the work, because it is read weekly rather
  // than worked daily. `audit:read` no longer opens it: every role holding
  // that key also holds this one, and the page shows reports, not the trail.
  {
    key: "reports",
    label: "Reports",
    href: "/dashboard/reports",
    group: "work",
    anyOf: ["report:read"],
  },

  // --- administration ------------------------------------------------------
  { key: "team", label: "Team", href: "/dashboard/team", group: "admin", anyOf: ["member:read"] },
  {
    key: "settings",
    label: "Settings",
    href: "/dashboard/settings",
    group: "admin",
    // Entities live under settings, so the permissions that open them belong
    // here too. The rail and the page have to agree, or one of them is lying.
    anyOf: [
      "org:read",
      "org:manage",
      "role:read",
      "role:manage",
      "integration:manage",
      "project:read",
      "project:create",
      // Connected accounts: whoever publishes or sets ad budgets needs to see
      // where posts go and each ad account's daily limit.
      "campaign:publish",
      "campaign.budget:manage",
      // Plan and usage.
      "billing:read",
      // The audit trail.
      "audit:read",
    ],
  },
];

export function navFor(authz: Authz, orgType = "DEVELOPER"): NavItem[] {
  return NAV.filter(
    (item) => (!item.kinds || item.kinds.includes(orgType)) && (item.anyOf.length === 0 || item.anyOf.some((p) => authz.can(p))),
  );
}

/** The items in one group, in declared order. */
export function inGroup(items: readonly NavItem[], group: NavGroup): NavItem[] {
  return items.filter((i) => i.group === group);
}

/** What a phone's tab bar carries: the first few of the work this viewer reaches. */
export function onTabBar(items: readonly NavItem[]): NavItem[] {
  return inGroup(items, "work").filter((i) => i.tabBar !== false).slice(0, TAB_BAR_MAX);
}

/** Everything else, which the account menu carries on a phone. */
export function offTabBar(items: readonly NavItem[]): NavItem[] {
  const bar = new Set(onTabBar(items).map((i) => i.key));
  return items.filter((i) => !bar.has(i.key));
}

/**
 * Which item a path is inside.
 *
 * The rail used to answer this with `pathname.startsWith(item.href)`, which
 * lit nothing for the six routes that do not live under their section's own
 * prefix: a Brain opens at `/dashboard/brain/...` and belongs to Projects, a
 * brief opens under Campaigns and its studio one level deeper again. A person
 * three screens into a task could not tell which section they were in.
 */
export function activeKey(pathname: string): NavKey | null {
  if (pathname === "/dashboard") return "today";
  if (pathname.startsWith("/dashboard/ask")) return "ask";
  if (pathname.startsWith("/dashboard/agents")) return "agents";
  if (pathname.startsWith("/dashboard/brain")) return "projects";
  if (pathname.startsWith("/dashboard/projects")) return "projects";
  if (pathname.startsWith("/dashboard/library")) return "library";
  if (pathname.startsWith("/dashboard/campaigns")) return "campaigns";
  if (pathname.startsWith("/dashboard/team")) return "team";
  if (pathname.startsWith("/dashboard/settings")) return "settings";
  if (pathname.startsWith("/dashboard/leads")) return "leads";
  if (pathname.startsWith("/dashboard/desk")) return "desk";
  if (pathname.startsWith("/dashboard/loans")) return "loans";
  if (pathname.startsWith("/dashboard/visits")) return "visits";
  if (pathname.startsWith("/dashboard/partners")) return "partners";
  if (pathname.startsWith("/dashboard/developers")) return "developers";
  if (pathname.startsWith("/dashboard/reports")) return "reports";
  return null;
}

/** A segment of the scope path, made navigable. `href` null means you are here. */
export type Crumb = { label: string; href: string | null };

/**
 * The trail from the organisation down to the screen you are on.
 *
 * The bar used to render the organisation name and then two buttons that
 * announced a menu and opened nothing, so three screens into a task the only
 * thing it said was which tenant you were in. Six routes carry a scope node in
 * the URL and none of them said whose tower it was.
 *
 * `placeName` resolves that id to a name; the caller has the list already, so
 * this stays pure and `check:logic` covers it. An id that resolves to nothing
 * is left out rather than printed raw: a uuid in a breadcrumb tells a sales
 * head nothing at all.
 */
export function crumbsFor(
  pathname: string,
  placeName: (id: string) => string | null,
): Crumb[] {
  const parts = pathname.split("/").filter(Boolean); // ["dashboard", ...]
  const rest = parts.slice(1);
  // The tenant is not in the trail. The switcher at the other end of the same
  // bar names it, and saying it twice made the bar read as two controls for
  // one thing.
  if (rest.length === 0) return [{ label: "Today", href: null }];

  const out: Crumb[] = [];
  const section = rest[0];

  const item = NAV.find((n) => n.href === `/dashboard/${section}`);
  // The Brain has no rail item of its own: it belongs to the project it
  // describes, which is where the trail puts it.
  const sectionLabel = item?.label ?? (section === "brain" ? "Projects" : null);
  if (!sectionLabel) return [{ label: "Today", href: null }];
  out.push({
    label: sectionLabel,
    href: section === "brain" ? "/dashboard/projects" : `/dashboard/${section}`,
  });

  for (let i = 1; i < rest.length; i++) {
    const seg = rest[i];
    // A campaign brief: /campaigns/brief/<id>/… — "Brief" opens that brief,
    // not the campaigns list. The id itself is never shown.
    if (seg === "brief" && rest[i + 1]) {
      const briefId = rest[i + 1];
      out.push({ label: "Brief", href: `/dashboard/campaigns/brief/${briefId}` });
      i += 1;
      continue;
    }
    const named = placeName(seg);
    if (named) {
      out.push({ label: named, href: `/${parts.slice(0, i + 2).join("/")}` });
      continue;
    }
    // A fixed segment is a word; anything else is an id nothing could name,
    // and a uuid printed in a breadcrumb is noise.
    const fixed: Record<string, string> = {
      branding: "Branding",
      entities: "Entities",
      roles: "Roles",
      brief: "Brief",
      studio: "Studio",
      schedule: "Schedule",
      queue: "Queue",
      occasions: "Occasions",
      calls: "Calls",
      availability: "Availability",
      banks: "Banks",
      reports: "Reports",
      crm: "CRM",
      connections: "Connected accounts",
      meta: "Meta",
      google: "Google",
      live: "Published",
      billing: "Plan and usage",
      "top-up": "Top up",
      invoices: "Invoices",
      auto: "Auto top-up",
      "phone-numbers": "Buyer phone numbers",
      audit: "Audit trail",
      sso: "Single sign-on",
      firm: "Your firm",
      buyers: "Registered buyers",
      payouts: "Brokerage",
      export: "Export",
    };
    if (fixed[seg]) out.push({ label: fixed[seg], href: null });
  }

  const last = out[out.length - 1];
  return [...out.slice(0, -1), { ...last, href: null }];
}

/**
 * Human-readable role for the top bar, used only where a resolved role
 * definition is not to hand. A tenant that renamed a role, or invented one,
 * has a label of its own and that always wins.
 */
export function roleLabel(role: string): string {
  const special: Record<string, string> = {
    ORG_ADMIN: "Org admin",
    CRE: "Customer relationship executive",
    CP_RELATIONSHIP_MANAGER: "CP relationship manager",
    RERA_COMPLIANCE_OFFICER: "RERA compliance officer",
  };
  if (special[role]) return special[role];

  const bare = role.startsWith("C_") ? role.slice(2) : role;
  const words = bare.toLowerCase().split("_").filter(Boolean);
  if (!words.length) return role;
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + " " + words.slice(1).join(" ");
}

export type IconMap = Record<NavKey, (p: { size?: number }) => ReactNode>;
