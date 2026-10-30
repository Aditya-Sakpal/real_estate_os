-- ===========================================================================
--  0100_fewer_video_templates  --  three more video templates go
--
--  The client, 8 October 2026, took these out of the product:
--    video  04-drone-and-route, 05-sample-flat-tour, 10-possession-and-handover
--
--  As 0081 did: a schedule's style that picked one of these leaves it to the
--  AI. Posts already made keep the key they were made after; it just reads as
--  no template.
-- ===========================================================================

UPDATE post_schedules
SET styles = regexp_replace(styles::text,
      '"(04-drone-and-route|05-sample-flat-tour|10-possession-and-handover)"', 'null', 'g')::jsonb,
    day_styles = regexp_replace(day_styles::text,
      '"(04-drone-and-route|05-sample-flat-tour|10-possession-and-handover)"', 'null', 'g')::jsonb,
    dated = regexp_replace(dated::text,
      '"(04-drone-and-route|05-sample-flat-tour|10-possession-and-handover)"', 'null', 'g')::jsonb
WHERE (styles::text || coalesce(day_styles::text, '') || dated::text) ~
      '"(04-drone-and-route|05-sample-flat-tour|10-possession-and-handover)"';
