-- ===========================================================================
--  0026_lead_engine  --  from an ad to a booking: the lead pipeline, what
--                        the product does next for each lead, the messages
--                        and site visits, and the ad figures budget moves on
--
--  0024 stored one lead and one call placed by hand. This is the rest of the
--  journey section 02 draws: a lead captured from a Meta or Google form or
--  the developer's website, called at once (or messaged and called at ten
--  the next morning), followed up on a cadence, sent the site's location
--  when a visit is booked, reminded, recovered after a no-show, followed up
--  after the visit, and kept warm after the booking.
--
--  A LEAD IS A PIPELINE CARD, NOT A CONTACT
--
--  `leads` gains the stage the board draws and the facts that stage needs,
--  held in the same shape `lead-rules.ts` checks them in, so the board, the
--  engine and a person moving a card cannot disagree about what a stage
--  means. Who moved it and why goes to `lead_activity`, append only.
--
--  WHAT HAPPENS NEXT IS A ROW
--
--  `lead_tasks` is the cadence: a call, a message or a check, each due at an
--  instant and claimed under a lease the way `post_runs` are. Each carries a
--  dedupe key computed from the lead and the step, so a webhook delivered
--  twice schedules one follow-up, not two. Every task that spends money is
--  refused before it spends: the opt-out, the hours, the consent, the RERA
--  gate and the project's minute allowance are asked when it runs, not when
--  it was scheduled.
--
--  THE RAW CAPTURE IS KEPT
--
--  `lead_events` is what a form sent, as it arrived, unique on the platform's
--  own id. A delivery Meta retries lands on the row already there. The event
--  is the replay source when parsing was wrong; the lead is what came of it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The lead, as the pipeline sees it
-- ---------------------------------------------------------------------------
ALTER TABLE leads
  ADD COLUMN email            text CHECK (email IS NULL OR (length(email) <= 200 AND email LIKE '%_@_%')),
  ADD COLUMN stage            text NOT NULL DEFAULT 'new' CHECK (stage IN (
                                'new', 'contacted', 'qualified', 'visit_scheduled', 'visit_done',
                                'negotiation', 'booked', 'nurture', 'lost')),
  -- For a side lane, the path stage it left from.
  ADD COLUMN path_stage       text NOT NULL DEFAULT 'new' CHECK (path_stage IN (
                                'new', 'contacted', 'qualified', 'visit_scheduled', 'visit_done',
                                'negotiation', 'booked')),
  -- `lead-rules.ts` Facts: every value a string, a date as YYYY-MM-DD.
  ADD COLUMN facts            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN exit_reason      text CHECK (exit_reason IS NULL OR length(exit_reason) <= 120),
  ADD COLUMN follow_up_on     date,
  ADD COLUMN temperature      text CHECK (temperature IN ('HOT', 'WARM', 'COLD')),
  ADD COLUMN owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  --   META_FORM    a Meta lead ad's instant form
  --   GOOGLE_FORM  a Google Ads lead form
  --   WEBSITE      the developer's own site or landing page
  --   MANUAL       typed in the console
  ADD COLUMN channel          text NOT NULL DEFAULT 'MANUAL'
                                CHECK (channel IN ('META_FORM', 'GOOGLE_FORM', 'WEBSITE', 'MANUAL')),
  -- The platform's id for this enquiry, so a second delivery is one lead.
  ADD COLUMN external_id      text CHECK (external_id IS NULL OR length(external_id) <= 200),
  -- The advertisement it came from, when we published it.
  ADD COLUMN publish_target_id uuid REFERENCES publish_targets(id) ON DELETE SET NULL,
  -- Campaign, ad set, ad, form, gclid, utm_*: captured here or never.
  ADD COLUMN lineage          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Why a person has to act. NULL means the agent has it.
  ADD COLUMN needs_person     text CHECK (needs_person IS NULL OR length(needs_person) <= 200),
  --   ON       the engine calls and messages on its cadence
  --   PAUSED   a person took it over; nothing automatic goes out
  ADD COLUMN automation       text NOT NULL DEFAULT 'ON' CHECK (automation IN ('ON', 'PAUSED')),
  ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at       timestamptz NOT NULL DEFAULT now(),
  -- A side lane remembers why; the path does not carry a stale reason.
  ADD CONSTRAINT leads_exit_shape CHECK ((stage IN ('nurture', 'lost')) = (exit_reason IS NOT NULL));

