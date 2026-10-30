-- ===========================================================================
--  0122_kyc_on_our_site  --  the client's KYC on our own screen
--
--  The client types its PAN and GST (or CIN) on Settings, Calling numbers
--  and we send them to Vobiz's per-document checks; a person or proprietor
--  gives Aadhaar through DigiLocker, the one step that has to happen on the
--  government's own page. Nothing the client types is kept here: Vobiz holds
--  the documents, we keep only where the check stands.
--
--  `digilocker_request` and `digilocker_state` hold one DigiLocker hand-off
--  while it is under way (the state proves the return is ours). The day's
--  checks are counted, because each one is a paid lookup.
-- ===========================================================================

ALTER TABLE vobiz_subaccounts
  ADD COLUMN digilocker_request text CHECK (digilocker_request IS NULL OR length(digilocker_request) <= 200),
  ADD COLUMN digilocker_state   text CHECK (digilocker_state IS NULL OR digilocker_state ~ '^[0-9a-f]{32,64}$'),
  ADD COLUMN checks_day         date,
  ADD COLUMN checks_today       integer NOT NULL DEFAULT 0 CHECK (checks_today >= 0);

GRANT UPDATE (digilocker_request, digilocker_state, checks_day, checks_today) ON vobiz_subaccounts TO salesdesk_app;
GRANT DELETE ON vobiz_subaccounts TO salesdesk_app;
