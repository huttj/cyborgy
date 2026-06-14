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

// --- photo albums: group by media_group_id, images in message_media ---

/** Create the album's message if it's the first photo; else return the existing one. */
export async function createOrGetAlbumMessage(
  env: Env,
  m: { telegramMessageId: number; rawText: string | null; r2Key: string; mediaGroupId: string },
): Promise<{ id: number; created: boolean }> {
  const created = await env.DB.prepare(
    `INSERT INTO messages (telegram_message_id, source, role, raw_text, r2_key, media_group_id, created_at)
     VALUES (?, 'telegram_photo', 'entry', ?, ?, ?, ?)
     ON CONFLICT(media_group_id) DO NOTHING
     RETURNING id`,
  )
    .bind(m.telegramMessageId, m.rawText, m.r2Key, m.mediaGroupId, now())
    .first<{ id: number }>();
  if (created) return { id: created.id, created: true };

  const existing = await env.DB.prepare(`SELECT id, raw_text FROM messages WHERE media_group_id = ?`)
    .bind(m.mediaGroupId)
    .first<{ id: number; raw_text: string | null }>();
  // The caption rides on one photo of the group — capture it whoever carries it.
  if (m.rawText && !existing!.raw_text) {
    await env.DB.prepare(`UPDATE messages SET raw_text = ? WHERE id = ?`)
      .bind(m.rawText, existing!.id)
      .run();
  }
  return { id: existing!.id, created: false };
}

export async function addMedia(
  env: Env,
  messageId: number,
  telegramMessageId: number,
  r2Key: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_media (message_id, telegram_message_id, r2_key, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(messageId, telegramMessageId, r2Key, now())
    .run();
}

/** All image keys for a message, oldest first; falls back to messages.r2_key. */
export async function mediaKeysForMessage(
  env: Env,
  messageId: number,
  fallback?: string | null,
): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT r2_key FROM message_media WHERE message_id = ? ORDER BY id`,
  )
    .bind(messageId)
    .all<{ r2_key: string }>();
  if (res.results.length) return res.results.map((r) => r.r2_key);
  return fallback ? [fallback] : [];
}

/** Batched media lookup for the feed: message id → image keys. */
export async function mediaByMessageIds(
  env: Env,
  ids: number[],
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT message_id, r2_key FROM message_media WHERE message_id IN (${placeholders}) ORDER BY id`,
  )
    .bind(...ids)
    .all<{ message_id: number; r2_key: string }>();
  for (const r of res.results) {
    const list = map.get(r.message_id) ?? [];
    list.push(r.r2_key);
    map.set(r.message_id, list);
  }
  return map;
}

export async function setReplyMessageId(env: Env, id: number, replyId: number): Promise<void> {
  await env.DB.prepare(`UPDATE messages SET reply_message_id = ? WHERE id = ?`)
    .bind(replyId, id)
    .run();
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

export async function setMessageWords(
  env: Env,
  telegramMessageId: number,
  words: unknown[] | null,
): Promise<void> {
  if (!words || words.length === 0) return;
  await env.DB.prepare(`UPDATE messages SET words_json = ? WHERE telegram_message_id = ?`)
    .bind(JSON.stringify(words), telegramMessageId)
    .run();
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

export async function deleteEntry(env: Env, entryId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(entryId).run();
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

/** Messages with their extracted entries, newest first, with search/time/cursor filters. */
export async function queryMessagesWithEntries(
  env: Env,
  opts: { limit?: number; before?: number; q?: string; since?: number } = {},
): Promise<Array<MessageRow & { entries: EntryRow[] }>> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (opts.before) {
    conds.push("id < ?");
    binds.push(opts.before);
  }
  if (opts.since) {
    conds.push("created_at >= ?");
    binds.push(opts.since);
  }
  if (opts.q) {
    const like = `%${opts.q}%`;
    conds.push(
      `(raw_text LIKE ? OR EXISTS (
         SELECT 1 FROM entries e WHERE e.message_id = messages.id
           AND (e.summary LIKE ? OR e.entities LIKE ? OR e.notes LIKE ?)))`,
    );
    binds.push(like, like, like, like);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const messages = (
    await env.DB.prepare(`SELECT * FROM messages ${where} ORDER BY id DESC LIMIT ?`)
      .bind(...binds, limit)
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

// --- auth: one-time login tokens + session cookies ---

const LOGIN_TOKEN_TTL = 600; // 10 minutes
const SESSION_DAYS = 30;

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export async function createLoginToken(env: Env): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO login_tokens (token, expires_at) VALUES (?, ?)`)
    .bind(token, now() + LOGIN_TOKEN_TTL)
    .run();
  return token;
}

/** Atomically consume a login token; true only the first time, within TTL. */
export async function consumeLoginToken(env: Env, token: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `UPDATE login_tokens SET used = 1 WHERE token = ? AND used = 0 AND expires_at > ? RETURNING token`,
  )
    .bind(token, now())
    .first();
  return row != null;
}

export async function createSession(env: Env): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)`)
    .bind(token, now(), now() + SESSION_DAYS * 86400)
    .run();
  return token;
}

export async function sessionValid(env: Env, token: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM sessions WHERE token = ? AND expires_at > ?`)
    .bind(token, now())
    .first();
  if (row != null) {
    // Sliding window: every use pushes expiry out another year.
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`)
      .bind(now() + SESSION_DAYS * 86400, token)
      .run();
    return true;
  }
  return false;
}

export async function purgeExpiredAuth(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`).bind(now()),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now()),
  ]);
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
