/**
 * The permission catalog.
 *
 * Permissions are `resource:action`, and code checks a PERMISSION, never a
 * role name. That single rule is what lets a role become an editable bundle
 * of permissions rather than a hardcoded branch: a tenant can rename roles,
 * retune them, or invent their own, and not one call site changes.
 *
 * The catalog itself stays in code, because a permission only means something
 * where a check exists. Inventing `lead.phone:unmask` at runtime would grant
 * nothing, since no code would be asking for it.
 */

export type PermissionGroupKey =
  | "leads"
  | "visits"
  | "partners"
  | "campaigns"
  | "brain"
  | "projects"
  | "team"
  | "reports"
  | "settings";

export type PermissionDef = {
  key: string;
  group: PermissionGroupKey;
  label: string;
  /** What granting it actually lets a person do, in the admin's language. */
  detail: string;
  /**
   * Carries real risk: buyer privacy, money, regulatory exposure, or the
   * ability to widen someone else's access. The role editor calls these out
   * rather than burying them among forty identical checkboxes.
   */
  sensitive?: boolean;
  /**
   * The capability itself is specified but not built yet: nothing in code
   * asks for this key. The role editor hides it, and keeps it on a role that
   * already holds it. Take the flag off the day a check starts asking.
   */
  future?: boolean;
};

export const PERMISSION_GROUPS: {
  key: PermissionGroupKey;
  label: string;
  detail: string;
}[] = [
  { key: "leads", label: "Leads and buyers", detail: "Buyer records, their stage, and their phone numbers." },
  { key: "visits", label: "Site visits", detail: "Slots, confirmations, and what happened on site." },
  { key: "partners", label: "Channel partners", detail: "Empanelment, tagging and payouts." },
  { key: "campaigns", label: "Campaigns and creative", detail: "Generation, approval and publishing to ad platforms." },
  { key: "brain", label: "Project Brain", detail: "The signed facts every quote, reply and creative is built from." },
  { key: "projects", label: "Projects and RERA", detail: "The scope tree, and each phase's registration record." },
  { key: "team", label: "People and roles", detail: "Who is in the organisation, and what they may do." },
  { key: "reports", label: "Reporting", detail: "Attribution, cost per booking, and the audit trail." },
  { key: "settings", label: "Organisation settings", detail: "Company details and connected accounts." },
];

