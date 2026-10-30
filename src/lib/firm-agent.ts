import { withTenant } from "./db/index.ts";
import { agentOnAds, type AgentOnAds } from "./rera-ad-rules.ts";

/**
 * What a company's own advertisements carry about it as an agent, read in
 * its own tenant: nothing for a developer, and for a mandate firm or a
 * channel partner its recorded MahaRERA agent registration (Settings, Your
 * firm), or the reason no ad of its may be made. Asked before anything is
 * paid for, beside the refusals for a missing lockup or location.
 */
export async function firmAgentFor(orgId: string, nowIso: string = new Date().toISOString()): Promise<AgentOnAds & { seller: string | null }> {
  const today = new Date(Date.parse(nowIso) + 330 * 60_000).toISOString().slice(0, 10);
  const row = await withTenant(orgId, async (sql) => {
    const [o] = await sql<{ type: string; display_name: string | null; rera_agent_no: string | null; rera_valid_till: Date | string | null }[]>`
      SELECT o.type, o.display_name, f.rera_agent_no, f.rera_valid_till
      FROM orgs o LEFT JOIN firm_profiles f ON f.org_id = o.id
      WHERE o.id = ${orgId}`;
    return o ?? null;
  });
  if (!row) return { ok: true, agentNo: null, seller: null };
  const till = row.rera_valid_till === null
    ? null
    : typeof row.rera_valid_till === "string"
      ? row.rera_valid_till.slice(0, 10)
      // A date column comes back as midnight UTC, so its own day is the date.
      : row.rera_valid_till.toISOString().slice(0, 10);
  // The name the seller's ads are marketed under, beside its agent number.
  return { ...agentOnAds({ orgType: row.type, reraNo: row.rera_agent_no, reraTill: till }, today), seller: row.display_name?.trim() || null };
}
