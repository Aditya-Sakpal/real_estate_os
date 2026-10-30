-- ===========================================================================
--  0018_post_schedules  --  a campaign that runs itself, and never unwatched
--
--  Campaign Studio writes copy when somebody presses a button. A developer
--  does not want a button; they want three posts a week in Marathi and
--  English for as long as Tower C is selling, and they want to be told when
--  one of them could not lawfully go out.
--
--  This is the machine that does that, and the whole of its design is in one
--  sentence: a SCHEDULE fires into a RUN, a run generates CREATIVES, each
--  creative carries a verdict, and the schedule's MODE decides what happens
--  next. AUTO publishes what PASSED. REVIEW waits for a person. Neither of
--  them skips the gate, because AUTO means "publish what passed" and never
--  "publish without asking".
--
--  FIRING TWICE HAS TO BE IMPOSSIBLE, NOT UNLIKELY
--
--  A scheduler that fires twice is ordinary: a retry, two workers, a deploy
--  mid-cycle, a clock that steps back an hour. This one calls paid models and
--  will later spend a developer's own money, so the second fire has to insert
--  nothing rather than merely usually lose a race.
--
--  Two mechanisms, both here rather than in the runner. A run is UNIQUE on
--  (schedule_id, slot), where the slot is the COMPUTED scheduled instant and
--  never now(), so the second fire for one slot conflicts. And work is
--  CLAIMED rather than started: a worker takes a lease with an expiry, only
--  the holder may advance the run, and a worker that dies leaves a lease that
--  expires rather than a run that is stuck forever.
--
--  A CREATIVE HOLDS ITS OWN COPY, RATHER THAN POINTING AT campaign_copy
--
--  This looks like duplication and is not. `campaign_copy` is unique on
--  (brief_id, language, segment) and upserts, because the Studio is a working
--  surface where rewriting replaces: two headlines for one buyer is two
--  answers to one question. A schedule running weekly would therefore have
--  every run destroy the record of what the previous run was cleared against,
--  which is the exact thing `campaign_copy.ground` exists to prevent.
--
--  A run is a record of one moment and its ground moves underneath it: a
--  price is superseded, a registration lapses, a never-say list grows. So the
--  creative keeps the sentences, the verdict, the reasons and the ground it
--  was reached on, and none of it is ever rewritten.
--
--  WHAT IS NOT HERE
--
--  `publish_targets` is not in this migration. It is where a live ad's
--  platform ids and its idempotency key belong, and nothing publishes yet, so
--  it would be a table with no writer. It arrives with the Meta publisher.
--
--  The composite's bytes have columns here and nothing fills them, which is a
--  different case: the composer is the next step and the creative row is
--  where its output lands, so the columns are the seam rather than a
--  placeholder. `doc/post-generation.md` section 5 is the rule they enforce.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The calendar, which belongs to nobody
-- ---------------------------------------------------------------------------
--
-- Almost every occasion that moves a booking in India is lunar, so the date
-- moves year to year and no rule produces it. A table does.
--
-- It carries no tenant's anything, so it is reference data rather than tenant
-- data: no org_id, no RLS, and the app role holds SELECT and nothing else. A
-- tenant that could write this table could move Diwali.
--
-- `verified_at` is load-bearing rather than bookkeeping. The hard stop on a
-- festival offer is computed from this date, so a Diwali seeded one day late
-- publishes "no floor rise until Diwali" on the day after Diwali, which is a
-- false offer under Section 12 with our own table as the cause. A row nobody
-- verified is not used by a run.
CREATE TABLE occasions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable across years, because the opt-in is per occasion and not per
  -- occurrence: a developer who observes Diwali observes it every year.
  key          text NOT NULL,
  name         text NOT NULL,

  year         integer NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  on_date      date NOT NULL,

  -- The field that changes the creative. A greeting occasion carries no offer
  -- and no price at all.
  kind         text NOT NULL CHECK (kind IN ('BUYING', 'GREETING')),

  -- State codes. Empty means everywhere: a Pune developer wishing people a
  -- happy Onam reads as a template nobody configured.
  regions      text[] NOT NULL DEFAULT '{}',

  -- Solar occasions are computable and safe. Everything else is looked up.
  solar        boolean NOT NULL DEFAULT false,

  source       text,
  verified_at  timestamptz,

  UNIQUE (key, year)
);

CREATE INDEX occasions_date_idx ON occasions (on_date);

