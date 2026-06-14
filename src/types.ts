export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  AUTHORIZED_USER_ID: string;
  SHORTCUT_TOKEN: string;
  DASHBOARD_KEY: string;
  TIMEZONE: string;
  PUBLIC_URL: string;
}

export type Intent = "entry" | "question";

export interface ExtractedEntry {
  category:
    | "food"
    | "exercise"
    | "activity"
    | "social"
    | "work"
    | "mood"
    | "thought"
    | "sleep"
    | "other";
  summary: string;
  entities: string[];
  mood: number | null;
  energy: number | null;
  notes: string | null;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface Delivery {
  /** Observable speech/writing features, e.g. "self-interrupting", "hedging", "flowing", "terse". */
  tags: string[];
  /** One-sentence observation when something stands out; null otherwise. */
  note: string | null;
}

export interface ExtractionResult {
  entries: ExtractedEntry[];
  delivery: Delivery;
}

export interface MessageRow {
  id: number;
  telegram_message_id: number | null;
  source: string;
  role: string;
  raw_text: string | null;
  r2_key: string | null;
  created_at: number;
  delivery_json: string | null;
  wps: number | null;
  words_json: string | null;
  media_group_id: string | null;
  reply_message_id: number | null;
}

export interface Image {
  base64: string;
  mediaType: "image/jpeg" | "image/png";
}

export interface EntryRow {
  id: number;
  message_id: number;
  ts: number;
  category: string;
  summary: string;
  entities: string;
  mood: number | null;
  energy: number | null;
  notes: string | null;
}
