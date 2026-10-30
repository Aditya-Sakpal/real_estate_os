-- ===========================================================================
-- 0105: a project's own share of a shared allowance.
--
-- A channel partner's plan is one allowance for every project it covers,
-- and a developer's plans pool from five projects. One busy project could
-- then use the month's minutes or videos for all of them. An organisation
-- may set, per project and per unit, the most that project may use in a
-- month. Nothing set is no limit beyond the plan's own. It is asked before
-- anything is paid for, beside the plan.
-- ===========================================================================

CREATE TABLE project_caps (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  unit        text NOT NULL CHECK (unit IN ('MINUTE', 'IMAGE', 'CAROUSEL', 'VIDEO')),
  monthly     integer NOT NULL CHECK (monthly BETWEEN 1 AND 1000000),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, unit)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON project_caps TO salesdesk_app;
ALTER TABLE project_caps ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_caps_isolation ON project_caps
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- The project is the organisation's own, and a project.
CREATE FUNCTION project_caps_own() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scope_nodes n WHERE n.id = NEW.project_id AND n.org_id = NEW.org_id AND n.kind = 'PROJECT') THEN
    RAISE EXCEPTION 'a limit is set on a project of the organisation''s own' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_caps_own BEFORE INSERT OR UPDATE ON project_caps
  FOR EACH ROW EXECUTE FUNCTION project_caps_own();
