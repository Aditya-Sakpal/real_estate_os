/**
 * The role templates Sales Desk ships with.
 *
 * Roles are always held AT a scope node, never globally: "Project Sales
 * Manager" is meaningless without "@ which project". `minKind` records the
 * shallowest node a role may be granted at, which is what makes the ordering
 * constraint in onboarding explicit. You cannot grant a Project Sales Manager
 * before a PROJECT node exists.
 *
 * These are TEMPLATES, not the final word. A tenant may retune any of them or
 * write its own, and those live in `org_roles`. See `src/lib/rbac.ts` for how
 * the two are merged. What ships here is the sensible default, so a company
 * that never opens the role editor still gets a defensible split.
 *
 * Note what is NOT here: a `canDelegate` flag. Delegation used to be a boolean
 * beside the role, which meant two things could disagree about whether someone
 * may add people. Now `member:invite` is the whole answer, and only the
 * founding role ships with it. An organisation that wants its sales head
 * approving join requests grants that permission deliberately.
 */

import { ALL_PERMISSIONS } from "./permissions.ts";

export type ScopeKind = "ORG" | "ENTITY" | "REGION" | "PROJECT" | "PHASE";

export type RoleDef = {
  key: string;
  label: string;
  /** One line, shown in the role editor and the invite picker. */
  description: string;
  minKind: ScopeKind;
  /** The bundle. `["*"]` on the founding admin only. */
  permissions: string[];
};

const SALES_FLOOR = [
  "lead:read",
  "lead:update",
  "lead:call",
  "inventory:read",
  "visit:read",
  "member:read",
];

