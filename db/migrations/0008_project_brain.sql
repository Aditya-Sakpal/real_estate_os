-- ===========================================================================
--  0008_project_brain  --  the signed facts everything else quotes from
--
--  One object grounds the first reply, the voice qualifier, the CP bot, the
--  quote generator and the egress validator. If they each held their own copy
--  of the price, they would eventually disagree, and the one that is wrong is
--  the one that reaches a buyer.
--
--  Three rules are enforced here rather than in the application, because all
--  three are the kind that a later feature quietly breaks:
--
--    1. A DRAFT is invisible. Consumers read PUBLISHED and nothing else, so a
--       fact nobody signed can never be quoted. That is a query rule, kept in
--       `resolveBrain`, but the state column is what makes it expressible.
--
--    2. PUBLISHED is immutable. Not "we do not update it": the app role is
--       refused the write by a trigger. Editing a published fact would leave
--       a signature attesting to something that is no longer there.
--
--    3. One PUBLISHED version per node, and one DRAFT. Two live versions is
--       two answers to "what does this cost", which is the whole failure the
--       Brain exists to prevent.
--
--  Versions hang off ANY scope node, not just a phase. A price set on the
--  project applies to every tower under it until a tower says otherwise:
--  `resolveBrain` walks the ancestors and the deepest value wins. The phase is
--  where resolution is ASKED, because the phase carries the registration and
--  Section 3(1) bars advertising a phase that has none.
-- ===========================================================================

CREATE TABLE brain_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  -- Monotonic per node, so "version 3" means something to a person reading
  -- an audit row two years later.
  version        integer NOT NULL,

  state          text NOT NULL DEFAULT 'DRAFT'
                   CHECK (state IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),

  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at   timestamptz,
  superseded_at  timestamptz,

  -- PUBLISHED is a claim that somebody made it live, so it cannot be
  -- asserted without recording when.
  CONSTRAINT brain_published_has_a_date
    CHECK (state <> 'PUBLISHED' OR published_at IS NOT NULL)
);

CREATE UNIQUE INDEX brain_versions_node_version
  ON brain_versions (scope_node_id, version);
-- One working draft, and one live version. Both partial, so any number of
-- SUPERSEDED versions accumulate behind them as the history.
CREATE UNIQUE INDEX brain_versions_one_draft
  ON brain_versions (scope_node_id) WHERE state = 'DRAFT';
CREATE UNIQUE INDEX brain_versions_one_published
  ON brain_versions (scope_node_id) WHERE state = 'PUBLISHED';
CREATE INDEX brain_versions_org_idx ON brain_versions (org_id);

