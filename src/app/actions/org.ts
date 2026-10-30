"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { controlDb, audit } from "@/lib/db";
import { ACTIVE_ORG_COOKIE } from "@/lib/onboarding";
import { mandateContexts } from "@/lib/grant-access";

/**
 * Switch the org the console is acting as.
 *
 * The posted id is never trusted: it is only honoured when this user already
 * holds a live membership in that org, or reaches it through their firm's live
 * mandate, so the cookie can select among their
 * own tenants and can never reach one they were not granted.
 */
export async function switchOrgAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const orgId = String(formData.get("orgId") ?? "");
  if (!orgId) redirect("/dashboard");

  const [allowed] = await controlDb<{ org_id: string }[]>`
    SELECT org_id FROM memberships
    WHERE user_id = ${session.user.id}
      AND org_id = ${orgId}
      AND status = 'ACTIVE'
    LIMIT 1
  `;
  // Or a developer reached through the person's firm's live mandate.
  const through = allowed ? null : (await mandateContexts(session.user.id)).find((c) => c.devOrgId === orgId);
  if (!allowed && !through) redirect("/dashboard");

  const jar = await cookies();
  jar.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  await audit({
    orgId,
    actorUserId: session.user.id,
    action: "org.switched",
    targetType: "org",
    targetId: orgId,
    metadata: through ? { via: "mandate", firm_org_id: through.firmOrgId } : {},
  });

  redirect("/dashboard");
}
