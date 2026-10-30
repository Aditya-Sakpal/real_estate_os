-- ===========================================================================
--  0093_portal_leads  --  leads from the property portals, for a developer
--                         with no CRM between the portal and us
--
--  A PORTAL LEAD ARRIVES BY EMAIL, OR IN THE PORTAL'S EXPORT
--
--  99acres, MagicBricks, Housing.com and NoBroker tell the developer about
--  each enquiry by email. The developer forwards those emails to an address
--  of its own here (`leads-<org>-<key>@<domain>`), or uploads the portal's
--  export. Each enquiry is a `lead_events` row with source PORTAL, keyed on
--  the portal's own id or a fingerprint, so an email sent twice is one lead,
--  and from there it takes the ordinary capture path. The lead's channel is
--  PORTAL; which portal is on its lineage.
--
--  THE PORTAL'S PROJECT IS MATCHED BY A PERSON, ONCE PER WORDING
--
--  A portal writes the project its own way ("Sath Heights, Goregaon West").
--  `portal_projects` holds each wording an organisation has received and the
--  tower a person matched it to. An enquiry whose wording nobody matched
--  WAITS (outcome WAITING) and shows on Today; it is never placed on a guess.
--  The worker passes over a waiting event, and matching the wording releases
--  every event waiting on it.
--
--  THE ADDRESS'S KEY CAN BE CHANGED
--
--  The key is derived from the server's secret and a version per
--  organisation (`portal_settings`); changing it bumps the version, and the
--  old address stops working at once. The version only goes up.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- PORTAL as a source and a channel, WAITING as an outcome. Each CHECK is
-- extended from its current definition rather than restated, so a value
-- another migration added is kept.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t record;
  def text;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('lead_events', 'lead_events_source_check', 'PORTAL'),
      ('leads', 'leads_channel_check', 'PORTAL'),
      ('lead_events', 'lead_events_outcome_check', 'WAITING')
    ) AS v(tbl, con, val)
  LOOP
    SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c WHERE c.conrelid = t.tbl::regclass AND c.conname = t.con;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint % on % not found', t.con, t.tbl;
    END IF;
    IF def NOT LIKE ('%''' || t.val || '''%') THEN
      IF position('ARRAY[' IN def) = 0 THEN
        RAISE EXCEPTION 'constraint % is not a list of values: %', t.con, def;
      END IF;
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t.tbl, t.con);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', t.tbl, t.con,
        replace(def, 'ARRAY[', 'ARRAY[' || quote_literal(t.val) || '::text, '));
    END IF;
  END LOOP;
END $$;

-- The worker reads pending events by received_at; a waiting one is found by
-- the wording it waits on.
CREATE INDEX lead_events_waiting ON lead_events (org_id, source) WHERE outcome = 'WAITING';

-- ---------------------------------------------------------------------------
-- The address's key version, one row per organisation
-- ---------------------------------------------------------------------------
CREATE TABLE portal_settings (
  org_id       uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  key_version  integer NOT NULL DEFAULT 1 CHECK (key_version BETWEEN 1 AND 1000000),
  rotated_at   timestamptz,
  rotated_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE FUNCTION portal_settings_forward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key_version < OLD.key_version THEN
    RAISE EXCEPTION 'a portal key version only goes up';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_settings_forward BEFORE UPDATE ON portal_settings
  FOR EACH ROW EXECUTE FUNCTION portal_settings_forward();

GRANT SELECT, INSERT ON portal_settings TO salesdesk_app;
GRANT UPDATE (key_version, rotated_at, rotated_by) ON portal_settings TO salesdesk_app;
ALTER TABLE portal_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_settings_isolation ON portal_settings
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- Each wording a portal used for a project, and the tower it means here
-- ---------------------------------------------------------------------------
CREATE TABLE portal_projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- `portal-rules.ts` projectKey(): lower case, letters and digits.
  project_key    text NOT NULL CHECK (length(project_key) BETWEEN 1 AND 160),
  -- The wording as it first arrived, for the screen.
  project_text   text CHECK (project_text IS NULL OR length(project_text) <= 160),
  -- The portal it first arrived from.
  portal         text NOT NULL CHECK (portal IN ('99ACRES', 'MAGICBRICKS', 'HOUSING', 'NOBROKER', 'OTHER')),
  -- The tower a person matched it to, or that the wording names exactly.
  phase_id       uuid REFERENCES scope_nodes(id) ON DELETE SET NULL,
  -- A person said it is none of theirs: its enquiries are closed, not placed.
  not_ours       boolean NOT NULL DEFAULT false,
  -- NULL with a tower means it was matched by its exact name, not by a person.
  matched_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  matched_at     timestamptz,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, project_key),
  CHECK (NOT (not_ours AND phase_id IS NOT NULL))
);

-- The tower must be one of this organisation's towers.
CREATE FUNCTION portal_projects_own_phase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM scope_nodes WHERE id = NEW.phase_id AND org_id = NEW.org_id AND kind = 'PHASE'
  ) THEN
    RAISE EXCEPTION 'a portal project is matched to a tower of the same organisation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_projects_own_phase BEFORE INSERT OR UPDATE OF phase_id ON portal_projects
  FOR EACH ROW EXECUTE FUNCTION portal_projects_own_phase();

GRANT SELECT, INSERT ON portal_projects TO salesdesk_app;
GRANT UPDATE (project_text, phase_id, not_ours, matched_by, matched_at, last_seen_at) ON portal_projects TO salesdesk_app;
ALTER TABLE portal_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_projects_isolation ON portal_projects
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
