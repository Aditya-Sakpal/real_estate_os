-- ===========================================================================
--  0048_rera_states  --  a registration outside Maharashtra, and the dates
--                        an authority moves without asking anybody
--
--  WHAT THE AUTHORITY SAID, KEPT
--
--  `registered_on` is the day the authority registered it, read off the
--  portal where the portal says, or typed from the certificate. It decides
--  whether an order extending "every registration made before 1 August"
--  reaches this one. `portal_ref` is the authority's own id for the project
--  (West Bengal's procode, Gujarat's entity id), which some published lists
--  key on instead of the number.
--
--  EXTENSIONS NOBODY APPLIED FOR
--
--  On 31 July 2026 the Ministry of Housing advised every authority to extend
--  completion by four months for the West Asia war, and MahaRERA, K-RERA,
--  TNRERA and TGRERA did, with no application from anybody. The client's
--  typed date does not move when that happens, so `extended_until` holds the
--  later date and `extension_ref` the order that gave it: a date with no
--  order behind it is a date somebody made up, hence the CHECK. The gate
--  reads whichever of the two is later.
--
--  TELANGANA'S PERMIT
--
--  TGRERA wants the local authority's building permit number (HMDA, GHMC or
--  DTCP) printed beside the registration on every advertisement.
--  `permit_no` is that number, typed from the permit.
-- ===========================================================================

ALTER TABLE registration_records
  ADD COLUMN registered_on  date,
  ADD COLUMN extended_until date,
  ADD COLUMN extension_ref  text,
  ADD COLUMN portal_ref     text,
  ADD COLUMN permit_no      text;

ALTER TABLE registration_records
  ADD CONSTRAINT registration_extension_has_ref
    CHECK (extended_until IS NULL OR extension_ref IS NOT NULL),
  ADD CONSTRAINT registration_permit_short
    CHECK (permit_no IS NULL OR length(permit_no) BETWEEN 3 AND 80);
