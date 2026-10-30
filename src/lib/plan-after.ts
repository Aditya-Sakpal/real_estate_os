import { withTenant } from "./db/index.ts";
import { rentCallingNumber, searchNumbers } from "./calling-numbers.ts";
import type { PlanPaid } from "./plan-purchase.ts";

/**
 * What follows a plan being paid for, after the answer: a calling number of
 * its own, in the project's city, placed on the project (on the firm, for a
 * channel partner). Every plan already counts its numbers, so this rents
 * inside the plan and never past it; `rentCallingNumber()` asks the ceiling,
 * the place and the clash itself.
 *
 * It never fails the payment. A city Vobiz has nothing in, Vobiz not
 * switched on, or Vobiz not answering leaves the place without a number,
 * and Settings, Calling numbers offers "Get a number" as before.
 */
export async function afterPlanPaid(orgId: string, paid: PlanPaid): Promise<{ ok: boolean; message: string }> {
  if (!paid.userId) return { ok: false, message: "No person to rent the number for." };
  const where = await withTenant(orgId, async (sql) => {
    if (paid.scope === "PROJECT" && paid.projectId) {
      const [r] = await sql<{ id: string; city: string }[]>`
        SELECT p.id, region.name AS city FROM scope_nodes p
        JOIN scope_nodes region ON region.id = p.parent_id
        WHERE p.org_id = ${orgId} AND p.id = ${paid.projectId} AND p.kind = 'PROJECT'`;
      return r ?? null;
    }
    const [r] = await sql<{ id: string; city: string | null }[]>`
      SELECT n.id, f.city FROM scope_nodes n LEFT JOIN firm_profiles f ON f.org_id = n.org_id
      WHERE n.org_id = ${orgId} AND n.kind = 'ORG' LIMIT 1`;
    return r?.city ? { id: r.id, city: r.city } : null;
  });
  if (!where) return { ok: false, message: "No city to look for a number in." };
  const found = await searchNumbers(where.city);
  if (!found.ok) return { ok: false, message: found.message };
  // Two tries: the first number may be taken by somebody else in between.
  for (const n of found.numbers.slice(0, 2)) {
    const rented = await rentCallingNumber({ orgId, userId: paid.userId, number: n.number, city: found.city ?? where.city, nodeId: where.id });
    if (rented.ok) return { ok: true, message: rented.message };
    if (rented.code !== "TAKEN" && rented.code !== "REFUSED") return { ok: false, message: rented.message };
  }
  return { ok: false, message: "No number could be had in that city." };
}

/** The same, never throwing: it runs after the answer has gone. */
export async function afterPlanPaidQuietly(orgId: string, paid: PlanPaid | null | undefined): Promise<void> {
  if (!paid) return;
  try {
    const r = await afterPlanPaid(orgId, paid);
    if (!r.ok) console.warn(`plan: no calling number rented (${r.message})`);
  } catch (e) {
    console.warn(`plan: renting a number failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