-- Read only, deliberately. This table is seeded by migration and by nothing
-- else, so no tenant and no server action can move a festival.
GRANT SELECT ON occasions TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Which of them this developer observes
-- ---------------------------------------------------------------------------
--
-- Never inferred. Posting every Hindu festival on behalf of a Muslim or Jain
-- developer is the kind of mistake that ends an account, and there is no
-- signal in the product that could be read as permission.
--
-- Keyed on the occasion KEY rather than an occasion row, so opting into
-- Diwali once covers 2026 and 2027 and every year seeded after them. Opting
-- in per occurrence would mean the feature silently stops at the end of
-- whatever the last seeded year is.
CREATE TABLE occasion_opt_ins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  occasion_key  text NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (org_id, occasion_key)
);

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
CREATE TABLE post_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- A schedule belongs to a brief: the brief says what the push is FOR, and
  -- this says how often. Two schedules on one brief is ordinary, because a
  -- weekday cadence and a weekend one are two rhythms of one campaign.
  brief_id       uuid NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,

  -- The node a run resolves its registration, Brain and library against.
  -- A brief already hangs off a PROJECT or a PHASE and this follows it, which
  -- is checked in `canSchedule()` rather than here for the reason
  -- `canUploadAsset()` states: a CHECK cannot read another table.
  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  name           text NOT NULL CHECK (length(btrim(name)) > 0),

  -- One switch, two machines. REVIEW is the default and the only lawful mode
  -- until the pixel gate exists, which is why nothing here defaults to AUTO.
  mode           text NOT NULL DEFAULT 'REVIEW' CHECK (mode IN ('AUTO', 'REVIEW')),

  -- Sunday 0 through Saturday 6, in IST.
  days_of_week   smallint[] NOT NULL CHECK (
    array_length(days_of_week, 1) BETWEEN 1 AND 7
    AND days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
  ),

  -- Minutes from IST midnight. The publish time, not the generate time.
  at_minute      integer NOT NULL CHECK (at_minute BETWEEN 0 AND 1439),

  -- How far ahead of publishing a run starts. Generation takes minutes and a
  -- person needs lead time to look, so these are two timestamps and not one.
  -- A day is the REVIEW default; AUTO can sit much closer.
  lead_minutes   integer NOT NULL DEFAULT 1440 CHECK (lead_minutes BETWEEN 5 AND 10080),

  -- The column exists so that a second timezone is a migration rather than a
  -- rewrite, and the CHECK exists because only one is actually handled. IST
  -- has no daylight saving and sits a half hour off the hour, which is the
  -- whole reason the arithmetic is explicit rather than left to the server's
  -- own clock.
  tz             text NOT NULL DEFAULT 'Asia/Kolkata' CHECK (tz = 'Asia/Kolkata'),

  -- Our invoice, not the developer's. Every run calls a copy model and will
  -- call an image model, so a misconfigured schedule across fifty phases is a
  -- real bill with no ad account involved at all.
  max_runs_per_day integer NOT NULL DEFAULT 1 CHECK (max_runs_per_day BETWEEN 1 AND 24),

  starts_on      date,
  ends_on        date,
  CONSTRAINT post_schedules_window CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),

  -- The kill switch. Off is a state with a reason attached, because a
  -- schedule somebody stopped during an election window and a schedule
  -- somebody stopped because the campaign ended are different things and the
  -- screen has to say which.
  active         boolean NOT NULL DEFAULT true,
  stopped_reason text,
  stopped_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  stopped_at     timestamptz,

  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX post_schedules_org_idx ON post_schedules (org_id);
CREATE INDEX post_schedules_brief_idx ON post_schedules (brief_id);
CREATE INDEX post_schedules_due_idx ON post_schedules (org_id, active);

-- ---------------------------------------------------------------------------
-- The run
-- ---------------------------------------------------------------------------
CREATE TABLE post_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  schedule_id   uuid NOT NULL REFERENCES post_schedules(id) ON DELETE CASCADE,

  -- The COMPUTED scheduled publish instant. Never now(). This is the column
  -- that makes a double fire impossible rather than unlikely: two workers
  -- computing the same slot write the same value and one of them conflicts.
  slot          timestamptz NOT NULL,

  generate_at   timestamptz NOT NULL,
  publish_at    timestamptz NOT NULL,

  --   PENDING    created, waiting for generate_at
  --   RUNNING    claimed by a worker
  --   GENERATED  creatives exist, waiting on release
  --   RELEASED   released per the mode, which in REVIEW means a person acted
  --   REFUSED    a gate said no before anything was generated or spent
  --   EXPIRED    nobody reviewed in time. It never slips to the next slot.
  --   FAILED     something broke. Distinct from REFUSED on purpose: one is
  --              the product working and the other is the product not.
  state         text NOT NULL DEFAULT 'PENDING' CHECK (state IN
                  ('PENDING', 'RUNNING', 'GENERATED', 'RELEASED',
                   'REFUSED', 'EXPIRED', 'FAILED')),

  -- The lease. A worker that dies leaves an expired lease another may take;
  -- a worker that is merely slow cannot have its work taken while its lease
  -- is live. Both halves matter and neither is the runner's to decide.
  lease_id      uuid,
  lease_until   timestamptz,
  attempts      integer NOT NULL DEFAULT 0,

  -- Why a gate said no, in codes rather than prose. A refusal nobody can see
  -- is a refusal nobody can fix, and a refusal nobody can group is a refusal
  -- nobody can count.
  refusal_code  text,
  refusal_detail text,

  occasion_id   uuid REFERENCES occasions(id) ON DELETE SET NULL,

  written       integer NOT NULL DEFAULT 0,
  passed        integer NOT NULL DEFAULT 0,
  held          integer NOT NULL DEFAULT 0,
  failed        integer NOT NULL DEFAULT 0,

  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (schedule_id, slot)
);

