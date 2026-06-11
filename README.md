# cyborgy 🤖

Personal happiness/life tracker as a Telegram bot on Cloudflare Workers. Dump voice notes, texts, and photos about your day; an LLM extracts structured entries (food, exercise, activities, social, moods); you get smart check-in pings, a daily recap, a weekly correlation analysis with charts, and a live dashboard.

**Stack:** Cloudflare Workers + D1 (SQLite) + R2 (media archive) + Workers AI (Whisper transcription) + Anthropic API (extraction: Haiku 4.5, chat/analysis: Opus 4.8) + grammY + QuickChart. Infrastructure cost: $0 on free tiers; only real cost is Anthropic usage (a few $/month).

Prior art: `~/Projects/telegram-bots` (the Fly.io voice-journal bot) — used as reference, fully independent deployment.

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

## Setup (one-time)

### 1. Telegram bot
1. Message [@BotFather](https://t.me/botfather) → `/newbot` → save the token.
2. Get your numeric user id from [@userinfobot](https://t.me/userinfobot).

### 2. Cloudflare resources
```bash
npm install
npx wrangler login

npx wrangler d1 create cyborgy        # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create cyborgy-media
npm run db:migrate                    # apply migrations to remote D1
```

### 3. Secrets
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN       # from BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # any random string: openssl rand -hex 16
npx wrangler secret put ANTHROPIC_API_KEY        # console.anthropic.com
npx wrangler secret put AUTHORIZED_USER_ID       # your numeric Telegram id
npx wrangler secret put SHORTCUT_TOKEN           # openssl rand -hex 16
npx wrangler secret put DASHBOARD_KEY            # openssl rand -hex 8
```
Also set `TIMEZONE` in `wrangler.jsonc` if you're not on Pacific time.

### 4. Deploy + wire the webhook
```bash
npm run deploy    # note your worker URL, e.g. https://cyborgy.<you>.workers.dev

curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://cyborgy.<you>.workers.dev/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```
Set `PUBLIC_URL` in `wrangler.jsonc` to your worker URL (or custom domain) and redeploy.

### 5. Apple Watch / iPhone Shortcut
Create a Shortcut named "Log it" with two actions:
1. **Dictate Text** (stop listening: after pause)
2. **Get Contents of URL** — `https://cyborgy.<you>.workers.dev/api/entry`, Method POST, Header `Authorization: Bearer <SHORTCUT_TOKEN>`, Request Body JSON: `text` = Dictated Text

Then: Watch Ultra → Settings → Action Button → Shortcut → "Log it". Same Shortcut works on the iPhone Action button. Add it as a watch-face complication too for non-Ultra access.

## Usage

- **Send anything** — voice note, text, food photo. The bot classifies it as an entry (logged + extracted) or a question (answered from your journal). Wrong guess? Tap the correction button on its reply.
- **Force it**: `/note <text>` always saves, `/ask <text>` always answers.
- **Replies to the bot** are always treated as conversation.
- **Pings**: a few gentle check-ins a day, skipped when you've logged recently.
- **Daily recap** at 9pm; **weekly analysis** Sunday 6pm with charts and dashboard link.
- **Dashboard**: `https://cyborgy.<you>.workers.dev/?key=<DASHBOARD_KEY>`

## Development

```bash
cp .dev.vars.example .dev.vars   # fill in secrets
npm run db:migrate:local
npm run dev                      # local worker; use polling or a tunnel for Telegram testing
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

- Vectorize-backed semantic search over entries (the old bot's embedding search, serverless)
- Mini self-experiments: weekly report proposes one, bot tracks compliance
- Lag-aware correlation stats computed in code (not just LLM eyeballing)
- Export endpoint (CSV/JSON dump of entries)
