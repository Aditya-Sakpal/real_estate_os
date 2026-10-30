-- ===========================================================================
--  0012_brand_kit  --  who the developer is, said once
--
--  Every creative carries the same handful of facts: the logo, the tagline,
--  the phone number a buyer rings, the disclaimer at the foot. They do not
--  change between campaigns and they do not change between towers, so asking
--  for them per campaign is asking sixty times for one answer.
--
--  Keyed by scope_node_id and resolved down the tree, the way the Brain
--  resolves facts. Set it on the ORG root and every project and phase under
--  it inherits. A group running two brands under one tenant overrides at the
--  ENTITY that owns the second, and only that subtree changes.
--
--  What is NOT here, because it already exists and a second copy is a second
--  thing to disagree with the first:
--
--    orgs.legal_name        the developer's registered name
--    orgs.display_name      the brand short form
--    the ENTITY node's name the RERA promoter of record
--    entity_details         PAN, CIN, and the registered address
--
--  The registered address is a CA's office more often than not, which is why
--  `office_address` here is a separate field: it is where a buyer is being
--  invited to walk in.
--
--  Contact details are not decoration. MahaRERA requires the registration
--  lockup at a font size at least as large as the largest contact detail on
--  the creative, so the pixel gate in section 08 measures one against the
--  other. It cannot do that without knowing what they are.
-- ===========================================================================

CREATE TABLE brand_kits (
  scope_node_id     uuid PRIMARY KEY REFERENCES scope_nodes(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- A line that gets printed, which makes it a claim. Whether it belongs
  -- behind the brand approver in the Brain's claims group rather than here
  -- is an open question; it sits here for now because it is identity before
  -- it is a promise.
  tagline           text,

  colour_primary    text,
  colour_accent     text,

  -- The brand face, and which scripts it can actually set. A Latin-only font
  -- cannot render Marathi or Tamil, and a campaign brief that asks for eight
  -- languages against a font covering one renders seven of them as boxes.
  typeface_name     text,
  typeface_scripts  text[] NOT NULL DEFAULT '{}',

  -- The layout adapter needs a floor and a margin. Without them a logo ends
  -- up twelve pixels tall in a 9:16 story and nobody notices until it is
  -- printed. Clear space is a multiple of the logo's own height, which is how
  -- every brand guideline in the world states it.
  logo_min_px       integer
                      CHECK (logo_min_px IS NULL OR logo_min_px BETWEEN 8 AND 600),
  logo_clear_ratio  numeric(3, 2)
                      CHECK (logo_clear_ratio IS NULL OR logo_clear_ratio BETWEEN 0 AND 4),

  sales_phone       text,
  sales_email       text,
  website           text,

  -- Where a buyer is invited to come, which is rarely the registered office.
  office_address    text,

  -- Stored as full URLs after normalisation, never as raw handles: a handle
  -- has to be turned into a link to be printed or clicked, and doing that
  -- once here beats doing it in every surface that renders one.
  instagram_url     text,
  facebook_url      text,
  youtube_url       text,

  -- The boilerplate every creative carries. "Artist's impression", the RERA
  -- line, terms and conditions. Written once rather than retyped per ad.
  disclaimer        text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX brand_kits_org_idx ON brand_kits (org_id);

-- ---------------------------------------------------------------------------
-- The files, one per role per node
-- ---------------------------------------------------------------------------
--
-- Four roles rather than one logo, because one logo cannot do the job. A
-- horizontal lockup does not sit in a 9:16 story, and a full-colour mark
-- disappears on a photograph. The formats a brief can ask for run 1:1, 9:16,
-- 16:9 and hoarding, and the layout adapter picks by shape.
--
-- Bytes in the row, like reference media and for the same reasons: there is
-- no object storage yet, and in this column the RLS policy that guards every
-- other table guards these too. The cap is 5 MB, which is generous for a
-- logo and enough for a font. When the Asset Library arrives with real
-- storage, `media` becomes a key here as well.
CREATE TABLE brand_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  role          text NOT NULL CHECK (role IN
                  ('LOGO_HORIZONTAL', 'LOGO_STACKED', 'LOGO_MONO', 'TYPEFACE')),

  media         bytea NOT NULL,
  media_type    text NOT NULL,
  media_name    text,

  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brand_files_size CHECK (octet_length(media) <= 5242880)
);

-- One file per role per node. Replacing a logo is an upsert, not a second
-- row: two horizontal logos on one node is two answers to which mark is ours.
CREATE UNIQUE INDEX brand_files_node_role ON brand_files (scope_node_id, role);
CREATE INDEX brand_files_org_idx ON brand_files (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON brand_kits TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON brand_files TO salesdesk_app;

ALTER TABLE brand_kits ENABLE ROW LEVEL SECURITY;
CREATE POLICY brand_kits_isolation ON brand_kits
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE brand_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY brand_files_isolation ON brand_files
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
