import { controlDb, audit } from "./db/index.ts";
import { normaliseEmail } from "./invite-rules.ts";

/**
 * The two halves of an invite that the sign-in path touches.
 *
 * Kept apart from `invite.ts` so signing in does not drag role resolution and
 * the permission catalog into the request that is only trying to work out
 * whether to open the door.
 *
 * Imports are relative so `check:invite` can load this module straight from
 * source and call the real acceptance, rather than re-implementing its SQL in
 * a test and proving only that two copies agree.
 */

/**
 * Acceptance, run once at sign-in.
 *
 * Every invite waiting on this identity becomes a live membership. It is an
 * UPDATE and nothing else: the row already says which org, which node and
 * which role, decided by the admin at invite time rather than by whoever
 * happens to open a link.
 */
export async function claimInvites(userId: string): Promise<number> {
  const claimed = await controlDb<{ org_id: string; role: string }[]>`
    UPDATE memberships
    SET status = 'ACTIVE', accepted_at = now()
    WHERE user_id = ${userId} AND status = 'INVITED'
    RETURNING org_id, role
  `;

  for (const row of claimed) {
    await audit({
      orgId: row.org_id,
      actorUserId: userId,
      action: "membership.accepted",
      targetType: "user",
      targetId: userId,
      metadata: { role: row.role, via: "invite" },
    });
  }

  return claimed.length;
}

/**
 * Does this address have a standing reason to be let in?
 *
 * This is what lets the identity bar move to tenant creation. Someone an
 * admin invited may sign in with whatever account they have; someone with no
 * invite and no membership still cannot.
 */
export async function hasStandingAccess(email: string): Promise<boolean> {
  const [row] = await controlDb<{ n: number }[]>`
    SELECT 1 AS n
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE u.email = ${normaliseEmail(email)}
      AND m.status IN ('INVITED', 'ACTIVE')
    LIMIT 1
  `;
  return Boolean(row);
}
