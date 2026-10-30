-- What a person typed beside the files of a project set up in Ask Jimmy is
-- filed as a document of its own, "Notes from the developer", and read into
-- the Brain like any other: each value proposed, with the line it came from,
-- for a person to check.
ALTER TABLE brain_documents DROP CONSTRAINT brain_documents_kind_check;
ALTER TABLE brain_documents ADD CONSTRAINT brain_documents_kind_check CHECK (kind IN (
  'RERA_CERTIFICATE', 'AGREEMENT', 'PRICE_LIST', 'PAYMENT_PLAN',
  'BROCHURE', 'AMENITIES', 'FLOOR_PLANS', 'SPECIFICATIONS', 'LOCATION',
  'DEVELOPER_NOTE'));
