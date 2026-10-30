-- ===========================================================================
--  0079_one_script_ads  --  an image ad is all English or all Hindi
--
--  The client, 1 October 2026: an image ad is written in one language and
--  one script, English or Hindi, never Hinglish (Hindi in English letters)
--  and never a mixture. Hinglish stays in the story reels' captions, which
--  are made apart from the cards.
--
--  1. A card in Hindi (or another script of its own) carries `local`: the
--     location and the approved points in that script, which its ad prints,
--     and the whole card read back into English, which the copy gate reads.
--     `{}` on an English card and on every card written before this.
--  2. Every brief, schedule style and brand typeface that named Hinglish
--     names Hindi instead (a brief's language) or English (a typeface: the
--     same letters), so no saved choice points at a language that is gone.
-- ===========================================================================

ALTER TABLE campaign_copy
  ADD COLUMN local jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(local) = 'object');

-- A brief asked for Hinglish: it now asks for Hindi, once, in its place.
UPDATE campaign_briefs b
SET languages = (
  SELECT coalesce(array_agg(l ORDER BY first), '{}')
  FROM (
    SELECT l, min(o) AS first
    FROM unnest(array_replace(b.languages, 'Hinglish', 'Hindi')) WITH ORDINALITY AS u(l, o)
    GROUP BY l
  ) kept
)
WHERE 'Hinglish' = ANY (b.languages);

-- A schedule's styles name languages by the same words. A repeat inside one
-- list is harmless: a run writes in the brief's languages, each once.
UPDATE post_schedules
SET styles = replace(styles::text, '"Hinglish"', '"Hindi"')::jsonb
WHERE styles::text LIKE '%"Hinglish"%';

UPDATE post_schedules
SET day_styles = replace(day_styles::text, '"Hinglish"', '"Hindi"')::jsonb
WHERE day_styles IS NOT NULL AND day_styles::text LIKE '%"Hinglish"%';

UPDATE post_schedules
SET dated = replace(dated::text, '"Hinglish"', '"Hindi"')::jsonb
WHERE dated::text LIKE '%"Hinglish"%';

-- A typeface that set Hinglish sets English: they are the same letters.
UPDATE brand_kits
SET typeface_languages = CASE
  WHEN 'English' = ANY (typeface_languages) THEN array_remove(typeface_languages, 'Hinglish')
  ELSE array_replace(typeface_languages, 'Hinglish', 'English')
END
WHERE 'Hinglish' = ANY (typeface_languages);