CREATE UNIQUE INDEX leads_external ON leads (org_id, channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX leads_org_stage ON leads (org_id, stage, last_activity_at DESC);
CREATE INDEX leads_target ON leads (publish_target_id) WHERE publish_target_id IS NOT NULL;

-- 0024 held a lead as a thing written once. A pipeline card moves.
GRANT UPDATE ON leads TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- What a form sent, as it arrived
-- ---------------------------------------------------------------------------
CREATE TABLE lead_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (source IN ('META_FORM', 'GOOGLE_FORM', 'WEBSITE')),
  external_id   text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  attempts      smallint NOT NULL DEFAULT 0,
  processed_at  timestamptz,
  lead_id       uuid REFERENCES leads(id) ON DELETE SET NULL,
  --   CREATED | MERGED | JUNK | FAILED, and the reason when it was not a lead
  outcome       text CHECK (outcome IN ('CREATED', 'MERGED', 'JUNK', 'FAILED')),
  error         text CHECK (error IS NULL OR length(error) <= 500),
  UNIQUE (org_id, source, external_id)
);
CREATE INDEX lead_events_pending ON lead_events (org_id, received_at) WHERE processed_at IS NULL;

GRANT SELECT, INSERT ON lead_events TO salesdesk_app;
-- The payload is what arrived; only what became of it is ever written back.
GRANT UPDATE (attempts, processed_at, lead_id, outcome, error) ON lead_events TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- What happened to a lead, in order. Append only.
-- ---------------------------------------------------------------------------
CREATE TABLE lead_activity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  --   CAPTURED    arrived from a form, a site or a person
  --   STAGE       moved on the board, by a person or by the engine
  --   ASSIGNED    given an owner
  --   AUTOMATION  paused or resumed
  --   NOTE        a person wrote something down
  kind          text NOT NULL CHECK (kind IN ('CAPTURED', 'STAGE', 'ASSIGNED', 'AUTOMATION', 'NOTE')),
  from_stage    text,
  to_stage      text,
  reason        text CHECK (reason IS NULL OR length(reason) <= 200),
  note          text CHECK (note IS NULL OR length(note) <= 1000),
  -- NULL is the engine.
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_activity_lead ON lead_activity (lead_id, at DESC);

GRANT SELECT, INSERT ON lead_activity TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- A site, where a buyer is sent. Resolved downward like the brand kit.
-- ---------------------------------------------------------------------------
CREATE TABLE site_locations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  address        text CHECK (address IS NULL OR length(address) <= 300),
  latitude       numeric(9, 6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude      numeric(9, 6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  -- The link a buyer taps. Built from the pin when there is one.
  maps_url       text NOT NULL CHECK (maps_url ~ '^https://' AND length(maps_url) <= 500),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope_node_id),
  CONSTRAINT site_locations_pin CHECK ((latitude IS NULL) = (longitude IS NULL))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON site_locations TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- A site visit
-- ---------------------------------------------------------------------------
CREATE TABLE site_visits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  -- The tower. A visit names a phase the way a call does.
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  scheduled_at   timestamptz NOT NULL,
  --   CONFIRMED  booked, waiting for the day
  --   ON_SITE    checked in by the site team
  --   VISITED    the host recorded how it went
  --   NO_SHOW    the slot passed with nobody checked in
  --   LAPSED     a no-show nobody recovered in 72 hours
  --   MOVED      replaced by another visit, named in `moved_to`
  --   CANCELLED  called off
  status         text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN (
                   'CONFIRMED', 'ON_SITE', 'VISITED', 'NO_SHOW', 'LAPSED', 'MOVED', 'CANCELLED')),
  booked_via     text NOT NULL CHECK (booked_via IN ('AI_CALL', 'CONSOLE')),
  -- What the buyer said when they booked, as the agent heard it.
  asked_for      text CHECK (asked_for IS NULL OR length(asked_for) <= 200),
  host_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  call_id        uuid REFERENCES calls(id) ON DELETE SET NULL,
  arrived_at     timestamptz,
  completed_at   timestamptz,
  -- { interest, objection, next, note }
  outcome        jsonb,
  moved_to       uuid REFERENCES site_visits(id) ON DELETE SET NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_visits_moved CHECK ((status = 'MOVED') = (moved_to IS NOT NULL)),
  CONSTRAINT site_visits_outcome CHECK (status <> 'VISITED' OR outcome IS NOT NULL)
);
CREATE INDEX site_visits_org_when ON site_visits (org_id, scheduled_at);
CREATE INDEX site_visits_lead ON site_visits (lead_id);

