-- ---------------------------------------------------------------------------
-- 0038  What became of a lead, told back to the platform that bought it
-- ---------------------------------------------------------------------------
--
-- Section 09. Meta and Google bid on whatever the advertiser says converted,
-- and every developer says a form fill. What matters (a qualified buyer, a
-- site visit, a booking) happens offline, days or months later. This is the
-- log those outcomes are told from, and the record of what each platform was
-- told and when.
--
-- ONE ROW PER OUTCOME, NEVER EDITED
--
-- The app role inserts and reads `outcome_events`; it never updates or
-- deletes one. A booking that falls through is a CANCELLED row pointing at
-- the booking, not an edit of it.
--
-- THE ID IS THE PLATFORMS' KEY
--
-- A ULID made in code. It is Meta's event_id and Google's transaction id, so
-- a send that lands twice is one conversion on both.
--
-- THE LINEAGE IS COPIED, NOT JOINED
--
-- The leadgen id, gclid, fbc and UTM tags as they stood when the outcome
-- happened. Never a phone number or an email: the phone is hashed at the
-- moment of sending and the hash is stored nowhere.
--
-- ONCE, WHERE ONCE IS THE TRUTH
--
-- A lead is qualified once and has its first site visit once, however often
-- a person moves its card back and forth. An agreement, a registration and a
-- cancellation each belong to one booking, once.
--
-- UPLOADS ARE A QUEUE BESIDE THE LOG
--
-- `outcome_uploads` is one row per outcome per platform, leased like
-- `lead_tasks`. It records why an outcome was not sent (no consent, no
-- click id, too old, cancelled inside the hold) as a code, because "not
-- sent" with no reason is a status nobody can act on. `tried_at` without
-- `sent_at` is a send whose answer never came back.
--
-- NOTHING HERE ASKS THE RERA GATE
--
-- A phase that stopped being advertisable halts the publisher. It does not
-- halt this: telling a platform what spend already made became is reporting,
-- not advertising.

-- ---------------------------------------------------------------------------
-- The log
-- ---------------------------------------------------------------------------
CREATE TABLE outcome_events (
  id                text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('QUALIFIED', 'VISIT_DONE', 'BOOKED', 'AGREEMENT', 'REGISTERED', 'CANCELLED')),
  occurred_at       timestamptz NOT NULL,
  -- The booking an agreement, a registration or a cancellation belongs to.
  booking_id        text REFERENCES outcome_events(id) ON DELETE CASCADE,
  -- The tower the lead was about when it happened.
  scope_node_id     uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  publish_target_id uuid REFERENCES publish_targets(id) ON DELETE SET NULL,
  -- Rupees, frozen at write, so changing the values later does not change
  -- what an outcome was already worth.
  value             integer NOT NULL DEFAULT 0 CHECK (value BETWEEN 0 AND 100000000),
  lineage           jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (NOT (lineage ? 'phone') AND NOT (lineage ? 'email')),
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcome_events_booking CHECK ((kind IN ('AGREEMENT', 'REGISTERED', 'CANCELLED')) = (booking_id IS NOT NULL))
);
CREATE UNIQUE INDEX outcome_events_once ON outcome_events (lead_id, kind) WHERE kind IN ('QUALIFIED', 'VISIT_DONE');
CREATE UNIQUE INDEX outcome_events_per_booking ON outcome_events (booking_id, kind) WHERE booking_id IS NOT NULL;
CREATE INDEX outcome_events_lead ON outcome_events (lead_id, occurred_at);
CREATE INDEX outcome_events_org ON outcome_events (org_id, occurred_at DESC);