export const DEVELOPER_ROLES: RoleDef[] = [
  {
    key: "ORG_ADMIN",
    label: "Org Admin",
    description: "Everything, including roles, billing and connected accounts.",
    minKind: "ORG",
    permissions: [ALL_PERMISSIONS],
  },
  {
    key: "SALES_HEAD",
    label: "Sales Head",
    description: "Owns the sales number across every project, and the people chasing it.",
    minKind: "ORG",
    permissions: [
      "lead:read",
      "lead:create",
      "lead:update",
      "lead:assign",
      "lead:call",
      "lead.phone:unmask",
      "lead:export",
      "inventory:read",
      "inventory:manage",
      "visit:read",
      "visit:schedule",
      "visit:confirm",
      "visit:outcome",
      "visit:manage",
      "quote:create",
      "quote:approve",
      "loan:update",
      "loan:manage",
      "partner:read",
      "partner:register",
      "payout:read",
      "mandate:manage",
      "project:read",
      "rera:read",
      "member:read",
      "role:read",
      "report:read",
      "billing:read",
      "report.pii:read",
    ],
  },
  {
    key: "MARKETING_HEAD",
    label: "Marketing Head",
    description: "Owns spend and creative. Can publish, and can approve what others build.",
    minKind: "ORG",
    permissions: [
      "campaign:read",
      "campaign:create",
      "campaign:publish",
      "campaign.budget:manage",
      "creative:approve",
      "brand:read",
      "brand:manage",
      "asset:read",
      "asset:manage",
      "unit:read",
      "unit:manage",
      "brain:read",
      "brain:edit",
      "brain:publish",
      "lead:read",
      "project:read",
      "rera:read",
      "member:read",
      "role:read",
      "report:read",
      "billing:read",
    ],
  },
  {
    key: "FINANCE_APPROVER",
    label: "Finance / Payout Approver",
    description: "Releases channel-partner commission, and signs off what a unit costs.",
    minKind: "ORG",
    permissions: [
      "partner:read",
      "payout:read",
      "payout:approve",
      "payout:pay",
      "brain:read",
      "brain.price:approve",
      // It approves a configuration's carpet area and starting price through
      // `brain.price:approve`, so it has to be able to see them.
      "unit:read",
      "member:read",
      "report:read",
      "billing:read",
      "billing:manage",
    ],
  },
  {
    key: "RERA_COMPLIANCE_OFFICER",
    label: "RERA Compliance Officer",
    description: "Holds the registration records, and the veto over what may be advertised.",
    minKind: "ORG",
    permissions: [
      "rera:read",
      "rera:manage",
      "campaign:read",
      "creative:approve",
      "brain:read",
      "brain.rera:approve",
      "project:read",
      "member:read",
      "audit:read",
    ],
  },
  {
    key: "BRAND_APPROVER",
    label: "Brand Approver",
    description: "Signs off what may be claimed about the building, and what may never be said.",
    minKind: "ORG",
    permissions: [
      "brain:read",
      "brain.claims:approve",
      "campaign:read",
      "creative:approve",
      "brand:read",
      "asset:read",
      "asset:approve",
      "unit:read",
      "project:read",
      "member:read",
    ],
  },
  {
    key: "AUDITOR",
    label: "Auditor",
    description: "Aggregates and the audit trail. Never a buyer identity, never an export.",
    minKind: "ORG",
    permissions: ["report:read", "audit:read", "billing:read"],
  },
  {
    key: "CP_RELATIONSHIP_MANAGER",
    label: "CP Relationship Manager",
    description: "Empanels and manages channel partners in a region.",
    minKind: "REGION",
    permissions: [
      "partner:read",
      "partner:empanel",
      "partner:suspend",
      "partner:register",
      "payout:read",
      // A partner's buyer lands in this person's queue, so they hold the
      // lead and book the visit the partner asks for.
      "lead:read",
      "lead:update",
      "inventory:read",
      "visit:read",
      "visit:schedule",
      "member:read",
    ],
  },
  {
    key: "PRESALES_MANAGER",
    label: "Pre-sales Manager",
    description: "Runs the calling bench for a region and routes what comes in.",
    minKind: "REGION",
    permissions: [
      "lead:read",
      "lead:create",
      "lead:update",
      "lead:assign",
      "lead:call",
      "lead.phone:unmask",
      "inventory:read",
      "visit:read",
      "visit:schedule",
      "visit:confirm",
      "visit:outcome",
      "visit:manage",
      "member:read",
      "report:read",
    ],
  },
  {
    key: "MARKETING_EXEC",
    label: "Marketing Executive",
    description: "Builds campaigns. Cannot publish them or move budget.",
    minKind: "REGION",
    permissions: [
      "campaign:read",
      "campaign:create",
      "asset:read",
      "asset:manage",
      "unit:read",
      "brain:read",
      "brain:edit",
      "member:read",
    ],
  },
  {
    key: "PROJECT_SALES_MANAGER",
    label: "Project Sales Manager",
    description: "Owns one project end to end, and the team on it.",
    minKind: "PROJECT",
    permissions: [
      "lead:read",
      "lead:update",
      "lead:assign",
      "lead:call",
      "lead.phone:unmask",
      "inventory:read",
      "inventory:manage",
      "visit:read",
      "visit:schedule",
      "visit:confirm",
      "visit:outcome",
      "visit:manage",
      "quote:create",
      "quote:approve",
      "loan:update",
      "project:read",
      "rera:read",
      "brain:read",
      "member:read",
      "report:read",
    ],
  },
  {
    key: "CLOSING_MANAGER",
    label: "Closing Manager",
    description: "Takes qualified buyers through to a booking.",
    minKind: "PROJECT",
    permissions: [...SALES_FLOOR, "lead.phone:unmask", "visit:outcome", "quote:create", "quote:approve", "loan:update"],
  },
  {
    key: "LOAN_EXECUTIVE",
    label: "Loan Executive",
    description: "Follows each buyer's home loan with the bank, from documents to disbursement.",
    minKind: "ORG",
    permissions: ["lead:read", "loan:update", "loan:manage", "inventory:read", "visit:read", "member:read"],
  },
  {
    key: "PRESALES_AGENT",
    label: "Pre-sales Agent",
    description: "Calls new leads and books site visits. Dials through the proxy only.",
    minKind: "PROJECT",
    permissions: [...SALES_FLOOR, "visit:schedule"],
  },
  {
    key: "CRE",
    label: "Customer Relationship Executive",
    description: "Looks after the buyer after the visit is booked.",
    minKind: "PROJECT",
    permissions: [...SALES_FLOOR, "visit:confirm"],
  },
  {
    key: "SITE_TEAM",
    label: "Site Team",
    description: "On site. Confirms who turned up and what came of it.",
    minKind: "PHASE",
    permissions: ["visit:read", "visit:confirm", "visit:outcome", "member:read"],
  },
];

/** The one role a tenant may never edit away, and never be left without. */
export const FOUNDING_ROLE = "ORG_ADMIN";

/**
 * Custom roles carry this prefix, so a tenant can never define a role that
 * shadows a shipped template or is mistaken for one later. The database
 * enforces the same rule, as a CHECK constraint.
 */
export const CUSTOM_ROLE_PREFIX = "C_";

const DEPTH: Record<ScopeKind, number> = {
  ORG: 0,
  ENTITY: 1,
  REGION: 2,
  PROJECT: 3,
  PHASE: 4,
};

export function scopeDepth(kind: ScopeKind): number {
  return DEPTH[kind];
}

export function roleByKey(key: string): RoleDef | undefined {
  return DEVELOPER_ROLES.find((r) => r.key === key);
}

export function isTemplateKey(key: string): boolean {
  return DEVELOPER_ROLES.some((r) => r.key === key);
}

/**
 * Roles that can be granted at a given depth. Immediately after org creation
 * that is ORG only, which is why the invite picker is short at first and grows
 * as the scope tree is built out.
 */
export function rolesGrantableAt(kind: ScopeKind): RoleDef[] {
  return DEVELOPER_ROLES.filter((r) => DEPTH[r.minKind] <= DEPTH[kind]);
}

export function isRoleValidAtKind(roleKey: string, kind: ScopeKind): boolean {
  const role = roleByKey(roleKey);
  return !!role && DEPTH[role.minKind] <= DEPTH[kind];
}
