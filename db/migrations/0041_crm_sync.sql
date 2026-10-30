-- ===========================================================================
--  0041_crm_sync  --  the developer's CRM beside us, both ways, and the flats
--                     a tower actually has left
--
--  Section 01: Sales Desk is a system of ACTION beside the system of record.
--  The CRM (LeadSquared, Sell.Do, LeadRat) keeps the record; we do the
--  work and report it back. So a lead captured here is written there at
--  once, a stage a person moves there comes back here, and neither side is
--  allowed to quietly overwrite what the other side owns.
--
--  WHO OWNS WHICH FIELD (decided 28 September 2026)
--
--  The CRM wins what people type there: the stage, the owner, the name and
--  the booking. We win what we observed: what a call found out (budget,
--  configuration, timeline) and the visits the agent booked. An opt-out on
--  either side is final. The phone number never changes through sync; it is
--  the identity both sides dedupe on. `crm-rules.ts` holds the rule and
--  `crm_links.base` is what makes it decidable: the values both sides last
--  agreed on, so "changed since" has an answer on each side.
--
--  NOTHING UNMAPPED IS GUESSED
--
--  Their stages, projects and users are rows in `crm_mappings`, created the
--  first time we see them and pointing at nothing until a person says what
--  they are. An event naming an unmapped stage WAITS, and so does a write
--  that needs one; saving the mapping releases both. The rule `nodesNamed()`
--  follows for a spreadsheet row, applied to a CRM.
--
--  WRITES ARE A DURABLE OUTBOX
--
--  `crm_outbox` is claimed under a lease the way `post_runs` are, unique on
--  an idempotency key, retried with backoff, and left DEAD after the last
--  attempt for a person to see and retry. A lead's row says only "this lead
--  changed": what to send is worked out when it is sent, from the lead as it
--  is then, so ten edits in a minute are one request and an echo of the
--  CRM's own change sends nothing. A trigger on `leads` writes that row in
--  the same transaction as the change, so no write path can forget to.
--
--  INVENTORY IS FAST AND NEVER SIGNED
--
--  `units` is one row per flat. It changes by the hour and is diff synced
--  from the CRM or imported from the developer's availability sheet. It is
--  never on an advertisement ("only four left" is true for about an hour),
--  so nothing in Campaign Studio reads it; the lead page and Ask Jimmy do.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The connection: one CRM per organisation
-- ---------------------------------------------------------------------------
CREATE TABLE crm_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('LEADSQUARED', 'SELLDO', 'LEADRAT')),

  --   CONNECTED     the credential works
  --   BROKEN        it stopped working; somebody has to enter it again
  --   DISCONNECTED  a person disconnected it. No secret, by CHECK.
  status           text NOT NULL DEFAULT 'CONNECTED'
                     CHECK (status IN ('CONNECTED', 'BROKEN', 'DISCONNECTED')),

  -- Where this client's account lives, not secret: LeadSquared's API host
  -- (it differs by data centre), LeadRat's tenant name.
  account          text CHECK (account IS NULL OR length(account) BETWEEN 1 AND 100),
  -- Choices made at connect time from what the CRM listed, such as which
  -- LeadSquared field holds the project. Never a credential.
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The credential, sealed by `vault.ts` for this org and this row.
  secret           bytea,
  key_version      smallint,

  -- The webhooks registered at the CRM: [{ event, id }].
  webhooks         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where polling reached, in the adapter's own terms.
  poll_cursor      jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_polled_at   timestamptz,
  -- The last exchange that worked, either way.
  last_synced_at   timestamptz,
  last_error_code  text CHECK (last_error_code IS NULL OR length(last_error_code) <= 40),
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 300),

  connected_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at     timestamptz NOT NULL DEFAULT now(),
  disconnected_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crm_connections_scrubbed CHECK (status <> 'DISCONNECTED' OR secret IS NULL),
  CONSTRAINT crm_connections_keyed CHECK (secret IS NULL OR key_version IS NOT NULL)
);
-- One live CRM per organisation: "where does this lead go" has one answer.
CREATE UNIQUE INDEX crm_connections_one_live ON crm_connections (org_id) WHERE status <> 'DISCONNECTED';

