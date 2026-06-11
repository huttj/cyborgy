import type { Env, ExtractedEntry, Delivery, TranscriptWord } from "./types";
import { extractEntries } from "./llm";
import { insertMessage, insertEntries, setMessageDelivery, now } from "./db";
import { arrayBufferToBase64 } from "./telegram-api";

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
    image?: { base64: string; mediaType: "image/jpeg" | "image/png" };
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
  const { entries, delivery } = await extractEntries(env, input.text, input.image);
  await insertEntries(env, messageId, now(), entries);

  const wps = wordsPerSecond(input.text, input.durationSec);
  await setMessageDelivery(env, messageId, delivery, wps);

  return { messageId, entries, delivery };
}

function wordsPerSecond(text: string | null, durationSec?: number): number | null {
  if (!text || !durationSec || durationSec <= 0) return null;
  const words = text.trim().split(/\s+/).length;
  return Math.round((words / durationSec) * 100) / 100;
}

/** Human-readable confirmation for what got extracted. */
export function confirmationText(entries: ExtractedEntry[]): string {
  if (entries.length === 0) return "📝 Saved, but I didn't find anything to extract.";
  const lines = entries.map((e) => {
    const scores = [
      e.mood != null ? `mood ${e.mood}` : null,
      e.energy != null ? `energy ${e.energy}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `• ${e.category}: ${e.summary}${scores ? ` (${scores})` : ""}`;
  });
  return `📝 Logged ${entries.length === 1 ? "1 entry" : `${entries.length} entries`}:\n${lines.join("\n")}`;
}
