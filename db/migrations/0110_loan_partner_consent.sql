-- ===========================================================================
-- 0110: who arranges a home loan, a partner told of it only with the
-- buyer's consent, and a partner's second half paid on the bank's money.
--
-- `doc/home-loan-partners.md` is the research. Three changes.
--
-- 1. `lead_loans.arranged_by`: the developer's own bank, the buyer's own,
--    the channel partner's or the mandate firm's. A bank that has not
--    approved the project needs more paperwork, and the loan file says so.
-- 2. A channel partner sees its buyer's loan stage only when the developer
--    switched it on (`partner_settings.share_loan_stage`) and the buyer said
--    yes (`lead_loans.partner_share`), on WhatsApp or to a person, recorded
--    with when and how.
-- 3. A project's terms may make a partner's second half fall due on
--    whichever comes first, the share of the price collected or the bank's
--    first payment (`commission_terms.second_half`).
-- ===========================================================================

ALTER TABLE lead_loans
  ADD COLUMN arranged_by text CHECK (arranged_by IS NULL OR arranged_by IN ('DEVELOPER', 'BUYER', 'PARTNER', 'MANDATE')),
  --   ASKED  the buyer was asked on WhatsApp and has not answered
  --   YES    the buyer agreed the partner may see the loan's stage
  --   NO     the buyer said no; nothing is shown
  ADD COLUMN partner_share text CHECK (partner_share IS NULL OR partner_share IN ('ASKED', 'YES', 'NO')),
  ADD COLUMN partner_share_at timestamptz,
  ADD COLUMN partner_share_source text CHECK (partner_share_source IS NULL OR partner_share_source IN ('WHATSAPP', 'PERSON')),
  ADD CONSTRAINT lead_loans_share_recorded CHECK (partner_share IS NULL OR partner_share = 'ASKED' OR (partner_share_at IS NOT NULL AND partner_share_source IS NOT NULL));

GRANT UPDATE (arranged_by, partner_share, partner_share_at, partner_share_source) ON lead_loans TO salesdesk_app;

ALTER TABLE partner_settings
  ADD COLUMN share_loan_stage boolean NOT NULL DEFAULT false;

ALTER TABLE commission_terms
  ADD COLUMN second_half text NOT NULL DEFAULT 'COLLECTED' CHECK (second_half IN ('COLLECTED', 'COLLECTED_OR_BANK'));
