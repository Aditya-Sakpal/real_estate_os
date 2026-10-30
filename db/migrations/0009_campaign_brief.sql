-- ===========================================================================
--  0009_campaign_brief  --  the job a launch is asking creative to do
--
--  The Project Brain says what is TRUE about a building. A brief says what
--  this particular push is for: who it is aimed at, in which languages, in
--  which formats, and what the reader is meant to do next. Those are
--  different lifetimes. A price is signed once and quoted for months; a
--  Diwali offer runs for three weeks. Keeping them in one object would mean
--  either three approvers re-signing to change a CTA, or a festive hook
--  inheriting the immutability that exists to protect a price.
--
--  Several per node on purpose. A project runs a launch campaign, an NRI
--  campaign and a festive campaign in the same quarter, and each is a
--  separate job with its own audience and its own formats. One row per node
--  would have forced a marketer to overwrite the last campaign to write the
--  next one.
--
--  Nothing here is signed and nothing here is immutable, which is the whole
--  difference from brain_versions. A brief is a working instruction and it is
--  edited in place; the object that carries consequence is the Brain it
--  quotes from.
-- ===========================================================================

CREATE TABLE campaign_briefs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- A PROJECT or a PHASE. Enforced in `campaign.ts` rather than by a trigger,
  -- because the kind lives on scope_nodes and a cross-table CHECK is not a
  -- thing Postgres will hold for us.
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  -- What a marketer calls it in conversation. "Diwali 2026", "NRI Dubai".
  name           text NOT NULL,

  -- DRAFT while it is being written, READY when the marketer says it is done.
  -- Deliberately reversible: a brief is not signed truth, and a campaign that
  -- comes back for a rewrite must be able to go back to DRAFT. The Brain's
  -- one-way state machine exists because signatures hang off it; nothing
  -- hangs off this.
  status         text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'READY')),

  -- Every field below is nullable, including the ones a brief cannot run
  -- without. Completeness is answered by `briefGaps()` in code, not by a NOT
  -- NULL, because a marketer fills a brief over several sittings and a
  -- constraint that refuses a half-written brief is a constraint that makes
  -- people keep briefs in WhatsApp instead.
  objective      text CHECK (objective IS NULL OR objective IN
                   ('LEAD_FORM', 'WHATSAPP', 'SITE_VISIT', 'CP_LINK', 'AWARENESS')),
  audience       text,
  micro_markets  text[] NOT NULL DEFAULT '{}',

  -- Validated against the catalogs in `campaign-rules.ts`, for the same
  -- reason the permission catalog lives in code: a language nothing can
  -- render and a format nothing can lay out are not choices, and the list
  -- that knows which is which is the one the renderer reads.
  languages      text[] NOT NULL DEFAULT '{}',
  formats        text[] NOT NULL DEFAULT '{}',
  cta            text,

  hook           text,
  competitors    text,
  offers         text,

  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Two briefs called "Diwali 2026" on one tower is a naming accident, not a
  -- second campaign.
  CONSTRAINT campaign_briefs_named CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX campaign_briefs_node_name
  ON campaign_briefs (scope_node_id, lower(btrim(name)));
CREATE INDEX campaign_briefs_org_idx ON campaign_briefs (org_id);
CREATE INDEX campaign_briefs_node_idx ON campaign_briefs (scope_node_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_briefs TO salesdesk_app;

ALTER TABLE campaign_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY campaign_briefs_isolation ON campaign_briefs
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
