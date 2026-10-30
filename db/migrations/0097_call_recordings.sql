-- ===========================================================================
-- 0097: a call's recording is kept in our own bucket.
--
-- Until now a recording lived only at Sarvam and was fetched from there every
-- time somebody pressed play: slow on the first press, gone the day Sarvam
-- stops keeping it, and out of reach of the erasure that scrubs the buyer.
-- The lead worker now copies each finished call's recording to the bucket
-- (`archiveDueRecordings()`), as speech-sized MP3 where FFmpeg is at hand,
-- under the call's project (`org/<org>/project/<project>/recording/<call>`),
-- and the player and the export read it from there.
--
--   recording_key    the object, never a URL
--   recording_type   what it was stored as
--   recording_tries  how often Sarvam was asked for it, so a recording Sarvam
--                    no longer holds is asked for three times and then left
-- ===========================================================================

ALTER TABLE calls
  ADD COLUMN recording_key text,
  ADD COLUMN recording_type text,
  ADD COLUMN recording_tries smallint NOT NULL DEFAULT 0;

ALTER TABLE calls
  ADD CONSTRAINT calls_recording_key_shape CHECK (recording_key IS NULL OR recording_key LIKE 'org/%'),
  ADD CONSTRAINT calls_recording_pair CHECK ((recording_key IS NULL) = (recording_type IS NULL));

-- The worker's question: finished calls with a recording not yet copied.
CREATE INDEX calls_recording_due ON calls (org_id, placed_at DESC)
  WHERE recording_key IS NULL AND interaction_id IS NOT NULL;

-- An erased buyer's call points at no recording, whoever writes the row.
CREATE OR REPLACE FUNCTION calls_stay_erased() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM leads WHERE id = NEW.lead_id AND erased_at IS NOT NULL) THEN
    NEW.to_number := NULL;
    NEW.transcript := NULL;
    NEW.final_variables := NULL;
    NEW.payload := NULL;
    NEW.qualification := NULL;
    NEW.variables := '{}'::jsonb;
    NEW.recording_key := NULL;
    NEW.recording_type := NULL;
    -- `calls_goal_pair` keeps a goal's text beside its kind.
    IF NEW.goal_text IS NOT NULL THEN NEW.goal_text := ''; END IF;
  END IF;
  RETURN NEW;
END;
$$;
