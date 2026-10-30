-- ===========================================================================
--  0042_billing  --  plans sold per project, what was used, the prepaid
--                    wallet, payments and GST invoices
--
--  The plans themselves are code (`src/lib/billing-rules.ts`), the way the
--  permission catalog is: a plan only means something where a check reads
--  it. What is stored is what one tenant was SOLD, frozen the day it was
--  signed, and what it USED, one row per billable outcome.
--
--  WHO MAY WRITE WHAT
--
--  A plan is a contract, so the app role cannot write one. `billing_accounts`
--  and `subscriptions` are written by the operator's script on the owner
--  connection; the app role reads them and may edit only the bill-to
--  details. A tenant that could give itself Scale would not need a bug to
--  do it.
--
--  APPEND ONLY, AND THE DATABASE SAYS SO
--
--  `usage_events`, `wallet_entries` and `invoices` take SELECT and INSERT
--  and nothing else. A balance is never an updated number: it is credits
--  less draws less expiries, all rows. An invoice is never edited: it is
--  corrected by a credit note.
--
--  THE TWO RULES A LATER FEATURE WOULD QUIETLY BREAK
--
--  An expired top-up is never spent, and free credit is never self-granted.
--  Both are enforced by the trigger on `wallet_entries`, not by convention:
--  a draw on a lot past its expiry, or larger than what the lot has left,
--  is refused; a GRANT row can only be written by the owner; a PURCHASE
--  credit needs a payment that is PAID, in the same tenant.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The organisation's billing account. No row means no plan has been sold:
-- work is metered and nothing is refused on account of billing.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_accounts (
  org_id        uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  -- SHADOW meters and enforces the plan and charges nothing. LIVE charges.
  mode          text NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW', 'LIVE')),
  -- Who the invoice is made out to. Defaults to the organisation's own
  -- legal name and GSTIN when these are empty.
  bill_name     text CHECK (bill_name IS NULL OR length(bill_name) BETWEEN 1 AND 200),
  bill_gstin    text CHECK (bill_gstin IS NULL OR bill_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  bill_address  text CHECK (bill_address IS NULL OR length(bill_address) BETWEEN 1 AND 500),
  -- GST state code, the place of supply for a buyer with no GSTIN.
  bill_state    text CHECK (bill_state IS NULL OR bill_state ~ '^[0-9]{2}$'),
  bill_email    citext CHECK (bill_email IS NULL OR length(bill_email) <= 254),
  -- Buys a top-up by itself, never past the monthly ceiling. Stored and
  -- ruled on; nothing charges a saved card until recurring payments exist.
  auto_topup_on            boolean NOT NULL DEFAULT false,
  auto_topup_sku           text,
  auto_topup_ceiling_paise bigint CHECK (auto_topup_ceiling_paise IS NULL OR auto_topup_ceiling_paise >= 0),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- A plan sold to one project. A change is a new row and an end date on the
-- old one, so what a month was billed against is always answerable.
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES scope_nodes(id),
  plan            text NOT NULL CHECK (plan IN ('LAUNCH', 'GROWTH', 'SCALE')),
  status          text NOT NULL CHECK (status IN ('PILOT', 'ACTIVE')),
  cycle           text NOT NULL DEFAULT 'MONTHLY' CHECK (cycle IN ('MONTHLY', 'ANNUAL')),
  starts_on       date NOT NULL,
  -- Exclusive. NULL runs until somebody ends it.
  ends_on         date,
  -- The plan as sold: price, allowances, channels, agents. A later price
  -- list does not change a signed contract.
  terms           jsonb NOT NULL,
  extra_channels  smallint NOT NULL DEFAULT 0 CHECK (extra_channels BETWEEN 0 AND 40),
  extra_agents    text[] NOT NULL DEFAULT '{}',
  extra_numbers   smallint NOT NULL DEFAULT 0 CHECK (extra_numbers BETWEEN 0 AND 10),
  -- Setup billed with the first month of this plan, pilot already adjusted.
  setup_paise     bigint NOT NULL DEFAULT 0 CHECK (setup_paise >= 0),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on > starts_on),
  CHECK (status <> 'PILOT' OR (plan = 'LAUNCH' AND ends_on IS NOT NULL)),
  CHECK (extra_agents <@ ARRAY['QUALIFIER', 'CONFIRMER', 'REENGAGER', 'POST_VISIT', 'RECEPTIONIST', 'CP_DESK']::text[])
);
CREATE INDEX subscriptions_org ON subscriptions (org_id, starts_on);
CREATE INDEX subscriptions_project ON subscriptions (project_id, starts_on);

