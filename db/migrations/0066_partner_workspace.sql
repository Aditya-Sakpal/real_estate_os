-- ===========================================================================
-- 0066: a channel partner's own workspace.
--
-- A partner firm's people sign in to a workspace of their own and work the
-- buyers they bring to every developer that empanelled them. Their rows live
-- in each developer's tenant, and the application reads them there filtered
-- to the firm, the way the partner bot already does for a message. What the
-- database adds is below.
--
-- 1. The firm finds the developers it works with, from its own tenant: ids
--    and names only, and only where a developer has the firm on its desk.
-- 2. A buyer the partner registers from its workspace says so, rather than
--    reading as entered by the developer's relationship manager.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The developers a firm works with
-- ---------------------------------------------------------------------------
CREATE FUNCTION partner_developers_for_firm()
RETURNS TABLE (org_id uuid, developer text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT o.id, o.display_name
  FROM partner_firms f JOIN orgs o ON o.id = f.org_id
  WHERE app_current_org() IS NOT NULL AND f.cp_org_id = app_current_org()
    AND o.status = 'ACTIVE' AND o.type IN ('DEVELOPER', 'MANDATE_FIRM')
  ORDER BY o.display_name;
$$;
REVOKE ALL ON FUNCTION partner_developers_for_firm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_developers_for_firm() TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- 2. Registered from the partner's workspace
-- ---------------------------------------------------------------------------
ALTER TABLE client_registrations DROP CONSTRAINT client_registrations_via_check;
ALTER TABLE client_registrations ADD CONSTRAINT client_registrations_via_check
  CHECK (via IN ('CONSOLE', 'LINK', 'WHATSAPP', 'WORKSPACE'));
