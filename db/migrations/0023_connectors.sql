-- ===========================================================================
--  0023_connectors  --  the developer's own Meta and Google accounts, and
--                       what was published into them
--
--  Every post so far ended at a download button. This is where a post goes
--  out: to the developer's Facebook Page and Instagram account, as a paused
--  ad in their Meta ad account, as a paused display ad in their Google Ads
--  account, and to their Google Business Profile.
--
--  THE ACCOUNTS ARE THE DEVELOPER'S, NOT OURS
--
--  Section 06 is explicit: every tenant brings its own Meta and Google
--  accounts, held per tenant. That is blast-radius control. Meta strikes a
--  business, not a platform, and one developer's disapproved ad must not
--  reach another's account. So a connection belongs to one organisation, its
--  token is encrypted with a key derived for that organisation alone, and the
--  row carries the tenant the same way every other row does.
--
--  WHAT IS STORED IS CIPHERTEXT
--
--  `secret` is AES-256-GCM, sealed by `src/lib/vault.ts` with a key derived
--  from the server's master key and this row's org id, and bound to the row
--  it belongs to. A ciphertext copied into another tenant's row does not
--  open. A token never reaches `audit_log`, a screen or a log line.
--
--  A DISCONNECTED ROW HOLDS NO SECRET
--
--  Disconnecting scrubs the token rather than deleting the row, because what
--  was published through it has to stay answerable: which account, which
--  person, which registration. The CHECK below makes "disconnected but still
--  holding a working token" impossible rather than unlikely.
--
--  PUBLISHING IS A RECORD, NOT A BUTTON
--
--  `publish_targets` is the table `0018` promised and deliberately left out
--  until something wrote to it. One row per post per destination: what went
--  out, word for word and file for file, which registration the gate said
--  yes about, and every id the platform handed back, so the kill switch can
--  find a live ad and pause it.
--
--  It is unique on an idempotency key derived from the post and the account,
--  so pressing Publish twice, or two workers, or a retry after a crash, all
--  land on one row. Every step the platform confirms is written before the
--  next is attempted, so a retry resumes rather than repeats.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The connection: one per provider per organisation
-- ---------------------------------------------------------------------------
CREATE TABLE connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  provider         text NOT NULL CHECK (provider IN ('META', 'GOOGLE')),

  --   PENDING       consented, nothing chosen yet
  --   CONNECTED     accounts chosen, token working
  --   BROKEN        the token stopped working; somebody has to reconnect
  --   DISCONNECTED  a person disconnected it, or Meta told us the person
  --                 removed the app. No secret, by CHECK.
  status           text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'CONNECTED', 'BROKEN', 'DISCONNECTED')),

  secret           bytea,
  key_version      smallint,
  -- NULL means the token does not expire (a Meta system-user token, or a
  -- Google refresh token, which lives until revoked).
  token_expires_at timestamptz,
  scopes           text[] NOT NULL DEFAULT '{}',

  -- Meta's app-scoped id for the person who consented. Needed for one thing:
  -- when that person removes the app, Meta calls us with this id and nothing
  -- else, and the token it names has to be scrubbed.
  external_user_id text,

  -- What the person may pick from, read at consent: [{ kind, id, name, detail }].
  -- Names and ids only. A Page's own token is fetched at the moment it is
  -- chosen and never parked here.
  choices          jsonb NOT NULL DEFAULT '[]'::jsonb,
  choices_at       timestamptz,

  connected_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at     timestamptz,
  last_checked_at  timestamptz,
  -- A code a screen can group on, and the platform's own words, trimmed.
  last_error_code  text,
  last_error       text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT connections_scrubbed CHECK (status <> 'DISCONNECTED' OR secret IS NULL),
  CONSTRAINT connections_keyed CHECK (secret IS NULL OR key_version IS NOT NULL)
);

-- One live connection per provider. Reconnecting replaces the token on the
-- live row, so the accounts chosen under it survive a reconnect.
CREATE UNIQUE INDEX connections_one_live ON connections (org_id, provider)
  WHERE status <> 'DISCONNECTED';
CREATE INDEX connections_org_idx ON connections (org_id);