-- A plan belongs to a PROJECT of the same tenant, and one project carries at
-- most one plan on any day.
CREATE FUNCTION subscriptions_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scope_nodes WHERE id = NEW.project_id AND org_id = NEW.org_id AND kind = 'PROJECT') THEN
    RAISE EXCEPTION 'a plan belongs to a project of the same organisation' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.project_id = NEW.project_id AND s.id <> NEW.id
      AND daterange(s.starts_on, s.ends_on) && daterange(NEW.starts_on, NEW.ends_on)
  ) THEN
    RAISE EXCEPTION 'this project already has a plan for some of those days' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_check BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_check();

-- ---------------------------------------------------------------------------
-- What was used. One row per billable outcome, idempotent on its source.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The project the unit counts against. NULL for the organisation's pool
  -- (Ask Jimmy) and for a project since removed.
  project_id      uuid REFERENCES scope_nodes(id) ON DELETE SET NULL,
  node_id         uuid REFERENCES scope_nodes(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('CALL_MINUTE', 'HANDOFF_MINUTE', 'IMAGE_POST', 'CAROUSEL', 'EXTRA_SLIDE',
                                                'VIDEO', 'FILM', 'FILM_VERSION', 'STORY_REEL', 'QUESTION', 'WHATSAPP')),
  unit            text NOT NULL CHECK (unit IN ('MINUTE', 'IMAGE', 'CAROUSEL', 'SLIDE', 'VIDEO', 'QUESTION', 'WHATSAPP')),
  -- In the unit: minutes (a hand-off minute already weighted), posts,
  -- videos, questions, or paise of WhatsApp credit.
  qty             numeric(14, 2) NOT NULL CHECK (qty >= 0),
  from_allowance  numeric(14, 2) NOT NULL DEFAULT 0 CHECK (from_allowance >= 0),
  from_wallet     numeric(14, 2) NOT NULL DEFAULT 0 CHECK (from_wallet >= 0),
  -- Neither covered it: a run that started with room and finished past it.
  over            numeric(14, 2) NOT NULL DEFAULT 0 CHECK (over >= 0),
  -- False for a cost-only row: a post that did not pass is never charged,
  -- and its cost is still ours to see.
  billable        boolean NOT NULL,
  -- The plan in force, NULL when none was sold.
  plan            text CHECK (plan IS NULL OR plan IN ('LAUNCH', 'GROWTH', 'SCALE')),
  -- Our cost, an estimate from `doc/pricing.md` where the row cannot know it.
  cost_paise      bigint NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  source_kind     text NOT NULL CHECK (source_kind IN ('call', 'post', 'creative', 'ask_message', 'message')),
  source_id       text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 100),
  -- The IST month it counts in, as its first day.
  period          date NOT NULL CHECK (extract(day FROM period) = 1),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (billable OR (qty = 0 AND from_allowance = 0 AND from_wallet = 0 AND over = 0)),
  CHECK (plan IS NULL OR from_allowance + from_wallet + over = qty),
  UNIQUE (org_id, source_kind, source_id, kind)
);
CREATE INDEX usage_events_period ON usage_events (org_id, period, unit);
CREATE INDEX usage_events_project ON usage_events (org_id, project_id, period);

-- ---------------------------------------------------------------------------
-- Payments. Razorpay, top-ups only; a plan is invoiced for bank transfer.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider       text NOT NULL DEFAULT 'RAZORPAY' CHECK (provider IN ('RAZORPAY')),
  order_id       text NOT NULL UNIQUE CHECK (length(order_id) BETWEEN 1 AND 100),
  payment_ref    text UNIQUE CHECK (payment_ref IS NULL OR length(payment_ref) BETWEEN 1 AND 100),
  status         text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'FAILED')),
  -- What was bought, as the person saw it: [{ sku, qty, unit, units, pricePaise }].
  items          jsonb NOT NULL,
  taxable_paise  bigint NOT NULL CHECK (taxable_paise > 0),
  tax_paise      bigint NOT NULL CHECK (tax_paise >= 0),
  total_paise    bigint NOT NULL,
  -- Paid through the gateway's test mode: never money, never a real invoice number.
  test           boolean NOT NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  CHECK (total_paise = taxable_paise + tax_paise),
  CHECK ((status = 'PAID') = (paid_at IS NOT NULL AND payment_ref IS NOT NULL))
);
CREATE INDEX payments_org ON payments (org_id, created_at DESC);

