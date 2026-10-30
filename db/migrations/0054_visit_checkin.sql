-- ===========================================================================
--  0054_visit_checkin  --  a buyer checked in at the gallery by the site
--                          team's own phone, where and when it scanned, and
--                          where the buyer came from, frozen there
--
--  Check-in is an authenticated act by the site team: the buyer shows the
--  pass their confirmation carried, and somebody holding `visit:confirm` at
--  the tower scans it. A scan made with no signal is kept on the phone with
--  its own time and position and judged when it arrives, so `arrived_at` is
--  the scan's time and `checkin_synced_at` is when we heard of it.
--
--  ATTRIBUTION FREEZES HERE
--
--  Where the buyer came from (the channel, the ad's lineage, the
--  publication, a partner's claim) is written once, at check-in, and a
--  trigger refuses any change to it after that. A lead's own lineage can be
--  edited or a partner's claim can lapse; what brought this buyer to the
--  gallery on this day cannot be recomputed.
-- ===========================================================================

ALTER TABLE site_visits
  ADD COLUMN checkin_method text CHECK (checkin_method IS NULL OR checkin_method IN ('QR', 'MANUAL')),
  ADD COLUMN checkin_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN checkin_lat numeric(9, 6) CHECK (checkin_lat IS NULL OR checkin_lat BETWEEN -90 AND 90),
  ADD COLUMN checkin_lng numeric(9, 6) CHECK (checkin_lng IS NULL OR checkin_lng BETWEEN -180 AND 180),
  ADD COLUMN checkin_accuracy_m integer CHECK (checkin_accuracy_m IS NULL OR checkin_accuracy_m >= 0),
  ADD COLUMN checkin_distance_m integer CHECK (checkin_distance_m IS NULL OR checkin_distance_m >= 0),
  ADD COLUMN checkin_flags text[] NOT NULL DEFAULT '{}'
    CHECK (checkin_flags <@ ARRAY['NO_POSITION', 'NO_PIN', 'SENT_LATER']::text[]),
  ADD COLUMN checkin_synced_at timestamptz,
  ADD COLUMN attribution jsonb,
  ADD CONSTRAINT site_visits_checkin_pin CHECK ((checkin_lat IS NULL) = (checkin_lng IS NULL));

CREATE FUNCTION site_visits_attribution_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.attribution IS NOT NULL AND NEW.attribution IS DISTINCT FROM OLD.attribution THEN
    RAISE EXCEPTION 'A visit''s attribution is frozen at check-in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER site_visits_attribution_frozen
  BEFORE UPDATE OF attribution ON site_visits
  FOR EACH ROW EXECUTE FUNCTION site_visits_attribution_frozen();