GRANT SELECT, INSERT, UPDATE ON site_visits TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- What the engine does next for a lead
-- ---------------------------------------------------------------------------
CREATE TABLE lead_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  visit_id     uuid REFERENCES site_visits(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('CALL', 'MESSAGE', 'CHECK')),
  -- The step in the cadence. `cadence-rules.ts` holds the catalog.
  purpose      text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 40),
  due_at       timestamptz NOT NULL,
  --   DUE        waiting for its time
  --   WORKING    a worker holds it
  --   DONE       it ran
  --   SKIPPED    it was no longer right to run (a gate, a stage that moved on)
  --   CANCELLED  a person or an opt-out called it off
  --   FAILED     three attempts, and it still could not run
  state        text NOT NULL DEFAULT 'DUE' CHECK (state IN (
                 'DUE', 'WORKING', 'DONE', 'SKIPPED', 'CANCELLED', 'FAILED')),
  -- The lead and the step, so the same step scheduled twice is one row.
  dedupe_key   text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  attempts     smallint NOT NULL DEFAULT 0,
  lease_id     uuid,
  lease_until  timestamptz,
  result       text CHECK (result IS NULL OR length(result) <= 300),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  UNIQUE (org_id, dedupe_key)
);
CREATE INDEX lead_tasks_due ON lead_tasks (org_id, state, due_at);
CREATE INDEX lead_tasks_lead ON lead_tasks (lead_id, due_at);

GRANT SELECT, INSERT, UPDATE ON lead_tasks TO salesdesk_app;

-- A call now names the step it was placed for, and which try it was.
ALTER TABLE calls
  ADD COLUMN task_id uuid REFERENCES lead_tasks(id) ON DELETE SET NULL,
  ADD COLUMN attempt smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20);
ALTER TABLE calls DROP CONSTRAINT calls_agent_check;
ALTER TABLE calls ADD CONSTRAINT calls_agent_check
  CHECK (agent IN ('qualifier', 'reminder', 'recovery', 'reengage'));
CREATE INDEX calls_lead ON calls (lead_id, placed_at DESC);
CREATE INDEX calls_live ON calls (org_id, status) WHERE status IN ('PLACING', 'DIALLING');

