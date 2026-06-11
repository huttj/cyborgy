-- Message-level delivery metadata: how the message was said, not what it said.
-- delivery_json: {"tags": ["self-interrupting","hedging",...], "note": "..."} from extraction
-- wps: words per second (voice notes only; transcript word count / Telegram duration)
ALTER TABLE messages ADD COLUMN delivery_json TEXT;
ALTER TABLE messages ADD COLUMN wps REAL;
