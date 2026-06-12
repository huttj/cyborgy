import { webhookCallback } from "grammy";
import type { Env } from "./types";
import { createBot } from "./bot";
import { runScheduled } from "./scheduled";
import { ingestEntry, confirmationText } from "./pipeline";
import {
  dashboardData,
  dashboardPage,
  messagesData,
  askHandler,
  reprocessMessage,
  deleteMessage,
  deleteEntryHandler,
} from "./dashboard";
import { sendToUser } from "./telegram-api";
import { consumeLoginToken, createSession, sessionValid } from "./db";

const SESSION_COOKIE = "cyborgy_session";

/** Authorized via session cookie (normal) or ?key= (curl/debug fallback). */
async function isAuthed(request: Request, env: Env): Promise<boolean> {
  const url = new URL(request.url);
  if (url.searchParams.get("key") === env.DASHBOARD_KEY) return true;
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]+)`));
  return match ? sessionValid(env, match[1]) : false;
}

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
      // Buffer the body BEFORE responding — the request stream becomes
      // unreadable once the response is sent, but waitUntil runs after.
      const body = await request.text();
      const buffered = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body,
      });
      const bot = createBot(env);
      const handler = webhookCallback(bot, "cloudflare-mod", {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
        timeoutMilliseconds: 25_000,
      });
      ctx.waitUntil(handler(buffered).catch((err) => console.error("webhook processing:", err)));
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

    // Telegram /login link → session cookie. GET shows a confirm button and
    // consumes nothing — link-preview crawlers and prefetchers only GET, so
    // the single-use token survives until a human presses the button (POST).
    if (url.pathname === "/auth" && request.method === "GET") {
      const token = url.searchParams.get("t") ?? "";
      return new Response(
        `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<meta name="robots" content="noindex">` +
          `<body style="font-family:system-ui;max-width:26rem;margin:20vh auto;text-align:center;line-height:1.6">` +
          `<h1 style="font-size:1.3rem">🤖 cyborgy</h1>` +
          `<form method="POST" action="/auth">` +
          `<input type="hidden" name="t" value="${token.replace(/[^a-f0-9]/g, "")}">` +
          `<button style="font-size:1.05rem;padding:.6rem 2.2rem;border-radius:6px;border:1px solid #8886;background:#e07a5f;color:#fff;cursor:pointer">Sign in</button>` +
          `</form>`,
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
      );
    }
    if (url.pathname === "/auth" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const token = String(form?.get("t") ?? "");
      if (!(await consumeLoginToken(env, token))) {
        return new Response("Link expired or already used — send /login to the bot for a fresh one.", {
          status: 401,
        });
      }
      const session = await createSession(env);
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          // DB session slides on every use, so active use never logs out.
          "set-cookie": `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`,
        },
      });
    }

    // Dashboard + admin feed (personal data — session cookie, or ?key= fallback).
    const key = url.searchParams.get("key");
    const authed = await isAuthed(request, env);
    // Debug: which bot does our token belong to, and is the webhook healthy?
    if (url.pathname === "/api/debug/telegram" && request.method === "GET") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
      const [me, webhook] = await Promise.all([
        fetch(`${api}/getMe`).then((r) => r.json()),
        fetch(`${api}/getWebhookInfo`).then((r) => r.json()),
      ]);
      return Response.json({ me, webhook, authorizedUserId: env.AUTHORIZED_USER_ID });
    }
    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      return dashboardData(env);
    }
    if (url.pathname === "/api/messages" && request.method === "GET") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      return messagesData(env, url.searchParams);
    }
    if (url.pathname === "/api/ask" && request.method === "POST") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      return askHandler(env, request);
    }
    // Admin: POST /api/admin/reprocess?id=N | DELETE /api/admin/messages?id=N
    if (url.pathname === "/api/admin/reprocess" && request.method === "POST") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      return reprocessMessage(
        env,
        Number(url.searchParams.get("id")),
        url.searchParams.get("retranscribe") === "1",
      );
    }
    if (url.pathname === "/api/admin/messages" && request.method === "DELETE") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      return deleteMessage(env, Number(url.searchParams.get("id")));
    }
    if (url.pathname === "/api/admin/entries" && request.method === "DELETE") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      return deleteEntryHandler(env, Number(url.searchParams.get("id")));
    }
    // Archived voice/photo files from R2, e.g. /media/voice%2F123-456.oga
    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      if (!authed) return new Response("unauthorized", { status: 401 });
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
      if (!authed) {
        return new Response(
          `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<body style="font-family:system-ui;max-width:26rem;margin:20vh auto;text-align:center;line-height:1.6">` +
            `<h1 style="font-size:1.3rem">🤖 cyborgy</h1>` +
            `<p>Send <b>/login</b> to your Telegram bot and tap the link it replies with to sign in here.</p>`,
          { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return dashboardPage(key);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
