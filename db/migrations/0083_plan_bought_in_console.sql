-- 0083: A plan bought in the console, and a channel partner's plan for the
-- whole firm.
--
-- Until now only the operator sold a plan (`npm run billing -- plan`, on the
-- owner's connection) and the app role could not write `subscriptions` at
-- all. Decided with the client on 4 October 2026:
--
--   * In production a developer or a mandate firm buys a plan for a project
--     before the project exists: they pay the first month in Checkout, and
--     the project and its plan are written when the payment settles.
--   * A channel partner buys ONE plan for the whole firm, the same three
--     plans at the same prices, and its allowance is used across all its
--     projects up to the plan's project cap.
--   * Nothing is shared between companies: each pays for its own.
--
-- So the app may now INSERT a subscription, and only from a PAID plan
-- payment of the same tenant for exactly that plan. The operator's
-- connection is unchanged and may still write anything.

-- ---------------------------------------------------------------------------
-- What a payment bought
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN purpose     text NOT NULL DEFAULT 'TOPUP' CHECK (purpose IN ('TOPUP', 'PLAN')),
  ADD COLUMN plan        text CHECK (plan IS NULL OR plan IN ('LAUNCH', 'GROWTH', 'SCALE')),
  ADD COLUMN plan_scope  text CHECK (plan_scope IS NULL OR plan_scope IN ('PROJECT', 'ORG')),
  -- A plan for a project that already exists (one created before plans
  -- were required, or one whose plan ended).
  ADD COLUMN project_id  uuid REFERENCES scope_nodes(id) ON DELETE SET NULL,
  -- A plan for a project that does not exist yet: the entity, city and name
  -- the person typed, written as a project when the payment settles.
  ADD COLUMN new_project jsonb;

ALTER TABLE payments ADD CONSTRAINT payments_plan_shape CHECK (
  (purpose = 'TOPUP' AND plan IS NULL AND plan_scope IS NULL AND project_id IS NULL AND new_project IS NULL)
  OR (purpose = 'PLAN' AND plan IS NOT NULL AND (
       (plan_scope = 'ORG' AND project_id IS NULL AND new_project IS NULL)
    -- One or the other when written; a project removed later leaves neither.
    OR (plan_scope = 'PROJECT' AND (project_id IS NULL OR new_project IS NULL))
  ))
);

-- What was bought never changes once it is a row (the app role holds no
-- UPDATE on these columns either; the trigger says so for the owner too).
CREATE OR REPLACE FUNCTION payments_one_way() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'CREATED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a settled payment does not change state' USING ERRCODE = '23514';
  END IF;
  IF (NEW.org_id, NEW.order_id, NEW.items, NEW.taxable_paise, NEW.tax_paise, NEW.total_paise, NEW.test,
      NEW.purpose, NEW.plan, NEW.plan_scope, NEW.new_project)
     IS DISTINCT FROM (OLD.org_id, OLD.order_id, OLD.items, OLD.taxable_paise, OLD.tax_paise, OLD.total_paise, OLD.test,
      OLD.purpose, OLD.plan, OLD.plan_scope, OLD.new_project) THEN
    RAISE EXCEPTION 'what was bought does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- A plan for one project, or for a channel partner's whole firm
-- ---------------------------------------------------------------------------
ALTER TABLE subscriptions ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE subscriptions
  ADD COLUMN scope      text NOT NULL DEFAULT 'PROJECT' CHECK (scope IN ('PROJECT', 'ORG')),
  -- The payment that bought it, when the client bought it in the console.
  ADD COLUMN payment_id uuid UNIQUE REFERENCES payments(id);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_scope_shape
  CHECK ((scope = 'PROJECT') = (project_id IS NOT NULL));

-- One plan a project on any day, one firm-wide plan a firm on any day, a
-- firm-wide plan only for a channel partner and never a project plan for
-- one. Serialised per tenant, so two plans written at once cannot both pass.
-- The application writes a plan only from a paid payment for exactly it.
CREATE OR REPLACE FUNCTION subscriptions_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner name := (SELECT tableowner FROM pg_tables WHERE tablename = 'subscriptions' AND schemaname = 'public');
  v_type  text;
  pay     payments%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('subscriptions:' || NEW.org_id::text, 0));
  SELECT type INTO v_type FROM orgs WHERE id = NEW.org_id;

  IF NEW.scope = 'PROJECT' THEN
    IF NOT EXISTS (SELECT 1 FROM scope_nodes WHERE id = NEW.project_id AND org_id = NEW.org_id AND kind = 'PROJECT') THEN
      RAISE EXCEPTION 'a plan belongs to a project of the same organisation' USING ERRCODE = '23514';
    END IF;
    IF v_type = 'CHANNEL_PARTNER' THEN
      RAISE EXCEPTION 'a channel partner''s plan covers the whole firm' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.project_id = NEW.project_id AND s.id <> NEW.id
        AND daterange(s.starts_on, s.ends_on) && daterange(NEW.starts_on, NEW.ends_on)
    ) THEN
      RAISE EXCEPTION 'this project already has a plan for some of those days' USING ERRCODE = '23P01';
    END IF;
  ELSE
    IF v_type IS DISTINCT FROM 'CHANNEL_PARTNER' THEN
      RAISE EXCEPTION 'only a channel partner holds a plan for the whole firm' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.org_id = NEW.org_id AND s.scope = 'ORG' AND s.id <> NEW.id
        AND daterange(s.starts_on, s.ends_on) && daterange(NEW.starts_on, NEW.ends_on)
    ) THEN
      RAISE EXCEPTION 'this firm already has a plan for some of those days' USING ERRCODE = '23P01';
    END IF;
  END IF;

  IF session_user <> v_owner THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'a plan sold is changed by the operator' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO pay FROM payments WHERE id = NEW.payment_id;
    IF NOT FOUND OR pay.org_id <> NEW.org_id OR pay.purpose <> 'PLAN' OR pay.status <> 'PAID'
       OR pay.plan IS DISTINCT FROM NEW.plan OR pay.plan_scope IS DISTINCT FROM NEW.scope
       OR (pay.project_id IS NOT NULL AND pay.project_id IS DISTINCT FROM NEW.project_id)
       OR NEW.status <> 'ACTIVE' OR NEW.cycle <> 'MONTHLY' OR NEW.ends_on IS NOT NULL
       OR NEW.terms->>'plan' IS DISTINCT FROM NEW.plan
       OR NEW.extra_channels <> 0 OR NEW.extra_numbers <> 0 OR cardinality(NEW.extra_agents) <> 0
       OR NEW.starts_on <> (pay.paid_at AT TIME ZONE 'Asia/Kolkata')::date
    THEN
      RAISE EXCEPTION 'the application writes a plan only from a paid payment for exactly that plan' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

