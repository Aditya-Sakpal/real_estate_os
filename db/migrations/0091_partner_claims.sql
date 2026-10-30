-- 0091: partner claims that the buyer's own number and project do not match,
-- money taken back from a cancelled booking, the ladder's period, the
-- developer's rule for a direct buyer, and a partner's own leads registered
-- by themselves.
--
-- Additive. The payout triggers of 0037 (a paid half never changes, stages
-- forward only, amounts fixed once invoiced) are untouched: a clawback is
-- its own rows, set against a half's payment and never written into it.

-- ---------------------------------------------------------------------------
-- 1. Other numbers on a lead: a co-applicant, an alternate
-- ---------------------------------------------------------------------------
CREATE TABLE lead_phones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  phone        text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  kind         text NOT NULL CHECK (kind IN ('CO_APPLICANT', 'ALTERNATE')),
  added_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  removed_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX lead_phones_one ON lead_phones (org_id, lead_id, phone) WHERE removed_at IS NULL;
CREATE INDEX lead_phones_phone ON lead_phones (org_id, phone) WHERE removed_at IS NULL;

GRANT SELECT, INSERT ON lead_phones TO salesdesk_app;
GRANT UPDATE (removed_at, removed_by) ON lead_phones TO salesdesk_app;

ALTER TABLE lead_phones ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_phones_isolation ON lead_phones
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A number taken off a lead stays off.
CREATE OR REPLACE FUNCTION lead_phones_removed_once() RETURNS trigger AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a number taken off a lead stays off' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lead_phones_removed_once BEFORE UPDATE ON lead_phones
  FOR EACH ROW EXECUTE FUNCTION lead_phones_removed_once();

-- ---------------------------------------------------------------------------
-- 2. The developer's partner rules, and a partner firm's own
-- ---------------------------------------------------------------------------
ALTER TABLE partner_settings
  --   OFF    a claim pays only on the project it was registered on
  --   FLAG   a booking on another project is flagged for the desk
  --   CARRY  and paid on the booked project's terms when the firm is empanelled there
  ADD COLUMN cross_project_claims text NOT NULL DEFAULT 'OFF'
    CHECK (cross_project_claims IN ('OFF', 'FLAG', 'CARRY')),
  -- A booking cancelled after a half was paid takes that money back from the firm's next payouts.
  ADD COLUMN clawback boolean NOT NULL DEFAULT true,
  --   ENQUIRY  an open direct enquiry refuses a partner's registration
  --   VISIT    only a direct enquiry with a site visit recorded does
  ADD COLUMN direct_wins text NOT NULL DEFAULT 'ENQUIRY'
    CHECK (direct_wins IN ('ENQUIRY', 'VISIT')),
  -- A channel partner's own setting: its captured leads are registered
  -- with the developer whose project it sells, by themselves.
  ADD COLUMN auto_register boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 3. Which bookings count toward the ladder
-- ---------------------------------------------------------------------------
ALTER TABLE commission_terms
  ADD COLUMN ladder_period text NOT NULL DEFAULT 'ALL' CHECK (ladder_period IN ('ALL', 'QUARTER', 'YEAR'));

-- ---------------------------------------------------------------------------
-- 4. How a payout found its claim
-- ---------------------------------------------------------------------------
ALTER TABLE partner_payouts
  --   PHONE          the buyer's number, on the project it was registered on
  --   OTHER_NUMBER   a co-applicant's or alternate number on the lead
  --   OTHER_PROJECT  registered on another project of this developer (CARRY)
  --   BY_HAND        linked by a person on the desk, with a reason
  ADD COLUMN matched_by text NOT NULL DEFAULT 'PHONE'
    CHECK (matched_by IN ('PHONE', 'OTHER_NUMBER', 'OTHER_PROJECT', 'BY_HAND')),
  ADD COLUMN link_reason text CHECK (link_reason IS NULL OR length(link_reason) BETWEEN 4 AND 200),
  ADD CONSTRAINT partner_payouts_link_reason CHECK (matched_by <> 'BY_HAND' OR link_reason IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 5. A partner's own project, linked to the developer's project it sells
-- ---------------------------------------------------------------------------
-- Held in the partner's tenant. The developer's ids are a pointer the
-- partner's own functions read through (registerForFirm asks again that the
-- developer still has the firm and granted that project), never a grant.
CREATE TABLE partner_project_links (
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_node_id   uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  dev_org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  dev_project_id  uuid NOT NULL,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope_node_id),
  CONSTRAINT partner_project_links_other_org CHECK (dev_org_id <> org_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_project_links TO salesdesk_app;
ALTER TABLE partner_project_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_project_links_isolation ON partner_project_links
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- 6. Clawback: a debit, and where it was set off
-- ---------------------------------------------------------------------------
-- A debit is negative: what the firm owes back from a cancelled booking. It
-- belongs to the desk that paid it (the developer's own, or the mandate
-- firm's), and is set off only against that desk's later halves to the same
-- firm. Append only.
CREATE TABLE partner_adjustments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  cp_org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  payer_mandate_id  uuid REFERENCES mandates(id),
  kind              text NOT NULL DEFAULT 'CLAWBACK' CHECK (kind IN ('CLAWBACK')),
  -- The cancelled booking it was taken from.
  payout_id         uuid NOT NULL REFERENCES partner_payouts(id),
  amount            bigint NOT NULL CHECK (amount < 0),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, kind)
);
CREATE INDEX partner_adjustments_firm ON partner_adjustments (org_id, cp_org_id);