-- PAID and FAILED are final, and a paid amount cannot change.
CREATE FUNCTION payments_one_way() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'CREATED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a settled payment does not change state' USING ERRCODE = '23514';
  END IF;
  IF (NEW.org_id, NEW.order_id, NEW.items, NEW.taxable_paise, NEW.tax_paise, NEW.total_paise, NEW.test)
     IS DISTINCT FROM (OLD.org_id, OLD.order_id, OLD.items, OLD.taxable_paise, OLD.tax_paise, OLD.total_paise, OLD.test) THEN
    RAISE EXCEPTION 'what was bought does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_one_way BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_one_way();

-- ---------------------------------------------------------------------------
-- The wallet: prepaid top-ups as lots, and every change to them a row.
-- ---------------------------------------------------------------------------
CREATE TABLE wallet_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('CREDIT', 'DRAW', 'EXPIRE')),
  unit         text NOT NULL CHECK (unit IN ('MINUTE', 'IMAGE', 'CAROUSEL', 'SLIDE', 'VIDEO', 'WHATSAPP')),
  qty          numeric(14, 2) NOT NULL CHECK (qty > 0),
  -- The CREDIT a DRAW or an EXPIRE comes out of.
  lot_id       uuid REFERENCES wallet_entries(id) ON DELETE CASCADE,
  expires_at   timestamptz,
  source       text NOT NULL CHECK (source IN ('PURCHASE', 'GRANT', 'USAGE', 'EXPIRY')),
  payment_id   uuid REFERENCES payments(id),
  usage_id     uuid REFERENCES usage_events(id),
  -- What the client paid for this lot, before GST. NULL for a grant.
  price_paise  bigint CHECK (price_paise IS NULL OR price_paise >= 0),
  test         boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'CREDIT') = (lot_id IS NULL)),
  CHECK ((kind = 'CREDIT') = (expires_at IS NOT NULL)),
  CHECK (kind <> 'CREDIT' OR source IN ('PURCHASE', 'GRANT')),
  CHECK (kind <> 'DRAW' OR (source = 'USAGE' AND usage_id IS NOT NULL)),
  CHECK (kind <> 'EXPIRE' OR source = 'EXPIRY'),
  CHECK (source <> 'PURCHASE' OR payment_id IS NOT NULL)
);
CREATE INDEX wallet_entries_org ON wallet_entries (org_id, unit, kind);
CREATE INDEX wallet_entries_lot ON wallet_entries (lot_id);
CREATE UNIQUE INDEX wallet_entries_draw_once ON wallet_entries (usage_id, lot_id) WHERE kind = 'DRAW';
CREATE UNIQUE INDEX wallet_entries_expire_once ON wallet_entries (lot_id) WHERE kind = 'EXPIRE';
CREATE UNIQUE INDEX wallet_entries_purchase_once ON wallet_entries (payment_id, unit) WHERE kind = 'CREDIT' AND source = 'PURCHASE';

-- Runs as the owner so it can see every entry of the lot it guards,
-- whichever role wrote them, and serialise on the lot.
CREATE FUNCTION wallet_entries_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lot     wallet_entries%ROWTYPE;
  used    numeric;
  pay     payments%ROWTYPE;
BEGIN
  IF NEW.kind = 'CREDIT' THEN
    -- Free credit is the operator's to give, never the application's.
    IF NEW.source = 'GRANT' AND session_user <> (SELECT tableowner FROM pg_tables WHERE tablename = 'wallet_entries' AND schemaname = 'public') THEN
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
  SELECT coalesce(sum(qty), 0) INTO used FROM wallet_entries WHERE lot_id = NEW.lot_id;
  IF used + NEW.qty > lot.qty THEN
    RAISE EXCEPTION 'more than the top-up holds' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_entries_check BEFORE INSERT ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_entries_check();

