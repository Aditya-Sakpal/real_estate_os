-- ===========================================================================
--  0071_quote_extras_offline_refunds  --  floor rise, PLC and a woman buyer's
--                                         concession on a quote; a token paid
--                                         by cheque or transfer; cancelling a
--                                         paid token and its refund
--
--  WHAT A QUOTE SAYS IS STILL WRITTEN ONCE
--
--  Floor rise and PLC are lines a person types on the draft. They join the
--  agreement value (taxes are worked out on it) and the quote's hash, so an
--  approval pins them. They are inserted with the quote and the app role
--  holds no UPDATE on them, like every other number here. So are the
--  registration number and the names the PDF prints: a quote PDF is drawn
--  from its own row, never from today's names.
--
--  A PAID TOKEN IS GIVEN BACK, NEVER ERASED
--
--  Cancelling moves a SENT quote to CANCELLED (forward only, by trigger) and
--  writes one refund row, which can never ask for more than was paid (a
--  CHECK) and whose amount the app cannot change. A token paid by cheque or
--  transfer is its own append-only row.
-- ===========================================================================

ALTER TABLE quotes
  ADD COLUMN extras        bigint NOT NULL DEFAULT 0 CHECK (extras >= 0),
  ADD COLUMN extra_lines   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(extra_lines) = 'array' AND jsonb_array_length(extra_lines) <= 2),
  ADD COLUMN woman_buyer   boolean NOT NULL DEFAULT false,
  -- The number the gate said yes about when the quote was drafted.
  ADD COLUMN registration_no text CHECK (registration_no IS NULL OR length(registration_no) <= 60),
  -- The developer, promoter, project, tower and configuration as named at drafting.
  ADD COLUMN parties       jsonb,
  ADD COLUMN cancelled_at  timestamptz,
  ADD COLUMN cancelled_by  uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE quotes DROP CONSTRAINT quotes_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_all_in CHECK (all_in = price + extras + gst + stamp_duty + registration);
ALTER TABLE quotes DROP CONSTRAINT quotes_state_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_state_check
  CHECK (state IN ('DRAFT', 'APPROVED', 'SENT', 'SUPERSEDED', 'EXPIRED', 'CANCELLED'));
ALTER TABLE quotes ADD CONSTRAINT quotes_cancelled CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL));

CREATE OR REPLACE FUNCTION quotes_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'DRAFT' AND NEW.state IN ('APPROVED', 'SUPERSEDED', 'EXPIRED'))
    OR (OLD.state = 'APPROVED' AND NEW.state IN ('SENT', 'SUPERSEDED', 'EXPIRED'))
    OR (OLD.state = 'SENT' AND NEW.state IN ('SUPERSEDED', 'EXPIRED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'A quote moves forward only: % to %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'An approval is not rewritten' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
    RAISE EXCEPTION 'A cancellation is not rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

GRANT UPDATE (cancelled_at, cancelled_by) ON quotes TO salesdesk_app;

-- ---------------------------------------------------------------------------
--  A token paid by cheque or bank transfer, recorded by somebody holding
--  quote:approve. One per quote, never changed.

CREATE TABLE token_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  quote_id      uuid NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE RESTRICT,
  block_id      uuid NOT NULL REFERENCES unit_blocks(id) ON DELETE RESTRICT,
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  mode          text NOT NULL CHECK (mode IN ('CHEQUE', 'TRANSFER')),
  reference     text NOT NULL CHECK (
                  (mode = 'CHEQUE' AND reference ~ '^[0-9]{6}$') OR (mode = 'TRANSFER' AND reference ~ '^[A-Z0-9]{12,22}$')),
  amount        bigint NOT NULL CHECK (amount > 0),
  paid_on       date NOT NULL,
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON token_payments TO salesdesk_app;
ALTER TABLE token_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY token_payments_isolation ON token_payments
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
--  A paid token cancelled, and what is given back. One per quote.
--
--    DUE        a cheque or transfer the developer owes; a person records it paid
--    REQUESTED  asked of the developer's Razorpay account; pending there
--    PROCESSED  Razorpay says refunded, or a person recorded the payment
--    FAILED     Razorpay refused it, or it was asked too often; a person decides

CREATE TABLE token_refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  quote_id            uuid NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE RESTRICT,
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  mode                text NOT NULL CHECK (mode IN ('RAZORPAY', 'CHEQUE', 'TRANSFER')),
  paid_amount         bigint NOT NULL CHECK (paid_amount > 0),
  amount              bigint NOT NULL CHECK (amount > 0 AND amount <= paid_amount),
  reason              text NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  -- The gateway's payment it refunds, and the receipt that makes asking twice safe.
  provider_payment_id text CHECK (provider_payment_id IS NULL OR length(provider_payment_id) <= 40),
  receipt             text NOT NULL CHECK (receipt ~ '^r[0-9a-f]{32}$'),
  provider_refund_id  text CHECK (provider_refund_id IS NULL OR provider_refund_id ~ '^rfnd_[A-Za-z0-9]{6,30}$'),
  -- The cheque or UTR a person paid it back with.
  paid_reference      text CHECK (paid_reference IS NULL OR paid_reference ~ '^[A-Z0-9]{6,22}$'),
  state               text NOT NULL CHECK (state IN ('DUE', 'REQUESTED', 'PROCESSED', 'FAILED')),
  attempts            smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  last_error          text CHECK (last_error IS NULL OR length(last_error) <= 300),
  requested_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  CHECK ((mode = 'RAZORPAY') = (provider_payment_id IS NOT NULL)),
  CHECK ((mode = 'RAZORPAY') OR state IN ('DUE', 'PROCESSED')),
  CHECK ((state = 'PROCESSED') = (processed_at IS NOT NULL))
);
CREATE UNIQUE INDEX token_refunds_one_provider ON token_refunds (provider_refund_id) WHERE provider_refund_id IS NOT NULL;

CREATE FUNCTION token_refunds_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('PROCESSED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'A refund paid is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'A refund id is not rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER token_refunds_forward BEFORE UPDATE ON token_refunds FOR EACH ROW EXECUTE FUNCTION token_refunds_forward();

GRANT SELECT, INSERT ON token_refunds TO salesdesk_app;
GRANT UPDATE (provider_refund_id, paid_reference, state, attempts, last_error, updated_at, processed_at) ON token_refunds TO salesdesk_app;
ALTER TABLE token_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY token_refunds_isolation ON token_refunds
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
