-- ===========================================================================
--  0037_channel_partners  --  empanelment, a partner's claim on a buyer, and
--                             what the partner is paid for a booking
--
--  Section 07. A channel partner is a firm of its own, not a list of people
--  inside the developer, so a firm is an org of type CHANNEL_PARTNER and its
--  empanelment is a GRANT: an edge from a node of the tenant that holds the
--  project to that other org, with a start, an end and a status. The
--  developer holds no membership for the firm's staff.
--
--  ONE HOP, NOT A CHAIN
--
--  The grantor is whichever tenant holds the project's nodes. For a mandate
--  firm selling a developer's project, that is the mandate firm. There are
--  no re-grants: a partner reaching a project through somebody else's grant
--  is a decision for when a developer and its mandate firm are both here.
--
--  NOTHING HERE IS READABLE ACROSS TENANTS BY THE GRANTOR
--
--  The firm's org row is written once, by the control connection, when the
--  first tenant empanels it (org creation, the one thing that connection is
--  for). What a tenant knows about the firm, the name it invoices, its PAN,
--  its MahaRERA agent number, lives in that tenant's own `partner_firms`
--  row, so one tenant never writes something another tenant reads.
--
--  THE GRANTEE READS ONLY WHAT IS LIVE
--
--  Nobody at a partner firm can sign in yet (phone and OTP are not built),
--  but the two policies a partner's session will run under are written now,
--  so the rule is in the database before the first session exists: a firm
--  sees its own grants while they are live, and its own registrations while
--  both the registration and the grant are live. Expiry is a comparison with
--  now(), never a job, so a grant that ended at midnight shows nothing at
--  the first query after it. A partner reads no lead, no payout and no
--  other firm's anything.
--
--  A REGISTRATION IS A LOGGED VERDICT
--
--  Every attempt is a row, refused or not, with the verdict it got. The
--  claims are the rows whose verdict is REGISTERED, and `valid_until` is
--  computed when the row is written, from the project's terms as they stood
--  then. It moves only forward, and only when a visit extends it.
--
--  MONEY IS FROZEN WHEN IT IS OWED
--
--  A booking by a registered buyer writes a payout with its rate, the
--  booking's place on the ladder and the pass-back, then two milestones with
--  their invoice arithmetic. Changing a project's terms later changes no
--  payout already written. A milestone moves forward only, and a paid one
--  never moves again.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The tenant's partner settings
-- ---------------------------------------------------------------------------
CREATE TABLE partner_settings (
  org_id               uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  --   AFTER_VISIT  nobody here calls a partner's buyer, by AI or by hand,
  --                until the buyer has visited the site
  --   LOGGED       calls are allowed and logged
  dial_policy          text NOT NULL DEFAULT 'AFTER_VISIT' CHECK (dial_policy IN ('AFTER_VISIT', 'LOGGED')),
  -- Registrations one firm may attempt in an IST day.
  daily_registrations  integer NOT NULL DEFAULT 50 CHECK (daily_registrations BETWEEN 1 AND 1000),
  updated_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- A project's terms: the commission ladder and the registration clock
-- ---------------------------------------------------------------------------
CREATE TABLE commission_terms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id        uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  -- [{"from": 1, "rate": 0.02}, {"from": 2, "rate": 0.0225}, ...]: the rate
  -- a firm's Nth booking on this project earns. Checked by `partner-rules.ts`.
  steps                jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 6),
  -- The most a firm may give back to the buyer as a discount, per booking.
  pass_back_max        numeric(6, 5) NOT NULL DEFAULT 0.01 CHECK (pass_back_max >= 0 AND pass_back_max <= 0.02),
  registration_days    integer NOT NULL DEFAULT 30 CHECK (registration_days BETWEEN 15 AND 90),
  visit_extends_days   integer NOT NULL DEFAULT 30 CHECK (visit_extends_days BETWEEN 0 AND 90),
  updated_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope_node_id)
);

-- ---------------------------------------------------------------------------
-- What this tenant knows about a firm
-- ---------------------------------------------------------------------------
CREATE TABLE partner_firms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  cp_org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  legal_name           text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 160),
  pan                  text NOT NULL CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  gstin                text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  rera_agent_no        text CHECK (rera_agent_no IS NULL OR rera_agent_no ~ '^A[0-9]{11}$'),
  rera_valid_till      date,
  competency_till      date,
  principal_name       text CHECK (principal_name IS NULL OR length(principal_name) BETWEEN 1 AND 120),
  principal_phone      text CHECK (principal_phone IS NULL OR principal_phone ~ '^\+[1-9][0-9]{7,14}$'),
  area                 text CHECK (area IS NULL OR length(area) <= 80),
  -- The person here who looks after the firm.
  rm_id                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, cp_org_id),
  UNIQUE (org_id, pan)
);