-- ---------------------------------------------------------------------------
-- The accounts chosen under a connection, and where each one is used
-- ---------------------------------------------------------------------------
--
-- A person who consents to Meta may manage six Pages. They choose which ones
-- this organisation publishes to, and where in the tree each is used: a group
-- running two brands points the second entity at the second Page, the way
-- the brand kit overrides at an ENTITY. Resolution is the brand kit's: the
-- deepest active account of a kind at or above the node wins.
CREATE TABLE connection_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

  kind           text NOT NULL CHECK (kind IN (
                   'FACEBOOK_PAGE', 'INSTAGRAM', 'META_AD_ACCOUNT',
                   'GOOGLE_ADS_CUSTOMER', 'GOOGLE_BUSINESS_LOCATION')),
  external_id    text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  name           text NOT NULL,
  -- Currency, an Instagram handle and the Page it hangs off, a Business
  -- Profile's account, a manager account. Never a token.
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- A Facebook Page's own token. It is what posts to the Page, and one
  -- derived from a long-lived user token does not expire.
  secret         bytea,
  key_version    smallint,

  scope_node_id  uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,

  -- Spend authority, recorded rather than assumed: the most one ad created
  -- from this account may spend in a day, in rupees. NULL means nobody has
  -- set one, and no ad is created until somebody holding the budget key does.
  daily_cap      integer CHECK (daily_cap IS NULL OR daily_cap BETWEEN 100 AND 10000000),

  active         boolean NOT NULL DEFAULT true,
  added_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (connection_id, kind, external_id),
  CONSTRAINT connection_accounts_keyed CHECK (secret IS NULL OR key_version IS NOT NULL)
);

-- One account of a kind per place. Two Pages both claiming the organisation
-- would leave "where does this post go" to whichever row a query read first.
CREATE UNIQUE INDEX connection_accounts_one_per_node
  ON connection_accounts (org_id, kind, scope_node_id) WHERE active;
CREATE INDEX connection_accounts_org_idx ON connection_accounts (org_id);

-- ---------------------------------------------------------------------------
-- What was published, where
-- ---------------------------------------------------------------------------
CREATE TABLE publish_targets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- Where it came from: a studio post somebody chose to publish, or a
  -- scheduled creative somebody approved. Nulled rather than cascaded when
  -- the source goes, because the post is still out there.
  source           text NOT NULL CHECK (source IN ('STUDIO', 'SCHEDULE')),
  rendered_post_id uuid REFERENCES rendered_posts(id) ON DELETE SET NULL,
  post_creative_id uuid REFERENCES post_creatives(id) ON DELETE SET NULL,

  destination      text NOT NULL CHECK (destination IN (
                     'FACEBOOK_PAGE', 'INSTAGRAM', 'META_AD',
                     'GOOGLE_DISPLAY_AD', 'GOOGLE_BUSINESS')),
  account_id       uuid NOT NULL REFERENCES connection_accounts(id),

  -- What went out, frozen. The source can be rewritten or removed; this is
  -- the record of the words and files a buyer actually saw.
  kind             text NOT NULL CHECK (kind IN ('IMAGE', 'CAROUSEL', 'VIDEO')),
  placement        text,
  headline         text NOT NULL,
  caption          text NOT NULL,
  -- [{ key, type, width, height }], in the order they are shown.
  media            jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_sha256   text NOT NULL CHECK (char_length(content_sha256) = 64),

  -- The node advertised, and the phase whose registration the gate said yes
  -- about. The kill switch keys on the phase: when it stops being
  -- advertisable, every live ad carrying its number pauses.
  scope_node_id    uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  phase_id         uuid NOT NULL REFERENCES scope_nodes(id) ON DELETE CASCADE,
  registration_no  text,

  --   QUEUED     waiting for a worker, or for its time
  --   WORKING    a worker holds it
  --   LIVE       an organic post is up
  --   PAUSED     an ad exists and is not spending
  --   ACTIVE     an ad is spending
  --   FAILED     it could not be published; the reason is on the row
  --   CANCELLED  the gate closed before it went out
  state            text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
                     'QUEUED', 'WORKING', 'LIVE', 'PAUSED', 'ACTIVE', 'FAILED', 'CANCELLED')),

  idempotency_key  text NOT NULL CHECK (char_length(idempotency_key) = 64),

  -- Every id the platform confirmed, written as it is confirmed, so a retry
  -- resumes at the first step that has no id rather than creating twice.
  steps            jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Ads only. Rupees a day, and the page the ad sends people to.
  daily_budget     integer CHECK (daily_budget IS NULL OR daily_budget > 0),
  destination_url  text,

  attempts         integer NOT NULL DEFAULT 0,
  lease_id         uuid,
  lease_until      timestamptz,
  not_before       timestamptz NOT NULL DEFAULT now(),

  error_code       text,
  error            text,
  external_url     text,

  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at     timestamptz,
  paused_at        timestamptz,
  paused_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  --   PERSON        somebody pressed Pause
  --   REGISTRATION  the phase stopped being advertisable
  paused_reason    text CHECK (paused_reason IN ('PERSON', 'REGISTRATION')),
  activated_at     timestamptz,
  activated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- An organic post still up on a phase that is no longer advertisable. The
  -- platforms give no reliable way to take one down, so a person does, and
  -- the screen lists it until they have.
  blocked_at       timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (org_id, idempotency_key),
  CONSTRAINT publish_targets_one_source
    CHECK (rendered_post_id IS NULL OR post_creative_id IS NULL),
  CONSTRAINT publish_targets_ad_budget
    CHECK ((destination IN ('META_AD', 'GOOGLE_DISPLAY_AD')) = (daily_budget IS NOT NULL))
);

