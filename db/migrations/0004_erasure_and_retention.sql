-- ===========================================================================
--  0004_erasure_and_retention  --  making the schema survive a DPDP request
--
--  The DPDP Rules were notified on 13 November 2025 and full compliance is
--  required by 13 May 2027. Two things in this schema stood in the way, and
--  both were verified against the live database rather than assumed.
--
--  1. Nobody could be erased. Four columns record WHO acted, all declared
--     NO ACTION, so deleting the founding admin raised 23503 from
--     orgs.created_by. Every admin was undeletable.
--
--  2. audit_log could hold a raw email address, written for a person who was
--     REFUSED at sign-in and never became a user at all, in a table the
--     application role has no DELETE grant on. There was no path to remove
--     it, ever.
--
--  The shape of the fix: erasure scrubs the row rather than deleting it, so
--  attribution survives as a uuid that maps to nobody. "Who invited whom"
--  stays answerable; the person is gone. That is pseudonymisation, and it is
--  what the Act asks for. The alternative, cascading deletes through
--  memberships and audit rows, destroys the record that anything happened.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- users -- erasure by tombstone
--
-- email and email_domain become nullable so they can be scrubbed. Postgres
-- allows many NULLs in a UNIQUE column, so any number of people can be erased
-- without colliding with each other.
-- ---------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN email        DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email_domain DROP NOT NULL;
ALTER TABLE users ADD COLUMN erased_at timestamptz;

-- A row may only be nameless if it has been erased. Without this, a bug that
-- nulls an email quietly produces an account nobody can sign into and nobody
-- can explain.
ALTER TABLE users ADD CONSTRAINT users_named_unless_erased
  CHECK (erased_at IS NOT NULL OR email IS NOT NULL);

CREATE INDEX users_erased_idx ON users (erased_at) WHERE erased_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Attribution: NO ACTION becomes SET NULL
--
-- These four say who did something. They must not be the reason a person
-- cannot be forgotten. All four are already nullable, so this is a constraint
-- swap and touches no data.
--
-- The two *_user_id columns keep CASCADE: a membership or a join request
-- belonging to an erased person has no meaning on its own.
-- audit_log.actor_user_id deliberately has no foreign key at all, so it
-- degrades to an opaque uuid and the trail stays intact.
-- ---------------------------------------------------------------------------
ALTER TABLE orgs DROP CONSTRAINT orgs_created_by_fkey;
ALTER TABLE orgs ADD CONSTRAINT orgs_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE memberships DROP CONSTRAINT memberships_invited_by_fkey;
ALTER TABLE memberships ADD CONSTRAINT memberships_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE org_join_requests DROP CONSTRAINT org_join_requests_decided_by_fkey;
ALTER TABLE org_join_requests ADD CONSTRAINT org_join_requests_decided_by_fkey
  FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE org_roles DROP CONSTRAINT org_roles_created_by_fkey;
ALTER TABLE org_roles ADD CONSTRAINT org_roles_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- audit_log -- a clock, and a tripwire
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log ADD COLUMN retain_until timestamptz;
UPDATE audit_log SET retain_until = created_at + interval '7 years'
  WHERE retain_until IS NULL;
ALTER TABLE audit_log ALTER COLUMN retain_until SET NOT NULL;
ALTER TABLE audit_log ALTER COLUMN retain_until
  SET DEFAULT (now() + interval '7 years');

CREATE INDEX audit_log_retain_idx ON audit_log (retain_until);

-- Crude, and it would have caught the bug that prompted all of this. An
-- identifier belonging to a person does not go in target_id; the internal id
-- does, or the domain, or a hash in metadata.
ALTER TABLE audit_log ADD CONSTRAINT audit_log_no_raw_identifier
  CHECK (target_id IS NULL OR target_id NOT LIKE '%@%');

-- ---------------------------------------------------------------------------
-- The retention role
--
-- Append-only should bind the APPLICATION, not the universe. salesdesk_app
-- still holds only SELECT and INSERT here and cannot delete a row under any
-- circumstances. Lawful expiry gets its own identity instead, and the policy
-- below means even a buggy expiry job cannot reach a live row: the predicate
-- is enforced by Postgres, not by the job's WHERE clause.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salesdesk_retention') THEN
    RAISE EXCEPTION
      'Role salesdesk_retention is missing. Run db/bootstrap.sql as a superuser first.';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO salesdesk_retention;
GRANT SELECT, DELETE ON audit_log TO salesdesk_retention;

-- Permissive policies OR together, so the existing tenant-scoped SELECT rule
-- from 0001 is untouched. This adds one more way in, for one role, limited to
-- rows that have already expired.
CREATE POLICY audit_log_expire_read ON audit_log
  FOR SELECT TO salesdesk_retention
  USING (retain_until < now());

CREATE POLICY audit_log_expire_delete ON audit_log
  FOR DELETE TO salesdesk_retention
  USING (retain_until < now());
