-- ===========================================================================
--  0017_unit_types  --  a developer sells configurations, not towers
--
--  Twenty three tables and not one of them knew that a 1 BHK and a 2 BHK in
--  the same tower are different products at different prices. Two things
--  followed, and both are Section 12 exposure rather than untidiness.
--
--  An advertisement for the 1 BHK could carry the 2 BHK's living room, and
--  nothing refused it, because a render hangs off the tower and the tower is
--  as specific as the library could get. `asset-rules.ts` has carried the
--  sentence "one tower's 3 BHK is not another's" since 0013, which is the
--  right rule noticed and given nowhere to live.
--
--  Worse, the Brain holds ONE price per node. So "2 BHK from Rs 48 lakh" is
--  cleared by the copy gate whenever Rs 48 lakh is a signed price anywhere on
--  that tower, including when it is the 1 BHK's. The money check was real and
--  the thing it measured against was too coarse to catch the ordinary case.
--
--  WHAT A UNIT TYPE IS, AND IS NOT
--
--  It is a product: a configuration, its carpet area, and the price it starts
--  at. It is NOT an individual flat. A-1203 with its floor, its facing and
--  its sold-or-available flag is inventory: it changes hourly, it arrives
--  from the CRM by diff sync, and it never appears in an advertisement,
--  because "only four left" is true for about an hour. Section 06 already
--  draws that line, calling the slow facts signed and the unit rows fast.
--  This table is on the slow side of it.
--
--  PINNED TO A PHASE
--
--  A configuration is a product inside one tower, which is why floor plans
--  were already pinned to a phase. Two towers selling the same 2 BHK are two
--  rows, and `copyUnitTypesTo()` puts one on the other, the way
--  `copyAssetsTo()` does for assets and with the same refusal to carry an
--  approval across.
--
--  IDENTITY AND NUMBERS SEPARATE, THE WAY 0014 SPLIT THEM FOR ASSETS
--
--  `unit_types` is what the thing IS: which tower, which configuration.
--  `unit_type_versions` is what it HAS BEEN: the areas and the price, one row
--  per revision, newest in force. A price rise in March does not erase what
--  January's advertisement was cleared against, which is the whole reason
--  `campaign_copy.ground` records the ground a verdict was reached on.
--
--  The approval pins a HASH of the values rather than a version id, so a
--  revision that puts the old numbers back lands already approved: that
--  person really did approve exactly those numbers. It is the mechanism
--  `brain_signatures` and `asset_approvals` both use, for the third time,
--  deliberately.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The identity
-- ---------------------------------------------------------------------------
CREATE TABLE unit_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- A PHASE, enforced in `canAddUnitType()` rather than here, because the
  -- node kind lives on `scope_nodes` and a CHECK cannot read another table.
  -- The same arrangement `canUploadAsset()` has for floor plans.
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  -- From the catalog in `unit-rules.ts`, in code for the reason the asset
  -- categories and the permission keys are: free text here means "2BHK",
  -- "2 bhk" and "Two BHK" are three products the gate cannot compare.
  config         text NOT NULL,

  -- Optional, and ordinary. Two 2 BHKs in one tower at different carpet
  -- areas is how most towers are actually sold, and "Optima" is the only
  -- thing that tells them apart on a price list.
  variant        text,

  -- Where a copy came from. Nulled rather than cascaded, like `assets`: the
  -- original going does not make the copy untrue about having been copied.
  copied_from    uuid REFERENCES unit_types(id) ON DELETE SET NULL,

  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT unit_types_variant_shape
    CHECK (variant IS NULL OR length(btrim(variant)) > 0)
);

-- One 2 BHK Optima per tower. `coalesce` rather than a plain UNIQUE because
-- NULL is distinct from NULL in Postgres, so the unnamed variant would be
-- insertable any number of times.
CREATE UNIQUE INDEX unit_types_one_per_node
  ON unit_types (scope_node_id, config, coalesce(btrim(variant), ''));
CREATE INDEX unit_types_org_idx ON unit_types (org_id);

