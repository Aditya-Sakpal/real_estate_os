-- ===========================================================================
--  0010_campaign_references  --  the examples a brief points at
--
--  A marketer briefing an agency does not describe the look in prose. They
--  send two things: the post that worked last Diwali, and the competitor
--  hoarding nobody wants to resemble. The brief had a single "competitors"
--  textarea, which held one half of that as words and lost the other half
--  entirely, so the column is dropped here and both halves become rows.
--
--  These are REFERENCES, not assets. Nothing here is ever rendered into an
--  advertisement. The Approved Asset Library is the thing whose every pixel
--  has to trace to a named human's approval, and it is not built: it needs
--  per-tenant encrypted object storage and an approval chain. An example of
--  a reel that performed well needs neither, because no part of it reaches a
--  buyer.
--
--  Images live in the row. That is a deliberate trade and it has a ceiling:
--
--    - A reference image is tenant data, so it has to be isolated. In this
--      column, the RLS policy that already guards every other table guards it
--      too. A file in a bucket needs a second access-control system, written
--      by hand, and the second one is the one that leaks.
--    - The cap is 5 MB and the CHECK enforces it, because a screenshot of an
--      advertisement is 100 KB to 2 MB and anything much larger is a video
--      somebody renamed.
--    - Video is a URL, never bytes. A reel is 5 to 50 MB, which does not
--      belong in a row, and video references travel as links anyway: nobody
--      emails an MP4 of a competitor's ad, they send the post.
--
--  When the Asset Library arrives with real object storage, these move to it
--  and `image` becomes a key. Until then this is the honest shape.
-- ===========================================================================

-- Replaced by AVOID references, which carry a link and an image rather than
-- only words. Dropped rather than left behind: two places to write down what
-- a campaign must not look like is one place too many.
ALTER TABLE campaign_briefs DROP COLUMN competitors;

CREATE TABLE campaign_references (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  brief_id     uuid NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,

  -- WORKED is "do more of this", AVOID is "do not look like this". Two lists
  -- rather than one with a flag, because a generator reads them as opposite
  -- instructions and a reference filed under the wrong one inverts its
  -- meaning.
  kind         text NOT NULL CHECK (kind IN ('WORKED', 'AVOID')),

  -- Why it is here. "Carousel, third card did the work" is worth more to
  -- whoever writes the next campaign than the image on its own.
  note         text,

  -- A post, a reel, a portal listing, a video. Validated to http or https in
  -- `normaliseUrl()` before it is written, because this ends up in an href
  -- and a `javascript:` URL in an href is a script somebody else wrote.
  url          text,

  image        bytea,
  image_type   text,
  image_name   text,

  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- A reference that names nothing is not a reference.
  CONSTRAINT campaign_references_says_something
    CHECK (note IS NOT NULL OR url IS NOT NULL OR image IS NOT NULL),

  -- Bytes without a type cannot be served, and a type without bytes is a
  -- claim about nothing.
  CONSTRAINT campaign_references_image_pair
    CHECK ((image IS NULL) = (image_type IS NULL)),

  -- The application caps this too. The constraint is here because the
  -- application is the thing that gets rewritten.
  CONSTRAINT campaign_references_image_size
    CHECK (image IS NULL OR octet_length(image) <= 5242880)
);

CREATE INDEX campaign_references_brief_idx ON campaign_references (brief_id, kind, created_at);
CREATE INDEX campaign_references_org_idx ON campaign_references (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_references TO salesdesk_app;

ALTER TABLE campaign_references ENABLE ROW LEVEL SECURITY;
CREATE POLICY campaign_references_isolation ON campaign_references
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
