-- ===========================================================================
--  0035_dated_schedules_and_ads  --  a schedule on picked dates, and ads
--
--  Two changes the client asked for on 28 September 2026.
--
--  A schedule could only repeat weekly. It may now run on dates picked from
--  a calendar instead, each date with its own kind and time: a launch week
--  or a site-visit weekend is not a rhythm. The dates live on the schedule
--  as a small JSON list, capped, because every one is a paid run.
--
--  And every entry (a weekday, or a date) now says how it goes out: an
--  organic post, a paid ad, or both from the one creative. A schedule used to
--  publish organic posts only, on the rule that starting spend is a decision
--  and never a cadence. The decision is now made once, when a person holding
--  the budget key sets a daily budget and a length on the schedule, and again
--  per ad by whoever approves it (or by the mode, in AUTO). So an ad from a
--  schedule is created and switched on in one go, and stops on its own after
--  the days it was given.
-- ===========================================================================

ALTER TABLE post_schedules
  ADD COLUMN repeat text NOT NULL DEFAULT 'WEEKLY' CHECK (repeat IN ('WEEKLY', 'DATES')),
  -- [{ "on": "2026-10-04", "at": 600, "kind": "IMAGE", "outlet": "POST" }, ...]
  ADD COLUMN dated jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(dated) = 'array' AND jsonb_array_length(dated) <= 60
  ),
  -- How each weekday's post goes out, Sunday first, beside `day_kinds`.
  ADD COLUMN day_outlets text[] CHECK (
    day_outlets IS NULL
    OR (array_length(day_outlets, 1) = 7
        AND array_remove(day_outlets, NULL) <@ ARRAY['POST', 'AD', 'BOTH']::text[])
  ),
  -- Rupees a day for every ad this schedule makes, and how long each runs.
  ADD COLUMN ad_daily_budget integer CHECK (ad_daily_budget IS NULL OR ad_daily_budget > 0),
  ADD COLUMN ad_days integer NOT NULL DEFAULT 10 CHECK (ad_days BETWEEN 3 AND 30);

-- A schedule on dates has no weekdays.
ALTER TABLE post_schedules DROP CONSTRAINT post_schedules_days_of_week_check;
ALTER TABLE post_schedules ADD CONSTRAINT post_schedules_days_of_week_check CHECK (
  days_of_week <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
  AND (repeat = 'DATES' OR array_length(days_of_week, 1) BETWEEN 1 AND 7)
);

-- A Meta ad is now somewhere a schedule may send a post.
ALTER TABLE post_schedules DROP CONSTRAINT post_schedules_destinations_check;
ALTER TABLE post_schedules ADD CONSTRAINT post_schedules_destinations_check CHECK (
  destinations <@ ARRAY['FACEBOOK_PAGE', 'INSTAGRAM', 'GOOGLE_BUSINESS', 'META_AD']::text[]
);

-- What the run's entry said when it was written, so a plan edited later does
-- not change how a post already in the queue goes out.
ALTER TABLE post_runs
  ADD COLUMN outlet text NOT NULL DEFAULT 'POST' CHECK (outlet IN ('POST', 'AD', 'BOTH'));

-- A scheduled ad is switched on as soon as it exists, and stops by itself.
ALTER TABLE publish_targets
  ADD COLUMN switch_on boolean NOT NULL DEFAULT false,
  ADD COLUMN ends_at timestamptz;

--   ENDED  it ran for the days it was given
ALTER TABLE publish_targets DROP CONSTRAINT publish_targets_paused_reason_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_paused_reason_check
  CHECK (paused_reason IN ('PERSON', 'REGISTRATION', 'ENDED'));

CREATE INDEX publish_targets_ends_idx ON publish_targets (ends_at) WHERE ends_at IS NOT NULL;