GRANT SELECT, INSERT ON outcome_events TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- What an outcome is worth, and how long a booking waits
-- ---------------------------------------------------------------------------
--
-- No row means the defaults. Values are fixed rupees, never the agreement
-- value: the developer's prices are not the platforms' business, and the
-- ratios are what tell a bidder a visit matters more than a form.
CREATE TABLE attribution_settings (
  org_id           uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  value_qualified  integer NOT NULL DEFAULT 2000 CHECK (value_qualified BETWEEN 0 AND 10000000),
  value_visit      integer NOT NULL DEFAULT 10000 CHECK (value_visit BETWEEN 0 AND 10000000),
  value_booking    integer NOT NULL DEFAULT 100000 CHECK (value_booking BETWEEN 0 AND 10000000),
  -- A booking is sent once it has stood this long. Neither platform can
  -- take a conversion back, so one cancelled inside the hold is never sent.
  hold_days        smallint NOT NULL DEFAULT 30 CHECK (hold_days BETWEEN 0 AND 60),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON attribution_settings TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Consent to measure, separate from consent to be contacted
-- ---------------------------------------------------------------------------
--
-- Agreeing to a call is not agreeing to have a platform told whether you
-- booked. A lead with no `ad_measurement` consent on file is never uploaded.
ALTER TABLE lead_consents DROP CONSTRAINT lead_consents_channels_check;
ALTER TABLE lead_consents ADD CONSTRAINT lead_consents_channels_check
  CHECK (channels <@ ARRAY['call', 'whatsapp', 'sms', 'ad_measurement']::text[] AND cardinality(channels) > 0);

-- ---------------------------------------------------------------------------
-- Where outcomes go: a Meta dataset, and a Google Ads account's actions
-- ---------------------------------------------------------------------------
ALTER TABLE connection_accounts DROP CONSTRAINT connection_accounts_kind_check;
ALTER TABLE connection_accounts ADD CONSTRAINT connection_accounts_kind_check
  CHECK (kind IN ('FACEBOOK_PAGE', 'INSTAGRAM', 'META_AD_ACCOUNT', 'META_DATASET',
                  'GOOGLE_ADS_CUSTOMER', 'GOOGLE_BUSINESS_LOCATION'));

-- One Google conversion action per outcome per Ads account, created by us
-- and remembered, because Google refuses a second action of the same name.
CREATE TABLE conversion_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES connection_accounts(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('QUALIFIED', 'VISIT_DONE', 'BOOKED', 'AGREEMENT', 'REGISTERED')),
  external_id    text NOT NULL CHECK (external_id ~ '^[0-9]{1,20}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind)
);

GRANT SELECT, INSERT ON conversion_actions TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------
CREATE TABLE outcome_uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  event_id     text NOT NULL REFERENCES outcome_events(id) ON DELETE CASCADE,
  platform     text NOT NULL CHECK (platform IN ('META', 'GOOGLE')),
  --   WAITING    held (a booking inside its hold) or waiting on setup
  --   QUEUED     due to go at not_before
  --   SENDING    leased by a worker
  --   SENT       the platform accepted it
  --   NOT_SENT   will never go, and `reason` says why
  --   FAILED     the platform refused it, or it ran out of attempts
  state        text NOT NULL CHECK (state IN ('WAITING', 'QUEUED', 'SENDING', 'SENT', 'NOT_SENT', 'FAILED')),
  reason       text CHECK (reason IS NULL OR reason ~ '^[A-Z_]{2,40}$'),
  -- The Meta dataset or Google Ads account it went to.
  account_id   uuid REFERENCES connection_accounts(id) ON DELETE SET NULL,
  not_before   timestamptz NOT NULL DEFAULT now(),
  attempts     smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  lease_id     uuid,
  lease_until  timestamptz,
  -- Set before a request goes out; with no sent_at after it, the answer was lost.
  tried_at     timestamptz,
  sent_at      timestamptz,
  error        text CHECK (error IS NULL OR length(error) <= 300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, platform),
  CONSTRAINT outcome_uploads_sent CHECK ((state = 'SENT') = (sent_at IS NOT NULL)),
  CONSTRAINT outcome_uploads_reason CHECK (state NOT IN ('NOT_SENT', 'WAITING') OR reason IS NOT NULL)
);
CREATE INDEX outcome_uploads_due ON outcome_uploads (org_id, not_before) WHERE state IN ('QUEUED', 'SENDING', 'WAITING');

GRANT SELECT, INSERT ON outcome_uploads TO salesdesk_app;
GRANT UPDATE (state, reason, account_id, not_before, attempts, lease_id, lease_until, tried_at, sent_at, error, updated_at)
  ON outcome_uploads TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE outcome_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY outcome_events_isolation ON outcome_events
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE attribution_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY attribution_settings_isolation ON attribution_settings
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE conversion_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversion_actions_isolation ON conversion_actions
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE outcome_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY outcome_uploads_isolation ON outcome_uploads
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
