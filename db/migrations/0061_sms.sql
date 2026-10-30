-- ===========================================================================
--  0061_sms  --  SMS as a service fallback, on the developer's own DLT
--               registration, sent through AWS End User Messaging
--
--  An SMS goes only when a service message could not go on WhatsApp: the
--  project has no number connected, Meta has not approved the message, or
--  the buyer is not on WhatsApp. Only the acknowledgement, the visit
--  confirmation and the two visit reminders; never a promotion.
--
--  THE DEVELOPER'S DLT, NEVER OURS
--
--  India's DLT makes the sender register itself (a Principal Entity id), its
--  six-letter header, and the exact words of every template, each with its
--  own id. A message whose words, header or ids do not match what the
--  developer registered is dropped by the operator. So the words are ours
--  (`sms-rules.ts`), the developer registers them as they are, and this
--  records the ids they got back.
--
--  WHAT IS STORED
--
--    sms_senders     one DLT registration and header per organisation or
--                    entity (a second brand's SPV has its own)
--    sms_templates   the DLT template id for each message and version, with
--                    the hash of the words it was registered with
--    messages        channel 'SMS' beside 'WHATSAPP': one history, one
--                    opt-out, one meter
--    usage_events    kind 'SMS', drawn from the same messaging credit
-- ===========================================================================

CREATE TABLE sms_senders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The organisation's root, or an ENTITY: the brand that registered.
  scope_node_id   uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  -- DLT's Principal Entity id, 19 digits.
  dlt_entity_id   text NOT NULL CHECK (dlt_entity_id ~ '^[0-9]{19}$'),
  -- The header buyers see, six letters, registered for service messages.
  header          text NOT NULL CHECK (header ~ '^[A-Z]{6}$'),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  CONSTRAINT sms_senders_retired CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);
-- One live registration per place: "who sends from here" has one answer.
CREATE UNIQUE INDEX sms_senders_live ON sms_senders (org_id, scope_node_id) WHERE status = 'ACTIVE';

CREATE TABLE sms_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES sms_senders(id) ON DELETE CASCADE,
  purpose          text NOT NULL CHECK (purpose IN ('ACK', 'VISIT_CONFIRMED', 'VISIT_REMINDER_DAY', 'VISIT_REMINDER_SOON')),
  voice            text NOT NULL CHECK (voice IN ('ENGLISH', 'HINGLISH', 'MARATHI')),
  -- DLT's content template id, 19 digits.
  dlt_template_id  text NOT NULL CHECK (dlt_template_id ~ '^[0-9]{19}$'),
  -- The words it was registered with. When ours change, the id no longer
  -- matches them and nothing is sent until the new words are registered.
  body_sha256      text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sms_templates_live ON sms_templates (sender_id, purpose, voice) WHERE status = 'ACTIVE';

-- One history for both channels.
ALTER TABLE messages DROP CONSTRAINT messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check CHECK (channel IN ('WHATSAPP', 'SMS'));
ALTER TABLE messages
  ADD COLUMN sms_template_id uuid REFERENCES sms_templates(id) ON DELETE SET NULL,
  -- How many SMS parts it took; each is priced.
  ADD COLUMN sms_parts smallint CHECK (sms_parts IS NULL OR sms_parts BETWEEN 1 AND 3),
  ADD CONSTRAINT messages_sms_shape CHECK (channel <> 'SMS' OR direction = 'OUT');

ALTER TABLE usage_events DROP CONSTRAINT usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN (
  'CALL_MINUTE', 'HANDOFF_MINUTE', 'IMAGE_POST', 'CAROUSEL', 'EXTRA_SLIDE', 'VIDEO', 'FILM', 'FILM_VERSION',
  'STORY_REEL', 'QUESTION', 'WHATSAPP', 'SMS'));

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------
-- A registration is replaced by retiring it and writing the next, so what a
-- message went out under stays answerable. Nothing is deleted by the app.
GRANT SELECT, INSERT ON sms_senders TO salesdesk_app;
GRANT UPDATE (status, retired_at) ON sms_senders TO salesdesk_app;
GRANT SELECT, INSERT ON sms_templates TO salesdesk_app;
GRANT UPDATE (status) ON sms_templates TO salesdesk_app;

ALTER TABLE sms_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY sms_senders_isolation ON sms_senders
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE sms_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY sms_templates_isolation ON sms_templates
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
