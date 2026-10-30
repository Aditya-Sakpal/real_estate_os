-- ---------------------------------------------------------------------------
-- 0114  Setting a project up from its documents, in Ask Jimmy
-- ---------------------------------------------------------------------------
--
-- A person attaches a brochure, a price list, a RERA certificate or a few
-- pictures to a question, and Jimmy sets the project up from them: the
-- promoter, the project, its towers, the flat types, the pictures in the
-- library and the documents read into the Brain. Nothing it makes is
-- approved or signed; everything waits for the people who approve.
--
-- Two tables, both the asker's own (`app.user_id`), like the chat they sit in.
--
--   ask_files       one uploaded file. The bytes are in the store under
--                   org/<org>/shared/askfile/<sha256>; a row is made when the
--                   upload begins and turns READY once its bytes are checked.
--   project_setups  one setup, walking one way:
--
--     READING   the files are being read and their pictures looked at
--     ASKING    something only the person can answer is waiting
--     READY     everything is known; the card says what will be made
--     CREATING  confirmed, and being made
--     DONE      made; `result` says what, with links
--     FAILED    a gate or a cap refused, or the files could not be read
--     CANCELLED the person said no
--     EXPIRED   nobody answered for a week
--
-- The move from READY to CREATING is one guarded UPDATE, so a double press
-- makes nothing twice, and every step of the making is recorded as it lands
-- (`result.made`), so a worker that dies part way picks up where it stopped.
-- A setup is cleared out two weeks after it ends, and its files with it; the
-- store's orphans go to the sweep.

CREATE TABLE project_setups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  state        text NOT NULL DEFAULT 'READING' CHECK (state IN
                 ('READING', 'ASKING', 'READY', 'CREATING', 'DONE', 'FAILED', 'CANCELLED', 'EXPIRED')),
  -- What the person wrote beside the files.
  said         text NOT NULL DEFAULT '' CHECK (char_length(said) <= 600),
  -- The text read off every page, per file, and how far reading got.
  reading      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Every picture worth a look: its key in the store, where it came from,
  -- and what the model saw in it.
  pictures     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What the documents say, kept only where the words are on a page.
  proposal     jsonb,
  -- The person's answers: { filled, hints }, as an action card keeps them.
  inputs       jsonb NOT NULL DEFAULT '{"filled": {}, "hints": {}}'::jsonb,
  questions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The plan the confirm button makes, and the keys held when it was pressed.
  plan         jsonb,
  permit       jsonb,
  -- What was made, recorded as it lands, then the message and links.
  result       jsonb,
  stage        text,
  progress     int CHECK (progress BETWEEN 0 AND 100),
  attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until  timestamptz,
  calls        int NOT NULL DEFAULT 0 CHECK (calls >= 0),
  cost_usd     numeric(10, 4) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  finished_at  timestamptz
);
CREATE INDEX project_setups_thread ON project_setups (thread_id, created_at);
CREATE INDEX project_setups_due ON project_setups (state, lease_until) WHERE state IN ('READING', 'CREATING');
CREATE INDEX project_setups_month ON project_setups (org_id, created_at);

CREATE TABLE ask_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setup_id     uuid REFERENCES project_setups(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  media_type   text NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  bytes        bigint NOT NULL CHECK (bytes > 0 AND bytes <= 62914560),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key  text NOT NULL CHECK (storage_key = 'org/' || org_id::text || '/shared/askfile/' || sha256),
  pages        int CHECK (pages > 0),
  state        text NOT NULL DEFAULT 'UPLOADING' CHECK (state IN ('UPLOADING', 'READY', 'REFUSED')),
  problem      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ask_files_person ON ask_files (org_id, user_id, created_at);
CREATE INDEX ask_files_setup ON ask_files (setup_id);

GRANT SELECT, INSERT, UPDATE ON project_setups TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ask_files TO salesdesk_app;

ALTER TABLE project_setups ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_setups_owner ON project_setups
  USING (org_id = app_current_org() AND user_id = app_current_user())
  WITH CHECK (org_id = app_current_org() AND user_id = app_current_user());

ALTER TABLE ask_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY ask_files_owner ON ask_files
  USING (org_id = app_current_org() AND user_id = app_current_user())
  WITH CHECK (org_id = app_current_org() AND user_id = app_current_user());

-- A file joins a setup once, and its bytes never change under it. (It goes
-- with its setup, or with the chat, by cascade.)
CREATE FUNCTION ask_files_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.setup_id IS NOT NULL AND NEW.setup_id IS DISTINCT FROM OLD.setup_id THEN
    RAISE EXCEPTION 'a file belongs to one setup';
  END IF;
  IF NEW.sha256 <> OLD.sha256 OR NEW.storage_key <> OLD.storage_key OR NEW.bytes <> OLD.bytes OR NEW.media_type <> OLD.media_type THEN
    RAISE EXCEPTION 'a file''s bytes are fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ask_files_guard BEFORE UPDATE ON ask_files
  FOR EACH ROW EXECUTE FUNCTION ask_files_guard();
