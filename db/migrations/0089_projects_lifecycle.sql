-- 0089: a project's life after its launch.
--
-- Three things, decided 4 October 2026.
--
-- 1. ONE PROJECT, TWO COMPANIES. `registration_records` is unique per tenant
--    only, so a mandate firm or a channel partner that added a project to its
--    own console before the developer joined can hold the same registration
--    as the developer. `registration_held_elsewhere()` answers, for the
--    tenant asking and nobody else, which other companies hold the number:
--    their display name and kind, never an id or a row of theirs.
--    `registrations_shared()` answers the same for each of the asking
--    tenant's own registrations, for Today. Both compare on the registration
--    key (`registrationKey()` in rera-rules.ts), mirrored here in SQL.
--
-- 2. A SOLD-OUT PROJECT IS RETIRED. `project_states` holds ACTIVE or RETIRED
--    per project (no row is ACTIVE). Retiring ends the project's plan at the
--    end of the IST month: the app may now set `subscriptions.ends_on`, and
--    only that, only on a RETIRED project of its own, only to the first of
--    next month and only earlier than it was. Price and terms stay the
--    operator's.
--
-- 3. VISIT HOURS AND GALLERIES. A project keeps its own opening hours for
--    weekdays and the weekend (minutes from midnight, half hours, 08:00 to a
--    last start of 20:30), defaulting to 10:00 and 18:30 so nothing changes.
--    A project or tower may have several galleries, each with a label, and a
--    visit may name the one it is at. A host's hours widen to match.
--
-- Additive. The RLS policies on visit_capacity, site_locations and
-- site_visits already cover the new columns.

-- ---------------------------------------------------------------------------
-- 1. The same registration in another company
-- ---------------------------------------------------------------------------

