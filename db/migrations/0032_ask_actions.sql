-- ---------------------------------------------------------------------------
-- 0032  Ask Jimmy takes actions
-- ---------------------------------------------------------------------------
--
-- Jimmy proposes; a person confirms; the server runs the same function the
-- screen's button runs. An action is a row that walks one way:
--
--   ASKING     inputs are missing, and a question card is waiting on them
--   PROPOSED   everything is known; the card says exactly what will happen
--   RUNNING    confirmed, and running (a post takes minutes, a reel far more)
--   DONE       it happened; `result` says what came of it
--   FAILED     a gate or the function refused; `result` says why
--   CANCELLED  the person said no
--   EXPIRED    nobody answered or confirmed in time
--
-- The row is the asker's, like the chat it sits in (`app.user_id`), and the
-- move from PROPOSED to RUNNING is one guarded UPDATE, so a double click or a
-- second tab runs the action once.

CREATE TABLE ask_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  state        text NOT NULL DEFAULT 'ASKING' CHECK (state IN
                 ('ASKING', 'PROPOSED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED', 'EXPIRED')),
  -- { filled: { input: { v, label } | { vs, labels } }, hints: { input: text } }
  inputs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The question card on screen while ASKING; answers are checked against it.
  questions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The confirm card while PROPOSED: title, lines, the button's words.
  preview      jsonb,
  -- What it acts on, read back again at confirm: { type, id, path }.
  target       jsonb,
  -- What came of it: a message, links, a picture, the next thing it offers.
  result       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  finished_at  timestamptz
);
CREATE INDEX ask_actions_thread ON ask_actions (thread_id, created_at);
CREATE INDEX ask_actions_day ON ask_actions (org_id, user_id, created_at);

GRANT SELECT, INSERT, UPDATE ON ask_actions TO salesdesk_app;

ALTER TABLE ask_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ask_actions_owner ON ask_actions
  USING (org_id = app_current_org() AND user_id = app_current_user())
  WITH CHECK (org_id = app_current_org() AND user_id = app_current_user());

-- The organisation's switch. No row means the default: Jimmy may act, within
-- each person's own keys. Only `org:manage` changes it, in Settings.
CREATE TABLE ask_settings (
  org_id      uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  actions_on  boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON ask_settings TO salesdesk_app;

ALTER TABLE ask_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY ask_settings_isolation ON ask_settings
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
