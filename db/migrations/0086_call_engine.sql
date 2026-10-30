-- ===========================================================================
--  0086_call_engine  --  a call that failed on our side is not a missed call
--
--  A call the calling service accepted and then lost (no result ever came
--  back, a status nobody knows, Sarvam's own "failed" with no carrier cause
--  naming the buyer's phone) used to be read as the buyer not answering: it
--  spent one of their nine dials and one of their sixteen automatic calls,
--  and enough of them closed the lead "Not reachable". The buyer never heard
--  a ring.
--
--  `system_failure` marks such a call, written with the result
--  (`isSystemFailure()` in calling-rules.ts) or by `closeSilentCalls()`. The
--  engine leaves it out of both counts and tries the call again, three times
--  a day at most, then asks a person.
--
--  The second index serves the pickup rate per calling number over five
--  weeks, which names a number buyers have stopped answering on Today.
-- ===========================================================================

ALTER TABLE calls ADD COLUMN system_failure boolean NOT NULL DEFAULT false;

-- A connected call never failed on our side.
ALTER TABLE calls ADD CONSTRAINT calls_system_failure_not_connected
  CHECK (NOT system_failure OR connectivity IS DISTINCT FROM 'connected');

CREATE INDEX calls_system_failure ON calls (lead_id, placed_at) WHERE system_failure;

CREATE INDEX calls_from_number ON calls (org_id, from_number, placed_at DESC)
  WHERE direction = 'OUT' AND from_number IS NOT NULL;
