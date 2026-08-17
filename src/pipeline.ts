import type { Env, ExtractedEntry, Delivery, Image, Intent, TranscriptWord } from "./types";
import { extractEntries, classifyIntent, answerQuestion } from "./llm";
import {
  insertMessage,
  insertEntries,
  setMessageDelivery,
  setMessageRole,
  setMessageTranscript,
  createOrGetAlbumMessage,
  addMedia,
  mediaKeysForMessage,
  deleteEntriesForMessage,
  entriesSince,
  recentConversation,
  now,
} from "./db";
import { arrayBufferToBase64 } from "./telegram-api";

const DAY = 86400;
const ANSWER_CONTEXT_DAYS = 14;

// Share-sheet photos arrive ungrouped; treat photos within this window as one moment.
const PHOTO_GROUP_WINDOW = 30; // seconds

/** Load image keys from R2 as base64 blocks for extraction. */
export async function loadImages(env: Env, r2Keys: string[]): Promise<Image[]> {
  const out: Image[] = [];
  for (const key of r2Keys) {
    const obj = await env.MEDIA.get(key);
    if (obj) out.push({ base64: arrayBufferToBase64(await obj.arrayBuffer()), mediaType: "image/jpeg" });
  }
  return out;
}

export interface Transcription {
  text: string;
  /** Word-level timestamps when the model provides them; null otherwise. */
  words: TranscriptWord[] | null;
}

/** Transcribe audio with Workers AI Whisper (free daily allocation). */
export async function transcribe(env: Env, audio: ArrayBuffer): Promise<Transcription> {
  const result = (await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: arrayBufferToBase64(audio),
  })) as unknown as Record<string, unknown>;
  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (!text) throw new Error("transcription returned empty text");
  return { text, words: harvestWords(result) };
}

/** Word timestamps appear either top-level (`words`) or nested in `segments[].words`. */
function harvestWords(result: Record<string, unknown>): TranscriptWord[] | null {
  const isWord = (w: unknown): w is TranscriptWord =>
    typeof w === "object" &&
    w !== null &&
    typeof (w as TranscriptWord).word === "string" &&
    typeof (w as TranscriptWord).start === "number" &&
    typeof (w as TranscriptWord).end === "number";

  if (Array.isArray(result.words) && result.words.every(isWord) && result.words.length > 0) {
    return result.words;
  }
  if (Array.isArray(result.segments)) {
    const words = result.segments.flatMap((s) =>
      Array.isArray((s as { words?: unknown[] }).words)
        ? ((s as { words: unknown[] }).words.filter(isWord) as TranscriptWord[])
        : [],
    );
    if (words.length > 0) return words;
  }
  return null;
}

/**
 * Finish a voice message whose stub row was saved before transcription:
 * transcribe, route (entry vs question), extract or answer, and return the
 * reply to surface. Shared by the live Telegram handler and the cron sweep
 * that heals rows whose first attempt was killed by the ~30s webhook budget.
 *
 * Idempotent: raw_text stays NULL until the very end, so a re-run after any
 * partial death redoes the whole job; entries are wiped before re-insert.
 */
export async function completeVoiceStub(
  env: Env,
  msg: { id: number; r2_key: string | null; created_at: number },
  opts: { audio?: ArrayBuffer; durationSec?: number; forceQuestion?: boolean } = {},
): Promise<{ intent: Intent; replyText: string }> {
  let audio = opts.audio;
  if (!audio) {
    if (!msg.r2_key) throw new Error(`voice message ${msg.id} has no archived audio`);
    const object = await env.MEDIA.get(msg.r2_key);
    if (!object) throw new Error(`audio missing in R2: ${msg.r2_key}`);
    audio = await object.arrayBuffer();
  }
  const { text, words } = await transcribe(env, audio);

  const intent: Intent = opts.forceQuestion ? "question" : await classifyIntent(env, text);
  if (intent === "question") {
    await setMessageRole(env, msg.id, "question");
    const answer = await answerWithContext(env, text);
    await insertMessage(env, { source: "bot", role: "assistant", rawText: answer });
    await setMessageTranscript(env, msg.id, text, words);
    return { intent, replyText: answer };
  }

  // Anchor time cues to capture time — the sweep may run well after the fact.
  const { entries, delivery } = await extractEntries(env, text, undefined, msg.created_at);
  await deleteEntriesForMessage(env, msg.id);
  await insertEntries(env, msg.id, msg.created_at, entries);
  await setMessageDelivery(env, msg.id, delivery, wordsPerSecond(text, opts.durationSec));
  await setMessageTranscript(env, msg.id, text, words);
  return { intent, replyText: confirmationText(entries, env.TIMEZONE) };
}

export async function answerWithContext(env: Env, question: string): Promise<string> {
  const [entries, conversation] = await Promise.all([
    entriesSince(env, now() - ANSWER_CONTEXT_DAYS * DAY),
    recentConversation(env, DAY),
  ]);
  return answerQuestion(env, question, { entries, conversation });
}

export interface IngestResult {
  messageId: number;
  entries: ExtractedEntry[];
  delivery: Delivery;
}

