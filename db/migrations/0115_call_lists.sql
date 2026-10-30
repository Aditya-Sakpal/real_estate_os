-- ---------------------------------------------------------------------------
-- 0115  Call lists: a spreadsheet of people the agent rings
-- ---------------------------------------------------------------------------
--
-- A person uploads a CSV or Excel sheet of prospects. A model reads its
-- columns and each person's remarks into what that call should do; the
-- person reads the plan, ticks that everyone agreed to be contacted, and
-- starts it. The worker then rings the list a few at a time, each person
-- through the ordinary lead capture and the ordinary call gates.
--
--   call_lists      one sheet: what its columns hold, what it is for, the
--                   goal most calls carry, and how far calling has got.
--   call_list_rows  one person on it: who, which tower, what to say, and
--                   what became of the call.
--
-- A list walks DRAFT, then RUNNING (PAUSED when a gate stops it, or a person
-- does), then DONE or CANCELLED. A DRAFT nobody started is cleared after two
-- days. A row is READY until called; CALLING while its call is live; then
-- CALLED, back to READY for another try, UNREACHED, REFUSED, or SKIPPED.

CREATE TABLE call_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The tower a person is about when the sheet does not say.
  scope_node_id   uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  file_name       text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  state           text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'RUNNING', 'PAUSED', 'DONE', 'CANCELLED')),
  columns         jsonb NOT NULL DEFAULT '[]'::jsonb,
  purpose         text NOT NULL DEFAULT '' CHECK (char_length(purpose) <= 300),
  goal            text CHECK (char_length(goal) BETWEEN 1 AND 240),
  -- How the columns were read: by the model, or by our own reading when it could not.
  read_by         text NOT NULL DEFAULT 'model' CHECK (read_by IN ('model', 'rules')),
  reads           int NOT NULL DEFAULT 0 CHECK (reads >= 0),
  cost_usd        numeric(10, 4) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  consent_wording text CHECK (char_length(consent_wording) BETWEEN 1 AND 600),
  -- Why a list paused itself, in the gate's own words.
  paused_reason   text CHECK (char_length(paused_reason) <= 300),
  started_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (state = 'DRAFT' OR state = 'CANCELLED' OR (started_at IS NOT NULL AND consent_wording IS NOT NULL))
);
CREATE INDEX call_lists_org ON call_lists (org_id, created_at DESC);
CREATE INDEX call_lists_running ON call_lists (org_id) WHERE state = 'RUNNING';

CREATE TABLE call_list_rows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  list_id         uuid NOT NULL REFERENCES call_lists(id) ON DELETE CASCADE,
  line            int NOT NULL CHECK (line > 0),
  scope_node_id   uuid REFERENCES scope_nodes(id) ON DELETE SET NULL,
  name            text CHECK (char_length(name) <= 120),
  phone           text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  language        text NOT NULL DEFAULT 'hi' CHECK (language IN ('hi', 'mr', 'en')),
  -- The remarks as the sheet had them, phones hidden.
  note            text CHECK (char_length(note) <= 600),
  -- What this person's call should do, when it differs from the list's.
  goal            text CHECK (char_length(goal) BETWEEN 1 AND 240),
  state           text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY', 'SKIPPED', 'CALLING', 'CALLED', 'UNREACHED', 'REFUSED')),
  reason          text CHECK (char_length(reason) <= 300),
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  call_id         uuid REFERENCES calls(id) ON DELETE SET NULL,
  tries           int NOT NULL DEFAULT 0 CHECK (tries >= 0),
  not_before      timestamptz,
  lease_until     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, line)
);
CREATE INDEX call_list_rows_due ON call_list_rows (list_id, state, not_before) WHERE state IN ('READY', 'CALLING');
CREATE INDEX call_list_rows_phone ON call_list_rows (org_id, phone);

GRANT SELECT, INSERT, UPDATE, DELETE ON call_lists TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_list_rows TO salesdesk_app;

ALTER TABLE call_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY call_lists_isolation ON call_lists
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
ALTER TABLE call_list_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY call_list_rows_isolation ON call_list_rows
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A list's tower and a row's are the organisation's own towers, and a row
-- belongs to a list of its own organisation.
CREATE FUNCTION call_lists_own() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scope_nodes n WHERE n.id = NEW.scope_node_id AND n.org_id = NEW.org_id AND n.kind = 'PHASE') THEN
    RAISE EXCEPTION 'a call list is about a tower of the organisation''s own' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER call_lists_own BEFORE INSERT OR UPDATE OF scope_node_id ON call_lists
  FOR EACH ROW EXECUTE FUNCTION call_lists_own();

CREATE FUNCTION call_list_rows_own() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM call_lists l WHERE l.id = NEW.list_id AND l.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'a row belongs to a call list of its own organisation' USING ERRCODE = '23514';
  END IF;
  IF NEW.scope_node_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM scope_nodes n WHERE n.id = NEW.scope_node_id AND n.org_id = NEW.org_id AND n.kind = 'PHASE') THEN
    RAISE EXCEPTION 'a call list row is about a tower of the organisation''s own' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER call_list_rows_own BEFORE INSERT OR UPDATE OF list_id, scope_node_id ON call_list_rows
  FOR EACH ROW EXECUTE FUNCTION call_list_rows_own();
