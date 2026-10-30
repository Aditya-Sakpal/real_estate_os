-- ---------------------------------------------------------------------------
-- 0039  How often the same people have seen an ad
-- ---------------------------------------------------------------------------
--
-- post-generation.md section 11: a creative is due for a refresh when its
-- own frequency crosses about 3.0, and past 3.5 to 4.0 a new one is due
-- whatever it spends. Frequency is reach over a window, and reach does not
-- add up across days (the same person seen on Monday and Tuesday is one
-- person), so it cannot come from `ad_stats`' daily rows. The worker asks
-- the platform for the window as one figure and keeps the latest here.
--
-- One row per ad, replaced on each read: this is a reading, not a history.
CREATE TABLE ad_windows (
  publish_target_id uuid PRIMARY KEY REFERENCES publish_targets(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  since             date NOT NULL,
  until             date NOT NULL,
  reach             bigint NOT NULL DEFAULT 0 CHECK (reach >= 0),
  impressions       bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  -- Impressions per person reached over the window, as the platform says.
  frequency         numeric(6, 2) CHECK (frequency IS NULL OR frequency >= 0),
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (since <= until)
);
CREATE INDEX ad_windows_org ON ad_windows (org_id);

GRANT SELECT, INSERT, UPDATE ON ad_windows TO salesdesk_app;

ALTER TABLE ad_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY ad_windows_isolation ON ad_windows
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
