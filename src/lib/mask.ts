import { cache } from "react";
import { withTenant, audit, auditHash } from "@/lib/db";
import type { Authz } from "@/lib/rbac";
import { isUuid } from "@/lib/capture-rules";
import type { PathStage } from "@/lib/lead-rules";
import {
  REVEALS_PER_DAY,
  lensOf,
  spacedPhone,
  thresholdRows,
  visibilityAt,
  type MaskedField,
  type LeadAt,
  type Lens,
  type PolicyRow,
  type Threshold,
} from "@/lib/mask-rules";

/**
 * Masking, applied. The rules are `mask-rules.ts`; this reads a tenant's
 * policy, turns a viewer into a lens every read path shows numbers through,
 * and is the one place a whole number is handed to a person who asked.
 *
 * Every page that shows a buyer's contact details builds one lens for the
 * request and passes numbers through it before anything reaches a client
 * component. The dialling, dedupe and messaging code never uses a lens: it
 * reads the column, because it is not showing the number to anybody.
 */

export const loadPolicy = cache(async (orgId: string): Promise<PolicyRow[]> =>
  withTenant(orgId, (sql) => sql<PolicyRow[]>`
    SELECT role, field, stage, visibility FROM field_policies
    WHERE org_id = ${orgId} AND resource = 'lead'`),
);

export type { LeadAt, Lens } from "@/lib/mask-rules";
export { lensOf };

export async function lensFor(orgId: string, authz: Authz): Promise<Lens> {
  return lensOf(authz, await loadPolicy(orgId));
}

// ---------------------------------------------------------------------------
// Showing one number to one person
// ---------------------------------------------------------------------------

export type Revealed =
  | { ok: true; phone: string; email: string | null }
  | { ok: false; message: string; needsCode?: boolean };

/**
 * The whole number for one lead, to somebody allowed it, with a row saying
 * so. The row carries a hash of the number, never the number, so the log
 * answers "who looked at this buyer" without becoming a list of buyers.
 *
 * Refused where the policy hides the number outright (a reveal is for a
 * masked number, not a hidden one), without `lead.phone:unmask` at the lead's
 * tower, and past `REVEALS_PER_DAY` in an IST day, which is what stops a
 * person walking the board one click at a time.
 */
export async function revealContact(opts: {
  orgId: string;
  userId: string;
  authz: Authz;
  leadId: string;
  now?: Date;
}): Promise<Revealed> {
  const { orgId, userId, authz, leadId } = opts;
  const missing: Revealed = { ok: false, message: "That lead is not there any more." };
  if (!isUuid(leadId)) return missing;

  const now = opts.now ?? new Date();
  // Midnight IST, as an instant.
  const dayStart = new Date(Math.floor((now.getTime() + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000);

  const found = await withTenant(orgId, async (sql) => {
    const [lead] = await sql<{ phone: string | null; email: string | null; path: string; path_stage: PathStage }[]>`
      SELECT l.phone, l.email, n.path::text AS path, l.path_stage
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    // An erased buyer has no number left to show.
    if (!lead || !lead.phone) return null;
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE org_id = ${orgId} AND actor_user_id = ${userId}
        AND action = 'lead.phone_unmasked' AND created_at >= ${dayStart}`;
    return { lead: { ...lead, phone: lead.phone }, today: n };
  });
  if (!found || !authz.canAt("lead:read", found.lead.path)) return missing;

  const { lead, today } = found;
  const at: LeadAt = { path: lead.path, stage: lead.path_stage };
  const rows = await loadPolicy(orgId);
  const vis = visibilityAt({ grants: authz.grants, path: at.path, stage: at.stage, field: "phone", rows });

  // Already on their screen: nothing is being revealed, so nothing is logged.
  if (vis === "FULL") return { ok: true, phone: spacedPhone(lead.phone), email: lead.email };
  if (vis === "HIDDEN") return { ok: false, message: "Numbers are hidden for your role on this lead." };
  if (!authz.canAt("lead.phone:unmask", at.path)) {
    return { ok: false, message: "Your role cannot see whole numbers here." };
  }
  if (today >= REVEALS_PER_DAY) {
    return { ok: false, message: `You have seen ${REVEALS_PER_DAY} numbers today. More from midnight.` };
  }

  await audit({
    orgId,
    actorUserId: userId,
    action: "lead.phone_unmasked",
    targetType: "lead",
    targetId: leadId,
    metadata: { phone: auditHash(lead.phone), email: auditHash(lead.email), stage: at.stage },
  });
  const emailVis = visibilityAt({ grants: authz.grants, path: at.path, stage: at.stage, field: "email", rows });
  return { ok: true, phone: spacedPhone(lead.phone), email: emailVis === "HIDDEN" ? null : lead.email };
}

// ---------------------------------------------------------------------------
// The tenant's policy
// ---------------------------------------------------------------------------

/**
 * Replace one role's policy. The threshold is written for both fields: the
 * setting is one decision about a buyer's contact details, and a policy that
 * hid the number and showed the email would be a policy nobody chose.
 */
export async function savePolicy(opts: {
  orgId: string;
  userId: string;
  role: string;
  threshold: Threshold;
}): Promise<void> {
  const rows = (["phone", "email"] as MaskedField[]).flatMap((f) => thresholdRows(opts.role, f, opts.threshold));
  await withTenant(opts.orgId, async (sql) => {
    await sql`DELETE FROM field_policies WHERE org_id = ${opts.orgId} AND resource = 'lead' AND role = ${opts.role}`;
    for (const r of rows) {
      await sql`
        INSERT INTO field_policies (org_id, resource, field, role, stage, visibility, updated_by)
        VALUES (${opts.orgId}, 'lead', ${r.field}, ${r.role}, ${r.stage}, ${r.visibility}, ${opts.userId})`;
    }
  });
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "field_policy.changed",
    targetType: "role",
    targetId: opts.role,
    metadata: { before: opts.threshold.before, from: opts.threshold.from, after: opts.threshold.after },
  });
}

/** Back to the shipped answer for one role. */
export async function resetPolicy(opts: { orgId: string; userId: string; role: string }): Promise<void> {
  await withTenant(opts.orgId, (sql) =>
    sql`DELETE FROM field_policies WHERE org_id = ${opts.orgId} AND resource = 'lead' AND role = ${opts.role}`);
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "field_policy.reset",
    targetType: "role",
    targetId: opts.role,
    metadata: {},
  });
}
