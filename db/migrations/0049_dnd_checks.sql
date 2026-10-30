-- ===========================================================================
--  0049_dnd_checks  --  what we know about a number and the DND register
--
--  TRAI's National Customer Preference Register (NCPR, "DND") lists numbers
--  whose owners refused promotional calls. A call inside the seven days after
--  the buyer's own enquiry is a reply to it; any other call to a number on
--  the register needs the buyer's consent registered with the operator.
--
--  No official single-number lookup exists: the operator scrubs at dial time,
--  on a 140-series number. So this table is what we learnt, from three
--  places, and the call gate reads its newest row:
--
--    LOOKUP    a lookup service answered (the seam in dnd.ts); lasts 24 hours,
--              because a preference is enforced within a day of being set
--    OPERATOR  a call was refused with a cause naming DND
--    PERSON    somebody on the developer's team recorded it by hand
--
--  CONSENT_REGISTERED is the buyer's consent held in the operators' consent
--  register (a DLT portal act), which lets a DND number be called.
--
--  Append only for the application: a new answer is a new row, and the
--  newest stands, so "what did we know when we called" stays answerable.
-- ===========================================================================

CREATE TABLE dnd_checks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone        text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  status       text NOT NULL CHECK (status IN ('DND', 'CLEAR', 'CONSENT_REGISTERED')),
  source       text NOT NULL CHECK (source IN ('LOOKUP', 'OPERATOR', 'PERSON')),
  lead_id      uuid REFERENCES leads(id) ON DELETE SET NULL,
  call_id      uuid REFERENCES calls(id) ON DELETE SET NULL,
  recorded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  CHECK (expires_at IS NULL OR expires_at > checked_at),
  -- Only a person's row names a person (it may lose them to SET NULL), and
  -- only a lookup's answer runs out.
  CHECK (source = 'PERSON' OR recorded_by IS NULL),
  CHECK ((source = 'LOOKUP') = (expires_at IS NOT NULL))
);

CREATE INDEX dnd_checks_phone ON dnd_checks (org_id, phone, checked_at DESC);

GRANT SELECT, INSERT ON dnd_checks TO salesdesk_app;

ALTER TABLE dnd_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY dnd_checks_isolation ON dnd_checks
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
