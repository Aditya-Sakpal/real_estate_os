-- ---------------------------------------------------------------------------
-- 0116  Call lists ask before they guess
-- ---------------------------------------------------------------------------
--
-- When a sheet or a person's remarks are unclear in a way that changes
-- whether, when or how somebody is called ("call between 3 to 5, 6",
-- "status B"), the list holds questions for the person who uploaded it,
-- and cannot start until each is answered or left to the system. A row
-- may also carry the hours of the day its person is rung in, on every try.

ALTER TABLE call_lists
  ADD COLUMN questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN ask_rounds int NOT NULL DEFAULT 0 CHECK (ask_rounds >= 0);

ALTER TABLE call_list_rows
  ADD COLUMN window_from text CHECK (window_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN window_to   text CHECK (window_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT call_list_rows_window CHECK ((window_from IS NULL) = (window_to IS NULL) AND (window_from IS NULL OR window_from < window_to));
