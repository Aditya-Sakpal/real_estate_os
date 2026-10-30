-- ===========================================================================
-- 0109: a plan renews by itself each month, and a channel partner may move
-- its firm to a smaller plan from the console.
--
-- plan_renewals: one row per organisation per month. In shadow mode it is
-- recorded as WOULD_CHARGE and nothing else. Once LIVE, the month's plan is
-- taken from the client's automatic payment when it may be (announced a day
-- before), or waits for the client to pay it through Checkout. A renewal is
-- paid by a payment of purpose RENEWAL, whose settlement issues the month's
-- plan invoice.
--
-- plan_changes: a channel partner asks for a smaller plan, from the first
-- of next month. The billing sweep applies it on that day on the owner's
-- connection, which is how a plan sold is changed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A payment for a month's plan
-- ---------------------------------------------------------------------------
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_check;
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'payments'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%purpose%' AND pg_get_constraintdef(oid) ILIKE '%TOPUP%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%plan_scope%'
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('TOPUP', 'PLAN', 'RENEWAL'));

ALTER TABLE payments DROP CONSTRAINT payments_plan_shape;
ALTER TABLE payments ADD CONSTRAINT payments_plan_shape CHECK (
  (purpose IN ('TOPUP', 'RENEWAL') AND plan IS NULL AND plan_scope IS NULL AND project_id IS NULL AND new_project IS NULL)
  OR (purpose = 'PLAN' AND plan IS NOT NULL AND (
       (plan_scope = 'ORG' AND project_id IS NULL AND new_project IS NULL)
    OR (plan_scope = 'PROJECT' AND (project_id IS NULL OR new_project IS NULL))
  ))
);

