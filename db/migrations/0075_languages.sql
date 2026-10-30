-- ===========================================================================
-- 0074: the partner's own language, and Ask Jimmy read aloud.
--
-- 1. A channel partner's person chooses the language the bot writes to them
--    in, on WhatsApp: Hinglish (as every reply was before this), English or
--    Marathi, all in Roman letters. It is theirs and nobody else's, so it is
--    a column on their row of the developer's list, written by the bot when
--    they choose. Everybody already on the list keeps Hinglish.
-- 2. An answer Jimmy gave may be read aloud by Sarvam's Bulbul. The audio is
--    never stored anywhere; what is kept is how many answers a person had
--    read today, beside their questions and clips, so the allowance is asked
--    before Sarvam is paid, and what it cost joins the day's dollars.
-- ===========================================================================

ALTER TABLE partner_agents
  ADD COLUMN language text NOT NULL DEFAULT 'hi' CHECK (language IN ('hi', 'en', 'mr'));

GRANT UPDATE (language) ON partner_agents TO salesdesk_app;

ALTER TABLE ask_usage
  ADD COLUMN listen integer NOT NULL DEFAULT 0 CHECK (listen >= 0);
