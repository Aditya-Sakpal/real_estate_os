// A connected WhatsApp number for a suite's own tenant.
//
// There is no shared number any more: a message goes only from a number the
// developer connected through Meta's sign-in. A suite that sends WhatsApp
// (with the driver injected by `useWhatsApp()`) therefore needs one, and
// this writes the rows that sign-in would have written: an account holding a
// sealed token, a registered number placed at a node, and every catalog
// template approved for the words it has now. Call `useVaultKey()` first.
//
// `check:messaging` connects through the real flow against a fake Meta and
// never uses this.
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { seal } from "../src/lib/vault.ts";
import { SUBMITTED } from "../src/lib/wa-catalog.ts";
import { catalogBodies, catalogHash, whatsappPurpose } from "../src/lib/wa-numbers.ts";

export type FixtureNumber = { accountId: string; numberId: string; phoneNumberId: string; wabaId: string };

export async function connectFixtureNumber(
  sql: postgres.Sql,
  orgId: string,
  nodeId: string,
  opts: { display?: string; approve?: boolean } = {},
): Promise<FixtureNumber> {
  const accountId = randomUUID();
  // Digits unique per run, so two suites at once never share a number.
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-12);
  const wabaId = `9${stamp}`;
  const phoneNumberId = `8${stamp}`;
  const sealed = await seal(orgId, whatsappPurpose(accountId), `fixture-token-${stamp}`);
  if (!sealed) throw new Error("useVaultKey() before connectFixtureNumber()");
  await sql`
    INSERT INTO whatsapp_accounts (id, org_id, waba_id, name, currency, status, secret, key_version, last_checked_at)
    VALUES (${accountId}, ${orgId}, ${wabaId}, 'Fixture WABA', 'INR', 'CONNECTED', ${sealed.secret}, ${sealed.keyVersion}, now())`;
  const [n] = await sql<{ id: string }[]>`
    INSERT INTO whatsapp_numbers (org_id, account_id, phone_number_id, display_phone, verified_name, quality, daily_limit,
                                  registered, scope_node_id, active, checked_at)
    VALUES (${orgId}, ${accountId}, ${phoneNumberId}, ${opts.display ?? "+919876501234"}, 'Fixture Developer', 'GREEN', 'TIER_2K',
            true, ${nodeId}, true, now())
    RETURNING id`;
  if (opts.approve !== false) {
    for (const t of SUBMITTED) {
      for (const { language, body } of catalogBodies(t)) {
        await sql`
          INSERT INTO whatsapp_templates (org_id, account_id, name, language, category_asked, category, status, body_sha256, decided_at)
          VALUES (${orgId}, ${accountId}, ${t.name}, ${language}, ${t.category}, ${t.category}, 'APPROVED',
                  ${catalogHash(t, language, body)}, now())`;
      }
    }
  }
  return { accountId, numberId: n.id, phoneNumberId, wabaId };
}

/** Everything a fixture number wrote, before the tenant itself goes. */
export async function dropFixtureNumbers(sql: postgres.Sql, orgId: string): Promise<void> {
  await sql`UPDATE messages SET number_id = NULL WHERE org_id = ${orgId}`;
  await sql`DELETE FROM whatsapp_templates WHERE org_id = ${orgId}`;
  await sql`DELETE FROM whatsapp_numbers WHERE org_id = ${orgId}`;
  await sql`DELETE FROM whatsapp_accounts WHERE org_id = ${orgId}`;
}
