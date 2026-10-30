-- ===========================================================================
--  0024_calling  --  leads the AI agent may call, the client's calling
--                    policy, consent, opt-outs, and every call placed
--
--  Until now the call log was invented and nothing stored what the Sarvam
--  agent did. This is the smallest set of tables that lets one real call go
--  out and come back: a lead to call, the rules the client chose for calling,
--  the consent that permits it, the opt-outs that forbid it, and the call.
--
--  THE CLIENT CHOOSES THE POLICY, AND THE CHOICE IS RECORDED
--
--  Whether a call needs consent, whether the agent announces the recording
--  and whether it says it is an AI are the client's decisions under their
--  agreement with us. `calling_settings` holds them per node (the org root,
--  or a project that differs), and every change is audited with who made it,
--  because that record is what shows the client chose it.
--
--  OPT-OUTS ARE NOT OPTIONAL
--
--  A buyer who said "don't call me" is never dialled again, whatever the
--  settings say. Three complaints in ten days can bar the calling number
--  under TRAI's 2026 amendment, and that number serves every client. The
--  table is keyed on the number, not the lead, so a second lead record for
--  the same person does not reopen it.
--
--  A CALL IS A RECORD OF WHAT HAPPENED
--
--  `calls` is written when the call is placed and completed by Sarvam's
--  webhook. It keeps the payload as it arrived, so what the agent heard and
--  extracted stays answerable after the lead changes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The client's calling policy, per node, resolved downward like the brand kit
-- ---------------------------------------------------------------------------
CREATE TABLE calling_settings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id      uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  -- NULL means "inherit from above". The org root carries the defaults.
  consent_required   boolean,
  announce_recording boolean,
  recording_line     text CHECK (recording_line IS NULL OR length(recording_line) <= 200),
  announce_ai        boolean,
  -- E.164. Where the agent hands a qualified buyer to a person.
  handoff_number     text CHECK (handoff_number IS NULL OR handoff_number ~ '^\+[1-9][0-9]{7,14}$'),

  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope_node_id)
);

-- ---------------------------------------------------------------------------
-- A lead: somebody who enquired about a tower
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The tower (or project) the enquiry was about.
  scope_node_id   uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone           text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  source          text NOT NULL DEFAULT 'Manual' CHECK (length(source) <= 60),
  -- When the enquiry was made. The 7-day window runs from here.
  enquired_at     timestamptz NOT NULL DEFAULT now(),
  language        text NOT NULL DEFAULT 'hi' CHECK (language IN ('hi', 'mr', 'en')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_org_phone ON leads (org_id, phone);

-- ---------------------------------------------------------------------------
-- Consent: saved proof the buyer agreed to be contacted. Append only.
-- ---------------------------------------------------------------------------
CREATE TABLE lead_consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone        text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  channels     text[] NOT NULL CHECK (channels <@ ARRAY['call', 'whatsapp', 'sms']::text[] AND cardinality(channels) > 0),
  -- The words the buyer agreed to, as shown to them.
  wording      text NOT NULL CHECK (length(wording) BETWEEN 1 AND 600),
  source       text NOT NULL CHECK (length(source) <= 60),
  captured_at  timestamptz NOT NULL DEFAULT now(),
  -- NULL means it does not lapse on its own.
  expires_at   timestamptz,
  captured_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX lead_consents_org_phone ON lead_consents (org_id, phone);

-- ---------------------------------------------------------------------------
-- Opt-outs: never contact this number again
-- ---------------------------------------------------------------------------
CREATE TABLE call_suppressions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone        text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  reason       text NOT NULL CHECK (reason IN ('SAID_ON_CALL', 'WHATSAPP_STOP', 'ADDED_BY_HAND')),
  call_id      uuid,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone)
);

-- ---------------------------------------------------------------------------
-- A call the agent placed
-- ---------------------------------------------------------------------------
CREATE TABLE calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  scope_node_id    uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,

  agent            text NOT NULL DEFAULT 'qualifier' CHECK (agent IN ('qualifier', 'reminder', 'recovery')),
  app_id           text NOT NULL,
  app_version      integer NOT NULL,
  from_number      text NOT NULL,
  to_number        text NOT NULL CHECK (to_number ~ '^\+[1-9][0-9]{7,14}$'),

  -- Sarvam's attempt id, once the call was accepted for dialling.
  attempt_id       text UNIQUE,
  --   PLACING    asked Sarvam, no answer yet
  --   DIALLING   Sarvam accepted it
  --   DONE       the webhook came back
  --   REFUSED    Sarvam refused to place it; `failure_reason` says why
  status           text NOT NULL DEFAULT 'PLACING'
                     CHECK (status IN ('PLACING', 'DIALLING', 'DONE', 'REFUSED')),
  connectivity     text CHECK (connectivity IN ('connected', 'no_answer', 'busy', 'failed')),
  outcome          text,
  duration_s       numeric,
  interaction_id   text,
  failure_reason   text,
  final_variables  jsonb,
  transcript       jsonb,
  payload          jsonb,

  -- What the agent was told for this call, for answering "why did it say that".
  variables        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The Brain versions the facts came from.
  brain_sources    jsonb NOT NULL DEFAULT '[]'::jsonb,

  placed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE INDEX calls_org_placed ON calls (org_id, placed_at DESC);

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON calling_settings TO salesdesk_app;
GRANT SELECT, INSERT ON leads TO salesdesk_app;
-- Consent is evidence: the app may add it and never change or remove it.
GRANT SELECT, INSERT ON lead_consents TO salesdesk_app;
-- An opt-out may be recorded and never lifted by the application.
GRANT SELECT, INSERT ON call_suppressions TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE ON calls TO salesdesk_app;

ALTER TABLE calling_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY calling_settings_isolation ON calling_settings
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY leads_isolation ON leads
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE lead_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_consents_isolation ON lead_consents
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE call_suppressions ENABLE ROW LEVEL SECURITY;
CREATE POLICY call_suppressions_isolation ON call_suppressions
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY calls_isolation ON calls
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
