-- ===========================================================================
--  0006_rera  --  registration at the phase, exemption at the project
--
--  Under the explanation to Section 3 each PHASE is a standalone
--  registration, with its own number and its own expiry. Tower D lapsing must
--  not stop Tower C advertising, so the record hangs off the phase node and
--  nothing above it.
--
--  Exemption is the other half, and it sits one level UP. Section 3(2)(a)
--  measures land and apartment count ACROSS ALL PHASES, which is what stops a
--  promoter slicing a project into small phases to slip under the threshold.
--  So it is attested once on the PROJECT, by a named compliance officer, and
--  inherited by every phase beneath it.
--
--  Three states, no fourth. BLOCKED is the default at creation and where
--  every failure lands, including a lookup that has not happened yet. There
--  is no "probably fine".
-- ===========================================================================

CREATE TABLE registration_records (
  scope_node_id     uuid PRIMARY KEY REFERENCES scope_nodes(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  status            text NOT NULL DEFAULT 'BLOCKED'
                      CHECK (status IN ('VERIFIED', 'EXEMPT', 'BLOCKED')),

  registration_no   text,
  state_code        text,

  -- The promoter name as it reads on the portal. Verification is this
  -- matching the ENTITY's legal name after normalisation, which is why the
  -- entity form insists on the registered name rather than the brand.
  promoter_name     text,

  valid_from        date,
  valid_to          date,

  verified_at       timestamptz,
  -- Set by the daily re-verification job, which does not exist yet. A record
  -- that has never been checked against the portal says so by holding NULL
  -- here rather than by looking verified.
  last_checked_at   timestamptz,

  -- A human resolution records who and why, because an automated exact match
  -- is the only thing that should ever pass silently.
  resolved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_reason text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- VERIFIED is a claim about a specific registration, so it cannot be
  -- asserted without one.
  CONSTRAINT registration_verified_needs_number
    CHECK (status <> 'VERIFIED' OR (registration_no IS NOT NULL AND valid_to IS NOT NULL))
);

CREATE INDEX registration_records_org_idx ON registration_records (org_id);
CREATE INDEX registration_records_expiry_idx ON registration_records (valid_to)
  WHERE status = 'VERIFIED';
CREATE UNIQUE INDEX registration_records_org_no
  ON registration_records (org_id, registration_no) WHERE registration_no IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Exemption, attested on the PROJECT and inherited by its phases
-- ---------------------------------------------------------------------------
CREATE TABLE project_exemptions (
  scope_node_id    uuid PRIMARY KEY REFERENCES scope_nodes(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- The two Section 3(2)(a) measures, across all phases.
  land_area_sqm    numeric(10, 2) NOT NULL,
  apartment_count  integer NOT NULL,
  state_code       text NOT NULL,

  -- A named officer, not the system. Their id is the accountability.
  attested_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  attested_at      timestamptz NOT NULL DEFAULT now(),
  -- 90 days from attestation. An exemption that never expires is an
  -- exemption nobody revisits when the plan grows.
  expires_at       timestamptz NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT project_exemptions_positive
    CHECK (land_area_sqm >= 0 AND apartment_count >= 0)
);

CREATE INDEX project_exemptions_org_idx ON project_exemptions (org_id);
CREATE INDEX project_exemptions_expiry_idx ON project_exemptions (expires_at);

-- ---------------------------------------------------------------------------
-- Isolation, on the same terms as every other tenant table.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON registration_records TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_exemptions TO salesdesk_app;

ALTER TABLE registration_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY registration_records_isolation ON registration_records
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE project_exemptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_exemptions_isolation ON project_exemptions
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
