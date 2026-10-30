-- ===========================================================================
--  0045_whatsapp_numbers  --  each developer's own WhatsApp number
--
--  Until now one WhatsApp number, configured in the environment, spoke for
--  every tenant. That is how a business gets banned: templates sent in a
--  client's name from somebody else's account are exactly what Meta's
--  Terms of Acceptable Use punish, and a strike lands on the number, so one
--  developer's reported message would silence every other developer too.
--  Section 06 says each tenant brings its own WABA and number. There is no
--  shared number and no fallback to one.
--
--  THE ACCOUNT IS THE DEVELOPER'S, CONNECTED BY META'S OWN CONSENT
--
--  A developer connects through Embedded Signup, Meta's pop-up, as a
--  customer of our Tech Provider app. Meta hands back a code and, beside it
--  in the browser, the WABA and number the person picked. The browser's ids
--  are hints and nothing more: the server exchanges the code for a business
--  integration system user token and believes only the accounts that token
--  can reach. Nobody types an id.
--
--  A developer can keep the number they already use in the WhatsApp
--  Business app (Meta's coexistence onboarding, open to +91 since May
--  2025), because nobody in this market will change the number their
--  buyers and channel partners already have saved.
--
--  WHAT IS STORED IS CIPHERTEXT
--
--  The token is sealed by `vault.ts` per tenant and bound to the account
--  row, as 0023's are. A disconnected account holds no token, by CHECK.
--
--  ONE NUMBER, ONE TENANT
--
--  A webhook names a phone number id and a WABA id, never a tenant, so the
--  two lookup functions below are the only reads across tenants and return
--  ids only. For that to have one answer a live WABA and a live number
--  belong to exactly one organisation, which the unique indexes hold across
--  tenants.
--
--  WHERE A NUMBER IS USED
--
--  Like a Facebook Page, a number serves a node and the deepest active one
--  at or above a lead's tower sends to that lead, so a group running two
--  brands can put the second brand's number on its entity.
-- ===========================================================================

CREATE TABLE whatsapp_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  waba_id          text NOT NULL CHECK (waba_id ~ '^[0-9]{1,40}$'),
  -- The developer's Meta business portfolio, when Meta says which.
  business_id      text CHECK (business_id IS NULL OR business_id ~ '^[0-9]{1,40}$'),
  name             text NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  -- What Meta bills this account in. Meta stops delivering for an Indian
  -- business whose account is not in rupees from 1 January 2027.
  currency         text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),

  --   CONNECTED     the token works
  --   BROKEN        the token stopped working; somebody has to connect again
  --   DISCONNECTED  a person disconnected it, or Meta said the developer
  --                 removed us. No secret, by CHECK.
  status           text NOT NULL DEFAULT 'CONNECTED'
                     CHECK (status IN ('CONNECTED', 'BROKEN', 'DISCONNECTED')),
  secret           bytea,
  key_version      smallint,
  -- NULL: a system user token that does not expire.
  token_expires_at timestamptz,

  connected_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at     timestamptz NOT NULL DEFAULT now(),
  last_checked_at  timestamptz,
  last_error_code  text CHECK (last_error_code IS NULL OR length(last_error_code) <= 40),
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 500),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_accounts_scrubbed CHECK (status <> 'DISCONNECTED' OR secret IS NULL),
  CONSTRAINT whatsapp_accounts_sealed CHECK (status = 'DISCONNECTED' OR secret IS NOT NULL),
  CONSTRAINT whatsapp_accounts_keyed CHECK (secret IS NULL OR key_version IS NOT NULL)
);
-- One live connection per WABA, across every tenant.
CREATE UNIQUE INDEX whatsapp_accounts_one_live ON whatsapp_accounts (waba_id) WHERE status <> 'DISCONNECTED';
CREATE INDEX whatsapp_accounts_org ON whatsapp_accounts (org_id);

