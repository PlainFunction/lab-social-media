-- D1 schema for the core capabilities. One database per client.
-- Create it in Australia:  wrangler d1 create <client>-capabilities --location oc
-- Apply:                   wrangler d1 execute <client>-capabilities --remote --file capabilities/core/schema.sql

CREATE TABLE IF NOT EXISTS audit_log (
  seq     INTEGER PRIMARY KEY,
  at      TEXT    NOT NULL,
  actor   TEXT    NOT NULL,
  action  TEXT    NOT NULL,
  subject TEXT    NOT NULL,
  detail  TEXT    NOT NULL DEFAULT '{}',
  ai      INTEGER NOT NULL DEFAULT 0,
  prev    TEXT    NOT NULL,
  hash    TEXT    NOT NULL
);

-- Payloads are AES-GCM sealed (context "approval:<id>"). Summary is what the
-- owner sees in a notification, so it carries no contact details either.
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed', 'done')),
  ai          INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  decided_by  TEXT,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals (status, expires_at);

CREATE TABLE IF NOT EXISTS run_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  automation  TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  ms          INTEGER NOT NULL,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS run_log_by_automation ON run_log (automation, started_at);

-- Accounts people connected by OAuth (integrations' D1TokenVault). Tokens are
-- sealed (context "connected-account:<name>"); the other columns are for listing.
CREATE TABLE IF NOT EXISTS connected_accounts (
  name          TEXT PRIMARY KEY,
  sealed        TEXT NOT NULL,
  account       TEXT,
  connected_by  TEXT NOT NULL,
  connected_at  TEXT NOT NULL
);

-- OAuth logins in progress (integrations' ConnectedAccounts). id is the SHA-256
-- of the state, so a leaked table can't finish anyone's login. Deleted on use,
-- so each state works once.
CREATE TABLE IF NOT EXISTS oauth_states (
  id          TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- ── Slack agent (core/slack-agent) ──────────────────────────────────────────

-- Messages are AES-GCM sealed (context "conversation:<id>"). Pruned after 30 days.
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  messages    TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_by_age ON conversations (updated_at);

-- One row per model call. Counts and cost only, never content.
CREATE TABLE IF NOT EXISTS spend (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  month          TEXT NOT NULL,
  feature        TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  usd            REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_by_month ON spend (month);

-- What admins changed in Slack, over the config defaults. One row.
CREATE TABLE IF NOT EXISTS settings (
  id          TEXT PRIMARY KEY CHECK (id = 'current'),
  overrides   TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);

-- ── PWA shell (core/pwa) ────────────────────────────────────────────────────

-- People who can open the app. id is also the WebAuthn user handle.
CREATE TABLE IF NOT EXISTS pwa_users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,           -- one of the app's roles (core/pwa/roles.ts)
  created_at  TEXT NOT NULL
);

-- Their passkeys: public keys only. id is the credential id, base64url.
CREATE TABLE IF NOT EXISTS pwa_passkeys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  alg           INTEGER NOT NULL,
  sign_count    INTEGER NOT NULL,
  label         TEXT NOT NULL,
  synced        INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS pwa_passkeys_by_user ON pwa_passkeys (user_id);

-- Invite links. id is the SHA-256 of the link's token. Deleted on use.
CREATE TABLE IF NOT EXISTS pwa_invites (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  user_id     TEXT,
  created_by  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Signed-in devices. id is the SHA-256 of the cookie's token.
CREATE TABLE IF NOT EXISTS pwa_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  passkey_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  seen_at     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pwa_sessions_by_passkey ON pwa_sessions (passkey_id);
CREATE INDEX IF NOT EXISTS pwa_sessions_by_user ON pwa_sessions (user_id);

-- Passkey challenges in flight, five minutes each. id is the SHA-256 of the
-- challenge. Deleted on use, so each works once.
CREATE TABLE IF NOT EXISTS pwa_challenges (
  id          TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Whose device each push subscription is (the subscriptions themselves are
-- sealed in KV). Recovering or removing someone, or removing a device, stops
-- notifications reaching it.
CREATE TABLE IF NOT EXISTS pwa_push (
  endpoint    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  passkey_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pwa_push_by_user ON pwa_push (user_id);

-- Automations waiting for a passkey tap, ten minutes each. Arguments are
-- sealed (context "pwa-call:<id>").
CREATE TABLE IF NOT EXISTS pwa_calls (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  sealed      TEXT NOT NULL,
  challenge   TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
