import type { Env, UEnv, ExtractedEntry, Delivery, MessageRow, EntryRow, UserRow } from "./types";

// Functions that take a UEnv read or write only that user's rows (USER_ID).
// Functions that take an Env work by a row id the caller already owns.

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function insertMessage(
  env: UEnv,
  m: {
    telegramMessageId?: number;
    source: string;
    role: string;
    rawText: string | null;
    r2Key?: string;
  },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO messages (telegram_message_id, source, role, raw_text, r2_key, created_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(m.telegramMessageId ?? null, m.source, m.role, m.rawText, m.r2Key ?? null, now(), env.USER_ID)
    .first<{ id: number }>();
  return res!.id;
}

/**
 * Resolve an entry's effective timestamp: the extractor's occurred_at when it
 * supplied a valid, sane one, else the capture time. Guards against model-
 * hallucinated dates by rejecting anything outside roughly [a year ago, a day
 * ahead] of capture.
 */
export function resolveEntryTs(occurredAt: string | null | undefined, fallback: number): number {
  if (!occurredAt) return fallback;
  const ms = Date.parse(occurredAt);
  if (Number.isNaN(ms)) return fallback;
  const ts = Math.floor(ms / 1000);
  const YEAR = 366 * 24 * 60 * 60;
  const DAY = 24 * 60 * 60;
  if (ts < fallback - YEAR || ts > fallback + DAY) return fallback;
  return ts;
}

export async function insertEntries(
  env: UEnv,
  messageId: number,
  ts: number,
  entries: ExtractedEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const stmt = env.DB.prepare(
    `INSERT INTO entries (message_id, ts, category, summary, entities, mood, energy, notes, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch(
    entries.map((e) =>
      stmt.bind(
        messageId,
        resolveEntryTs(e.occurred_at, ts),
        e.category,
        e.summary,
        JSON.stringify(e.entities ?? []),
        e.mood,
        e.energy,
        e.notes,
        env.USER_ID,
      ),
    ),
  );
}

export async function getMessage(env: UEnv, id: number): Promise<MessageRow | null> {
  return env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND user_id = ?`)
    .bind(id, env.USER_ID)
    .first<MessageRow>();
}

// --- photo albums: group by media_group_id, images in message_media ---

/** Create the album's message if it's the first photo; else return the existing one. */
export async function createOrGetAlbumMessage(
  env: UEnv,
  m: { telegramMessageId: number; rawText: string | null; r2Key: string; mediaGroupId: string },
): Promise<{ id: number; created: boolean }> {
  const created = await env.DB.prepare(
    `INSERT INTO messages (telegram_message_id, source, role, raw_text, r2_key, media_group_id, created_at, user_id)
     VALUES (?, 'telegram_photo', 'entry', ?, ?, ?, ?, ?)
     ON CONFLICT(media_group_id) DO NOTHING
     RETURNING id`,
  )
    .bind(m.telegramMessageId, m.rawText, m.r2Key, m.mediaGroupId, now(), env.USER_ID)
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

// --- long-term memory (single editable document) ---

/** app_state keys are per user: "u<id>:<name>". */
const stateKey = (env: UEnv, name: string) => `u${env.USER_ID}:${name}`;

export async function getMemory(env: UEnv): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM app_state WHERE key = ?`)
    .bind(stateKey(env, "memory"))
    .first<{ value: string }>();
  return row?.value ?? "";
}

export async function setMemory(env: UEnv, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(stateKey(env, "memory"), value, now())
    .run();
}

/** Append one bullet to memory; returns the updated document. */
export async function appendMemory(env: UEnv, note: string): Promise<string> {
  const cur = await getMemory(env);
  const next = (cur.trim() ? cur.trimEnd() + "\n" : "") + "- " + note.trim();
  await setMemory(env, next);
  return next;
}

/** Generic JSON value in app_state (settings etc.), or the fallback. */
export async function getState<T>(env: UEnv, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare(`SELECT value FROM app_state WHERE key = ?`)
    .bind(stateKey(env, key))
    .first<{ value: string }>();
  if (!row) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value) as T) };
  } catch {
    return fallback;
  }
}

export async function setState(env: UEnv, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(stateKey(env, key), JSON.stringify(value), now())
    .run();
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
}

export async function setReplyMessageId(env: Env, id: number, replyId: number): Promise<void> {
  await env.DB.prepare(`UPDATE messages SET reply_message_id = ? WHERE id = ?`)
    .bind(replyId, id)
    .run();
}

export async function getMessageByTelegramId(env: UEnv, tgId: number): Promise<MessageRow | null> {
  return env.DB.prepare(`SELECT * FROM messages WHERE telegram_message_id = ? AND user_id = ?`)
    .bind(tgId, env.USER_ID)
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

/**
 * Store the transcript + word timings. This is the LAST step of voice
 * completion — a NULL raw_text is the marker the cron sweep uses to find
 * rows whose pipeline was killed mid-flight, so it must only be set once
 * the extracted entries are safely in.
 */
export async function setMessageTranscript(
  env: Env,
  id: number,
  text: string,
  words: unknown[] | null,
): Promise<void> {
  await env.DB.prepare(`UPDATE messages SET raw_text = ?, words_json = ? WHERE id = ?`)
    .bind(text, words && words.length > 0 ? JSON.stringify(words) : null, id)
    .run();
}

/** Voice rows archived to R2 but never transcribed — killed mid-pipeline. */
export async function stuckVoiceMessages(
  env: UEnv,
  olderThan: number,
  newerThan: number,
): Promise<MessageRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE source = 'telegram_voice' AND raw_text IS NULL AND r2_key IS NOT NULL
       AND created_at <= ? AND created_at >= ? AND user_id = ?
     ORDER BY id`,
  )
    .bind(olderThan, newerThan, env.USER_ID)
    .all<MessageRow>();
  return res.results;
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
  env: UEnv,
  since: number,
  until?: number,
): Promise<Pick<MessageRow, "created_at" | "delivery_json" | "wps">[]> {
  const res = await env.DB.prepare(
    `SELECT created_at, delivery_json, wps FROM messages
     WHERE role = 'entry' AND created_at >= ? AND created_at < ? AND user_id = ?
       AND (delivery_json IS NOT NULL OR wps IS NOT NULL)
     ORDER BY created_at ASC`,
  )
    .bind(since, until ?? now() + 1, env.USER_ID)
    .all<Pick<MessageRow, "created_at" | "delivery_json" | "wps">>();
  return res.results;
}

