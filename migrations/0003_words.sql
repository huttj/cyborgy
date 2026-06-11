-- Word-level transcription timestamps: [{"word": "So", "start": 0.0, "end": 0.3}, ...]
-- Powers click-to-seek and karaoke highlighting in the dashboard, and makes
-- pause/timing analysis possible later.
ALTER TABLE messages ADD COLUMN words_json TEXT;
