-- ===========================================================================
--  0094_agent_voices  --  the voice each agent speaks in, per project
--
--  A client picks the voice of each calling agent on the AI agents screen.
--  No row is the agent's own voice. The plan decides which voices may be
--  picked (agent-catalog.ts), asked by the server before a row is written.
-- ===========================================================================

CREATE TABLE agent_voices (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  job        text NOT NULL CHECK (job IN ('QUALIFIER', 'CONFIRMER', 'REENGAGER', 'POST_VISIT')),
  voice      text NOT NULL CHECK (voice IN ('advait', 'shubh', 'priya', 'ritu')),
  set_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, job)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_voices TO salesdesk_app;
ALTER TABLE agent_voices ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_voices_isolation ON agent_voices
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A voice belongs to a project node of the same tenant.
CREATE OR REPLACE FUNCTION agent_voices_on_project() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scope_nodes WHERE id = NEW.project_id AND org_id = NEW.org_id AND kind = 'PROJECT') THEN
    RAISE EXCEPTION 'agent_voices: % is not a project of this organisation', NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_voices_on_project BEFORE INSERT OR UPDATE ON agent_voices
  FOR EACH ROW EXECUTE FUNCTION agent_voices_on_project();
