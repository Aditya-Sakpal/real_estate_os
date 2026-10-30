-- ===========================================================================
--  0067_schedule_styles  --  a scheduled post's look, as the studio offers it
--
--  The studio lets a person choose the language, the buyers, the size, the
--  design template, the typeface and a carousel's length. A schedule made
--  every post in every language and buyer, at the brief's first size, with
--  nothing else chosen. The client asked on 1 October 2026 for a schedule to
--  carry the same choices, set once for every image, carousel and video it
--  makes, and changed for one date or weekday where that one is different.
--
--  `styles` is the schedule's own style per kind ({ IMAGE, CAROUSEL, VIDEO }).
--  `day_styles` is a weekday's own, Sunday first, null where the day takes the
--  schedule's. A picked date carries its own inside `dated`, which 0035
--  already caps at sixty entries.
-- ===========================================================================

ALTER TABLE post_schedules
  ADD COLUMN styles jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(styles) = 'object'),
  ADD COLUMN day_styles jsonb CHECK (
    day_styles IS NULL
    OR (jsonb_typeof(day_styles) = 'array' AND jsonb_array_length(day_styles) = 7)
  );
