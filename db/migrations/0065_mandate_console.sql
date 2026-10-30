-- ===========================================================================
-- 0065: a mandate firm works the developer's project, and runs its own
-- channel partners on it.
--
-- A mandate firm's people work inside the developer's tenant, bounded by the
-- live MANDATE_FIRM grant and by their own role in their firm; that is
-- resolved in code (`grant-access.ts`), the way a scoped member's reach is.
-- What the database adds is below.
--
-- 1. The developer can read the names of the people who act on its data
--    through a mandate: a lead's owner, a visit's host, an audit row.
-- 2. A channel partner firm sits on one desk per developer: the developer's
--    own (mandate_id NULL) or one mandate firm's. Its grants, commission
--    terms and payouts carry the same mandate, so the firm that empanelled a
--    partner is the firm that pays it.
-- 3. A mandate firm's partner grant stays inside its mandate: its projects,
--    its days, and only while it is live.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Names of the people working through a mandate
-- ---------------------------------------------------------------------------
CREATE FUNCTION mandate_people() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(array_agg(DISTINCT m.user_id), '{}')
  FROM grants g JOIN memberships m ON m.org_id = g.grantee_org_id AND m.status <> 'REVOKED'
  WHERE app_current_org() IS NOT NULL AND g.org_id = app_current_org() AND g.role = 'MANDATE_FIRM';
$$;
REVOKE ALL ON FUNCTION mandate_people() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandate_people() TO salesdesk_app;

CREATE POLICY users_visible_via_mandate ON users FOR SELECT
  USING (id = ANY (mandate_people()));

-- ---------------------------------------------------------------------------
-- 2. Desks
-- ---------------------------------------------------------------------------
ALTER TABLE partner_firms ADD COLUMN mandate_id uuid REFERENCES mandates(id) ON DELETE RESTRICT;
ALTER TABLE grants ADD COLUMN mandate_id uuid REFERENCES mandates(id) ON DELETE RESTRICT;
ALTER TABLE commission_terms ADD COLUMN mandate_id uuid REFERENCES mandates(id) ON DELETE RESTRICT;
ALTER TABLE partner_payouts ADD COLUMN payer_mandate_id uuid REFERENCES mandates(id) ON DELETE RESTRICT;

-- A project has one set of terms per desk.
ALTER TABLE commission_terms DROP CONSTRAINT commission_terms_org_id_scope_node_id_key;
CREATE UNIQUE INDEX commission_terms_desk ON commission_terms
  (org_id, scope_node_id, coalesce(mandate_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX partner_firms_mandate ON partner_firms (org_id, mandate_id) WHERE mandate_id IS NOT NULL;
CREATE INDEX grants_mandate ON grants (org_id, mandate_id) WHERE mandate_id IS NOT NULL;
CREATE INDEX partner_payouts_payer ON partner_payouts (org_id, payer_mandate_id) WHERE payer_mandate_id IS NOT NULL;

-- The mandate's own grants name their mandate too, now and from every
-- acceptance on (answer_mandate() links the grant through mandate_projects).
UPDATE grants g SET mandate_id = p.mandate_id
FROM mandate_projects p WHERE p.grant_id = g.id AND g.role = 'MANDATE_FIRM' AND g.mandate_id IS NULL;

CREATE FUNCTION mandate_grant_named() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grant_id IS NOT NULL AND NEW.grant_id IS DISTINCT FROM OLD.grant_id THEN
    UPDATE grants SET mandate_id = NEW.mandate_id WHERE id = NEW.grant_id AND role = 'MANDATE_FIRM';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mandate_grant_named AFTER UPDATE OF grant_id ON mandate_projects
  FOR EACH ROW EXECUTE FUNCTION mandate_grant_named();

-- A firm's desk moves only once the mandate it was on is over, so a partner
-- is never stranded on a firm that no longer works the project. Every payout
-- keeps the payer it was written with, which is why this is a column on the
-- payout and not read through the firm.
CREATE FUNCTION partner_firms_desk_fixed() RETURNS trigger
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
    ) THEN
      RAISE EXCEPTION 'a partner firm moves desk only once its empanelment is over' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER partner_firms_desk_fixed BEFORE UPDATE ON partner_firms
  FOR EACH ROW EXECUTE FUNCTION partner_firms_desk_fixed();

-- ---------------------------------------------------------------------------
-- 3. A mandate firm's partner grant stays inside its mandate
-- ---------------------------------------------------------------------------
CREATE FUNCTION grants_inside_mandate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m mandates%ROWTYPE;
BEGIN
  IF NEW.mandate_id IS NULL OR NEW.role <> 'CHANNEL_PARTNER' THEN
    RETURN NEW;
  END IF;
  -- Ending or suspending a grant is always allowed.
  IF TG_OP = 'UPDATE' AND NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO m FROM mandates WHERE id = NEW.mandate_id;
  IF NOT FOUND OR m.org_id <> NEW.org_id OR m.status <> 'LIVE' THEN
    RAISE EXCEPTION 'a mandate firm empanels partners only while its mandate is live' USING ERRCODE = '23514';
  END IF;
  IF NEW.valid_to > m.valid_to THEN
    RAISE EXCEPTION 'a partner''s empanelment cannot outlast the mandate' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mandate_projects p
    JOIN scope_nodes pn ON pn.id = p.scope_node_id
    JOIN scope_nodes gn ON gn.id = NEW.scope_node_id
    WHERE p.mandate_id = m.id AND gn.path <@ pn.path
  ) THEN
    RAISE EXCEPTION 'a mandate firm empanels partners only on its own projects' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER grants_inside_mandate BEFORE INSERT OR UPDATE ON grants
  FOR EACH ROW EXECUTE FUNCTION grants_inside_mandate();

