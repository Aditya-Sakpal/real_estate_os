-- ===========================================================================
--  0085_inventory_sync  --  availability kept current, a quote that says
--                           everything a buyer pays, and a token in parts
--
--  A LIVE SHEET, READ EVERY FEW MINUTES
--
--  No CRM publishes a developer's flats through its public API, and the
--  developer's own sheet is where availability is kept. `availability_feeds`
--  is a published sheet's address for a tower or a whole project; the CRM
--  worker reads it every pass, and an unchanged sheet (same hash) writes
--  nothing. What it writes goes through the sheet import's own rules: a flat
--  the CRM wrote is never overwritten by a sheet.
--
--  A PHASE'S OCCUPANCY CERTIFICATE
--
--  GST on a flat is nil once the completion or occupancy certificate is
--  issued. `oc_received_on` is that day, on the phase's registration record,
--  and a quote reads it.
--
--  WHAT ELSE A BUYER PAYS
--
--  Car parking, club membership, the maintenance deposit and legal charges
--  are lines typed on the draft, written once like every other number.
--  Parking and club join the agreement value (they are in `extras`); the
--  deposit and legal charges are outside it, outside GST and outside stamp
--  duty (`charges`). The all-in total adds both.
--
--  A TOKEN PAID IN PARTS
--
--  Up to three parts against one quote, by link, cheque or transfer, mixed.
--  The block holds while the parts come in and books the buyer only when
--  they add up to the token. One link out at a time; each link is its own
--  reference, so each part is its own payment and its own refund. A trigger
--  holds the sum to the token and the count to three.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A published availability sheet
-- ---------------------------------------------------------------------------
CREATE TABLE availability_feeds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- A PHASE (one tower's sheet) or a PROJECT (one sheet naming each tower),
  -- checked in `inventory-feed.ts`.
  scope_node_id    uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  url              text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 2000),
  -- The sheet's bytes as last read: an unchanged sheet writes nothing.
  last_hash        text CHECK (last_hash IS NULL OR last_hash ~ '^[0-9a-f]{64}$'),
  last_fetched_at  timestamptz,
  last_changed_at  timestamptz,
  -- What the last change did, in counts: never a unit number or a row.
  last_result      jsonb,
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 300),
  -- A lease, so two workers never read one sheet at once.
  claimed_until    timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope_node_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON availability_feeds TO salesdesk_app;
ALTER TABLE availability_feeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY availability_feeds_isolation ON availability_feeds
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- The occupancy certificate
-- ---------------------------------------------------------------------------
ALTER TABLE registration_records ADD COLUMN oc_received_on date;

-- ---------------------------------------------------------------------------
-- What else a buyer pays
-- ---------------------------------------------------------------------------
ALTER TABLE quotes
  ADD COLUMN charges       bigint NOT NULL DEFAULT 0 CHECK (charges >= 0),
  ADD COLUMN charge_lines  jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(charge_lines) = 'array' AND jsonb_array_length(charge_lines) <= 4);

ALTER TABLE quotes DROP CONSTRAINT quotes_all_in;
ALTER TABLE quotes ADD CONSTRAINT quotes_all_in
  CHECK (all_in = price + extras + gst + stamp_duty + registration + charges);

-- ---------------------------------------------------------------------------
-- A token in parts
-- ---------------------------------------------------------------------------

-- Each link has its own reference: the quote, then "n2", "n3" for later links.
ALTER TABLE payment_links DROP CONSTRAINT payment_links_reference_check;
ALTER TABLE payment_links ADD CONSTRAINT payment_links_reference_check
  CHECK (reference ~ '^q[0-9a-f]{32}(n[2-9])?$');
-- One link out at a time; a quote may hold several paid ones.
DROP INDEX payment_links_one_live;
CREATE UNIQUE INDEX payment_links_one_out ON payment_links (quote_id) WHERE status IN ('CREATING', 'CREATED');

-- A cheque or transfer is a part; the same one is never recorded twice.
ALTER TABLE token_payments DROP CONSTRAINT token_payments_quote_id_key;
CREATE UNIQUE INDEX token_payments_one_reference ON token_payments (quote_id, mode, reference);

-- A refund per part paid: a Razorpay payment is refunded on its own.
ALTER TABLE token_refunds DROP CONSTRAINT token_refunds_quote_id_key;
ALTER TABLE token_refunds
  ADD COLUMN link_id           uuid REFERENCES payment_links(id) ON DELETE RESTRICT,
  ADD COLUMN token_payment_id  uuid REFERENCES token_payments(id) ON DELETE RESTRICT,
  ADD CONSTRAINT token_refunds_one_part CHECK (link_id IS NULL OR token_payment_id IS NULL);
CREATE UNIQUE INDEX token_refunds_by_link ON token_refunds (link_id) WHERE link_id IS NOT NULL;
CREATE UNIQUE INDEX token_refunds_by_payment ON token_refunds (token_payment_id) WHERE token_payment_id IS NOT NULL;
CREATE INDEX token_refunds_quote ON token_refunds (org_id, quote_id);
ALTER TABLE token_refunds DROP CONSTRAINT token_refunds_receipt_check;
ALTER TABLE token_refunds ADD CONSTRAINT token_refunds_receipt_check
  CHECK (receipt ~ '^r[0-9a-f]{32}([no][0-9])?$');

-- The parts never add up to more than the token, and never number more than three.
CREATE FUNCTION token_parts_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q_token  bigint;
  parts    integer;
  total    bigint;
BEGIN
  SELECT token INTO q_token FROM quotes WHERE id = NEW.quote_id;
  SELECT
    (SELECT count(*) FROM payment_links WHERE quote_id = NEW.quote_id AND status = 'PAID')
      + (SELECT count(*) FROM token_payments WHERE quote_id = NEW.quote_id),
    coalesce((SELECT sum(amount_paise) / 100 FROM payment_links WHERE quote_id = NEW.quote_id AND status IN ('CREATING', 'CREATED', 'PAID')), 0)
      + coalesce((SELECT sum(amount) FROM token_payments WHERE quote_id = NEW.quote_id), 0)
  INTO parts, total;
  IF total > q_token THEN
    RAISE EXCEPTION 'The parts of a token add up to more than the token' USING ERRCODE = 'check_violation';
  END IF;
  IF parts > 3 THEN
    RAISE EXCEPTION 'A token is paid in three parts at most' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER token_payments_parts AFTER INSERT ON token_payments
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION token_parts_check();
CREATE CONSTRAINT TRIGGER payment_links_parts AFTER INSERT ON payment_links
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION token_parts_check();