CREATE INDEX post_runs_org_idx ON post_runs (org_id);
CREATE INDEX post_runs_due_idx ON post_runs (state, generate_at);
CREATE INDEX post_runs_publish_idx ON post_runs (state, publish_at);

-- ---------------------------------------------------------------------------
-- The creative
-- ---------------------------------------------------------------------------
CREATE TABLE post_creatives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES post_runs(id) ON DELETE CASCADE,

  language      text NOT NULL,
  segment       text NOT NULL CHECK (segment IN
                  ('END_USER', 'UPGRADER', 'INVESTOR', 'NRI')),

  -- The sentences, kept here rather than referenced. See the header.
  headline      text NOT NULL,
  body          text NOT NULL,
  cta           text NOT NULL,

  verdict       text NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'HOLD')),
  reasons       jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- What the verdict was reached against, frozen. The facts move and this is
  -- what makes "cleared on the 14th, and here is what it was cleared
  -- against" answerable two years later.
  ground        jsonb NOT NULL DEFAULT '{}'::jsonb,
  brain_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  model         text NOT NULL,

  -- The five choices, recorded so the next run can differ. Meta suppresses
  -- repetitive creative, so sameness costs reach before anybody finds it
  -- boring.
  template      text NOT NULL,
  lead_point    text,
  asset_id      uuid REFERENCES assets(id) ON DELETE SET NULL,
  occasion_id   uuid REFERENCES occasions(id) ON DELETE SET NULL,

  -- Every approved input this creative was built from, by hash. The Brain
  -- version, the unit type versions, the asset version, the brand files.
  -- This is what makes "every pixel traces to a named human who approved it"
  -- a checkable claim about a composite rather than only about its parts.
  inputs        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The composite. Empty until the composer exists; these are its seam.
  storage_key   text UNIQUE,
  media_type    text,
  media_bytes   bigint CHECK (media_bytes IS NULL OR media_bytes > 0),

  -- The hash of what a person would be approving: the sentences and the
  -- inputs. Stored rather than computed on read so an approval can pin it.
  content_sha256 text NOT NULL CHECK (char_length(content_sha256) = 64),

  --   DRAFT      generated, nobody has acted
  --   APPROVED   a person said yes, or AUTO released a PASS
  --   REJECTED   a person said no
  --   PUBLISHED  it is live. Nothing sets this yet.
  --   EXPIRED    its slot passed unreviewed, or its occasion did
  state         text NOT NULL DEFAULT 'DRAFT' CHECK (state IN
                  ('DRAFT', 'APPROVED', 'REJECTED', 'PUBLISHED', 'EXPIRED')),

  -- A festival offer is a claim with an expiry, and the stop date is the
  -- occasion's date rather than the schedule's. "No floor rise until Diwali"
  -- published on the 10th when Diwali was the 8th is a false offer, and
  -- Section 12 does not care that a scheduler did it.
  hard_stop_at  timestamptz,

  -- The approval pins the HASH, not the row. It is the fourth use of the
  -- mechanism `brain_signatures`, `asset_approvals` and `unit_type_approvals`
  -- share, and deliberately not a fourth invention.
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  decided_sha256 text CHECK (decided_sha256 IS NULL OR char_length(decided_sha256) = 64),

  -- A reviewer's own words about their own creative. Tenant data under RLS,
  -- and it never reaches `audit_log`, which is the table that holds no free
  -- text somebody typed.
  reject_note   text,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- One block of copy per run: a language times a buyer, never times a
  -- placement. Copy does not change between a 1:1 feed post and a 9:16 story,
  -- the layout does.
  UNIQUE (run_id, language, segment)
);

CREATE INDEX post_creatives_org_idx ON post_creatives (org_id);
CREATE INDEX post_creatives_run_idx ON post_creatives (run_id);
CREATE INDEX post_creatives_queue_idx ON post_creatives (org_id, state);