-- ---------------------------------------------------------------------------
-- GST invoices, numbered in one series across every tenant
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  number           text NOT NULL UNIQUE CHECK (length(number) <= 16 AND number ~ '^[A-Z0-9/-]+$'),
  series           text NOT NULL CHECK (series IN ('EST', 'ECN', 'TST')),
  fy               text NOT NULL CHECK (fy ~ '^[0-9]{2}-[0-9]{2}$'),
  seq              integer NOT NULL CHECK (seq > 0),
  kind             text NOT NULL CHECK (kind IN ('INVOICE', 'CREDIT_NOTE')),
  purpose          text NOT NULL CHECK (purpose IN ('TOPUP', 'PLAN')),
  test             boolean NOT NULL,
  issued_on        date NOT NULL,
  -- The month a plan invoice bills.
  period           date,
  seller           jsonb NOT NULL,
  buyer            jsonb NOT NULL,
  place_of_supply  text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  lines            jsonb NOT NULL,
  taxable_paise    bigint NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise       bigint NOT NULL CHECK (cgst_paise >= 0),
  sgst_paise       bigint NOT NULL CHECK (sgst_paise >= 0),
  igst_paise       bigint NOT NULL CHECK (igst_paise >= 0),
  total_paise      bigint NOT NULL,
  payment_id       uuid UNIQUE REFERENCES payments(id),
  reverses         uuid REFERENCES invoices(id),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series, fy, seq),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  CHECK (igst_paise = 0 OR (cgst_paise = 0 AND sgst_paise = 0)),
  CHECK ((series = 'TST') = test),
  CHECK ((kind = 'CREDIT_NOTE') = (reverses IS NOT NULL)),
  CHECK ((kind = 'CREDIT_NOTE') = (series = 'ECN') OR test),
  CHECK (purpose <> 'PLAN' OR period IS NOT NULL)
);
CREATE INDEX invoices_org ON invoices (org_id, issued_on DESC);
CREATE UNIQUE INDEX invoices_plan_month ON invoices (org_id, period) WHERE purpose = 'PLAN' AND kind = 'INVOICE';

-- The counter behind every number. No tenant column and no grant: the app
-- role reaches it only through the function below, inside the same
-- transaction as the invoice it numbers, so a rolled-back invoice rolls its
-- number back too and the series has no gaps.
CREATE TABLE invoice_series (
  series    text NOT NULL,
  fy        text NOT NULL,
  last_seq  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (series, fy)
);

CREATE FUNCTION next_invoice_seq(p_series text, p_fy text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_series NOT IN ('EST', 'ECN', 'TST') OR p_fy !~ '^[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'unknown invoice series' USING ERRCODE = '22023';
  END IF;
  INSERT INTO invoice_series (series, fy, last_seq) VALUES (p_series, p_fy, 1)
  ON CONFLICT (series, fy) DO UPDATE SET last_seq = invoice_series.last_seq + 1
  RETURNING last_seq INTO n;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION next_invoice_seq(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_invoice_seq(text, text) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The gateway's callbacks, stored before they are acted on
-- ---------------------------------------------------------------------------
CREATE TABLE billing_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Razorpay's x-razorpay-event-id: the same event delivered twice is one row.
  event_id      text NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 100),
  type          text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);

-- A payment callback names an order, not a tenant. This answers which
-- tenant created it and nothing else, the pattern 0023 set.
CREATE FUNCTION payment_org(p_order_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM payments WHERE order_id = p_order_id AND length(p_order_id) BETWEEN 1 AND 100;
$$;
REVOKE ALL ON FUNCTION payment_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_org(text) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------
GRANT SELECT ON billing_accounts TO salesdesk_app;
GRANT UPDATE (bill_name, bill_gstin, bill_address, bill_state, bill_email,
              auto_topup_on, auto_topup_sku, auto_topup_ceiling_paise, updated_by, updated_at)
  ON billing_accounts TO salesdesk_app;
GRANT SELECT ON subscriptions TO salesdesk_app;
GRANT SELECT, INSERT ON usage_events TO salesdesk_app;
GRANT SELECT, INSERT ON wallet_entries TO salesdesk_app;
GRANT SELECT, INSERT ON payments TO salesdesk_app;
GRANT UPDATE (status, payment_ref, paid_at) ON payments TO salesdesk_app;
GRANT SELECT, INSERT ON invoices TO salesdesk_app;
GRANT SELECT, INSERT ON billing_events TO salesdesk_app;
GRANT UPDATE (processed_at) ON billing_events TO salesdesk_app;

ALTER TABLE billing_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_accounts_isolation ON billing_accounts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_isolation ON subscriptions
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_events_isolation ON usage_events
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_isolation ON payments
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE wallet_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_entries_isolation ON wallet_entries
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_isolation ON invoices
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_events_isolation ON billing_events
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- The counter is nobody's to read directly.
ALTER TABLE invoice_series ENABLE ROW LEVEL SECURITY;
