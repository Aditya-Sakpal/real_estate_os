-- ===========================================================================
--  0014_asset_versions  --  an asset is a thing with a history, not a file
--
--  0013 put the bytes' key on the asset row, which made replacing a file a
--  destructive act: the old object went, and with it any way of answering
--  "what did the approver actually see". An approval pins the content hash
--  precisely so that a changed file stops being approved, and that is only
--  half useful if the thing that was approved no longer exists.
--
--  So the identity and the bytes separate. `assets` keeps what the thing IS
--  (which node, which category, what it is called); `asset_versions` keeps
--  what it HAS BEEN. The newest version is the current one, and the older
--  ones stay with their approvals attached.
--
--  The approval mechanism needs no change at all, which is the point. It
--  already pins a sha256 rather than an asset, so uploading a new version
--  drops the asset out of `approvedAssets()` until somebody approves the new
--  bytes, and rolling back to an old version makes its original approval
--  apply again. That is the same behaviour the Brain's signatures have when
--  a group's values are put back.
--
--  COPYING BETWEEN NODES
--
--  A copy is a new asset with a new row and a new object, never a second
--  pointer at the same one. Two rows sharing a key means deleting either one
--  takes the other's bytes, and ref-counting that is a bug waiting to be
--  written. S3 copies server side, so the cost is a request rather than a
--  download and an upload.
--
--  Approvals deliberately do NOT travel with a copy. A clubhouse render
--  approved for one project is not thereby approved for a different
--  project's clubhouse, and an approval that survived being moved would make
--  "every pixel traces to a named human who approved it here" false the
--  first time anybody copied anything. `copied_from` records where it came
--  from, so the lineage is answerable without the permission travelling.
-- ===========================================================================

CREATE TABLE asset_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  asset_id     uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,

  -- Monotonic per asset, so "version 3" means something to a person reading
  -- an audit row two years later.
  version      integer NOT NULL,

  storage_key  text NOT NULL,
  media_type   text NOT NULL,
  media_name   text,
  media_bytes  bigint NOT NULL CHECK (media_bytes > 0),
  sha256       text NOT NULL CHECK (char_length(sha256) = 64),

  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (asset_id, version)
);

CREATE UNIQUE INDEX asset_versions_storage_key ON asset_versions (storage_key);
CREATE INDEX asset_versions_org_idx ON asset_versions (org_id);
CREATE INDEX asset_versions_asset_idx ON asset_versions (asset_id, version DESC);

-- Carry what 0013 stored on the asset into version 1 of that asset, so no
-- upload already made is lost or has to be redone.
INSERT INTO asset_versions
  (org_id, asset_id, version, storage_key, media_type, media_name, media_bytes, sha256, uploaded_by, uploaded_at)
SELECT org_id, id, 1, storage_key, media_type, media_name, media_bytes, sha256, uploaded_by, uploaded_at
FROM assets;

-- The bytes now live on the version. The asset keeps only what it is.
ALTER TABLE assets DROP COLUMN storage_key;
ALTER TABLE assets DROP COLUMN media_type;
ALTER TABLE assets DROP COLUMN media_name;
ALTER TABLE assets DROP COLUMN media_bytes;
ALTER TABLE assets DROP COLUMN sha256;

-- Where a copy came from. Nulled rather than cascaded on delete: losing the
-- original is not a reason to lose the copy, and a lineage that points at
-- nothing still says truthfully that this was copied from somewhere.
ALTER TABLE assets ADD COLUMN copied_from uuid REFERENCES assets(id) ON DELETE SET NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_versions TO salesdesk_app;

ALTER TABLE asset_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_versions_isolation ON asset_versions
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
