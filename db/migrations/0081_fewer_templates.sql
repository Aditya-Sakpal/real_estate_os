-- ===========================================================================
--  0081_fewer_templates  --  thirteen templates and the hoarding size go
--
--  The client, 3 October 2026, took these out of the product:
--    image     13-testimonial, 17-channel-partner, 18-hoarding-ooh (and the
--              Hoarding size with it)
--    carousel  08-buyer-education, 09-testimonials, 10-developer-track-record
--    video     02-motion-poster, 03-3d-walkthrough, 07-testimonial,
--              08-offer-reel, 09-presenter-explainer, 11-developer-brand-film,
--              16-insta-friendly-presenter-site-price-reveal
--
--  The catalog in code no longer knows them. What was saved naming one is put
--  back to the default, so no saved choice points at something that is gone:
--  a brief stops asking for the Hoarding size, and a schedule's style that
--  picked one of these templates, or the Hoarding size, leaves it to the AI
--  (or the brief's first size). Posts already made keep the key they were
--  made after; it just reads as no template.
-- ===========================================================================

UPDATE campaign_briefs
SET formats = array_remove(formats, 'Hoarding')
WHERE 'Hoarding' = ANY (formats);

-- Every one of these is only ever a value (a style's size or template), so
-- a whole-word swap for null is exact.
UPDATE post_schedules
SET styles = regexp_replace(styles::text,
      '"(Hoarding|13-testimonial|17-channel-partner|18-hoarding-ooh|08-buyer-education|09-testimonials|10-developer-track-record|02-motion-poster|03-3d-walkthrough|07-testimonial|08-offer-reel|09-presenter-explainer|11-developer-brand-film|16-insta-friendly-presenter-site-price-reveal)"',
      'null', 'g')::jsonb,
    day_styles = regexp_replace(day_styles::text,
      '"(Hoarding|13-testimonial|17-channel-partner|18-hoarding-ooh|08-buyer-education|09-testimonials|10-developer-track-record|02-motion-poster|03-3d-walkthrough|07-testimonial|08-offer-reel|09-presenter-explainer|11-developer-brand-film|16-insta-friendly-presenter-site-price-reveal)"',
      'null', 'g')::jsonb,
    dated = regexp_replace(dated::text,
      '"(Hoarding|13-testimonial|17-channel-partner|18-hoarding-ooh|08-buyer-education|09-testimonials|10-developer-track-record|02-motion-poster|03-3d-walkthrough|07-testimonial|08-offer-reel|09-presenter-explainer|11-developer-brand-film|16-insta-friendly-presenter-site-price-reveal)"',
      'null', 'g')::jsonb
WHERE (styles::text || coalesce(day_styles::text, '') || dated::text) ~
      '"(Hoarding|13-testimonial|17-channel-partner|18-hoarding-ooh|08-buyer-education|09-testimonials|10-developer-track-record|02-motion-poster|03-3d-walkthrough|07-testimonial|08-offer-reel|09-presenter-explainer|11-developer-brand-film|16-insta-friendly-presenter-site-price-reveal)"';