/**
 * Core entry pipeline, shared by Telegram handlers and the Shortcut endpoint:
 * store the raw message, run extraction, store structured entries plus
 * message-level delivery metadata (how it was said: tags/note + words/sec).
 */
export async function ingestEntry(
  env: Env,
  input: {
    text: string | null;
    source: string;
    telegramMessageId?: number;
    r2Key?: string;
    images?: Image[];
    /** Voice note duration in seconds (from Telegram) — enables words/sec. */
    durationSec?: number;
  },
): Promise<IngestResult> {
  const messageId = await insertMessage(env, {
    telegramMessageId: input.telegramMessageId,
    source: input.source,
    role: "entry",
    rawText: input.text,
    r2Key: input.r2Key,
  });
  const { entries, delivery } = await extractEntries(env, input.text, input.images);
  await insertEntries(env, messageId, now(), entries);

  const wps = wordsPerSecond(input.text, input.durationSec);
  await setMessageDelivery(env, messageId, delivery, wps);

  return { messageId, entries, delivery };
}

export interface PhotoResult extends IngestResult {
  /** True when this photo created the message (vs. attaching to an album). */
  created: boolean;
}

/**
 * Ingest one photo, grouping album members by media_group_id with no timers:
 * the first photo creates the message, the rest attach their image to it, and
 * every photo re-extracts over all images gathered so far — so the last one
 * to arrive yields the complete result.
 */
export async function ingestPhoto(
  env: Env,
  input: {
    telegramMessageId: number;
    r2Key: string;
    caption: string | null;
    mediaGroupId: string | null;
  },
): Promise<PhotoResult> {
  // Telegram only tags true albums (tiled grid) with a media_group_id. Photos
  // multi-sent as separate bubbles arrive ungrouped, so fall back to grouping
  // with any photo from the last PHOTO_GROUP_WINDOW seconds — i.e. shots of the
  // same moment. Reusing a prior photo's group id keeps the atomic-merge path.
  let groupId = input.mediaGroupId;
  if (!groupId) {
    // Only merge with other recent *ungrouped* photos (auto- groups), so a
    // stray share-sheet photo never gets absorbed into a real Telegram album.
    const recent = await env.DB.prepare(
      `SELECT media_group_id FROM messages
       WHERE source = 'telegram_photo' AND media_group_id LIKE 'auto-%' AND created_at >= ?
       ORDER BY id DESC LIMIT 1`,
    )
      .bind(now() - PHOTO_GROUP_WINDOW)
      .first<{ media_group_id: string }>();
    groupId = recent?.media_group_id ?? `auto-${input.telegramMessageId}`;
  }

  const res = await createOrGetAlbumMessage(env, {
    telegramMessageId: input.telegramMessageId,
    rawText: input.caption,
    r2Key: input.r2Key,
    mediaGroupId: groupId,
  });
  const messageId = res.id;
  const created = res.created;

  await addMedia(env, messageId, input.telegramMessageId, input.r2Key);

  // Re-extract over every image in the (possibly growing) group.
  const keys = await mediaKeysForMessage(env, messageId, input.r2Key);
  const images = await loadImages(env, keys);
  const msg = await env.DB.prepare(`SELECT raw_text FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<{ raw_text: string | null }>();
  const { entries, delivery } = await extractEntries(env, msg?.raw_text ?? input.caption, images);
  await deleteEntriesForMessage(env, messageId);
  await insertEntries(env, messageId, now(), entries);
  await setMessageDelivery(env, messageId, delivery, null);

  return { messageId, entries, delivery, created };
}

function wordsPerSecond(text: string | null, durationSec?: number): number | null {
  if (!text || !durationSec || durationSec <= 0) return null;
  const words = text.trim().split(/\s+/).length;
  return Math.round((words / durationSec) * 100) / 100;
}

/**
 * Label for an entry the extractor backdated to a different calendar day than
 * now — the user's safety net to catch a misread time cue. Empty when the
 * entry lands on today (the common case).
 */
function backdateLabel(occurredAt: string | null, timeZone: string): string {
  if (!occurredAt) return "";
  const ms = Date.parse(occurredAt);
  if (Number.isNaN(ms)) return "";
  const day = (d: Date) =>
    d.toLocaleDateString("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  if (day(new Date(ms)) === day(new Date())) return "";
  const label = new Date(ms).toLocaleDateString("en-US", {
    timeZone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });
  return ` 📅 for ${label}`;
}

/** Human-readable confirmation for what got extracted. */
export function confirmationText(entries: ExtractedEntry[], timeZone: string): string {
  if (entries.length === 0) return "📝 Saved, but I didn't find anything to extract.";
  const lines = entries.map((e) => {
    const scores = [
      e.mood != null ? `mood ${e.mood}` : null,
      e.energy != null ? `energy ${e.energy}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `• ${e.category}: ${e.summary}${scores ? ` (${scores})` : ""}${backdateLabel(e.occurred_at, timeZone)}`;
  });
  return `📝 Logged ${entries.length === 1 ? "1 entry" : `${entries.length} entries`}:\n${lines.join("\n")}`;
}