-- ---------------------------------------------------------------------------
-- 4. What a mandate firm is owed, read from its own workspace
-- ---------------------------------------------------------------------------
CREATE FUNCTION mandate_payouts_for_firm()
RETURNS TABLE (payout_id uuid, developer text, project text, unit text, agreement numeric, rate numeric, booked_on date,
               cancelled boolean, halves jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, o.display_name, n.name, p.unit, p.agreement, p.rate, p.booked_on::date, p.cancelled_at IS NOT NULL,
         coalesce((SELECT jsonb_agg(jsonb_build_object('key', ms.key, 'net', ms.net, 'gross', ms.gross, 'stage', ms.stage,
                                                        'paid_on', ms.paid_on,
                                                        'owed', CASE ms.key WHEN 'M1' THEN p.agreement_registered_on IS NOT NULL
                                                                            ELSE p.collected_on IS NOT NULL END) ORDER BY ms.key)
                   FROM payout_milestones ms WHERE ms.payout_id = p.id), '[]'::jsonb)
  FROM partner_payouts p
  JOIN mandates m ON m.id = p.mandate_id
  JOIN orgs o ON o.id = p.org_id
  JOIN scope_nodes n ON n.id = p.scope_node_id
  WHERE app_current_org() IS NOT NULL AND m.firm_org_id = app_current_org() AND p.kind = 'MANDATE'
  ORDER BY p.booked_on DESC;
$$;
REVOKE ALL ON FUNCTION mandate_payouts_for_firm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandate_payouts_for_firm() TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- 5. A firm's mandates name the developer's org, so its workspace can open it
-- ---------------------------------------------------------------------------
DROP FUNCTION mandates_for_firm();
CREATE FUNCTION mandates_for_firm()
RETURNS TABLE (id uuid, developer text, projects text[], rate numeric, valid_from timestamptz, valid_to timestamptz,
               status text, offered_at timestamptz, answered_at timestamptz, developer_org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, o.display_name,
         ARRAY(SELECT p.project_name FROM mandate_projects p WHERE p.mandate_id = m.id ORDER BY p.project_name),
         m.rate, m.valid_from, m.valid_to, m.status, m.created_at, m.answered_at, m.org_id
  FROM mandates m JOIN orgs o ON o.id = m.org_id
  WHERE m.firm_org_id = app_current_org() AND app_current_org() IS NOT NULL
    AND m.status IN ('OFFERED', 'LIVE', 'DECLINED', 'ENDED')
  ORDER BY (m.status = 'OFFERED') DESC, m.created_at DESC;
$$;
REVOKE ALL ON FUNCTION mandates_for_firm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandates_for_firm() TO salesdesk_app;
