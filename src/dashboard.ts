import type { Env, Delivery } from "./types";
import {
  entriesSince,
  latestReport,
  queryMessagesWithEntries,
  mediaByMessageIds,
  mediaKeysForMessage,
  getMessage,
  deleteEntriesForMessage,
  deleteEntry,
  insertEntries,
  insertMessage,
  setMessageDelivery,
  now,
} from "./db";
import { extractEntries } from "./llm";
import { transcribe, loadImages } from "./pipeline";
import { answerWithContext } from "./bot";
import { dailyMoodEnergySeries } from "./scheduled";

const DAY = 86400;

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

/** Paginated, searchable message feed with extracted entries. */
export async function messagesData(env: Env, params: URLSearchParams): Promise<Response> {
  const limit = Number(params.get("limit")) || 20;
  const rows = await queryMessagesWithEntries(env, {
    limit,
    before: Number(params.get("before")) || undefined,
    since: Number(params.get("since")) || undefined,
    q: params.get("q")?.trim() || undefined,
  });

  // Pair Q→A: each assistant row folds into the nearest preceding question,
  // so the feed shows one card per exchange.
  const consumed = new Set<number>();
  const answerFor = new Map<number, (typeof rows)[number]>();
  let lastQuestion: (typeof rows)[number] | null = null;
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    if (r.role === "question") lastQuestion = r;
    else if (r.role === "assistant" && lastQuestion && !answerFor.has(lastQuestion.id)) {
      answerFor.set(lastQuestion.id, r);
      consumed.add(r.id);
    }
  }
  const messages = rows.filter((r) => !consumed.has(r.id));
  const mediaMap = await mediaByMessageIds(env, messages.map((m) => m.id));

  return Response.json({
    messages: messages.map((m) => ({
      answer: answerFor.has(m.id)
        ? { text: answerFor.get(m.id)!.raw_text, createdAt: answerFor.get(m.id)!.created_at }
        : null,
      id: m.id,
      createdAt: m.created_at,
      source: m.source,
      role: m.role,
      rawText: m.raw_text,
      r2Key: m.r2_key,
      // All image keys (albums); falls back to the single r2_key for old photos.
      media: mediaMap.get(m.id) ?? (m.r2_key?.startsWith("photo/") ? [m.r2_key] : []),
      wps: m.wps,
      words: m.words_json ? (JSON.parse(m.words_json) as unknown[]) : null,
      delivery: m.delivery_json ? (JSON.parse(m.delivery_json) as Delivery) : null,
      entries: m.entries.map((e) => ({
        id: e.id,
        category: e.category,
        summary: e.summary,
        entities: JSON.parse(e.entities) as string[],
        mood: e.mood,
        energy: e.energy,
        notes: e.notes,
      })),
    })),
    nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}

/** Charts + categories + latest weekly report, for the Review tab. */
export async function dashboardData(env: Env): Promise<Response> {
  const [entries, weekly] = await Promise.all([
    entriesSince(env, now() - 28 * DAY),
    latestReport(env, "weekly"),
  ]);

  const series = dailyMoodEnergySeries(env, entries);
  const categoryCounts: Record<string, number> = {};
  const recent = entries.filter((e) => e.ts >= now() - 7 * DAY);
  for (const e of recent) categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;

  return Response.json({
    series,
    categoryCounts,
    totalEntries: entries.length,
    latestWeeklyReport: weekly
      ? { markdown: weekly.content_md, createdAt: weekly.created_at }
      : null,
  });
}

/** Browser Q&A — same brain as asking the bot in Telegram. */
export async function askHandler(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();
  if (!question) return Response.json({ ok: false, error: "empty question" }, { status: 400 });

  await insertMessage(env, { source: "web", role: "question", rawText: question });
  const answer = await answerWithContext(env, question);
  await insertMessage(env, { source: "web", role: "assistant", rawText: answer });
  return Response.json({ ok: true, answer });
}

/**
 * Re-run the pipeline for one message (heals stuck rows, applies prompt changes).
 * With retranscribe=true, re-transcribes the archived R2 audio first — used to
 * backfill word timestamps or pick up transcription improvements.
 */
export async function reprocessMessage(
  env: Env,
  id: number,
  retranscribe = false,
): Promise<Response> {
  const msg = await getMessage(env, id);
  if (!msg) return Response.json({ ok: false, error: "message not found" }, { status: 404 });

  let text = msg.raw_text;
  if (retranscribe) {
    if (!msg.r2_key?.startsWith("voice/")) {
      return Response.json({ ok: false, error: "no archived audio for message" }, { status: 400 });
    }
    const object = await env.MEDIA.get(msg.r2_key);
    if (!object) return Response.json({ ok: false, error: "audio missing in R2" }, { status: 404 });
    const transcription = await transcribe(env, await object.arrayBuffer());
    text = transcription.text;
    await env.DB.prepare(`UPDATE messages SET raw_text = ?, words_json = ? WHERE id = ?`)
      .bind(text, transcription.words ? JSON.stringify(transcription.words) : null, id)
      .run();
  }

  // Photo messages re-extract from all archived images in the album.
  const photoKeys = (
    await mediaKeysForMessage(env, id, msg.r2_key?.startsWith("photo/") ? msg.r2_key : undefined)
  ).filter((k) => k.startsWith("photo/"));
  const images = await loadImages(env, photoKeys);
  if (!text && images.length === 0) {
    return Response.json({ ok: false, error: "message has no text or image" }, { status: 400 });
  }

  await deleteEntriesForMessage(env, id);
  const { entries, delivery } = await extractEntries(env, text, images);
  await insertEntries(env, id, msg.created_at, entries);
  await setMessageDelivery(env, id, delivery, msg.wps);

  // Return the stored rows (with ids) so the UI can keep per-entry controls live.
  const rows = await env.DB.prepare(`SELECT * FROM entries WHERE message_id = ? ORDER BY id`)
    .bind(id)
    .all<{ id: number; category: string; summary: string; entities: string; mood: number | null; energy: number | null; notes: string | null }>();
  return Response.json({
    ok: true,
    retranscribed: retranscribe,
    text,
    delivery,
    entries: rows.results.map((e) => ({
      id: e.id,
      category: e.category,
      summary: e.summary,
      entities: JSON.parse(e.entities) as string[],
      mood: e.mood,
      energy: e.energy,
      notes: e.notes,
    })),
  });
}

/**
 * Delete a message and its entries (R2 media is left in place).
 * Deleting a question also deletes its paired answer — otherwise the
 * assistant row survives as a confusing orphan card in the feed.
 */
export async function deleteMessage(env: Env, id: number): Promise<Response> {
  const msg = await getMessage(env, id);
  await deleteEntriesForMessage(env, id);
  await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(id).run();
  if (msg?.role === "question") {
    const next = await env.DB.prepare(
      `SELECT id, role FROM messages WHERE id > ? ORDER BY id LIMIT 1`,
    )
      .bind(id)
      .first<{ id: number; role: string }>();
    if (next?.role === "assistant") {
      await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(next.id).run();
    }
  }
  return Response.json({ ok: true });
}

/** Delete a single extracted entry, leaving the raw message intact. */
export async function deleteEntryHandler(env: Env, id: number): Promise<Response> {
  await deleteEntry(env, id);
  return Response.json({ ok: true });
}

export { dashboardPage } from "./dashboard-page";