-- ---------------------------------------------------------------------------
-- The grant: an edge from a node of this tenant to another org
-- ---------------------------------------------------------------------------
CREATE TABLE grants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The grantor: the tenant that owns the node and this row.
  org_id               uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  grantee_org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id        uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  role                 text NOT NULL CHECK (role IN ('CHANNEL_PARTNER')),
  valid_from           timestamptz NOT NULL DEFAULT now(),
  valid_to             timestamptz NOT NULL,
  --   ACTIVE     live between valid_from and valid_to
  --   SUSPENDED  cut mid-cycle by a person; can be restored
  --   ENDED      finished; a new empanelment is a new row
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ENDED')),
  commission_terms_ref uuid REFERENCES commission_terms(id) ON DELETE RESTRICT,
  suspended_reason     text CHECK (suspended_reason IS NULL OR length(suspended_reason) <= 200),
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grants_window CHECK (valid_to > valid_from),
  CONSTRAINT grants_other_org CHECK (grantee_org_id <> org_id),
  CONSTRAINT grants_reason CHECK ((status = 'SUSPENDED') = (suspended_reason IS NOT NULL))
);
-- One live edge per firm per node: "where does this firm stand here" has one answer.
CREATE UNIQUE INDEX grants_one_live ON grants (org_id, grantee_org_id, scope_node_id) WHERE status <> 'ENDED';
CREATE INDEX grants_grantee ON grants (grantee_org_id, status);

-- ---------------------------------------------------------------------------
-- A partner's claim on a buyer, and every attempt at one
-- ---------------------------------------------------------------------------
CREATE TABLE client_registrations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  cp_org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  -- The grant it was decided under. NULL only when there was none.
  grant_id             uuid REFERENCES grants(id) ON DELETE RESTRICT,
  -- The project. A lead at any tower under it belongs to the claim.
  scope_node_id        uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  phone                text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  buyer_name           text CHECK (buyer_name IS NULL OR length(buyer_name) BETWEEN 1 AND 120),
  agent_name           text CHECK (agent_name IS NULL OR length(agent_name) BETWEEN 1 AND 120),
  lead_id              uuid REFERENCES leads(id) ON DELETE SET NULL,
  --   CONSOLE   entered by the relationship manager on the firm's behalf
  --   LINK      the buyer tapped the firm's link
  --   WHATSAPP  the firm's bot (not built)
  via                  text NOT NULL CHECK (via IN ('CONSOLE', 'LINK', 'WHATSAPP')),
  ref_code             text CHECK (ref_code IS NULL OR ref_code ~ '^[A-Z0-9-]{4,24}$'),
  --   REGISTERED    the claim
  --   ALREADY       this firm already holds the buyer; the answer points at that claim
  --   BLOCKED       another firm holds the buyer; never says which
  --   DIRECT_FIRST  the buyer enquired before, and not through this firm's link
  --   NO_GRANT      the firm is not empanelled here, or no longer
  --   AGENT_RERA    the firm's MahaRERA agent registration is missing or lapsed
  --   RATE_LIMITED  the firm's registrations for the day are used up
  verdict              text NOT NULL CHECK (verdict IN (
                         'REGISTERED', 'ALREADY', 'BLOCKED', 'DIRECT_FIRST', 'NO_GRANT', 'AGENT_RERA', 'RATE_LIMITED')),
  -- For a claim, when it lapses. For BLOCKED and ALREADY, when the holding
  -- claim does; for NO_GRANT, when the grant ended. Frozen at write.
  valid_until          timestamptz,
  --   ACTIVE    a claim in force (lapsed claims read as lapsed before the sweep)
  --   RELEASED  lapsed, and the lead handed back
  --   BOOKED    the buyer booked while it was live
  --   WITHDRAWN taken back by a person
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED', 'BOOKED', 'WITHDRAWN')),
  released_at          timestamptz,
  extended_at          timestamptz,
  extended_by_visit    uuid REFERENCES site_visits(id) ON DELETE SET NULL,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_registrations_claim CHECK (
    verdict <> 'REGISTERED' OR (grant_id IS NOT NULL AND valid_until IS NOT NULL)),
  -- Only a claim has a life after it is written.
  CONSTRAINT client_registrations_life CHECK (verdict = 'REGISTERED' OR status = 'ACTIVE')
);
-- One claim holding a buyer per project. A claim that lapsed but has not
-- been swept still holds its place here, which is why registering releases
-- the lapsed claim on that number first, in the same transaction. A booked
-- claim holds the buyer too, and goes back to ACTIVE if the booking is
-- cancelled.
CREATE UNIQUE INDEX client_registrations_one_claim ON client_registrations (org_id, phone, scope_node_id)
  WHERE verdict = 'REGISTERED' AND status IN ('ACTIVE', 'BOOKED');
