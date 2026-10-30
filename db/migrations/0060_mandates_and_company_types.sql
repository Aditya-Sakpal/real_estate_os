-- ===========================================================================
--  0060_mandates_and_company_types  --  three kinds of company sign up, and a
--                                       developer hands a mandate firm the
--                                       selling of its projects
--
--  THREE KINDS OF COMPANY
--
--  A developer builds and owns projects. A mandate firm (Guardians, say) is
--  engaged by a developer to sell them, usually as the sole selling agent,
--  for a commission on every booking. A channel partner is a broker firm
--  that brings buyers for a commission per booking it brings. Each signs up
--  as its own organisation and says which it is: `MANDATE_FIRM` joins the
--  types. What a firm declares about itself that no developer typed (its
--  MahaRERA agent registration, its city, its own number) is its own
--  `firm_profiles` row.
--
--  A MANDATE IS AN OFFER, THEN A GRANT
--
--  The developer offers the mandate: which projects, what commission, until
--  when. A firm that is not on Sales Desk yet is INVITED by the PAN and the
--  work address the developer has for it, and the offer waits for it: when a
--  mandate firm signs up with that PAN, the offer is attached to it and
--  becomes OFFERED. The firm answers from its own workspace. Accepting is
--  the moment it goes LIVE, and each project gets a grant row of role
--  `MANDATE_FIRM`, the cross-org edge every other access hangs off. A firm
--  answers only its own offers, through `answer_mandate()`, which asks
--  nothing of the caller but the tenant it is pinned to.
--
--  One live mandate per project over any stretch of time: a sole selling
--  mandate is exactly that. Offering a project that already has one is
--  refused, and so is accepting one that would now overlap.
--
--  A MANDATE FIRM IS PAID LIKE A PARTNER
--
--  While a mandate is live, every booking in its projects owes the firm its
--  commission, in the same two halves, with the same invoice, verification,
--  approval and UTR a partner's payout moves through. So a payout row says
--  which kind it is (`kind`), and a mandate's row points at the mandate
--  rather than at a buyer's registration. A booking can owe both: the
--  partner who brought the buyer and the firm holding the mandate.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The kinds of company
-- ---------------------------------------------------------------------------
ALTER TABLE orgs DROP CONSTRAINT orgs_type_check;
ALTER TABLE orgs ADD CONSTRAINT orgs_type_check
  CHECK (type IN ('DEVELOPER', 'MANDATE_FIRM', 'CHANNEL_PARTNER', 'AGENCY', 'CALL_CENTER', 'PLATFORM'));

