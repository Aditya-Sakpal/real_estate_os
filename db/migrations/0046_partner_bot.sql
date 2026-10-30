-- ===========================================================================
--  0046_partner_bot  --  the people at a firm who use the developer's
--                        WhatsApp, what the bot is waiting on, and the
--                        buyer who writes in through a partner's link
--
--  WHATSAPP IS THE PARTNER'S PRODUCT
--
--  Section 07: a partner firm's agents never install anything. They write to
--  the developer's own WhatsApp number (0045), and the bot registers buyers,
--  books visits, answers for payouts and sends co-branded creative. The
--  number is proved once with a code and is then the credential: weak, so
--  what it can do is reduced, and three things ask for a fresh code each
--  time (confirming an invoice, seeing a whole number, an export).
--
--  WHO MAY SPEAK FOR A FIRM HERE
--
--  `partner_agents` is the developer's own list: the people it lets use its
--  number on a firm's behalf, added by its relationship manager, the firm's
--  principal first. It is this tenant's row, like `partner_firms`, so no
--  tenant writes what another reads. A person on it who proves the number
--  becomes a global user known only by that phone (the CHECK below), with a
--  membership in the FIRM's own org. The developer holds no membership for
--  them. The firm's own screens, where its owner manages its people, come
--  with partner sign-in (build prompt 10); until then that membership
--  grants nothing anywhere.
--
--  WHAT THE BOT IS WAITING ON
--
--  One thing per person at a time: the code that proves the number, the code
--  for one action, a yes to a write (a visit slot is held 90 seconds while
--  it waits), or a pick from a list it sent. `action` is the fixed action and
--  its arguments by id, never free text. A buyer's number is held in it only
--  while a pick is open (which project to register them on), and is taken out
--  when the row is closed.
--
--  THE BUYER WHO TAPS A PARTNER'S LINK
--
--  A partner's link now opens WhatsApp to the developer's number with the
--  ref code written in. The buyer's first message is a lead event of its own
--  kind, and becomes the lead and the partner's claim in one transaction.
-- ===========================================================================

-- A partner firm created by a developer has no admin until its owner signs
-- up, so its memberships could never be changed: the last-admin rule (0007)
-- counted admins on every change to any membership. It now asks only when
-- the row changed was an active admin, which is the only change that can
-- take the count down. Everything it protected, it still protects.
CREATE OR REPLACE FUNCTION assert_org_keeps_an_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_org uuid := COALESCE(NEW.org_id, OLD.org_id);
  admins int;
  org_alive boolean;
BEGIN
  IF NOT (OLD.role = 'ORG_ADMIN' AND OLD.status = 'ACTIVE') THEN
    RETURN NULL;
  END IF;

  SELECT status <> 'SUSPENDED' INTO org_alive FROM orgs WHERE id = target_org;
  IF org_alive IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO admins
  FROM memberships
  WHERE org_id = target_org AND role = 'ORG_ADMIN' AND status = 'ACTIVE';

  IF admins = 0 THEN
    RAISE EXCEPTION
      'An organisation must keep at least one active admin'
      USING ERRCODE = 'check_violation',
            HINT = 'Promote someone else before giving up or removing the last ORG_ADMIN.';
  END IF;

  RETURN NULL;
END;
$$;

-- A person known only by the phone they proved.
ALTER TABLE users DROP CONSTRAINT users_named_unless_erased;
ALTER TABLE users ADD CONSTRAINT users_named_unless_erased
  CHECK (erased_at IS NOT NULL OR email IS NOT NULL OR (phone IS NOT NULL AND phone_verified_at IS NOT NULL));

CREATE TABLE partner_agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  firm_id       uuid NOT NULL REFERENCES partner_firms(id) ON DELETE CASCADE,
  cp_org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone         text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- The firm's principal, who hears about every payout.
  is_principal  boolean NOT NULL DEFAULT false,
  --   WAITING  on the list; has not proved the number yet
  --   ACTIVE   proved it; the bot answers them
  --   REMOVED  taken off; the bot no longer knows them
  status        text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'ACTIVE', 'REMOVED')),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  bound_at      timestamptz,
  -- They wrote STOP: nothing unprompted goes to them. The bot still answers.
  muted_at      timestamptz,
  removed_at    timestamptz,
  removed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  added_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_agents_bound CHECK (status <> 'ACTIVE' OR bound_at IS NOT NULL),
  CONSTRAINT partner_agents_removed CHECK ((status = 'REMOVED') = (removed_at IS NOT NULL))
);
-- One number speaks for one firm here: the bot has to know which.
CREATE UNIQUE INDEX partner_agents_phone ON partner_agents (org_id, phone) WHERE status <> 'REMOVED';
CREATE INDEX partner_agents_firm ON partner_agents (org_id, firm_id);

