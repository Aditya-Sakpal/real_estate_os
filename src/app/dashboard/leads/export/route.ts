import { requirePermission } from "@/lib/guard";
import { redeemStepUp } from "@/lib/phone-session";
import type { Authz } from "@/lib/rbac";
import { withTenant, audit } from "@/lib/db";
import { lensFor } from "@/lib/mask";
import { stageLabel, type PathStage, type StageKey } from "@/lib/lead-rules";
import { sourceLabel, type Lineage } from "@/lib/capture-rules";
import { exportTally, leadsCsv, MAX_EXPORT_ROWS, type ExportRow } from "@/lib/lead-export-rules";

/**
 * Every lead this person may export, as a CSV, with each number as the
 * masking policy lets them see it.
 *
 * `lead:export` is its own key and its own scope: holding it over Pune
 * exports Pune. The audit row records how many rows went out and how many
 * carried a whole number, never what was in them.
 */
export async function GET(): Promise<Response> {
  const { userId, orgId, authz } = await requirePermission("lead:export", "/dashboard/leads");
  return csvFor(userId, orgId, authz);
}

/**
 * A phone session's export: the same file, behind a fresh code sent to the
 * person's own WhatsApp for this one export, spent here.
 */
export async function POST(req: Request): Promise<Response> {
  const { userId, orgId, authz, method, stepUp } = await requirePermission("lead:read", "/dashboard/leads");
  if (method !== "phone") return new Response("Use the Export button.", { status: 400 });
  const form = await req.formData().catch(() => null);
  const opened = await redeemStepUp({
    userId, orgId, authz, stepUp, permission: "lead:export", targetId: orgId,
    challengeId: String(form?.get("challengeId") ?? ""), code: String(form?.get("code") ?? ""),
  });
  if (!opened.ok) return new Response(opened.message, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  return csvFor(userId, orgId, opened.authz);
}

async function csvFor(userId: string, orgId: string, authz: Authz): Promise<Response> {
  const scopes = authz.scopesFor("lead:export");
  const lens = await lensFor(orgId, authz);

  const leads = scopes.length === 0
    ? []
    : await withTenant(orgId, (sql) => sql<{
        name: string; phone: string; email: string | null; stage: StageKey; path_stage: PathStage;
        path: string; place: string; channel: string; lineage: Lineage; enquired_at: Date;
      }[]>`
        SELECT l.name, l.phone, l.email, l.stage, l.path_stage, n.path::text AS path,
               CASE WHEN p.name IS NULL THEN n.name ELSE p.name || ' · ' || n.name END AS place,
               l.channel, l.lineage, l.enquired_at
        FROM leads l
        JOIN scope_nodes n ON n.id = l.scope_node_id
        LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
        WHERE l.org_id = ${orgId} AND n.path <@ ${scopes}::ltree[]
        ORDER BY l.enquired_at DESC
        LIMIT ${MAX_EXPORT_ROWS}`);

  const rows: ExportRow[] = leads.map((l) => {
    const at = { path: l.path, stage: l.path_stage };
    return {
      name: l.name,
      phone: lens.phone(l.phone, at),
      email: lens.email(l.email, at),
      stage: stageLabel(l.stage),
      place: l.place,
      source: sourceLabel(l.channel, l.lineage ?? {}),
      enquiredOn: new Date(l.enquired_at.getTime() + 19_800_000).toISOString().slice(0, 10),
    };
  });

  await audit({
    orgId,
    actorUserId: userId,
    action: "lead.exported",
    targetType: "org",
    targetId: orgId,
    metadata: exportTally(rows),
  });

  const day = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  return new Response(leadsCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leads-${day}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
