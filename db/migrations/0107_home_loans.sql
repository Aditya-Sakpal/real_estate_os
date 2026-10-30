-- ===========================================================================
-- 0107: a buyer's home loan, as the developer's loan executive records it.
--
-- One row per lead: where the loan stands (needs a loan, collecting
-- documents, applied, sanctioned, disbursed, rejected, not taking one), the
-- bank (one of the organisation's lenders, or another bank by name), what
-- the bank sanctioned or paid, and why it said no. The history of each change
-- is a line on the lead's own history (`lead_activity`, NOTE).
--
-- Nothing here talks to a bank and no money passes: any payout is between
-- the developer and the bank (decided 13 October 2026).
--
-- Three rules the database holds:
--   * the lead and the lender are the row's own organisation's;
--   * a disbursed loan never changes;
--   * the app may write the row and never delete it.
-- ===========================================================================

CREATE TABLE lead_loans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  stage         text NOT NULL CHECK (stage IN ('INTERESTED', 'DOCUMENTS', 'APPLIED', 'SANCTIONED', 'DISBURSED', 'REJECTED', 'NOT_NEEDED')),
  lender_id     uuid REFERENCES lenders(id) ON DELETE RESTRICT,
  -- A bank that is not on the organisation's list (the buyer's own bank).
  bank_name     text CHECK (bank_name IS NULL OR length(bank_name) BETWEEN 1 AND 80),
  amount_paise  bigint CHECK (amount_paise IS NULL OR amount_paise BETWEEN 10000000 AND 10000000000),
  reason        text CHECK (reason IS NULL OR reason IN ('INCOME', 'CREDIT', 'PAPERS', 'PROJECT', 'AGE', 'OTHER')),
  --   CALL        the call heard the buyer will take a loan
  --   LENDER_YES  the buyer said yes to a lender calling
  --   PERSON      a person recorded it
  source        text NOT NULL CHECK (source IN ('CALL', 'LENDER_YES', 'PERSON')),
  stage_at      timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lead_id),
  CHECK (lender_id IS NULL OR bank_name IS NULL),
  CHECK (stage NOT IN ('APPLIED', 'SANCTIONED', 'DISBURSED', 'REJECTED') OR lender_id IS NOT NULL OR bank_name IS NOT NULL),
  CHECK (stage NOT IN ('SANCTIONED', 'DISBURSED') OR amount_paise IS NOT NULL),
  CHECK ((stage = 'REJECTED') = (reason IS NOT NULL))
);

CREATE INDEX lead_loans_open ON lead_loans (org_id, stage, stage_at)
  WHERE stage IN ('DOCUMENTS', 'APPLIED', 'REJECTED');

CREATE FUNCTION lead_loans_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leads WHERE id = NEW.lead_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'A loan belongs to a lead of the same organisation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lender_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lenders WHERE id = NEW.lender_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'A loan names one of its own organisation''s lenders' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.stage = 'DISBURSED' THEN
      RAISE EXCEPTION 'A disbursed loan cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lead_id IS DISTINCT FROM OLD.lead_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION 'A loan stays on its lead' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lead_loans_check
  BEFORE INSERT OR UPDATE ON lead_loans
  FOR EACH ROW EXECUTE FUNCTION lead_loans_check();

GRANT SELECT, INSERT ON lead_loans TO salesdesk_app;
GRANT UPDATE (stage, lender_id, bank_name, amount_paise, reason, stage_at, updated_by, updated_at) ON lead_loans TO salesdesk_app;
ALTER TABLE lead_loans ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_loans_isolation ON lead_loans
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
