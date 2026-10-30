-- ===========================================================================
--  0043_field_policies  --  who sees a buyer's number, per role and stage
--
--  Section 04: a field policy on (org, resource, field, role, lead stage)
--  answers FULL, MASKED or HIDDEN, applied on the server so a masked number
--  never reaches a browser. `mask-rules.ts` holds the rule; this is only
--  where a tenant's own answers are kept.
--
--  COPY ON WRITE
--
--  Empty for a tenant that never opened the setting, and the shipped answer
--  (masked for anybody who works leads or visits, hidden for everybody else)
--  applies. A row exists only where a tenant decided otherwise, which is the
--  `org_roles` pattern.
--
--  THE STAGE IS THE PATH STAGE
--
--  `leads.path_stage`, how far a lead has come, not where it sits now, so a
--  lead that reached Qualified and went to Nurture is judged as Qualified.
--  That is why only the seven path stages are allowed here.
--
--  NO FOREIGN KEY ON ROLE
--
--  A role we ship has no row anywhere, so there is nothing to point at. A row
--  naming a role that was since deleted answers for nobody, because nobody
--  holds that role.
-- ===========================================================================

CREATE TABLE field_policies (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  resource    text NOT NULL CHECK (resource IN ('lead')),
  field       text NOT NULL CHECK (field IN ('phone', 'email')),
  role        text NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  stage       text NOT NULL CHECK (stage IN ('new', 'contacted', 'qualified', 'visit_scheduled',
                                             'visit_done', 'negotiation', 'booked')),
  visibility  text NOT NULL CHECK (visibility IN ('FULL', 'MASKED', 'HIDDEN')),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, resource, field, role, stage)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON field_policies TO salesdesk_app;

ALTER TABLE field_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY field_policies_isolation ON field_policies
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