CREATE INDEX publish_targets_org_idx ON publish_targets (org_id, created_at DESC);
CREATE INDEX publish_targets_due_idx ON publish_targets (state, not_before);
CREATE INDEX publish_targets_phase_idx ON publish_targets (org_id, phase_id, state);
CREATE INDEX publish_targets_post_idx ON publish_targets (rendered_post_id);
CREATE INDEX publish_targets_creative_idx ON publish_targets (post_creative_id);

-- ---------------------------------------------------------------------------
-- Where a schedule's approved posts go
-- ---------------------------------------------------------------------------
--
-- Organic destinations only. A schedule that created ads would start spend
-- three times a week without a person choosing a budget each time, and
-- starting spend is a decision, never a cadence.
ALTER TABLE post_schedules
  ADD COLUMN destinations text[] NOT NULL DEFAULT '{}' CHECK (
    destinations <@ ARRAY['FACEBOOK_PAGE', 'INSTAGRAM', 'GOOGLE_BUSINESS']::text[]
  );

-- Why an approved scheduled post has not gone out: no account for this
-- project, a connection that needs reconnecting, copy that no longer clears.
-- Asked again every pass until its window closes, so fixing the cause inside
-- the window is enough, and cleared the moment it goes out.
ALTER TABLE post_creatives ADD COLUMN publish_note text;

-- 0018 wrote the decision's shape before anything published, and so said a
-- decision belongs to APPROVED and REJECTED only. A published creative was
-- approved first and still carries who approved it and what they approved,
-- which is the whole point of pinning the hash; the old CHECK refused the
-- first post that went out.
ALTER TABLE post_creatives DROP CONSTRAINT post_creatives_decision_shape;
ALTER TABLE post_creatives ADD CONSTRAINT post_creatives_decision_shape
  CHECK (
    (state IN ('APPROVED', 'REJECTED', 'PUBLISHED')) = (decided_at IS NOT NULL)
    AND (decided_at IS NULL) = (decided_sha256 IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Meta's callbacks name a person, not a tenant
-- ---------------------------------------------------------------------------
--
-- When somebody removes the app from their Facebook account, or asks Meta to
-- delete their data, Meta calls us with their app-scoped id and nothing else.
-- Finding the connections that id authorised means reading across tenants,
-- which the app role cannot do and should not be able to.
--
-- This function is the whole of that exception. It returns org ids and
-- connection ids for one external id and one provider, nothing else, and it
-- runs as the owner so RLS does not hide the rows. Everything done with the
-- answer happens back inside `withTenant()`.
CREATE FUNCTION connections_for_external_user(p_provider text, p_external_user_id text)
RETURNS TABLE (org_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.org_id, c.id FROM connections c
  WHERE c.provider = p_provider
    AND c.external_user_id = p_external_user_id
    AND c.status <> 'DISCONNECTED'
    AND length(p_external_user_id) BETWEEN 1 AND 100;
$$;
REVOKE ALL ON FUNCTION connections_for_external_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connections_for_external_user(text, text) TO salesdesk_app;

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON connections TO salesdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connection_accounts TO salesdesk_app;
-- No DELETE. A publication is the record of an advertisement a buyer saw, and
-- the only ways out of this table are the org going and a scope node going.
GRANT SELECT, INSERT, UPDATE ON publish_targets TO salesdesk_app;

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY connections_isolation ON connections
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE connection_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY connection_accounts_isolation ON connection_accounts
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE publish_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY publish_targets_isolation ON publish_targets
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
