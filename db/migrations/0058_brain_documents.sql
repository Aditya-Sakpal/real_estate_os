-- ---------------------------------------------------------------------------
-- 0058  The Project Brain's documents, and what was read from them
-- ---------------------------------------------------------------------------
--
-- A developer already holds every fact the Brain asks for, in PDFs: the RERA
-- certificate, the price list, the payment plan, the brochure. Typing them
-- in again is slow and is where a digit goes missing. So a document is
-- uploaded, read, and what it says is PROPOSED to the draft with the page
-- and the place on the page it came from.
--
-- Three rules are kept here rather than in the application.
--
--   1. The bytes are content-addressed. `sha256` is unique per organisation,
--      so the same file uploaded twice is one row, and the object's key is
--      the hash, so the file behind a row can never change.
--
--   2. A proposal is a record, not a working copy. Its value, its quote and
--      its place on the page are never rewritten, and its state moves
--      forward only: PROPOSED is decided (ACCEPTED, CORRECTED, REJECTED) or
--      replaced by a later reading of the same document (SUPERSEDED). A
--      reading again is new rows beside the old ones, never an overwrite.
--
--   3. A document a value was taken from stays. Once a person accepted or
--      corrected anything it said, it is the evidence behind a fact that may
--      already be on an advertisement, so removing it is refused.
--
-- None of this reaches PUBLISHED. What is read lands in a DRAFT at most, and
-- a draft is invisible to every consumer (0008).

CREATE TABLE brain_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'RERA_CERTIFICATE', 'AGREEMENT', 'PRICE_LIST', 'PAYMENT_PLAN',
                   'BROCHURE', 'AMENITIES', 'FLOOR_PLANS', 'SPECIFICATIONS', 'LOCATION')),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The key, never a URL (see storage.ts): org/<org_id>/doc/<sha256>.
  storage_key    text NOT NULL,
  media_type     text NOT NULL CHECK (media_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  bytes          bigint NOT NULL CHECK (bytes > 0 AND bytes <= 62914560),
  pages          integer NOT NULL CHECK (pages BETWEEN 1 AND 500),
  -- What was read off each page, kept so reading again pays only for the
  -- model and never for the reading. Filled page by page, so a reading cut
  -- short resumes where it stopped.
  layout         jsonb,
  -- Pictures of pages already drawn for the review screen: page -> key.
  previews       jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, sha256),
  CONSTRAINT brain_documents_key_is_the_hash
    CHECK (storage_key = 'org/' || org_id::text || '/doc/' || sha256)
);

CREATE INDEX brain_documents_node_idx ON brain_documents (org_id, scope_node_id);

-- ---------------------------------------------------------------------------
-- One reading of one document
-- ---------------------------------------------------------------------------
CREATE TABLE brain_extractions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id    uuid NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  extractor      text NOT NULL,
  state          text NOT NULL DEFAULT 'QUEUED'
                   CHECK (state IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
  -- What it is doing now, for the screen: reading the pages, or asking.
  stage          text CHECK (stage IS NULL OR stage IN ('READING', 'ASKING', 'WRITING')),
  pages_done     integer NOT NULL DEFAULT 0,
  requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Claimed under a lease, the post_runs pattern: a worker that dies leaves
  -- a lease that expires, and three tries is the end of it.
  lease_until    timestamptz,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  -- The meter for this document: every model call it made and what it cost.
  model          text,
  model_version  text,
  calls          integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  tokens_in      integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out     integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cost_usd       numeric(10, 5) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  pages_read     integer NOT NULL DEFAULT 0,
  ocr_pages      integer NOT NULL DEFAULT 0,
  found          integer NOT NULL DEFAULT 0,
  dropped        integer NOT NULL DEFAULT 0,
  -- The flats a price list or a floor plan lists, each with its page and
  -- place. Compared against the tower's unit types; written nowhere else.
  units          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- A code and a sentence we wrote. Never anything a person typed.
  error_code     text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

-- One live reading per document: a second press is the first one, twice.
CREATE UNIQUE INDEX brain_extractions_one_live
  ON brain_extractions (document_id) WHERE state IN ('QUEUED', 'RUNNING');
CREATE INDEX brain_extractions_org_day ON brain_extractions (org_id, created_at);
CREATE INDEX brain_extractions_due ON brain_extractions (state, lease_until)
  WHERE state IN ('QUEUED', 'RUNNING');

-- ---------------------------------------------------------------------------
-- What a reading found, one fact (or one line of a list) a row
-- ---------------------------------------------------------------------------
CREATE TABLE brain_proposals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  extraction_id    uuid NOT NULL REFERENCES brain_extractions(id) ON DELETE CASCADE,
  document_id      uuid NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
  scope_node_id    uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  -- The draft it was measured against, and written into when `in_draft`.
  brain_version_id uuid REFERENCES brain_versions(id) ON DELETE CASCADE,
  field_key        text NOT NULL,
  value            text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 2000),
  -- The words on the page the value was read from. No span, no value.
  quote            text NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 1000),
  page             integer NOT NULL CHECK (page >= 1),
  -- {x, y, w, h} as fractions of the page, so it draws at any size.
  bbox             jsonb NOT NULL,
  confidence       numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extractor        text NOT NULL,
  model_version    text NOT NULL,
  -- True when the draft's field was empty and this value was put in it.
  -- Such a value is not signable until a person decides it.
  in_draft         boolean NOT NULL DEFAULT false,
  state            text NOT NULL DEFAULT 'PROPOSED' CHECK (state IN (
                     'PROPOSED', 'MATCHED', 'ACCEPTED', 'CORRECTED', 'REJECTED', 'SUPERSEDED')),
  corrected_value  text CHECK (corrected_value IS NULL OR char_length(corrected_value) <= 2000),
  decided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brain_proposals_correction_has_a_value
    CHECK (state <> 'CORRECTED' OR corrected_value IS NOT NULL),
  CONSTRAINT brain_proposals_decision_has_a_date
    CHECK (state NOT IN ('ACCEPTED', 'CORRECTED', 'REJECTED') OR decided_at IS NOT NULL)
);

