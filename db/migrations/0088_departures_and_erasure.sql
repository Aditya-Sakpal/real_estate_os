-- 0088: A departing member's work moves on, and a buyer can be erased.
--
-- A PERSON WHO LEAVES TAKES NOTHING WITH THEM
--
-- Removing a member, changing their role or a SCIM deactivation used to end
-- their memberships and nothing else: their open leads, the visits they
-- were to host and the partner firms they looked after kept pointing at
-- somebody who could no longer open any of them. The reassignment runs in
-- the same transaction as the change (`departures.ts`) and needs no new
-- table: a lead's history says who left (`lead_activity`, kind ASSIGNED,
-- `detail.departed`), which is also what Today counts.
--
-- A BUYER'S DATA IS SCRUBBED, NEVER DELETED (DPDP)
--
-- `leads.erased_at` marks a buyer erased at their request. Their name,
-- number, email, the words calls and messages carried, visit-note
-- transcripts and a partner's record of them are scrubbed; ids, stages,
-- amounts and times stay, so reports and payouts still add up. The number
-- goes on the opt-out lists, which is the one place it is kept, so nobody
-- here contacts them again. Four rules hold it in the database:
--
--   1. An erased lead has no number, no email and no name (`leads_erased`).
--   2. Nothing is placed, sent or booked for an erased lead: a call, a
--      message or a visit inserted for one is refused.
--   3. A late write to an erased lead's call or message is scrubbed as it
--      lands, so a webhook arriving after the erasure cannot put the words
--      back.
--   4. The append-only tables that held the buyer's words (history notes,
--      the raw capture) may be changed in exactly one way: emptied, and only
--      for an erased lead.

-- ---------------------------------------------------------------------------
-- The lead
-- ---------------------------------------------------------------------------
ALTER TABLE leads ADD COLUMN erased_at timestamptz;
ALTER TABLE leads ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE leads ADD CONSTRAINT leads_erased CHECK (
  (erased_at IS NULL AND phone IS NOT NULL)
  OR (erased_at IS NOT NULL AND phone IS NULL AND email IS NULL AND name = 'Erased buyer'));

-- ---------------------------------------------------------------------------
-- Never contacted again
-- ---------------------------------------------------------------------------
ALTER TABLE call_suppressions DROP CONSTRAINT call_suppressions_reason_check;
ALTER TABLE call_suppressions ADD CONSTRAINT call_suppressions_reason_check
  CHECK (reason IN ('SAID_ON_CALL', 'WHATSAPP_STOP', 'ADDED_BY_HAND', 'ERASED'));

CREATE FUNCTION lead_not_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM leads WHERE id = NEW.lead_id AND erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'an erased buyer is never contacted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calls_not_erased BEFORE INSERT ON calls
  FOR EACH ROW EXECUTE FUNCTION lead_not_erased();
CREATE TRIGGER messages_not_erased BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION lead_not_erased();
CREATE TRIGGER site_visits_not_erased BEFORE INSERT ON site_visits
  FOR EACH ROW EXECUTE FUNCTION lead_not_erased();

-- ---------------------------------------------------------------------------
-- Calls and messages: the words go, the facts about them stay
-- ---------------------------------------------------------------------------
ALTER TABLE calls ALTER COLUMN to_number DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN phone DROP NOT NULL;

CREATE FUNCTION calls_stay_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM leads WHERE id = NEW.lead_id AND erased_at IS NOT NULL) THEN
    NEW.to_number := NULL;
    NEW.transcript := NULL;
    NEW.final_variables := NULL;
    NEW.payload := NULL;
    NEW.qualification := NULL;
    NEW.variables := '{}'::jsonb;
    -- `calls_goal_pair` keeps a goal's text beside its kind.
    IF NEW.goal_text IS NOT NULL THEN NEW.goal_text := ''; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calls_stay_erased BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION calls_stay_erased();

CREATE FUNCTION messages_stay_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads WHERE id = NEW.lead_id AND erased_at IS NOT NULL) THEN
    NEW.phone := NULL;
    NEW.body := '';
    NEW.variables := '[]'::jsonb;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_stay_erased BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_stay_erased();

-- ---------------------------------------------------------------------------
-- Append-only tables: emptied for an erased lead, and changed no other way
-- ---------------------------------------------------------------------------
GRANT UPDATE (note) ON lead_activity TO salesdesk_app;
CREATE FUNCTION lead_activity_scrub_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.note IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM leads WHERE id = OLD.lead_id AND erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a lead''s history is only ever emptied, for an erased buyer'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lead_activity_scrub_only BEFORE UPDATE ON lead_activity
  FOR EACH ROW EXECUTE FUNCTION lead_activity_scrub_only();

GRANT UPDATE (payload) ON lead_events TO salesdesk_app;
CREATE FUNCTION lead_events_scrub_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload AND (
       NEW.payload <> '{}'::jsonb
       OR OLD.lead_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM leads WHERE id = OLD.lead_id AND erased_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'what a form sent is only ever emptied, for an erased buyer'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lead_events_scrub_only BEFORE UPDATE ON lead_events
  FOR EACH ROW EXECUTE FUNCTION lead_events_scrub_only();

-- ---------------------------------------------------------------------------
-- A partner's record of the buyer
-- ---------------------------------------------------------------------------
ALTER TABLE client_registrations ALTER COLUMN phone DROP NOT NULL;
GRANT UPDATE (phone, buyer_name) ON client_registrations TO salesdesk_app;
CREATE FUNCTION client_registrations_scrub_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone IS NOT NULL)
     OR (NEW.buyer_name IS DISTINCT FROM OLD.buyer_name AND NEW.buyer_name IS NOT NULL) THEN
    RAISE EXCEPTION 'a registration''s buyer is only ever erased' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_registrations_scrub_only BEFORE UPDATE ON client_registrations
  FOR EACH ROW EXECUTE FUNCTION client_registrations_scrub_only();

-- ---------------------------------------------------------------------------
-- A call in from the buyer: the caller may now be erased, and nothing else moves
-- ---------------------------------------------------------------------------
GRANT UPDATE (from_number) ON inbound_calls TO salesdesk_app;
CREATE OR REPLACE FUNCTION inbound_calls_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.calling_number_id <> OLD.calling_number_id OR NEW.vobiz_call_uuid <> OLD.vobiz_call_uuid
     OR (NEW.from_number IS DISTINCT FROM OLD.from_number AND NEW.from_number IS NOT NULL)
     OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'an inbound call''s number and caller are fixed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('ENDED', 'MISSED', 'REFUSED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'an inbound call that ended stays ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- The CRM is the developer's record: an erased lead is never synced again
-- ---------------------------------------------------------------------------
ALTER TABLE crm_links DROP CONSTRAINT crm_links_removed_reason_check;
ALTER TABLE crm_links ADD CONSTRAINT crm_links_removed_reason_check
  CHECK (removed_reason IN ('DELETED', 'MERGED', 'ERASED'));

-- Today counts leads a departed owner left behind.
CREATE INDEX lead_activity_departed ON lead_activity (org_id, lead_id, at DESC)
  WHERE kind = 'ASSIGNED' AND detail ? 'departed';
