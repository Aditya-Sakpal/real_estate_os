-- ===========================================================================
--  0074_crm_visits  --  what 0041 left out: a visit booked in the CRM, the
--                       record deleted or merged there, and a partner's
--                       buyer arriving through it
--
--  A VISIT A PERSON TYPED IN THE CRM IS A VISIT HERE
--
--  LeadRat carries a site visit on the lead (`scheduledDate` under a
--  site-visit status). 0041 copied its time into the lead's facts and
--  stopped there, so the buyer got no confirmation, no reminder and no seat
--  in the gallery's ledger. Now it is booked through `bookVisit()`, the path
--  the board uses, and `crm_visits` remembers which of our visits is the
--  CRM's, keyed on the CRM's own id for it, so a replay books nothing twice
--  and a moved or cancelled visit there moves or cancels ours.
--
--  Who owns it follows 0041's rule: the CRM owns a visit a person typed
--  there, we own one the agent booked. Ownership only settles the case where
--  both sides changed it since they last agreed.
--
--  A RECORD DELETED OR MERGED IN THE CRM IS NEVER DELETED HERE
--
--  The lead is closed as "Removed in CRM" and its link is kept, marked, so
--  nothing is ever sent to a record that is gone and nothing recreates it.
--  A merge moves the link to the record that survived.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The CRM's visits, and which of ours each one is
-- ---------------------------------------------------------------------------
CREATE TABLE crm_visits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- The CRM's id for the visit (`crm-rules.ts` crmVisitKey()).
  external_id      text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  -- Our visit for it now. A move points this at the new row.
  visit_id         uuid REFERENCES site_visits(id) ON DELETE SET NULL,
  --   CRM  a person typed it in the CRM: the CRM's time wins a conflict
  --   US   the agent or a person here booked it: ours does
  origin           text NOT NULL CHECK (origin IN ('CRM', 'US')),
  -- The time both sides last agreed on, in IST, "YYYY-MM-DDTHH:MM".
  agreed_at        text CHECK (agreed_at IS NULL OR agreed_at ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d$'),
  --   BOOKED | MOVED | CANCELLED   what the last change did to ours
  status           text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED', 'MOVED', 'CANCELLED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);
CREATE INDEX crm_visits_by_visit ON crm_visits (org_id, visit_id);

GRANT SELECT, INSERT, UPDATE ON crm_visits TO salesdesk_app;
ALTER TABLE crm_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_visits_isolation ON crm_visits
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A visit the CRM booked says so.
ALTER TABLE site_visits DROP CONSTRAINT site_visits_booked_via_check;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_booked_via_check
  CHECK (booked_via IN ('AI_CALL', 'CONSOLE', 'WHATSAPP', 'CRM'));

-- ---------------------------------------------------------------------------
-- A record the CRM deleted or merged
-- ---------------------------------------------------------------------------
ALTER TABLE crm_links
  ADD COLUMN removed_at      timestamptz,
  --   DELETED  gone from the CRM; the link stays so nothing recreates it
  --   MERGED   merged into another record: this link names it now, or, when
  --            that record is already another lead's here, the link is
  --            closed like a deleted one
  ADD COLUMN removed_reason  text CHECK (removed_reason IN ('DELETED', 'MERGED')),
  -- The ids this link named before a merge moved it, oldest first.
  ADD COLUMN previous_ids    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(previous_ids) <= 20),
  ADD CONSTRAINT crm_links_removed CHECK (removed_at IS NULL OR removed_reason IS NOT NULL);

ALTER TABLE crm_events DROP CONSTRAINT crm_events_outcome_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_outcome_check
  CHECK (outcome IN ('CREATED', 'LINKED', 'UPDATED', 'UNCHANGED', 'IGNORED', 'WAITING', 'FAILED', 'REMOVED', 'MERGED'));
