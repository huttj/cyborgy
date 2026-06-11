import { webhookCallback } from "grammy";
import type { Env } from "./types";
import { createBot } from "./bot";
import { runScheduled } from "./scheduled";
import { ingestEntry, confirmationText } from "./pipeline";
import {
  dashboardData,
  dashboardPage,
  messagesData,
  reprocessMessage,
  deleteMessage,
} from "./dashboard";
import { sendToUser } from "./telegram-api";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Telegram webhook. ACK immediately and process in the background —
    // the pipeline (Whisper + extraction + replies) can exceed both grammY's
    // 10s handler timeout and Telegram's webhook patience, which causes
    // retries and duplicate processing if we respond only when done.
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (
        request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET
      ) {
        return new Response("unauthorized", { status: 401 });
      }
      const bot = createBot(env);
      const handler = webhookCallback(bot, "cloudflare-mod", {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
        timeoutMilliseconds: 25_000,
      });
      ctx.waitUntil(handler(request).catch((err) => console.error("webhook processing:", err)));
      return new Response("ok");
    }

    // Apple Watch / iPhone Shortcut: Dictate Text -> POST here.
    if (url.pathname === "/api/entry" && request.method === "POST") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.SHORTCUT_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const contentType = request.headers.get("content-type") ?? "";
      let text: string;
      if (contentType.includes("application/json")) {
        const body = (await request.json()) as { text?: string };
        text = body.text ?? "";
      } else {
        text = await request.text();
      }
      text = text.trim();
      if (!text) return Response.json({ ok: false, error: "empty text" }, { status: 400 });

      const { entries } = await ingestEntry(env, { text, source: "shortcut" });
      // Echo into the Telegram chat so the journal feed stays complete.
      ctx.waitUntil(sendToUser(env, `⌚ ${text}\n\n${confirmationText(entries)}`));
      return Response.json({ ok: true, entries: entries.length });
    }

    // Dashboard + admin feed (personal data — gated by key).
    const key = url.searchParams.get("key");
    // Debug: which bot does our token belong to, and is the webhook healthy?
    if (url.pathname === "/api/debug/telegram" && request.method === "GET") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
      const [me, webhook] = await Promise.all([
        fetch(`${api}/getMe`).then((r) => r.json()),
        fetch(`${api}/getWebhookInfo`).then((r) => r.json()),
      ]);
      return Response.json({ me, webhook, authorizedUserId: env.AUTHORIZED_USER_ID });
    }
    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      return dashboardData(env);
    }
    if (url.pathname === "/api/messages" && request.method === "GET") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      return messagesData(env);
    }
    // Admin: POST /api/admin/reprocess?id=N | DELETE /api/admin/messages?id=N
    if (url.pathname === "/api/admin/reprocess" && request.method === "POST") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      return reprocessMessage(env, Number(url.searchParams.get("id")));
    }
    if (url.pathname === "/api/admin/messages" && request.method === "DELETE") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      return deleteMessage(env, Number(url.searchParams.get("id")));
    }
    // Archived voice/photo files from R2, e.g. /media/voice%2F123-456.oga
    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      const r2Key = decodeURIComponent(url.pathname.slice("/media/".length));
      const object = await env.MEDIA.get(r2Key);
      if (!object) return new Response("not found", { status: 404 });
      const contentType = r2Key.endsWith(".jpg")
        ? "image/jpeg"
        : r2Key.endsWith(".oga")
          ? "audio/ogg"
          : "application/octet-stream";
      return new Response(object.body, {
        headers: { "content-type": contentType, "cache-control": "private, max-age=3600" },
      });
    }
    if (url.pathname === "/" && request.method === "GET") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      return dashboardPage(key);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
