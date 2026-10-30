import { auditHash, withTenant } from "./db/index.ts";
import { isUuid } from "./capture-rules.ts";
import { removeAsset } from "./storage.ts";
import type { Authz } from "./rbac-rules.ts";
import type { Qualification } from "./qualification-rules.ts";
import { ERASED_NAME, erasureRefusal, scrubOutcome, scrubQualification } from "./erasure-rules.ts";

/**
 * Erasing a buyer at their request (DPDP), the reads and writes around
 * `erasure-rules.ts`.
 *
 * A buyer is a number, so erasing one erases every enquiry that number made
 * in this organisation, and the person pressing it must hold `lead:erase` at
 * every one of their towers. Everything is scrubbed in one transaction,
 * under the same lock on the number a new enquiry takes, so an enquiry
 * arriving at that moment waits and then finds nobody to merge into.
 *
 * What goes: the name, number and email, the words of every call and
 * message, what the calls heard in the buyer's words, the host's note, a
 * visit note's transcript and its recording, the form as it arrived, the
 * notes on the lead's history, and a partner's record of the buyer. What
 * stays: ids, stages, amounts and times, so reports and payouts still add
 * up. The number goes on both opt-out lists, the one place it is kept, so
 * nobody here contacts them again; the database refuses a call, a message
 * or a visit for an erased lead whatever path asks.
 *
 * The developer's CRM is their own record and is not touched: the lead's
 * link is closed, so nothing is sent to it again and nothing it sends is
 * taken back in. Consent proofs and DND register answers are kept as the
 * evidence they are.
 */

export type EraseOutcome = { ok: true; message: string } | { ok: false; message: string };

