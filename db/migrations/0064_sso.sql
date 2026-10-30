-- ===========================================================================
-- 0064: single sign-on (SAML) and provisioning (SCIM), per organisation.
--
-- A developer's IT team signs its people in through its own identity
-- provider (Okta, Entra ID, Google Workspace's SAML app, OneLogin) and adds
-- and removes them from there. Everything here is per tenant under RLS,
-- with two exceptions that are reads across tenants and return ids only:
-- which organisation a verified domain belongs to (sign-in has no tenant
-- yet), and which organisation a SCIM token belongs to (a provisioning call
-- has no session).
-- ===========================================================================

-- The organisation's identity provider.
CREATE TABLE sso_configs (
  org_id         uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  idp_entity_id  text NOT NULL CHECK (length(idp_entity_id) BETWEEN 1 AND 500),
  sso_url        text NOT NULL CHECK (sso_url ~ '^https://' AND length(sso_url) <= 1000),
  -- PEM bodies, one or two: the second is the next one during a rotation.
  certificates   text[] NOT NULL CHECK (cardinality(certificates) BETWEEN 1 AND 2),
  -- People on a verified domain must sign in through the identity provider.
  enforce        boolean NOT NULL DEFAULT false,
  -- The last time somebody signed in through these exact settings.
  tested_at      timestamptz,
  tested_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Requiring a door nobody has walked through locks everybody out.
  CONSTRAINT sso_configs_tested CHECK (NOT enforce OR tested_at IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON sso_configs TO salesdesk_app;
ALTER TABLE sso_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY sso_configs_isolation ON sso_configs
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- The mail domains whose people it signs in, each proved by a DNS record.
CREATE TABLE sso_domains (
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  domain       citext NOT NULL CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  -- What the TXT record must say: salesdesk-verify=<token>.
  token        text NOT NULL CHECK (token ~ '^[a-f0-9]{32}$'),
  verified_at  timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, domain)
);
-- Two organisations may each claim a domain; only one can prove it.
CREATE UNIQUE INDEX sso_domains_verified ON sso_domains (domain) WHERE verified_at IS NOT NULL;
GRANT SELECT, INSERT, DELETE ON sso_domains TO salesdesk_app;
GRANT UPDATE (verified_at) ON sso_domains TO salesdesk_app;
ALTER TABLE sso_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY sso_domains_isolation ON sso_domains
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Each sign-in we started, so the answer can be matched to its question.
CREATE TABLE saml_requests (
  id          text PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 200),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saml_requests_age ON saml_requests (created_at);
GRANT SELECT, INSERT, DELETE ON saml_requests TO salesdesk_app;
ALTER TABLE saml_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY saml_requests_isolation ON saml_requests
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Every assertion accepted, so the same one is never accepted twice.
CREATE TABLE saml_seen (
  assertion_id  text NOT NULL CHECK (length(assertion_id) BETWEEN 1 AND 200),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seen_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, assertion_id)
);
GRANT SELECT, INSERT ON saml_seen TO salesdesk_app;
ALTER TABLE saml_seen ENABLE ROW LEVEL SECURITY;
CREATE POLICY saml_seen_isolation ON saml_seen
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- The hand-over from our assertion check to the session: one use, two minutes.
CREATE TABLE sso_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Redeemed on the control connection at sign-in, like the rest of sign-in.
ALTER TABLE sso_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY sso_tickets_isolation ON sso_tickets
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
GRANT SELECT, INSERT ON sso_tickets TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- SCIM
-- ---------------------------------------------------------------------------

-- A provisioning token: shown once, stored as a hash.
CREATE TABLE scim_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
GRANT SELECT, INSERT ON scim_tokens TO salesdesk_app;
GRANT UPDATE (last_used_at, revoked_at) ON scim_tokens TO salesdesk_app;
ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY scim_tokens_isolation ON scim_tokens
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A person as the identity provider knows them.
CREATE TABLE scim_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id  text CHECK (external_id IS NULL OR length(external_id) <= 300),
  user_name    citext NOT NULL CHECK (length(user_name) BETWEEN 3 AND 320),
  -- The work address the person is keyed on. Kept here because a person
  -- with no membership yet is not visible through users' own policy.
  email        citext NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  given_name   text CHECK (given_name IS NULL OR length(given_name) <= 120),
  family_name  text CHECK (family_name IS NULL OR length(family_name) <= 120),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_name),
  UNIQUE (org_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON scim_users TO salesdesk_app;
ALTER TABLE scim_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY scim_users_isolation ON scim_users
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A group, and the role and place an admin said its members get.
CREATE TABLE scim_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  external_id     text CHECK (external_id IS NULL OR length(external_id) <= 300),
  role            text,
  scope_node_id   uuid REFERENCES scope_nodes(id) ON DELETE SET NULL,
  mapped_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  mapped_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, display_name),
  CONSTRAINT scim_groups_mapping CHECK ((role IS NULL) = (scope_node_id IS NULL))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON scim_groups TO salesdesk_app;
ALTER TABLE scim_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY scim_groups_isolation ON scim_groups
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

CREATE TABLE scim_group_members (
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  group_id      uuid NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  scim_user_id  uuid NOT NULL REFERENCES scim_users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, scim_user_id)
);
GRANT SELECT, INSERT, DELETE ON scim_group_members TO salesdesk_app;
ALTER TABLE scim_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY scim_group_members_isolation ON scim_group_members
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A membership the identity provider gave, so removing it there removes it here.
ALTER TABLE memberships ADD COLUMN scim_group_id uuid REFERENCES scim_groups(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- The two reads across tenants
-- ---------------------------------------------------------------------------

-- Which organisation a SCIM token belongs to. The token's hash in, the org
-- and the token's id out, and the use is stamped.
CREATE FUNCTION scim_token_org(p_hash text)
RETURNS TABLE (org_id uuid, token_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE scim_tokens t SET last_used_at = now()
  FROM orgs o
  WHERE t.token_hash = p_hash AND t.revoked_at IS NULL AND o.id = t.org_id AND o.status = 'ACTIVE'
  RETURNING t.org_id, t.id;
$$;
REVOKE ALL ON FUNCTION scim_token_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scim_token_org(text) TO salesdesk_app;
