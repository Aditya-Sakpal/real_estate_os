-- ===========================================================================
--  0001_rls  --  isolation enforced in the DATABASE, not the application
--
--  Two roles, deliberately:
--
--    salesdesk      table owner. Runs migrations and the control-plane
--                    signup path only (creating a user or an org happens
--                    BEFORE any org context exists, so it cannot be
--                    RLS-scoped). Bypasses RLS by virtue of ownership --
--                    we do NOT enable FORCE ROW LEVEL SECURITY.
--
--    salesdesk_app  every other query in the product. RLS is enforced.
--                    Each transaction does SET LOCAL app.org_id = '<uuid>'
--                    from the verified session, and the policies below take
--                    over from there.
--
--  Policies fail CLOSED: with app.org_id unset, current_org() is NULL, every
--  comparison is NULL, and no rows are visible. A forgotten WHERE clause
--  leaks nothing.
-- ===========================================================================

-- Resolve the current tenant from the transaction-local setting.
-- The `true` second argument makes a missing setting return NULL instead of
-- raising; NULLIF then guards against an empty string reaching the uuid cast.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO salesdesk_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  orgs, scope_nodes, memberships, org_join_requests,
  users, user_identities
TO salesdesk_app;

-- Audit log is append-only for the app role. No UPDATE, no DELETE, ever.
GRANT SELECT, INSERT ON audit_log TO salesdesk_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- orgs
-- ---------------------------------------------------------------------------
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON orgs
  USING (id = app_current_org())
  WITH CHECK (id = app_current_org());

-- ---------------------------------------------------------------------------
-- scope_nodes / memberships / org_join_requests -- straight tenant scoping
-- ---------------------------------------------------------------------------
ALTER TABLE scope_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope_nodes_isolation ON scope_nodes
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_isolation ON memberships
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE org_join_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_join_requests_isolation ON org_join_requests
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- users -- GLOBAL by design, so it cannot carry an org_id column. Visibility
-- is derived instead: you may see a human only if they hold a live membership
-- in the tenant you are currently acting as. This is the row-level rule that
-- stops the global identity table becoming a cross-tenant directory leak.
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_visible_within_org ON users
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.org_id  = app_current_org()
        AND m.status <> 'REVOKED'
    )
  );

ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_identities_visible_within_org ON user_identities
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = user_identities.user_id
        AND m.org_id  = app_current_org()
        AND m.status <> 'REVOKED'
    )
  );

-- ---------------------------------------------------------------------------
-- audit_log -- readable within the tenant, insertable within the tenant,
-- and immutable thereafter (no UPDATE/DELETE grant above).
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_isolation ON audit_log
  FOR SELECT USING (org_id = app_current_org());
CREATE POLICY audit_log_append ON audit_log
  FOR INSERT WITH CHECK (org_id = app_current_org());
