-- ===========================================================================
-- 0109: a developer's bank tie-ups, in one place.
--
-- `lenders` (0055) was a name and an address, kept in Settings, Lead rules,
-- and the Brain's "Home-loan tie-ups" was a separate line of text. A tie-up
-- is now a lender with its own contact, the rate and fee it offers the
-- developer's buyers, until when, and the projects it has approved
-- (`lender_projects`, with the bank's approval number when it has one).
-- The lender question, the calling agents' facts and the loan file all read
-- it. The address stays as it was written: a new address is a new lender.
-- ===========================================================================

ALTER TABLE lenders
  ADD COLUMN contact_name   text CHECK (contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 80),
  ADD COLUMN contact_phone  text CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- The lowest yearly rate it offers, in basis points.
  ADD COLUMN rate_bp        integer CHECK (rate_bp IS NULL OR rate_bp BETWEEN 100 AND 2500),
  ADD COLUMN fee_note       text CHECK (fee_note IS NULL OR length(fee_note) BETWEEN 1 AND 120),
  ADD COLUMN valid_until    date,
  ADD COLUMN updated_by     uuid REFERENCES users(id) ON DELETE SET NULL;

GRANT UPDATE (contact_name, contact_phone, rate_bp, fee_note, valid_until, updated_by) ON lenders TO salesdesk_app;

CREATE TABLE lender_projects (
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lender_id      uuid NOT NULL REFERENCES lenders(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  -- The bank's approval of the project (APF), when it gave a number.
  apf_no         text CHECK (apf_no IS NULL OR length(apf_no) BETWEEN 1 AND 60),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lender_id, scope_node_id)
);

CREATE INDEX lender_projects_node ON lender_projects (org_id, scope_node_id);

CREATE FUNCTION lender_projects_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lenders WHERE id = NEW.lender_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'A tie-up names one of its own organisation''s lenders' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scope_nodes WHERE id = NEW.scope_node_id AND org_id = NEW.org_id AND kind = 'PROJECT') THEN
    RAISE EXCEPTION 'A tie-up is with a project of the same organisation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lender_projects_check
  BEFORE INSERT OR UPDATE ON lender_projects
  FOR EACH ROW EXECUTE FUNCTION lender_projects_check();

GRANT SELECT, INSERT, DELETE ON lender_projects TO salesdesk_app;
GRANT UPDATE (apf_no) ON lender_projects TO salesdesk_app;
ALTER TABLE lender_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY lender_projects_isolation ON lender_projects
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
