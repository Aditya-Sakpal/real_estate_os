import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/db";
import { listCalls } from "@/lib/calling";
import { lensFor } from "@/lib/mask";
import { xlsxFile } from "@/lib/xlsx-write";
import {
  callExportTable,
  callExportTally,
  callExportWidths,
  callsCsv,
  MAX_CALL_EXPORT,
  pickCalls,
  readIds,
  type CallExportFormat,
} from "@/lib/call-export-rules";

/**
 * The calls on screen, as a file. The page posts the ids it is showing after
 * its filters, in its order; the calls themselves are read again here, inside
 * `lead:export`'s own scope and through the masking policy, so a posted id
 * this person may not export is simply not in the file.
 *
 * The audit row records how many rows went out and how many carried a whole
 * number, never what was in them.
 */
export async function POST(req: Request): Promise<Response> {
  const { userId, orgId, authz } = await requirePermission("lead:export", "/dashboard/leads/calls");
  const form = await req.formData().catch(() => null);
  const format: CallExportFormat = form?.get("format") === "xlsx" ? "xlsx" : "csv";
  const ids = readIds(form?.get("ids"));

  const scopes = authz.scopesFor("lead:export");
  const all = ids.length
    ? await listCalls(orgId, { lens: await lensFor(orgId, authz), scopes }, MAX_CALL_EXPORT, null, { transcripts: false })
    : [];
  const calls = pickCalls(all, ids);

  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const table = callExportTable(calls, { today, nowIso: now.toISOString(), origin: new URL(req.url).origin });

  await audit({
    orgId,
    actorUserId: userId,
    action: "call.exported",
    targetType: "org",
    targetId: orgId,
    metadata: callExportTally(calls, format),
  });

  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (format === "xlsx") {
    return new Response(new Uint8Array(xlsxFile("Calls", table.header, table.rows, callExportWidths(table.header))), {
      headers: {
        ...headers,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="calls-${today}.xlsx"`,
      },
    });
  }
  return new Response(callsCsv(table), {
    headers: {
      ...headers,
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="calls-${today}.csv"`,
    },
  });
}
