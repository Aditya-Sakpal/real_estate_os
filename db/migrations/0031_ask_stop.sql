-- ---------------------------------------------------------------------------
-- 0031  Stopping a question from anywhere
-- ---------------------------------------------------------------------------
--
-- A question outlives the screen that asked it: switching chats or starting a
-- new one leaves it running, and its answer lands in its own chat. So Stop
-- can no longer be the browser dropping the request. It is this column, set
-- by the stop route and read by the running question every second or so, the
-- way a copy run reads `cancelled_at`. Cleared when the next question starts.

ALTER TABLE ask_threads ADD COLUMN stop_requested_at timestamptz;
