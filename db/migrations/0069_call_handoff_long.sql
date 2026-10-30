-- ===========================================================================
-- 0069: a long call goes to a person, and the AI line and recording notice
-- are off.
--
-- 1. A call with the AI that runs past five minutes is handed to the sales
--    team (`LONG_CALL_SECONDS`, `handOffLongCalls()`). Sales Desk watches for
--    it, because the agent cannot keep time: `live_since` is when Vobiz first
--    showed the call in progress, so ringing is not counted, and
--    `handoff_reason` says whether the agent asked or the clock did.
--
-- 2. The client chose on 30 September 2026 to drop "as an AI assistant" and
--    "this call is recorded": buyers hung up on hearing them in testing, and
--    neither is required on the call today. The defaults in code are now off.
--    A tenant that saved Settings, Calling holds an explicit true from the
--    old defaults, which would keep saying them, so those are turned off too.
--    No organisation is live, so nobody's deliberate choice is overridden.
-- ===========================================================================

ALTER TABLE calls
  ADD COLUMN live_since timestamptz,
  ADD COLUMN handoff_reason text CHECK (handoff_reason IS NULL OR handoff_reason IN ('ASKED', 'LONG_CALL'));

-- The watcher reads only calls still with the AI.
CREATE INDEX calls_with_ai ON calls (org_id, placed_at) WHERE status = 'DIALLING' AND handoff_state IS NULL;

UPDATE calling_settings SET announce_ai = false WHERE announce_ai;
UPDATE calling_settings SET announce_recording = false WHERE announce_recording;