export const PERMISSIONS: PermissionDef[] = [
  // --- leads ---------------------------------------------------------------
  {
    key: "lead:read",
    group: "leads",
    label: "See leads",
    detail: "View the lead list and any single lead, within your scope.",
  },
  {
    key: "lead:create",
    group: "leads",
    label: "Add leads",
    detail: "Enter a lead by hand, outside the ad and portal feeds.",
  },
  {
    key: "lead:update",
    group: "leads",
    label: "Edit leads",
    detail: "Change lead details and move a lead through its stages.",
  },
  {
    key: "lead:assign",
    group: "leads",
    label: "Assign leads",
    detail: "Route a lead to a specific person.",
    future: true,
  },
  {
    key: "lead:call",
    group: "leads",
    label: "Call a lead",
    detail: "Call a lead: the AI agent, or yourself from your own phone through our number. Every call is logged.",
  },
  {
    key: "lead.phone:unmask",
    group: "leads",
    label: "See real phone numbers",
    detail:
      "Reveal a buyer's number instead of 98XXXXXX21. Each reveal is written to the audit log.",
    sensitive: true,
  },
  {
    key: "lead:export",
    group: "leads",
    label: "Export leads",
    detail:
      "Download leads as a file. Numbers in it are masked or hidden exactly as they are on screen.",
    sensitive: true,
  },
  {
    key: "lead:erase",
    group: "leads",
    label: "Erase a buyer's data",
    detail:
      "Erase a buyer's name, number and what they said, when they ask. It cannot be undone, and they are never contacted again.",
    sensitive: true,
  },
  {
    key: "loan:update",
    group: "leads",
    label: "Update home loans",
    detail: "Record where a buyer's home loan stands: documents, applied, sanctioned, disbursed or rejected.",
  },
  {
    key: "loan:manage",
    group: "leads",
    label: "Manage bank tie-ups",
    detail: "Add the banks buyers are introduced to, their offers, and the projects each has approved.",
  },

  // --- inventory -----------------------------------------------------------
  //
  // One flat and whether it is still for sale, apart from `unit:read`, which
  // is the signed product a marketing team advertises. Availability is what a
  // sales person quotes on a call and is true for about an hour, so it sits
  // with the leads and is never printed on anything.
  {
    key: "inventory:read",
    group: "leads",
    label: "See availability",
    detail: "Which flats in a tower are available, blocked or booked.",
  },
  {
    key: "inventory:manage",
    group: "leads",
    label: "Update availability",
    detail: "Import a tower's availability sheet.",
  },
  {
    key: "quote:create",
    group: "leads",
    label: "Draft quotes",
    detail: "Draft a buyer's quote for a flat, worked out from the approved price and the taxes.",
  },
  {
    key: "quote:approve",
    group: "leads",
    label: "Approve quotes and send token links",
    detail: "Approve a quote, block the flat and send the buyer a link to pay the token.",
    sensitive: true,
  },

  // --- visits --------------------------------------------------------------
  {
    key: "visit:read",
    group: "visits",
    label: "See site visits",
    detail: "View the visit calendar and each booking.",
  },
  {
    key: "visit:schedule",
    group: "visits",
    label: "Schedule visits",
    detail: "Book a buyer into a slot and send the confirmation.",
  },
  {
    key: "visit:confirm",
    group: "visits",
    label: "Confirm arrivals",
    detail: "Mark a buyer as arrived on site.",
  },
  {
    key: "visit:outcome",
    group: "visits",
    label: "Record visit outcomes",
    detail: "Log what happened, including a no-show.",
  },
  {
    key: "visit:manage",
    group: "visits",
    label: "Set gallery capacity",
    detail: "How many visits a project's gallery can host in an hour, on weekdays and at the weekend.",
  },

  // --- partners ------------------------------------------------------------
  {
    key: "partner:read",
    group: "partners",
    label: "See partners",
    detail: "View empanelled channel partners and the leads they have tagged.",
  },
  {
    key: "partner:empanel",
    group: "partners",
    label: "Empanel partners",
    detail:
      "Add a channel partner firm to a project, renew it, and set a project's commission terms.",
    sensitive: true,
  },
  {
    key: "partner:suspend",
    group: "partners",
    label: "Suspend partners",
    detail: "Cut a partner's access immediately, mid-cycle.",
    sensitive: true,
  },
  {
    key: "partner:register",
    group: "partners",
    label: "Register buyers for partners",
    detail: "Register a buyer on a partner's behalf, and file a partner's invoice.",
  },
  {
    key: "payout:read",
    group: "partners",
    label: "See payouts",
    detail: "View commission milestones and what is owed.",
  },
  {
    key: "payout:approve",
    group: "partners",
    label: "Approve payouts",
    detail:
      "Check a partner's invoice and release commission. On a Rs 1.25 Cr booking at 2 percent that is Rs 2.5 lakh.",
    sensitive: true,
  },
  {
    key: "payout:pay",
    group: "partners",
    label: "Record payments",
    detail: "Mark an approved payout as paid, with the bank's UTR.",
    sensitive: true,
  },
  {
    key: "mandate:manage",
    group: "partners",
    label: "Appoint mandate firms",
    detail: "Offer a mandate firm a project at a commission, renew it, and end it.",
    sensitive: true,
  },

  // --- campaigns -----------------------------------------------------------
  {
    key: "campaign:read",
    group: "campaigns",
    label: "See campaigns",
    detail: "View campaign briefs, and how a campaign is performing.",
  },
  {
    key: "campaign:create",
    group: "campaigns",
    label: "Build campaigns",
    detail: "Write the brief for a campaign, and mark it ready to run.",
  },
  {
    key: "creative:approve",
    group: "campaigns",
    label: "Approve creative",
    detail:
      "Sign off a scheduled post as fit to run, and stop a schedule that should not be running.",
    sensitive: true,
  },
  {
    key: "campaign:publish",
    group: "campaigns",
    label: "Publish campaigns",
    detail:
      "Post to Facebook, Instagram and Business Profile, and create ads paused. Blocked unless the phase RERA registration is verified or exempt.",
    sensitive: true,
  },
  {
    key: "campaign.budget:manage",
    group: "campaigns",
    label: "Manage ad budget",
    detail: "Set each ad account's daily limit, and switch an ad's spend on.",
    sensitive: true,
  },

  // --- project brain -------------------------------------------------------
  //
  // Three approve keys rather than one, because the three signatures are
  // three different jobs: what a unit costs, what the authority registered,
  // and what may be claimed about the building. One key would let whoever
  // holds it sign all three, which is the arrangement the split exists to
  // prevent.
  {
    key: "brain:read",
    group: "brain",
    label: "See the Project Brain",
    detail: "View the signed facts for a project or phase, and their history.",
  },
  {
    key: "brain:edit",
    group: "brain",
    label: "Edit the draft",
    detail:
      "Change facts in the working draft. A draft is invisible to every surface that quotes, so editing publishes nothing.",
  },
  {
    key: "brain.price:approve",
    group: "brain",
    label: "Sign off price",
    detail: "Sign the price and payment facts. A quote is generated from these.",
    sensitive: true,
  },
  {
    key: "brain.rera:approve",
    group: "brain",
    label: "Sign off RERA facts",
    detail:
      "Sign the registration number, QR and declared completion date that go on every advertisement.",
    sensitive: true,
  },
  {
    key: "brain.claims:approve",
    group: "brain",
    label: "Sign off claims",
    detail:
      "Sign what may be said about the building, and the never-say list.",
    sensitive: true,
  },
  {
    key: "brain:publish",
    group: "brain",
    label: "Publish a version",
    detail:
      "Make a signed draft the live version. Refused unless every changed group is signed and the phase is advertisable.",
    sensitive: true,
  },

  // --- projects ------------------------------------------------------------
  {
    key: "project:read",
    group: "projects",
    label: "See projects",
    detail: "View entities, projects and their phases.",
  },
  {
    key: "project:create",
    group: "projects",
    label: "Create projects",
    detail: "Add an entity, a project or a phase.",
  },
  {
    key: "phase:create",
    group: "projects",
    label: "Create phases",
    detail: "Add a phase or tower. Each phase is its own RERA registration.",
    future: true,
  },
  {
    key: "rera:read",
    group: "projects",
    label: "See RERA records",
    detail: "View each phase's registration number, validity and verification status.",
  },
  {
    key: "rera:manage",
    group: "projects",
    label: "Manage RERA records",
    detail:
      "Enter and update registration details. This is what unlocks advertising for a phase.",
    sensitive: true,
  },

  // --- team ----------------------------------------------------------------
  {
    key: "member:read",
    group: "team",
    label: "See the team",
    detail: "View who is in the organisation and the role each person holds.",
  },
  {
    key: "member:invite",
    group: "team",
    label: "Add people",
    detail: "Invite someone, and approve or decline a request to join.",
  },
  {
    key: "member:role",
    group: "team",
    label: "Change someone's role",
    detail:
      "Move an existing member to a different role, including handing over the admin role. Separate from adding people, because it can widen what somebody already inside can do.",
    sensitive: true,
  },
  {
    key: "member:remove",
    group: "team",
    label: "Remove people",
    detail: "Revoke a membership and cut that person's access.",
    sensitive: true,
  },
  {
    key: "role:read",
    group: "team",
    label: "See roles",
    detail: "View each role and the permissions it carries.",
  },
  {
    key: "role:manage",
    group: "team",
    label: "Edit roles",
    detail:
      "Retune a role's permissions, and create roles of your own. This can widen what other people may do.",
    sensitive: true,
  },

  // --- reports -------------------------------------------------------------
  {
    key: "report:read",
    group: "reports",
    label: "See reports",
    detail: "Cost per booking, funnel conversion and campaign attribution, as aggregates.",
  },
  {
    key: "report.pii:read",
    group: "reports",
    label: "See buyer identities in reports",
    detail:
      "Drill from an aggregate down to named buyers. Without this, reports stay anonymous.",
    sensitive: true,
    future: true,
  },
  {
    key: "audit:read",
    group: "reports",
    label: "See the audit trail",
    detail: "Read the append-only log of who did what.",
  },

  // --- assets --------------------------------------------------------------
  //
  // `asset:approve` is its own key and it sits beside `brain.claims:approve`,
  // because what the building looks like and what may be claimed about it are
  // the same job. Section 08 is the reason it exists at all: every pixel of a
  // creative has to trace to an asset a named human approved, so approving is
  // an act somebody is answerable for rather than a state somebody sets.
  {
    key: "asset:read",
    group: "campaigns",
    label: "See the asset library",
    detail: "Renders, plans and site photography a creative can be built from.",
  },
  {
    key: "asset:manage",
    group: "campaigns",
    label: "Add and remove assets",
    detail: "Upload renders and photography, and take them back out.",
  },
  {
    key: "asset:approve",
    group: "campaigns",
    label: "Approve assets",
    detail:
      "Sign off an image as fit to build a creative from. Nothing unapproved can be rendered.",
    sensitive: true,
  },

  // --- unit types ----------------------------------------------------------
  //
  // A configuration and its price are a different thing from a render, which
  // is why these are not folded into `asset:manage`. A marketing executive
  // who should be uploading site photography all week has no business setting
  // what a 2 BHK costs, and a tenant that wanted to allow it can, because the
  // role is an editable bundle.
  //
  // There is deliberately no `unit:approve`. The number a configuration
  // produces is a price, and `brain.price:approve` is the key that already
  // means "this person owns prices". A fourth approve key would be a second
  // person able to sign off a price, which is the arrangement the Brain's
  // three-way split exists to prevent.
  {
    key: "unit:read",
    group: "campaigns",
    label: "See the configurations",
    detail: "The 1 BHK, 2 BHK and 3 BHK a tower sells, with carpet areas and prices.",
  },
  {
    key: "unit:manage",
    group: "campaigns",
    label: "Record configurations",
    detail: "Add a configuration, revise its area or price, and copy it to another tower.",
    sensitive: true,
  },

  // --- brand ---------------------------------------------------------------
  //
  // Separate from `org:manage` on purpose. A brand kit hangs off a node and
  // resolves downward, so a subsidiary's marketing lead can own their own
  // entity's logo and contact details without also holding the power to edit
  // the organisation's legal identity.
  {
    key: "brand:read",
    group: "settings",
    label: "See the brand kit",
    detail: "The logo, tagline, contact details and disclaimer a creative is built from.",
  },
  {
    key: "brand:manage",
    group: "settings",
    label: "Edit the brand kit",
    detail: "Upload the logo and set the contact details every advertisement carries.",
  },

  // --- settings ------------------------------------------------------------
  {
    key: "org:read",
    group: "settings",
    label: "See organisation settings",
    detail: "View company details, GSTIN and verified domains.",
  },
  {
    key: "org:manage",
    group: "settings",
    label: "Edit organisation settings",
    detail: "Change company details and the organisation's identity.",
    sensitive: true,
  },
  // --- billing -------------------------------------------------------------
  //
  // Two keys, because seeing what the plan allows and buying more are
  // different powers: a sales head needs to know the minutes are running
  // out, and should not be the one who spends the company's money on more.
  {
    key: "billing:read",
    group: "settings",
    label: "See plan and usage",
    detail: "Each project's plan, what this month's allowance has left, the top-ups and the invoices.",
  },
  {
    key: "billing:manage",
    group: "settings",
    label: "Buy top-ups and edit billing details",
    detail: "Buy prepaid top-ups and change who invoices are made out to.",
    sensitive: true,
  },
  {
    key: "integration:manage",
    group: "settings",
    label: "Manage connected accounts",
    detail:
      "Connect and disconnect the Meta and Google accounts posts and ads go to. These hold credentials.",
    sensitive: true,
  },
];