CREATE INDEX client_registrations_firm_day ON client_registrations (org_id, cp_org_id, created_at);
CREATE INDEX client_registrations_lead ON client_registrations (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX client_registrations_grantee ON client_registrations (cp_org_id) WHERE verdict = 'REGISTERED';

-- valid_until moves forward only, and only on a claim.
CREATE OR REPLACE FUNCTION client_registrations_forward_only() RETURNS trigger AS $$
BEGIN
  IF NEW.valid_until IS DISTINCT FROM OLD.valid_until
     AND (OLD.verdict <> 'REGISTERED' OR NEW.valid_until IS NULL OR NEW.valid_until < OLD.valid_until) THEN
    RAISE EXCEPTION 'a registration''s validity only moves forward'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A booking that is cancelled hands its claim back; nothing else revives one.
  IF OLD.status <> 'ACTIVE' AND NEW.status <> OLD.status
     AND NOT (OLD.status = 'BOOKED' AND NEW.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'a registration that ended cannot change state'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER client_registrations_forward_only
  BEFORE UPDATE ON client_registrations
  FOR EACH ROW EXECUTE FUNCTION client_registrations_forward_only();

-- ---------------------------------------------------------------------------
-- What a booking owes the firm
-- ---------------------------------------------------------------------------
CREATE TABLE partner_payouts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id                  uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  registration_id          uuid NOT NULL REFERENCES client_registrations(id) ON DELETE RESTRICT,
  cp_org_id                uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  -- The project whose ladder it was counted on.
  scope_node_id            uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  unit                     text CHECK (unit IS NULL OR length(unit) <= 40),
  agreement                bigint NOT NULL CHECK (agreement > 0),
  -- This firm's Nth booking on the project, and the rate that step pays.
  booking_no               integer NOT NULL CHECK (booking_no >= 1),
  rate                     numeric(6, 5) NOT NULL CHECK (rate > 0 AND rate <= 0.05),
  -- Given back to the buyer as a discount, out of the rate.
  pass_back                numeric(6, 5) NOT NULL DEFAULT 0 CHECK (pass_back >= 0 AND pass_back < rate),
  gst_registered           boolean NOT NULL,
  booked_on                date NOT NULL,
  agreement_registered_on  date,
  -- When collection reached thirty per cent of the price.
  collected_on             date,
  cancelled_at             timestamptz,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_payouts_live ON partner_payouts (org_id, lead_id) WHERE cancelled_at IS NULL;
CREATE INDEX partner_payouts_firm ON partner_payouts (org_id, cp_org_id, scope_node_id);

CREATE TABLE payout_milestones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  payout_id     uuid NOT NULL REFERENCES partner_payouts(id) ON DELETE RESTRICT,
  key           text NOT NULL CHECK (key IN ('M1', 'M2')),
  base          bigint NOT NULL CHECK (base >= 0),
  gst           bigint NOT NULL CHECK (gst >= 0),
  gross         bigint NOT NULL,
  tds           bigint NOT NULL CHECK (tds >= 0),
  net           bigint NOT NULL,
  --   NONE      nothing invoiced (held, or owed and waiting on the invoice)
  --   INVOICED  the firm's invoice is on file
  --   VERIFIED  somebody checked it against the booking
  --   APPROVED  released for payment
  --   PAID      money sent, with its UTR
  stage         text NOT NULL DEFAULT 'NONE' CHECK (stage IN ('NONE', 'INVOICED', 'VERIFIED', 'APPROVED', 'PAID')),
  verified_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at   timestamptz,
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz,
  paid_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at       timestamptz,
  paid_on       date,
  utr           text CHECK (utr IS NULL OR utr ~ '^[A-Z0-9]{8,32}$'),
  CONSTRAINT payout_milestones_sums CHECK (gross = base + gst AND net = gross - tds),
  CONSTRAINT payout_milestones_paid CHECK ((stage = 'PAID') = (utr IS NOT NULL AND paid_on IS NOT NULL)),
  UNIQUE (payout_id, key)
);

-- Forward only, one step at a time, and a rejected invoice sends it back to
-- NONE. A paid milestone never changes again, and the amounts change only
-- before anything has been invoiced against them (a pass-back corrected).
CREATE OR REPLACE FUNCTION payout_milestones_forward_only() RETURNS trigger AS $$
BEGIN
  IF OLD.stage = 'PAID' AND (NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'a paid milestone cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.base, NEW.gst, NEW.gross, NEW.tds, NEW.net) IS DISTINCT FROM (OLD.base, OLD.gst, OLD.gross, OLD.tds, OLD.net)
     AND NOT (OLD.stage = 'NONE' AND NEW.stage = 'NONE') THEN
    RAISE EXCEPTION 'a milestone''s amounts are fixed once it is invoiced' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.stage = NEW.stage THEN RETURN NEW; END IF;
  IF (OLD.stage, NEW.stage) IN (('NONE', 'INVOICED'), ('INVOICED', 'NONE'), ('INVOICED', 'VERIFIED'),
                                ('VERIFIED', 'APPROVED'), ('APPROVED', 'PAID')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a milestone cannot go from % to %', OLD.stage, NEW.stage
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payout_milestones_forward_only
  BEFORE UPDATE ON payout_milestones
  FOR EACH ROW EXECUTE FUNCTION payout_milestones_forward_only();

-- The firm's invoice for one milestone. The bytes are in the file store, by key.
CREATE TABLE partner_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  milestone_id  uuid NOT NULL REFERENCES payout_milestones(id) ON DELETE RESTRICT,
  cp_org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  invoice_no    text NOT NULL CHECK (length(invoice_no) BETWEEN 1 AND 40),
  invoice_date  date NOT NULL,
  -- As written on the invoice: the total, GST included.
  amount        bigint NOT NULL CHECK (amount > 0),
  storage_key   text NOT NULL CHECK (storage_key LIKE 'org/%'),
  media_type    text NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  bytes         integer NOT NULL CHECK (bytes BETWEEN 1 AND 10485760),
  -- By the firm itself, once a partner can sign in. Not built.
  attested_at   timestamptz,
  rejected_at   timestamptz,
  rejected_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_invoices_milestone ON partner_invoices (milestone_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Privileges: nothing here is ever deleted by the application
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON partner_settings, commission_terms, partner_firms TO salesdesk_app;
GRANT SELECT, INSERT ON grants, client_registrations, partner_payouts, payout_milestones, partner_invoices TO salesdesk_app;
GRANT UPDATE (valid_to, status, suspended_reason, commission_terms_ref, updated_at) ON grants TO salesdesk_app;
GRANT UPDATE (status, released_at, valid_until, extended_at, extended_by_visit, lead_id) ON client_registrations TO salesdesk_app;
GRANT UPDATE (pass_back, agreement_registered_on, collected_on, cancelled_at, updated_at) ON partner_payouts TO salesdesk_app;
GRANT UPDATE (base, gst, gross, tds, net, stage, verified_by, verified_at, approved_by, approved_at, paid_by, paid_at, paid_on, utr)
  ON payout_milestones TO salesdesk_app;
GRANT UPDATE (rejected_at, rejected_by) ON partner_invoices TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------
ALTER TABLE partner_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_settings_isolation ON partner_settings
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE commission_terms ENABLE ROW LEVEL SECURITY;
CREATE POLICY commission_terms_isolation ON commission_terms
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE partner_firms ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_firms_isolation ON partner_firms
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY grants_isolation ON grants
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
-- The grantee sees its own edges while they are live, and nothing else.
CREATE POLICY grants_grantee_live ON grants FOR SELECT
  USING (grantee_org_id = app_current_org()
         AND status = 'ACTIVE' AND now() >= valid_from AND now() < valid_to);

ALTER TABLE client_registrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_registrations_isolation ON client_registrations
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
-- A firm sees the buyers it registered while the claim is in force and the
-- grant it was made under is live. The grant is read through its own
-- policy, so a lapsed grant hides every claim made under it.
CREATE POLICY client_registrations_grantee_live ON client_registrations FOR SELECT
  USING (cp_org_id = app_current_org()
         AND verdict = 'REGISTERED' AND status = 'ACTIVE' AND now() < valid_until
         AND EXISTS (SELECT 1 FROM grants g WHERE g.id = grant_id));

ALTER TABLE partner_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_payouts_isolation ON partner_payouts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE payout_milestones ENABLE ROW LEVEL SECURITY;
CREATE POLICY payout_milestones_isolation ON payout_milestones
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE partner_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_invoices_isolation ON partner_invoices
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
