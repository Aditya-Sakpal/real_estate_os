-- ---------------------------------------------------------------------------
-- 0030  Ask Jimmy: the questions a person asks, and what answering cost
-- ---------------------------------------------------------------------------
--
-- A chat belongs to the person who asked it, not to their organisation. A
-- sales head's questions are not the admin's to read, so the two chat tables
-- are scoped to the person as well as the tenant, by a second setting beside
-- `app.org_id`. With either unset, nothing is visible: the policies fail
-- closed the way every other policy here does.
--
-- An answer can name a buyer, so a chat is kept for thirty days and then
-- removed whole. `ask_expire()` does that for the current organisation only,
-- and is called whenever anybody in it asks something.
--
-- What each question cost is kept apart from what was said, in `ask_usage`:
-- one row per person per IST day, a count and dollars, no text. That is the
-- metering, it outlives the chats, and the allowance is read from it.

CREATE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE TABLE ask_threads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The first question, cut short. What the chat list shows.
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ask_threads_owner ON ask_threads (org_id, user_id, updated_at DESC);
CREATE INDEX ask_threads_age ON ask_threads (org_id, updated_at);

CREATE TABLE ask_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  thread_id   uuid NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  --   PERSON  the question
  --   JIMMY   the answer
  role        text NOT NULL CHECK (role IN ('PERSON', 'JIMMY')),
  body        text NOT NULL CHECK (length(body) <= 4000),
  -- The tables shown with an answer, built from query results and never
  -- written by the model, plus links and suggested follow-ups.
  blocks      jsonb NOT NULL DEFAULT '{}'::jsonb,
  --   ANSWERED    answered from the data
  --   CLARIFY     asked the person something back
  --   UNANSWERED  the data could not answer it; the log of what to add next
  --   REFUSED     nothing the person may see could answer it
  --   LIMIT       over the day's or the month's allowance
  --   FAILED      something broke
  --   STOPPED     the person pressed Stop
  outcome     text CHECK (outcome IN
                ('ANSWERED', 'CLARIFY', 'UNANSWERED', 'REFUSED', 'LIMIT', 'FAILED', 'STOPPED')),
  -- Topics, tools called, model, turns and dollars. Never the data itself.
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ask_messages_outcome CHECK ((role = 'JIMMY') = (outcome IS NOT NULL))
);
CREATE INDEX ask_messages_thread ON ask_messages (thread_id, created_at);

CREATE TABLE ask_usage (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        date NOT NULL,
  questions  integer NOT NULL DEFAULT 0 CHECK (questions >= 0),
  usd        numeric(10, 4) NOT NULL DEFAULT 0 CHECK (usd >= 0),
  PRIMARY KEY (org_id, user_id, day)
);
CREATE INDEX ask_usage_month ON ask_usage (org_id, day);

GRANT SELECT, INSERT, UPDATE, DELETE ON ask_threads TO salesdesk_app;
GRANT SELECT, INSERT, DELETE ON ask_messages TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE ON ask_usage TO salesdesk_app;

ALTER TABLE ask_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY ask_threads_owner ON ask_threads
  USING (org_id = app_current_org() AND user_id = app_current_user())
  WITH CHECK (org_id = app_current_org() AND user_id = app_current_user());

ALTER TABLE ask_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY ask_messages_owner ON ask_messages
  USING (org_id = app_current_org() AND user_id = app_current_user())
  WITH CHECK (org_id = app_current_org() AND user_id = app_current_user());

ALTER TABLE ask_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY ask_usage_isolation ON ask_usage
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- Chats past thirty days, removed for the current organisation. SECURITY
-- DEFINER because the person asking can see only their own chats, and the
-- expiry has to reach everybody's; it is pinned to `app_current_org()`, so it
-- can never reach another tenant's.
CREATE FUNCTION ask_expire()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH gone AS (
    DELETE FROM ask_threads
    WHERE org_id = app_current_org() AND updated_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone;
$$;
REVOKE ALL ON FUNCTION ask_expire() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ask_expire() TO salesdesk_app;
