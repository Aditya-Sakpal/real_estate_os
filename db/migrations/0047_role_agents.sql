-- ===========================================================================
--  0047_role_agents  --  a call placed for the post-visit agent
--
--  Each calling job has a Sarvam agent of its own now, a copy of the
--  qualifier with that job's role in its prompt (doc/sarvam-qualifier-agent.md
--  section 10). The visit confirmer's calls were already `reminder` and
--  `recovery`, and the re-engager's `reengage`; the call after a visit is
--  new, so its kind is added here.
-- ===========================================================================

ALTER TABLE calls DROP CONSTRAINT calls_agent_check;
ALTER TABLE calls ADD CONSTRAINT calls_agent_check
  CHECK (agent IN ('qualifier', 'reminder', 'recovery', 'reengage', 'post_visit', 'goal'));
