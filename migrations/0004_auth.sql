-- Cookie auth: /login in Telegram mints a one-time token; /auth exchanges it
-- for a long-lived session cookie. Keys-in-URLs become a debug-only fallback.
CREATE TABLE login_tokens (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
