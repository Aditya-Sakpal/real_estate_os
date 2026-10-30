-- ===========================================================================
--  0072_credit_notes_auto_topup  --  credit notes under GST, and the
--                                    automatic top-up
--
--  CREDIT NOTES
--
--  An issued invoice is never edited (0042 gave the app role no UPDATE).
--  A correction is a credit note: section 34 of the CGST Act, its contents
--  in Rule 53. It runs its own gapless series per financial year, ECN for
--  real and TCN for test mode, so a test never takes a real number. It
--  names the invoice it corrects, carries that invoice's buyer and place of
--  supply, and the same tax heads. The database refuses a credit note that
--  would credit more than its invoice held, head by head, one issued after
--  section 34's time limit, and one written by anybody but the operator.
--
--  A credit note on a top-up takes back what is still unused of that
--  purchase: a REVERSE row out of the purchase's own lot, guarded by the
--  wallet's trigger like every other draw.
--
--  AUTO TOP-UP
--
--  The rule (`autoTopUpDue()`) and its columns existed in 0042. This adds
--  the threshold and quantity, the saved Razorpay mandate (sealed), and one
--  row per automatic purchase, decided and then charged. The database holds
--  the two things that matter most: nothing is charged for an organisation
--  that is not LIVE (a shadow one records what it would have done), and an
--  organisation has at most one automatic purchase in flight.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Invoices: the test credit note series, and the reason on a credit note
-- ---------------------------------------------------------------------------
ALTER TABLE invoices DROP CONSTRAINT invoices_series_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_series_check CHECK (series IN ('EST', 'ECN', 'TST', 'TCN'));
ALTER TABLE invoices DROP CONSTRAINT invoices_check2;
ALTER TABLE invoices ADD CONSTRAINT invoices_test_series CHECK ((series IN ('TST', 'TCN')) = test);
ALTER TABLE invoices DROP CONSTRAINT invoices_check4;
ALTER TABLE invoices ADD CONSTRAINT invoices_credit_series CHECK ((kind = 'CREDIT_NOTE') = (series IN ('ECN', 'TCN')));

-- Why the value was reduced, as the operator wrote it. Printed on the
-- credit note and never copied into the audit log.
ALTER TABLE invoices ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 300);
ALTER TABLE invoices ADD CONSTRAINT invoices_credit_reason CHECK ((kind = 'CREDIT_NOTE') = (reason IS NOT NULL));
CREATE INDEX invoices_reverses ON invoices (reverses) WHERE reverses IS NOT NULL;

