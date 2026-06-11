import Anthropic from "@anthropic-ai/sdk";
import type { Env, ExtractedEntry, ExtractionResult, Intent, EntryRow, MessageRow } from "./types";

const EXTRACT_MODEL = "claude-haiku-4-5"; // cheap structured extraction per entry
const ROUTE_MODEL = "claude-haiku-4-5"; //  entry-vs-question classification
const CHAT_MODEL = "claude-opus-4-8"; //    Q&A and recaps
const ANALYSIS_MODEL = "claude-opus-4-8"; // weekly correlation report

function client(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

function firstText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block in response");
  return block.text;
}

// ---------------------------------------------------------------------------
// Routing: is this inbound message a journal entry or a question?
// ---------------------------------------------------------------------------

const INTENT_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string", enum: ["entry", "question"] } },
  required: ["intent"],
  additionalProperties: false,
} as const;

export async function classifyIntent(env: Env, text: string): Promise<Intent> {
  const response = await client(env).messages.create({
    model: ROUTE_MODEL,
    max_tokens: 256,
    system:
      "You route messages for a personal life-tracking journal bot. " +
      "'entry' = the user is recording something about their life: what they ate, did, " +
      "felt, thought, who they saw, how they slept. Usually statements, often rambling voice notes. " +
      "'question' = the user is asking the bot something or requesting analysis/recall " +
      "('what did I eat yesterday', 'how has my mood been', 'when do I feel best'). " +
      "When genuinely ambiguous, prefer 'entry' — saving is cheap and correctable.",
    messages: [{ role: "user", content: text }],
    output_config: {
      format: { type: "json_schema", schema: INTENT_SCHEMA as unknown as Record<string, unknown> },
    },
  });
  return (JSON.parse(firstText(response)) as { intent: Intent }).intent;
}

// ---------------------------------------------------------------------------
// Extraction: transcript/photo -> structured entries
// ---------------------------------------------------------------------------

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "food",
              "exercise",
              "activity",
              "social",
              "work",
              "mood",
              "thought",
              "sleep",
              "other",
            ],
          },
          summary: { type: "string" },
          entities: { type: "array", items: { type: "string" } },
          mood: { type: ["integer", "null"] },
          energy: { type: ["integer", "null"] },
          notes: { type: ["string", "null"] },
        },
        required: ["category", "summary", "entities", "mood", "energy", "notes"],
        additionalProperties: false,
      },
    },
    delivery: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        note: { type: ["string", "null"] },
      },
      required: ["tags", "note"],
      additionalProperties: false,
    },
  },
  required: ["entries", "delivery"],
  additionalProperties: false,
} as const;

const EXTRACTION_SYSTEM = `You extract structured journal entries from a personal life-tracker's voice transcripts, texts, and photos. The goal is later correlation analysis of what affects the user's happiness.

Rules:
- Split the input into distinct entries: each meal, workout, activity, social interaction, mood statement, or notable thought is its own entry.
- summary: one concise line, third person omitted ("oatmeal with blueberries", "ran 5k along the river", "frustrated about the deploy").
- entities: the concrete nouns worth correlating later (foods, people, places, activities).
- mood and energy: integers 1-10, ONLY when the user actually expresses them (explicitly or very clearly implied). Otherwise null. Do not invent scores.
- notes: anything contextual that doesn't fit the summary, else null.
- For photos: describe what's depicted (e.g. the meal) as the entry; combine with any caption.
- If the input contains nothing journal-worthy, return an empty entries array.

Separately, report "delivery" — HOW the message reads, not what it says. This is a subtle signal of internal state worth tracking over time.
- tags: short lowercase observable features, e.g. "self-interrupting", "restarts", "hedging", "fragmented", "flowing", "terse", "rambling", "emphatic", "flat", "questioning-self". Use the same tag vocabulary consistently when the same pattern recurs. Empty array if nothing stands out.
- note: ONE sentence on what stands out about the delivery, or null.
- Stay observational, not diagnostic: describe the speech/writing pattern, never infer a mental state ("fragmented, three restarts mid-sentence" — not "anxious").
- IMPORTANT: voice transcripts have been cleaned by the transcriber — filler words and pauses are mostly removed. Absence of disfluency is NOT evidence of composure; only positively-present features count.
- For photos with no text, return empty tags and null note.`;

