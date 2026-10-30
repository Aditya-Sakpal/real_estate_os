-- ===========================================================================
-- 0108: the loan desk. A loan file the way a Maharashtra developer's loan
-- executive works it (`doc/home-loan-sop.md`).
--
-- On the loan: the stages a desk tracks (an eligibility check and the bank's
-- legal and technical check between the application and the sanction, and
-- disbursing before fully disbursed), who the buyer is for the checklist
-- (salaried, self-employed, NRI), the documents received, the rate, when the
-- sanction lapses, and the flat's agreement value (what the buyer's own share
-- is worked out from).
--
-- `lead_loan_demands` is one row per demand the developer raises on the
-- flat, at a MahaRERA stage of the construction-linked plan: the amount,
-- split into the buyer's share and the bank's (the buyer's own contribution
-- is paid first), when it went to the bank, what the bank paid and when, and
-- when the buyer paid theirs. A paid part is never rewritten.
-- ===========================================================================

-- Every CHECK 0107 put on the table, by whatever name Postgres gave it.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'lead_loans'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE lead_loans DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE lead_loans
  ADD COLUMN applicant        text,
  ADD COLUMN documents        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN rate_bp          integer,
  ADD COLUMN sanction_expires_on date,
  ADD COLUMN agreement_paise  bigint;

ALTER TABLE lead_loans
  ADD CONSTRAINT lead_loans_stage CHECK (stage IN (
    'INTERESTED', 'PRE_CHECK', 'DOCUMENTS', 'APPLIED', 'APPRAISAL', 'SANCTIONED',
    'DISBURSING', 'DISBURSED', 'REJECTED', 'NOT_NEEDED')),
  ADD CONSTRAINT lead_loans_bank_name CHECK (bank_name IS NULL OR length(bank_name) BETWEEN 1 AND 80),
  -- Rs 1 lakh to Rs 10 Cr.
  ADD CONSTRAINT lead_loans_amount CHECK (amount_paise IS NULL OR amount_paise BETWEEN 10000000 AND 10000000000),
  ADD CONSTRAINT lead_loans_agreement CHECK (agreement_paise IS NULL OR agreement_paise BETWEEN 10000000 AND 100000000000),
  ADD CONSTRAINT lead_loans_reason CHECK (reason IS NULL OR reason IN ('INCOME', 'CREDIT', 'PAPERS', 'VALUATION', 'PROJECT', 'AGE', 'OTHER')),
  ADD CONSTRAINT lead_loans_source CHECK (source IN ('CALL', 'LENDER_YES', 'PERSON')),
  ADD CONSTRAINT lead_loans_applicant CHECK (applicant IS NULL OR applicant IN ('SALARIED', 'SELF_EMPLOYED', 'NRI')),
  ADD CONSTRAINT lead_loans_documents CHECK (jsonb_typeof(documents) = 'object'),
  -- 1% to 25% a year.
  ADD CONSTRAINT lead_loans_rate CHECK (rate_bp IS NULL OR rate_bp BETWEEN 100 AND 2500),
  ADD CONSTRAINT lead_loans_one_bank CHECK (lender_id IS NULL OR bank_name IS NULL),
  ADD CONSTRAINT lead_loans_bank_from_application CHECK (
    stage NOT IN ('APPLIED', 'APPRAISAL', 'SANCTIONED', 'DISBURSING', 'DISBURSED', 'REJECTED')
    OR lender_id IS NOT NULL OR bank_name IS NOT NULL),
  ADD CONSTRAINT lead_loans_amount_from_sanction CHECK (
    stage NOT IN ('SANCTIONED', 'DISBURSING', 'DISBURSED') OR amount_paise IS NOT NULL),
  ADD CONSTRAINT lead_loans_reason_on_refusal CHECK ((stage = 'REJECTED') = (reason IS NOT NULL));

GRANT UPDATE (applicant, documents, rate_bp, sanction_expires_on, agreement_paise) ON lead_loans TO salesdesk_app;

