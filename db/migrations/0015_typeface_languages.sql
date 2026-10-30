-- The typeface card asked which SCRIPTS a face can set, and a script is not
-- what the person filling the form thinks in. Five of the seven entries were
-- named after the only language written in them, so the list already read as
-- languages; "Latin" and "Devanagari" were the two that did not, and they were
-- the two that read as jargon.
--
-- Storing the script was the tidier model, because one file that sets
-- Devanagari sets Hindi and Marathi both. It is also wrong often enough to
-- matter: Marathi needs the eyelash reph and a lla that Hindi-only Devanagari
-- faces are shipped without, and Hinglish is a real instruction to a marketer
-- while being the same glyphs as English. A language is what gets chosen in a
-- brief, so a language is what the coverage is recorded against.
--
-- The conversion fans each stored script out to the languages it set, in
-- catalog order rather than alphabetical, because the screen prints the array
-- back as it stands.

ALTER TABLE brand_kits RENAME COLUMN typeface_scripts TO typeface_languages;

UPDATE brand_kits k SET typeface_languages = coalesce((
  SELECT array_agg(m.language ORDER BY m.ord)
  FROM (VALUES
    ('English',  1, 'Latin'),
    ('Hinglish', 2, 'Latin'),
    ('Hindi',    3, 'Devanagari'),
    ('Marathi',  4, 'Devanagari'),
    ('Gujarati', 5, 'Gujarati'),
    ('Tamil',    6, 'Tamil'),
    ('Telugu',   7, 'Telugu'),
    ('Kannada',  8, 'Kannada'),
    ('Bengali',  9, 'Bengali')
  ) AS m(language, ord, script)
  WHERE m.script = ANY (k.typeface_languages)
), '{}');
