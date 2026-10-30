-- ===========================================================================
-- 0123: who ended a connected call, as the carrier recorded it.
--
-- A call back opened with "our call suddenly got cut" to a buyer who had
-- hung up himself (28 October 2026): `wasCutOff()` reads the transcript's
-- shape and cannot know who hung up. Vobiz's own record of the call says
-- which side ended it, so a connected call keeps it here (BUYER, AGENT,
-- NETWORK), and "the call got cut" is said only when the network did it.
-- ===========================================================================

ALTER TABLE calls
  ADD COLUMN hung_up_by text CHECK (hung_up_by IN ('BUYER', 'AGENT', 'NETWORK')),
  ADD COLUMN hangup_cause text CHECK (hangup_cause IS NULL OR length(hangup_cause) <= 80);
