-- ===========================================================================
--  0016_campaign_studio  --  written copy, and what a model was allowed to draw
--
--  Section 08's rule is the one this migration is shaped by:
--
--    "The AI never originates the property. It assembles, adapts, localises
--     and validates approved assets."
--
--  A model writes the sentences here. Nothing it wrote is trusted. Every row
--  in `campaign_copy` carries the verdict a gate reached about it and the
--  reasons behind that verdict, and the verdict is not a flag somebody sets:
--  it is recomputed from the copy and from facts that were signed elsewhere.
--
--  WHY THE VERDICT IS STORED AT ALL, IF IT IS DERIVED
--
--  Because the facts move. A price is superseded, a registration lapses, a
--  never-say list grows. Storing the verdict with the ground it was reached
--  on is what makes "this was cleared on the 14th, and here is what it was
--  cleared against" answerable two years later, which is the same reason the
--  Brain's signatures pin a hash instead of a version.
--
--  WHAT A ROW IS
--
--  One block of copy per language per buyer segment. The FORMAT is not on the
--  row on purpose: copy does not change between a 1:1 feed post and a 9:16
--  story, the layout does. Putting the format here would multiply every model
--  call by seven and pay seven times for one sentence. The rendered assets,
--  when the renderer exists, hang off these rows rather than replace them.
--
--  WHAT A GENERATED PICTURE MAY BE
--
--  `generated_media` is deliberately not `assets`. An asset is source material
--  a named human approved and every pixel of the building traces to one. A
--  generated picture is a backdrop, a texture, a gradient or a pattern, it is
--  never the property, and keeping the two in separate tables means a
--  renderer cannot confuse them by forgetting a WHERE clause. The role CHECK
--  here is the last of three: the prompt is refused in code if it asks for a
--  building, and the exclusions are appended to every prompt that is sent.
-- ===========================================================================

CREATE TABLE campaign_copy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  brief_id       uuid NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,

  -- Carried alongside the brief so a read can filter by subtree without a
  -- join. It is the brief's node, and `creative.ts` sets it from the brief
  -- rather than from anything a form sent.
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  -- Validated against the catalogs in code, the same rule the brief follows:
  -- a checkbox list posts whatever the page happened to render.
  language       text NOT NULL,
  segment        text NOT NULL CHECK (segment IN
                   ('END_USER', 'UPGRADER', 'INVESTOR', 'NRI')),

  headline       text NOT NULL,
  body           text NOT NULL,
  cta            text NOT NULL,

  -- PASS publishes, FAIL is blocked, HOLD renders and never publishes. The
  -- third exists because a registration inside 30 days of lapsing is not a
  -- refusal: Section 6 allows an extension, and it is not automatic.
  verdict        text NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'HOLD')),

  -- Every reason the gate gave, as {code, detail}. A FAIL with no reasons
  -- would be a verdict nobody can act on.
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- What it was measured against, and which published Brain versions those
  -- facts came from. Together these make the verdict reproducible.
  ground         jsonb NOT NULL DEFAULT '{}'::jsonb,
  brain_sources  jsonb NOT NULL DEFAULT '[]'::jsonb,

  model          text NOT NULL,
  generated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaign_copy_reasons_shape CHECK (jsonb_typeof(reasons) = 'array'),
  CONSTRAINT campaign_copy_sources_shape CHECK (jsonb_typeof(brain_sources) = 'array')
);

-- One block per language per segment. Regenerating replaces rather than piles
-- up: two headlines for Marathi investors is two answers to one question, and
-- the screen would have to pick one anyway.
CREATE UNIQUE INDEX campaign_copy_block ON campaign_copy (brief_id, language, segment);
CREATE INDEX campaign_copy_org_idx ON campaign_copy (org_id);
CREATE INDEX campaign_copy_verdict_idx ON campaign_copy (brief_id, verdict);

CREATE TABLE generated_media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  -- Which push it was drawn for. Nullable: a backdrop outlives the brief that
  -- prompted it, and deleting a campaign should not delete a usable texture.
  brief_id       uuid REFERENCES campaign_briefs(id) ON DELETE SET NULL,

  -- Never a building. `canGenerate()` refuses a prompt that asks for one and
  -- `backdropPrompt()` appends the exclusions to whatever is sent; this is
  -- the constraint that holds when both of those are edited by somebody who
  -- did not read Section 08.
  role           text NOT NULL CHECK (role IN
                   ('BACKDROP', 'TEXTURE', 'GRADIENT', 'PATTERN')),

  -- What was asked for, as the person typed it, not as it was sent. The sent
  -- prompt is reconstructible from this and is not worth storing twice.
  prompt         text NOT NULL,
  model          text NOT NULL,

  -- A key, never a URL, for the reason `assets` holds one: a URL that works
  -- in a browser works for anybody holding it, forever, with no sign-in.
  storage_key    text NOT NULL UNIQUE,
  media_type     text NOT NULL,
  media_bytes    bigint NOT NULL CHECK (media_bytes > 0),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),

  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generated_media_org_idx ON generated_media (org_id);
CREATE INDEX generated_media_node_idx ON generated_media (scope_node_id);
CREATE INDEX generated_media_brief_idx ON generated_media (brief_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_copy TO salesdesk_app;
-- No UPDATE on a generated picture. The bytes are what the model returned and
-- the prompt is what was asked for; editing either would make the pair a lie.
-- Replacing one is a new row and a new object.
GRANT SELECT, INSERT, DELETE ON generated_media TO salesdesk_app;

ALTER TABLE campaign_copy ENABLE ROW LEVEL SECURITY;
CREATE POLICY campaign_copy_isolation ON campaign_copy
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE generated_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY generated_media_isolation ON generated_media
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
