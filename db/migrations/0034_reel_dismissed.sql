-- ===========================================================================
--  0034_reel_dismissed  --  a finished video card a person put away stays away
--
--  A stopped or failed video's card offered Dismiss, and Dismiss only hid it
--  in the open page: the studio lists the day's jobs, so the next load put
--  the card back. The job keeps its row (what was spent, the film asked for,
--  "Try again" all hang off it); this records only that the person is done
--  looking at it.
-- ===========================================================================

ALTER TABLE reel_jobs ADD COLUMN dismissed_at timestamptz;
