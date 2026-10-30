-- ===========================================================================
--  0000_init  --  identity, tenancy, scope tree, audit
--
--  Day-one non-negotiables encoded here:
--    * User is GLOBAL, never tenant-scoped (Membership links them to orgs)
--    * Scope tree carries ltree paths for ancestor/descendant queries
--    * Org is a node in a graph, not a tree -- cross-org Grant edges land next
--    * Audit log is append-only
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- users -- ONE row per human, for the life of that human. A CP agent who
-- later joins a developer's pre-sales team is the same row with a new
-- Membership. Scoping users inside tenants makes that unmodellable.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  email_domain       citext NOT NULL,
  name               text,
  picture            text,
  -- phone is reserved for the phone+OTP path (CP agents, field staff) that
  -- arrives with the CP portal. Work-account SSO does not populate it.
  phone              text UNIQUE,
  phone_verified_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at      timestamptz
);
CREATE INDEX users_email_domain_idx ON users (email_domain);

-- ---------------------------------------------------------------------------
-- user_identities -- a user may link both Google and Microsoft over time.
-- idp_tenant holds Google's hd claim or Entra's tid: this is the proof the
-- account is a corporate one, and we keep it to auto-route later signups.
-- ---------------------------------------------------------------------------
CREATE TABLE user_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('google','microsoft-entra-id')),
  provider_subject  text NOT NULL,
  idp_tenant        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE INDEX user_identities_user_idx   ON user_identities (user_id);
CREATE INDEX user_identities_tenant_idx ON user_identities (idp_tenant);

-- ---------------------------------------------------------------------------
-- orgs -- the tenant. cell_id is control-plane routing: exactly one cell for
-- a long time, but every lookup goes through the indirection from day one.
-- ---------------------------------------------------------------------------
CREATE TABLE orgs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL CHECK (type IN
                    ('DEVELOPER','CHANNEL_PARTNER','AGENCY','CALL_CENTER','PLATFORM')),
  legal_name      text NOT NULL,
  display_name    text NOT NULL,
  -- GSTIN is the dedupe key that stops one company becoming two tenants.
  -- Nullable: CP sole proprietors below the threshold may not hold one.
  gstin           text,
  pan             text NOT NULL,
  region          text NOT NULL DEFAULT 'IN',
  cell_id         text NOT NULL DEFAULT 'IN-1',
  -- email domain + IdP tenant of the founding admin. Later signups from the
  -- same domain or tenant are routed to a join request, never a second org.
  primary_domain  citext,
  idp_tenant      text,
  status          text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','SUSPENDED','PENDING_VERIFICATION')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX orgs_gstin_key      ON orgs (gstin) WHERE gstin IS NOT NULL;
CREATE INDEX        orgs_pan_idx        ON orgs (pan);
CREATE INDEX        orgs_domain_idx     ON orgs (primary_domain);
CREATE INDEX        orgs_idp_tenant_idx ON orgs (idp_tenant);

-- ---------------------------------------------------------------------------
-- scope_nodes -- ORG -> ENTITY(SPV) -> REGION/CITY -> PROJECT -> PHASE/TOWER
-- RERA registration will attach to whichever node is the registered unit
-- (usually PHASE), which is why it is its own table, not a project column.
-- ---------------------------------------------------------------------------
CREATE TABLE scope_nodes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES scope_nodes(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('ORG','ENTITY','REGION','PROJECT','PHASE')),
  name       text NOT NULL,
  slug       text NOT NULL,
  path       ltree NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scope_nodes_path_key  ON scope_nodes (path);
CREATE INDEX        scope_nodes_path_gist ON scope_nodes USING gist (path);
CREATE INDEX        scope_nodes_org_idx   ON scope_nodes (org_id);
CREATE UNIQUE INDEX scope_nodes_sibling_slug ON scope_nodes
  (org_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

-- ---------------------------------------------------------------------------
-- memberships -- the User <-> Org link, ALWAYS scoped to a node. There is no
-- unscoped membership: "Sales Manager" is meaningless without "@ which project".
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  role           text NOT NULL,
  status         text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('INVITED','ACTIVE','REVOKED')),
  invited_by     uuid REFERENCES users(id),
  invited_at     timestamptz,
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memberships_unique_live
  ON memberships (user_id, scope_node_id, role) WHERE status <> 'REVOKED';
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE status = 'ACTIVE';
CREATE INDEX memberships_org_idx  ON memberships (org_id)  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- org_join_requests -- what a second signup from an existing company becomes.
-- ---------------------------------------------------------------------------
CREATE TABLE org_join_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matched_on  text NOT NULL CHECK (matched_on IN
                ('GSTIN','PAN','IDP_TENANT','EMAIL_DOMAIN')),
  status      text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX org_join_requests_one_pending
  ON org_join_requests (org_id, user_id) WHERE status = 'PENDING';
CREATE INDEX org_join_requests_org_idx
  ON org_join_requests (org_id) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- audit_log -- append-only. Every authz decision, PII access, unmask,
-- impersonation and outbound message lands here with its compliance decision.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         uuid,
  actor_user_id  uuid,
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_time_idx   ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_actor_time_idx ON audit_log (actor_user_id, created_at DESC);
