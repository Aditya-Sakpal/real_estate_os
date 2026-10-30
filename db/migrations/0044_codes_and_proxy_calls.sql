-- ===========================================================================
--  0044_codes_and_proxy_calls  --  one-time codes, a person's own number, and
--                                  calls a person makes through our number
--
--  ONE-TIME CODES ARE IDENTITY, NOT TENANT DATA
--
--  A code proves somebody holds a phone. It is asked for before anybody is
--  signed in (a channel partner signing in) as well as after, so it lives
--  beside `users`, on the control connection, the way sign-in does. RLS is
--  on and no policy exists, and the app role holds no grant at all: from the
--  application's own role this table is not there.
--
--  Nothing readable is stored. The code is an HMAC keyed by the challenge's
--  id, and the phone a sha256, so the row answers "was this the number the
--  code went to" without holding it. `cost_paise` and `org_id` are the paid
--  call naming its tenant and its unit: a WhatsApp authentication message.
--
--  A PERSON'S OWN NUMBER
--
--  `users.phone` was reserved for this and never written. It is now written
--  once a code sent to it comes back, and is the phone a call through our
--  number rings first. It must be E.164, like every other number here.
--
--  A CALL THROUGH OUR NUMBER
--
--  Vobiz rings the person's own phone from our number, then connects the
--  buyer, so neither sees the other's number. One row per call, in the
--  tenant, carrying who pressed Call and how long Vobiz billed. The buyer's
--  number is not copied here: it is read from the lead when the call is
--  answered, and the row points at the lead.
-- ===========================================================================

ALTER TABLE users
  ADD CONSTRAINT users_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');

CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose      text NOT NULL CHECK (purpose IN ('VERIFY_PHONE', 'SIGN_IN', 'STEP_UP')),
  phone_hash   text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  code_hash    text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  -- Who asked, when somebody is signed in. Gone with them.
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  -- Whose cost it was, when that is known.
  org_id       uuid REFERENCES orgs(id) ON DELETE SET NULL,
  -- A step-up is for one action on one thing, and nothing else.
  action       text CHECK (action IS NULL OR length(action) <= 64),
  target_id    text CHECK (target_id IS NULL OR length(target_id) <= 100),
  ip_hash      text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  attempts     smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sent         boolean NOT NULL DEFAULT false,
  cost_paise   integer NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX otp_challenges_phone ON otp_challenges (phone_hash, created_at DESC);
CREATE INDEX otp_challenges_ip ON otp_challenges (ip_hash, created_at DESC) WHERE ip_hash IS NOT NULL;
CREATE INDEX otp_challenges_day ON otp_challenges (created_at);

ALTER TABLE otp_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON otp_challenges FROM salesdesk_app;

CREATE TABLE proxy_calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  -- The lead's tower, where the minutes and the lines are counted.
  scope_node_id    uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE RESTRICT,
  caller_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  --   RINGING    Vobiz is ringing the caller's own phone
  --   CONNECTED  the caller picked up and the buyer is being rung, or talking
  --   ENDED      over; `bill_s` is what Vobiz billed for the buyer's leg
  --   FAILED     never got as far as the caller
  status           text NOT NULL DEFAULT 'RINGING' CHECK (status IN ('RINGING', 'CONNECTED', 'ENDED', 'FAILED')),
  vobiz_call_uuid  text CHECK (vobiz_call_uuid IS NULL OR length(vobiz_call_uuid) <= 100),
  bill_s           integer CHECK (bill_s IS NULL OR bill_s >= 0),
  failure          text CHECK (failure IS NULL OR length(failure) <= 300),
  placed_at        timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE INDEX proxy_calls_lead ON proxy_calls (org_id, lead_id, placed_at DESC);
CREATE INDEX proxy_calls_live ON proxy_calls (org_id, placed_at) WHERE status IN ('RINGING', 'CONNECTED');

GRANT SELECT, INSERT ON proxy_calls TO salesdesk_app;
GRANT UPDATE (status, vobiz_call_uuid, bill_s, failure, ended_at) ON proxy_calls TO salesdesk_app;

ALTER TABLE proxy_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY proxy_calls_isolation ON proxy_calls
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
