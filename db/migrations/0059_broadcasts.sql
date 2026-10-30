-- ===========================================================================
--  0059_broadcasts  --  one approved post to many of a project's own leads,
--                       on WhatsApp, from the developer's own number
--
--  A broadcast is an advertisement: the post's image and one line of its
--  cleared copy, sent as a MARKETING template to the leads of one tower or
--  project who agreed to hear from the developer on WhatsApp. Every gate a
--  Meta ad passes applies to it, and every gate a marketing message passes
--  applies to each person it reaches.
--
--  THE AUDIENCE IS FROZEN AT APPROVAL, THE GATES ARE NOT
--
--  Approving writes one recipient row per lead who survived the filters
--  (opt-out, consent, a partner's claim, the caps, and the rest), so what was
--  approved is what can be sent, never more. Each message is still asked
--  every gate again when it goes: a buyer who wrote STOP after approval, a
--  phase that stopped being advertisable, a credit that ran out.
--
--  WHAT IS STORED
--
--  Ids, enums and counts. The line of copy is the post's own cleared copy,
--  frozen here because a post can be rewritten after it was sent; no phone
--  number is ever on a broadcast row, and the audit rows carry counts only.
--
--  MARKETING STOPS ARE THEIR OWN LEDGER
--
--  A buyer who taps "Stop promotions", or turns marketing off in WhatsApp's
--  own settings, has stopped advertising, not their visit reminders. So it
--  is not a `call_suppressions` row (which stops everything): it is a
--  `message_opt_outs` row, append-only, the newest per number standing.
-- ===========================================================================

CREATE TABLE broadcasts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- The tower or project whose leads it reaches.
  scope_node_id    uuid NOT NULL REFERENCES scope_nodes(id),
  -- The phase whose registration the gate said yes about when it was approved.
  phase_id         uuid REFERENCES scope_nodes(id),

  source           text NOT NULL CHECK (source IN ('STUDIO', 'SCHEDULE')),
  rendered_post_id uuid REFERENCES rendered_posts(id) ON DELETE SET NULL,
  post_creative_id uuid REFERENCES post_creatives(id) ON DELETE SET NULL,

  -- What a buyer sees, frozen: the picture by its key and hash, and one line
  -- of the post's cleared copy.
  media_key        text NOT NULL CHECK (length(media_key) BETWEEN 1 AND 300),
  media_sha256     text NOT NULL CHECK (char_length(media_sha256) = 64),
  line             text NOT NULL CHECK (length(line) BETWEEN 1 AND 300 AND line !~ '[\r\n\t]'),

  -- The filters, as enums only: the stages a lead must be at (empty: any
  -- open stage) and one language version (NULL: every lead in their own).
  stages           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(stages) <= 9),
  voice            text CHECK (voice IS NULL OR voice IN ('ENGLISH', 'HINGLISH', 'MARATHI')),

  -- The developer's number it goes from, resolved at approval.
  number_id        uuid REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,

  -- Counts, never people: who is in it, who was left out and why, the split
  -- by language version, and what it would cost at Meta's price plus 15%.
  audience         integer NOT NULL DEFAULT 0 CHECK (audience BETWEEN 0 AND 5000),
  excluded         jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_voice         jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimate_paise   integer NOT NULL DEFAULT 0 CHECK (estimate_paise >= 0),

  --   DRAFT      built, not approved; nothing will go
  --   APPROVED   approved by somebody holding the budget key; waiting for the worker
  --   SENDING    the worker is sending it in batches
  --   DONE       every recipient was sent to or refused
  --   HALTED     stopped by a gate (the registration, the number's quality)
  --   CANCELLED  a person stopped it
  status           text NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'APPROVED', 'SENDING', 'DONE', 'HALTED', 'CANCELLED')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  -- A code, never a sentence somebody typed.
  halted_reason    text CHECK (halted_reason IS NULL OR halted_reason IN (
                     'REGISTRATION', 'POST', 'QUALITY', 'NUMBER', 'TEMPLATE', 'STOPPED')),
  halted_at        timestamptz,
  stopped_by       uuid REFERENCES users(id) ON DELETE SET NULL,

  -- The picture, uploaded once to Meta on the number that sends it. A media
  -- id lives thirty days.
  meta_media_id    text CHECK (meta_media_id IS NULL OR length(meta_media_id) <= 200),
  meta_media_at    timestamptz,

  lease_until      timestamptz,
  lease_holder     text CHECK (lease_holder IS NULL OR length(lease_holder) <= 100),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT broadcasts_approved CHECK (status IN ('DRAFT', 'CANCELLED') OR approved_at IS NOT NULL),
  CONSTRAINT broadcasts_halted CHECK (status <> 'HALTED' OR halted_reason IS NOT NULL)
);
CREATE INDEX broadcasts_org ON broadcasts (org_id, created_at DESC);
CREATE INDEX broadcasts_due ON broadcasts (org_id) WHERE status IN ('APPROVED', 'SENDING');

