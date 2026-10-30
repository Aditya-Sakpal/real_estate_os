-- ---------------------------------------------------------------------------
-- 0027  The people a qualified buyer is handed to
-- ---------------------------------------------------------------------------
--
-- With one hand-off number, the second buyer handed over while the sales
-- manager is still talking to the first gets a busy line, and the lead is
-- lost at the moment it was worth most. So the organisation keeps a list of
-- the people who take hand-offs, each on or off duty, and every call is
-- given the one who is free and has waited longest (`pickHandoff()`).
--
-- Busy is what Sales Desk can see: a person already assigned to a call the
-- agent is still on, or handed a buyer in the last few minutes. A call on
-- somebody's own phone is invisible, which is why a transfer that fails still
-- falls back to "the sales manager will call you back" and a flag on the lead.

CREATE TABLE sales_team (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The organisation root for now; a project for a team of its own later.
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone          text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  on_duty        boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope_node_id, phone)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_team TO salesdesk_app;

ALTER TABLE sales_team ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_team_isolation ON sales_team
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- Who this call would be handed to. Frozen on the call, so "busy" can be
-- read from the calls themselves and the log can say who took the buyer.
ALTER TABLE calls
  ADD COLUMN handoff_to text CHECK (handoff_to IS NULL OR handoff_to ~ '^\+[1-9][0-9]{7,14}$');
CREATE INDEX calls_handoff ON calls (org_id, handoff_to, placed_at DESC) WHERE handoff_to IS NOT NULL;
