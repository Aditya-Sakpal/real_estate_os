-- ===========================================================================
-- 0101: every rupee an ad account spends, whoever made the campaign.
--
-- Spend was read only for ads this product made, only while they were live,
-- and once a day. A campaign made in Ads Manager spent real money and brought
-- real leads, and none of it reached Reports. The lead worker now reads each
-- connected Meta ad account's spend per campaign per day (one request a
-- pass), and keeps it here whether or not the campaign is ours.
--
--   ad_campaign_stats   one row per account, campaign and day. A campaign of
--                       ours names its publication; one made elsewhere names
--                       none and is placed by `ad_campaign_places`.
--   ad_campaign_places  which tower a campaign made elsewhere advertises,
--                       chosen by a person, never guessed. Its leads are
--                       filed there and its spend counted there.
-- ===========================================================================

CREATE TABLE ad_campaign_stats (
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES connection_accounts(id) ON DELETE CASCADE,
  campaign_id       text NOT NULL CHECK (campaign_id ~ '^[0-9]{1,30}$'),
  campaign_name     text NOT NULL DEFAULT '' CHECK (length(campaign_name) <= 400),
  day               date NOT NULL,
  spend_paise       bigint NOT NULL DEFAULT 0 CHECK (spend_paise >= 0),
  impressions       bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks            bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  platform_leads    integer NOT NULL DEFAULT 0 CHECK (platform_leads >= 0),
  publish_target_id uuid REFERENCES publish_targets(id) ON DELETE SET NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, campaign_id, day)
);
CREATE INDEX ad_campaign_stats_org_day ON ad_campaign_stats (org_id, day);

GRANT SELECT, INSERT, UPDATE ON ad_campaign_stats TO salesdesk_app;
ALTER TABLE ad_campaign_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY ad_campaign_stats_isolation ON ad_campaign_stats
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

CREATE TABLE ad_campaign_places (
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES connection_accounts(id) ON DELETE CASCADE,
  campaign_id  text NOT NULL CHECK (campaign_id ~ '^[0-9]{1,30}$'),
  phase_id     uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  set_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, campaign_id)
);
CREATE INDEX ad_campaign_places_org ON ad_campaign_places (org_id, campaign_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON ad_campaign_places TO salesdesk_app;
ALTER TABLE ad_campaign_places ENABLE ROW LEVEL SECURITY;
CREATE POLICY ad_campaign_places_isolation ON ad_campaign_places
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A place is a tower of the same tenant.
CREATE OR REPLACE FUNCTION ad_campaign_places_phase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scope_nodes WHERE id = NEW.phase_id AND org_id = NEW.org_id AND kind = 'PHASE') THEN
    RAISE EXCEPTION 'an ad campaign is placed on a tower of its own organisation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ad_campaign_places_phase BEFORE INSERT OR UPDATE ON ad_campaign_places
  FOR EACH ROW EXECUTE FUNCTION ad_campaign_places_phase();

-- The daily budget pass marked itself by the newest `ad_stats` row it wrote.
-- Spend is now written every few minutes, so the pass keeps its own mark.
CREATE TABLE ad_budget_passes (
  org_id  uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  ran_at  timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON ad_budget_passes TO salesdesk_app;
ALTER TABLE ad_budget_passes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ad_budget_passes_isolation ON ad_budget_passes
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
INSERT INTO ad_budget_passes (org_id, ran_at)
  SELECT org_id, max(fetched_at) FROM ad_stats GROUP BY org_id;

-- Leads a webhook never delivered are read off each Page's forms, every half
-- hour; this is when each Page was last read.
CREATE TABLE meta_form_sweeps (
  account_id  uuid PRIMARY KEY REFERENCES connection_accounts(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  swept_at    timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON meta_form_sweeps TO salesdesk_app;
ALTER TABLE meta_form_sweeps ENABLE ROW LEVEL SECURITY;
CREATE POLICY meta_form_sweeps_isolation ON meta_form_sweeps
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