/** Every permission key, for validation on the way in. */
export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

/**
 * The wildcard held by the founding admin role.
 *
 * Storing `*` rather than a materialised list means a permission added in a
 * later release applies to the admin immediately. Anything else would ship a
 * feature that even the org owner cannot reach until someone remembers to
 * tick a box.
 */
export const ALL_PERMISSIONS = "*";

/**
 * Keys as a person reads them, for a refusal: "See real phone numbers,
 * Export leads and 2 more". Never the key itself, which is ours.
 */
export function permissionWords(keys: readonly string[], max = 3): string {
  const words = keys.map((k) =>
    k === ALL_PERMISSIONS ? "everything" : (PERMISSIONS.find((p) => p.key === k)?.label ?? k),
  );
  if (words.length <= max) return words.join(", ");
  return `${words.slice(0, max).join(", ")} and ${words.length - max} more`;
}

export function permissionByKey(key: string): PermissionDef | undefined {
  return PERMISSIONS.find((p) => p.key === key);
}

/** Drops anything not in the catalog. Unknown keys grant nothing, so they are noise. */
export function sanitisePermissions(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const k of keys) {
    if (PERMISSION_KEYS.has(k)) seen.add(k);
  }
  return [...seen].sort();
}

export function permissionsIn(group: PermissionGroupKey): PermissionDef[] {
  return PERMISSIONS.filter((p) => p.group === group);
}