CREATE TABLE whatsapp_numbers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,

  phone_number_id  text NOT NULL CHECK (phone_number_id ~ '^[0-9]{1,40}$'),
  -- E.164, read back from Meta, never typed.
  display_phone    text NOT NULL CHECK (display_phone ~ '^\+[1-9][0-9]{7,14}$'),
  verified_name    text NOT NULL DEFAULT '' CHECK (length(verified_name) <= 200),
  name_status      text CHECK (name_status IS NULL OR length(name_status) <= 40),
  quality          text NOT NULL DEFAULT 'UNKNOWN' CHECK (quality IN ('GREEN', 'YELLOW', 'RED', 'UNKNOWN')),
  -- How many people the developer's portfolio may start a conversation with
  -- in 24 hours. Meta sets it per portfolio, and it starts at 250.
  daily_limit      text CHECK (daily_limit IS NULL OR daily_limit IN (
                     'TIER_250', 'TIER_2K', 'TIER_10K', 'TIER_100K', 'TIER_UNLIMITED')),

  -- Also live in the developer's WhatsApp Business app (coexistence). Such
  -- a number is never registered by us: it already is.
  on_app           boolean NOT NULL DEFAULT false,
  -- Registered on the Cloud API, by us or before us.
  registered       boolean NOT NULL DEFAULT false,
  -- Why registering did not work, in the words a person can act on.
  register_error   text CHECK (register_error IS NULL OR length(register_error) <= 300),
  -- The number's two-step verification PIN, sealed. Registering a new number
  -- sets one; Meta asks for it again if the number ever has to be registered
  -- again, and nobody would otherwise know it.
  pin_secret       bytea,
  pin_key_version  smallint,
  -- When we asked Meta to sync the app's contacts (coexistence needs it
  -- within 24 hours of connecting).
  synced_at        timestamptz,

  -- Where it is used. NULL: connected, not in use yet. A node a number is
  -- placed at cannot be deleted until the number is moved, the way a
  -- configuration a picture points at cannot.
  scope_node_id    uuid REFERENCES scope_nodes(id),
  active           boolean NOT NULL DEFAULT false,
  -- Set when its account is disconnected. A retired row stays so a message
  -- still names the number it went from.
  retired_at       timestamptz,

  checked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_numbers_placed CHECK (NOT active OR (scope_node_id IS NOT NULL AND retired_at IS NULL)),
  CONSTRAINT whatsapp_numbers_pin_keyed CHECK (pin_secret IS NULL OR pin_key_version IS NOT NULL),
  -- A retired number holds no PIN, the way a disconnected account holds no token.
  CONSTRAINT whatsapp_numbers_pin_scrubbed CHECK (retired_at IS NULL OR pin_secret IS NULL)
);
-- One tenant per number.
CREATE UNIQUE INDEX whatsapp_numbers_one_live ON whatsapp_numbers (phone_number_id) WHERE retired_at IS NULL;
-- One number per place, or "which number does this lead hear from" has two answers.
CREATE UNIQUE INDEX whatsapp_numbers_one_per_node ON whatsapp_numbers (org_id, scope_node_id) WHERE active;
CREATE INDEX whatsapp_numbers_org ON whatsapp_numbers (org_id);

-- ---------------------------------------------------------------------------
-- Templates, per account, per language
-- ---------------------------------------------------------------------------
--
-- Templates live on the WABA. One row per name and language, holding what
-- Meta decided and the hash of the text we sent, so a wording change in the
-- catalog reads as "send it again" rather than as approved.
CREATE TABLE whatsapp_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,

  name             text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND length(name) <= 512),
  language         text NOT NULL CHECK (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  -- What we asked for, and what Meta says it is. Meta approves a utility
  -- template it judges promotional as marketing, and recategorises monthly.
  category_asked   text NOT NULL CHECK (category_asked IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),
  category         text CHECK (category IS NULL OR category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),
  --   FAILED  Meta refused the submission itself; `reason` says why
  --   the rest are Meta's own words for a template's state
  status           text NOT NULL CHECK (status IN (
                     'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL',
                     'FLAGGED', 'REINSTATED', 'PENDING_DELETION', 'DELETED', 'ARCHIVED',
                     'LOCKED', 'LIMIT_EXCEEDED', 'FAILED')),
  meta_template_id text CHECK (meta_template_id IS NULL OR meta_template_id ~ '^[0-9]{1,40}$'),
  body_sha256      text NOT NULL CHECK (char_length(body_sha256) = 64),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  quality          text CHECK (quality IS NULL OR quality IN ('GREEN', 'YELLOW', 'RED', 'UNKNOWN')),

  submitted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, name, language)
);
CREATE INDEX whatsapp_templates_org ON whatsapp_templates (org_id);

-- ---------------------------------------------------------------------------
-- Which number a message went from, and who wrote to it
-- ---------------------------------------------------------------------------
ALTER TABLE messages
  ADD COLUMN number_id  uuid REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  -- Meta's business-scoped id for the buyer (since April 2026 a webhook may
  -- carry it without a phone number).
  ADD COLUMN wa_user_id text CHECK (wa_user_id IS NULL OR length(wa_user_id) <= 100);
CREATE INDEX messages_number ON messages (number_id, created_at DESC) WHERE number_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The webhook names a number or a WABA, not a tenant
-- ---------------------------------------------------------------------------
--
-- Ids only, the pattern 0023 and 0026 set. What is done with the answer
-- happens back inside `withTenant()`.
CREATE FUNCTION whatsapp_number_owner(p_phone_number_id text)
RETURNS TABLE (org_id uuid, number_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT n.org_id, n.id FROM whatsapp_numbers n
  JOIN whatsapp_accounts a ON a.id = n.account_id
  WHERE n.phone_number_id = p_phone_number_id
    AND n.retired_at IS NULL
    AND a.status <> 'DISCONNECTED'
    AND p_phone_number_id ~ '^[0-9]{1,40}$';
$$;
REVOKE ALL ON FUNCTION whatsapp_number_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_number_owner(text) TO salesdesk_app;

CREATE FUNCTION whatsapp_waba_owner(p_waba_id text)
RETURNS TABLE (org_id uuid, account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.org_id, a.id FROM whatsapp_accounts a
  WHERE a.waba_id = p_waba_id
    AND a.status <> 'DISCONNECTED'
    AND p_waba_id ~ '^[0-9]{1,40}$';
$$;
REVOKE ALL ON FUNCTION whatsapp_waba_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_waba_owner(text) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------
-- An account is scrubbed, never deleted: messages and templates name it.
GRANT SELECT, INSERT, UPDATE ON whatsapp_accounts TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE ON whatsapp_numbers TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE ON whatsapp_templates TO salesdesk_app;

ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_accounts_isolation ON whatsapp_accounts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE whatsapp_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_numbers_isolation ON whatsapp_numbers
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_templates_isolation ON whatsapp_templates
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