CREATE OR REPLACE FUNCTION next_invoice_seq(p_series text, p_fy text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_series NOT IN ('EST', 'ECN', 'TST', 'TCN') OR p_fy !~ '^[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'unknown invoice series' USING ERRCODE = '22023';
  END IF;
  INSERT INTO invoice_series (series, fy, last_seq) VALUES (p_series, p_fy, 1)
  ON CONFLICT (series, fy) DO UPDATE SET last_seq = invoice_series.last_seq + 1
  RETURNING last_seq INTO n;
  RETURN n;
END $$;

-- What a credit note may be. Runs as the owner so it sees every credit note
-- already written against the invoice, and serialises on that invoice.
CREATE FUNCTION invoices_credit_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  orig    invoices%ROWTYPE;
  done_t  bigint;
  done_c  bigint;
  done_s  bigint;
  done_i  bigint;
  fy_end  integer;
BEGIN
  IF NEW.kind <> 'CREDIT_NOTE' THEN
    RETURN NEW;
  END IF;
  IF session_user <> (SELECT tableowner FROM pg_tables WHERE tablename = 'invoices' AND schemaname = 'public') THEN
    RAISE EXCEPTION 'only the operator issues a credit note' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_credit:' || NEW.reverses::text, 0));
  SELECT * INTO orig FROM invoices WHERE id = NEW.reverses;
  IF NOT FOUND OR orig.kind <> 'INVOICE' OR orig.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'a credit note corrects an invoice of the same organisation' USING ERRCODE = '23514';
  END IF;
  IF orig.test <> NEW.test OR orig.purpose <> NEW.purpose OR orig.place_of_supply <> NEW.place_of_supply
     OR orig.buyer <> NEW.buyer OR orig.period IS DISTINCT FROM NEW.period THEN
    RAISE EXCEPTION 'a credit note carries its invoice''s buyer, place of supply and mode' USING ERRCODE = '23514';
  END IF;
  IF NEW.taxable_paise <= 0 THEN
    RAISE EXCEPTION 'a credit note credits something' USING ERRCODE = '23514';
  END IF;
  IF NEW.issued_on < orig.issued_on THEN
    RAISE EXCEPTION 'a credit note is not dated before its invoice' USING ERRCODE = '23514';
  END IF;
  -- Section 34(2): declared no later than 30 November after the end of the
  -- financial year of the supply.
  fy_end := 2000 + substr(orig.fy, 4, 2)::integer;
  IF NEW.issued_on > make_date(fy_end, 11, 30) THEN
    RAISE EXCEPTION 'past the time limit for a credit note on this invoice' USING ERRCODE = '23514';
  END IF;
  IF (orig.igst_paise > 0 AND (NEW.cgst_paise > 0 OR NEW.sgst_paise > 0))
     OR (orig.igst_paise = 0 AND NEW.igst_paise > 0) THEN
    RAISE EXCEPTION 'a credit note takes back the same tax its invoice charged' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(taxable_paise), 0), coalesce(sum(cgst_paise), 0), coalesce(sum(sgst_paise), 0), coalesce(sum(igst_paise), 0)
    INTO done_t, done_c, done_s, done_i
  FROM invoices WHERE reverses = NEW.reverses;
  IF done_t + NEW.taxable_paise > orig.taxable_paise OR done_c + NEW.cgst_paise > orig.cgst_paise
     OR done_s + NEW.sgst_paise > orig.sgst_paise OR done_i + NEW.igst_paise > orig.igst_paise THEN
    RAISE EXCEPTION 'more than the invoice held' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_credit_check BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_credit_check();

-- ---------------------------------------------------------------------------
-- The wallet: a credit note takes back what is unused of its purchase
-- ---------------------------------------------------------------------------
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN ('CREDIT', 'DRAW', 'EXPIRE', 'REVERSE'));
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_source_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_source_check CHECK (source IN ('PURCHASE', 'GRANT', 'USAGE', 'EXPIRY', 'CREDIT_NOTE'));
ALTER TABLE wallet_entries ADD COLUMN credit_note_id uuid REFERENCES invoices(id);
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_reverse
  CHECK ((kind = 'REVERSE') = (credit_note_id IS NOT NULL) AND (kind <> 'REVERSE' OR source = 'CREDIT_NOTE'));
CREATE UNIQUE INDEX wallet_entries_reverse_once ON wallet_entries (credit_note_id, lot_id) WHERE kind = 'REVERSE';

CREATE OR REPLACE FUNCTION wallet_entries_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lot     wallet_entries%ROWTYPE;
  used    numeric;
  pay     payments%ROWTYPE;
  v_owner name := (SELECT tableowner FROM pg_tables WHERE tablename = 'wallet_entries' AND schemaname = 'public');