-- What a mandate firm or a channel partner says about itself at sign-up.
CREATE TABLE firm_profiles (
  org_id           uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  rera_agent_no    text NOT NULL CHECK (rera_agent_no ~ '^A[0-9]{11}$'),
  rera_valid_till  date,
  city             text CHECK (city IS NULL OR length(city) BETWEEN 1 AND 80),
  -- E.164, proved with a code when a channel partner signed up.
  phone            text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON firm_profiles TO salesdesk_app;
GRANT UPDATE (rera_agent_no, rera_valid_till, city, phone, updated_at) ON firm_profiles TO salesdesk_app;
ALTER TABLE firm_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_profiles_isolation ON firm_profiles
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- Mandates
-- ---------------------------------------------------------------------------
CREATE TABLE mandates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The developer.
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The mandate firm, once it is on Sales Desk.
  firm_org_id     uuid REFERENCES orgs(id) ON DELETE RESTRICT,
  -- As the developer knows it, and the PAN an invite is matched on.
  firm_name       text NOT NULL CHECK (length(firm_name) BETWEEN 1 AND 160),
  firm_pan        text NOT NULL CHECK (firm_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  -- Whether the firm charges GST, read from its own org when it answers.
  firm_gstin      boolean,
  -- Where an invite went. A work address; never written to audit_log.
  contact_name    text CHECK (contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 120),
  contact_email   citext CHECK (contact_email IS NULL OR contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  rate            numeric(6, 5) NOT NULL CHECK (rate >= 0.005 AND rate <= 0.08),
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz NOT NULL,
  --   INVITED    the firm is not on Sales Desk; waiting for it to sign up
  --   OFFERED    waiting for the firm's answer
  --   LIVE       accepted: commission on every booking in its projects while
  --              the window is open
  --   DECLINED   the firm said no
  --   WITHDRAWN  the developer took the offer back before it was answered
  --   ENDED      the developer ended a live mandate
  status          text NOT NULL CHECK (status IN ('INVITED', 'OFFERED', 'LIVE', 'DECLINED', 'WITHDRAWN', 'ENDED')),
  offered_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  answered_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  answered_at     timestamptz,
  ended_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mandates_window CHECK (valid_to > valid_from),
  CONSTRAINT mandates_firm CHECK (
    (status = 'INVITED' AND firm_org_id IS NULL AND contact_email IS NOT NULL)
    OR (status IN ('OFFERED', 'LIVE', 'DECLINED') AND firm_org_id IS NOT NULL)
    OR status IN ('WITHDRAWN', 'ENDED')),
  CONSTRAINT mandates_other_org CHECK (firm_org_id IS NULL OR firm_org_id <> org_id)
);
CREATE INDEX mandates_org ON mandates (org_id, status);
CREATE INDEX mandates_firm ON mandates (firm_org_id, status) WHERE firm_org_id IS NOT NULL;
CREATE INDEX mandates_invited ON mandates (firm_pan) WHERE status = 'INVITED';

CREATE TABLE mandate_projects (
  mandate_id     uuid NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  -- As it was named when offered, for the firm, which cannot read the tree.
  project_name   text NOT NULL CHECK (length(project_name) BETWEEN 1 AND 200),
  -- The grant made when the firm accepted.
  grant_id       uuid REFERENCES grants(id) ON DELETE SET NULL,
  PRIMARY KEY (mandate_id, scope_node_id)
);
CREATE INDEX mandate_projects_node ON mandate_projects (org_id, scope_node_id);

GRANT SELECT, INSERT ON mandates, mandate_projects TO salesdesk_app;
GRANT UPDATE (status, valid_to, ended_by, ended_at, updated_at) ON mandates TO salesdesk_app;
GRANT UPDATE (grant_id) ON mandate_projects TO salesdesk_app;

ALTER TABLE mandates ENABLE ROW LEVEL SECURITY;
CREATE POLICY mandates_isolation ON mandates
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
ALTER TABLE mandate_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY mandate_projects_isolation ON mandate_projects
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- A grant is a partner's or a mandate firm's.
ALTER TABLE grants DROP CONSTRAINT grants_role_check;
ALTER TABLE grants ADD CONSTRAINT grants_role_check CHECK (role IN ('CHANNEL_PARTNER', 'MANDATE_FIRM'));

-- ---------------------------------------------------------------------------
-- A payout is a partner's or a mandate firm's
-- ---------------------------------------------------------------------------
ALTER TABLE partner_payouts
  ADD COLUMN kind text NOT NULL DEFAULT 'PARTNER' CHECK (kind IN ('PARTNER', 'MANDATE')),
  ADD COLUMN mandate_id uuid REFERENCES mandates(id) ON DELETE RESTRICT;
ALTER TABLE partner_payouts ALTER COLUMN registration_id DROP NOT NULL;
ALTER TABLE partner_payouts ADD CONSTRAINT partner_payouts_kind CHECK (
  (kind = 'PARTNER' AND registration_id IS NOT NULL AND mandate_id IS NULL)
  OR (kind = 'MANDATE' AND mandate_id IS NOT NULL AND registration_id IS NULL AND pass_back = 0));
ALTER TABLE partner_payouts DROP CONSTRAINT partner_payouts_rate_check;
ALTER TABLE partner_payouts ADD CONSTRAINT partner_payouts_rate_check CHECK (rate > 0 AND rate <= 0.08);
DROP INDEX partner_payouts_live;
CREATE UNIQUE INDEX partner_payouts_live ON partner_payouts (org_id, lead_id, kind) WHERE cancelled_at IS NULL;
CREATE INDEX partner_payouts_mandate ON partner_payouts (org_id, mandate_id) WHERE mandate_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The reads and writes across tenants, ids and names only
-- ---------------------------------------------------------------------------

-- A developer looking up a mandate firm by its PAN: only a firm that signed
-- up itself, and only its name.
CREATE FUNCTION mandate_firm_by_pan(p_pan text)
RETURNS TABLE (id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.display_name FROM orgs o
  WHERE o.pan = upper(trim(p_pan)) AND o.type = 'MANDATE_FIRM' AND o.status = 'ACTIVE'
    AND app_current_org() IS NOT NULL
  ORDER BY o.created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION mandate_firm_by_pan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandate_firm_by_pan(text) TO salesdesk_app;

-- A mandate firm's own offers and mandates, from every developer.
CREATE FUNCTION mandates_for_firm()
RETURNS TABLE (id uuid, developer text, projects text[], rate numeric, valid_from timestamptz, valid_to timestamptz,
               status text, offered_at timestamptz, answered_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, o.display_name,
         ARRAY(SELECT p.project_name FROM mandate_projects p WHERE p.mandate_id = m.id ORDER BY p.project_name),
         m.rate, m.valid_from, m.valid_to, m.status, m.created_at, m.answered_at
  FROM mandates m JOIN orgs o ON o.id = m.org_id
  WHERE m.firm_org_id = app_current_org() AND app_current_org() IS NOT NULL
    AND m.status IN ('OFFERED', 'LIVE', 'DECLINED', 'ENDED')
  ORDER BY (m.status = 'OFFERED') DESC, m.created_at DESC;
$$;
REVOKE ALL ON FUNCTION mandates_for_firm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandates_for_firm() TO salesdesk_app;

-- A channel partner's own empanelments, from every developer.
CREATE FUNCTION partner_grants_for_firm()
RETURNS TABLE (developer text, project text, status text, valid_to timestamptz, live boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.display_name, n.name, g.status, g.valid_to,
         g.status = 'ACTIVE' AND now() >= g.valid_from AND now() < g.valid_to
  FROM grants g JOIN orgs o ON o.id = g.org_id JOIN scope_nodes n ON n.id = g.scope_node_id
  WHERE g.grantee_org_id = app_current_org() AND app_current_org() IS NOT NULL AND g.role = 'CHANNEL_PARTNER'
    AND g.status <> 'ENDED'
  ORDER BY o.display_name, n.name;
$$;
REVOKE ALL ON FUNCTION partner_grants_for_firm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_grants_for_firm() TO salesdesk_app;

-- The firm answers its own offer, and nothing else. Accepting makes the
-- mandate live and gives each of its projects a grant; the lock on the
-- developer's projects makes two offers accepted at once resolve here.
CREATE FUNCTION answer_mandate(p_mandate uuid, p_accept boolean, p_user uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m mandates%ROWTYPE;
  p mandate_projects%ROWTYPE;
  g uuid;
BEGIN
  IF app_current_org() IS NULL THEN RETURN 'NOT_YOURS'; END IF;
  SELECT * INTO m FROM mandates WHERE id = p_mandate FOR UPDATE;
  IF NOT FOUND OR m.firm_org_id IS DISTINCT FROM app_current_org() THEN RETURN 'NOT_YOURS'; END IF;
  IF m.status <> 'OFFERED' THEN RETURN 'ANSWERED'; END IF;
  IF m.valid_to <= now() THEN RETURN 'EXPIRED'; END IF;

  IF NOT p_accept THEN
    UPDATE mandates SET status = 'DECLINED', answered_by = p_user, answered_at = now(), updated_at = now()
    WHERE id = m.id;
    INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (m.org_id, p_user, 'mandate.declined', 'mandate', m.id::text, '{}'::jsonb);
    RETURN 'DECLINED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('mandate:' || m.org_id::text));
  IF EXISTS (
    SELECT 1 FROM mandates o JOIN mandate_projects op ON op.mandate_id = o.id
    WHERE o.org_id = m.org_id AND o.id <> m.id AND o.status = 'LIVE'
      AND o.valid_from < m.valid_to AND m.valid_from < o.valid_to
      AND op.scope_node_id IN (SELECT scope_node_id FROM mandate_projects WHERE mandate_id = m.id)
  ) THEN
    RETURN 'TAKEN';
  END IF;

  UPDATE mandates SET status = 'LIVE', answered_by = p_user, answered_at = now(), updated_at = now(),
         firm_gstin = (SELECT gstin IS NOT NULL FROM orgs WHERE id = m.firm_org_id)
  WHERE id = m.id;
  FOR p IN SELECT * FROM mandate_projects WHERE mandate_id = m.id LOOP
    INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_from, valid_to, status, created_by)
    VALUES (m.org_id, m.firm_org_id, p.scope_node_id, 'MANDATE_FIRM', greatest(m.valid_from, now() - interval '1 second'),
            m.valid_to, 'ACTIVE', p_user)
    RETURNING id INTO g;
    UPDATE mandate_projects SET grant_id = g WHERE mandate_id = m.id AND scope_node_id = p.scope_node_id;
  END LOOP;
  INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (m.org_id, p_user, 'mandate.accepted', 'mandate', m.id::text, '{}'::jsonb);
  RETURN 'LIVE';
END;
$$;
REVOKE ALL ON FUNCTION answer_mandate(uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION answer_mandate(uuid, boolean, uuid) TO salesdesk_app;