-- ---------------------------------------------------------------------------
-- Their words for things, and what each one means here
-- ---------------------------------------------------------------------------
CREATE TABLE crm_mappings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,

  --   STAGE    one of their lead statuses        -> one of our nine stages
  --   PROJECT  one of their projects             -> one of our towers (PHASE)
  --   TOWER    one of their blocks, for units    -> one of our towers (PHASE)
  --   USER     one of their users                -> one of our people
  kind             text NOT NULL CHECK (kind IN ('STAGE', 'PROJECT', 'TOWER', 'USER')),
  external_id      text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  -- As they spell it, for the screen. A sub-status names its parent, a block its project.
  label            text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  parent_id        text CHECK (parent_id IS NULL OR length(parent_id) <= 200),
  parent_label     text CHECK (parent_label IS NULL OR length(parent_label) <= 200),
  -- Their own order, so the screen lists stages the way their pipeline reads.
  rank             integer NOT NULL DEFAULT 0,

  -- At most one of these, by kind. None and not ignored means it is waiting.
  stage            text CHECK (stage IS NULL OR stage IN (
                     'new', 'contacted', 'qualified', 'visit_scheduled', 'visit_done',
                     'negotiation', 'booked', 'nurture', 'lost')),
  scope_node_id    uuid REFERENCES scope_nodes(id) ON DELETE SET NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  -- A person said this means nothing to us (a project we do not sell).
  ignored          boolean NOT NULL DEFAULT false,
  -- For a STAGE: the one we set there when a lead moves to `stage` here.
  -- Theirs to ours is many to one; ours to theirs needs a choice.
  push_as          boolean NOT NULL DEFAULT false,

  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- NULL once the CRM stops listing it; kept, because events may still name it.
  last_seen_at     timestamptz DEFAULT now(),
  mapped_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  mapped_at        timestamptz,

  UNIQUE (connection_id, kind, external_id),
  CONSTRAINT crm_mappings_shape CHECK (
    (kind = 'STAGE' AND scope_node_id IS NULL AND user_id IS NULL) OR
    (kind IN ('PROJECT', 'TOWER') AND stage IS NULL AND user_id IS NULL) OR
    (kind = 'USER' AND stage IS NULL AND scope_node_id IS NULL)),
  CONSTRAINT crm_mappings_ignored CHECK (NOT ignored OR (stage IS NULL AND scope_node_id IS NULL AND user_id IS NULL)),
  CONSTRAINT crm_mappings_push CHECK (NOT push_as OR (kind = 'STAGE' AND stage IS NOT NULL))
);
CREATE UNIQUE INDEX crm_mappings_one_push ON crm_mappings (connection_id, stage) WHERE push_as;
CREATE INDEX crm_mappings_waiting ON crm_mappings (connection_id, kind)
  WHERE stage IS NULL AND scope_node_id IS NULL AND user_id IS NULL AND NOT ignored;

-- ---------------------------------------------------------------------------
-- Our lead and theirs, and what the two last agreed on
-- ---------------------------------------------------------------------------
CREATE TABLE crm_links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id      uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  lead_id            uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  external_id        text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  -- `crm-rules.ts` SyncValues: the base of the three-way merge.
  base               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A hash of their record as last read, so a poll can tell unchanged from changed.
  remote_hash        text CHECK (remote_hash IS NULL OR length(remote_hash) <= 64),
  synced_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id),
  UNIQUE (connection_id, lead_id)
);

