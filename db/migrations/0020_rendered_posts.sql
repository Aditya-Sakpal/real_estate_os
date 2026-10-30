-- ===========================================================================
--  0020_rendered_posts  --  copy becomes a post: an image, a carousel, a video
--
--  Everything before this produced sentences. A developer advertises
--  pictures with sentences on them, so this is where a cleared block of copy
--  is laid over an APPROVED picture, with the logo, the phone number and the
--  RERA lockup, and becomes something that could be posted.
--
--  The composition is deterministic. The approved picture is resized and
--  cropped and nothing else: no model touches the frame, because a model
--  handed a render and asked for a finished post gives back a new picture,
--  and the building in it is not the building (`doc/post-generation.md`
--  section 5). Video is the same slides with a slow zoom and a fade, which is
--  a transform on approved bytes rather than an invention.
--
--  A POST HOLDS ITS OWN COPY
--
--  For the reason 0018 gave for scheduled creatives: `campaign_copy` upserts,
--  so the next rewrite replaces the words a post was made from. The post
--  keeps the sentences it carries, and a pointer back that is nulled rather
--  than cascaded when the copy row goes.
--
--  A POST RECORDS WHAT IT WAS BUILT FROM
--
--  `inputs` names every approved asset version by hash, and the brand marks
--  by their address, the same record `post_creatives.inputs` keeps. That is
--  what makes "every pixel of the building traces to a named human who
--  approved it" answerable about the post and not only about its parts.
-- ===========================================================================

CREATE TABLE rendered_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  brief_id      uuid NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,
  scope_node_id uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  copy_id       uuid REFERENCES campaign_copy(id) ON DELETE SET NULL,

  --   IMAGE     one frame per placement
  --   CAROUSEL  several square frames, shown in order
  --   VIDEO     one clip per placement, made from the carousel frames
  kind          text NOT NULL CHECK (kind IN ('IMAGE', 'CAROUSEL', 'VIDEO')),

  -- The brief's own format name ("Meta feed 1:1"), from the catalog in
  -- `campaign-rules.ts`, so the placement a post was made for is the one the
  -- brief asked for.
  placement     text NOT NULL,

  language      text NOT NULL,
  segment       text NOT NULL,
  headline      text NOT NULL,
  body          text NOT NULL,
  cta           text NOT NULL,

  -- [{ key, type, width, height, bytes }] in the order they are shown. The
  -- KEY, never a URL, for the reason `storage.ts` states.
  media         jsonb NOT NULL DEFAULT '[]'::jsonb,

  inputs        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rendered_posts_org_idx ON rendered_posts (org_id);
CREATE INDEX rendered_posts_brief_idx ON rendered_posts (brief_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON rendered_posts TO salesdesk_app;

ALTER TABLE rendered_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY rendered_posts_isolation ON rendered_posts
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- A schedule's week plan
-- ---------------------------------------------------------------------------
--
-- Seven entries, Sunday first, each NULL for a day off or a post kind. It
-- replaces "which days" with "which days, and what goes out on each": Monday
-- an image, Wednesday a carousel, Friday a video. `days_of_week` is kept and
-- written from it, so everything that reads the days (the slot arithmetic,
-- the checks) goes on reading them unchanged.
ALTER TABLE post_schedules
  ADD COLUMN day_kinds text[] CHECK (
    day_kinds IS NULL
    OR (array_length(day_kinds, 1) = 7
        AND day_kinds <@ ARRAY['IMAGE', 'CAROUSEL', 'VIDEO', NULL]::text[])
  );

-- Every schedule written before this posted an image on each of its days.
UPDATE post_schedules s SET day_kinds = ARRAY(
  SELECT CASE WHEN d = ANY(s.days_of_week) THEN 'IMAGE' ELSE NULL END
  FROM generate_series(0, 6) AS d ORDER BY d
);

-- What a scheduled creative became, so the review queue shows the post a
-- person is approving and not only its sentences.
ALTER TABLE post_creatives
  ADD COLUMN kind  text NOT NULL DEFAULT 'IMAGE' CHECK (kind IN ('IMAGE', 'CAROUSEL', 'VIDEO')),
  ADD COLUMN media jsonb NOT NULL DEFAULT '[]'::jsonb;
