import { audit, withTenant } from "./db/index.ts";
import { CAP_UNITS, readCaps, type Caps } from "./project-cap-rules.ts";

/**
 * Each project's own limit on a shared allowance, read and saved in the
 * organisation's own tenant (`project-cap-rules.ts` holds the rules;
 * `billing.ts` asks them before anything is paid for).
 */

const ID = /^[0-9a-f-]{36}$/i;

/** Every project's limits, by project. */
export async function capsOf(orgId: string): Promise<Map<string, Caps>> {
  const rows = await withTenant(orgId, (sql) => sql<{ project_id: string; unit: string; monthly: number }[]>`
    SELECT project_id, unit, monthly FROM project_caps WHERE org_id = ${orgId}`);
  const out = new Map<string, Caps>();
  for (const r of rows) out.set(r.project_id, { ...(out.get(r.project_id) ?? {}), [r.unit]: r.monthly });
  return out;
}

/** A project's limits, replaced whole: an empty field takes its limit off. */
export async function saveCaps(o: { orgId: string; userId: string; projectId: string; raw: Record<string, unknown> }): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!ID.test(o.projectId)) return { ok: false, message: "Choose a project." };
  const read = readCaps(o.raw);
  if (!read.ok) return { ok: false, message: Object.values(read.errors)[0] ?? "Check the limits." };
  const saved = await withTenant(o.orgId, async (sql) => {
    const [p] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.projectId} AND kind = 'PROJECT'`;
    if (!p) return false;
    await sql`DELETE FROM project_caps WHERE org_id = ${o.orgId} AND project_id = ${p.id}`;
    for (const u of CAP_UNITS) {
      const n = read.caps[u];
      if (n === undefined) continue;
      await sql`INSERT INTO project_caps (org_id, project_id, unit, monthly, updated_by) VALUES (${o.orgId}, ${p.id}, ${u}, ${n}, ${o.userId})`;
    }
    return true;
  });
  if (!saved) return { ok: false, message: "That project is not here." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "billing.project_caps", targetType: "scope_node", targetId: o.projectId, metadata: read.caps });
  return { ok: true };
}
