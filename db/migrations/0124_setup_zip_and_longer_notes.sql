-- ===========================================================================
-- 0124: a zip attached in Ask Jimmy, and a longer note beside the files.
--
-- A developer's pictures arrive as a zip as often as one by one, so a zip
-- may be attached: it lands as one row, is opened on our side into a row
-- per PDF or picture inside it, and its own row goes (29 October 2026).
-- A zip may be up to 120 MB; every file taken out of it keeps the old caps.
--
-- What a person types beside the files (a booking amount, the visiting
-- hours, a jodi flat's price) ran into a 500-character box and a 600 one
-- here. Both are 3,000 now.
-- ===========================================================================

ALTER TABLE ask_files DROP CONSTRAINT ask_files_media_type_check;
ALTER TABLE ask_files ADD CONSTRAINT ask_files_media_type_check
  CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/zip'));

ALTER TABLE ask_files DROP CONSTRAINT ask_files_bytes_check;
ALTER TABLE ask_files ADD CONSTRAINT ask_files_bytes_check
  CHECK (bytes > 0 AND bytes <= CASE WHEN media_type = 'application/zip' THEN 125829120 ELSE 62914560 END);

ALTER TABLE project_setups DROP CONSTRAINT project_setups_said_check;
ALTER TABLE project_setups ADD CONSTRAINT project_setups_said_check CHECK (char_length(said) <= 3000);
