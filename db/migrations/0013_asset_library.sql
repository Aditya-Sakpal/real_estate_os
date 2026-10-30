-- ===========================================================================
--  0013_asset_library  --  the Approved Asset Library
--
--  Section 08 sets the rule this table exists to enforce:
--
--    "The AI never originates the property. It assembles, adapts, localises
--     and validates approved assets. Every pixel of the building traces to an
--     asset a named human approved, versioned and timestamped."
--
--    "No approval row, no render, enforced by foreign key."
--
--  So this is not an upload table with a bigger size limit. An asset nobody
--  approved has to be structurally incapable of reaching a creative, which
--  means the approval is a row the renderer joins to rather than a boolean
--  somebody can flip.
--
--  Under Section 12 a buyer who paid on a misleading advertisement withdraws
--  with refund, interest and compensation. A render showing a clubhouse that
--  was never built is that exposure, and "who approved this image" has to be
--  answerable two years later by name and date without anybody's memory.
--
--  HOW IT DIFFERS FROM WHAT IS ALREADY HERE
--
--    campaign_references  inspiration. Never rendered into an ad. No approval.
--    brand_files          the developer's own marks. Identity, not property.
--    assets (here)        source material. Every pixel traces to an approval.
--
--  WHERE THE BYTES LIVE
--
--  Not in the row. This is the first table to hold a storage KEY instead,
--  because dozens of renders per project at several megabytes each is what
--  finally breaks bytes-in-a-row. A key and not a URL: a URL that works in a
--  browser works for anyone holding it forever, with no sign-in and no audit,
--  which would undo the isolation every other table rests on. The bucket is
--  private and a reader who has passed the permission check is handed a link
--  that expires in five minutes.
--
--  WHERE AN ASSET HANGS
--
--  On the node it depicts, resolved downward like the Brain's facts, with one
--  difference that matters: assets are a UNION down the chain, not an
--  override. Tower C having its own elevation must not hide the township
--  masterplan. Two categories never inherit at all, and both are pinned to a
--  PHASE because sharing them is a misrepresentation rather than a
--  convenience: a QR lockup belongs to one registration, and a progress photo
--  of the 18th slab is not the tower that is on its 4th.
-- ===========================================================================

CREATE TABLE assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- The node this depicts. A site plan on the project, a floor plan on the
  -- phase, and resolution walks upward from wherever a creative is built.
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  -- From the catalog in `asset-rules.ts`, in code for the same reason the
  -- permission catalog is: the generator picks assets by what they depict,
  -- and a category nothing can select is a category nobody should be offered.
  category       text NOT NULL,

  title          text,

  -- Photograph or render, and it is not a judgement made at render time.
  -- Section 08's pixel gate requires the artist's impression disclaimer
  -- wherever provenance says render, so the flag has to be on the asset.
  is_render      boolean NOT NULL DEFAULT true,

  -- Where the bytes are. `org/<org_id>/asset/<id>`, never a URL.
  storage_key    text NOT NULL,
  media_type     text NOT NULL,
  media_name     text,
  media_bytes    bigint NOT NULL CHECK (media_bytes > 0),

  -- What was stored, so an approval can pin it. Replace the file and the hash
  -- changes, the approval stops matching, and it needs approving again. The
  -- same mechanism the Brain's signatures use, and for the same reason.
  sha256         text NOT NULL CHECK (char_length(sha256) = 64),

  -- A construction photo is only true of the day it was taken. Advertising a
  -- six month old slab as current is its own Section 12 problem, so the date
  -- is recorded rather than inferred from when somebody got round to
  -- uploading it.
  captured_on    date,

  uploaded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assets_titled CHECK (title IS NULL OR length(btrim(title)) > 0)
);

CREATE INDEX assets_node_idx ON assets (scope_node_id, category);
CREATE INDEX assets_org_idx ON assets (org_id);
CREATE UNIQUE INDEX assets_storage_key ON assets (storage_key);

-- ---------------------------------------------------------------------------
-- The approvals
-- ---------------------------------------------------------------------------
--
-- Append only, and pinned to the asset's content hash rather than to the
-- asset. That is what makes "every pixel traces to an approval" true rather
-- than aspirational: swap the file and the approval no longer matches what is
-- there, so nothing built from it can claim to have been approved.
--
-- A separate table rather than a column, because a column can be written by
-- anything holding the row, and because an approval that was later withdrawn
-- still has to be answerable. Its own row with its own timestamp is the only
-- shape that survives the question "who said this was fine, and when".
CREATE TABLE asset_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  asset_id     uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,

  -- What was approved. Not the asset id: the bytes.
  sha256       text NOT NULL CHECK (char_length(sha256) = 64),

  -- ON DELETE SET NULL like every other attribution column here, and for the
  -- reason 0004 records: NO ACTION made every admin undeletable. Erasure
  -- scrubs rather than deletes, so the row and its id survive with the name
  -- nulled, and `audit_log` holds the entry naming the actor and the hash.
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at  timestamptz NOT NULL DEFAULT now(),

  -- One approval per person per version of the bytes. Approving twice is one
  -- act happening twice.
  UNIQUE (asset_id, sha256, approved_by)
);

CREATE INDEX asset_approvals_asset_idx ON asset_approvals (asset_id, sha256);
CREATE INDEX asset_approvals_org_idx ON asset_approvals (org_id);

-- Append only for the application, the same arrangement `brain_signatures`
-- and `audit_log` have. An approval that can be edited is a signature that
-- can be forged, and withdrawing one is a delete rather than a rewrite.
CREATE OR REPLACE FUNCTION asset_approvals_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'asset_approvals is append only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asset_approvals_no_update
  BEFORE UPDATE ON asset_approvals
  FOR EACH ROW EXECUTE FUNCTION asset_approvals_append_only();

GRANT SELECT, INSERT, UPDATE, DELETE ON assets TO salesdesk_app;
-- No UPDATE. The trigger above refuses it anyway; withholding the grant means
-- the refusal happens before a statement is even planned.
GRANT SELECT, INSERT, DELETE ON asset_approvals TO salesdesk_app;

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY assets_isolation ON assets
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE asset_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_approvals_isolation ON asset_approvals
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
