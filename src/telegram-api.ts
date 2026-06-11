import type { Env } from "./types";

/** Thin raw Bot API helper for outbound sends from cron jobs (no grammY context). */
export async function tg(
  env: Env,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!body.ok) throw new Error(`telegram ${method} failed: ${body.description}`);
  return body.result;
}

/** LLM output often carries markdown; we send Telegram plain text, so strip it. */
export function stripMarkdown(s: string): string {
  return s.replace(/\[(.*?)\]\((.*?)\)/g, "$1 ($2)").replace(/[*_#`~]/g, "");
}

export async function sendToUser(env: Env, text: string): Promise<void> {
  // Telegram caps messages at 4096 chars; chunk on paragraph boundaries.
  const chunks = chunkText(stripMarkdown(text), 4000);
  for (const chunk of chunks) {
    await tg(env, "sendMessage", { chat_id: Number(env.AUTHORIZED_USER_ID), text: chunk });
  }
}

export async function sendPhotoToUser(env: Env, photoUrl: string, caption: string): Promise<void> {
  await tg(env, "sendPhoto", {
    chat_id: Number(env.AUTHORIZED_USER_ID),
    photo: photoUrl,
    caption: caption.slice(0, 1024),
  });
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function downloadTelegramFile(env: Env, fileId: string): Promise<ArrayBuffer> {
  const file = (await tg(env, "getFile", { file_id: fileId })) as { file_path: string };
  const res = await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
  );
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  return res.arrayBuffer();
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
