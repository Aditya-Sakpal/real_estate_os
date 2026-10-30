-- ---------------------------------------------------------------------------
-- 0117  A call list may pitch several towers
-- ---------------------------------------------------------------------------
--
-- A developer chooses which towers a sheet is about: one, several, or a
-- whole project's. Each person is called about one of them (the sheet's
-- project column, else the one their remarks fit, else the first chosen),
-- and the call's facts carry the others as alternatives. `scope_node_id`
-- stays the first chosen; `tower_ids` holds every chosen tower, in order.

ALTER TABLE call_lists ADD COLUMN tower_ids uuid[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(tower_ids) <= 50);

CREATE OR REPLACE FUNCTION call_lists_own() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scope_nodes n WHERE n.id = NEW.scope_node_id AND n.org_id = NEW.org_id AND n.kind = 'PHASE') THEN
    RAISE EXCEPTION 'a call list is about a tower of the organisation''s own' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.tower_ids) t(id)
    WHERE NOT EXISTS (SELECT 1 FROM scope_nodes n WHERE n.id = t.id AND n.org_id = NEW.org_id AND n.kind = 'PHASE')) THEN
    RAISE EXCEPTION 'every tower a call list pitches is the organisation''s own' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER call_lists_own ON call_lists;
CREATE TRIGGER call_lists_own BEFORE INSERT OR UPDATE OF scope_node_id, tower_ids ON call_lists
  FOR EACH ROW EXECUTE FUNCTION call_lists_own();
