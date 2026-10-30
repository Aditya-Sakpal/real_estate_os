-- 0087: one-to-one WhatsApp paced to the number's messaging limit.
--
-- A business-initiated template that would take a number past the people
-- Meta lets it reach in 24 hours is not sent; its task waits until the
-- oldest person in the window ages out. The number records when that last
-- happened and until when messages wait, so Today can say so.
--
-- Additive. `salesdesk_app` already holds UPDATE on whatsapp_numbers (0045),
-- and the row's RLS policy covers the new columns.

ALTER TABLE whatsapp_numbers
  -- When a send was last held back because the number reached its limit.
  ADD COLUMN paced_at    timestamptz,
  -- Until when held messages wait, at the latest.
  ADD COLUMN paced_until timestamptz,
  ADD CONSTRAINT whatsapp_numbers_paced CHECK (paced_until IS NULL OR paced_at IS NOT NULL);
