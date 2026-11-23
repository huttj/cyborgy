// Browser capture (ported from Todolog's capture pipeline, adapted to one user
// and to cyborgy's entry/question routing).
//
//   POST   /api/capture                     → open a draft message, returns {id}
//   POST   /api/capture/:id/segments?seq&duration  (body = audio blob)
//   POST   /api/capture/:id/photos          (body = JPEG blob)
//   GET    /api/capture/:id                 → draft state (segment transcripts, photos)
//   POST   /api/capture/:id/send            {text?, mode?: auto|entry|question}
//   DELETE /api/capture/:id                 → discard a draft
//
// Voice arrives as short segments (the browser starts a new MediaRecorder
// every ~25s), each transcribed on upload in the background. Send stitches the
// segments in seq order, adds any typed text and photos, then routes like the
// bot does. A message stays capture_state='sent' until the pipeline finishes,
// so the cron sweep can finish a send whose request died.
import type { AudioSegmentRow, Env, Intent, MessageRow, TranscriptWord } from "./types";
import { classifyIntent, extractEntries } from "./llm";
import { answerWithContext, loadImages, transcribe } from "./pipeline";
import {
  deleteEntriesForMessage,
  getMessage,
  insertEntries,
  insertMessage,
  mediaKeysForMessage,
  setMessageDelivery,
  now,
} from "./db";

const MAX_SEGMENT_BYTES = 25 * 1024 * 1024;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_PHOTOS = 8;

/** Sweep tuning: wait out a live send before finishing it; give up after a week. */
const SENT_MIN_AGE = 180; // seconds
const SENT_MAX_AGE = 7 * 86400;
/** An open draft with no activity for this long is sent (or dropped when empty). */
const ABANDONED_AFTER = 6 * 3600;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function getDraft(env: Env, id: number): Promise<MessageRow | null> {
  const msg = await getMessage(env, id);
  return msg && msg.capture_state != null ? msg : null;
}

export async function segmentsFor(env: Env, messageId: number): Promise<AudioSegmentRow[]> {
  const res = await env.DB.prepare(`SELECT * FROM audio_segments WHERE message_id = ? ORDER BY seq`)
    .bind(messageId)
    .all<AudioSegmentRow>();
  return res.results;
}

/** Batched segment lookup for the feed: message id → segments in order. */
export async function segmentsByMessageIds(
  env: Env,
  ids: number[],
): Promise<Map<number, AudioSegmentRow[]>> {
  const map = new Map<number, AudioSegmentRow[]>();
  if (ids.length === 0) return map;
  const res = await env.DB.prepare(
    `SELECT * FROM audio_segments WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY message_id, seq`,
  )
    .bind(...ids)
    .all<AudioSegmentRow>();
  for (const s of res.results) {
    const list = map.get(s.message_id) ?? [];
    list.push(s);
    map.set(s.message_id, list);
  }
  return map;
}

const PHANTOM = new Set(["you", "thank you", "thanks for watching", "bye", "thank you for watching"]);

/** Transcribe one segment and store the result. Silence stores ''. */
async function transcribeSegment(env: Env, seg: AudioSegmentRow): Promise<void> {
  const object = await env.MEDIA.get(seg.r2_key);
  if (!object) throw new Error(`segment audio missing in R2: ${seg.r2_key}`);
  let text = "";
  let words: TranscriptWord[] | null = null;
  try {
    ({ text, words } = await transcribe(env, await object.arrayBuffer()));
  } catch (err) {
    // transcribe() throws on an empty result: that is silence, not a failure.
    if (!(err instanceof Error && err.message.includes("empty text"))) throw err;
  }
  // Whisper invents a short stock phrase for a silent clip ("You", "Thank
  // you."). A segment that is only such a phrase is treated as silence.
  if (PHANTOM.has(text.toLowerCase().replace(/[^a-z ]/g, "").trim())) {
    text = "";
    words = null;
  }
  await env.DB.prepare(`UPDATE audio_segments SET transcript = ?, words_json = ? WHERE id = ?`)
    .bind(text, words && words.length ? JSON.stringify(words) : null, seg.id)
    .run();
  seg.transcript = text;
  seg.words_json = words && words.length ? JSON.stringify(words) : null;
}

/** Stitch segment transcripts in order; word timings shift by the preceding durations. */
function stitch(segments: AudioSegmentRow[]): { text: string; words: TranscriptWord[]; duration: number } {
  const parts: string[] = [];
  const words: TranscriptWord[] = [];
  let offset = 0;
  for (const s of segments) {
    if (s.transcript) parts.push(s.transcript.trim());
    if (s.words_json) {
      for (const w of JSON.parse(s.words_json) as TranscriptWord[]) {
        words.push({ word: w.word, start: w.start + offset, end: w.end + offset });
      }
    }
    offset += s.duration;
  }
  return { text: parts.filter(Boolean).join(" "), words, duration: offset };
}

export interface CaptureResult {
  intent: Intent | "empty";
  messageId: number;
  answerId?: number;
}

