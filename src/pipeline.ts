import type { Env, ExtractedEntry, Delivery } from "./types";
import { extractEntries } from "./llm";
import { insertMessage, insertEntries, setMessageDelivery, now } from "./db";
import { arrayBufferToBase64 } from "./telegram-api";

/** Transcribe audio with Workers AI Whisper (free daily allocation). */
export async function transcribe(env: Env, audio: ArrayBuffer): Promise<string> {
  const result = (await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: arrayBufferToBase64(audio),
  })) as { text?: string };
  const text = result.text?.trim();
  if (!text) throw new Error("transcription returned empty text");
  return text;
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
