-- ===========================================================================
--  0076_lead_gaps  --  hosts with their own hours, more than one lender,
--                      a note recorded before the visit, and bidding on
--                      qualified buyers
--
--  HOSTS ARE PEOPLE, WITH HOURS
--
--  `visit_host_hours` is a host's working hours at one project, per weekday:
--  the hours a visit may START in, `start_hour` up to but not including
--  `end_hour`. Once any host at a project has hours, an hour's capacity is
--  the number of hosts on the floor that hour, and a booked visit is given
--  one of them; with none set, the project's own number stands (0052). The
--  ledger (`visit_slots.capacity`) is still what a seat is taken against, in
--  one statement, so the race stays in the database.
--
--  A LENDER ASK MAY NAME SEVERAL LENDERS
--
--  One question to the buyer, one row per lender asked, tied together by
--  `ask_id`. The buyer's Yes answers every row of that ask, and each lender
--  is emailed and audited on its own.
--
--  A NOTE BEFORE THE VISIT
--
--  A host may record a note on a visit scheduled today before the buyer is
--  checked in. It is marked as such, once, and never changed.
--
--  BIDDING ON QUALIFIED BUYERS
--
--  Per Meta ad account, switched on by the budget key once the account has
--  brought enough leads: new ad sets then optimise for the Qualified outcome
--  the attribution sends, through a custom conversion made on the dataset.
-- ===========================================================================

CREATE TABLE visit_host_hours (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 0 is Sunday, the way extract(dow) counts.
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  -- The IST hours a visit may start in: start_hour to end_hour - 1.
  start_hour  smallint NOT NULL CHECK (start_hour BETWEEN 10 AND 18),
  end_hour    smallint NOT NULL CHECK (end_hour BETWEEN 11 AND 19),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, user_id, weekday),
  CHECK (end_hour > start_hour)
);
CREATE INDEX visit_host_hours_day ON visit_host_hours (org_id, project_id, weekday);

-- A host's week is replaced whole, so a day off is a row removed.
GRANT SELECT, INSERT, UPDATE, DELETE ON visit_host_hours TO salesdesk_app;
ALTER TABLE visit_host_hours ENABLE ROW LEVEL SECURITY;
CREATE POLICY visit_host_hours_isolation ON visit_host_hours
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------

ALTER TABLE lender_referrals ADD COLUMN ask_id uuid;
UPDATE lender_referrals SET ask_id = id WHERE ask_id IS NULL;
ALTER TABLE lender_referrals ALTER COLUMN ask_id SET DEFAULT gen_random_uuid();
ALTER TABLE lender_referrals ALTER COLUMN ask_id SET NOT NULL;
CREATE INDEX lender_referrals_ask ON lender_referrals (org_id, ask_id);

-- ---------------------------------------------------------------------------

ALTER TABLE visit_notes ADD COLUMN before_visit boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------

ALTER TABLE connection_accounts
  ADD COLUMN qualified_bidding     boolean NOT NULL DEFAULT false,
  ADD COLUMN qualified_bidding_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN qualified_bidding_at  timestamptz,
  -- The dataset the Qualified outcome is sent to, and the custom conversion
  -- on it that ad sets optimise for. Ids at Meta, never a token.
  ADD COLUMN qualified_dataset     text CHECK (qualified_dataset IS NULL OR qualified_dataset ~ '^[0-9]{1,30}$'),
  ADD COLUMN qualified_conversion  text CHECK (qualified_conversion IS NULL OR qualified_conversion ~ '^[0-9]{1,30}$');
ALTER TABLE connection_accounts ADD CONSTRAINT connection_accounts_qualified_bidding CHECK (
  NOT qualified_bidding
  OR (kind = 'META_AD_ACCOUNT' AND qualified_dataset IS NOT NULL AND qualified_conversion IS NOT NULL AND qualified_bidding_at IS NOT NULL));
