import { webhookCallback } from "grammy";
import type { Env } from "./types";
import { createBot } from "./bot";
import { runScheduled } from "./scheduled";
import { ingestEntry, confirmationText } from "./pipeline";
import { dashboardData, dashboardPage, messagesData } from "./dashboard";
import { sendToUser } from "./telegram-api";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Telegram webhook (secret validated by grammY via secretToken).
    if (url.pathname === "/webhook" && request.method === "POST") {
      const bot = createBot(env);
      const handler = webhookCallback(bot, "cloudflare-mod", {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      });
      return handler(request);
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
    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      return dashboardData(env);
    }
    if (url.pathname === "/api/messages" && request.method === "GET") {
      if (key !== env.DASHBOARD_KEY) return new Response("unauthorized", { status: 401 });
      return messagesData(env);
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
