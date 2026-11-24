-- Multi-user. People sign up with their email; an admin approves them; an
-- approved user signs in with a magic link. Each user's journal is separate:
-- every per-user table carries user_id.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,                         -- lowercase; NULL only for the owner row until the first admin signs in
  status TEXT NOT NULL,                      -- 'pending' | 'approved' | 'rejected'
  is_admin INTEGER NOT NULL DEFAULT 0,
  timezone TEXT,                             -- IANA zone from the browser; NULL = env TIMEZONE
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);
-- User 1 is the owner: all data from before users existed is theirs. The
-- owner's email is not in this (public) repo: the first sign-in by an email
-- in the ADMIN_EMAILS secret claims this row.
INSERT INTO users (id, email, status, is_admin, created_at, approved_at)
VALUES (1, NULL, 'approved', 1, unixepoch(), unixepoch());

ALTER TABLE messages ADD COLUMN user_id INTEGER;
ALTER TABLE entries ADD COLUMN user_id INTEGER;
ALTER TABLE pings ADD COLUMN user_id INTEGER;
ALTER TABLE reports ADD COLUMN user_id INTEGER;
ALTER TABLE sessions ADD COLUMN user_id INTEGER;
ALTER TABLE login_tokens ADD COLUMN user_id INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN user_id INTEGER;
UPDATE messages SET user_id = 1;
UPDATE entries SET user_id = 1;
UPDATE pings SET user_id = 1;
UPDATE reports SET user_id = 1;
UPDATE sessions SET user_id = 1;
UPDATE login_tokens SET user_id = 1;
UPDATE push_subscriptions SET user_id = 1;
-- Per-user documents and settings in app_state get a "u<id>:" prefix.
UPDATE app_state SET key = 'u1:' || key;

CREATE INDEX idx_messages_user ON messages(user_id, id);
CREATE INDEX idx_entries_user_ts ON entries(user_id, ts);
CREATE INDEX idx_pings_user ON pings(user_id, kind, sent_at);
CREATE INDEX idx_reports_user ON reports(user_id, kind, created_at);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
