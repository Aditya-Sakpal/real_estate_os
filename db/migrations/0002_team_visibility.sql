-- ===========================================================================
--  0002_team_visibility
--
--  An admin adjudicating a join request has to see who is asking. The users
--  policy from 0001 derives visibility from membership alone, and a requester
--  has no membership yet -- that is the whole point of the request -- so the
--  rows rendered blank.
--
--  Rather than reaching for the owner connection to read around RLS, the
--  visibility rule itself is extended: a person is visible inside a tenant if
--  they hold a live membership in it OR have a pending request to join it.
--  Multiple permissive policies OR together, so 0001's rule is untouched.
-- ===========================================================================

CREATE POLICY users_visible_pending_join ON users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_join_requests r
      WHERE r.user_id = users.id
        AND r.org_id  = app_current_org()
        AND r.status  = 'PENDING'
    )
  );

-- The adjudicating admin needs to resolve the request to a membership, which
-- 0001 already permits within the tenant. Nothing further is granted here:
-- visibility ends the moment the request stops being PENDING.
