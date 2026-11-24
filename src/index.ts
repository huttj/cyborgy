import { webhookCallback } from "grammy";
import type { Env, UserRow } from "./types";
import { createBot } from "./bot";
import { runScheduled } from "./scheduled";
import { ingestEntry, confirmationText } from "./pipeline";
import {
  dashboardData,
  dashboardPage,
  messagesData,
  askHandler,
  memoryData,
  saveMemory,
  reprocessMessage,
  deleteMessage,
  deleteEntryHandler,
} from "./dashboard";
import { sendToUser, telegramEnabled } from "./telegram-api";
import { consumeLoginToken, createSession, deleteSession, sessionUser, setState } from "./db";
import { handleCapture } from "./capture";
import { renderMessage } from "./dashboard";
import { deleteSubscription, pushEnabled, pushToUser, saveSubscription } from "./push";
import {
  forUser,
  getUser,
  listUsers,
  OWNER_ID,
  ownerEnv,
  requestSignIn,
  setUserStatus,
} from "./users";
import { getNotifySettings, type NotifySettings } from "./scheduled";

const SESSION_COOKIE = "cyborgy_session";

// The bot mark from the dashboard icon set, white on the accent terracotta.
const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
  `<rect width="24" height="24" rx="5" fill="#e07a5f"/>` +
  `<g stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="6" y="10" width="12" height="8" rx="2"/>` +
  `<circle cx="12" cy="4.8" r="1.5"/>` +
  `<path d="M12 6.3V10"/>` +
  `<path d="M9.5 14h.01M14.5 14h.01"/>` +
  `</g></svg>`;

/** Constant-time string compare (for the sign-in key). */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength || ea.byteLength === 0) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

function sessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]+)`));
  return match ? match[1] : null;
}

/** The signed-in user: session cookie (normal), or ?key= = the owner (curl/debug fallback). */
async function currentUser(request: Request, env: Env): Promise<UserRow | null> {
  const url = new URL(request.url);
  if (safeEqual(url.searchParams.get("key") ?? "", env.DASHBOARD_KEY)) return getUser(env, OWNER_ID);
  const token = sessionToken(request);
  return token ? sessionUser(env, token) : null;
}

function sessionCookie(token: string, maxAge = 30 * 86400): string {
  // The DB session slides on every use, so active use never logs out.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const PAGE_HEAD =
  `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="robots" content="noindex"><link rel="icon" type="image/svg+xml" href="/favicon.svg">` +
  `<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png">` +
  `<title>cyborgy</title>` +
  `<body style="font-family:system-ui;max-width:26rem;margin:20vh auto;padding:0 1rem;text-align:center;line-height:1.6">` +
  `<h1 style="font-size:1.3rem">🤖 cyborgy</h1>`;

const INPUT_CSS =
  "font-size:1rem;padding:.55rem .8rem;border-radius:6px;border:1px solid #8886;background:none;color:inherit;width:100%;box-sizing:border-box";
const BUTTON_CSS =
  "font-size:1.05rem;padding:.6rem 2.2rem;border-radius:6px;border:1px solid #8886;background:#e07a5f;color:#fff;cursor:pointer";

