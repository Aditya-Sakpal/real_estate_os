-- ===========================================================================
--  0005_entity_details  --  the legal identity of an SPV
--
--  scope_nodes is a generic tree: id, kind, name, slug, path. Hanging
--  entity-only columns off it would leave a table of mostly-null fields once
--  projects and phases arrive wanting their own, so node-specific data gets
--  its own table keyed by the node. The RegistrationRecord that attaches to a
--  PHASE will follow the same shape.
--
--  Why these fields and not a document upload: nobody checks an uploaded
--  certificate. A CIN is the certificate of incorporation expressed as a
--  string that can be verified against the MCA register, and the PAN is the
--  tax identity that already dedupes orgs. Scans are evidence for a human
--  dispute, not an automated gate, and they need per-tenant encrypted storage
--  that does not exist yet.
-- ===========================================================================

CREATE TABLE entity_details (
  scope_node_id      uuid PRIMARY KEY REFERENCES scope_nodes(id) ON DELETE CASCADE,
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- Every registered entity has one. Validated with the same checksum-aware
  -- parser that guards org creation.
  pan                text NOT NULL,

  -- CIN for a company, LLPIN for an LLP. Nullable because a sole
  -- proprietorship or a partnership firm holds neither, and those do promote
  -- small projects.
  registration_no    text,
  registration_kind  text CHECK (registration_kind IN ('CIN', 'LLPIN')),

  registered_address text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Either both or neither: a number without its kind cannot be verified
  -- against the right MCA register.
  CONSTRAINT entity_details_registration_pair
    CHECK ((registration_no IS NULL) = (registration_kind IS NULL))
);

-- Two SPVs in one group cannot share a PAN; that would be the same legal
-- person twice.
CREATE UNIQUE INDEX entity_details_org_pan ON entity_details (org_id, pan);
CREATE UNIQUE INDEX entity_details_org_registration
  ON entity_details (org_id, registration_no) WHERE registration_no IS NOT NULL;
CREATE INDEX entity_details_org_idx ON entity_details (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_details TO salesdesk_app;

ALTER TABLE entity_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY entity_details_isolation ON entity_details
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