export async function deleteEntriesForMessage(env: Env, messageId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM entries WHERE message_id = ?`).bind(messageId).run();
}

export async function deleteEntry(env: UEnv, entryId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM entries WHERE id = ? AND user_id = ?`).bind(entryId, env.USER_ID).run();
}

export async function entriesSince(env: UEnv, since: number, until?: number): Promise<EntryRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM entries WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  )
    .bind(env.USER_ID, since, until ?? now() + 1)
    .all<EntryRow>();
  return res.results;
}

export async function lastEntryTime(env: UEnv): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT created_at FROM messages WHERE role = 'entry' AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(env.USER_ID)
    .first<{ created_at: number }>();
  return row?.created_at ?? null;
}

export async function lastPingTime(env: UEnv, kind: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT sent_at FROM pings WHERE kind = ? AND user_id = ? ORDER BY sent_at DESC LIMIT 1`,
  )
    .bind(kind, env.USER_ID)
    .first<{ sent_at: number }>();
  return row?.sent_at ?? null;
}

export async function pingCountSince(env: UEnv, kind: string, since: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pings WHERE kind = ? AND sent_at >= ? AND user_id = ?`,
  )
    .bind(kind, since, env.USER_ID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function logPing(env: UEnv, kind: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO pings (kind, sent_at, user_id) VALUES (?, ?, ?)`)
    .bind(kind, now(), env.USER_ID)
    .run();
}

export async function saveReport(
  env: UEnv,
  kind: string,
  periodStart: number,
  periodEnd: number,
  contentMd: string,
  dataJson: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO reports (kind, period_start, period_end, content_md, data_json, created_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(kind, periodStart, periodEnd, contentMd, JSON.stringify(dataJson ?? null), now(), env.USER_ID)
    .run();
}

export async function latestReport(
  env: UEnv,
  kind: string,
): Promise<{ content_md: string; data_json: string | null; created_at: number } | null> {
  return env.DB.prepare(
    `SELECT content_md, data_json, created_at FROM reports WHERE kind = ? AND user_id = ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(kind, env.USER_ID)
    .first();
}

/** Messages with their extracted entries, newest first, with search/time/cursor filters. */
export async function queryMessagesWithEntries(
  env: UEnv,
  opts: { limit?: number; before?: number; q?: string; since?: number } = {},
): Promise<Array<MessageRow & { entries: EntryRow[] }>> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  // Open web drafts (still recording) are not part of the feed yet.
  const conds: string[] = ["user_id = ?", "(capture_state IS NULL OR capture_state != 'open')"];
  const binds: unknown[] = [env.USER_ID];
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

export async function createLoginToken(env: UEnv, ttl = LOGIN_TOKEN_TTL): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO login_tokens (token, expires_at, user_id) VALUES (?, ?, ?)`)
    .bind(token, now() + ttl, env.USER_ID)
    .run();
  return token;
}

/** Atomically consume a login token; its user id only the first time, within TTL. */
export async function consumeLoginToken(env: Env, token: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `UPDATE login_tokens SET used = 1 WHERE token = ? AND used = 0 AND expires_at > ? RETURNING user_id`,
  )
    .bind(token, now())
    .first<{ user_id: number | null }>();
  return row?.user_id ?? null;
}

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (token, created_at, expires_at, user_id) VALUES (?, ?, ?, ?)`)
    .bind(token, now(), now() + SESSION_DAYS * 86400, userId)
    .run();
  return token;
}

/** The approved user behind a live session (sliding expiry), or null. */
export async function sessionUser(env: Env, token: string): Promise<UserRow | null> {
  const user = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.status = 'approved'`,
  )
    .bind(token, now())
    .first<UserRow>();
  if (user) {
    // Sliding window: every use pushes expiry out again.
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`)
      .bind(now() + SESSION_DAYS * 86400, token)
      .run();
  }
  return user;
}

export async function purgeExpiredAuth(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`).bind(now()),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now()),
  ]);
}

/** Recent conversation turns (questions + assistant replies) for chat context. */
export async function recentConversation(
  env: UEnv,
  sinceSeconds: number,
  limit = 10,
): Promise<MessageRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE role IN ('question', 'assistant') AND created_at >= ? AND user_id = ?
       AND raw_text IS NOT NULL AND raw_text != ''
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(now() - sinceSeconds, env.USER_ID, limit)
    .all<MessageRow>();
  return res.results.reverse();
}
