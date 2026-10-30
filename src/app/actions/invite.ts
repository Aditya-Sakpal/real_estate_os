"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { getViewer } from "@/lib/console";
import { createInvite, revokeInvite } from "@/lib/invite";
import { inviteMail, mailerConfigured, send } from "@/lib/mailer";
import { audit } from "@/lib/db";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

const TEAM = "/dashboard/team";

/** An address inside a mailer's words, so it never reaches the audit log. */
const withoutAddresses = (text: string) => text.replace(/[^\s@<>"']+@[^\s@<>"']+/g, "[address]");

/**
 * Send an invite.
 *
 * Nothing here trusts the form except the email and the role key, and both
 * are validated against the viewer's own resolved state: the org comes from
 * the session, the scope from the memberships this person actually holds, and
 * the role from what this tenant actually has.
 *
 * A refusal comes back to the form, so the address typed survives it. Success
 * redirects with a signed message, which also clears the form.
 */
export async function inviteAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("member:invite", TEAM);

  const viewer = await getViewer();
  if (!viewer) redirect("/");

  const email = String(formData.get("email") ?? "");
  const roleKey = String(formData.get("role") ?? "");
  if (!email || !roleKey) return { ok: false, message: "Pick an address and a role." };

  // The node is passed through as text and validated inside createInvite,
  // where it is read back within the tenant. Nothing here believes it.
  const result = await createInvite({
    orgId,
    orgName: viewer.state.org.displayName,
    orgPrimaryDomain: viewer.state.org.primaryDomain,
    actorUserId: userId,
    actorName: viewer.name,
    inviterScopes: authz.scopesFor("member:invite"),
    inviterHeldAt: authz.heldAt,
    email,
    roleKey,
    scopeNodeId: String(formData.get("scopeNodeId") ?? ""),
    signInUrl: `${process.env.AUTH_URL ?? "http://localhost:3000"}/signin`,
  });

  if (!result.ok) return { ok: false, message: result.message };

  // The membership is already written. Mail is a notification about it, so a
  // failure here reports itself and changes nothing about the invite. Why it
  // failed (an SES sandbox, an unverified sender) is ours to fix, not the
  // admin's, so it goes to the audit row and the screen says what to do.
  let mailed: "sent" | "failed" | "off" = "off";
  if (mailerConfigured()) {
    const sent = await send(
      inviteMail({
        to: result.email,
        orgName: viewer.state.org.displayName,
        body: result.message,
      }),
    );
    mailed = sent.ok ? "sent" : "failed";
    await audit({
      orgId,
      actorUserId: userId,
      action: sent.ok ? "invite.emailed" : "invite.email_failed",
      targetType: "domain",
      targetId: result.email.slice(result.email.lastIndexOf("@") + 1),
      metadata: sent.ok
        ? { message_id: sent.messageId }
        : { code: sent.code, detail: withoutAddresses(sent.detail).slice(0, 300) },
    });
  }

  revalidatePath(TEAM);

  const place = result.scopeName;
  // "as Site Team" is half an answer below the root: on which tower.
  const as = result.scopePath.includes(".") ? `${result.roleLabel} on ${place}` : result.roleLabel;
  const signIn = "Ask them to sign in with this address.";
  const text = result.reinvited
    ? mailed === "sent"
      ? `${result.email} was already invited to ${place}. Their role is now ${result.roleLabel}, and the email was sent again.`
      : mailed === "failed"
        ? `${result.email} was already invited to ${place}. Their role is now ${result.roleLabel}, but the email did not go out. ${signIn}`
        : `${result.email} was already invited to ${place}. Their role is now ${result.roleLabel}. ${signIn}`
    : mailed === "sent"
      ? `${result.email} is invited as ${as}. The email is on its way.`
      : mailed === "failed"
        ? `${result.email} is invited, but the email did not go out. ${signIn}`
        : `${result.email} is invited as ${as}. ${signIn}`;

  // A mail that did not go out is something to act on, so it takes the red
  // banner; the address warning rides beside it under its own name.
  const parts = [flash(mailed === "failed" ? "unsent" : "invited", text)];
  if (result.warning) parts.push(flash("address", result.warning));
  redirect(`${TEAM}?${parts.join("&")}#invite`);
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("member:invite", TEAM);

  const membershipId = String(formData.get("membershipId") ?? "");
  if (!membershipId) redirect(TEAM);

  const done = await revokeInvite({ orgId, actorUserId: userId, membershipId });

  revalidatePath(TEAM);
  redirect(done ? `${TEAM}?${flash("invited", "Invite withdrawn.")}#invite` : TEAM);
}
