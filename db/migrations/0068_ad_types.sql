-- ===========================================================================
--  0068_ad_types  --  every kind of ad Meta and Google sell that a developer
--                     uses, not one of each
--
--  A Meta ad was always a Traffic ad (clicks to a website), one file shown in
--  every placement. Google was a display banner only. Decided with the client
--  on 1 October 2026: Meta ads carry a goal (an instant lead form, a WhatsApp
--  chat, clicks, or reach) and a story version beside the feed one; Google
--  adds Search, Performance Max and Demand Gen, the last also as YouTube
--  video ads.
--
--  Search and Performance Max are not posts. Each is one campaign per brief
--  that runs until it is stopped, built from the brief's cleared copy and its
--  passed pictures, so its publication names the brief (`source = 'BRIEF'`)
--  rather than a post. Everything else about a publication is unchanged: one
--  row, idempotent, created paused, stopped by the kill switch.
-- ===========================================================================

ALTER TABLE publish_targets DROP CONSTRAINT publish_targets_destination_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_destination_check CHECK (destination IN (
  'FACEBOOK_PAGE', 'INSTAGRAM', 'META_AD', 'GOOGLE_DISPLAY_AD', 'GOOGLE_BUSINESS',
  'GOOGLE_SEARCH_AD', 'GOOGLE_PMAX_AD', 'GOOGLE_DEMAND_GEN_AD'));

ALTER TABLE publish_targets DROP CONSTRAINT publish_targets_source_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_source_check
  CHECK (source IN ('STUDIO', 'SCHEDULE', 'BRIEF'));

-- A search ad is words only, and a Performance Max campaign is a bundle of
-- words and pictures from several posts.
ALTER TABLE publish_targets DROP CONSTRAINT publish_targets_kind_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_kind_check
  CHECK (kind IN ('IMAGE', 'CAROUSEL', 'VIDEO', 'TEXT', 'BUNDLE'));

ALTER TABLE publish_targets
  ADD COLUMN brief_id uuid REFERENCES campaign_briefs(id) ON DELETE SET NULL,
  -- What a Meta ad is optimised for. Null for everything else.
  ADD COLUMN ad_goal text CHECK (ad_goal IN ('LEADS', 'TRAFFIC', 'WHATSAPP', 'AWARENESS'));

ALTER TABLE publish_targets DROP CONSTRAINT publish_targets_one_source;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_one_source CHECK (
  num_nonnulls(rendered_post_id, post_creative_id, brief_id) <= 1
  AND (source <> 'BRIEF' OR (rendered_post_id IS NULL AND post_creative_id IS NULL))
);

ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_goal_meta
  CHECK (ad_goal IS NULL OR destination = 'META_AD');

ALTER TABLE publish_targets DROP CONSTRAINT publish_targets_ad_budget;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_ad_budget CHECK (
  (destination IN ('META_AD', 'GOOGLE_DISPLAY_AD', 'GOOGLE_SEARCH_AD', 'GOOGLE_PMAX_AD', 'GOOGLE_DEMAND_GEN_AD'))
  = (daily_budget IS NOT NULL));

-- An always-on campaign is found by its brief. A second press, a second tab
-- or a retry lands on the same row through the idempotency key.
CREATE INDEX publish_targets_brief_idx ON publish_targets (brief_id);

-- ---------------------------------------------------------------------------
-- A schedule's ads: Meta, and now Google Demand Gen, with Meta's goal
-- ---------------------------------------------------------------------------
ALTER TABLE post_schedules DROP CONSTRAINT post_schedules_destinations_check;
ALTER TABLE post_schedules ADD CONSTRAINT post_schedules_destinations_check CHECK (
  destinations <@ ARRAY['FACEBOOK_PAGE', 'INSTAGRAM', 'GOOGLE_BUSINESS', 'META_AD',
                        'GOOGLE_DEMAND_GEN_AD', 'WHATSAPP_BROADCAST']::text[]
);

ALTER TABLE post_schedules
  ADD COLUMN ad_goal text NOT NULL DEFAULT 'TRAFFIC'
    CHECK (ad_goal IN ('LEADS', 'TRAFFIC', 'WHATSAPP', 'AWARENESS'));

-- ---------------------------------------------------------------------------
-- The developer's privacy policy
-- ---------------------------------------------------------------------------
--
-- A Meta instant form and a Google lead form both refuse to exist without a
-- link to the advertiser's own privacy policy. It is the developer's
-- document, so it lives in their brand kit beside the website.
ALTER TABLE brand_kits ADD COLUMN privacy_url text;
