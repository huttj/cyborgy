export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  SHORTCUT_TOKEN: string;
  /** Sign-in key for the browser app (also the ?key= debug fallback). */
  DASHBOARD_KEY: string;
  // Telegram is optional: the browser app is the primary client. When these
  // are unset, the webhook route is off and outbound sends skip Telegram.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  AUTHORIZED_USER_ID?: string;
  // Web Push (optional). VAPID_PRIVATE_KEY is a P-256 JWK (JSON string);
  // VAPID_PUBLIC_KEY is the matching raw public key, base64url.
  VAPID_PRIVATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
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
  /**
   * When the event actually happened, as an ISO 8601 string with offset, or
   * null meaning "use the capture time". Set by the extractor only when the
   * message carries an explicit time cue ("yesterday", "last night").
   */
  occurred_at: string | null;
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
  capture_state: string | null;
  sent_at: number | null;
  typed_text: string | null;
  capture_mode: string | null;
  answer_id: number | null;
}

export interface AudioSegmentRow {
  id: number;
  message_id: number;
  seq: number;
  r2_key: string;
  mime: string;
  duration: number;
  transcript: string | null;
  words_json: string | null;
  created_at: number;
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
