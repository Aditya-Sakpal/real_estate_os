-- ---------------------------------------------------------------------------
-- 0080  How the calling agent says a project's words
-- ---------------------------------------------------------------------------
--
-- The agent's voice reads a name written in English letters as English:
-- "Pimple Saudagar" is the English word, "Sath" came back "Sapt". A project's
-- words are checked by ear (said by the agent's voice, heard back, compared),
-- the ones that come back wrong are shown to the developer with how they
-- sound, and the developer writes how each is really said. Every call then
-- carries those words with their spelling, which the agent copies, and which
-- the voice reads right.
--
-- One row is one word at one node (a project or a tower), resolved downward
-- like the Brain: a tower's own spelling of a word wins over its project's.
--
--   written   the word as the facts write it
--   said      how it is really said, as the developer wrote it (null: as written)
--   heard     what the check heard when the agent's voice said it
--   verdict   UNCHECKED, RIGHT, WRONG, or FAILED (the check could not run)
--   sample    the agent saying it, kept so playing it again costs nothing,
--             and `sample_of` the text that sample spoke
--
-- A word is not a fact: it says nothing about the building, so it is edited
-- with the Brain's own edit key and needs no signature.

CREATE TABLE pronunciations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  written        text NOT NULL CHECK (char_length(btrim(written)) BETWEEN 1 AND 60),
  said           text CHECK (said IS NULL OR char_length(btrim(said)) BETWEEN 1 AND 80),
  heard          text CHECK (heard IS NULL OR char_length(heard) <= 300),
  verdict        text NOT NULL DEFAULT 'UNCHECKED' CHECK (verdict IN ('UNCHECKED', 'RIGHT', 'WRONG', 'FAILED')),
  sample         bytea CHECK (sample IS NULL OR octet_length(sample) <= 300000),
  sample_of      text,
  cost_paise     integer NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  checked_at     timestamptz,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pronunciations_word ON pronunciations (org_id, scope_node_id, lower(btrim(written)));
CREATE INDEX pronunciations_checked ON pronunciations (org_id, scope_node_id, checked_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON pronunciations TO salesdesk_app;

ALTER TABLE pronunciations ENABLE ROW LEVEL SECURITY;
CREATE POLICY pronunciations_isolation ON pronunciations
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Every time the agent's voice says a word for a check is a row of its own,
-- so the caps count sayings, not words: one word whose spelling is changed
-- and played ten times is ten sayings, and ten paid calls. Append only.
CREATE TABLE pronunciation_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  verdict        text NOT NULL CHECK (verdict IN ('RIGHT', 'WRONG', 'FAILED')),
  cost_paise     integer NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  checked_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pronunciation_checks_node ON pronunciation_checks (org_id, scope_node_id, checked_at);

GRANT SELECT, INSERT ON pronunciation_checks TO salesdesk_app;

ALTER TABLE pronunciation_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY pronunciation_checks_isolation ON pronunciation_checks
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
