"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { getViewer } from "@/lib/console";
import { importInvites } from "@/lib/invite-bulk";
import { listOrgRoles } from "@/lib/rbac";
import { listScopeNodes } from "@/lib/scope-nodes";
import { nodesWithin, reachFor } from "@/lib/scope-rules";
import { MAX_ROWS } from "@/lib/csv-rules";
import type { FormResult } from "@/components/KeptForm";

/**
 * Importing a list of people.
 *
 * Same permission as a single invite, because it is the same act done sixty
 * times. What differs is only that nobody types sixty addresses, and the
 * refusals have to be reported per line rather than as one sentence.
 *
 * The browser previewed this file with the same rules module. That preview
 * has no authority: the text is re-read and re-planned here against live
 * tenant state, so a row that looked fine a minute ago can still be refused.
 */

const TEAM = "/dashboard/team";

/** A form field, not a file upload: 500 addresses is well under any limit. */
const MAX_TEXT = MAX_ROWS * 400;

/**
 * A refusal comes back to the panel rather than by redirect: a redirect
 * remounted the page, closed the panel and threw away the pasted list.
 * Success still redirects, with the counts, and that is what clears it.
 */
export async function importInvitesAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const { actorUserId, orgId, authz } = await guard();

  const viewer = await getViewer();
  if (!viewer) redirect("/");

  const text = String(formData.get("csv") ?? "");
  if (!text.trim()) return refuse("Paste the list, or choose a file.");
  if (text.length > MAX_TEXT) {
    return refuse(`That is larger than one batch should carry. Split it into files of ${MAX_ROWS} rows or fewer.`);
  }

  // Where this person may land somebody: the subtrees they hold
  // `member:invite` in, and everything below them. Filtering the picker was
  // presentation; this is the list every row is measured against, and a node
  // outside it is refused whether or not the screen ever offered it.
  const allNodes = await listScopeNodes(orgId);
  const nodes = nodesWithin(allNodes, authz.scopesFor("member:invite"));
  if (nodes.length === 0) return refuse("You have nowhere to add anybody.");

  // What they may hand out, and where: roles deep enough to sit somewhere in
  // reach, at the nodes where they hold everything the role does. The
  // founding role falls out of the same rule, because only its wildcard
  // satisfies it.
  const roles = await listOrgRoles(orgId);
  const grantable = reachFor(roles, nodes, authz.heldAt).map((r) => ({
    key: r.key,
    label: r.label,
    minKind: r.minKind,
    at: r.at,
  }));

  // Empty is allowed and means no default: a row naming no role is then
  // refused rather than quietly given one. Anything else has to be a role
  // this person may hand out.
  const defaultRoleKey = String(formData.get("defaultRole") ?? "");
  if (defaultRoleKey && !grantable.some((r) => r.key === defaultRoleKey)) {
    return refuse("Pick the role for rows that do not name one.");
  }

  // The node a row lands at when it names none. Never trusted: it has to be
  // one of the nodes read back above, not whichever id the form carried.
  const defaultScopeId = String(formData.get("defaultScope") ?? "");
  if (defaultScopeId && !nodes.some((n) => n.id === defaultScopeId)) {
    return refuse("Pick a place in your part of the organisation.");
  }

  const result = await importInvites({
    orgId,
    orgName: viewer.state.org.displayName,
    orgPrimaryDomain: viewer.state.org.primaryDomain,
    actorUserId,
    actorName: viewer.name,
    inviterScopes: authz.scopesFor("member:invite"),
    inviterHeldAt: authz.heldAt,
    grantable,
    allRoles: roles,
    nodes,
    allNodes,
    defaultScopeId,
    defaultRoleKey,
    signInUrl: `${process.env.AUTH_URL ?? "http://localhost:3000"}/signin`,
    text,
  });

  if (result.fatal) return refuse(result.fatal);

  revalidatePath(TEAM);

  // Counts, not a transcript. The per-line detail is in the audit log under
  // this batch id, and the team list below now shows who is waiting. The page
  // prints them only as numbers, so a crafted address shows nothing else.
  const q = new URLSearchParams({
    imported: String(result.written),
    skipped: String(result.skipped),
    refused: String(result.refused),
    ...(result.mailFailed > 0 ? { mailFailed: String(result.mailFailed) } : {}),
  }).toString();
  redirect(`${TEAM}?${q}`);
}

async function guard() {
  const { userId, orgId, authz } = await requirePermission("member:invite", TEAM);
  return { actorUserId: userId, orgId, authz };
}

function refuse(message: string): FormResult {
  return { ok: false, message };
}
