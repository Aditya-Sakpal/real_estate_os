-- ===========================================================================
--  bootstrap  --  the three database roles, created once, by a superuser
--
--  Migrations cannot do this. They run as `salesdesk`, which deliberately
--  has neither SUPERUSER nor CREATEROLE: the role that runs schema changes
--  should not be able to invent new identities for itself.
--
--  Run this ONCE per environment, before the first migration:
--
--      psql -U postgres -d salesdesk -v pw_app=... -v pw_ret=... \
--           -f db/bootstrap.sql
--
--  Then put the connection strings in .env.local:
--      DATABASE_URL            salesdesk          (owner, control plane)
--      DATABASE_APP_URL        salesdesk_app      (RLS enforced, the product)
--      DATABASE_RETENTION_URL  salesdesk_retention (audit expiry job only)
--
--  Why three and not two:
--
--    salesdesk            owns the tables and bypasses RLS by ownership.
--                          Migrations, sign-in and org creation only.
--
--    salesdesk_app        every other query. RLS enforced. Holds SELECT and
--                          INSERT on audit_log and nothing more, which is
--                          what "append-only" actually means here: a grant
--                          binding the application, not a law of physics.
--
--    salesdesk_retention  one nightly job that expires audit rows. It can
--                          DELETE from audit_log and touch no other table,
--                          and its policy lets it delete only rows already
--                          past retain_until. A bug in that job cannot
--                          reach a live row.
--
--  Keeping expiry out of salesdesk_app is the point. Retention limits under
--  the DPDP Act need deletion to be possible; the audit trail needs it to be
--  impossible for the product. Both hold, because they are different roles.
-- ===========================================================================

-- The owner. Already exists in every environment built so far.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salesdesk') THEN
    RAISE EXCEPTION 'Role salesdesk is missing. Create it and the database first.';
  END IF;
END $$;

-- The application role. RLS applies to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salesdesk_app') THEN
    EXECUTE format('CREATE ROLE salesdesk_app LOGIN PASSWORD %L', :'pw_app');
  END IF;
END $$;

-- The retention role. No table privileges here; migration 0004 grants the
-- single one it is allowed to have.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salesdesk_retention') THEN
    EXECUTE format('CREATE ROLE salesdesk_retention LOGIN PASSWORD %L', :'pw_ret');
  END IF;
END $$;

-- Neither may create further roles, and neither inherits the owner's bypass.
ALTER ROLE salesdesk_app       NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE salesdesk_retention NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Nothing is granted by default. Every privilege these roles hold is granted
-- explicitly by a migration, so the grants live in version control.
REVOKE ALL ON SCHEMA public FROM salesdesk_app, salesdesk_retention;
