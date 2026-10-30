-- ===========================================================================
--  0095_portal_accounts  --  a portal account we ask for its leads
--
--  Housing.com publishes a builder lead API: the developer's account id and a
--  secret key, a time window, and an HMAC of the current time. A developer
--  who adds them here has its Housing.com leads read every ten minutes by the
--  lead worker, as events with source PORTAL, the way a forwarded email or a
--  portal's own post arrives.
--
--  The key is sealed per tenant (`vault.ts`, purpose `portal-account:<id>`),
--  never stored in the clear and never shown again. Removing an account
--  scrubs it. A key Housing.com refuses marks the account BROKEN, which
--  Today shows, and it is not asked again until somebody saves a key.
-- ===========================================================================

CREATE TABLE portal_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  portal         text NOT NULL CHECK (portal IN ('HOUSING')),
  account_id     text NOT NULL CHECK (account_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  secret         bytea,
  key_version    smallint,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BROKEN', 'REMOVED')),
  -- The end of the last window read whole.
  pulled_until   timestamptz,
  last_pull_at   timestamptz,
  last_ok_at     timestamptz,
  last_error     text CHECK (last_error IS NULL OR length(last_error) <= 300),
  leads_read     integer NOT NULL DEFAULT 0 CHECK (leads_read >= 0),
  -- Two workers never ask at once: a pass claims the account until then.
  lease_until    timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_accounts_scrubbed CHECK ((status = 'REMOVED') = (secret IS NULL)),
  CONSTRAINT portal_accounts_keyed CHECK (secret IS NULL OR key_version IS NOT NULL)
);

-- One live row per account, across tenants: an account belongs to one developer.
CREATE UNIQUE INDEX portal_accounts_one_live ON portal_accounts (portal, account_id) WHERE status <> 'REMOVED';
CREATE INDEX portal_accounts_org ON portal_accounts (org_id) WHERE status <> 'REMOVED';

-- A removed account stays removed.
CREATE FUNCTION portal_accounts_forward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'REMOVED' AND NEW.status <> 'REMOVED' THEN
    RAISE EXCEPTION 'a removed portal account is not brought back; add it again';
  END IF;
  IF NEW.account_id <> OLD.account_id OR NEW.portal <> OLD.portal OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'a portal account keeps its portal and id';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_accounts_forward BEFORE UPDATE ON portal_accounts
  FOR EACH ROW EXECUTE FUNCTION portal_accounts_forward();

GRANT SELECT, INSERT ON portal_accounts TO salesdesk_app;
GRANT UPDATE (secret, key_version, status, pulled_until, last_pull_at, last_ok_at, last_error, leads_read, lease_until)
  ON portal_accounts TO salesdesk_app;
ALTER TABLE portal_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_accounts_isolation ON portal_accounts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- An account held by another tenant is refused when added, naming nobody.
CREATE FUNCTION portal_account_taken(p_portal text, p_account text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM portal_accounts
    WHERE portal = p_portal AND account_id = p_account AND status <> 'REMOVED'
      AND org_id IS DISTINCT FROM app_current_org()
  );
$$;
REVOKE ALL ON FUNCTION portal_account_taken(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_account_taken(text, text) TO salesdesk_app;