-- ---------------------------------------------------------------------------
-- What the CRM sent, as it arrived
-- ---------------------------------------------------------------------------
CREATE TABLE crm_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  --   WEBHOOK  pushed by the CRM, keyed on its own event id
  --   POLL     read by us, keyed on their lead and a hash of what we read
  source           text NOT NULL CHECK (source IN ('WEBHOOK', 'POLL')),
  external_id      text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  kind             text NOT NULL CHECK (length(kind) BETWEEN 1 AND 60),
  payload          jsonb NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  attempts         smallint NOT NULL DEFAULT 0,
  processed_at     timestamptz,
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  --   CREATED | LINKED | UPDATED | UNCHANGED | IGNORED   done
  --   WAITING   on a mapping nobody has made; saving it releases the event
  --   FAILED    tried and refused; `error` says why
  outcome          text CHECK (outcome IN ('CREATED', 'LINKED', 'UPDATED', 'UNCHANGED', 'IGNORED', 'WAITING', 'FAILED')),
  waiting_on       text CHECK (waiting_on IN ('STAGE', 'PROJECT', 'USER')),
  waiting_for      text CHECK (waiting_for IS NULL OR length(waiting_for) <= 200),
  error            text CHECK (error IS NULL OR length(error) <= 500),
  -- A worker reading the CRM for this event holds it until then.
  claimed_until    timestamptz,
  UNIQUE (connection_id, source, external_id),
  CONSTRAINT crm_events_waiting CHECK ((outcome = 'WAITING') = (waiting_on IS NOT NULL))
);
CREATE INDEX crm_events_pending ON crm_events (org_id, received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- What we have to tell the CRM
-- ---------------------------------------------------------------------------
CREATE TABLE crm_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  --   LEAD  make their record match ours, creating it if there is none
  --   NOTE  add one line to their record: a call's summary, sent once
  op               text NOT NULL CHECK (op IN ('LEAD', 'NOTE')),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  -- A NOTE's subject ({ call_id }). A LEAD carries nothing: it is read at send time.
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,

  --   PENDING    due at `not_before`
  --   RUNNING    claimed under a lease; a change arriving now opens a new row,
  --              because this one may already have read the lead
  --   WAITING    needs a mapping nobody has made
  --   DONE       the CRM confirmed it
  --   DEAD       refused for good, or out of attempts; a person can retry it
  --   CANCELLED  the connection went away
  status           text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'RUNNING', 'WAITING', 'DONE', 'DEAD', 'CANCELLED')),
  waiting_on       text CHECK (waiting_on IN ('STAGE', 'PROJECT', 'USER')),
  waiting_for      text CHECK (waiting_for IS NULL OR length(waiting_for) <= 200),
  attempts         smallint NOT NULL DEFAULT 0,
  not_before       timestamptz NOT NULL DEFAULT now(),
  lease_id         uuid,
  lease_until      timestamptz,
  -- What the CRM confirmed so far, and what was tried and never answered.
  steps            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error_code  text CHECK (last_error_code IS NULL OR length(last_error_code) <= 40),
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  done_at          timestamptz,
  UNIQUE (connection_id, idempotency_key),
  CONSTRAINT crm_outbox_waiting CHECK ((status = 'WAITING') = (waiting_on IS NOT NULL))
);
-- One open "this lead changed" per lead: ten edits are one request.
CREATE UNIQUE INDEX crm_outbox_one_open_lead ON crm_outbox (connection_id, lead_id)
  WHERE op = 'LEAD' AND status IN ('PENDING', 'WAITING');
CREATE INDEX crm_outbox_due ON crm_outbox (org_id, not_before) WHERE status IN ('PENDING', 'RUNNING');

