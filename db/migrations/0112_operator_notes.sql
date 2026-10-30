-- ===========================================================================
-- 0112: the operator console's own notes on a client.
--
-- admin.salesdesk.app is Sales Desk's own staff looking across every
-- client. Two things they need to write down about a company, which belong
-- to us and never to the client:
--
--   is_test   a company made by a check suite or a demo, left out of every
--             total on the console
--   note      a line of free text ("pilot until 30 Nov, call Rahul")
--
-- Only the owner role reads or writes it: RLS is on with no policy and the
-- app role holds no grant, so nothing in the product (and no tenant) can
-- see it.
-- ===========================================================================

CREATE TABLE operator_notes (
  org_id      uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  is_test     boolean NOT NULL DEFAULT false,
  note        text CHECK (note IS NULL OR length(note) <= 2000),
  updated_by  text NOT NULL CHECK (length(updated_by) BETWEEN 3 AND 320),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE operator_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON operator_notes FROM salesdesk_app;
