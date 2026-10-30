-- ===========================================================================
-- 0103: a channel partner works a developer's project from its own console.
--
-- When the developer is on Sales Desk and has empanelled the channel partner
-- for a project, the partner adds that project to its own console. Its own
-- PROJECT and PHASE nodes are made (its leads, briefs, posts, ads and calls
-- hang off them, on its own plan), and each is linked here to the
-- developer's node it stands for. The facts, the prices, the pictures and
-- the registration are read from the developer's own signed records through
-- the link, never copied and never editable by the partner, and only while
-- the empanelment is live: the day it ends, the partner's towers stop being
-- advertisable and its ads are paused by the kill switch.
-- ===========================================================================

CREATE TABLE linked_nodes (
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id     uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  -- The developer, its node, and the project the empanelment is on.
  source_org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_node_id    uuid NOT NULL,
  source_project_id uuid NOT NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope_node_id),
  CONSTRAINT linked_nodes_other_org CHECK (source_org_id <> org_id)
);
-- One of the partner's nodes per developer node.
CREATE UNIQUE INDEX linked_nodes_one_source ON linked_nodes (org_id, source_org_id, source_node_id);

-- A link is made and taken off, never edited.
GRANT SELECT, INSERT, DELETE ON linked_nodes TO salesdesk_app;
ALTER TABLE linked_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY linked_nodes_isolation ON linked_nodes
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Only a channel partner links, and only its own node.
CREATE FUNCTION linked_nodes_own() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.type = 'CHANNEL_PARTNER') THEN
    RAISE EXCEPTION 'only a channel partner links a developer''s project' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scope_nodes n WHERE n.id = NEW.scope_node_id AND n.org_id = NEW.org_id AND n.kind IN ('PROJECT', 'PHASE')) THEN
    RAISE EXCEPTION 'a link is on a project or a tower of the partner''s own' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER linked_nodes_own BEFORE INSERT ON linked_nodes
  FOR EACH ROW EXECUTE FUNCTION linked_nodes_own();