-- ---------------------------------------------------------------------------
-- The trigger: a change to a lead is a row in the outbox, in the same
-- transaction, whichever path wrote it
-- ---------------------------------------------------------------------------
--
-- It runs as whoever wrote the lead, so RLS holds: the row lands in the
-- lead's own org or nowhere. With no live connection it does nothing.
-- Inbound sync writes set `app.crm_inbound` so an echo is not re-sent; the
-- merge would find nothing to send anyway, and this saves the request.
CREATE FUNCTION crm_mark_lead() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conn uuid;
BEGIN
  IF coalesce(current_setting('app.crm_inbound', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT id INTO conn FROM crm_connections
    WHERE org_id = NEW.org_id AND status = 'CONNECTED' LIMIT 1;
  IF conn IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO crm_outbox (org_id, connection_id, lead_id, op, idempotency_key)
  VALUES (NEW.org_id, conn, NEW.id, 'LEAD', 'lead:' || NEW.id || ':' || gen_random_uuid())
  ON CONFLICT (connection_id, lead_id) WHERE op = 'LEAD' AND status IN ('PENDING', 'WAITING')
  DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_crm_insert AFTER INSERT ON leads
  FOR EACH ROW EXECUTE FUNCTION crm_mark_lead();
-- Only the fields the CRM shares. `last_activity_at` moves on every call and
-- would otherwise turn every heartbeat into a request.
CREATE TRIGGER leads_crm_update AFTER UPDATE OF name, email, stage, facts, owner_id, exit_reason ON leads
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.email IS DISTINCT FROM NEW.email OR
    OLD.stage IS DISTINCT FROM NEW.stage OR OLD.facts IS DISTINCT FROM NEW.facts OR
    OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.exit_reason IS DISTINCT FROM NEW.exit_reason)
  EXECUTE FUNCTION crm_mark_lead();

-- A call that ended is one line on their record, once.
CREATE FUNCTION crm_mark_call() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conn uuid;
BEGIN
  SELECT id INTO conn FROM crm_connections
    WHERE org_id = NEW.org_id AND status = 'CONNECTED' LIMIT 1;
  IF conn IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO crm_outbox (org_id, connection_id, lead_id, op, idempotency_key, payload)
  VALUES (NEW.org_id, conn, NEW.lead_id, 'NOTE', 'call:' || NEW.id, jsonb_build_object('call_id', NEW.id))
  ON CONFLICT (connection_id, idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER calls_crm_done AFTER UPDATE OF status ON calls
  FOR EACH ROW WHEN (NEW.status = 'DONE' AND OLD.status IS DISTINCT FROM 'DONE')
  EXECUTE FUNCTION crm_mark_call();

-- A lead that came from the CRM says so.
ALTER TABLE leads DROP CONSTRAINT leads_channel_check;
ALTER TABLE leads ADD CONSTRAINT leads_channel_check
  CHECK (channel IN ('META_FORM', 'GOOGLE_FORM', 'WEBSITE', 'MANUAL', 'CRM'));

-- ---------------------------------------------------------------------------
-- Inventory: one row per flat
-- ---------------------------------------------------------------------------
CREATE TABLE units (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- A PHASE, enforced in `inventory.ts`, the arrangement `unit_types` has.
  scope_node_id      uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  -- The product this flat is. NULL until its configuration matches one we
  -- recorded; the flat is still counted, and the screen says it is unmatched.
  unit_type_id       uuid REFERENCES unit_types(id) ON DELETE SET NULL,
  -- A wing inside the tower, when the sheet names one ("A", "Wing B").
  wing               text CHECK (wing IS NULL OR length(wing) BETWEEN 1 AND 40),
  unit_no            text NOT NULL CHECK (length(unit_no) BETWEEN 1 AND 40),
  floor              smallint CHECK (floor BETWEEN -5 AND 200),
  -- From the catalog in `unit-rules.ts` ("2 BHK"), or NULL when unreadable.
  config             text CHECK (config IS NULL OR length(config) <= 40),
  carpet_sqft        numeric(8, 2) CHECK (carpet_sqft IS NULL OR carpet_sqft > 0),
  facing             text CHECK (facing IN ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')),
  status             text NOT NULL CHECK (status IN ('AVAILABLE', 'BLOCKED', 'BOOKED')),
  --   CRM     their record; a later import does not overwrite it
  --   IMPORT  the developer's availability sheet
  source             text NOT NULL CHECK (source IN ('CRM', 'IMPORT')),
  external_id        text CHECK (external_id IS NULL OR length(external_id) <= 200),
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX units_one_per_number ON units (org_id, scope_node_id, coalesce(wing, ''), unit_no);
CREATE INDEX units_availability ON units (org_id, scope_node_id, status, config);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON crm_connections TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE ON crm_mappings TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE ON crm_links TO salesdesk_app;
GRANT SELECT, INSERT ON crm_events TO salesdesk_app;
-- The payload is what arrived; only what became of it is ever written back.
GRANT UPDATE (attempts, processed_at, lead_id, outcome, waiting_on, waiting_for, error, claimed_until) ON crm_events TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE ON crm_outbox TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE ON units TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------
ALTER TABLE crm_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_connections_isolation ON crm_connections
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE crm_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_mappings_isolation ON crm_mappings
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE crm_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_links_isolation ON crm_links
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE crm_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_events_isolation ON crm_events
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE crm_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_outbox_isolation ON crm_outbox
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
CREATE POLICY units_isolation ON units
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
