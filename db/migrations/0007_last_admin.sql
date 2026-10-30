-- An organisation always has at least one administrator.
--
-- This is the invariant that makes admin transfer safe to offer at all. The
-- first signup is frequently the agency's rather than the developer's, so
-- handing the role over is an ordinary thing to want; handing it over badly
-- leaves a tenant nobody can administer, and recovery then means platform
-- impersonation, which is time-boxed and audited by design rather than a
-- routine fix.
--
-- Enforced here rather than in the application because the failure is silent
-- and permanent. A transfer, a demotion, a revocation and an erasure are four
-- different code paths that can each empty the set, and the fifth is somebody
-- with a psql prompt. Only the database sees all five.
--
-- A CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, so the check runs once
-- at COMMIT rather than after each row. That is what lets a transfer be
-- written in whichever order reads best: demote then promote is as valid as
-- promote then demote, and only the state at commit has to be legal.

CREATE OR REPLACE FUNCTION assert_org_keeps_an_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_org uuid := COALESCE(NEW.org_id, OLD.org_id);
  admins int;
  org_alive boolean;
BEGIN
  -- A tenant being wound up is allowed to end with nobody in it. The rule
  -- protects live organisations from becoming unadministrable, not archives
  -- from being archived.
  SELECT status <> 'SUSPENDED' INTO org_alive FROM orgs WHERE id = target_org;
  IF org_alive IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO admins
  FROM memberships
  WHERE org_id = target_org AND role = 'ORG_ADMIN' AND status = 'ACTIVE';

  IF admins = 0 THEN
    RAISE EXCEPTION
      'An organisation must keep at least one active admin'
      USING ERRCODE = 'check_violation',
            HINT = 'Promote someone else before giving up or removing the last ORG_ADMIN.';
  END IF;

  RETURN NULL;
END;
$$;

-- UPDATE and DELETE only. An INSERT can never remove the last admin, and
-- firing on it would make creating an org fail on its own first row.
DROP TRIGGER IF EXISTS memberships_keep_an_admin ON memberships;
CREATE CONSTRAINT TRIGGER memberships_keep_an_admin
  AFTER UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_org_keeps_an_admin();

-- The count above reads every membership in the org, so it wants the index
-- that a partial one gives it: admins are a handful of rows in a table that
-- will hold every field agent.
CREATE INDEX IF NOT EXISTS memberships_active_admins
  ON memberships (org_id)
  WHERE role = 'ORG_ADMIN' AND status = 'ACTIVE';
