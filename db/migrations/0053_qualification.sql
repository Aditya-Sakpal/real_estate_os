-- ===========================================================================
--  0053_qualification  --  what a call learned about the buyer, how sure we
--                          are, the score, the route, and the hot buyer put
--                          straight through to a person
--
--  NINE FIELDS, EACH WITH THE BUYER'S OWN WORDS
--
--  A qualifying call is read after it ends (`qualify.ts`), and nine things
--  the buyer said are kept as `{ value, confidence, span }`: the span is the
--  buyer's own words, found in the transcript, and a field without one is
--  not kept at all. `calls.qualification` is what that call heard;
--  `leads.qualification` is the lead's merged view, the surer answer
--  winning. `leads.score` is arithmetic with the tenant's weights, and
--  `leads.route` is where section 02's table sends the lead.
--
--  THE TENANT'S KNOBS
--
--  Weights, the hot and warm floors, the localities it sells in, the
--  projects it competes with, and the people who take buyers calling from
--  outside India, beside the lookback 0051 put here.
--
--  A HOT BUYER, PUT THROUGH
--
--  A hot buyer the agent did not put through on the call is: a free sales
--  person is rung from our number, hears who is waiting, and a key press
--  dials the buyer. It is a call through our number like any other, so it
--  is a `proxy_calls` row (0044), marked BRIDGE, naming the person rung and
--  the AI call it follows.
-- ===========================================================================

ALTER TABLE calls ADD COLUMN qualification jsonb;

ALTER TABLE leads
  ADD COLUMN qualification jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN score smallint CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  ADD COLUMN route text CHECK (route IS NULL OR route IN ('JUNK', 'CP', 'NRI', 'HOT', 'WARM', 'COLD'));

ALTER TABLE lead_settings
  ADD COLUMN weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN hot_floor smallint NOT NULL DEFAULT 70 CHECK (hot_floor BETWEEN 0 AND 100),
  ADD COLUMN warm_floor smallint NOT NULL DEFAULT 40 CHECK (warm_floor BETWEEN 0 AND 100),
  ADD COLUMN micro_markets text[] NOT NULL DEFAULT '{}' CHECK (cardinality(micro_markets) <= 50),
  ADD COLUMN competitors text[] NOT NULL DEFAULT '{}' CHECK (cardinality(competitors) <= 50),
  -- Members who take buyers calling from outside India. Ids, checked on save.
  ADD COLUMN nri_desk uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(nri_desk) <= 20),
  ADD CONSTRAINT lead_settings_floors CHECK (warm_floor < hot_floor);

ALTER TABLE proxy_calls
  ADD COLUMN kind text NOT NULL DEFAULT 'PERSON' CHECK (kind IN ('PERSON', 'BRIDGE')),
  -- A bridge rings a sales person from the sales team, not a user's own phone.
  ADD COLUMN to_number text CHECK (to_number IS NULL OR to_number ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN after_call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  ADD COLUMN accepted_at timestamptz,
  ADD CONSTRAINT proxy_calls_bridge CHECK ((kind = 'BRIDGE') = (to_number IS NOT NULL));

GRANT UPDATE (accepted_at) ON proxy_calls TO salesdesk_app;
