-- Free-form long-term memory: a single editable document injected (concisely)
-- into the AI's system prompts. User edits it in the Memory tab; the Ask flow
-- can also append to it via the `remember` tool.
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
