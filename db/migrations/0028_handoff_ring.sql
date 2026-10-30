-- ---------------------------------------------------------------------------
-- 0028  Putting a ready buyer through to whoever on the sales team is free
-- ---------------------------------------------------------------------------
--
-- When a buyer is ready, the agent asks Sales Desk to connect them. Sales Desk
-- redirects the live Vobiz call to its own instructions, which ring every free
-- person on the sales team at once; the first to answer takes the buyer and
-- the others stop ringing. Vobiz reports who answered and how long they
-- talked, so "busy" is known rather than guessed, and the talk is metered.
--
--   REQUESTED  the agent asked; the call is being redirected
--   RINGING    the team's phones are ringing
--   CONNECTED  somebody answered and is talking to the buyer
--   ENDED      that conversation is over
--   NO_ANSWER  nobody picked up; the buyer was told they will be called back
--   FAILED     the call could not be redirected (already over, or Vobiz refused)

ALTER TABLE calls
  ADD COLUMN handoff_state text CHECK (handoff_state IS NULL OR handoff_state IN (
    'REQUESTED', 'RINGING', 'CONNECTED', 'ENDED', 'NO_ANSWER', 'FAILED')),
  -- The numbers rung, in order, frozen when the ring was built.
  ADD COLUMN handoff_rang text[],
  ADD COLUMN handoff_at timestamptz,
  ADD COLUMN handoff_ended_at timestamptz,
  -- Seconds the sales person was billed for, as Vobiz rounded them.
  ADD COLUMN handoff_bill_s integer CHECK (handoff_bill_s IS NULL OR handoff_bill_s >= 0),
  -- Vobiz's id for the buyer's leg, found when the hand-off was asked for.
  ADD COLUMN vobiz_call_uuid text CHECK (vobiz_call_uuid IS NULL OR length(vobiz_call_uuid) <= 80);

CREATE INDEX calls_handoff_live ON calls (org_id, handoff_state) WHERE handoff_state IN ('REQUESTED', 'RINGING', 'CONNECTED');