BEGIN
  IF NEW.kind = 'CREDIT' THEN
    -- Free credit is the operator's to give, never the application's.
    IF NEW.source = 'GRANT' AND session_user <> v_owner THEN
      RAISE EXCEPTION 'only the operator grants credit' USING ERRCODE = '42501';
    END IF;
    IF NEW.source = 'PURCHASE' THEN
      SELECT * INTO pay FROM payments WHERE id = NEW.payment_id;
      IF NOT FOUND OR pay.org_id <> NEW.org_id OR pay.status <> 'PAID' OR pay.test <> NEW.test THEN
        RAISE EXCEPTION 'a purchased top-up needs a paid payment of the same organisation' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('wallet_lot:' || NEW.lot_id::text, 0));
  SELECT * INTO lot FROM wallet_entries WHERE id = NEW.lot_id;
  IF NOT FOUND OR lot.kind <> 'CREDIT' OR lot.org_id <> NEW.org_id OR lot.unit <> NEW.unit THEN
    RAISE EXCEPTION 'a draw comes out of a top-up of the same organisation and unit' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'DRAW' AND lot.expires_at <= now() THEN
    RAISE EXCEPTION 'an expired top-up is never spent' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'EXPIRE' AND lot.expires_at > now() THEN
    RAISE EXCEPTION 'a top-up expires only after its date' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'REVERSE' THEN
    IF session_user <> v_owner THEN
      RAISE EXCEPTION 'only the operator takes a top-up back' USING ERRCODE = '42501';
    END IF;
    IF lot.source <> 'PURCHASE' OR NOT EXISTS (
      SELECT 1 FROM invoices cn JOIN invoices i ON i.id = cn.reverses
      WHERE cn.id = NEW.credit_note_id AND cn.kind = 'CREDIT_NOTE' AND cn.org_id = NEW.org_id
        AND i.payment_id = lot.payment_id
    ) THEN
      RAISE EXCEPTION 'a top-up is taken back only by a credit note on its own purchase' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT coalesce(sum(qty), 0) INTO used FROM wallet_entries WHERE lot_id = NEW.lot_id;
  IF used + NEW.qty > lot.qty THEN
    RAISE EXCEPTION 'more than the top-up holds' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Auto top-up: the setting
-- ---------------------------------------------------------------------------
-- How many of the pack one automatic purchase buys (only a counted item,
-- a post or a video, takes more than one), and below what it buys: minutes,
-- posts or videos left, or paise of WhatsApp credit.
ALTER TABLE billing_accounts ADD COLUMN auto_topup_qty smallint NOT NULL DEFAULT 1 CHECK (auto_topup_qty BETWEEN 1 AND 10);
ALTER TABLE billing_accounts ADD COLUMN auto_topup_threshold numeric(14, 2) CHECK (auto_topup_threshold IS NULL OR auto_topup_threshold >= 0);
ALTER TABLE billing_accounts ADD CONSTRAINT billing_accounts_auto_complete
  CHECK (NOT auto_topup_on OR (auto_topup_sku IS NOT NULL AND auto_topup_ceiling_paise > 0 AND auto_topup_threshold IS NOT NULL));
GRANT UPDATE (auto_topup_qty, auto_topup_threshold) ON billing_accounts TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The saved way to pay: a Razorpay recurring token the client authorised
-- ---------------------------------------------------------------------------
CREATE TABLE billing_mandates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'RAZORPAY' CHECK (provider IN ('RAZORPAY')),
  method            text NOT NULL CHECK (method IN ('CARD', 'UPI', 'EMANDATE')),
  -- Shown to the client ("HDFC e-mandate"). Never a card number or a UPI id.
  label             text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60),
  -- Razorpay's customer id, the token, and the email and phone a recurring
  -- payment must carry, sealed together under the tenant's key.
  secret            bytea NOT NULL,
  key_version       smallint NOT NULL,
  -- The most the mandate allows in one charge.
  max_amount_paise  bigint NOT NULL CHECK (max_amount_paise > 0),
  test              boolean NOT NULL,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX billing_mandates_one_active ON billing_mandates (org_id) WHERE status = 'ACTIVE';
