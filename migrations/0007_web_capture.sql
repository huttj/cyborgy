-- Browser capture. The web composer records voice as a series of short
-- segments (a new MediaRecorder every ~25s), so each segment uploads and
-- transcribes on its own and no single Whisper call is long. The message row
-- is created when capture starts (raw_text NULL), segments and photos attach
-- to it, and Send stitches everything and runs the usual pipeline.
CREATE TABLE audio_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                      -- order within the message (client counter)
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration REAL NOT NULL,                    -- seconds, measured by the browser
  transcript TEXT,                           -- NULL until transcribed; '' for silence
  words_json TEXT,                           -- word timings relative to this segment
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, seq)
);
CREATE INDEX idx_audio_segments_msg ON audio_segments(message_id, seq);

-- Web capture lifecycle: 'open' while the user records/types (a draft, not
-- shown in the feed), 'sent' once Send is pressed (the cron sweep finishes a
-- 'sent' row whose request died), 'done' when the pipeline has finished.
-- NULL for every other source.
ALTER TABLE messages ADD COLUMN capture_state TEXT;
ALTER TABLE messages ADD COLUMN sent_at INTEGER;
-- What the user typed in the composer (kept apart from the voice transcript).
ALTER TABLE messages ADD COLUMN typed_text TEXT;
-- Routing the user chose on Send: 'auto' | 'entry' | 'question'.
ALTER TABLE messages ADD COLUMN capture_mode TEXT;
-- A question's answer row (browser captures), so the feed pairs them exactly.
ALTER TABLE messages ADD COLUMN answer_id INTEGER;
CREATE INDEX idx_messages_capture ON messages(capture_state, created_at);

-- Web Push subscriptions (one per browser/device that enabled notifications).
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
