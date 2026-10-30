-- ===========================================================================
--  0019_copy_runs  --  writing copy can be stopped, and cannot run twice
--
--  Pressing "Write the copy" starts up to thirty six model calls, four at a
--  time, and nothing could stop them. The button said "Writing" and offered
--  no way out, so somebody who noticed the hook was wrong ten seconds in
--  watched the whole run finish and paid for every block of it.
--
--  A stop has to reach the SERVER, not just the page. A server action keeps
--  running after the browser stops waiting for it, and Next queues a second
--  action from the same page behind the first, so a stop sent as an action
--  would arrive after the thing it was meant to stop. The stop is therefore a
--  row the run checks, reached by an ordinary request.
--
--  A row rather than memory, because the console runs on more than one
--  instance and the request that stops a run need not land on the instance
--  running it.
--
--  One live run per brief. Two tabs pressing write on the same brief used to
--  run twice, pay twice, and overwrite each other's blocks in whatever order
--  the model answered. The partial unique index makes the second one refuse.
-- ===========================================================================

CREATE TABLE copy_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  brief_id      uuid NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,

  started_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),

  -- Set by the stop. The run reads it between blocks and aborts what is in
  -- flight, so a stop costs at most the calls already answered.
  cancelled_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at  timestamptz,

  finished_at   timestamptz,
  written       integer NOT NULL DEFAULT 0
);

-- One live run per brief. A run whose server died never sets finished_at, so
-- the writer closes any live row older than the longest a run can take before
-- it inserts, rather than leaving the brief unwritable forever.
CREATE UNIQUE INDEX copy_runs_one_live ON copy_runs (brief_id) WHERE finished_at IS NULL;
CREATE INDEX copy_runs_org_idx ON copy_runs (org_id);

GRANT SELECT, INSERT, UPDATE ON copy_runs TO salesdesk_app;

ALTER TABLE copy_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY copy_runs_isolation ON copy_runs
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
