-- ---------------------------------------------------------------------------
-- 0062  Asking Jimmy by voice
-- ---------------------------------------------------------------------------
--
-- A person may speak a question instead of typing it. The clip is written
-- down by Sarvam's Saaras v3 and handed back to the box; the person reads it
-- and sends it. The audio is never stored: not here, not in the file store.
--
-- What a clip costs us is added to the person's day in `ask_usage` beside
-- their questions' dollars, and the clips are counted so the allowance can
-- be asked before Saaras is paid. A clip is not a question: the words it
-- gives back are counted as one when they are sent.
-- ---------------------------------------------------------------------------

ALTER TABLE ask_usage
  ADD COLUMN voice integer NOT NULL DEFAULT 0 CHECK (voice >= 0);
