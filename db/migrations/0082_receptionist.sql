-- ===========================================================================
--  0082_receptionist  --  a buyer ringing in is answered by the AI
--
--  A developer's own number (calling_numbers, 0073) may be answered by the
--  inbound receptionist: a Sarvam agent bound to the number, which asks us
--  at the start of each call who is ringing and what it may say
--  (/api/calls/inbound/start). That call is a `calls` row like any other, so
--  the call log, the lead's history, the reading of the call, the minutes
--  and the hand-off to a person all work on it unchanged. Two things mark
--  it: its direction, and its agent.
--
--  `from_number` stays our number and `to_number` the buyer's, the way every
--  row has them, so "the buyer's number" is one column whichever way the
--  call went.
-- ===========================================================================

ALTER TABLE calls ADD COLUMN direction text NOT NULL DEFAULT 'OUT'
  CHECK (direction IN ('OUT', 'IN'));

ALTER TABLE calls DROP CONSTRAINT calls_agent_check;
ALTER TABLE calls ADD CONSTRAINT calls_agent_check
  CHECK (agent IN ('qualifier', 'reminder', 'recovery', 'reengage', 'post_visit', 'goal', 'receptionist'));

-- Only the receptionist answers; nothing we place is inbound.
ALTER TABLE calls ADD CONSTRAINT calls_direction_agent
  CHECK ((direction = 'IN') = (agent = 'receptionist'));

-- The live inbound calls of a tenant, for the lines in use and the hand-off.
CREATE INDEX calls_live_inbound ON calls (org_id, to_number)
  WHERE direction = 'IN' AND status IN ('PLACING', 'DIALLING');