CREATE TABLE lead_loan_demands (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  loan_id            uuid NOT NULL REFERENCES lead_loans(id) ON DELETE CASCADE,
  -- The MahaRERA model agreement's stages, clause 1(c).
  milestone          text NOT NULL CHECK (milestone IN
                       ('BOOKING', 'AGREEMENT', 'PLINTH', 'SLAB', 'WALLS', 'SANITARY', 'EXTERNAL', 'LIFTS', 'POSSESSION')),
  slab_no            integer CHECK (slab_no IS NULL OR slab_no BETWEEN 1 AND 200),
  demand_on          date NOT NULL,
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 100000000000),
  buyer_share_paise  bigint NOT NULL CHECK (buyer_share_paise >= 0),
  bank_share_paise   bigint NOT NULL CHECK (bank_share_paise >= 0),
  sent_to_bank_on    date,
  bank_paid_paise    bigint CHECK (bank_paid_paise IS NULL OR bank_paid_paise > 0),
  bank_paid_on       date,
  buyer_paid_on      date,
  cancelled_at       timestamptz,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_share_paise + bank_share_paise = amount_paise),
  CHECK ((milestone = 'SLAB') = (slab_no IS NOT NULL)),
  CHECK ((bank_paid_paise IS NULL) = (bank_paid_on IS NULL)),
  CHECK (bank_paid_paise IS NULL OR bank_paid_paise <= bank_share_paise),
  CHECK (bank_paid_on IS NULL OR bank_share_paise > 0),
  CHECK (buyer_paid_on IS NULL OR buyer_share_paise > 0)
);

CREATE INDEX lead_loan_demands_loan ON lead_loan_demands (loan_id, demand_on);
CREATE INDEX lead_loan_demands_waiting ON lead_loan_demands (org_id, sent_to_bank_on)
  WHERE bank_paid_on IS NULL AND cancelled_at IS NULL AND bank_share_paise > 0;

CREATE FUNCTION lead_loan_demands_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lead_loans WHERE id = NEW.loan_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'A demand belongs to a loan of the same organisation' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.loan_id IS DISTINCT FROM OLD.loan_id OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.milestone IS DISTINCT FROM OLD.milestone OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
       OR NEW.buyer_share_paise IS DISTINCT FROM OLD.buyer_share_paise OR NEW.bank_share_paise IS DISTINCT FROM OLD.bank_share_paise THEN
      RAISE EXCEPTION 'A demand''s amount and split never change: cancel it and raise it again' USING ERRCODE = 'check_violation';
    END IF;
    -- What was paid stays paid.
    IF OLD.bank_paid_on IS NOT NULL AND (NEW.bank_paid_on IS DISTINCT FROM OLD.bank_paid_on OR NEW.bank_paid_paise IS DISTINCT FROM OLD.bank_paid_paise) THEN
      RAISE EXCEPTION 'A bank payment once recorded never changes' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.buyer_paid_on IS NOT NULL AND NEW.buyer_paid_on IS DISTINCT FROM OLD.buyer_paid_on THEN
      RAISE EXCEPTION 'A buyer''s payment once recorded never changes' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.cancelled_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'A cancelled demand never changes' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.cancelled_at IS NOT NULL AND (OLD.bank_paid_on IS NOT NULL OR OLD.buyer_paid_on IS NOT NULL) THEN
      RAISE EXCEPTION 'A demand anything was paid on cannot be cancelled' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lead_loan_demands_check
  BEFORE INSERT OR UPDATE ON lead_loan_demands
  FOR EACH ROW EXECUTE FUNCTION lead_loan_demands_check();

GRANT SELECT, INSERT ON lead_loan_demands TO salesdesk_app;
GRANT UPDATE (sent_to_bank_on, bank_paid_paise, bank_paid_on, buyer_paid_on, cancelled_at, updated_at) ON lead_loan_demands TO salesdesk_app;
ALTER TABLE lead_loan_demands ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_loan_demands_isolation ON lead_loan_demands
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
