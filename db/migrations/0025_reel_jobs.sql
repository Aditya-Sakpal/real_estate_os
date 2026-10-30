-- ===========================================================================
--  0025_reel_jobs  --  a story reel is a job, not a request
--
--  A thirty-second story reel is written, voiced, scored, shot as eight AI
--  clips, trimmed, edited and reviewed up to five times. That is twenty to
--  forty minutes, far past what a request or a server action may take, so
--  the studio records a job and a worker makes it. The screen reads the row
--  for its progress; the post it produces is an ordinary rendered post.
--
--  A job is claimed under a lease, the post_runs pattern: a worker that dies
--  leaves a lease that expires, and two workers resolve in the database.
-- ===========================================================================

CREATE TABLE reel_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  brief_id      uuid NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,
  copy_id       uuid NOT NULL REFERENCES campaign_copy(id) ON DELETE CASCADE,
  placement     text NOT NULL,

  state         text NOT NULL DEFAULT 'QUEUED'
                CHECK (state IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'STOPPED')),
  -- What the worker is doing, in words for the screen, and how far along.
  stage         text NOT NULL DEFAULT 'Waiting to start',
  progress      integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  -- Why it failed, in the client's words. Never the copy.
  message       text,

  lease_until   timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  cancelled_at  timestamptz,

  -- The script, the music and the reviews: what the reel was made from.
  plan          jsonb,
  post_id       uuid REFERENCES rendered_posts(id) ON DELETE SET NULL,

  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reel_jobs_org_brief_idx ON reel_jobs (org_id, brief_id, created_at DESC);
CREATE INDEX reel_jobs_due_idx ON reel_jobs (state, lease_until) WHERE state IN ('QUEUED', 'RUNNING');

GRANT SELECT, INSERT, UPDATE ON reel_jobs TO salesdesk_app;

ALTER TABLE reel_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY reel_jobs_isolation ON reel_jobs
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
