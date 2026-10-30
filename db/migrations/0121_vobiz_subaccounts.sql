-- ===========================================================================
--  0121_vobiz_subaccounts  --  each client's own Vobiz sub-account and KYC
--
--  A calling number a client rents sits on a Vobiz sub-account in the
--  client's own name (`kyc_mode` customer_use), verified once by the client
--  through Vobiz's KYC, so a number a buyer reports is the client's, not
--  Sales Desk's (decided 28 October 2026). Vobiz bills our main account for
--  it. One sub-account per organisation; its token is sealed per tenant
--  (`vault.ts`, purpose `vobiz-sub:<id>`) and never shown on a screen.
--
--  Until its KYC is verified, the client is not offered a number.
-- ===========================================================================

CREATE TABLE vobiz_subaccounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sub_auth_id      text NOT NULL CHECK (sub_auth_id ~ '^SA_[A-Z0-9]{4,40}$'),
  secret           bytea NOT NULL,
  key_version      smallint NOT NULL,
  business_type    text NOT NULL CHECK (business_type IN
                     ('individual', 'proprietorship', 'private_limited', 'public_limited', 'llp', 'partnership', 'trust', 'society', 'huf')),
  email            text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  --  not_started, pending, verified, failed: Vobiz's own words.
  kyc_status       text NOT NULL DEFAULT 'not_started' CHECK (kyc_status IN ('not_started', 'pending', 'verified', 'failed')),
  calls_blocked    boolean NOT NULL DEFAULT true,
  -- What each document stands at (pan, gst, cin, aadhaar), as Vobiz said.
  verifications    jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at       timestamptz,
  verified_at      timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vobiz_subaccounts_one_per_org ON vobiz_subaccounts (org_id);
CREATE UNIQUE INDEX vobiz_subaccounts_sub ON vobiz_subaccounts (sub_auth_id);

-- A sub-account keeps its id and its tenant.
CREATE FUNCTION vobiz_subaccounts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sub_auth_id <> OLD.sub_auth_id OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'a Vobiz sub-account keeps its id and its organisation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vobiz_subaccounts_fixed BEFORE UPDATE ON vobiz_subaccounts
  FOR EACH ROW EXECUTE FUNCTION vobiz_subaccounts_fixed();

GRANT SELECT, INSERT ON vobiz_subaccounts TO salesdesk_app;
GRANT UPDATE (secret, key_version, business_type, email, kyc_status, calls_blocked, verifications, checked_at, verified_at)
  ON vobiz_subaccounts TO salesdesk_app;
ALTER TABLE vobiz_subaccounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY vobiz_subaccounts_isolation ON vobiz_subaccounts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Which Vobiz account a number sits on: the client's sub-account, or ours (NULL).
ALTER TABLE calling_numbers ADD COLUMN sub_auth_id text CHECK (sub_auth_id IS NULL OR sub_auth_id ~ '^SA_[A-Z0-9]{4,40}$');