CREATE TABLE broadcast_recipients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  broadcast_id     uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  -- The lead, never the number: it is read from the lead when the message goes.
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  voice            text NOT NULL CHECK (voice IN ('ENGLISH', 'HINGLISH', 'MARATHI')),

  --   WAITING    frozen at approval, not sent yet
  --   SENT       a message row exists and Meta took it
  --   REFUSED    a gate said no when it was its turn; `refusal` says which
  --   FAILED     Meta refused it; the message row says why
  --   CANCELLED  the broadcast was stopped or halted before its turn
  status           text NOT NULL DEFAULT 'WAITING'
                     CHECK (status IN ('WAITING', 'SENT', 'REFUSED', 'FAILED', 'CANCELLED')),
  refusal          text CHECK (refusal IS NULL OR refusal ~ '^[A-Z_]{2,40}$'),
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (broadcast_id, lead_id)
);
CREATE INDEX broadcast_recipients_waiting ON broadcast_recipients (broadcast_id, status);

-- Which broadcast a message belongs to, so its receipts, replies and cost
-- can be read per broadcast and the caps can count broadcasts.
ALTER TABLE messages
  ADD COLUMN broadcast_id uuid REFERENCES broadcasts(id) ON DELETE SET NULL;
CREATE INDEX messages_broadcast ON messages (broadcast_id) WHERE broadcast_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Marketing stops
-- ---------------------------------------------------------------------------
CREATE TABLE message_opt_outs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone       text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- What stopped: marketing only. A full stop is `call_suppressions`.
  scope       text NOT NULL DEFAULT 'MARKETING' CHECK (scope IN ('MARKETING')),
  --   BUTTON           the buyer tapped "Stop promotions" on a broadcast
  --   META_PREFERENCE  the buyer turned marketing off in WhatsApp itself
  --   PERSON           somebody here recorded it from a conversation
  source      text NOT NULL CHECK (source IN ('BUTTON', 'META_PREFERENCE', 'PERSON')),
  -- A later row with `resumed` true lifts it (WhatsApp's own "resume").
  resumed     boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_opt_outs_phone ON message_opt_outs (org_id, phone, created_at DESC);

-- ---------------------------------------------------------------------------
-- A schedule may broadcast its approved posts, up to a ceiling a person with
-- the budget key set on the schedule
-- ---------------------------------------------------------------------------
ALTER TABLE post_schedules DROP CONSTRAINT post_schedules_destinations_check;
ALTER TABLE post_schedules ADD CONSTRAINT post_schedules_destinations_check CHECK (
  destinations <@ ARRAY['FACEBOOK_PAGE', 'INSTAGRAM', 'GOOGLE_BUSINESS', 'META_AD', 'WHATSAPP_BROADCAST']::text[]
);
ALTER TABLE post_schedules
  ADD COLUMN broadcast_cap integer CHECK (broadcast_cap IS NULL OR broadcast_cap BETWEEN 1 AND 5000);

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------
-- What went out is a record: nothing is deleted by the application, and a
-- broadcast's picture, line and filters are never rewritten once written.
GRANT SELECT, INSERT ON broadcasts TO salesdesk_app;
GRANT UPDATE (phase_id, number_id, audience, excluded, by_voice, estimate_paise, status, approved_by, approved_at,
              started_at, finished_at, halted_reason, halted_at, stopped_by, meta_media_id, meta_media_at,
              lease_until, lease_holder, updated_at)
  ON broadcasts TO salesdesk_app;
GRANT SELECT, INSERT ON broadcast_recipients TO salesdesk_app;
GRANT UPDATE (status, refusal, message_id, updated_at) ON broadcast_recipients TO salesdesk_app;
GRANT SELECT, INSERT ON message_opt_outs TO salesdesk_app;

ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY broadcasts_isolation ON broadcasts
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY broadcast_recipients_isolation ON broadcast_recipients
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE message_opt_outs ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_opt_outs_isolation ON message_opt_outs
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