-- ---------------------------------------------------------------------------
-- WhatsApp, both ways
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id       uuid REFERENCES leads(id) ON DELETE RESTRICT,
  task_id       uuid REFERENCES lead_tasks(id) ON DELETE SET NULL,
  direction     text NOT NULL CHECK (direction IN ('OUT', 'IN')),
  channel       text NOT NULL DEFAULT 'WHATSAPP' CHECK (channel IN ('WHATSAPP')),
  purpose       text CHECK (purpose IS NULL OR length(purpose) <= 40),
  template      text CHECK (template IS NULL OR length(template) <= 120),
  --   UTILITY    Rs 0.115, a transaction the buyer started
  --   MARKETING  Rs 0.8631, a nudge; only inside calling hours
  --   SERVICE    a reply inside the 24-hour window, free
  category      text CHECK (category IN ('UTILITY', 'MARKETING', 'SERVICE')),
  language      text,
  variables     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What the buyer reads (or wrote), as text.
  body          text NOT NULL CHECK (length(body) <= 4096),
  -- The buyer's number: who it went to, or who it came from.
  phone         text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  --   QUEUED, SENT, DELIVERED, READ, FAILED   an outbound message's life
  --   REFUSED   a gate said no before anything was sent; `error` says which
  --   RECEIVED  an inbound message
  status        text NOT NULL CHECK (status IN (
                  'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'REFUSED', 'RECEIVED')),
  provider_id   text CHECK (provider_id IS NULL OR length(provider_id) <= 200),
  error         text CHECK (error IS NULL OR length(error) <= 500),
  -- What Meta charges us, in paise, before our 15 per cent. NULL when free.
  cost_paise    integer CHECK (cost_paise IS NULL OR cost_paise >= 0),
  sent_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz
);
CREATE UNIQUE INDEX messages_provider ON messages (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX messages_lead ON messages (lead_id, created_at DESC);
CREATE INDEX messages_org_phone ON messages (org_id, phone, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON messages TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The client's automation rules, beside the calling policy they extend
-- ---------------------------------------------------------------------------
ALTER TABLE calling_settings
  -- Call and message new leads without anybody pressing anything.
  ADD COLUMN auto_outreach    boolean,
  -- AI call minutes a project may use in a calendar month. A cap, not a bill.
  ADD COLUMN minute_allowance integer CHECK (minute_allowance IS NULL OR minute_allowance BETWEEN 0 AND 1000000),
  -- Calls at once, pooled across a project's agents.
  ADD COLUMN channel_limit    smallint CHECK (channel_limit IS NULL OR channel_limit BETWEEN 1 AND 50);

-- ---------------------------------------------------------------------------
-- What each ad did, per day, as the platform reports it
-- ---------------------------------------------------------------------------
CREATE TABLE ad_stats (
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  publish_target_id uuid NOT NULL REFERENCES publish_targets(id) ON DELETE CASCADE,
  day               date NOT NULL,
  spend_paise       bigint NOT NULL DEFAULT 0 CHECK (spend_paise >= 0),
  impressions       bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks            bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  platform_leads    integer NOT NULL DEFAULT 0 CHECK (platform_leads >= 0),
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publish_target_id, day)
);
CREATE INDEX ad_stats_org_day ON ad_stats (org_id, day);

GRANT SELECT, INSERT, UPDATE ON ad_stats TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Moving budget to what works
-- ---------------------------------------------------------------------------
--
-- Off until somebody holding the budget key switches it on for an ad
-- account: spend authority is recorded, never assumed. On, the daily pass
-- moves money between that account's live ads for one project, keeping the
-- total the same, a bounded step at a time. Every move is a row.
ALTER TABLE connection_accounts
  ADD COLUMN auto_budget    boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_budget_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN auto_budget_at timestamptz;

CREATE TABLE budget_shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES connection_accounts(id) ON DELETE CASCADE,
  publish_target_id uuid NOT NULL REFERENCES publish_targets(id) ON DELETE CASCADE,
  from_budget       integer NOT NULL CHECK (from_budget > 0),
  to_budget         integer NOT NULL CHECK (to_budget > 0),
  -- Which rule fired, and the numbers it read. Structured, never prose.
  rule              text NOT NULL CHECK (rule IN ('SCALE_UP', 'SCALE_DOWN')),
  metrics           jsonb NOT NULL DEFAULT '{}'::jsonb,
  state             text NOT NULL CHECK (state IN ('APPLIED', 'FAILED')),
  error             text CHECK (error IS NULL OR length(error) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_shifts_target ON budget_shifts (publish_target_id, created_at DESC);
CREATE INDEX budget_shifts_org ON budget_shifts (org_id, created_at DESC);

-- A record of money moved. Never edited, never removed by the application.
GRANT SELECT, INSERT ON budget_shifts TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The platforms' callbacks name a Page or a phone, not a tenant
-- ---------------------------------------------------------------------------
--
-- A Meta lead form's webhook says which Page it came from and nothing else,
-- and a WhatsApp reply says which number wrote. Finding the tenant means
-- reading across tenants, so each is one SECURITY DEFINER function that
-- returns ids and nothing else, the pattern 0023 set. What is done with the
-- answer happens back inside `withTenant()`.
CREATE FUNCTION lead_page_owners(p_page_id text)
RETURNS TABLE (org_id uuid, account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.org_id, a.id FROM connection_accounts a
  JOIN connections c ON c.id = a.connection_id
  WHERE a.kind = 'FACEBOOK_PAGE'
    AND a.external_id = p_page_id
    AND a.active
    AND c.status <> 'DISCONNECTED'
    AND p_page_id ~ '^[0-9]{1,40}$';
$$;
REVOKE ALL ON FUNCTION lead_page_owners(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lead_page_owners(text) TO salesdesk_app;

-- The organisations that wrote to this number in the last 30 days. A reply
-- or a STOP belongs to whoever the buyer was answering.
CREATE FUNCTION message_orgs_for_phone(p_phone text)
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT m.org_id FROM messages m
  WHERE m.phone = p_phone
    AND m.direction = 'OUT'
    AND m.created_at > now() - interval '30 days'
    AND p_phone ~ '^\+[1-9][0-9]{7,14}$';
$$;
REVOKE ALL ON FUNCTION message_orgs_for_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message_orgs_for_phone(text) TO salesdesk_app;

-- The organisation that sent one message, for its delivery receipts.
CREATE FUNCTION message_org(p_provider_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.org_id FROM messages m
  WHERE m.provider_id = p_provider_id AND length(p_provider_id) BETWEEN 1 AND 200
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION message_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message_org(text) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_events_isolation ON lead_events
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE lead_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_activity_isolation ON lead_activity
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE site_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_locations_isolation ON site_locations
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE site_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_visits_isolation ON site_visits
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE lead_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_tasks_isolation ON lead_tasks
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_isolation ON messages
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE ad_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY ad_stats_isolation ON ad_stats
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE budget_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_shifts_isolation ON budget_shifts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