-- ---------------------------------------------------------------------------
-- The facts, one row per field, carrying where each one came from
-- ---------------------------------------------------------------------------
CREATE TABLE brain_fields (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_version_id  uuid NOT NULL REFERENCES brain_versions(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- A key from the catalog in `brain-rules.ts`. Kept in code for the same
  -- reason the permission catalog is: a field nothing reads means nothing.
  field_key         text NOT NULL,
  value             text,

  -- Provenance. Typed in by hand today, so these stay NULL; the extractors
  -- fill them, and a field with a source can be shown to whoever signs it.
  source_asset      text,
  source_page       integer,
  source_bbox       text,
  extractor         text,
  model_version     text,
  confidence        numeric(4, 3)
                      CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (brain_version_id, field_key)
);

CREATE INDEX brain_fields_org_idx ON brain_fields (org_id);

-- ---------------------------------------------------------------------------
-- Signatures, one per field group, pinned to what was in front of the signer
-- ---------------------------------------------------------------------------
CREATE TABLE brain_signatures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_version_id  uuid NOT NULL REFERENCES brain_versions(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  field_group       text NOT NULL CHECK (field_group IN ('PRICE', 'RERA', 'CLAIMS')),

  -- The hash of that group's values at the moment of signing. An edit
  -- afterwards changes the hash, the signature stops matching, and the group
  -- needs signing again. This is what "signatures follow the diff" means: a
  -- signature is a statement about specific values, not about a version.
  group_hash        text NOT NULL,

  -- ON DELETE SET NULL, like every other attribution column here, and for the
  -- reason 0004 records: NO ACTION made every admin undeletable, because a
  -- person who had ever done anything could not be removed. A signer is no
  -- different.
  --
  -- Accountability does not rest on this column anyway. Erasure SCRUBS rather
  -- than deletes, so in practice the row and its id survive with the name
  -- nulled; and `audit_log` holds a `brain.signed` entry naming the actor and
  -- the exact hash, which outlives the signature row itself.
  signed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  signed_at         timestamptz NOT NULL DEFAULT now(),

  -- Unique on the HASH, not on the group. Signatures accumulate the way audit
  -- rows do: editing a signed group does not erase the signature, it leaves
  -- it attached to values that are no longer current, and signing again adds
  -- a row. Which signature counts is then a question with an exact answer,
  -- the one whose hash matches what is there now, rather than "the newest".
  --
  -- It also makes the honest thing happen when a group is edited and put
  -- back: the original signature applies again, because that person really
  -- did sign exactly these values.
  UNIQUE (brain_version_id, field_group, group_hash)
);

CREATE INDEX brain_signatures_org_idx ON brain_signatures (org_id);

-- ---------------------------------------------------------------------------
-- Immutability, in the database rather than by convention
-- ---------------------------------------------------------------------------
--
-- A published fact cannot be edited and a published version cannot be
-- reopened. Without this the application is the only thing standing between a
-- signature and the values it attests to, and the application is exactly what
-- changes every week.
CREATE OR REPLACE FUNCTION brain_refuse_published_write() RETURNS trigger AS $$
DECLARE
  v_state text;
BEGIN
  SELECT state INTO v_state FROM brain_versions
   WHERE id = COALESCE(NEW.brain_version_id, OLD.brain_version_id);

  -- No parent means the version itself is being deleted and this row is
  -- going with it. Refusing here would make a cascade impossible, which
  -- would mean an organisation that can never be deleted: the rule is that
  -- a published fact cannot be EDITED, not that a tenant is permanent.
  IF v_state IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_state <> 'DRAFT' THEN
    RAISE EXCEPTION
      'brain version is % and cannot be edited; open a new draft', v_state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brain_fields_only_in_draft
  BEFORE INSERT OR UPDATE OR DELETE ON brain_fields
  FOR EACH ROW EXECUTE FUNCTION brain_refuse_published_write();

-- The state machine: DRAFT becomes PUBLISHED, PUBLISHED becomes SUPERSEDED,
-- and nothing ever goes backwards. A published version reopened as a draft
-- would carry its signatures with it.
CREATE OR REPLACE FUNCTION brain_state_forward_only() RETURNS trigger AS $$
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'DRAFT' AND NEW.state = 'PUBLISHED' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'PUBLISHED' AND NEW.state = 'SUPERSEDED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a brain version cannot go from % to %', OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brain_versions_forward_only
  BEFORE UPDATE ON brain_versions
  FOR EACH ROW EXECUTE FUNCTION brain_state_forward_only();

-- A signature is a record of somebody putting their name to a number. It is
-- withdrawn by superseding the version, never by deleting the row.
CREATE OR REPLACE FUNCTION brain_signatures_append_only() RETURNS trigger AS $$
BEGIN
  -- Same exemption as above, and for the same reason: a signature going away
  -- because the version it signed is going away is a cascade, not a rewrite.
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM brain_versions WHERE id = OLD.brain_version_id)
  THEN
    RETURN OLD;
  END IF;

  -- Erasure. `signed_by` is ON DELETE SET NULL, and SET NULL is an UPDATE, so
  -- a blanket refusal here would make a signer undeletable and reintroduce
  -- exactly the bug 0004 fixed. Permitted for that one column moving to NULL
  -- and nothing else, so it cannot be used to reassign a signature: what the
  -- signature attests to, and when, stay exactly as they were.
  IF TG_OP = 'UPDATE'
     AND NEW.signed_by IS NULL
     AND OLD.signed_by IS NOT NULL
     AND NEW.id               = OLD.id
     AND NEW.brain_version_id = OLD.brain_version_id
     AND NEW.org_id           = OLD.org_id
     AND NEW.field_group      = OLD.field_group
     AND NEW.group_hash       = OLD.group_hash
     AND NEW.signed_at        = OLD.signed_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a signature cannot be changed or removed'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brain_signatures_no_rewrite
  BEFORE UPDATE OR DELETE ON brain_signatures
  FOR EACH ROW EXECUTE FUNCTION brain_signatures_append_only();

-- ---------------------------------------------------------------------------
-- Isolation, on the same terms as every other tenant table.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON brain_versions   TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON brain_fields     TO salesdesk_app;
-- No UPDATE, no DELETE. The trigger above refuses them anyway; withholding
-- the grant means the refusal does not depend on a trigger surviving.
GRANT SELECT, INSERT                 ON brain_signatures TO salesdesk_app;

ALTER TABLE brain_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_versions_isolation ON brain_versions
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE brain_fields ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_fields_isolation ON brain_fields
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE brain_signatures ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_signatures_isolation ON brain_signatures
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
