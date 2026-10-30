-- ===========================================================================
--  0073_calling_numbers  --  each developer's own calling number
--
--  One Vobiz number used to serve every tenant for AI calls, hand-offs and
--  calls through our number. A buyer who reports that number as spam gets it
--  blocked for every developer at once, and an incoming call to it cannot
--  say whose buyer is ringing. So a tenant rents numbers of its own, the way
--  it connects a WhatsApp number of its own, and every outbound call takes
--  its caller id from the number placed at or above the lead's tower.
--
--  A NUMBER IS RENTED ON OUR VOBIZ ACCOUNT AND BELONGS TO ONE TENANT
--
--  The row holds the E.164 number, where it is used, and the Sarvam
--  connection to dial through when the tenant has one of its own (NULL is
--  the platform's connection). One live row per number across every tenant,
--  so `calling_number_owner()` answers an inbound call with one tenant.
--
--  A RELEASED NUMBER STAYS
--
--  Calls name the number they went from, so a released row is kept with
--  `released_at` and nothing in use. The app role holds no DELETE.
-- ===========================================================================

CREATE TABLE calling_numbers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- E.164, as Vobiz rented it.
  number                text NOT NULL CHECK (number ~ '^\+[1-9][0-9]{7,14}$'),
  -- Where the number is from, as Vobiz described it, for the screen.
  city                  text CHECK (city IS NULL OR length(city) <= 80),
  provider              text NOT NULL DEFAULT 'VOBIZ' CHECK (provider IN ('VOBIZ')),
  -- The tenant's own Sarvam connection, when it has one. NULL dials through
  -- the platform's connection with this number as the caller id.
  sarvam_connection_id  text CHECK (sarvam_connection_id IS NULL OR sarvam_connection_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),

  -- Where it is used: the organisation, an entity or a project. NULL is
  -- rented and not in use yet. A node a number is placed at cannot be
  -- deleted until the number is moved.
  scope_node_id         uuid REFERENCES scope_nodes(id),
  active                boolean NOT NULL DEFAULT false,

  -- What a month of it costs us and what it is sold at, frozen the day it
  -- was rented (doc/pricing.md: Rs 600 and Rs 999).
  monthly_cost_paise    integer NOT NULL CHECK (monthly_cost_paise >= 0),
  monthly_price_paise   integer NOT NULL CHECK (monthly_price_paise >= 0),

  rented_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  rented_at             timestamptz NOT NULL DEFAULT now(),
  released_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  released_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT calling_numbers_placed CHECK (NOT active OR (scope_node_id IS NOT NULL AND released_at IS NULL)),
  CONSTRAINT calling_numbers_released CHECK (released_at IS NULL OR (NOT active AND scope_node_id IS NULL))
);
-- One tenant per number.
CREATE UNIQUE INDEX calling_numbers_one_live ON calling_numbers (number) WHERE released_at IS NULL;
-- One number per place, or "which number does this buyer see" has two answers.
CREATE UNIQUE INDEX calling_numbers_one_per_node ON calling_numbers (org_id, scope_node_id) WHERE active;
CREATE INDEX calling_numbers_org ON calling_numbers (org_id);

-- A number is placed at the organisation, an entity or a project of its own
-- tenant, never at a region or a tower, and never inside another tenant.
CREATE FUNCTION calling_numbers_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope_node_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM scope_nodes
    WHERE id = NEW.scope_node_id AND org_id = NEW.org_id AND kind IN ('ORG', 'ENTITY', 'PROJECT')
  ) THEN
    RAISE EXCEPTION 'a calling number is placed at the organisation, an entity or a project of its own tenant'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- The number and its frozen price never change; a released number is
    -- never brought back (renting it again is a new row).
    IF NEW.number <> OLD.number OR NEW.org_id <> OLD.org_id
       OR NEW.monthly_cost_paise <> OLD.monthly_cost_paise OR NEW.monthly_price_paise <> OLD.monthly_price_paise
       OR NEW.rented_at <> OLD.rented_at THEN
      RAISE EXCEPTION 'a calling number''s number and price are fixed when it is rented' USING ERRCODE = '23514';
    END IF;
    IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
      RAISE EXCEPTION 'a released calling number stays released' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calling_numbers_check BEFORE INSERT OR UPDATE ON calling_numbers
  FOR EACH ROW EXECUTE FUNCTION calling_numbers_check();

-- ---------------------------------------------------------------------------
-- A call through our number remembers the number it went from, so the
-- person's pick-up rings the buyer from the same one.
-- ---------------------------------------------------------------------------
ALTER TABLE proxy_calls
  ADD COLUMN from_number text CHECK (from_number IS NULL OR from_number ~ '^\+[1-9][0-9]{7,14}$');

-- ---------------------------------------------------------------------------
-- An inbound call names a number, not a tenant
-- ---------------------------------------------------------------------------
--
-- Ids only, the pattern 0045 set. What is done with the answer happens back
-- inside `withTenant()`.
CREATE FUNCTION calling_number_owner(p_number text)
RETURNS TABLE (org_id uuid, number_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.org_id, c.id FROM calling_numbers c
  WHERE c.number = p_number
    AND c.released_at IS NULL
    AND p_number ~ '^\+[1-9][0-9]{7,14}$';
$$;
REVOKE ALL ON FUNCTION calling_number_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calling_number_owner(text) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON calling_numbers TO salesdesk_app;

ALTER TABLE calling_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY calling_numbers_isolation ON calling_numbers
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
