# cyborgy 🤖

Personal happiness/life tracker on Cloudflare Workers, used in the browser (installable as a PWA). Record voice notes, type, or add photos about your day; an LLM extracts structured entries (food, exercise, activities, social, moods); you get optional check-in pings, a daily recap, and a weekly correlation analysis as web push notifications, plus a live dashboard. Several people can use it, each with a separate journal: anyone can ask for access with their email, an admin approves, and approved users sign in with an emailed magic link. A Telegram bot is an optional second client for the owner.

**Stack:** Cloudflare Workers (+ static assets in `public/`) + D1 (SQLite) + R2 (media archive) + Workers AI (Whisper transcription) + Anthropic API (extraction: Haiku 4.5, chat/analysis: Opus 4.8) + Web Push (VAPID on WebCrypto) + grammY (optional Telegram) + QuickChart. Infrastructure cost: $0 on free tiers; only real cost is Anthropic usage (a few $/month).

Prior art: `~/Projects/telegram-bots` (the Fly.io voice-journal bot). The browser capture pipeline and web push are ported from `~/Projects/todolog`.

## Browser capture

The composer is docked at the bottom of the Stream and Ask tabs: mic, photos, text, Send. Voice records as ~25s segments (a new `MediaRecorder` per segment, webm/opus or mp4 on Safari); each segment uploads and transcribes as soon as it closes, so the transcript shows while you talk and no Whisper call is long. Send stitches the segments (word timings shifted onto one timeline), adds typed text and photos, then routes: **Auto** (Haiku classifies entry vs question), **Log**, or **Ask**. Photos always log. The draft survives a reload; a draft left open for 6 hours is sent by the cron, and a send whose request died is finished by the cron within ~10 minutes.

## Architecture

```
Voice/text/photo ──▶ Telegram ──▶ Worker /webhook ─▶ routing layer (reply-to = conversation,
   ⌚ Shortcut ────────────────▶ Worker /api/entry      else Haiku classifies entry vs question)
                                        │
                       entry ◀──────────┴──────────▶ question
                         │                              │
              Whisper (Workers AI)              context: last 14d entries
              Haiku extraction ──▶ D1           Opus answer ──▶ Telegram
              audio/photos ──▶ R2
                                        │
  Cron (hourly) ─▶ smart pings (9a-8p, max 4/day, suppressed if recently logged)
                 ─▶ daily recap 9pm ──▶ Telegram
                 ─▶ weekly analysis Sun 6pm ──▶ chart image + report + dashboard link
                                        │
  GET /?key=… ──▶ dashboard (mood/energy chart, categories, latest report, recent entries)
```

## Accounts

- **Sign-in:** enter your email on `/login`. An approved user gets a one-time magic link (10 minutes). A new address becomes an access request: the admins get an email and a push, and approve or reject it in **Settings → Accounts**. Approval emails the person a 24-hour sign-in link. Only approved users get mail, so a mistyped signup never bounces.
- **Admins** are the emails in the `ADMIN_EMAILS` secret (kept out of this public repo). The first admin to sign in becomes the **owner** (user 1): the data from before accounts existed, the Telegram bot, the Shortcut token and the `DASHBOARD_KEY` fallback all belong to the owner.
- **Separation:** every per-user table has `user_id`; request handlers get a `UEnv` (the Env plus `USER_ID`, with `TIMEZONE` set to the user's browser timezone), and every per-user query reads it. Media is served only when the R2 key belongs to one of the user's messages.
- All users' AI calls use the owner's `ANTHROPIC_API_KEY`.

## Setup (one-time)

### 1. Cloudflare resources
```bash
npm install
npx wrangler login

npx wrangler d1 create cyborgy        # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create cyborgy-media
npm run db:migrate                    # apply migrations to remote D1
```

### 2. Secrets
```bash
npx wrangler secret put ANTHROPIC_API_KEY        # console.anthropic.com
npx wrangler secret put DASHBOARD_KEY            # owner fallback sign-in key: openssl rand -hex 16
npx wrangler secret put ADMIN_EMAILS             # comma-separated admin emails
npx wrangler secret put SHORTCUT_TOKEN           # openssl rand -hex 16
npm run vapid                                    # prints a web push key pair, then:
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY        # the JSON (JWK) line
```
Also set `TIMEZONE` (default for new users) and `PUBLIC_URL` in `wrangler.jsonc`, and turn on Email Sending for the domain: `npx wrangler email sending enable <domain>`. Mail goes out from `hello@<domain>` through the `EMAIL` binding.

### 3. Deploy and sign in
`npm run deploy`, open the site, and sign in with an admin email (or the owner key). The session cookie lasts 30 days and slides with use. On iPhone, tap Share → **Add to Home Screen** and open it from there; then **Settings → Turn on** notifications. Turn on check-ins / recaps in Settings.

### 4. Optional: Telegram bot
1. Message [@BotFather](https://t.me/botfather) → `/newbot` → save the token; get your numeric id from [@userinfobot](https://t.me/userinfobot).
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 16`) and `AUTHORIZED_USER_ID` as secrets. With all three set, the bot is on; scheduled messages also go to Telegram.
3. Wire the webhook:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://cyborgy.<you>.workers.dev/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 5. Apple Watch / iPhone Shortcut
Create a Shortcut named "Log it" with two actions:
1. **Dictate Text** (stop listening: after pause)
2. **Get Contents of URL** — `https://cyborgy.<you>.workers.dev/api/entry`, Method POST, Header `Authorization: Bearer <SHORTCUT_TOKEN>`, Request Body JSON: `text` = Dictated Text

Then: Watch Ultra → Settings → Action Button → Shortcut → "Log it". Same Shortcut works on the iPhone Action button. Add it as a watch-face complication too for non-Ultra access.

## Usage

- **Send anything** from the composer — voice, text, photos. Auto mode classifies it as an entry (logged + extracted) or a question (answered from your journal); pick **Log** or **Ask** to force it. The Ask tab always asks.
- **Fix an extraction**: the ↻ button on a card re-extracts, with an optional typed/dictated steer.
- **Pings** (Settings): a few gentle check-ins a day, skipped when you've logged recently. A tap on the notification opens the composer.
- **Daily recap** at 9pm; **weekly analysis** Sunday 6pm (also on the Review tab). Both off by default.
- **Telegram** (optional): same brain; `/note`, `/ask`, `/login` for a sign-in link. `?key=<DASHBOARD_KEY>` still works as a curl/debug fallback.

## Development

```bash
cp .dev.vars.example .dev.vars   # fill in secrets
npm run db:migrate:local
npm run dev                      # local worker at http://localhost:8787 (sign in with DASHBOARD_KEY)
npm run typecheck
```

## Costs

| Thing | Tier | Cost |
|---|---|---|
| Workers (requests + cron) | Free: 100k req/day | $0 |
| D1 | Free: 5GB | $0 |
| R2 | Free: 10GB | $0 |
| Workers AI Whisper | Free daily allocation | $0 |
| QuickChart | Free | $0 |
| Anthropic API | Haiku extraction + Opus recaps/analysis | ~$1–5/mo |

## Future ideas

- **"Request edit" on extractions** — move Ask into a persistent sidebar; each entry gets
  an "ask about this" button that adds it to the question context, and the agent can
  trigger re-extraction with corrective guidance or edit/delete specific entries itself

- Vectorize-backed semantic search over entries (the old bot's embedding search, serverless)
- Mini self-experiments: weekly report proposes one, bot tracks compliance
- Lag-aware correlation stats computed in code (not just LLM eyeballing)
- Export endpoint (CSV/JSON dump of entries)
