-- ===========================================================================
-- 0104: a channel partner's buyers and brokerage with developers who are not
-- on Sales Desk.
--
-- A channel partner files each developer it sells for as an ENTITY. For one
-- that is not on Sales Desk, its own console now holds the rest of the
-- business: where the developer takes buyer registrations (an email
-- address), each buyer registered with it (emailed from here, then held to
-- the days the developer allows), each booking and what it owes, and the
-- partner's own GST invoice for that brokerage, numbered in its own gapless
-- series and drawn as a PDF from the stored row.
--
-- All of it is the partner's tenant data, under RLS like every other table.
-- An invoice is immutable once issued: only its payment may be recorded on
-- it, once. A buyer's name and number are scrubbed with the buyer, and the
-- invoice never carries either.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The developer: where registrations go, and who an invoice is made out to
-- ---------------------------------------------------------------------------
CREATE TABLE outside_developers (
  entity_id      uuid PRIMARY KEY REFERENCES scope_nodes(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  reg_email      text NOT NULL CHECK (reg_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(reg_email) <= 254),
  reg_cc         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reg_cc) <= 3),
  -- Days a registration holds, as this developer allows it.
  validity_days  smallint NOT NULL DEFAULT 30 CHECK (validity_days BETWEEN 7 AND 365),
  -- The brokerage this developer pays, in basis points (200 is 2%).
  rate_bp        integer NOT NULL DEFAULT 200 CHECK (rate_bp BETWEEN 1 AND 1000),
  gstin          text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  bill_address   text CHECK (bill_address IS NULL OR length(bill_address) <= 300),
  state_code     text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON outside_developers TO salesdesk_app;
ALTER TABLE outside_developers ENABLE ROW LEVEL SECURITY;
CREATE POLICY outside_developers_isolation ON outside_developers
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- A buyer registered with that developer
-- ---------------------------------------------------------------------------
CREATE TABLE outside_registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_id      uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  lead_id        uuid REFERENCES leads(id) ON DELETE SET NULL,
  -- NULL once the buyer's data is erased.
  buyer_name     text CHECK (buyer_name IS NULL OR length(buyer_name) BETWEEN 1 AND 120),
  phone          text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  --   SENT       emailed to the developer, its answer not recorded
  --   CONFIRMED  the developer said the buyer is the partner's
  --   REFUSED    the developer said another holds the buyer
  --   WITHDRAWN  taken back by the partner
  status         text NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT', 'CONFIRMED', 'REFUSED', 'WITHDRAWN')),
  sent_at        timestamptz NOT NULL DEFAULT now(),
  valid_until    date NOT NULL,
  -- What the mail service said; an unsent registration says why.
  mail_id        text CHECK (mail_id IS NULL OR length(mail_id) <= 200),
  mail_error     text CHECK (mail_error IS NULL OR length(mail_error) <= 300),
  answered_at    timestamptz,
  note           text CHECK (note IS NULL OR length(note) <= 200),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outside_registrations_erased CHECK ((buyer_name IS NULL) = (phone IS NULL))
);
-- One live registration of a number for a project: a second press is the first.
CREATE UNIQUE INDEX outside_registrations_live ON outside_registrations (org_id, project_id, phone)
  WHERE status IN ('SENT', 'CONFIRMED') AND phone IS NOT NULL;
