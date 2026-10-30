-- ===========================================================================
-- 0106: a channel partner moves its firm to a bigger plan from the console.
--
-- A plan payment may name the firm plan it replaces (`upgrade_of`). Once it
-- is PAID, the plan it replaces ends that day (the trigger below allows the
-- application that one change, and nothing else) and the bigger plan starts
-- the same day from the payment, as any plan bought in the console does.
-- The payment charges the bigger plan for the rest of the month, less what
-- the smaller one was already paid for the same days.
-- ===========================================================================

ALTER TABLE payments ADD COLUMN upgrade_of uuid REFERENCES subscriptions(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION subscriptions_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner name := (SELECT tableowner FROM pg_tables WHERE tablename = 'subscriptions' AND schemaname = 'public');
  v_type  text;
  v_next  date := (date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')) + interval '1 month')::date;
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
      -- The column grant keeps every other column as it was.
      IF NEW.scope = 'PROJECT'
         AND NEW.ends_on = v_next
         AND (OLD.ends_on IS NULL OR OLD.ends_on > NEW.ends_on)
         AND EXISTS (SELECT 1 FROM project_states ps
                     WHERE ps.org_id = NEW.org_id AND ps.project_id = NEW.project_id AND ps.status = 'RETIRED')
      THEN
        RETURN NEW;
      END IF;
      -- A channel partner moving to a bigger plan: the plan it leaves ends
      -- the day the bigger one was paid for, and only from a PAID plan
      -- payment of the same firm that names this plan as the one it replaces.
      IF NEW.scope = 'ORG'
         AND OLD.ends_on IS NULL
         AND NEW.ends_on > NEW.starts_on
         AND EXISTS (SELECT 1 FROM payments p
                     WHERE p.org_id = NEW.org_id AND p.upgrade_of = NEW.id AND p.purpose = 'PLAN'
                       AND p.plan_scope = 'ORG' AND p.status = 'PAID'
                       AND (p.paid_at AT TIME ZONE 'Asia/Kolkata')::date = NEW.ends_on)
      THEN
        RETURN NEW;
      END IF;
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