export async function extractEntries(
  env: Env,
  text: string | null,
  image?: { base64: string; mediaType: "image/jpeg" | "image/png" },
): Promise<ExtractionResult> {
  const content: Anthropic.ContentBlockParam[] = [];
  if (image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.base64 },
    });
  }
  content.push({ type: "text", text: text?.trim() ? text : "(no text — see image)" });

  const response = await client(env).messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 2048,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: "user", content }],
    output_config: {
      format: {
        type: "json_schema",
        schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });
  return JSON.parse(firstText(response)) as ExtractionResult;
}

// ---------------------------------------------------------------------------
// Q&A over the journal
// ---------------------------------------------------------------------------

export function formatEntryLine(e: EntryRow, timeZone: string): string {
  const when = new Date(e.ts * 1000).toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const scores = [
    e.mood != null ? `mood ${e.mood}` : null,
    e.energy != null ? `energy ${e.energy}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `[${when}] ${e.category}: ${e.summary}${scores ? ` (${scores})` : ""}`;
}

export async function answerQuestion(
  env: Env,
  question: string,
  context: { entries: EntryRow[]; conversation: MessageRow[] },
): Promise<string> {
  const journal = context.entries.map((e) => formatEntryLine(e, env.TIMEZONE)).join("\n");

  const history: Anthropic.MessageParam[] = context.conversation.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.raw_text ?? "",
  }));

  const response = await client(env).messages.create({
    model: CHAT_MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system:
      "You are the user's personal journal assistant on Telegram. Answer questions about " +
      "their life using the journal entries below. Be specific, cite days/times naturally, " +
      "and keep answers conversational and reasonably short — this is a chat, not a report. " +
      "If the journal doesn't contain the answer, say so plainly.\n\n" +
      `Recent journal entries (timezone ${env.TIMEZONE}):\n${journal || "(no entries yet)"}`,
    messages: [...history, { role: "user", content: question }],
  });
  return firstText(response);
}

// ---------------------------------------------------------------------------
// Recaps
// ---------------------------------------------------------------------------

export async function writeDailyRecap(env: Env, todayEntries: EntryRow[]): Promise<string> {
  const journal = todayEntries.map((e) => formatEntryLine(e, env.TIMEZONE)).join("\n");
  const response = await client(env).messages.create({
    model: CHAT_MODEL,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system:
      "Write the user's end-of-day recap as a short, warm Telegram message (under 150 words). " +
      "Summarize the day from their journal entries, note mood/energy if recorded, and end with " +
      "ONE brief reflective question about anything notable that went unrecorded (e.g. dinner, " +
      "exercise, mood). Plain text, light emoji ok, no markdown headers.",
    messages: [{ role: "user", content: `Today's entries:\n${journal}` }],
  });
  return firstText(response);
}

export async function writeWeeklyAnalysis(
  env: Env,
  thisWeek: EntryRow[],
  lastWeek: EntryRow[],
  deliverySummary?: string,
): Promise<string> {
  const fmt = (rows: EntryRow[]) =>
    rows.map((e) => formatEntryLine(e, env.TIMEZONE)).join("\n") || "(none)";
  const deliverySection = deliverySummary
    ? `\n\nDELIVERY PATTERNS (how the user spoke, from voice-note analysis — speech rate in words/sec and observed speech features):\n${deliverySummary}`
    : "";
  const response = await client(env).messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system:
      "You are the analysis engine of a personal happiness tracker. From the user's journal " +
      "entries, produce a weekly report with:\n" +
      "1. A 2-3 sentence headline summary of the week (mood/energy trend vs last week).\n" +
      "2. Candidate correlations — patterns linking food/exercise/social/work/sleep to same-day " +
      "and NEXT-day mood/energy. Treat these as hypotheses, not findings (n=1, observational). " +
      "State the evidence for each (which days).\n" +
      "3. If delivery patterns are provided: note any alignment between speech features " +
      "(rate, fragmentation, hedging) and reported mood/energy — these are indirect signals " +
      "of internal state that the user may not have reported explicitly.\n" +
      "4. One or two suggested mini-experiments for next week to test the strongest hypothesis.\n" +
      "5. Gaps: what's under-logged that limits the analysis.\n" +
      "Format as a Telegram-friendly message: short sections with bold-style *headers*, " +
      "bullet lists, under 400 words. No tables.",
    messages: [
      {
        role: "user",
        content: `THIS WEEK:\n${fmt(thisWeek)}\n\nPREVIOUS WEEK (for comparison):\n${fmt(lastWeek)}${deliverySection}`,
      },
    ],
  });
  return firstText(response);
}
