-- ===========================================================================
--  0077_inbound_numbers  --  a buyer calling a developer's own number,
--                            each number's month metered, a partner firm
--                            adding its own people by phone
--
--  A CALL IN IS ITS OWN ROW
--
--  `inbound_calls` is one buyer ringing one of the tenant's calling numbers
--  (0073): who rang (the buyer's number, tenant data like `leads.phone`),
--  the lead it was filed on, who was rung for it and who took it, and what
--  Vobiz billed. The lead is NULL only when no tower could be told and the
--  capture refused to guess. A known lead's own row, and the app role never
--  deletes one: a missed call is the record a person calls back from.
--
--  A LEAD MAY ARRIVE BY PHONE
--
--  An unknown caller is captured through the ordinary path, so the channel
--  and the event source gain PHONE, and the lead's history gains CALL_IN.
--
--  A NUMBER'S MONTH IS METERED
--
--  One PHONE_NUMBER usage row per number per IST month, in the unit NUMBER,
--  idempotent on the number and the month (`source_kind` calling_number).
--
--  A PARTNER'S PERSON INVITED BY PHONE
--
--  A firm's owner adds its own people by their number. Until they sign in
--  with it the row is a phone nobody has proved, so the "nameless row is an
--  erased row" rule now also accepts an unproved phone that carries a name.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A call in
-- ---------------------------------------------------------------------------
CREATE TABLE inbound_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  calling_number_id  uuid NOT NULL REFERENCES calling_numbers(id) ON DELETE RESTRICT,
  -- The buyer's number as Vobiz gave it; NULL when the caller withheld it.
  from_number        text CHECK (from_number IS NULL OR from_number ~ '^\+[1-9][0-9]{7,14}$'),
  lead_id            uuid REFERENCES leads(id) ON DELETE RESTRICT,
  -- Where the minutes count: the lead's tower, else the number's own place.
  scope_node_id      uuid REFERENCES scope_nodes(id) ON DELETE SET NULL,
  vobiz_call_uuid    text NOT NULL CHECK (length(vobiz_call_uuid) BETWEEN 1 AND 100),
  --   OWNER     ringing the lead's owner first
  --   TEAM      ringing the free sales team
  stage              text CHECK (stage IS NULL OR stage IN ('OWNER', 'TEAM')),
  --   RINGING    somebody is being rung for the buyer
  --   CONNECTED  somebody took the buyer
  --   ENDED      over after a conversation; `bill_s` is what Vobiz billed
  --   MISSED     nobody took it; a person is asked to call back
  --   REFUSED    rung for nobody: a number the ownership rules call junk,
  --              or no minutes left on the plan
  status             text NOT NULL DEFAULT 'RINGING'
                       CHECK (status IN ('RINGING', 'CONNECTED', 'ENDED', 'MISSED', 'REFUSED')),
  in_hours           boolean NOT NULL,
  rang               text[] NOT NULL DEFAULT '{}' CHECK (cardinality(rang) <= 10),
  answered_by        text CHECK (answered_by IS NULL OR answered_by ~ '^\+[1-9][0-9]{7,14}$'),
  bill_s             integer CHECK (bill_s IS NULL OR bill_s >= 0),
  -- Why it went the way it did, in words a person reads.
  note               text CHECK (note IS NULL OR length(note) <= 200),
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz
);
-- Vobiz asks the answer address again on a retry: one row per call.
CREATE UNIQUE INDEX inbound_calls_one_per_call ON inbound_calls (org_id, vobiz_call_uuid);
CREATE INDEX inbound_calls_lead ON inbound_calls (org_id, lead_id, started_at DESC);
CREATE INDEX inbound_calls_live ON inbound_calls (org_id, started_at) WHERE status IN ('RINGING', 'CONNECTED');

-- The number and the call it belongs to never change; a call only moves on.
CREATE FUNCTION inbound_calls_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.calling_number_id <> OLD.calling_number_id OR NEW.vobiz_call_uuid <> OLD.vobiz_call_uuid
     OR NEW.from_number IS DISTINCT FROM OLD.from_number OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'an inbound call''s number and caller are fixed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('ENDED', 'MISSED', 'REFUSED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'an inbound call that ended stays ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbound_calls_forward BEFORE UPDATE ON inbound_calls
  FOR EACH ROW EXECUTE FUNCTION inbound_calls_forward();

-- The number must be the tenant's own.
CREATE FUNCTION inbound_calls_own_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM calling_numbers c WHERE c.id = NEW.calling_number_id AND c.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'an inbound call is on a number of its own tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbound_calls_own_number BEFORE INSERT ON inbound_calls
  FOR EACH ROW EXECUTE FUNCTION inbound_calls_own_number();

GRANT SELECT, INSERT ON inbound_calls TO salesdesk_app;
GRANT UPDATE (lead_id, scope_node_id, stage, status, rang, answered_by, bill_s, note, ended_at) ON inbound_calls TO salesdesk_app;
ALTER TABLE inbound_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY inbound_calls_isolation ON inbound_calls
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- A lead that arrived by phone
-- ---------------------------------------------------------------------------
ALTER TABLE lead_events DROP CONSTRAINT lead_events_source_check;
ALTER TABLE lead_events ADD CONSTRAINT lead_events_source_check
  CHECK (source IN ('META_FORM', 'GOOGLE_FORM', 'WEBSITE', 'WHATSAPP', 'PHONE'));
ALTER TABLE leads DROP CONSTRAINT leads_channel_check;
ALTER TABLE leads ADD CONSTRAINT leads_channel_check
  CHECK (channel IN ('META_FORM', 'GOOGLE_FORM', 'WEBSITE', 'MANUAL', 'CRM', 'WHATSAPP', 'PHONE'));
ALTER TABLE lead_activity DROP CONSTRAINT lead_activity_kind_check;
ALTER TABLE lead_activity ADD CONSTRAINT lead_activity_kind_check
  CHECK (kind IN ('CAPTURED', 'STAGE', 'ASSIGNED', 'AUTOMATION', 'NOTE', 'CALL_IN'));

-- ---------------------------------------------------------------------------
-- A number's month
-- ---------------------------------------------------------------------------
ALTER TABLE usage_events DROP CONSTRAINT usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN (
  'CALL_MINUTE', 'HANDOFF_MINUTE', 'IMAGE_POST', 'CAROUSEL', 'EXTRA_SLIDE', 'VIDEO', 'FILM', 'FILM_VERSION',
  'STORY_REEL', 'QUESTION', 'WHATSAPP', 'SMS', 'PHONE_NUMBER'));
ALTER TABLE usage_events DROP CONSTRAINT usage_events_unit_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_unit_check
  CHECK (unit IN ('MINUTE', 'IMAGE', 'CAROUSEL', 'SLIDE', 'VIDEO', 'QUESTION', 'WHATSAPP', 'NUMBER'));
ALTER TABLE usage_events DROP CONSTRAINT usage_events_source_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_source_kind_check
  CHECK (source_kind IN ('call', 'post', 'creative', 'ask_message', 'message', 'visit_note', 'calling_number'));

-- ---------------------------------------------------------------------------
-- A person invited by phone
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT users_named_unless_erased;
ALTER TABLE users ADD CONSTRAINT users_named_unless_erased
  CHECK (erased_at IS NOT NULL OR email IS NOT NULL
         OR (phone IS NOT NULL AND (phone_verified_at IS NOT NULL OR name IS NOT NULL)));
