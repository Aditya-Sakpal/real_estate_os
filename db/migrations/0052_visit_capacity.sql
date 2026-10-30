-- ===========================================================================
--  0052_visit_capacity  --  how many visits a project's gallery can take in
--                           an hour, the seats taken, the ones held while a
--                           buyer chooses, and visits that are waiting or
--                           barred
--
--  A gallery has so many hosts on the floor, and a visit takes one of them
--  for the better part of an hour. So capacity is per project, per day, per
--  hour: `visit_slots` is that ledger, one row per project per day per hour
--  a visit starts in, made the first time anybody asks about it from the
--  project's `visit_capacity` (hosts on a weekday, hosts at the weekend).
--
--  A seat is taken by ONE statement, `UPDATE ... WHERE taken + live holds <
--  capacity RETURNING id`, so two bookings racing for the last seat resolve
--  in the database: one gets the row, the other gets nothing and is offered
--  three other hours. The row lock serialises them; nothing is counted in
--  the application.
--
--  A HOLD is a seat kept for ten minutes while a buyer picks one of three
--  hours offered on WhatsApp. Expiry is a comparison with now(), never a
--  job: an expired hold simply stops counting.
--
--  A visit may now wait (REQUESTED: the hour asked for was full and three
--  others were offered) or be barred (BLOCKED: the admission gate said no
--  at the day-before or two-hour check, and `blocked_reason` says why).
-- ===========================================================================

CREATE TABLE visit_capacity (
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  weekday_hosts  smallint NOT NULL DEFAULT 2 CHECK (weekday_hosts BETWEEN 0 AND 50),
  weekend_hosts  smallint NOT NULL DEFAULT 3 CHECK (weekend_hosts BETWEEN 0 AND 50),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE visit_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  -- The IST civil date and the hour a visit starts in, 10 to 18.
  day         date NOT NULL,
  hour        smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  capacity    smallint NOT NULL CHECK (capacity BETWEEN 0 AND 50),
  taken       smallint NOT NULL DEFAULT 0 CHECK (taken >= 0),
  UNIQUE (org_id, project_id, day, hour)
);
CREATE INDEX visit_slots_day ON visit_slots (org_id, project_id, day);

CREATE TABLE visit_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slot_id      uuid NOT NULL REFERENCES visit_slots(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- The visit waiting on this choice, when there is one.
  visit_id     uuid REFERENCES site_visits(id) ON DELETE CASCADE,
  -- The start the buyer is offered, IST half hour, inside the slot's hour.
  starts_at    timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  -- Taken up by a booking, or let go because another was picked.
  released_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX visit_holds_live ON visit_holds (slot_id, expires_at) WHERE released_at IS NULL;
CREATE INDEX visit_holds_lead ON visit_holds (lead_id, created_at DESC);

ALTER TABLE site_visits
  ADD COLUMN slot_id uuid REFERENCES visit_slots(id) ON DELETE SET NULL,
  ADD COLUMN blocked_reason text CHECK (blocked_reason IS NULL OR length(blocked_reason) <= 200);
ALTER TABLE site_visits DROP CONSTRAINT site_visits_status_check;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_status_check CHECK (status IN (
  'REQUESTED', 'CONFIRMED', 'BLOCKED', 'ON_SITE', 'VISITED', 'NO_SHOW', 'LAPSED', 'MOVED', 'CANCELLED'));
ALTER TABLE site_visits ADD CONSTRAINT site_visits_blocked
  CHECK ((status = 'BLOCKED') = (blocked_reason IS NOT NULL));
-- A buyer can now book by tapping one of the times offered on WhatsApp.
ALTER TABLE site_visits DROP CONSTRAINT site_visits_booked_via_check;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_booked_via_check CHECK (booked_via IN ('AI_CALL', 'CONSOLE', 'WHATSAPP'));

GRANT SELECT, INSERT, UPDATE ON visit_capacity TO salesdesk_app;
-- The ledger's counts move; its rows are never removed by the application.
GRANT SELECT, INSERT, UPDATE (taken, capacity) ON visit_slots TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE (released_at, visit_id) ON visit_holds TO salesdesk_app;

ALTER TABLE visit_capacity ENABLE ROW LEVEL SECURITY;
CREATE POLICY visit_capacity_isolation ON visit_capacity
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE visit_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY visit_slots_isolation ON visit_slots
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE visit_holds ENABLE ROW LEVEL SECURITY;
CREATE POLICY visit_holds_isolation ON visit_holds
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