CREATE TABLE partner_adjustment_uses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  adjustment_id  uuid NOT NULL REFERENCES partner_adjustments(id),
  -- The later half it was taken off. Paid as its net less this.
  milestone_id   uuid NOT NULL REFERENCES payout_milestones(id),
  amount         bigint NOT NULL CHECK (amount > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adjustment_id, milestone_id)
);
CREATE INDEX partner_adjustment_uses_milestone ON partner_adjustment_uses (milestone_id);

GRANT SELECT, INSERT ON partner_adjustments, partner_adjustment_uses TO salesdesk_app;

ALTER TABLE partner_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_adjustments_isolation ON partner_adjustments
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
ALTER TABLE partner_adjustment_uses ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_adjustment_uses_isolation ON partner_adjustment_uses
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- A debit is taken from the cancelled booking's own firm and desk, and only once the booking is cancelled.
CREATE OR REPLACE FUNCTION partner_adjustments_check() RETURNS trigger AS $$
DECLARE p record;
BEGIN
  SELECT org_id, cp_org_id, payer_mandate_id, kind, cancelled_at INTO p FROM partner_payouts WHERE id = NEW.payout_id;
  IF NOT FOUND OR p.org_id <> NEW.org_id OR p.cp_org_id <> NEW.cp_org_id
     OR p.payer_mandate_id IS DISTINCT FROM NEW.payer_mandate_id OR p.kind <> 'PARTNER' OR p.cancelled_at IS NULL THEN
    RAISE EXCEPTION 'a clawback comes from a cancelled booking of the same firm and desk' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER partner_adjustments_check BEFORE INSERT ON partner_adjustments
  FOR EACH ROW EXECUTE FUNCTION partner_adjustments_check();

-- A use is set against a live, unpaid half of the same firm and desk, and
-- neither the debit nor the half is ever used past its amount. Two at once
-- are kept apart by the caller's lock on the firm (`settleDebits()`). A use on a
-- half whose booking was later cancelled before it was paid counts for
-- nothing: that half was never paid, so the debit is free again.
CREATE OR REPLACE FUNCTION partner_adjustment_uses_check() RETURNS trigger AS $$
DECLARE a record; m record; used_debit bigint; used_half bigint;
BEGIN
  SELECT * INTO a FROM partner_adjustments WHERE id = NEW.adjustment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such clawback' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ms.id, ms.stage, ms.net, p.org_id, p.cp_org_id, p.payer_mandate_id, p.kind, p.cancelled_at
    INTO m FROM payout_milestones ms JOIN partner_payouts p ON p.id = ms.payout_id WHERE ms.id = NEW.milestone_id;
  IF NOT FOUND OR a.org_id <> NEW.org_id OR m.org_id <> NEW.org_id
     OR m.cp_org_id <> a.cp_org_id OR m.payer_mandate_id IS DISTINCT FROM a.payer_mandate_id OR m.kind <> 'PARTNER'
     OR m.cancelled_at IS NOT NULL OR m.stage = 'PAID' THEN
    RAISE EXCEPTION 'a clawback is set only against an unpaid half owed to the same firm by the same desk' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(u.amount), 0) INTO used_debit
    FROM partner_adjustment_uses u JOIN payout_milestones ms ON ms.id = u.milestone_id JOIN partner_payouts p ON p.id = ms.payout_id
    WHERE u.adjustment_id = NEW.adjustment_id AND (ms.stage = 'PAID' OR p.cancelled_at IS NULL);
  IF used_debit + NEW.amount > -a.amount THEN
    RAISE EXCEPTION 'a clawback is never set off past its amount' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(u.amount), 0) INTO used_half FROM partner_adjustment_uses u WHERE u.milestone_id = NEW.milestone_id;
  IF used_half + NEW.amount > m.net THEN
    RAISE EXCEPTION 'a half is never taken below zero' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER partner_adjustment_uses_check BEFORE INSERT ON partner_adjustment_uses
  FOR EACH ROW EXECUTE FUNCTION partner_adjustment_uses_check();