export async function eraseBuyer(o: { orgId: string; userId: string; authz: Authz; leadId: string }): Promise<EraseOutcome> {
  const { orgId, userId, authz, leadId } = o;
  const missing: EraseOutcome = { ok: false, message: "That lead is not there any more." };
  if (!isUuid(leadId)) return missing;

  const done = await withTenant(orgId, async (sql) => {
    const [lead] = await sql<{ phone: string | null; erased_at: Date | null; path: string }[]>`
      SELECT l.phone, l.erased_at, n.path::text AS path
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    if (!lead || !authz.canAt("lead:read", lead.path)) return missing;
    if (!authz.canAt("lead:erase", lead.path)) return { ok: false as const, message: "Your role cannot erase a buyer's data here." };
    if (lead.erased_at || !lead.phone) return { ok: true as const, message: "This buyer's data is already erased.", keys: [] as string[] };
    const phone = lead.phone;

    // The lock a new enquiry from this number takes (`upsertCaptured()`).
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capture:${orgId}:${phone}`}, 0))`;

    const leads = await sql<{ id: string; path: string; qualification: Qualification | null }[]>`
      SELECT l.id, n.path::text AS path, l.qualification
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.phone = ${phone} AND l.erased_at IS NULL
      FOR UPDATE OF l`;
    const ids = leads.map((l) => l.id);
    const [state] = await sql<{ live_call: boolean; live_token: boolean; future_visit: boolean }[]>`
      SELECT
        EXISTS (SELECT 1 FROM calls WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND status IN ('PLACING', 'DIALLING')) AS live_call,
        (EXISTS (SELECT 1 FROM unit_blocks WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND state IN ('PENDING_TOKEN', 'TOKEN_PAID'))
         OR EXISTS (SELECT 1 FROM payment_links pl JOIN quotes q ON q.id = pl.quote_id
                     WHERE pl.org_id = ${orgId} AND q.lead_id = ANY(${ids}) AND pl.status IN ('CREATING', 'CREATED'))) AS live_token,
        EXISTS (SELECT 1 FROM site_visits WHERE org_id = ${orgId} AND lead_id = ANY(${ids})
                 AND (status = 'ON_SITE' OR (status IN ('REQUESTED', 'CONFIRMED') AND scheduled_at > now()))) AS future_visit`;
    const refused = erasureRefusal({
      outsideReach: leads.filter((l) => !authz.canAt("lead:erase", l.path)).length,
      liveCall: state.live_call,
      liveToken: state.live_token,
      futureVisit: state.future_visit,
    });
    if (refused) return { ok: false as const, message: refused };

    // The CRM keeps its own record: this change is not queued to it.
    await sql`SELECT set_config('app.crm_inbound', 'on', true)`;

    // Never contacted again. The opt-out lists are the one place the number stays.
    await sql`
      INSERT INTO call_suppressions (org_id, phone, reason, created_by)
      VALUES (${orgId}, ${phone}, 'ERASED', ${userId})
      ON CONFLICT (org_id, phone) DO NOTHING`;
    await sql`
      INSERT INTO message_opt_outs (org_id, phone, scope, source, created_by)
      VALUES (${orgId}, ${phone}, 'MARKETING', 'PERSON', ${userId})`;

    // The leads first: every guard below asks whether the lead is erased.
    for (const l of leads) {
      await sql`
        UPDATE leads SET erased_at = now(), name = ${ERASED_NAME}, phone = NULL, email = NULL,
               needs_person = NULL, automation = 'PAUSED', form_answers = NULL,
               qualification = ${sql.json(scrubQualification(l.qualification) as never)}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${l.id}`;
    }
    await sql`
      UPDATE lead_tasks SET state = 'CANCELLED', result = 'The buyer''s data was erased', done_at = now()
      WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND state = 'DUE'`;
    await sql`UPDATE lead_tasks SET detail = '{}'::jsonb WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND detail <> '{}'::jsonb`;

    // The recordings' keys are read first: the update below forgets them.
    const recordings = await sql<{ recording_key: string }[]>`
      SELECT recording_key FROM calls
      WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND recording_key IS NOT NULL`;
    const calls = await sql`
      UPDATE calls SET to_number = NULL, transcript = NULL, final_variables = NULL, payload = NULL,
             qualification = NULL, variables = '{}'::jsonb, recording_key = NULL, recording_type = NULL,
             goal_text = CASE WHEN goal_text IS NULL THEN NULL ELSE '' END
      WHERE org_id = ${orgId} AND lead_id = ANY(${ids})`;
    const messages = await sql`
      UPDATE messages SET phone = NULL, body = '', variables = '[]'::jsonb
      WHERE org_id = ${orgId} AND (lead_id = ANY(${ids}) OR phone = ${phone})`;

    const visits = await sql<{ id: string; outcome: Record<string, unknown> | null }[]>`
      SELECT id, outcome FROM site_visits WHERE org_id = ${orgId} AND lead_id = ANY(${ids})`;
    for (const v of visits) {
      await sql`
        UPDATE site_visits SET asked_for = NULL, outcome = ${v.outcome ? sql.json(scrubOutcome(v.outcome) as never) : null}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${v.id}`;
    }
    const notes = !visits.length ? [] : await sql<{ storage_key: string }[]>`
      UPDATE visit_notes SET transcript = NULL, draft = NULL, lease_until = NULL,
             state = CASE WHEN state = 'CONFIRMED' THEN state ELSE 'REFUSED' END,
             reason = CASE WHEN state = 'CONFIRMED' THEN reason ELSE 'Erased at the buyer''s request' END,
             updated_at = now()
      WHERE org_id = ${orgId} AND visit_id = ANY(${visits.map((v) => v.id)})
      RETURNING storage_key`;

    await sql`UPDATE lead_activity SET note = NULL WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND note IS NOT NULL`;
    await sql`UPDATE lead_events SET payload = '{}'::jsonb WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND payload <> '{}'::jsonb`;
    // A call from the number that still waits for a project is no lead's, and goes too.
    await sql`
      UPDATE lead_events SET payload = '{}'::jsonb, outcome = 'JUNK', processed_at = now(), error = 'The buyer''s data was erased'
      WHERE org_id = ${orgId} AND source = 'PHONE' AND outcome = 'WAITING' AND payload->>'phone' = ${phone}`;

    // A partner's record of the buyer: a live claim ends, and every row forgets who it was.
    await sql`
      UPDATE client_registrations SET status = 'WITHDRAWN', released_at = now()
      WHERE org_id = ${orgId} AND phone = ${phone} AND verdict = 'REGISTERED' AND status = 'ACTIVE'`;
    const registrations = await sql`
      UPDATE client_registrations SET phone = NULL, buyer_name = NULL
      WHERE org_id = ${orgId} AND phone = ${phone}`;
    await sql`UPDATE inbound_calls SET from_number = NULL WHERE org_id = ${orgId} AND from_number = ${phone}`;
    await sql`
      UPDATE call_list_rows SET name = NULL, phone = NULL, note = NULL, goal = NULL, lease_until = NULL,
             state = CASE WHEN state IN ('READY', 'CALLING') THEN 'SKIPPED' ELSE state END,
             reason = CASE WHEN state IN ('READY', 'CALLING') THEN 'The buyer''s data was erased' ELSE reason END
      WHERE org_id = ${orgId} AND (phone = ${phone} OR lead_id = ANY(${ids}))`;
    // A channel partner's own registration of the buyer with a developer not on Sales Desk, and its booking's name.
    await sql`
      UPDATE outside_bookings SET buyer_name = NULL
      WHERE org_id = ${orgId} AND registration_id IN (SELECT id FROM outside_registrations WHERE org_id = ${orgId} AND phone = ${phone})`;
    await sql`UPDATE outside_registrations SET buyer_name = NULL, phone = NULL WHERE org_id = ${orgId} AND phone = ${phone}`;

    // The lead's other numbers (a co-applicant's, an alternate) are taken off,
    // so no partner's claim or booking is matched on them again.
    await sql`
      UPDATE lead_phones SET removed_at = now(), removed_by = ${userId}
      WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND removed_at IS NULL`;

    // The developer's CRM: never synced again, either way. Our copy of what
    // the two sides last agreed held the name and number, so it goes too.
    await sql`
      UPDATE crm_links SET removed_at = now(), removed_reason = 'ERASED'
      WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND removed_at IS NULL`;
    await sql`
      UPDATE crm_links SET base = '{}'::jsonb
      WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND base <> '{}'::jsonb`;
    await sql`
      UPDATE crm_outbox SET status = 'CANCELLED', waiting_on = NULL, waiting_for = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND lead_id = ANY(${ids}) AND status IN ('PENDING', 'WAITING')`;

    await sql`
      INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (${orgId}, ${userId}, 'lead.erased', 'lead', ${leadId},
              ${sql.json({
                phone: auditHash(phone),
                leads: ids.length,
                calls: calls.count,
                messages: messages.count,
                notes: notes.length,
                registrations: registrations.count,
              } as never)})`;

    return {
      ok: true as const,
      message: ids.length > 1 ? `Erased. ${ids.length} enquiries from this buyer no longer hold their details.` : "Erased. This buyer's details are gone.",
      keys: [...notes.map((n) => n.storage_key), ...recordings.map((r) => r.recording_key)],
    };
  });

  if (!done.ok) return done;
  // The recordings, once the rows no longer point a player at them. A file
  // that will not go is left for a person: the row still names its key.
  for (const key of "keys" in done ? done.keys : []) await removeAsset(key);
  return { ok: true, message: done.message };
}

/** How many enquiries erasing this lead's buyer would reach, for the confirmation's words. */
export async function enquiriesOfBuyer(orgId: string, leadId: string): Promise<number> {
  if (!isUuid(leadId)) return 0;
  const [r] = await withTenant(orgId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM leads
    WHERE org_id = ${orgId} AND erased_at IS NULL
      AND phone = (SELECT phone FROM leads WHERE org_id = ${orgId} AND id = ${leadId})`);
  return r?.n ?? 0;
}
