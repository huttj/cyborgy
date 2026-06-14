-- Photo albums: Telegram delivers a multi-image message as separate updates
-- sharing a media_group_id. We group them into one message, with each image
-- in message_media. No timers — the first photo creates the row (ON CONFLICT
-- on media_group_id), the rest attach by that id.
ALTER TABLE messages ADD COLUMN media_group_id TEXT;
ALTER TABLE messages ADD COLUMN reply_message_id INTEGER; -- our confirmation reply, so later photos can edit it
CREATE UNIQUE INDEX idx_messages_media_group ON messages(media_group_id);

CREATE TABLE message_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  telegram_message_id INTEGER,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- idempotent re-delivery: same photo update never adds a duplicate image
CREATE UNIQUE INDEX idx_message_media_tg ON message_media(telegram_message_id);
CREATE INDEX idx_message_media_msg ON message_media(message_id);