-- The key two spellings of one registration share. Mirrors registrationKey()
-- over normaliseRegistrationNo(): Gujarat compares on the serial, Tamil Nadu
-- drops the padding and one spelling of "Regularisation Layout", Haryana
-- drops the prefix and the date an ad prints, every other state drops spaces.
CREATE FUNCTION rera_registration_key(p_state text, p_no text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  WITH s AS (
    SELECT upper(coalesce(p_state, '')) AS st, upper(btrim(coalesce(p_no, ''))) AS raw
  ), v AS (
    SELECT st,
           CASE
             WHEN st = 'GJ' THEN regexp_replace(regexp_replace(raw, '\s*/\s*', '/', 'g'), '\s+', ' ', 'g')
             WHEN st = 'HR' THEN regexp_replace(
                                   regexp_replace(regexp_replace(raw, '^RC\s*/\s*REP\s*/\s*HARERA\s*/', ''), '\s+DATED\M.*$', ''),
                                   '\s+', '', 'g')
             ELSE regexp_replace(raw, '\s+', '', 'g')
           END AS n
    FROM s
  )
  SELECT CASE
    WHEN st = 'GJ' THEN coalesce(substring('/' || n || '/' FROM '/([A-Z]{1,3}[0-9]{0,4}AA[0-9]{4,})/'), n)
    WHEN st = 'TN' THEN (
      SELECT string_agg(CASE WHEN part ~ '^[0-9]+$' THEN coalesce(nullif(ltrim(part, '0'), ''), '0') ELSE part END, '/' ORDER BY ord)
      FROM unnest(string_to_array(regexp_replace(n, 'REGULARISATION-?LAYOUT', 'REGULARISATION-LAYOUT', 'g'), '/'))
             WITH ORDINALITY AS t(part, ord))
    ELSE n
  END
  FROM v
$$;

-- Which other companies hold this registration: a name and a kind, for the
-- refusal or the note, and nothing else. Answered only for the tenant the
-- connection is pinned to.
CREATE FUNCTION registration_held_elsewhere(p_org uuid, p_state text, p_reg_no text)
RETURNS TABLE (holder_name text, holder_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT o.display_name, o.type
  FROM registration_records r
  JOIN orgs o ON o.id = r.org_id
  WHERE p_org = app_current_org()
    AND r.org_id <> p_org
    AND o.status <> 'SUSPENDED'
    AND r.registration_no IS NOT NULL
    AND upper(r.state_code) = upper(p_state)
    AND length(coalesce(p_reg_no, '')) BETWEEN 6 AND 130
    AND rera_registration_key(r.state_code, r.registration_no) = rera_registration_key(p_state, p_reg_no);
$$;
REVOKE ALL ON FUNCTION registration_held_elsewhere(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registration_held_elsewhere(uuid, text, text) TO salesdesk_app;

-- The asking tenant's own phases whose registration another company also
-- holds, with that company's name and kind. Its own node ids, never theirs.
CREATE FUNCTION registrations_shared(p_org uuid)
RETURNS TABLE (phase_id uuid, holder_name text, holder_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT mine.scope_node_id, o.display_name, o.type
  FROM registration_records mine
  JOIN registration_records other
    ON other.org_id <> mine.org_id
   AND other.registration_no IS NOT NULL
   AND upper(other.state_code) = upper(mine.state_code)
   AND rera_registration_key(other.state_code, other.registration_no) = rera_registration_key(mine.state_code, mine.registration_no)
  JOIN orgs o ON o.id = other.org_id AND o.status <> 'SUSPENDED'
  WHERE p_org = app_current_org()
    AND mine.org_id = p_org
    AND mine.registration_no IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION registrations_shared(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registrations_shared(uuid) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- 2. A retired project
-- ---------------------------------------------------------------------------
CREATE TABLE project_states (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  retired_at  timestamptz,
  retired_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id),
  CONSTRAINT project_states_retired CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);

CREATE FUNCTION project_states_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scope_nodes WHERE id = NEW.project_id AND org_id = NEW.org_id AND kind = 'PROJECT') THEN
    RAISE EXCEPTION 'a state belongs to a project of the same organisation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_states_check BEFORE INSERT OR UPDATE ON project_states
  FOR EACH ROW EXECUTE FUNCTION project_states_check();

GRANT SELECT, INSERT, UPDATE ON project_states TO salesdesk_app;
ALTER TABLE project_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_states_isolation ON project_states
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- The app may end a retired project's plan at the end of this IST month,
-- and change nothing else about it.
GRANT UPDATE (ends_on) ON subscriptions TO salesdesk_app;

-- 0083's check, with the one UPDATE the application may now make.
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

-- ---------------------------------------------------------------------------
-- 3. Visit hours and galleries
-- ---------------------------------------------------------------------------

-- Minutes from midnight, IST. A visit may start at any half hour from the
-- opening to the last start, inside 08:00 and 20:30.
ALTER TABLE visit_capacity
  ADD COLUMN weekday_open smallint NOT NULL DEFAULT 600,
  ADD COLUMN weekday_last smallint NOT NULL DEFAULT 1110,
  ADD COLUMN weekend_open smallint NOT NULL DEFAULT 600,
  ADD COLUMN weekend_last smallint NOT NULL DEFAULT 1110,
  ADD CONSTRAINT visit_capacity_hours CHECK (
    weekday_open BETWEEN 480 AND 1230 AND weekday_last BETWEEN 480 AND 1230
    AND weekend_open BETWEEN 480 AND 1230 AND weekend_last BETWEEN 480 AND 1230
    AND weekday_open % 30 = 0 AND weekday_last % 30 = 0
    AND weekend_open % 30 = 0 AND weekend_last % 30 = 0
    AND weekday_open <= weekday_last AND weekend_open <= weekend_last);

-- A host's hours may now run from 8 am to 9 pm.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'visit_host_hours'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%start_hour >= 10%' OR pg_get_constraintdef(oid) ILIKE '%end_hour >= 11%')
  LOOP
    EXECUTE format('ALTER TABLE visit_host_hours DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE visit_host_hours
  ADD CONSTRAINT visit_host_hours_start CHECK (start_hour BETWEEN 8 AND 20),
  ADD CONSTRAINT visit_host_hours_end CHECK (end_hour BETWEEN 9 AND 21);

-- Several galleries at one project or tower, told apart by a label.
ALTER TABLE site_locations
  ADD COLUMN label text NOT NULL DEFAULT 'Main gallery'
    CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'site_locations'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (org_id, scope_node_id)'
  LOOP
    EXECUTE format('ALTER TABLE site_locations DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
CREATE UNIQUE INDEX site_locations_node_label ON site_locations (org_id, scope_node_id, lower(label));

-- The gallery a visit is at. NULL is the first gallery at or above its tower.
ALTER TABLE site_visits
  ADD COLUMN location_id uuid REFERENCES site_locations(id) ON DELETE SET NULL;

CREATE FUNCTION site_visits_location_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM site_locations s
    JOIN scope_nodes ln ON ln.id = s.scope_node_id
    JOIN scope_nodes vn ON vn.id = NEW.scope_node_id
    WHERE s.id = NEW.location_id AND s.org_id = NEW.org_id AND ln.path @> vn.path
  ) THEN
    RAISE EXCEPTION 'a visit''s gallery is one at or above its tower' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER site_visits_location_check
  BEFORE INSERT OR UPDATE OF location_id, scope_node_id ON site_visits
  FOR EACH ROW EXECUTE FUNCTION site_visits_location_check();
