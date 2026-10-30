-- ===========================================================================
--  0056_quotes  --  a buyer's quote, the flat it blocks, the token link that
--                   pays for it, and the developer's own Razorpay account
--
--  THE ENGINE DRAFTS, A PERSON APPROVES
--
--  A quote's numbers are worked out from approved facts and written once:
--  the app role holds no UPDATE on any of them, so a changed price is a new
--  quote and the old one says SUPERSEDED. Its state moves forward only.
--
--  ONE FLAT, ONE LIVE BLOCK
--
--  A partial unique index over the live blocks stops two buyers holding one
--  flat. Expiry is a read (`expires_at`) plus a sweeper that releases, and
--  reserving a flat releases an expired block on it in the same transaction.
--
--  THE MONEY NEVER TOUCHES US
--
--  A token link is made by the developer's own Razorpay account, connected
--  through Razorpay's partner sign-in, and the money settles to them. The
--  account's token is sealed per tenant. A webhook names the account, never
--  a tenant, so `payment_account_owner()` is the one read across tenants,
--  returning ids only, the pattern 0023 and 0045 set.
-- ===========================================================================

CREATE TABLE payment_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'RAZORPAY' CHECK (provider = 'RAZORPAY'),
  account_id    text NOT NULL CHECK (account_id ~ '^acc_[A-Za-z0-9]{6,30}$'),
  mode          text NOT NULL CHECK (mode IN ('test', 'live')),
  -- The sealed token (vault.ts), never readable without the org's key.
  secret        bytea,
  key_version   smallint,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BROKEN', 'DISCONNECTED')),
  connected_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'DISCONNECTED') = (secret IS NULL))
);
-- One account, one tenant: a webhook naming it must have one answer.
CREATE UNIQUE INDEX payment_accounts_one_owner ON payment_accounts (provider, account_id) WHERE status <> 'DISCONNECTED';
CREATE UNIQUE INDEX payment_accounts_one_live ON payment_accounts (org_id, provider) WHERE status <> 'DISCONNECTED';

GRANT SELECT, INSERT ON payment_accounts TO salesdesk_app;
GRANT UPDATE (secret, key_version, status, updated_at) ON payment_accounts TO salesdesk_app;
ALTER TABLE payment_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_accounts_isolation ON payment_accounts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

CREATE FUNCTION payment_account_owner(p_account text)
RETURNS TABLE (org_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.org_id, a.id FROM payment_accounts a
  WHERE a.provider = 'RAZORPAY' AND a.account_id = p_account AND a.status <> 'DISCONNECTED'
$$;
REVOKE ALL ON FUNCTION payment_account_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_account_owner(text) TO salesdesk_app;

-- ---------------------------------------------------------------------------

CREATE TABLE quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  scope_node_id    uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  unit_type_id     uuid NOT NULL REFERENCES unit_types(id) ON DELETE RESTRICT,
  unit_no          text NOT NULL CHECK (unit_no ~ '^[A-Z0-9][A-Z0-9 /-]{0,19}$'),
  -- The published Brain versions and the approved unit type's hash it was worked out from.
  brain_versions   uuid[] NOT NULL DEFAULT '{}',
  unit_hash        text NOT NULL CHECK (unit_hash ~ '^[0-9a-f]{64}$'),
  -- When the flat's availability was read; NULL where no inventory is held.
  inventory_read_at timestamptz,
  price            bigint NOT NULL CHECK (price > 0),
  gst_rate         numeric(4, 2) NOT NULL CHECK (gst_rate IN (0, 1, 5)),
  gst              bigint NOT NULL CHECK (gst >= 0),
  duty_rate        numeric(4, 2) NOT NULL CHECK (duty_rate >= 0 AND duty_rate <= 15),
  stamp_duty       bigint NOT NULL CHECK (stamp_duty >= 0),
  registration     bigint NOT NULL CHECK (registration >= 0),
  all_in           bigint NOT NULL CHECK (all_in = price + gst + stamp_duty + registration),
  token            bigint NOT NULL CHECK (token > 0 AND token <= price),
  -- Which state's row the taxes came from, its source and the day it was read.
  tax_row          jsonb NOT NULL,
  state            text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'APPROVED', 'SENT', 'SUPERSEDED', 'EXPIRED')),
  drafted_by       text NOT NULL DEFAULT 'ENGINE' CHECK (drafted_by = 'ENGINE'),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  sent_at          timestamptz,
  content_hash     text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (state IN ('DRAFT', 'SUPERSEDED', 'EXPIRED') OR approved_at IS NOT NULL),
  CHECK (state <> 'SENT' OR sent_at IS NOT NULL)
);
CREATE INDEX quotes_lead ON quotes (org_id, lead_id, created_at DESC);

CREATE FUNCTION quotes_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'DRAFT' AND NEW.state IN ('APPROVED', 'SUPERSEDED', 'EXPIRED'))
    OR (OLD.state = 'APPROVED' AND NEW.state IN ('SENT', 'SUPERSEDED', 'EXPIRED'))
    OR (OLD.state = 'SENT' AND NEW.state IN ('SUPERSEDED', 'EXPIRED'))) THEN
    RAISE EXCEPTION 'A quote moves forward only: % to %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'An approval is not rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quotes_forward BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION quotes_forward();