function htmlPage(body: string, status = 200): Response {
  return new Response(PAGE_HEAD + body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function loginPage(env: Env, error?: string, email = ""): Response {
  return htmlPage(
    (error ? `<p style="color:#ef5350">${escHtml(error)}</p>` : "") +
      `<form method="POST" action="/login" style="display:flex;flex-direction:column;gap:.7rem">` +
      `<input type="email" name="email" value="${escHtml(email)}" placeholder="you@example.com" autocomplete="email" autofocus required style="${INPUT_CSS}">` +
      // The browser's timezone, so recaps and time cues use the user's own clock.
      `<input type="hidden" name="tz" id="tz">` +
      `<button style="${BUTTON_CSS}">Email me a sign-in link</button>` +
      `</form>` +
      `<p style="opacity:.6;font-size:.85rem">New here? Enter your email to ask for access. An admin approves each account.</p>` +
      `<details style="margin-top:2rem;opacity:.7;font-size:.85rem"><summary style="cursor:pointer">Sign in with the owner key</summary>` +
      `<form method="POST" action="/login" style="display:flex;flex-direction:column;gap:.5rem;margin-top:.6rem">` +
      // A username field lets password managers save and fill the key.
      `<input type="text" name="username" value="cyborgy" autocomplete="username" hidden>` +
      `<input type="password" name="key" placeholder="DASHBOARD_KEY" autocomplete="current-password" style="${INPUT_CSS}">` +
      `<button style="${BUTTON_CSS};font-size:.9rem;padding:.4rem 1rem">Sign in</button>` +
      `</form></details>` +
      (telegramEnabled(env) ? `<p style="opacity:.5;font-size:.8rem">The owner can also send /login to the Telegram bot.</p>` : "") +
      `<script>try{document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}</script>`,
    error ? 400 : 200,
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Telegram webhook. ACK immediately and process in the background —
    // the pipeline (Whisper + extraction + replies) can exceed both grammY's
    // 10s handler timeout and Telegram's webhook patience, which causes
    // retries and duplicate processing if we respond only when done.
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (!telegramEnabled(env)) return new Response("not found", { status: 404 });
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
      const bot = createBot(await ownerEnv(env));
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

      // The Shortcut token belongs to the owner.
      const owner = await ownerEnv(env);
      const { entries } = await ingestEntry(owner, { text, source: "shortcut" });
      // Echo into the Telegram chat so the journal feed stays complete.
      ctx.waitUntil(sendToUser(owner, `⌚ ${text}\n\n${confirmationText(entries, owner.TIMEZONE)}`));
      return Response.json({ ok: true, entries: entries.length });
    }

    // Favicon (public; browsers also request /favicon.ico unprompted).
    if ((url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") && request.method === "GET") {
      return new Response(FAVICON_SVG, {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
      });
    }

    // Magic link (email) or Telegram /login link → session cookie. GET shows a confirm button and
    // consumes nothing — link-preview crawlers and prefetchers only GET, so
    // the single-use token survives until a human presses the button (POST).
    if (url.pathname === "/auth" && request.method === "GET") {
      const token = url.searchParams.get("t") ?? "";
      return new Response(
        `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<meta name="robots" content="noindex"><link rel="icon" type="image/svg+xml" href="/favicon.svg">` +
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
      const userId = await consumeLoginToken(env, token);
      const user = userId != null ? await getUser(env, userId) : null;
      if (!user || user.status !== "approved") {
        return htmlPage(
          `<p>This link has expired or was already used.</p><p><a href="/login">Get a new sign-in link</a></p>`,
          401,
        );
      }
      const session = await createSession(env, user.id);
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": sessionCookie(session),
        },
      });
    }

    // Browser sign-in with the DASHBOARD_KEY (no Telegram needed).
    if (url.pathname === "/login" && request.method === "GET") return loginPage(env);
    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const email = String(form?.get("email") ?? "").trim();
      if (email) {
        const result = await requestSignIn(env, email, String(form?.get("tz") ?? "") || null);
        if (result.kind === "error") return loginPage(env, result.message, email);
        if (result.kind === "pending") {
          return htmlPage(
            `<p>Thanks. Your request for access is with the admin.</p>` +
              `<p style="opacity:.7">When it is approved, you get an email with a sign-in link.</p>`,
          );
        }
        return htmlPage(
          `<p>Check your email: a sign-in link is on its way to <b>${escHtml(email)}</b>.</p>` +
            `<p style="opacity:.7">The link works once, for 10 minutes.</p>`,
        );
      }
      const given = String(form?.get("key") ?? "").trim();
      if (!safeEqual(given, env.DASHBOARD_KEY)) {
        // Slow down guessing a little; the key itself has 64+ bits.
        await new Promise((r) => setTimeout(r, 800));
        return loginPage(env, "That key is not correct.");
      }
      const session = await createSession(env, OWNER_ID);
      return new Response(null, {
        status: 302,
        headers: { location: "/", "set-cookie": sessionCookie(session) },
      });
    }
    if (url.pathname === "/logout" && request.method === "POST") {
      const token = sessionToken(request);
      if (token) await deleteSession(env, token);
      return new Response(null, {
        status: 302,
        headers: { location: "/login", "set-cookie": sessionCookie("", 0) },
      });
    }

    // Everything below is personal data: session cookie, or ?key= fallback.
    const key = url.searchParams.get("key");
    const user = await currentUser(request, env);
    if (!user) {
      if (url.pathname === "/" && request.method === "GET") return Response.redirect(`${url.origin}/login`, 302);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    }
    // From here on, every handler gets the user-scoped env.
    const uenv = forUser(env, user);
    // Debug: which bot does our token belong to, and is the webhook healthy?
    if (url.pathname === "/api/debug/telegram" && request.method === "GET") {
      if (!user.is_admin) return new Response("forbidden", { status: 403 });
      const api = `https://api.telegram.org/bot${uenv.TELEGRAM_BOT_TOKEN}`;
      const [me, webhook] = await Promise.all([
        fetch(`${api}/getMe`).then((r) => r.json()),
        fetch(`${api}/getWebhookInfo`).then((r) => r.json()),
      ]);
      return Response.json({ me, webhook, authorizedUserId: uenv.AUTHORIZED_USER_ID });
    }
    // Admin: access requests and accounts.
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      if (!user.is_admin) return new Response("forbidden", { status: 403 });
      const users = await listUsers(env);
      return Response.json({
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          status: u.status,
          isAdmin: !!u.is_admin,
          createdAt: u.created_at,
        })),
      });
    }
    const userMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (userMatch && request.method === "POST") {
      if (!user.is_admin) return new Response("forbidden", { status: 403 });
      const body = (await request.json().catch(() => null)) as { status?: string } | null;
      if (body?.status !== "approved" && body?.status !== "rejected") {
        return Response.json({ ok: false, error: "status must be approved or rejected" }, { status: 400 });
      }
      return Response.json(await setUserStatus(env, Number(userMatch[1]), body.status));
    }
    // Browser capture: voice segments, photos, typed text → Send.
    if (url.pathname === "/api/capture" || url.pathname.startsWith("/api/capture/")) {
      const res = await handleCapture(request, uenv, ctx, url, (id, answerId) =>
        renderMessage(uenv, id, answerId),
      );
      if (res) return res;
    }
    // Web Push: public key, subscribe/unsubscribe, test.
    if (url.pathname === "/api/push/key" && request.method === "GET") {
      return Response.json({ key: pushEnabled(uenv) ? uenv.VAPID_PUBLIC_KEY : null });
    }
    if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
      const sub = (await request.json().catch(() => null)) as {
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      } | null;
      if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) {
        return Response.json({ ok: false, error: "bad subscription" }, { status: 400 });
      }
      await saveSubscription(uenv, {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/push/unsubscribe" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { endpoint?: string } | null;
      if (body?.endpoint) await deleteSubscription(uenv, body.endpoint);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/push/test" && request.method === "POST") {
      const sent = await pushToUser(uenv, {
        title: "cyborgy",
        body: "Notifications work. Tap to log something.",
        url: "/?compose=1#stream",
      });
      return Response.json({ ok: true, sent });
    }
    // Settings: which scheduled messages are on.
    if (url.pathname === "/api/settings" && request.method === "GET") {
      return Response.json({
        notify: await getNotifySettings(uenv),
        push: pushEnabled(uenv),
        telegram: telegramEnabled(uenv) && user.id === OWNER_ID,
        email: user.email,
        isAdmin: !!user.is_admin,
        timezone: uenv.TIMEZONE,
      });
    }
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      const body = (await request.json().catch(() => null)) as { notify?: Partial<NotifySettings> } | null;
      const cur = await getNotifySettings(uenv);
      const next: NotifySettings = {
        pings: typeof body?.notify?.pings === "boolean" ? body.notify.pings : cur.pings,
        daily: typeof body?.notify?.daily === "boolean" ? body.notify.daily : cur.daily,
        weekly: typeof body?.notify?.weekly === "boolean" ? body.notify.weekly : cur.weekly,
      };
      await setState(uenv, "notify", next);
      return Response.json({ ok: true, notify: next });
    }
    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      return dashboardData(uenv, url.searchParams);
    }
    if (url.pathname === "/api/messages" && request.method === "GET") {
      return messagesData(uenv, url.searchParams);
    }
    if (url.pathname === "/api/ask" && request.method === "POST") {
      return askHandler(uenv, request);
    }
    if (url.pathname === "/api/memory" && request.method === "GET") {
      return memoryData(uenv);
    }
    if (url.pathname === "/api/memory" && request.method === "PUT") {
      return saveMemory(uenv, request);
    }
    // Admin: POST /api/admin/reprocess?id=N | DELETE /api/admin/messages?id=N
    if (url.pathname === "/api/admin/reprocess" && request.method === "POST") {
      // Optional steering note for a manual re-extract (body may be empty).
      const body = (await request.json().catch(() => null)) as { note?: string } | null;
      return reprocessMessage(
        uenv,
        Number(url.searchParams.get("id")),
        url.searchParams.get("retranscribe") === "1",
        body?.note?.trim() || undefined,
      );
    }
    if (url.pathname === "/api/admin/messages" && request.method === "DELETE") {
      return deleteMessage(uenv, Number(url.searchParams.get("id")));
    }
    if (url.pathname === "/api/admin/entries" && request.method === "DELETE") {
      return deleteEntryHandler(uenv, Number(url.searchParams.get("id")));
    }
    // Archived voice/photo files from R2, e.g. /media/voice%2F123-456.oga
    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      const r2Key = decodeURIComponent(url.pathname.slice("/media/".length));
      // Only the user's own files: the key must belong to one of their messages.
      const owns = await uenv.DB.prepare(
        `SELECT 1 FROM messages WHERE user_id = ?1 AND r2_key = ?2
         UNION ALL SELECT 1 FROM message_media mm JOIN messages m ON m.id = mm.message_id
           WHERE m.user_id = ?1 AND mm.r2_key = ?2
         UNION ALL SELECT 1 FROM audio_segments s JOIN messages m ON m.id = s.message_id
           WHERE m.user_id = ?1 AND s.r2_key = ?2
         LIMIT 1`,
      )
        .bind(uenv.USER_ID, r2Key)
        .first();
      if (!owns) return new Response("not found", { status: 404 });
      // Range support lets the audio player seek (and Safari wants it for media).
      const wantsRange = request.headers.has("range");
      const object = await uenv.MEDIA.get(r2Key, wantsRange ? { range: request.headers } : undefined);
      if (!object) return new Response("not found", { status: 404 });
      const contentType =
        object.httpMetadata?.contentType ??
        (r2Key.endsWith(".jpg")
          ? "image/jpeg"
          : r2Key.endsWith(".oga")
            ? "audio/ogg"
            : r2Key.endsWith(".webm")
              ? "audio/webm"
              : r2Key.endsWith(".m4a")
                ? "audio/mp4"
                : "application/octet-stream");
      const headers = new Headers({
        "content-type": contentType,
        "cache-control": "private, max-age=3600",
        "accept-ranges": "bytes",
      });
      const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
      if (wantsRange && range) {
        const offset = range.suffix != null ? object.size - range.suffix : (range.offset ?? 0);
        const length = range.suffix != null ? range.suffix : (range.length ?? object.size - offset);
        headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
        headers.set("content-length", String(length));
        return new Response(object.body, { status: 206, headers });
      }
      headers.set("content-length", String(object.size));
      return new Response(object.body, { headers });
    }
    if (url.pathname === "/" && request.method === "GET") {
      // Only a correct key goes into the page (an arbitrary ?key= used to be
      // written into the page script unvalidated).
      return dashboardPage(key && safeEqual(key, uenv.DASHBOARD_KEY) ? key : null);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