GRANT INSERT ON subscriptions TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- The billing account, opened by the application for its own tenant
-- ---------------------------------------------------------------------------
-- A client buying its first plan needs an account to hang billing details
-- on. It opens in SHADOW, as the operator's script opens one.
CREATE FUNCTION billing_open_account() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_current_org() IS NULL THEN
    RAISE EXCEPTION 'no tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO billing_accounts (org_id) VALUES (app_current_org()) ON CONFLICT (org_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION billing_open_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_open_account() TO salesdesk_app;

-- A real payment for a plan makes the tenant LIVE: money moved, so nothing
-- about it is a shadow any more. A test payment never does.
CREATE FUNCTION billing_go_live(p_payment uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_current_org() IS NULL THEN
    RAISE EXCEPTION 'no tenant' USING ERRCODE = '42501';
  END IF;
  UPDATE billing_accounts SET mode = 'LIVE', updated_at = now()
  WHERE org_id = app_current_org() AND mode = 'SHADOW'
    AND EXISTS (
      SELECT 1 FROM payments p
      WHERE p.id = p_payment AND p.org_id = app_current_org()
        AND p.purpose = 'PLAN' AND p.status = 'PAID' AND NOT p.test
    );
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION billing_go_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_go_live(uuid) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- A first month's invoice is a plan invoice with no month of its own
-- ---------------------------------------------------------------------------
-- `invoices_plan_month` keeps one monthly plan invoice per tenant per month.
-- An invoice for a plan bought in the console is tied to its payment
-- instead, so two projects bought in one month are two invoices.
-- 0042 left that CHECK unnamed, so it is found by what it says.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'invoices'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%purpose <> ''PLAN''%period IS NOT NULL%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%payment_id%'
  LOOP
    EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE invoices ADD CONSTRAINT invoices_plan_period
  CHECK (purpose <> 'PLAN' OR period IS NOT NULL OR payment_id IS NOT NULL);
