import { Bot, Context, InlineKeyboard } from "grammy";
import type { Env, Intent } from "./types";
import { classifyIntent, answerQuestion } from "./llm";
import { ingestEntry, confirmationText, transcribe } from "./pipeline";
import { downloadTelegramFile, arrayBufferToBase64 } from "./telegram-api";
import {
  insertMessage,
  getMessage,
  setMessageRole,
  setMessageDelivery,
  deleteEntriesForMessage,
  insertEntries,
  entriesSince,
  recentConversation,
  now,
} from "./db";
import { extractEntries } from "./llm";

const DAY = 86400;
const ANSWER_CONTEXT_DAYS = 14;

export function createBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.catch((err) => console.error("bot error:", err.message, err.error));

  // Single-user bot: drop anything not from the authorized user.
  bot.use(async (ctx, next) => {
    const from = String(ctx.from?.id);
    const authorized = from === env.AUTHORIZED_USER_ID.trim();
    const kind = Object.keys(ctx.update).filter((k) => k !== "update_id")[0];
    console.log(`update: type=${kind} from=${from} authorized=${authorized}`);
    if (!authorized) return;
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      "Hey! I'm your life tracker. Send me voice notes, texts, or photos about your day — " +
        "food, exercise, moods, who you saw, what you did — and I'll log them. " +
        "Ask me questions anytime ('how was my mood this week?'). " +
        "Use /note to force-save and /ask to force-question.",
    ),
  );

  // Explicit overrides for when the classifier shouldn't be trusted.
  bot.command("note", async (ctx) => {
    const text = ctx.match?.toString().trim();
    if (!text) return ctx.reply("Usage: /note I had a great lunch with Sam");
    await handleAsEntry(env, ctx, text, "telegram_text");
  });

  bot.command("ask", async (ctx) => {
    const text = ctx.match?.toString().trim();
    if (!text) return ctx.reply("Usage: /ask how has my energy been this week?");
    await handleAsQuestion(env, ctx, text, "telegram_text");
  });

  bot.on("message:voice", async (ctx) => {
    await ctx.react("👀").catch(() => {});
    try {
      const voice = ctx.message.voice;
      const audio = await downloadTelegramFile(env, voice.file_id);

      // Archive the original audio.
      const r2Key = `voice/${ctx.message.message_id}-${Date.now()}.oga`;
      await env.MEDIA.put(r2Key, audio);

      const transcript = await transcribe(env, audio);
      await routeMessage(env, ctx, transcript, "telegram_voice", r2Key, voice.duration);
      await ctx.react("👍").catch(() => {});
    } catch (err) {
      console.error("voice handler failed", err);
      await ctx.react("👎").catch(() => {});
      await ctx.reply("Something went wrong processing that voice note — try again?");
    }
  });

  bot.on("message:photo", async (ctx) => {
    await ctx.react("👀").catch(() => {});
    try {
      // Largest size is last in the array.
      const sizes = ctx.message.photo;
      const photo = sizes[sizes.length - 1];
      const data = await downloadTelegramFile(env, photo.file_id);

      const r2Key = `photo/${ctx.message.message_id}-${Date.now()}.jpg`;
      await env.MEDIA.put(r2Key, data);

      const caption = ctx.message.caption ?? null;
      // Photos are always entries (nobody asks a question with a food pic).
      const { messageId, entries } = await ingestEntry(env, {
        text: caption,
        source: "telegram_photo",
        telegramMessageId: ctx.message.message_id,
        r2Key,
        image: { base64: arrayBufferToBase64(data), mediaType: "image/jpeg" },
      });
      await ctx.reply(confirmationText(entries), {
        reply_markup: rerouteKeyboard("question", messageId),
      });
      await ctx.react("👍").catch(() => {});
    } catch (err) {
      console.error("photo handler failed", err);
      await ctx.react("👎").catch(() => {});
      await ctx.reply("Something went wrong processing that photo — try again?");
    }
  });

  bot.on("message:text", async (ctx) => {
    try {
      await routeMessage(env, ctx, ctx.message.text, "telegram_text");
    } catch (err) {
      console.error("text handler failed", err);
      await ctx.reply("Something went wrong with that one — try again?");
    }
  });

  // Correction buttons: "actually that was a question" / "actually save that".
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data; // "as_q:<id>" | "as_e:<id>"
    const [action, idStr] = data.split(":");
    const messageId = Number(idStr);
    const msg = await getMessage(env, messageId);
    if (!msg?.raw_text) {
      await ctx.answerCallbackQuery({ text: "Couldn't find that message anymore." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "On it…" });

    if (action === "as_q") {
      // Was saved as entry; user says it's a question. Remove extracted entries, answer it.
      await deleteEntriesForMessage(env, messageId);
      await setMessageRole(env, messageId, "question");
      const answer = await answerWithContext(env, msg.raw_text);
      await insertMessage(env, { source: "bot", role: "assistant", rawText: answer });
      await ctx.reply(answer);
    } else if (action === "as_e") {
      // Was answered as question; user says it should be saved too.
      await setMessageRole(env, messageId, "entry");
      const { entries, delivery } = await extractEntries(env, msg.raw_text);
      await insertEntries(env, messageId, msg.created_at, entries);
      await setMessageDelivery(env, messageId, delivery, msg.wps);
      await ctx.reply(confirmationText(entries));
    }
    // Remove the button so it can't be double-tapped.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  return bot;
}

function rerouteKeyboard(to: Intent, messageId: number): InlineKeyboard {
  return to === "question"
    ? new InlineKeyboard().text("↩️ Answer as question instead", `as_q:${messageId}`)
    : new InlineKeyboard().text("📝 Save as entry too", `as_e:${messageId}`);
}

/** The routing layer: replies to the bot are conversation; otherwise classify. */
async function routeMessage(
  env: Env,
  ctx: Context,
  text: string,
  source: string,
  r2Key?: string,
  durationSec?: number,
): Promise<void> {
  const isReplyToBot = ctx.message?.reply_to_message?.from?.is_bot === true;
  const intent: Intent = isReplyToBot ? "question" : await classifyIntent(env, text);

  if (intent === "entry") {
    await handleAsEntry(env, ctx, text, source, r2Key, durationSec);
  } else {
    await handleAsQuestion(env, ctx, text, source, r2Key);
  }
}

async function handleAsEntry(
  env: Env,
  ctx: Context,
  text: string,
  source: string,
  r2Key?: string,
  durationSec?: number,
): Promise<void> {
  const { messageId, entries } = await ingestEntry(env, {
    text,
    source,
    telegramMessageId: ctx.message?.message_id,
    r2Key,
    durationSec,
  });
  await ctx.reply(confirmationText(entries), {
    reply_markup: rerouteKeyboard("question", messageId),
  });
}

async function handleAsQuestion(
  env: Env,
  ctx: Context,
  text: string,
  source: string,
  r2Key?: string,
): Promise<void> {
  const messageId = await insertMessage(env, {
    telegramMessageId: ctx.message?.message_id,
    source,
    role: "question",
    rawText: text,
    r2Key,
  });
  const answer = await answerWithContext(env, text);
  await insertMessage(env, { source: "bot", role: "assistant", rawText: answer });
  await ctx.reply(answer, { reply_markup: rerouteKeyboard("entry", messageId) });
}

async function answerWithContext(env: Env, question: string): Promise<string> {
  const [entries, conversation] = await Promise.all([
    entriesSince(env, now() - ANSWER_CONTEXT_DAYS * DAY),
    recentConversation(env, DAY),
  ]);
  return answerQuestion(env, question, { entries, conversation });
}