/**
 * Finish a sent capture: transcribe any segment still missing, stitch, route,
 * extract or answer, and mark the row 'done'. Idempotent up to the final
 * UPDATE: entries are wiped before insert, and only a 'sent' row is finished.
 */
export async function finishCapture(env: Env, msg: MessageRow): Promise<CaptureResult> {
  const segments = await segmentsFor(env, msg.id);
  for (const seg of segments) if (seg.transcript == null) await transcribeSegment(env, seg);
  const voice = stitch(segments);
  const typed = msg.typed_text?.trim() ?? "";
  const text = [voice.text, typed].filter(Boolean).join("\n\n");
  const photoKeys = await mediaKeysForMessage(env, msg.id);

  if (!text && photoKeys.length === 0) {
    // Nothing usable (e.g. a recording of silence): drop the row.
    await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(msg.id).run();
    return { intent: "empty", messageId: msg.id };
  }

  const source = segments.length ? "web_voice" : photoKeys.length ? "web_photo" : "web_text";
  const mode = msg.capture_mode;
  // Photos are always entries (as in the bot); otherwise the user's choice wins.
  const intent: Intent = photoKeys.length
    ? "entry"
    : mode === "entry" || mode === "question"
      ? mode
      : await classifyIntent(env, text);

  let answerId: number | undefined;
  if (intent === "question") {
    await deleteEntriesForMessage(env, msg.id);
    // A re-run after a partial death: drop the answer the first run stored.
    if (msg.answer_id) {
      await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(msg.answer_id).run();
    }
    const answer = await answerWithContext(env, text);
    answerId = await insertMessage(env, { source: "web", role: "assistant", rawText: answer });
    await env.DB.prepare(`UPDATE messages SET answer_id = ? WHERE id = ?`).bind(answerId, msg.id).run();
  } else {
    const images = await loadImages(env, photoKeys);
    // Anchor time cues to capture time: the sweep may run well after the fact.
    const { entries, delivery } = await extractEntries(env, text || null, images, msg.created_at);
    await deleteEntriesForMessage(env, msg.id);
    await insertEntries(env, msg.id, msg.created_at, entries);
    const wps =
      voice.text && voice.duration > 0
        ? Math.round((voice.text.split(/\s+/).length / voice.duration) * 100) / 100
        : null;
    await setMessageDelivery(env, msg.id, delivery, wps);
  }

  await env.DB.prepare(
    `UPDATE messages SET raw_text = ?, words_json = ?, source = ?, role = ?, answer_id = ?,
       capture_state = 'done'
     WHERE id = ?`,
  )
    .bind(
      text || null,
      voice.words.length ? JSON.stringify(voice.words) : null,
      source,
      intent,
      answerId ?? null,
      msg.id,
    )
    .run();
  return { intent, messageId: msg.id, answerId };
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

export async function handleCapture(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  /** Renders a finished message in the feed's JSON shape. */
  render: (messageId: number, answerId?: number) => Promise<unknown>,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/capture" && method === "POST") {
    const row = await env.DB.prepare(
      `INSERT INTO messages (source, role, raw_text, created_at, capture_state)
       VALUES ('web_voice', 'entry', NULL, ?, 'open') RETURNING id`,
    )
      .bind(now())
      .first<{ id: number }>();
    return json({ id: row!.id });
  }

  const m = path.match(/^\/api\/capture\/(\d+)(\/[a-z]+)?$/);
  if (!m) return null;
  const id = Number(m[1]);
  const sub = m[2] ?? "";
  const msg = await getDraft(env, id);
  if (!msg) return json({ ok: false, error: "capture not found" }, 404);

  if (sub === "" && method === "GET") {
    const segments = await segmentsFor(env, id);
    const photos = await mediaKeysForMessage(env, id);
    return json({
      id,
      state: msg.capture_state,
      segments: segments.map((s) => ({
        id: s.id,
        seq: s.seq,
        duration: s.duration,
        transcript: s.transcript,
      })),
      photos,
    });
  }

  if (sub === "" && method === "DELETE") {
    if (msg.capture_state !== "open") return json({ ok: false, error: "already sent" }, 409);
    const segments = await segmentsFor(env, id);
    const photos = await mediaKeysForMessage(env, id);
    await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(id).run();
    ctx.waitUntil(Promise.all([...segments.map((s) => s.r2_key), ...photos].map((k) => env.MEDIA.delete(k))));
    return json({ ok: true });
  }

  if (msg.capture_state !== "open") return json({ ok: false, error: "already sent" }, 409);

  if (sub === "/segments" && method === "POST") {
    const seq = Number(url.searchParams.get("seq"));
    const duration = Number(url.searchParams.get("duration"));
    if (!Number.isInteger(seq) || seq < 0 || !(duration > 0)) {
      return json({ ok: false, error: "bad seq/duration" }, 400);
    }
    const mime = (request.headers.get("content-type") ?? "audio/webm").split(";")[0].trim();
    const audio = await request.arrayBuffer();
    if (audio.byteLength === 0 || audio.byteLength > MAX_SEGMENT_BYTES) {
      return json({ ok: false, error: "bad segment size" }, 400);
    }
    const ext = mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("ogg") ? "oga" : "webm";
    const r2Key = `voice/web-${id}-${seq}.${ext}`;
    await env.MEDIA.put(r2Key, audio, { httpMetadata: { contentType: mime } });
    const seg = await env.DB.prepare(
      `INSERT INTO audio_segments (message_id, seq, r2_key, mime, duration, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id, seq) DO UPDATE SET r2_key = excluded.r2_key, mime = excluded.mime,
         duration = excluded.duration, transcript = NULL, words_json = NULL
       RETURNING *`,
    )
      .bind(id, seq, r2Key, mime, Math.round(duration * 100) / 100, now())
      .first<AudioSegmentRow>();
    // Transcribe now, after the response: the composer polls for the text.
    ctx.waitUntil(
      transcribeSegment(env, seg!).catch((err) => console.error(`segment ${seg!.id} transcribe:`, err)),
    );
    return json({ ok: true, segmentId: seg!.id });
  }

  if (sub === "/photos" && method === "POST") {
    const count = (await mediaKeysForMessage(env, id)).length;
    if (count >= MAX_PHOTOS) return json({ ok: false, error: `max ${MAX_PHOTOS} photos` }, 400);
    const data = await request.arrayBuffer();
    if (data.byteLength === 0 || data.byteLength > MAX_PHOTO_BYTES) {
      return json({ ok: false, error: "bad photo size" }, 400);
    }
    const r2Key = `photo/web-${id}-${Date.now()}.jpg`;
    await env.MEDIA.put(r2Key, data, { httpMetadata: { contentType: "image/jpeg" } });
    await env.DB.prepare(
      `INSERT INTO message_media (message_id, telegram_message_id, r2_key, created_at) VALUES (?, NULL, ?, ?)`,
    )
      .bind(id, r2Key, now())
      .run();
    return json({ ok: true, key: r2Key });
  }

  if (sub === "/send" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { text?: string; mode?: string };
    const mode = body.mode === "entry" || body.mode === "question" ? body.mode : "auto";
    const typed = typeof body.text === "string" ? body.text.trim().slice(0, 20000) : "";
    const claimed = await env.DB.prepare(
      `UPDATE messages SET capture_state = 'sent', sent_at = ?, typed_text = ?, capture_mode = ?
       WHERE id = ? AND capture_state = 'open' RETURNING *`,
    )
      .bind(now(), typed || null, mode, id)
      .first<MessageRow>();
    if (!claimed) return json({ ok: false, error: "already sent" }, 409);

    // waitUntil keeps the work alive ~30s past a closed tab; the sweep covers the rest.
    const work = finishCapture(env, claimed);
    ctx.waitUntil(work.catch(() => {}));
    try {
      const result = await work;
      if (result.intent === "empty") return json({ ok: true, intent: "empty" });
      return json({
        ok: true,
        intent: result.intent,
        message: await render(result.messageId, result.answerId),
      });
    } catch (err) {
      console.error(`capture ${id} send:`, err);
      return json({
        ok: false,
        pending: true,
        error: "Saved, but processing failed. It will retry automatically within ~10 minutes.",
      });
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

/**
 * Cron: finish sends whose request died, and send drafts that were left open
 * (a journal should not lose a recording because a tab closed). Returns the
 * finished message ids so the caller can notify.
 */
export async function sweepWebCaptures(env: Env): Promise<CaptureResult[]> {
  const t = now();
  const done: CaptureResult[] = [];

  const abandoned = await env.DB.prepare(
    `SELECT m.* FROM messages m
     WHERE m.capture_state = 'open'
       AND MAX(m.created_at, COALESCE((SELECT MAX(created_at) FROM audio_segments s WHERE s.message_id = m.id), 0)) < ?`,
  )
    .bind(t - ABANDONED_AFTER)
    .all<MessageRow>();
  for (const msg of abandoned.results) {
    await env.DB.prepare(
      `UPDATE messages SET capture_state = 'sent', sent_at = ?, capture_mode = 'auto' WHERE id = ? AND capture_state = 'open'`,
    )
      .bind(t - SENT_MIN_AGE, msg.id)
      .run();
  }

  const stuck = await env.DB.prepare(
    `SELECT * FROM messages WHERE capture_state = 'sent' AND sent_at <= ? AND sent_at >= ? ORDER BY id`,
  )
    .bind(t - SENT_MIN_AGE, t - SENT_MAX_AGE)
    .all<MessageRow>();
  for (const msg of stuck.results) {
    try {
      done.push(await finishCapture(env, msg));
      console.log(`capture sweep: finished message ${msg.id}`);
    } catch (err) {
      console.error(`capture sweep: message ${msg.id} failed`, err);
    }
  }
  return done;
}
