-- ===========================================================================
--  0078_mandate_setup_refunds  --  the client sets up its own recurring
--                                  mandate, and a credit note's money goes back
--
--  MANDATE SET-UP
--
--  Until now a mandate was written by the operator's script alone (0072).
--  The client now authorises one on Settings, Plan and usage, Auto top-up:
--  a Razorpay customer and an order carrying a token request, Checkout, and
--  the token stored sealed in `billing_mandates`, where the operator's
--  script stores one. Each attempt is a `billing_mandate_setups` row, and
--  the app role may add a mandate only against a setup of its own tenant
--  with the same method, maximum and mode, once, and a live one only for an
--  organisation that is LIVE. Everything else about a mandate stays the
--  operator's: the app may only stop using one (ACTIVE to REVOKED).
--
--  REFUNDS
--
--  A credit note on a top-up paid through Razorpay may send its amount back
--  to the card or account that paid. What was asked and what came back is
--  recorded on the credit note itself. Nothing else on an issued document
--  changes, and the refunds against one payment never add up to more than
--  it took. Only the operator writes them; the app role holds no grant.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A mandate set-up: one per attempt, from the order to the saved mandate
-- ---------------------------------------------------------------------------
CREATE TABLE billing_mandate_setups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  order_id          text NOT NULL UNIQUE CHECK (length(order_id) BETWEEN 1 AND 100),
  customer_id       text NOT NULL CHECK (customer_id ~ '^cust_[A-Za-z0-9]{1,40}$'),
  method            text NOT NULL CHECK (method IN ('CARD', 'UPI', 'EMANDATE')),
  -- The most one charge on the mandate may take: the monthly limit when it was asked.
  max_amount_paise  bigint NOT NULL CHECK (max_amount_paise > 0),
  -- What the authorisation itself takes: nothing for an e-mandate, a rupee otherwise.
  auth_paise        bigint NOT NULL CHECK (auth_paise >= 0),
  expire_at         timestamptz NOT NULL,
  test              boolean NOT NULL,
  -- CREATED: the order exists, Checkout not yet completed.
  -- AUTHORISED: paid, waiting for the bank to confirm the mandate.
  -- CONFIRMED: the mandate is saved. FAILED, EXPIRED: it is not.
  status            text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'AUTHORISED', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  -- A code saying why it stopped, never free text.
  note              text CHECK (note IS NULL OR note ~ '^[A-Z_]{2,40}$'),
  payment_ref       text CHECK (payment_ref IS NULL OR length(payment_ref) BETWEEN 1 AND 100),
  mandate_id        uuid,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  CHECK ((status = 'CONFIRMED') = (mandate_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (status <> 'AUTHORISED' OR payment_ref IS NOT NULL)
);
CREATE INDEX billing_mandate_setups_org ON billing_mandate_setups (org_id, created_at DESC);
-- One set-up in progress per organisation.
CREATE UNIQUE INDEX billing_mandate_setups_open ON billing_mandate_setups (org_id) WHERE status IN ('CREATED', 'AUTHORISED');

-- What was asked for does not change, and a set-up moves forward only.
CREATE FUNCTION billing_mandate_setups_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'CREATED' THEN
      RAISE EXCEPTION 'a mandate set-up starts as created' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.order_id, NEW.customer_id, NEW.method, NEW.max_amount_paise, NEW.auth_paise, NEW.expire_at, NEW.test, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.order_id, OLD.customer_id, OLD.method, OLD.max_amount_paise, OLD.auth_paise, OLD.expire_at, OLD.test, OLD.created_at) THEN
    RAISE EXCEPTION 'what a mandate set-up asked for does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'CREATED' AND NEW.status IN ('AUTHORISED', 'CONFIRMED', 'FAILED', 'EXPIRED'))
    OR (OLD.status = 'AUTHORISED' AND NEW.status IN ('CONFIRMED', 'FAILED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'a mandate set-up does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('CONFIRMED', 'FAILED', 'EXPIRED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'a finished mandate set-up does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_mandate_setups_check BEFORE INSERT OR UPDATE ON billing_mandate_setups
  FOR EACH ROW EXECUTE FUNCTION billing_mandate_setups_check();

GRANT SELECT, INSERT ON billing_mandate_setups TO salesdesk_app;
GRANT UPDATE (status, note, payment_ref, mandate_id, updated_at, confirmed_at) ON billing_mandate_setups TO salesdesk_app;
ALTER TABLE billing_mandate_setups ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_mandate_setups_isolation ON billing_mandate_setups
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A Razorpay callback names an order, not a tenant. This answers which
-- tenant started the set-up and nothing else, the pattern payment_org() set.
CREATE FUNCTION mandate_setup_org(p_order_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM billing_mandate_setups WHERE order_id = p_order_id AND length(p_order_id) BETWEEN 1 AND 100;
$$;
REVOKE ALL ON FUNCTION mandate_setup_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mandate_setup_org(text) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The saved mandate: written by the app only from a completed set-up
-- ---------------------------------------------------------------------------
ALTER TABLE billing_mandates ADD COLUMN setup_id uuid REFERENCES billing_mandate_setups(id);
CREATE UNIQUE INDEX billing_mandates_setup_once ON billing_mandates (setup_id) WHERE setup_id IS NOT NULL;
ALTER TABLE billing_mandate_setups ADD CONSTRAINT billing_mandate_setups_mandate
  FOREIGN KEY (mandate_id) REFERENCES billing_mandates(id);

CREATE FUNCTION billing_mandates_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner name := (SELECT tableowner FROM pg_tables WHERE tablename = 'billing_mandates' AND schemaname = 'public');
  s billing_mandate_setups%ROWTYPE;
BEGIN
  IF session_user = v_owner THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO s FROM billing_mandate_setups WHERE id = NEW.setup_id;
    IF NEW.setup_id IS NULL OR NOT FOUND OR s.org_id <> NEW.org_id OR s.status NOT IN ('CREATED', 'AUTHORISED')
       OR s.mandate_id IS NOT NULL OR s.method <> NEW.method OR s.max_amount_paise <> NEW.max_amount_paise
       OR s.test <> NEW.test OR NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'a mandate is saved only from a set-up the client completed' USING ERRCODE = '42501';
    END IF;
    IF NOT NEW.test AND NOT EXISTS (SELECT 1 FROM billing_accounts WHERE org_id = NEW.org_id AND mode = 'LIVE') THEN
      RAISE EXCEPTION 'a live mandate is only for a LIVE organisation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- The app may stop using a mandate, and nothing more.
  IF NOT (OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED')
     OR (to_jsonb(NEW) - 'status' - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'revoked_at') THEN
    RAISE EXCEPTION 'a mandate is only ever stopped' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_mandates_check BEFORE INSERT OR UPDATE ON billing_mandates
  FOR EACH ROW EXECUTE FUNCTION billing_mandates_check();

GRANT INSERT ON billing_mandates TO salesdesk_app;
GRANT UPDATE (status, revoked_at) ON billing_mandates TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- A credit note's refund, recorded on the credit note
-- ---------------------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN refund_status text CHECK (refund_status IS NULL OR refund_status IN ('REQUESTED', 'PENDING', 'PROCESSED', 'FAILED'));
ALTER TABLE invoices ADD COLUMN refund_paise bigint CHECK (refund_paise IS NULL OR refund_paise > 0);
ALTER TABLE invoices ADD COLUMN refund_ref text CHECK (refund_ref IS NULL OR refund_ref ~ '^rfnd_[A-Za-z0-9]{1,40}$');
ALTER TABLE invoices ADD COLUMN refund_attempts smallint NOT NULL DEFAULT 0 CHECK (refund_attempts BETWEEN 0 AND 5);
ALTER TABLE invoices ADD COLUMN refund_requested_at timestamptz;
ALTER TABLE invoices ADD COLUMN refund_settled_at timestamptz;
ALTER TABLE invoices ADD CONSTRAINT invoices_refund_on_credit_note
  CHECK (refund_status IS NULL OR (kind = 'CREDIT_NOTE' AND refund_paise IS NOT NULL AND refund_paise <= total_paise AND refund_requested_at IS NOT NULL));
ALTER TABLE invoices ADD CONSTRAINT invoices_refund_processed
  CHECK (refund_status IS DISTINCT FROM 'PROCESSED' OR (refund_ref IS NOT NULL AND refund_settled_at IS NOT NULL));
CREATE UNIQUE INDEX invoices_refund_ref ON invoices (refund_ref) WHERE refund_ref IS NOT NULL;

-- An issued document changes only in its refund, forward, and never past
-- what the payment behind it took.
CREATE FUNCTION invoices_refund_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  refund_cols text[] := ARRAY['refund_status', 'refund_paise', 'refund_ref', 'refund_attempts', 'refund_requested_at', 'refund_settled_at'];
  paid bigint;
  pay uuid;
  others bigint;
BEGIN
  IF (to_jsonb(NEW) - refund_cols) IS DISTINCT FROM (to_jsonb(OLD) - refund_cols) THEN
    RAISE EXCEPTION 'an issued invoice or credit note is never edited' USING ERRCODE = '42501';
  END IF;
  IF OLD.refund_paise IS NOT NULL AND NEW.refund_paise IS DISTINCT FROM OLD.refund_paise THEN
    RAISE EXCEPTION 'what a refund asked for does not change' USING ERRCODE = '23514';
  END IF;
  -- A refund keeps its reference, except a failed one asked again, which
  -- lets the failed reference go.
  IF OLD.refund_ref IS NOT NULL AND NEW.refund_ref IS DISTINCT FROM OLD.refund_ref
     AND NOT (OLD.refund_status = 'FAILED' AND NEW.refund_status = 'REQUESTED' AND NEW.refund_ref IS NULL) THEN
    RAISE EXCEPTION 'a refund keeps its reference' USING ERRCODE = '23514';
  END IF;
  IF NEW.refund_status IS DISTINCT FROM OLD.refund_status AND NOT (
       (OLD.refund_status IS NULL AND NEW.refund_status = 'REQUESTED')
    OR (OLD.refund_status = 'REQUESTED' AND NEW.refund_status IN ('PENDING', 'PROCESSED', 'FAILED'))
    OR (OLD.refund_status = 'PENDING' AND NEW.refund_status IN ('PROCESSED', 'FAILED'))
    OR (OLD.refund_status = 'FAILED' AND NEW.refund_status = 'REQUESTED')
  ) THEN
    RAISE EXCEPTION 'a refund does not move from % to %', coalesce(OLD.refund_status, 'none'), NEW.refund_status USING ERRCODE = '23514';
  END IF;
  IF NEW.refund_paise IS NOT NULL AND OLD.refund_paise IS NULL THEN
    SELECT i.payment_id INTO pay FROM invoices i WHERE i.id = NEW.reverses;
    IF pay IS NULL THEN
      RAISE EXCEPTION 'only a top-up paid through the gateway is refunded' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('refund_payment:' || pay::text, 0));
    SELECT total_paise INTO paid FROM payments WHERE id = pay AND status = 'PAID';
    SELECT coalesce(sum(cn.refund_paise), 0) INTO others
    FROM invoices cn JOIN invoices i ON i.id = cn.reverses
    WHERE i.payment_id = pay AND cn.id <> NEW.id AND cn.refund_paise IS NOT NULL AND cn.refund_status IS DISTINCT FROM 'FAILED';
    IF paid IS NULL OR others + NEW.refund_paise > paid THEN
      RAISE EXCEPTION 'more than the payment took' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_refund_only BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_refund_only();
