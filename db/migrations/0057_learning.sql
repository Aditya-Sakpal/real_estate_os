-- ---------------------------------------------------------------------------
-- 0057  Learning what works: competitor ads, the scores, the playbook
-- ---------------------------------------------------------------------------
--
-- Every campaign should teach the next one. Two sources, blended:
--
--   our own ads    what each ingredient (the angle, the format, the template,
--                  the language, the picture) cost per qualified buyer, from
--                  the spend and the outcomes 0038 records;
--   the market     what competitors run, and for how long, from ads a
--                  person saved (`competitor_ads`, per tenant) and from a
--                  library Sales Desk keeps by hand (`market_ads`, shared).
--
-- The market leads while a project has little of its own, and our own
-- results take over as they come in: the market counts like
-- `market_weight` qualified buyers of evidence (20 by default).
--
-- NOTHING IS SCRAPED
--
-- There is no API for Indian commercial ads on Meta or Google, and Meta's
-- terms forbid collecting from its products by machine. A competitor ad is
-- saved by a person who saw it, or by our team for the shared library.
--
-- NOTHING OF A COMPETITOR'S IS EVER PRINTED
--
-- Only the pattern is learnt (it led on connectivity, it was a carousel).
-- Their words, numbers and pictures never reach our copy or our designs,
-- and every creative still goes through every gate it went through before.
--
-- A PICTURE, NEVER THE VIDEO
--
-- A competitor video is read (three frames and its sound) and only one
-- frame is kept, in the row: there is no reason to hold another developer's
-- film, and bytes in a row are guarded by the same RLS as everything else.

-- ---------------------------------------------------------------------------
-- A competitor ad a person saved, per tenant
-- ---------------------------------------------------------------------------
CREATE TABLE competitor_ads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Which of our projects or towers it is compared with.
  scope_node_id   uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  competitor      text NOT NULL CHECK (length(competitor) BETWEEN 1 AND 120),
  project_name    text CHECK (project_name IS NULL OR length(project_name) <= 120),
  locality        text CHECK (locality IS NULL OR length(locality) <= 120),
  platform        text NOT NULL CHECK (platform IN ('META', 'GOOGLE', 'YOUTUBE', 'PORTAL', 'PRINT', 'OTHER')),
  kind            text NOT NULL CHECK (kind IN ('IMAGE', 'CAROUSEL', 'VIDEO')),
  -- "Started running on", from the ad library. A long run is the best sign
  -- an outsider gets that an ad works.
  running_since   date,
  seen_on         date NOT NULL DEFAULT current_date,
  poster          bytea CHECK (poster IS NULL OR octet_length(poster) <= 5 * 1024 * 1024),
  poster_type     text CHECK (poster_type IS NULL OR poster_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- What the ad says: the words on it, and for a video what is said.
  text_seen       text CHECK (text_seen IS NULL OR length(text_seen) <= 4000),
  -- The same ingredients our own ads are scored by, as the reader saw them.
  tags            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Claims no ad of ours may make ("assured returns"): kept, never recommended.
  flags           text[] NOT NULL DEFAULT '{}',
  read_state      text NOT NULL CHECK (read_state IN ('READ', 'FAILED')),
  read_error      text CHECK (read_error IS NULL OR length(read_error) <= 300),
  -- What reading it cost us, for the margin report. Never charged.
  read_cost_usd   numeric(8, 5) NOT NULL DEFAULT 0 CHECK (read_cost_usd >= 0),
  added_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competitor_ads_poster CHECK ((poster IS NULL) = (poster_type IS NULL))
);
CREATE INDEX competitor_ads_node ON competitor_ads (org_id, scope_node_id, created_at DESC);

