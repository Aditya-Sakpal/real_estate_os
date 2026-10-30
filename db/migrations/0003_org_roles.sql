-- ===========================================================================
--  0003_org_roles  --  roles become data a tenant owns, not code we ship
--
--  Until now a role was a string in memberships.role, and what it could do
--  was a hardcoded array in src/lib/nav.ts. Changing what a Sales Head may
--  see was a deploy, for every tenant at once. That does not survive contact
--  with a real developer group: a Lodha and a 40-unit builder in Nashik do
--  not agree on who may release a payout.
--
--  COPY ON WRITE, deliberately.
--
--  This table is EMPTY for a tenant that never opens the role editor. The 14
--  shipped templates live in src/lib/roles.ts and are resolved at read time.
--  A row appears here only when a tenant edits a template (source OVERRIDE,
--  keyed to the template) or writes its own role (source CUSTOM).
--
--  Seeding 14 rows per org instead would have frozen every tenant at the
--  permission set of the day they signed up: a permission added in a later
--  release would reach nobody until someone opened the editor and ticked it.
--  This way an untouched role keeps improving, and an edited one stays
--  exactly as its owner left it, which is the behaviour each case deserves.
-- ===========================================================================

CREATE TABLE org_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- For OVERRIDE this is the template key it replaces, e.g. 'SALES_HEAD'.
  -- For CUSTOM it is a tenant-invented key, always 'C_' prefixed.
  key          text NOT NULL,
  label        text NOT NULL,
  description  text NOT NULL DEFAULT '',

  -- Shallowest scope node the role may be granted at. A role whose work is
  -- per-project cannot be handed out at the org root.
  min_kind     text NOT NULL
                 CHECK (min_kind IN ('ORG','ENTITY','REGION','PROJECT','PHASE')),
  can_delegate boolean NOT NULL DEFAULT false,

  source       text NOT NULL CHECK (source IN ('OVERRIDE','CUSTOM')),

  -- resource:action keys from the code catalog. Anything unrecognised is
  -- dropped on the way in: an unknown key would grant nothing anyway, since
  -- no code asks for it.
  permissions  text[] NOT NULL DEFAULT '{}',

  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- A custom role can never shadow a shipped template, nor be mistaken for
  -- one later, because the two key spaces cannot overlap. LIKE treats the
  -- backslash as its escape character, so this is a literal 'C_' prefix.
  CONSTRAINT org_roles_custom_prefix
    CHECK ((source = 'CUSTOM') = (key LIKE 'C\_%')),

  CONSTRAINT org_roles_key_shape
    CHECK (key ~ '^[A-Z][A-Z0-9_]{1,48}$'),

  CONSTRAINT org_roles_label_present
    CHECK (length(btrim(label)) BETWEEN 1 AND 60)
);

-- One definition per key per tenant. This is also what makes an OVERRIDE
-- unambiguous: there cannot be two competing versions of SALES_HEAD.
CREATE UNIQUE INDEX org_roles_org_key ON org_roles (org_id, key);
CREATE INDEX org_roles_org_idx ON org_roles (org_id);

-- ---------------------------------------------------------------------------
-- Isolation, on the same terms as every other tenant table.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON org_roles TO salesdesk_app;

ALTER TABLE org_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_roles_isolation ON org_roles
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- The founding role is not editable, and this is the last line of that rule
-- rather than the first. The application refuses it too, but a bug there
-- would otherwise let a tenant lock itself out of its own organisation with
-- no way back in that does not involve us touching their database by hand.
-- ---------------------------------------------------------------------------
ALTER TABLE org_roles ADD CONSTRAINT org_roles_founding_immutable
  CHECK (key <> 'ORG_ADMIN');
