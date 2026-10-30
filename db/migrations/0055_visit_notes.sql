-- ===========================================================================
--  0055_visit_notes  --  the host's voice note after a visit, what it said,
--                        the lenders a buyer may be introduced to, and the
--                        buyer's yes before anybody is
--
--  A NOTE IS KEPT AS IT WAS SAID
--
--  The recording lives in the store under `org/<org>/visitnote/<id>`, and
--  the row holds the key, never a link. Its key, size and hash are written
--  once: the app role holds no UPDATE on them, so what the transcript and
--  the draft were read from stays the file that was recorded. The draft is
--  the AI's; the host confirms or corrects it, and only then is the visit
--  recorded.
--
--  Two notes a visit at most (one re-record), enforced here under a lock on
--  the visit, because every note is a paid transcription.
--
--  KEPT TWELVE MONTHS AFTER THE LEAD CLOSES
--
--  The app may delete a note only once its lead has been booked or lost for
--  twelve months; the policy says so, so a bug cannot reach a live one.
--
--  A LENDER HEARS ABOUT A BUYER ONLY AFTER THE BUYER SAYS YES
--
--  `lender_referrals` is the ask and the answer. The buyer's number goes to
--  a lender only from a row the buyer answered YES to, on WhatsApp.
-- ===========================================================================

CREATE TABLE visit_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  visit_id       uuid NOT NULL REFERENCES site_visits(id) ON DELETE CASCADE,
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  storage_key    text NOT NULL UNIQUE CHECK (storage_key ~ '^org/[0-9a-f-]{36}/visitnote/[0-9a-f-]{36}$'),
  content_type   text NOT NULL CHECK (content_type IN ('audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac')),
  bytes          integer NOT NULL CHECK (bytes > 0 AND bytes <= 5242880),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- As the phone timed it, then as FFmpeg read it from the file.
  duration_ms    integer NOT NULL CHECK (duration_ms BETWEEN 1000 AND 600000),
  measured_ms    integer CHECK (measured_ms IS NULL OR measured_ms >= 0),
  --   UPLOADED   waiting for the worker
  --   WORKING    transcribing and reading, under a lease
  --   DRAFTED    read; waiting for the host to confirm
  --   REFUSED    too short or too long, never transcribed
  --   FAILED     could not be transcribed or read
  --   CONFIRMED  the host confirmed it and the visit is recorded
  state          text NOT NULL DEFAULT 'UPLOADED' CHECK (state IN ('UPLOADED', 'WORKING', 'DRAFTED', 'REFUSED', 'FAILED', 'CONFIRMED')),
  reason         text CHECK (reason IS NULL OR length(reason) <= 200),
  transcript     text CHECK (transcript IS NULL OR length(transcript) <= 20000),
  language       text CHECK (language IS NULL OR length(language) <= 12),
  draft          jsonb,
  -- One transcription and two reads a note, counted before each is asked.
  transcribed    boolean NOT NULL DEFAULT false,
  extract_tries  smallint NOT NULL DEFAULT 0 CHECK (extract_tries BETWEEN 0 AND 2),
  lease_until    timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);
CREATE INDEX visit_notes_visit ON visit_notes (org_id, visit_id);
CREATE INDEX visit_notes_due ON visit_notes (state, created_at) WHERE state IN ('UPLOADED', 'WORKING');

CREATE FUNCTION visit_notes_two_at_most() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM site_visits WHERE id = NEW.visit_id FOR UPDATE;
  IF (SELECT count(*) FROM visit_notes WHERE visit_id = NEW.visit_id) >= 2 THEN
    RAISE EXCEPTION 'A visit holds two notes at most' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER visit_notes_two_at_most
  BEFORE INSERT ON visit_notes
  FOR EACH ROW EXECUTE FUNCTION visit_notes_two_at_most();

GRANT SELECT, INSERT ON visit_notes TO salesdesk_app;
GRANT UPDATE (measured_ms, state, reason, transcript, language, draft, transcribed, extract_tries,
              lease_until, confirmed_by, confirmed_at, updated_at) ON visit_notes TO salesdesk_app;
GRANT DELETE ON visit_notes TO salesdesk_app;

ALTER TABLE visit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY visit_notes_read ON visit_notes FOR SELECT USING (org_id = app_current_org());
CREATE POLICY visit_notes_add ON visit_notes FOR INSERT WITH CHECK (org_id = app_current_org());
CREATE POLICY visit_notes_change ON visit_notes FOR UPDATE
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
-- Only a note whose lead closed twelve months ago may go.
CREATE POLICY visit_notes_expire ON visit_notes FOR DELETE USING (
  org_id = app_current_org() AND EXISTS (
    SELECT 1 FROM site_visits v JOIN leads l ON l.id = v.lead_id
    WHERE v.id = visit_notes.visit_id AND l.stage IN ('booked', 'lost') AND l.updated_at < now() - interval '12 months'));

-- ---------------------------------------------------------------------------

CREATE TABLE lenders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- Where a buyer who said yes is sent. A work address the lender gave.
  email       text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 200),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX lenders_one_address ON lenders (org_id, lower(email)) WHERE active;

GRANT SELECT, INSERT ON lenders TO salesdesk_app;
GRANT UPDATE (name, active, updated_at) ON lenders TO salesdesk_app;
ALTER TABLE lenders ENABLE ROW LEVEL SECURITY;
CREATE POLICY lenders_isolation ON lenders
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

CREATE TABLE lender_referrals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  visit_id     uuid REFERENCES site_visits(id) ON DELETE SET NULL,
  lender_id    uuid NOT NULL REFERENCES lenders(id) ON DELETE RESTRICT,
  --   ASKED   the question went out
  --   YES     the buyer tapped yes; nothing sent yet
  --   NO      the buyer said no; nothing is ever sent
  --   SENT    the lender was sent the buyer's name and number
  --   FAILED  the lender could not be reached
  state        text NOT NULL DEFAULT 'ASKED' CHECK (state IN ('ASKED', 'YES', 'NO', 'SENT', 'FAILED')),
  -- The question, as the buyer was shown it.
  wording      text NOT NULL CHECK (length(wording) BETWEEN 1 AND 600),
  asked_at     timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  sent_at      timestamptz,
  reason       text CHECK (reason IS NULL OR length(reason) <= 200),
  UNIQUE (org_id, lead_id, lender_id),
  CHECK (state IN ('ASKED') OR answered_at IS NOT NULL),
  CHECK ((state = 'SENT') = (sent_at IS NOT NULL))
);

-- An answer moves forward only: once the buyer said no, it stays no.
CREATE FUNCTION lender_referrals_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('NO', 'SENT') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'A lender referral that ended cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'SENT' AND OLD.state NOT IN ('SENT', 'YES', 'FAILED') THEN
    RAISE EXCEPTION 'A buyer is sent to a lender only after saying yes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lender_referrals_forward
  BEFORE UPDATE ON lender_referrals
  FOR EACH ROW EXECUTE FUNCTION lender_referrals_forward();

GRANT SELECT, INSERT ON lender_referrals TO salesdesk_app;
GRANT UPDATE (state, answered_at, sent_at, reason) ON lender_referrals TO salesdesk_app;
ALTER TABLE lender_referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY lender_referrals_isolation ON lender_referrals
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A voice note is metered like a call's reading: half an AI minute.
ALTER TABLE usage_events DROP CONSTRAINT usage_events_source_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_source_kind_check
  CHECK (source_kind IN ('call', 'post', 'creative', 'ask_message', 'message', 'visit_note'));