GRANT SELECT, INSERT ON quotes TO salesdesk_app;
GRANT UPDATE (state, approved_by, approved_at, sent_at, updated_at) ON quotes TO salesdesk_app;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY quotes_isolation ON quotes
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------

CREATE TABLE unit_blocks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  unit_no        text NOT NULL CHECK (unit_no ~ '^[A-Z0-9][A-Z0-9 /-]{0,19}$'),
  quote_id       uuid NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  --   PENDING_TOKEN  held for the token, 48 hours
  --   TOKEN_PAID     paid; held 7 days more for the agreement
  --   RELEASED       let go: expired, voided, or the link was cancelled
  --   CONVERTED      the agreement is registered; the CRM owns it now
  state          text NOT NULL DEFAULT 'PENDING_TOKEN' CHECK (state IN ('PENDING_TOKEN', 'TOKEN_PAID', 'RELEASED', 'CONVERTED')),
  expires_at     timestamptz NOT NULL,
  paid_at        timestamptz,
  released_at    timestamptz,
  reason         text CHECK (reason IS NULL OR length(reason) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'RELEASED') = (released_at IS NOT NULL)),
  CHECK (state <> 'TOKEN_PAID' OR paid_at IS NOT NULL)
);
CREATE UNIQUE INDEX unit_blocks_one_live ON unit_blocks (org_id, scope_node_id, unit_no)
  WHERE state IN ('PENDING_TOKEN', 'TOKEN_PAID');

CREATE FUNCTION unit_blocks_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('RELEASED', 'CONVERTED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'A released or converted block is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'TOKEN_PAID' AND NEW.state = 'PENDING_TOKEN' THEN
    RAISE EXCEPTION 'A paid block does not go back to waiting' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER unit_blocks_forward BEFORE UPDATE ON unit_blocks FOR EACH ROW EXECUTE FUNCTION unit_blocks_forward();

GRANT SELECT, INSERT ON unit_blocks TO salesdesk_app;
GRANT UPDATE (state, expires_at, paid_at, released_at, reason) ON unit_blocks TO salesdesk_app;
ALTER TABLE unit_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY unit_blocks_isolation ON unit_blocks
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------

CREATE TABLE payment_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  quote_id             uuid NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  block_id             uuid NOT NULL REFERENCES unit_blocks(id) ON DELETE RESTRICT,
  account_id           uuid NOT NULL REFERENCES payment_accounts(id) ON DELETE RESTRICT,
  provider             text NOT NULL DEFAULT 'RAZORPAY' CHECK (provider = 'RAZORPAY'),
  -- The quote, in the gateway's own reference field.
  reference            text NOT NULL CHECK (reference ~ '^q[0-9a-f]{32}$'),
  provider_id          text CHECK (provider_id IS NULL OR provider_id ~ '^plink_[A-Za-z0-9]{6,30}$'),
  short_url            text CHECK (short_url IS NULL OR short_url ~ '^https://'),
  amount_paise         bigint NOT NULL CHECK (amount_paise > 0),
  --   CREATING   reserved; the gateway has not answered yet
  --   CREATED    the buyer has the link
  --   PAID       the token is paid into the developer's account
  --   EXPIRED, CANCELLED  the gateway ended it
  --   VOID       the gateway never made it, or it was undone with its block
  status               text NOT NULL DEFAULT 'CREATING' CHECK (status IN ('CREATING', 'CREATED', 'PAID', 'EXPIRED', 'CANCELLED', 'VOID')),
  expires_at           timestamptz NOT NULL,
  paid_at              timestamptz,
  provider_payment_id  text CHECK (provider_payment_id IS NULL OR length(provider_payment_id) <= 40),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('CREATED', 'PAID') OR provider_id IS NOT NULL),
  CHECK ((status = 'PAID') = (paid_at IS NOT NULL))
);
CREATE UNIQUE INDEX payment_links_one_live ON payment_links (quote_id) WHERE status IN ('CREATING', 'CREATED', 'PAID');
-- A retry after a lost answer reuses the reference, so the gateway finds the
-- link it already made; only one live row holds it.
CREATE UNIQUE INDEX payment_links_one_reference ON payment_links (reference) WHERE status IN ('CREATING', 'CREATED', 'PAID');

GRANT SELECT, INSERT ON payment_links TO salesdesk_app;
GRANT UPDATE (provider_id, short_url, status, paid_at, provider_payment_id, updated_at) ON payment_links TO salesdesk_app;
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_links_isolation ON payment_links
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

CREATE TABLE payment_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider     text NOT NULL DEFAULT 'RAZORPAY' CHECK (provider = 'RAZORPAY'),
  event_id     text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 100),
  event        text NOT NULL CHECK (length(event) <= 60),
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);

GRANT SELECT, INSERT ON payment_events TO salesdesk_app;
GRANT UPDATE (processed_at) ON payment_events TO salesdesk_app;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_events_isolation ON payment_events
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