-- ---------------------------------------------------------------------------
-- A month's renewal
-- ---------------------------------------------------------------------------
CREATE TABLE plan_renewals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The IST month it pays for.
  period         date NOT NULL CHECK (extract(day FROM period) = 1),
  -- The month's plan invoice lines as worked out when it was decided.
  lines          jsonb NOT NULL,
  taxable_paise  bigint NOT NULL CHECK (taxable_paise > 0),
  total_paise    bigint NOT NULL CHECK (total_paise >= taxable_paise),
  -- WOULD_CHARGE: shadow mode, recorded and never charged.
  -- NOTIFIED: the notice is out; taken from the automatic payment from due_at.
  -- AWAITING_APPROVAL: the client pays it through Checkout.
  -- CHARGING: asked of the automatic payment, answer not settled.
  status         text NOT NULL CHECK (status IN ('WOULD_CHARGE', 'NOTIFIED', 'AWAITING_APPROVAL', 'CHARGING', 'PAID', 'CANCELLED')),
  note           text CHECK (note IS NULL OR note ~ '^[A-Z_]{2,40}$'),
  mandate_id     uuid REFERENCES billing_mandates(id),
  notified_at    timestamptz,
  due_at         timestamptz,
  order_id       text CHECK (order_id IS NULL OR length(order_id) BETWEEN 1 AND 100),
  payment_id     uuid REFERENCES payments(id),
  invoice_id     uuid REFERENCES invoices(id),
  attempts       smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  tried_at       timestamptz,
  settled_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period),
  CHECK (status <> 'WOULD_CHARGE' OR (order_id IS NULL AND payment_id IS NULL AND notified_at IS NULL)),
  CHECK (status NOT IN ('NOTIFIED', 'AWAITING_APPROVAL', 'CHARGING', 'PAID') OR notified_at IS NOT NULL),
  CHECK (status <> 'NOTIFIED' OR due_at IS NOT NULL),
  CHECK (status <> 'PAID' OR (payment_id IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX plan_renewals_open ON plan_renewals (org_id) WHERE status IN ('NOTIFIED', 'AWAITING_APPROVAL', 'CHARGING');

-- Nothing is charged for an organisation that is not LIVE, what a renewal
-- is for never changes, and it moves forward only.
CREATE FUNCTION plan_renewals_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  live boolean := EXISTS (SELECT 1 FROM billing_accounts WHERE org_id = NEW.org_id AND mode = 'LIVE');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('WOULD_CHARGE', 'NOTIFIED', 'AWAITING_APPROVAL') THEN
      RAISE EXCEPTION 'a renewal starts as a decision' USING ERRCODE = '23514';
    END IF;
    IF (NEW.status = 'WOULD_CHARGE') = live THEN
      RAISE EXCEPTION 'only a LIVE organisation is charged, and a LIVE one is never only recorded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.period, NEW.lines, NEW.taxable_paise, NEW.total_paise, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.period, OLD.lines, OLD.taxable_paise, OLD.total_paise, OLD.created_at) THEN
    RAISE EXCEPTION 'what a renewal is for does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'NOTIFIED' AND NEW.status IN ('CHARGING', 'AWAITING_APPROVAL', 'CANCELLED'))
    OR (OLD.status = 'AWAITING_APPROVAL' AND NEW.status IN ('PAID', 'CANCELLED'))
    OR (OLD.status = 'CHARGING' AND NEW.status IN ('PAID', 'AWAITING_APPROVAL'))
  ) THEN
    RAISE EXCEPTION 'a renewal does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'CHARGING' AND OLD.status <> 'CHARGING' AND NOT live THEN
    RAISE EXCEPTION 'only a LIVE organisation is charged' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_renewals_check BEFORE INSERT OR UPDATE ON plan_renewals
  FOR EACH ROW EXECUTE FUNCTION plan_renewals_check();

GRANT SELECT, INSERT ON plan_renewals TO salesdesk_app;
GRANT UPDATE (status, note, order_id, payment_id, invoice_id, attempts, tried_at, settled_at, updated_at) ON plan_renewals TO salesdesk_app;
ALTER TABLE plan_renewals ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_renewals_isolation ON plan_renewals
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- A channel partner moving its firm to a smaller plan
-- ---------------------------------------------------------------------------
CREATE TABLE plan_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  from_plan        text NOT NULL CHECK (from_plan IN ('LAUNCH', 'GROWTH', 'SCALE')),
  to_plan          text NOT NULL CHECK (to_plan IN ('LAUNCH', 'GROWTH', 'SCALE')),
  -- Always the first of a month.
  effective_on     date NOT NULL CHECK (extract(day FROM effective_on) = 1),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPLIED', 'CANCELLED')),
  note             text CHECK (note IS NULL OR note ~ '^[A-Z_]{2,40}$'),
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  CHECK (from_plan <> to_plan),
  CHECK ((status = 'PENDING') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX plan_changes_one_pending ON plan_changes (org_id) WHERE status = 'PENDING';

-- The app asks and withdraws; applying it is the operator's sweep.
CREATE FUNCTION plan_changes_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner name := (SELECT tableowner FROM pg_tables WHERE tablename = 'plan_changes' AND schemaname = 'public');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'a plan change starts as asked' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM subscriptions s JOIN orgs o ON o.id = s.org_id
                   WHERE s.id = NEW.subscription_id AND s.org_id = NEW.org_id AND s.scope = 'ORG'
                     AND s.plan = NEW.from_plan AND o.type = 'CHANNEL_PARTNER') THEN
      RAISE EXCEPTION 'a plan change names the firm''s own plan' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.subscription_id, NEW.from_plan, NEW.to_plan, NEW.effective_on, NEW.created_at, NEW.requested_by)
     IS DISTINCT FROM (OLD.org_id, OLD.subscription_id, OLD.from_plan, OLD.to_plan, OLD.effective_on, OLD.created_at, OLD.requested_by) THEN
    RAISE EXCEPTION 'what was asked does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a decided plan change stays decided' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'APPLIED' AND session_user <> v_owner THEN
    RAISE EXCEPTION 'a plan change is applied by the operator' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_changes_check BEFORE INSERT OR UPDATE ON plan_changes
  FOR EACH ROW EXECUTE FUNCTION plan_changes_check();

GRANT SELECT, INSERT ON plan_changes TO salesdesk_app;
GRANT UPDATE (status, note, decided_at) ON plan_changes TO salesdesk_app;
ALTER TABLE plan_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_changes_isolation ON plan_changes
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
