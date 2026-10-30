-- ===========================================================================
--  0029_reel_format  --  which kind of film a reel job makes
--
--  The director agent makes two kinds: a narrated story (a narrator over
--  people and property shots) and an agent on camera (a presenter at the
--  property talking to the viewer, lip-synced, with large text landing on
--  the words). The job records which, because the worker that claims it half
--  an hour later has nothing else to go on, and a retry must make the same.
-- ===========================================================================

ALTER TABLE reel_jobs ADD COLUMN format text NOT NULL DEFAULT 'story';
ALTER TABLE reel_jobs ADD CONSTRAINT reel_jobs_format CHECK (format IN ('story', 'presenter'));
