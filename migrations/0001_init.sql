-- Raw inbound/outbound messages. One row per Telegram message or Shortcut POST.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_message_id INTEGER UNIQUE,        -- null for shortcut/assistant rows
  source TEXT NOT NULL,                      -- 'telegram_voice' | 'telegram_text' | 'telegram_photo' | 'shortcut' | 'bot'
  role TEXT NOT NULL,                        -- 'entry' | 'question' | 'assistant'
  raw_text TEXT,                             -- transcript, text, or photo caption
  r2_key TEXT,                               -- archived voice/photo object, if any
  created_at INTEGER NOT NULL                -- unix seconds
);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE INDEX idx_messages_role ON messages(role, created_at);

-- Structured items extracted from a message. One message can yield several.
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,                       -- when the thing happened (defaults to message time)
  category TEXT NOT NULL,                    -- food|exercise|activity|social|work|mood|thought|sleep|other
  summary TEXT NOT NULL,                     -- one-line description
  entities TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
  mood INTEGER,                              -- 1-10, null if not expressed
  energy INTEGER,                            -- 1-10, null if not expressed
  notes TEXT
);
CREATE INDEX idx_entries_ts ON entries(ts);
CREATE INDEX idx_entries_category ON entries(category, ts);

-- Outbound scheduled sends, for suppression logic and audit.
CREATE TABLE pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                        -- 'ping' | 'daily_recap' | 'weekly_recap'
  sent_at INTEGER NOT NULL
);
CREATE INDEX idx_pings_sent ON pings(kind, sent_at);

-- Generated analysis, also backs the dashboard.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                        -- 'daily' | 'weekly'
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  content_md TEXT NOT NULL,
  data_json TEXT,                            -- chart/series data used for rendering
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reports_kind ON reports(kind, created_at);