CREATE INDEX brain_proposals_node_idx ON brain_proposals (org_id, scope_node_id, state);
CREATE INDEX brain_proposals_version_idx ON brain_proposals (brain_version_id) WHERE state = 'PROPOSED';
CREATE INDEX brain_proposals_document_idx ON brain_proposals (document_id);

-- A proposal moves forward only, and what it says is never rewritten.
CREATE FUNCTION brain_proposals_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.value IS DISTINCT FROM OLD.value
     OR NEW.quote IS DISTINCT FROM OLD.quote
     OR NEW.page IS DISTINCT FROM OLD.page
     OR NEW.bbox IS DISTINCT FROM OLD.bbox
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.field_key IS DISTINCT FROM OLD.field_key
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.extraction_id IS DISTINCT FROM OLD.extraction_id
     OR NEW.in_draft IS DISTINCT FROM OLD.in_draft THEN
    RAISE EXCEPTION 'What a document said is not rewritten' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = NEW.state THEN
    -- Erasure only: `decided_by` going to NULL, and nothing else about it.
    IF NEW.decided_by IS NULL AND OLD.decided_by IS NOT NULL
       AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
       AND NEW.corrected_value IS NOT DISTINCT FROM OLD.corrected_value THEN
      RETURN NEW;
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A decided proposal is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'PROPOSED' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'MATCHED' AND NEW.state = 'SUPERSEDED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A proposal moves forward only: % to %', OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER brain_proposals_forward BEFORE UPDATE ON brain_proposals
  FOR EACH ROW EXECUTE FUNCTION brain_proposals_forward();

-- A document a value was taken from stays. A cascade (its tower or its
-- organisation going) is not a removal and passes.
CREATE OR REPLACE FUNCTION brain_documents_keep_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scope_nodes WHERE id = OLD.scope_node_id)
     OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM brain_proposals
    WHERE document_id = OLD.id AND state IN ('ACCEPTED', 'CORRECTED')
  ) THEN
    RAISE EXCEPTION 'A document a value was taken from is kept' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER brain_documents_keep_evidence BEFORE DELETE ON brain_documents
  FOR EACH ROW EXECUTE FUNCTION brain_documents_keep_evidence();

-- ---------------------------------------------------------------------------
-- Grants. What was uploaded, and what it said, is never rewritten by the app.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, DELETE ON brain_documents TO salesdesk_app;
GRANT UPDATE (layout, previews) ON brain_documents TO salesdesk_app;
GRANT SELECT, INSERT ON brain_extractions TO salesdesk_app;
GRANT UPDATE (state, stage, pages_done, lease_until, attempts, model, model_version, calls,
              tokens_in, tokens_out, cost_usd, pages_read, ocr_pages, found, dropped, units,
              error_code, error, started_at, finished_at)
  ON brain_extractions TO salesdesk_app;
GRANT SELECT, INSERT ON brain_proposals TO salesdesk_app;
GRANT UPDATE (state, corrected_value, decided_by, decided_at) ON brain_proposals TO salesdesk_app;

ALTER TABLE brain_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_documents_isolation ON brain_documents
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE brain_extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_extractions_isolation ON brain_extractions
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE brain_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_proposals_isolation ON brain_proposals
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
