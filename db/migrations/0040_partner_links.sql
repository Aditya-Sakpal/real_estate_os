-- ===========================================================================
--  0040_partner_links  --  a partner's own link to a tower's enquiry page
--
--  Section 07's co-branded creative carries a link with a ref code. A buyer
--  who taps it lands on our enquiry page for that tower, and the enquiry
--  becomes the lead AND the partner's claim in one transaction, before
--  either firm has spoken to the buyer. So for a link-sourced lead the
--  dispute about who was first does not arise.
--
--  The code names the project, the firm and a number (GT-SHR-4417). It is
--  not a secret: anybody may type it. What it can do is bounded by the
--  verdict it feeds, which still asks for a live grant, the firm's agent
--  registration, the day's allowance and whether somebody got there first.
--
--  The link goes to our enquiry page, not to the developer's WhatsApp
--  number: per-tenant WhatsApp numbers are not built, and a wa.me link to a
--  number we do not run is a lead nobody captures.
-- ===========================================================================

CREATE TABLE partner_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  firm_id        uuid NOT NULL REFERENCES partner_firms(id) ON DELETE CASCADE,
  cp_org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  -- The tower the enquiry page is for.
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  code           text NOT NULL CHECK (code ~ '^[A-Z]{2,3}-[A-Z]{2,3}-[0-9]{4}$'),
  agent_name     text CHECK (agent_name IS NULL OR length(agent_name) BETWEEN 1 AND 120),
  retired_at     timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);
CREATE INDEX partner_links_firm ON partner_links (org_id, firm_id);

GRANT SELECT, INSERT ON partner_links TO salesdesk_app;
GRANT UPDATE (retired_at) ON partner_links TO salesdesk_app;

ALTER TABLE partner_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_links_isolation ON partner_links
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
