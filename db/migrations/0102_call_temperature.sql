-- ===========================================================================
-- 0102: a call's hot, warm or cold is our score's, never the agent's word.
--
-- The calling agent rates its own calls, and it rated almost anybody who
-- answered as warm: a buyer who said nothing but "what difference does that
-- make?" read as "Qualified" on the call log. Our own reading of the call
-- (`qualify.ts`: the nine fields and their score) now decides it, and what
-- it decided is kept on the call, so the call log shows the verdict the
-- engine acted on rather than the agent's.
-- ===========================================================================

ALTER TABLE calls
  ADD COLUMN temperature text CHECK (temperature IN ('HOT', 'WARM', 'COLD'));
