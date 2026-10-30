-- ---------------------------------------------------------------------------
-- 0120  Who is on a call list: people who enquired, or people who never did
-- ---------------------------------------------------------------------------
--
-- The person uploading a sheet says where its people came from. ENQUIRED:
-- they filled a form, rang in or asked through a portal, so the agent may
-- say so (unless a person's own remarks say they never did). COLD: a cold
-- list, bought data or another outside source, so nobody on it is told they
-- enquired. MIXED: each person's remarks decide, and a remark that says
-- nothing counts as not enquired. Lists read before this are MIXED, which
-- is how they were already called.

ALTER TABLE call_lists ADD COLUMN source text NOT NULL DEFAULT 'MIXED'
  CHECK (source IN ('ENQUIRED', 'COLD', 'MIXED'));