GRANT SELECT, INSERT ON partner_agents TO salesdesk_app;
GRANT UPDATE (name, status, user_id, bound_at, muted_at, removed_at, removed_by, updated_at) ON partner_agents TO salesdesk_app;

ALTER TABLE partner_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_agents_isolation ON partner_agents
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

CREATE TABLE partner_bot_pending (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES partner_agents(id) ON DELETE CASCADE,
  --   BIND     the code that proves the number
  --   STEP_UP  the code for one action
  --   CONFIRM  a yes to a write
  --   CHOOSE   a number from a list the bot sent
  kind          text NOT NULL CHECK (kind IN ('BIND', 'STEP_UP', 'CONFIRM', 'CHOOSE')),
  action        jsonb NOT NULL,
  -- The code's challenge (control plane, so no foreign key reaches it).
  challenge_id  uuid,
  expires_at    timestamptz NOT NULL,
  done_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (kind NOT IN ('BIND', 'STEP_UP') OR challenge_id IS NOT NULL)
);
CREATE UNIQUE INDEX partner_bot_pending_one ON partner_bot_pending (agent_id) WHERE done_at IS NULL;

GRANT SELECT, INSERT ON partner_bot_pending TO salesdesk_app;
GRANT UPDATE (done_at, action) ON partner_bot_pending TO salesdesk_app;

ALTER TABLE partner_bot_pending ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_bot_pending_isolation ON partner_bot_pending
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- Every message the bot read, what it made of it, and what reading it cost.
CREATE TABLE partner_bot_turns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES partner_agents(id) ON DELETE CASCADE,
  firm_id     uuid NOT NULL REFERENCES partner_firms(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES messages(id) ON DELETE SET NULL,
  action      text NOT NULL CHECK (action ~ '^[a-z_]{1,40}$'),
  --   DONE    it did what was asked
  --   ASKED   it asked something back (a code, a yes, a pick)
  --   REFUSED a rule said no, and the reply said why
  --   UNCLEAR it could not tell what was asked
  --   CAPPED  over the day's allowance, and not read
  outcome     text NOT NULL CHECK (outcome IN ('DONE', 'ASKED', 'REFUSED', 'UNCLEAR', 'CAPPED')),
  model       text CHECK (model IS NULL OR length(model) <= 60),
  usd         numeric(10, 6) CHECK (usd IS NULL OR usd >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_bot_turns_agent ON partner_bot_turns (org_id, agent_id, created_at DESC);
CREATE INDEX partner_bot_turns_firm ON partner_bot_turns (org_id, firm_id, created_at DESC);

GRANT SELECT, INSERT ON partner_bot_turns TO salesdesk_app;

ALTER TABLE partner_bot_turns ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_bot_turns_isolation ON partner_bot_turns
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- Which person at a firm a message was to or from, and the project a paid
-- one is counted against (a partner's message has no lead to name it).
ALTER TABLE messages
  ADD COLUMN partner_agent_id uuid REFERENCES partner_agents(id) ON DELETE SET NULL,
  ADD COLUMN scope_node_id    uuid REFERENCES scope_nodes(id) ON DELETE SET NULL;
CREATE INDEX messages_partner ON messages (partner_agent_id, created_at DESC) WHERE partner_agent_id IS NOT NULL;

-- Which person at the firm made a claim, when the bot made it.
ALTER TABLE client_registrations
  ADD COLUMN agent_id uuid REFERENCES partner_agents(id) ON DELETE SET NULL;

-- The firm's own confirmation of an invoice, with a fresh code.
ALTER TABLE partner_invoices
  ADD COLUMN attested_by uuid REFERENCES users(id) ON DELETE SET NULL;
GRANT UPDATE (attested_at, attested_by) ON partner_invoices TO salesdesk_app;

-- A buyer who wrote in on WhatsApp through a partner's link.
ALTER TABLE lead_events DROP CONSTRAINT lead_events_source_check;
ALTER TABLE lead_events ADD CONSTRAINT lead_events_source_check
  CHECK (source IN ('META_FORM', 'GOOGLE_FORM', 'WEBSITE', 'WHATSAPP'));
ALTER TABLE leads DROP CONSTRAINT leads_channel_check;
ALTER TABLE leads ADD CONSTRAINT leads_channel_check
  CHECK (channel IN ('META_FORM', 'GOOGLE_FORM', 'WEBSITE', 'MANUAL', 'CRM', 'WHATSAPP'));
