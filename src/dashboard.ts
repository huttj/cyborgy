import type { Env, Delivery, MessageRow, EntryRow, AudioSegmentRow } from "./types";
import { segmentsByMessageIds } from "./capture";
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
  getMemory,
  setMemory,
  now,
} from "./db";
import { extractEntries } from "./llm";
import { transcribe, loadImages } from "./pipeline";
import { answerWithContext } from "./pipeline";
import { moodEnergySeries, type Resolution } from "./scheduled";

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
  const answerFor = new Map<number, MessageRow>();
  // Browser questions name their answer row (answer_id), so quick successive
  // questions pair correctly; the answer may sit outside this page.
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const missing = rows.filter((r) => r.answer_id != null && !byId.has(r.answer_id)).map((r) => r.answer_id!);
  const extra = missing.length
    ? (
        await env.DB.prepare(`SELECT * FROM messages WHERE id IN (${missing.map(() => "?").join(",")})`)
          .bind(...missing)
          .all<MessageRow>()
      ).results
    : [];
  const anyRow = new Map<number, MessageRow>([...rows, ...extra].map((r) => [r.id, r] as const));
  for (const r of rows) {
    if (r.answer_id != null && anyRow.has(r.answer_id)) {
      answerFor.set(r.id, anyRow.get(r.answer_id)!);
      consumed.add(r.answer_id);
    }
  }
  // Older rows (Telegram): fold each assistant row into the nearest preceding question.
  let lastQuestion: (typeof rows)[number] | null = null;
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    if (consumed.has(r.id)) continue;
    if (r.role === "question" && r.answer_id == null) lastQuestion = r;
    else if (r.role === "assistant" && lastQuestion && !answerFor.has(lastQuestion.id)) {
      answerFor.set(lastQuestion.id, r);
      consumed.add(r.id);
    }
  }
  const messages = rows.filter((r) => !consumed.has(r.id));
  const ids = messages.map((m) => m.id);
  const [mediaMap, segMap] = await Promise.all([
    mediaByMessageIds(env, ids),
    segmentsByMessageIds(env, ids),
  ]);

  return Response.json({
    messages: messages.map((m) =>
      messageJson(m, mediaMap.get(m.id), segMap.get(m.id), answerFor.get(m.id) ?? null),
    ),
    nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}

type FeedRow = MessageRow & { entries: EntryRow[] };

/** One feed card's JSON (shared by the feed and the capture Send response). */
function messageJson(
  m: FeedRow,
  media: string[] | undefined,
  segments: AudioSegmentRow[] | undefined,
  answer: MessageRow | null,
) {
  return {
    answer: answer ? { text: answer.raw_text, createdAt: answer.created_at } : null,
    id: m.id,
    createdAt: m.created_at,
    source: m.source,
    role: m.role,
    pending: m.capture_state === "sent",
    rawText: m.raw_text,
    r2Key: m.r2_key,
    // All image keys (albums); falls back to the single r2_key for old photos.
    media: media ?? (m.r2_key?.startsWith("photo/") ? [m.r2_key] : []),
    // Browser recordings: ordered segments, played back to back.
    audio: (segments ?? []).map((s) => ({ key: s.r2_key, duration: s.duration })),
    wps: m.wps,
    words: m.words_json ? (JSON.parse(m.words_json) as unknown[]) : null,
    delivery: m.delivery_json ? (JSON.parse(m.delivery_json) as Delivery) : null,
    entries: m.entries.map((e) => ({
      id: e.id,
      ts: e.ts,
      category: e.category,
      summary: e.summary,
      entities: JSON.parse(e.entities) as string[],
      mood: e.mood,
      energy: e.energy,
      notes: e.notes,
    })),
  };
}

/** Render one message (plus its answer row, if any) in the feed shape. */
export async function renderMessage(env: Env, messageId: number, answerId?: number) {
  const m = await getMessage(env, messageId);
  if (!m) return null;
  const entries = (
    await env.DB.prepare(`SELECT * FROM entries WHERE message_id = ? ORDER BY id`)
      .bind(messageId)
      .all<EntryRow>()
  ).results;
  const answer = answerId ? await getMessage(env, answerId) : null;
  const [mediaMap, segMap] = await Promise.all([
    mediaByMessageIds(env, [messageId]),
    segmentsByMessageIds(env, [messageId]),
  ]);
  return messageJson({ ...m, entries }, mediaMap.get(messageId), segMap.get(messageId), answer);
}

/** Charts + categories + latest weekly report, for the Review tab. */
export async function dashboardData(env: Env, params?: URLSearchParams): Promise<Response> {
  const resParam = params?.get("res");
  const res: Resolution = resParam === "hour" || resParam === "week" ? resParam : "day";
  const days = Math.min(Math.max(Number(params?.get("days")) || 28, 1), 365);

  const [entries, weekly] = await Promise.all([
    entriesSince(env, now() - days * DAY),
    latestReport(env, "weekly"),
  ]);

  const series = moodEnergySeries(env, entries, res);
  const categoryCounts: Record<string, number> = {};
  const recent = entries.filter((e) => e.ts >= now() - 7 * DAY);
  for (const e of recent) categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;

  return Response.json({
    series,
    res,
    days,
    categoryCounts,
    totalEntries: entries.length,
    latestWeeklyReport: weekly
      ? { markdown: weekly.content_md, createdAt: weekly.created_at }
      : null,
  });
}

/** Long-term memory document (Memory tab). */
export async function memoryData(env: Env): Promise<Response> {
  return Response.json({ memory: await getMemory(env) });
}

export async function saveMemory(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { memory?: string } | null;
  await setMemory(env, String(body?.memory ?? ""));
  return Response.json({ ok: true });
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
  guidance?: string,
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
  // Anchor "yesterday"/"last night" to when the message was captured, not now —
  // otherwise re-extracting a historical message resolves cues against today.
  const { entries, delivery } = await extractEntries(env, text, images, msg.created_at, guidance);
  await insertEntries(env, id, msg.created_at, entries);
  await setMessageDelivery(env, id, delivery, msg.wps);

  // Return the stored rows (with ids) so the UI can keep per-entry controls live.
  const rows = await env.DB.prepare(`SELECT * FROM entries WHERE message_id = ? ORDER BY id`)
    .bind(id)
    .all<{ id: number; ts: number; category: string; summary: string; entities: string; mood: number | null; energy: number | null; notes: string | null }>();
  return Response.json({
    ok: true,
    retranscribed: retranscribe,
    text,
    delivery,
    entries: rows.results.map((e) => ({
      id: e.id,
      ts: e.ts,
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
  await env.DB.prepare(`DELETE FROM audio_segments WHERE message_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(id).run();
  if (msg?.answer_id) {
    await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(msg.answer_id).run();
  } else if (msg?.role === "question") {
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