CREATE INDEX outside_registrations_by_org ON outside_registrations (org_id, sent_at DESC);
GRANT SELECT, INSERT ON outside_registrations TO salesdesk_app;
GRANT UPDATE (status, answered_at, note, valid_until, buyer_name, phone, lead_id, mail_id, mail_error) ON outside_registrations TO salesdesk_app;
ALTER TABLE outside_registrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY outside_registrations_isolation ON outside_registrations
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- A booking, and the brokerage it owes
-- ---------------------------------------------------------------------------
CREATE TABLE outside_bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  registration_id  uuid REFERENCES outside_registrations(id) ON DELETE SET NULL,
  entity_id        uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  buyer_name       text CHECK (buyer_name IS NULL OR length(buyer_name) BETWEEN 1 AND 120),
  unit             text CHECK (unit IS NULL OR length(unit) <= 40),
  booked_on        date NOT NULL,
  agreement_paise  bigint NOT NULL CHECK (agreement_paise > 0),
  rate_bp          integer NOT NULL CHECK (rate_bp BETWEEN 1 AND 1000),
  brokerage_paise  bigint NOT NULL CHECK (brokerage_paise > 0),
  status           text NOT NULL DEFAULT 'OWED' CHECK (status IN ('OWED', 'CANCELLED')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outside_bookings_by_org ON outside_bookings (org_id, booked_on DESC);
GRANT SELECT, INSERT ON outside_bookings TO salesdesk_app;
GRANT UPDATE (status, buyer_name) ON outside_bookings TO salesdesk_app;
ALTER TABLE outside_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY outside_bookings_isolation ON outside_bookings
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- The partner's own brokerage invoice
-- ---------------------------------------------------------------------------
CREATE TABLE outside_invoice_seq (
  org_id  uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  fy      text NOT NULL CHECK (fy ~ '^[0-9]{2}-[0-9]{2}$'),
  last    integer NOT NULL DEFAULT 0 CHECK (last >= 0),
  PRIMARY KEY (org_id, fy)
);
GRANT SELECT, INSERT, UPDATE ON outside_invoice_seq TO salesdesk_app;
ALTER TABLE outside_invoice_seq ENABLE ROW LEVEL SECURITY;
CREATE POLICY outside_invoice_seq_isolation ON outside_invoice_seq
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

CREATE TABLE outside_invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  booking_id       uuid NOT NULL REFERENCES outside_bookings(id) ON DELETE RESTRICT,
  number           text NOT NULL CHECK (length(number) <= 16 AND number ~ '^[A-Z0-9/-]+$'),
  fy               text NOT NULL,
  seq              integer NOT NULL CHECK (seq > 0),
  issued_on        date NOT NULL,
  -- Who and to whom, as they stood the day it was issued.
  seller           jsonb NOT NULL,
  buyer            jsonb NOT NULL,
  place_of_supply  text NOT NULL,
  description      text NOT NULL CHECK (length(description) <= 300),
  sac              text NOT NULL DEFAULT '997221',
  taxable_paise    bigint NOT NULL CHECK (taxable_paise > 0),
  cgst_paise       bigint NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise       bigint NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise       bigint NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  total_paise      bigint NOT NULL CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  tds_paise        bigint NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),
  paid_on          date,
  paid_paise       bigint CHECK (paid_paise IS NULL OR paid_paise > 0),
  utr              text CHECK (utr IS NULL OR utr ~ '^[A-Za-z0-9]{6,22}$'),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (org_id, fy, seq),
  CONSTRAINT outside_invoices_paid CHECK ((paid_on IS NULL) = (paid_paise IS NULL) AND (paid_on IS NULL) = (utr IS NULL))
);
-- One invoice per booking.
CREATE UNIQUE INDEX outside_invoices_one_per_booking ON outside_invoices (org_id, booking_id);
GRANT SELECT, INSERT ON outside_invoices TO salesdesk_app;
GRANT UPDATE (paid_on, paid_paise, utr) ON outside_invoices TO salesdesk_app;
ALTER TABLE outside_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY outside_invoices_isolation ON outside_invoices
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- An issued invoice is never edited; its payment is recorded once.
CREATE FUNCTION outside_invoices_paid_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.paid_on IS NOT NULL THEN
    RAISE EXCEPTION 'this invoice''s payment is already recorded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outside_invoices_paid_once BEFORE UPDATE ON outside_invoices
  FOR EACH ROW EXECUTE FUNCTION outside_invoices_paid_once();
