-- ===========================================================================
--  0021_day_kinds_check  --  a day off is allowed in a week plan
--
--  0020's CHECK read `day_kinds <@ ARRAY['IMAGE', 'CAROUSEL', 'VIDEO', NULL]`,
--  and array containment never matches a NULL element, so any week with a
--  day off (which is every week anybody plans) was refused. It went in
--  unnoticed only because no schedule existed to fail it.
--
--  The NULLs are removed before the containment is asked, which is the whole
--  of the fix: seven entries, and every entry that is not a day off is a kind
--  the catalog knows.
-- ===========================================================================

ALTER TABLE post_schedules DROP CONSTRAINT post_schedules_day_kinds_check;

ALTER TABLE post_schedules ADD CONSTRAINT post_schedules_day_kinds_check CHECK (
  day_kinds IS NULL
  OR (array_length(day_kinds, 1) = 7
      AND array_remove(day_kinds, NULL) <@ ARRAY['IMAGE', 'CAROUSEL', 'VIDEO']::text[])
);
