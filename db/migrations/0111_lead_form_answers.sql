-- ===========================================================================
-- 0111: what a buyer answered on our Meta lead form.
--
-- The form now asks which home, the budget, when they plan to buy and where
-- they live (`lead-form-rules.ts`, `doc/lead-quality.md`). The answers that
-- count toward the score go into `leads.qualification` as what the buyer
-- said on the form; this column keeps every answer in the buyer's words, for
-- the lead's page and the agent's first call. At most eight, each short.
-- ===========================================================================

ALTER TABLE leads
  ADD COLUMN form_answers jsonb
    CHECK (form_answers IS NULL OR (jsonb_typeof(form_answers) = 'array' AND jsonb_array_length(form_answers) <= 8));
