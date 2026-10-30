-- Per-tenant data keys under AWS KMS (slice 3 of doc/plan-access-security.md).
--
-- Each organisation gets its own AES-256 data key, made by KMS
-- (GenerateDataKey with the encryption context { org_id }) and stored here
-- only in its wrapped form. Opening it needs KMS and the same org id, so a
-- wrapped key copied into another tenant's row does not open. vault.ts seals
-- every connector token under the tenant's active key (format 2).
--
-- Rows are never changed but for retiring, and never deleted: a retired key
-- still opens what was sealed under it until `vault:reseal` has moved it.

CREATE TABLE tenant_keys (
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Written into the second byte of every sealed value, so 1 to 255.
  version      smallint NOT NULL CHECK (version BETWEEN 1 AND 255),
  -- KMS's CiphertextBlob for the data key. Never the key itself.
  wrapped_key  bytea NOT NULL CHECK (octet_length(wrapped_key) BETWEEN 16 AND 1024),
  kms_key_arn  text NOT NULL CHECK (kms_key_arn ~ '^(arn:aws:kms:[a-z0-9-]+:[0-9]{12}:(key|alias)/[A-Za-z0-9/_-]+|dev:[A-Za-z0-9:_-]+)$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  PRIMARY KEY (org_id, version)
);

-- One key seals at a time; every other is retired.
CREATE UNIQUE INDEX tenant_keys_one_active ON tenant_keys (org_id) WHERE retired_at IS NULL;

-- Retiring is the only change, and it is one way: a key is never brought
-- back, and nothing else about a row moves.
CREATE FUNCTION tenant_keys_retire_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.wrapped_key IS DISTINCT FROM OLD.wrapped_key OR NEW.kms_key_arn IS DISTINCT FROM OLD.kms_key_arn
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a tenant key never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'a retired key stays retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_keys_retire_only BEFORE UPDATE ON tenant_keys
  FOR EACH ROW EXECUTE FUNCTION tenant_keys_retire_only();

GRANT SELECT, INSERT ON tenant_keys TO salesdesk_app;
GRANT UPDATE (retired_at) ON tenant_keys TO salesdesk_app;
ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_keys_isolation ON tenant_keys
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