-- A decision names the bytes it was made about, or it is not a decision.
ALTER TABLE post_creatives ADD CONSTRAINT post_creatives_decision_shape
  CHECK (
    (state IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL)
    AND (decided_at IS NULL) = (decided_sha256 IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON post_schedules TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON post_runs TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON post_creatives TO salesdesk_app;
GRANT SELECT, INSERT, DELETE ON occasion_opt_ins TO salesdesk_app;

ALTER TABLE occasion_opt_ins ENABLE ROW LEVEL SECURITY;
CREATE POLICY occasion_opt_ins_isolation ON occasion_opt_ins
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE post_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_schedules_isolation ON post_schedules
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE post_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_runs_isolation ON post_runs
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE post_creatives ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_creatives_isolation ON post_creatives
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- ---------------------------------------------------------------------------
-- The calendar, seeded
-- ---------------------------------------------------------------------------
--
-- Solar occasions are computed and marked so. The lunar ones are looked up,
-- carry their source, and are only used by a run once verified, because the
-- hard stop on a festival offer is this date and a date that is one day out
-- publishes a false offer automatically.
--
-- Regions are state codes, matching the `state_code` on a registration
-- record. Empty is everywhere.
INSERT INTO occasions (key, name, year, on_date, kind, regions, solar, source, verified_at) VALUES
  -- 2026
  ('makar_sankranti', 'Makar Sankranti',   2026, '2026-01-14', 'GREETING', '{}',       true,  'solar', now()),
  ('republic_day',    'Republic Day',      2026, '2026-01-26', 'GREETING', '{}',       true,  'solar', now()),
  ('holi',            'Holi',              2026, '2026-03-04', 'GREETING', '{}',       false, 'drik panchang', NULL),
  ('gudi_padwa',      'Gudi Padwa',        2026, '2026-03-19', 'BUYING',   '{MH}',     false, 'drik panchang', NULL),
  ('ugadi',           'Ugadi',             2026, '2026-03-19', 'BUYING',   '{KA,AP,TG}', false, 'drik panchang', NULL),
  ('akshaya_tritiya', 'Akshaya Tritiya',   2026, '2026-04-19', 'BUYING',   '{}',       false, 'drik panchang', NULL),
  ('independence_day','Independence Day',  2026, '2026-08-15', 'GREETING', '{}',       true,  'solar', now()),
  ('raksha_bandhan',  'Raksha Bandhan',    2026, '2026-08-28', 'GREETING', '{}',       false, 'drik panchang', NULL),
  ('ganesh_chaturthi','Ganesh Chaturthi',  2026, '2026-09-14', 'GREETING', '{MH}',     false, 'drik panchang', NULL),
  ('onam',            'Onam',              2026, '2026-08-26', 'GREETING', '{KL}',     false, 'drik panchang', NULL),
  ('navratri',        'Navratri begins',   2026, '2026-10-11', 'BUYING',   '{}',       false, 'drik panchang', NULL),
  ('dussehra',        'Dussehra',          2026, '2026-10-20', 'BUYING',   '{}',       false, 'drik panchang', NULL),
  ('diwali',          'Diwali',            2026, '2026-11-08', 'BUYING',   '{}',       false, 'drik panchang', NULL),
  -- 2027
  ('makar_sankranti', 'Makar Sankranti',   2027, '2027-01-14', 'GREETING', '{}',       true,  'solar', now()),
  ('republic_day',    'Republic Day',      2027, '2027-01-26', 'GREETING', '{}',       true,  'solar', now()),
  ('holi',            'Holi',              2027, '2027-03-22', 'GREETING', '{}',       false, 'drik panchang', NULL),
  ('gudi_padwa',      'Gudi Padwa',        2027, '2027-04-07', 'BUYING',   '{MH}',     false, 'drik panchang', NULL),
  ('ugadi',           'Ugadi',             2027, '2027-04-07', 'BUYING',   '{KA,AP,TG}', false, 'drik panchang', NULL),
  ('akshaya_tritiya', 'Akshaya Tritiya',   2027, '2027-05-08', 'BUYING',   '{}',       false, 'drik panchang', NULL),
  ('independence_day','Independence Day',  2027, '2027-08-15', 'GREETING', '{}',       true,  'solar', now()),
  ('raksha_bandhan',  'Raksha Bandhan',    2027, '2027-08-17', 'GREETING', '{}',       false, 'drik panchang', NULL),
  ('onam',            'Onam',              2027, '2027-09-14', 'GREETING', '{KL}',     false, 'drik panchang', NULL),
  ('ganesh_chaturthi','Ganesh Chaturthi',  2027, '2027-09-04', 'GREETING', '{MH}',     false, 'drik panchang', NULL),
  ('navratri',        'Navratri begins',   2027, '2027-09-30', 'BUYING',   '{}',       false, 'drik panchang', NULL),
  ('dussehra',        'Dussehra',          2027, '2027-10-09', 'BUYING',   '{}',       false, 'drik panchang', NULL),
  ('diwali',          'Diwali',            2027, '2027-10-29', 'BUYING',   '{}',       false, 'drik panchang', NULL);
