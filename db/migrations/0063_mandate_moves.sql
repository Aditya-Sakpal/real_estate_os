-- ===========================================================================
-- 0063: a mandate moves only the ways the product moves it.
--
-- The developer holds UPDATE on a mandate's status (to withdraw an offer and
-- to end a live one) and INSERT (to offer one), which on their own would let
-- it write a mandate the firm never accepted. Accepting and declining are
-- the firm's, through answer_mandate(), and they are the only moves that
-- stamp answered_at, a column the app role cannot write. So a mandate is
-- born INVITED or OFFERED and unanswered, becomes LIVE or DECLINED only with
-- an answer stamped in the same statement, and its last day only moves
-- later.
-- ===========================================================================

CREATE FUNCTION mandates_moves() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('INVITED', 'OFFERED') OR NEW.answered_at IS NOT NULL OR NEW.answered_by IS NOT NULL
       OR NEW.ended_at IS NOT NULL OR NEW.firm_gstin IS NOT NULL THEN
      RAISE EXCEPTION 'a mandate starts as an offer nobody has answered' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.rate IS DISTINCT FROM OLD.rate OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.firm_pan IS DISTINCT FROM OLD.firm_pan THEN
    RAISE EXCEPTION 'a mandate''s terms do not change once offered' USING ERRCODE = '23514';
  END IF;
  IF NEW.valid_to < OLD.valid_to THEN
    RAISE EXCEPTION 'a mandate''s last day only moves later' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) IN (('INVITED', 'OFFERED'), ('INVITED', 'WITHDRAWN'), ('OFFERED', 'WITHDRAWN'), ('LIVE', 'ENDED')) THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) IN (('OFFERED', 'LIVE'), ('OFFERED', 'DECLINED'))
     AND OLD.answered_at IS NULL AND NEW.answered_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a mandate cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER mandates_moves BEFORE INSERT OR UPDATE ON mandates
  FOR EACH ROW EXECUTE FUNCTION mandates_moves();