-- ---------------------------------------------------------------------------
-- The numbers, versioned
-- ---------------------------------------------------------------------------
CREATE TABLE unit_type_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  unit_type_id       uuid NOT NULL REFERENCES unit_types(id) ON DELETE CASCADE,

  -- Monotonic per unit type, so "version 3" means something to a person
  -- reading an audit row two years later.
  version            integer NOT NULL,

  -- RERA measures in carpet area and the model agreement is written in it,
  -- so this is the figure that may appear on an advertisement. Super built-up
  -- is deliberately absent: a column that exists gets printed.
  carpet_area_sqft   numeric(10, 2) NOT NULL CHECK (carpet_area_sqft > 0),

  -- Never added into the carpet figure, which is the whole reason it is its
  -- own column rather than a note somebody types into the area.
  balcony_area_sqft  numeric(10, 2) CHECK (balcony_area_sqft IS NULL OR balcony_area_sqft >= 0),

  -- Left empty it is computed as carpet area times the phase's signed rate
  -- per sq ft, so the one number that is already signed stays the source and
  -- nobody retypes it. Set, it overrides, because a corner 2 BHK really is
  -- priced differently and pretending otherwise puts the wrong figure on a
  -- hoarding.
  starting_price     numeric(14, 2) CHECK (starting_price IS NULL OR starting_price > 0),

  -- The hash of the values a person was looking at. Covers the configuration
  -- and the variant as well as the numbers, so that if an edit path for those
  -- is ever added, every approval stops matching rather than silently
  -- carrying over onto a different product.
  sha256             text NOT NULL CHECK (char_length(sha256) = 64),

  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (unit_type_id, version)
);

CREATE INDEX unit_type_versions_org_idx ON unit_type_versions (org_id);
CREATE INDEX unit_type_versions_current_idx
  ON unit_type_versions (unit_type_id, version DESC);

-- ---------------------------------------------------------------------------
-- The approvals
-- ---------------------------------------------------------------------------
--
-- A carpet area and a starting price are both claims a buyer acts on, so
-- neither reaches an advertisement because somebody typed it. Approving is
-- `brain.price:approve` rather than a fourth approve key: the number this
-- produces is a price, and the point of splitting the Brain's signatures
-- three ways was that one person owns prices.
CREATE TABLE unit_type_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  unit_type_id  uuid NOT NULL REFERENCES unit_types(id) ON DELETE CASCADE,

  -- What was approved. Not the version id: the values.
  sha256        text NOT NULL CHECK (char_length(sha256) = 64),

  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (unit_type_id, sha256, approved_by)
);

CREATE INDEX unit_type_approvals_idx ON unit_type_approvals (unit_type_id, sha256);
CREATE INDEX unit_type_approvals_org_idx ON unit_type_approvals (org_id);

CREATE OR REPLACE FUNCTION unit_type_approvals_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'unit_type_approvals is append only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER unit_type_approvals_no_update
  BEFORE UPDATE ON unit_type_approvals
  FOR EACH ROW EXECUTE FUNCTION unit_type_approvals_append_only();

-- ---------------------------------------------------------------------------
-- What connects to it
-- ---------------------------------------------------------------------------

-- Which configuration this depicts, and which room of it. Empty means the
-- whole tower, which is right for an exterior render and wrong for a bedroom.
--
-- RESTRICT, not SET NULL. Nulling would silently turn "the 2 BHK bedroom"
-- into "some bedroom in this tower", which is the exact confusion this table
-- exists to end. Deleting a configuration that pictures point at is refused,
-- the way deleting a role somebody still holds is refused.
ALTER TABLE assets
  ADD COLUMN unit_type_id uuid REFERENCES unit_types(id) ON DELETE RESTRICT;

-- From the catalog in `asset-rules.ts`. A column rather than eight new
-- categories, because nothing about the compliance behaviour changes between
-- a bedroom and a kitchen: same disclaimer, same level, same approval.
ALTER TABLE assets ADD COLUMN room text;

CREATE INDEX assets_unit_type_idx ON assets (unit_type_id);

-- Which configurations one push is for. Empty means the whole tower, which is
-- what every brief written so far meant. No foreign key is possible on an
-- array, so the studio reads the ids back through `withTenant()` and keeps
-- only the ones that resolve, the same rule invites apply to a node id
-- arriving from a form.
ALTER TABLE campaign_briefs
  ADD COLUMN unit_type_ids uuid[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON unit_types TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON unit_type_versions TO salesdesk_app;
-- No UPDATE. The trigger refuses it anyway; withholding the grant means the
-- refusal happens before a statement is planned.
GRANT SELECT, INSERT, DELETE ON unit_type_approvals TO salesdesk_app;

ALTER TABLE unit_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY unit_types_isolation ON unit_types
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE unit_type_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY unit_type_versions_isolation ON unit_type_versions
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE unit_type_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY unit_type_approvals_isolation ON unit_type_approvals
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
