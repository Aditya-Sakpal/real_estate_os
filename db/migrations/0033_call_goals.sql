-- ---------------------------------------------------------------------------
-- 0033  A call can carry a goal
-- ---------------------------------------------------------------------------
--
-- A person can send the agent to do one thing ("invite him for a site visit
-- tomorrow") rather than the usual qualifying call. The goal goes to a second
-- Sarvam agent, a copy of the qualifier that reads it as a variable, so the
-- call records which agent it was and what it was asked to do.
--
-- `goal` is the kind (named or the person's own words); `goal_text` is the
-- instruction as the agent received it. The words stay here, under the
-- tenant's row-level security, and never reach `audit_log`, which records
-- only the kind.

ALTER TABLE calls
  ADD COLUMN goal text CHECK (goal IN ('site_visit', 'after_visit', 'custom')),
  ADD COLUMN goal_text text CHECK (char_length(goal_text) <= 600),
  ADD CONSTRAINT calls_goal_pair CHECK ((goal IS NULL) = (goal_text IS NULL));

ALTER TABLE calls DROP CONSTRAINT calls_agent_check;
ALTER TABLE calls ADD CONSTRAINT calls_agent_check
  CHECK (agent IN ('qualifier', 'reminder', 'recovery', 'reengage', 'goal'));
