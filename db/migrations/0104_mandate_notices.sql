-- What a mandate's two sides tell each other, and what the firm can see of
-- its own commission (13 October 2026).
--
-- 1. A renewal and a firm's request to run longer are stamped on the
--    mandate, so Today on either side can say so.
-- 2. A rejected invoice says why, in a fixed code.
-- 3. The firm reads a withdrawn offer, the renewal, its request, the buyer
--    a commission is for and its own invoice, through its two functions.
-- 4. Two narrow reads of who to email: the firm's admins, from the
--    developer's tenant; the person who offered the mandate, from the firm's.

-- ---------------------------------------------------------------------------
-- 1. Renewed, and asked to run longer
-- ---------------------------------------------------------------------------
ALTER TABLE mandates
  ADD COLUMN renewed_at timestamptz,
  ADD COLUMN extension_asked_at timestamptz,
  ADD COLUMN extension_asked_by uuid REFERENCES users(id) ON DELETE SET NULL;
-- The developer stamps a renewal and clears a request it answered; the firm
-- asks only through ask_mandate_extension().
GRANT UPDATE (renewed_at, extension_asked_at, extension_asked_by) ON mandates TO salesdesk_app;

CREATE FUNCTION ask_mandate_extension(p_mandate uuid, p_user uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m mandates%ROWTYPE;
BEGIN
  IF app_current_org() IS NULL THEN RETURN 'NOT_YOURS'; END IF;
  SELECT * INTO m FROM mandates WHERE id = p_mandate FOR UPDATE;
  IF NOT FOUND OR m.firm_org_id IS DISTINCT FROM app_current_org() THEN RETURN 'NOT_YOURS'; END IF;
  IF m.status <> 'LIVE' OR m.valid_to <= now() THEN RETURN 'NOT_LIVE'; END IF;
  IF m.extension_asked_at IS NOT NULL AND m.extension_asked_at > now() - interval '7 days' THEN RETURN 'ALREADY'; END IF;
  UPDATE mandates SET extension_asked_at = now(), extension_asked_by = p_user, updated_at = now() WHERE id = m.id;
  INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (m.org_id, p_user, 'mandate.extension_asked', 'mandate', m.id::text, '{}'::jsonb);
  RETURN 'ASKED';
END;
$$;
REVOKE ALL ON FUNCTION ask_mandate_extension(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ask_mandate_extension(uuid, uuid) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- 2. Why an invoice was sent back
-- ---------------------------------------------------------------------------
ALTER TABLE partner_invoices
  ADD COLUMN reject_reason text CHECK (reject_reason IS NULL OR reject_reason IN ('AMOUNT', 'GST', 'DETAILS', 'FILE', 'OTHER'));
GRANT UPDATE (reject_reason) ON partner_invoices TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- 3. The firm's two reads
-- ---------------------------------------------------------------------------
DROP FUNCTION mandates_for_firm();
CREATE FUNCTION mandates_for_firm()
RETURNS TABLE (id uuid, developer text, projects text[], rate numeric, valid_from timestamptz, valid_to timestamptz,
               status text, offered_at timestamptz, answered_at timestamptz, developer_org_id uuid, tail_days integer,
               ended_at timestamptz, renewed_at timestamptz, extension_asked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, o.display_name,
         ARRAY(SELECT p.project_name FROM mandate_projects p WHERE p.mandate_id = m.id ORDER BY p.project_name),
         m.rate, m.valid_from, m.valid_to, m.status, m.created_at, m.answered_at, m.org_id, m.tail_days, m.ended_at,
         m.renewed_at, m.extension_asked_at
  FROM mandates m JOIN orgs o ON o.id = m.org_id
  WHERE m.firm_org_id = app_current_org() AND app_current_org() IS NOT NULL
    AND m.status IN ('OFFERED', 'LIVE', 'DECLINED', 'ENDED', 'WITHDRAWN')
  ORDER BY (m.status = 'OFFERED') DESC, m.created_at DESC;
$$;
REVOKE ALL ON FUNCTION mandates_for_firm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandates_for_firm() TO salesdesk_app;

-- The buyer is the lead's name, which the firm already works through the
-- mandate; each half carries the invoice last filed against it.
DROP FUNCTION mandate_payouts_for_firm();
CREATE FUNCTION mandate_payouts_for_firm()
RETURNS TABLE (payout_id uuid, developer text, project text, unit text, agreement numeric, rate numeric, booked_on date,
               cancelled boolean, halves jsonb, buyer text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, o.display_name, n.name, p.unit, p.agreement, p.rate, p.booked_on::date, p.cancelled_at IS NOT NULL,
         coalesce((SELECT jsonb_agg(jsonb_build_object('key', ms.key, 'net', ms.net, 'gross', ms.gross, 'stage', ms.stage,
                                                        'paid_on', ms.paid_on,
                                                        'owed', CASE ms.key WHEN 'M1' THEN p.agreement_registered_on IS NOT NULL
                                                                            ELSE p.collected_on IS NOT NULL END,
                                                        'invoice_no', i.invoice_no, 'invoice_date', i.invoice_date,
                                                        'rejected', i.rejected_at IS NOT NULL, 'reject_reason', i.reject_reason)
                                     ORDER BY ms.key)
                   FROM payout_milestones ms
                   LEFT JOIN LATERAL (SELECT pi.invoice_no, pi.invoice_date, pi.rejected_at, pi.reject_reason
                                      FROM partner_invoices pi WHERE pi.milestone_id = ms.id
                                      ORDER BY pi.created_at DESC LIMIT 1) i ON true
                   WHERE ms.payout_id = p.id), '[]'::jsonb),
         l.name
  FROM partner_payouts p
  JOIN mandates m ON m.id = p.mandate_id
  JOIN orgs o ON o.id = p.org_id
  JOIN scope_nodes n ON n.id = p.scope_node_id
  LEFT JOIN leads l ON l.id = p.lead_id AND l.erased_at IS NULL
  WHERE app_current_org() IS NOT NULL AND m.firm_org_id = app_current_org() AND p.kind = 'MANDATE'
  ORDER BY p.booked_on DESC;
$$;
REVOKE ALL ON FUNCTION mandate_payouts_for_firm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandate_payouts_for_firm() TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- 4. Who to tell
-- ---------------------------------------------------------------------------
-- The firm's admins, asked by the developer that offered the mandate.
CREATE FUNCTION mandate_firm_emails(p_mandate uuid)
RETURNS TABLE (email text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT u.email::text, u.name
  FROM mandates m
  JOIN memberships ms ON ms.org_id = m.firm_org_id AND ms.status = 'ACTIVE' AND ms.role = 'ORG_ADMIN'
  JOIN users u ON u.id = ms.user_id AND u.erased_at IS NULL AND u.email IS NOT NULL
  WHERE m.id = p_mandate AND app_current_org() IS NOT NULL AND m.org_id = app_current_org();
$$;
REVOKE ALL ON FUNCTION mandate_firm_emails(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandate_firm_emails(uuid) TO salesdesk_app;

-- The person who offered it, while still a member of the developer, asked by the firm.
CREATE FUNCTION mandate_developer_emails(p_mandate uuid)
RETURNS TABLE (email text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.email::text, u.name
  FROM mandates m
  JOIN users u ON u.id = m.offered_by AND u.erased_at IS NULL AND u.email IS NOT NULL
  WHERE m.id = p_mandate AND app_current_org() IS NOT NULL AND m.firm_org_id = app_current_org()
    AND EXISTS (SELECT 1 FROM memberships ms WHERE ms.org_id = m.org_id AND ms.user_id = u.id AND ms.status = 'ACTIVE');
$$;
REVOKE ALL ON FUNCTION mandate_developer_emails(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandate_developer_emails(uuid) TO salesdesk_app;
