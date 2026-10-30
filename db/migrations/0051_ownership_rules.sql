-- ===========================================================================
--  0051_ownership_rules  --  who a captured enquiry belongs to, and why
--
--  Section 02 asks four questions of every enquiry before anybody is called:
--  is it junk (R0), has this buyer already booked here (R1), does a channel
--  partner hold them (R2, 0037), is there an open lead of ours inside the
--  lookback (R3), and otherwise it is new (R4). `ownership-rules.ts` decides;
--  this records which rule fired on the capture event, beside what became
--  of it, so "why was this buyer never called" has an answer.
--
--  The lookback is the organisation's own choice, one row per tenant.
-- ===========================================================================

ALTER TABLE lead_events
  ADD COLUMN rule text CHECK (rule IS NULL OR rule IN ('R0', 'R1', 'R2', 'R3', 'R4'));

GRANT UPDATE (rule) ON lead_events TO salesdesk_app;

CREATE TABLE lead_settings (
  org_id         uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  -- An open lead quiet for longer than this is closed when the buyer
  -- enquires again, and the enquiry becomes a new lead.
  lookback_days  smallint NOT NULL DEFAULT 90 CHECK (lookback_days BETWEEN 7 AND 365),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON lead_settings TO salesdesk_app;

ALTER TABLE lead_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_settings_isolation ON lead_settings
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