-- Recorded by the operator's script on the owner connection; the app reads.
GRANT SELECT ON billing_mandates TO salesdesk_app;
ALTER TABLE billing_mandates ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_mandates_isolation ON billing_mandates
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- One row per automatic purchase, from the decision to its settlement
-- ---------------------------------------------------------------------------
CREATE TABLE auto_topup_charges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The IST month it counts against the ceiling in, and its place in it.
  period         date NOT NULL CHECK (extract(day FROM period) = 1),
  seq            smallint NOT NULL CHECK (seq BETWEEN 1 AND 100),
  sku            text NOT NULL CHECK (length(sku) BETWEEN 1 AND 40),
  qty            smallint NOT NULL CHECK (qty BETWEEN 1 AND 10),
  unit           text NOT NULL CHECK (unit IN ('MINUTE', 'IMAGE', 'CAROUSEL', 'SLIDE', 'VIDEO', 'WHATSAPP')),
  units          numeric(14, 2) NOT NULL CHECK (units > 0),
  taxable_paise  bigint NOT NULL CHECK (taxable_paise > 0),
  total_paise    bigint NOT NULL CHECK (total_paise >= taxable_paise),
  -- What was left of the unit when it was decided.
  left_then      numeric(14, 2) NOT NULL,
  -- WOULD_CHARGE: shadow mode, recorded and never charged.
  -- NOTIFIED: the pre-debit notice is out; charged from due_at.
  -- AWAITING_APPROVAL: over what a mandate may take unattended; the client
  --   pays it through Checkout or it expires.
  status         text NOT NULL CHECK (status IN ('WOULD_CHARGE', 'NOTIFIED', 'AWAITING_APPROVAL', 'CHARGING',
                                                 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED')),
  -- A code saying why it stopped, never free text.
  note           text CHECK (note IS NULL OR note ~ '^[A-Z_]{2,40}$'),
  mandate_id     uuid REFERENCES billing_mandates(id),
  notified_at    timestamptz,
  due_at         timestamptz,
  order_id       text CHECK (order_id IS NULL OR length(order_id) BETWEEN 1 AND 100),
  payment_id     uuid REFERENCES payments(id),
  attempts       smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  tried_at       timestamptz,
  settled_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period, seq),
  CHECK (status <> 'WOULD_CHARGE' OR (order_id IS NULL AND payment_id IS NULL AND notified_at IS NULL)),
  CHECK (status NOT IN ('NOTIFIED', 'AWAITING_APPROVAL', 'CHARGING', 'PAID') OR notified_at IS NOT NULL),
  CHECK (status <> 'NOTIFIED' OR due_at IS NOT NULL),
  CHECK (status <> 'PAID' OR (payment_id IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX auto_topup_charges_org ON auto_topup_charges (org_id, created_at DESC);
-- One automatic purchase in flight per organisation.
CREATE UNIQUE INDEX auto_topup_charges_open ON auto_topup_charges (org_id)
  WHERE status IN ('NOTIFIED', 'AWAITING_APPROVAL', 'CHARGING');

-- Nothing is charged for an organisation that is not LIVE, and a charge
-- moves forward only.
CREATE FUNCTION auto_topup_charges_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  live boolean := EXISTS (SELECT 1 FROM billing_accounts WHERE org_id = NEW.org_id AND mode = 'LIVE');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('WOULD_CHARGE', 'NOTIFIED', 'AWAITING_APPROVAL') THEN
      RAISE EXCEPTION 'an automatic top-up starts as a decision' USING ERRCODE = '23514';
    END IF;
    IF (NEW.status = 'WOULD_CHARGE') = live THEN
      RAISE EXCEPTION 'only a LIVE organisation is charged, and a LIVE one is never only recorded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.period, NEW.seq, NEW.sku, NEW.qty, NEW.unit, NEW.units, NEW.taxable_paise, NEW.total_paise, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.period, OLD.seq, OLD.sku, OLD.qty, OLD.unit, OLD.units, OLD.taxable_paise, OLD.total_paise, OLD.created_at) THEN
    RAISE EXCEPTION 'what an automatic top-up buys does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'NOTIFIED' AND NEW.status IN ('CHARGING', 'CANCELLED'))
    OR (OLD.status = 'AWAITING_APPROVAL' AND NEW.status IN ('PAID', 'EXPIRED', 'CANCELLED'))
    OR (OLD.status = 'CHARGING' AND NEW.status IN ('PAID', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'an automatic top-up does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'CHARGING' AND OLD.status <> 'CHARGING' AND NOT live THEN
    RAISE EXCEPTION 'only a LIVE organisation is charged' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auto_topup_charges_check BEFORE INSERT OR UPDATE ON auto_topup_charges
  FOR EACH ROW EXECUTE FUNCTION auto_topup_charges_check();

GRANT SELECT, INSERT ON auto_topup_charges TO salesdesk_app;
GRANT UPDATE (status, note, order_id, payment_id, attempts, tried_at, settled_at, updated_at) ON auto_topup_charges TO salesdesk_app;
ALTER TABLE auto_topup_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY auto_topup_charges_isolation ON auto_topup_charges
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
