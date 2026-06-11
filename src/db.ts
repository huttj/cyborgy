import type { Env, ExtractedEntry, Delivery, MessageRow, EntryRow } from "./types";

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function insertMessage(
  env: Env,
  m: {
    telegramMessageId?: number;
    source: string;
    role: string;
    rawText: string | null;
    r2Key?: string;
  },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO messages (telegram_message_id, source, role, raw_text, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(m.telegramMessageId ?? null, m.source, m.role, m.rawText, m.r2Key ?? null, now())
    .first<{ id: number }>();
  return res!.id;
}

export async function insertEntries(
  env: Env,
  messageId: number,
  ts: number,
  entries: ExtractedEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const stmt = env.DB.prepare(
    `INSERT INTO entries (message_id, ts, category, summary, entities, mood, energy, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch(
    entries.map((e) =>
      stmt.bind(
        messageId,
        ts,
        e.category,
        e.summary,
        JSON.stringify(e.entities ?? []),
        e.mood,
        e.energy,
        e.notes,
      ),
    ),
  );
}

export async function getMessage(env: Env, id: number): Promise<MessageRow | null> {
  return env.DB.prepare(`SELECT * FROM messages WHERE id = ?`).bind(id).first<MessageRow>();
}

export async function getMessageByTelegramId(env: Env, tgId: number): Promise<MessageRow | null> {
  return env.DB.prepare(`SELECT * FROM messages WHERE telegram_message_id = ?`)
    .bind(tgId)
    .first<MessageRow>();
}

export async function entryCountForMessage(env: Env, messageId: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entries WHERE message_id = ?`)
    .bind(messageId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function setMessageRole(env: Env, id: number, role: string): Promise<void> {
  await env.DB.prepare(`UPDATE messages SET role = ? WHERE id = ?`).bind(role, id).run();
}

export async function setMessageDelivery(
  env: Env,
  id: number,
  delivery: Delivery,
  wps: number | null,
): Promise<void> {
  const hasContent = delivery.tags.length > 0 || delivery.note != null;
  await env.DB.prepare(`UPDATE messages SET delivery_json = ?, wps = ? WHERE id = ?`)
    .bind(hasContent ? JSON.stringify(delivery) : null, wps, id)
    .run();
}

/** Entry-message delivery metadata in a window, for the weekly analysis. */
export async function deliverySince(
  env: Env,
  since: number,
  until?: number,
): Promise<Pick<MessageRow, "created_at" | "delivery_json" | "wps">[]> {
  const res = await env.DB.prepare(
    `SELECT created_at, delivery_json, wps FROM messages
     WHERE role = 'entry' AND created_at >= ? AND created_at < ?
       AND (delivery_json IS NOT NULL OR wps IS NOT NULL)
     ORDER BY created_at ASC`,
  )
    .bind(since, until ?? now() + 1)
    .all<Pick<MessageRow, "created_at" | "delivery_json" | "wps">>();
  return res.results;
}

export async function deleteEntriesForMessage(env: Env, messageId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM entries WHERE message_id = ?`).bind(messageId).run();
}

export async function entriesSince(env: Env, since: number, until?: number): Promise<EntryRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM entries WHERE ts >= ? AND ts < ? ORDER BY ts ASC`,
  )
    .bind(since, until ?? now() + 1)
    .all<EntryRow>();
  return res.results;
}

export async function lastEntryTime(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT created_at FROM messages WHERE role = 'entry' ORDER BY created_at DESC LIMIT 1`,
  ).first<{ created_at: number }>();
  return row?.created_at ?? null;
}

export async function lastPingTime(env: Env, kind: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT sent_at FROM pings WHERE kind = ? ORDER BY sent_at DESC LIMIT 1`,
  )
    .bind(kind)
    .first<{ sent_at: number }>();
  return row?.sent_at ?? null;
}

export async function pingCountSince(env: Env, kind: string, since: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pings WHERE kind = ? AND sent_at >= ?`,
  )
    .bind(kind, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function logPing(env: Env, kind: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO pings (kind, sent_at) VALUES (?, ?)`).bind(kind, now()).run();
}

export async function saveReport(
  env: Env,
  kind: string,
  periodStart: number,
  periodEnd: number,
  contentMd: string,
  dataJson: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO reports (kind, period_start, period_end, content_md, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(kind, periodStart, periodEnd, contentMd, JSON.stringify(dataJson ?? null), now())
    .run();
}

export async function latestReport(
  env: Env,
  kind: string,
): Promise<{ content_md: string; data_json: string | null; created_at: number } | null> {
  return env.DB.prepare(
    `SELECT content_md, data_json, created_at FROM reports WHERE kind = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(kind)
    .first();
}

/** Last N messages with their extracted entries, newest first — for the admin view. */
export async function recentMessagesWithEntries(
  env: Env,
  limit = 50,
): Promise<Array<MessageRow & { entries: EntryRow[] }>> {
  const messages = (
    await env.DB.prepare(`SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(limit)
      .all<MessageRow>()
  ).results;
  if (messages.length === 0) return [];

  const ids = messages.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const entries = (
    await env.DB.prepare(`SELECT * FROM entries WHERE message_id IN (${placeholders})`)
      .bind(...ids)
      .all<EntryRow>()
  ).results;

  const byMessage = new Map<number, EntryRow[]>();
  for (const e of entries) {
    const list = byMessage.get(e.message_id) ?? [];
    list.push(e);
    byMessage.set(e.message_id, list);
  }
  return messages.map((m) => ({ ...m, entries: byMessage.get(m.id) ?? [] }));
}

/** Recent conversation turns (questions + assistant replies) for chat context. */
export async function recentConversation(
  env: Env,
  sinceSeconds: number,
  limit = 10,
): Promise<MessageRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE role IN ('question', 'assistant') AND created_at >= ?
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(now() - sinceSeconds, limit)
    .all<MessageRow>();
  return res.results.reverse();
}