-- A saved ad is the team's own swipe file: they add it, correct nothing in
-- it (it is what the reader saw), and remove it when it was a mistake.
GRANT SELECT, INSERT, DELETE ON competitor_ads TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The market library Sales Desk keeps, shared by every tenant
-- ---------------------------------------------------------------------------
--
-- Public advertisements from India's large developers, read by our team the
-- way the 26 September 2026 study was. No org_id and no RLS, like
-- `occasions`: the app reads it and never writes it, because a tenant that
-- could write it could steer every other tenant's creative.
CREATE TABLE market_ads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  developer       text NOT NULL CHECK (length(developer) BETWEEN 1 AND 120),
  project_name    text CHECK (project_name IS NULL OR length(project_name) <= 120),
  city            text CHECK (city IS NULL OR length(city) <= 80),
  locality        text CHECK (locality IS NULL OR length(locality) <= 120),
  -- The cheapest price the ad names, when it names one, in rupees.
  price_from      bigint CHECK (price_from IS NULL OR price_from > 0),
  platform        text NOT NULL CHECK (platform IN ('META', 'GOOGLE', 'YOUTUBE', 'PORTAL', 'PRINT', 'OTHER')),
  kind            text NOT NULL CHECK (kind IN ('IMAGE', 'CAROUSEL', 'VIDEO')),
  running_since   date,
  seen_on         date NOT NULL DEFAULT current_date,
  poster          bytea CHECK (poster IS NULL OR octet_length(poster) <= 5 * 1024 * 1024),
  poster_type     text CHECK (poster_type IS NULL OR poster_type IN ('image/png', 'image/jpeg', 'image/webp')),
  text_seen       text CHECK (text_seen IS NULL OR length(text_seen) <= 4000),
  tags            jsonb NOT NULL DEFAULT '{}'::jsonb,
  flags           text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_ads_poster CHECK ((poster IS NULL) = (poster_type IS NULL))
);
CREATE INDEX market_ads_city ON market_ads (city, seen_on DESC);

GRANT SELECT ON market_ads TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- How much the market counts, per tenant
-- ---------------------------------------------------------------------------
CREATE TABLE learning_settings (
  org_id          uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  -- The market counts like this many qualified buyers of our own.
  market_weight   integer NOT NULL DEFAULT 20 CHECK (market_weight BETWEEN 0 AND 500),
  -- The share of scheduled posts that try something the scores do not favour.
  explore_share   numeric(3, 2) NOT NULL DEFAULT 0.20 CHECK (explore_share BETWEEN 0.05 AND 0.50),
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON learning_settings TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The scores, worked out nightly per project and for the organisation
-- ---------------------------------------------------------------------------
--
-- Derived, and replaced whole on every pass: the ads, the outcomes and the
-- saved competitor ads are the record, this is a reading of them.
CREATE TABLE learning_scores (
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id   uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  dim             text NOT NULL CHECK (dim ~ '^[a-z_]{2,20}$'),
  value           text NOT NULL CHECK (length(value) BETWEEN 1 AND 60),
  -- Ours: qualified buyers and rupees spent behind this ingredient.
  own_qualified   integer NOT NULL DEFAULT 0 CHECK (own_qualified >= 0),
  own_spend       bigint NOT NULL DEFAULT 0 CHECK (own_spend >= 0),
  own_ads         integer NOT NULL DEFAULT 0 CHECK (own_ads >= 0),
  -- 1 is average; 1.3 means 30% more qualified buyers for the money.
  own_score       numeric(6, 3) NOT NULL DEFAULT 1,
  -- The market: how many competitor ads, weighted by how long they ran.
  market_ads      numeric(8, 2) NOT NULL DEFAULT 0,
  market_score    numeric(6, 3) NOT NULL DEFAULT 1,
  market_share    numeric(4, 3) NOT NULL DEFAULT 0 CHECK (market_share BETWEEN 0 AND 1),
  -- How much the market counted in `blended`, between 0 and 1.
  market_weight   numeric(4, 3) NOT NULL DEFAULT 1 CHECK (market_weight BETWEEN 0 AND 1),
  blended         numeric(6, 3) NOT NULL DEFAULT 1,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_node_id, dim, value)
);
CREATE INDEX learning_scores_org ON learning_scores (org_id);

GRANT SELECT, INSERT, DELETE ON learning_scores TO salesdesk_app;

-- The playbook a person reads: sentences written by code from the scores,
-- so every number on it is one the scores hold.
CREATE TABLE playbooks (
  scope_node_id   uuid PRIMARY KEY REFERENCES scope_nodes(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lines           jsonb NOT NULL DEFAULT '[]'::jsonb,
  own_ads         integer NOT NULL DEFAULT 0,
  market_ads      integer NOT NULL DEFAULT 0,
  market_weight   numeric(4, 3) NOT NULL DEFAULT 1,
  written_at      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON playbooks TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE competitor_ads ENABLE ROW LEVEL SECURITY;
CREATE POLICY competitor_ads_isolation ON competitor_ads
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE learning_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY learning_settings_isolation ON learning_settings
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE learning_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY learning_scores_isolation ON learning_scores
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE playbooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY playbooks_isolation ON playbooks
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
