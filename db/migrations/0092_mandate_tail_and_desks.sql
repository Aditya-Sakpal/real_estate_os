-- ===========================================================================
-- 0092: a mandate's tail, and a channel partner on one desk per project.
--
-- 1. A mandate may carry a tail: for so many days after it ends, a booking
--    by a buyer who came while it was live still owes the firm. The tail is
--    offered with the rate and accepted with it, so like the rate it never
--    changes once offered (0063's guarantee, extended).
--
-- 2. A channel partner may sit on two desks of one developer: the
--    developer's own for some projects and a mandate firm's for others. One
--    partner_firms row per desk (NULL mandate is the developer's own), and a
--    project has the partner on one desk at a time: a CHANNEL_PARTNER grant
--    may not overlap, in place or in time, with a live grant of the same
--    partner from another desk. A claim is paid by the desk whose grant it
--    was registered under, so every claim still has exactly one payer, and
--    a payout keeps the payer it was written with (0065).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The tail
-- ---------------------------------------------------------------------------
ALTER TABLE mandates
  ADD COLUMN tail_days integer NOT NULL DEFAULT 0 CHECK (tail_days BETWEEN 0 AND 180);

CREATE OR REPLACE FUNCTION mandates_moves() RETURNS trigger
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
     OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.firm_pan IS DISTINCT FROM OLD.firm_pan
     OR NEW.tail_days IS DISTINCT FROM OLD.tail_days THEN
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

-- The firm reads the tail it is accepting.
DROP FUNCTION mandates_for_firm();
CREATE FUNCTION mandates_for_firm()
RETURNS TABLE (id uuid, developer text, projects text[], rate numeric, valid_from timestamptz, valid_to timestamptz,
               status text, offered_at timestamptz, answered_at timestamptz, developer_org_id uuid, tail_days integer,
               ended_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, o.display_name,
         ARRAY(SELECT p.project_name FROM mandate_projects p WHERE p.mandate_id = m.id ORDER BY p.project_name),
         m.rate, m.valid_from, m.valid_to, m.status, m.created_at, m.answered_at, m.org_id, m.tail_days, m.ended_at
  FROM mandates m JOIN orgs o ON o.id = m.org_id
  WHERE m.firm_org_id = app_current_org() AND app_current_org() IS NOT NULL
    AND m.status IN ('OFFERED', 'LIVE', 'DECLINED', 'ENDED')
  ORDER BY (m.status = 'OFFERED') DESC, m.created_at DESC;
$$;
REVOKE ALL ON FUNCTION mandates_for_firm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandates_for_firm() TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- 2. One row per desk
-- ---------------------------------------------------------------------------
ALTER TABLE partner_firms DROP CONSTRAINT IF EXISTS partner_firms_org_id_cp_org_id_key;
ALTER TABLE partner_firms DROP CONSTRAINT IF EXISTS partner_firms_org_id_pan_key;
CREATE UNIQUE INDEX partner_firms_desk ON partner_firms
  (org_id, cp_org_id, coalesce(mandate_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE UNIQUE INDEX partner_firms_desk_pan ON partner_firms
  (org_id, pan, coalesce(mandate_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX partner_firms_cp ON partner_firms (org_id, cp_org_id);

-- A row still moves desk only once the mandate it was on is over and its
-- own desk has nothing live for the partner. Another desk's grants are that
-- desk's business.
CREATE OR REPLACE FUNCTION partner_firms_desk_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mandate_id IS DISTINCT FROM OLD.mandate_id THEN
    IF OLD.mandate_id IS NULL OR EXISTS (
      SELECT 1 FROM mandates m WHERE m.id = OLD.mandate_id AND m.status = 'LIVE' AND now() < m.valid_to
    ) THEN
      RAISE EXCEPTION 'a partner firm stays on the desk that empanelled it' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM grants g WHERE g.org_id = OLD.org_id AND g.grantee_org_id = OLD.cp_org_id
        AND g.role = 'CHANNEL_PARTNER' AND g.status = 'ACTIVE' AND now() < g.valid_to
        AND g.mandate_id IS NOT DISTINCT FROM OLD.mandate_id
    ) THEN
      RAISE EXCEPTION 'a partner firm moves desk only once its empanelment is over' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. One desk per project at a time
-- ---------------------------------------------------------------------------
CREATE FUNCTION grants_one_desk() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role <> 'CHANNEL_PARTNER' OR NEW.status = 'ENDED' THEN
    RETURN NEW;
  END IF;
  -- Ending, suspending or shortening a grant never needs asking.
  IF TG_OP = 'UPDATE'
     AND NOT (NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE')
     AND NEW.valid_to <= OLD.valid_to AND NEW.valid_from >= OLD.valid_from
     AND NEW.scope_node_id = OLD.scope_node_id AND NEW.mandate_id IS NOT DISTINCT FROM OLD.mandate_id THEN
    RETURN NEW;
  END IF;
  -- Two desks empanelling the same partner at once resolve here, not in a race.
  PERFORM pg_advisory_xact_lock(hashtext('cp-desk:' || NEW.org_id::text || ':' || NEW.grantee_org_id::text));
  IF EXISTS (
    SELECT 1 FROM grants g
    JOIN scope_nodes gn ON gn.id = g.scope_node_id
    JOIN scope_nodes nn ON nn.id = NEW.scope_node_id
    WHERE g.org_id = NEW.org_id AND g.grantee_org_id = NEW.grantee_org_id AND g.role = 'CHANNEL_PARTNER'
      AND g.id <> NEW.id AND g.status <> 'ENDED'
      AND g.mandate_id IS DISTINCT FROM NEW.mandate_id
      AND (gn.path @> nn.path OR nn.path @> gn.path)
      AND g.valid_from < NEW.valid_to AND NEW.valid_from < g.valid_to
  ) THEN
    RAISE EXCEPTION 'a channel partner sells a project through one desk at a time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER grants_one_desk BEFORE INSERT OR UPDATE ON grants
  FOR EACH ROW EXECUTE FUNCTION grants_one_desk();
