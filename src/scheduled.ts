import type { Env, EntryRow } from "./types";
import { writeDailyRecap, writeWeeklyAnalysis } from "./llm";
import { sendToUser, sendPhotoToUser } from "./telegram-api";
import {
  entriesSince,
  deliverySince,
  lastEntryTime,
  lastPingTime,
  pingCountSince,
  logPing,
  saveReport,
  purgeExpiredAuth,
  insertMessage,
  now,
} from "./db";

/** Send to Telegram AND record in the feed so outbound messages show in the UI. */
async function broadcast(env: Env, text: string): Promise<void> {
  await sendToUser(env, text);
  await insertMessage(env, { source: "bot", role: "broadcast", rawText: text });
}
import type { Delivery } from "./types";

const DAY = 86400;
const HOUR = 3600;

// Smart-ping tuning
const PING_WINDOW = { start: 9, end: 20 }; // local hours, inclusive
const MAX_PINGS_PER_DAY = 4;
const SUPPRESS_AFTER_ENTRY_HOURS = 3;
const MIN_HOURS_BETWEEN_PINGS = 2;
const PING_PROBABILITY = 0.4; // per eligible hour → ~3-4 pings/day after suppression

const DAILY_RECAP_HOUR = 21;
const WEEKLY_RECAP = { weekday: 0, hour: 18 }; // Sunday 6pm local

const PING_PROMPTS = [
  "How's the last couple hours been? Anything worth logging — food, mood, what you're up to?",
  "Quick check-in 👋 What are you doing right now, and how's your energy?",
  "Anything happen since you last logged? Even a one-liner helps the weekly analysis.",
  "Mood check: 1-10, and what's driving it?",
  "What did you last eat? (Photo works too 📸)",
  "Who have you talked to today? How'd it feel?",
];

export function localParts(env: Env, date = new Date()): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: env.TIMEZONE,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdays.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "Sun");
  return { hour, weekday };
}

/** Unix time of local midnight today in env.TIMEZONE (approximate via offset probe). */
function localMidnight(env: Env): number {
  const nowDate = new Date();
  const local = new Date(nowDate.toLocaleString("en-US", { timeZone: env.TIMEZONE }));
  const offsetMs = nowDate.getTime() - local.getTime();
  const midnightLocal = new Date(local);
  midnightLocal.setHours(0, 0, 0, 0);
  return Math.floor((midnightLocal.getTime() + offsetMs) / 1000);
}

export async function runScheduled(env: Env): Promise<void> {
  await purgeExpiredAuth(env).catch(() => {});
  const { hour, weekday } = localParts(env);

  if (weekday === WEEKLY_RECAP.weekday && hour === WEEKLY_RECAP.hour) {
    await runWeeklyRecap(env);
    return;
  }
  if (hour === DAILY_RECAP_HOUR) {
    await runDailyRecap(env);
    return;
  }
  if (hour >= PING_WINDOW.start && hour <= PING_WINDOW.end) {
    await maybePing(env);
  }
}

async function maybePing(env: Env): Promise<void> {
  const t = now();
  const midnight = localMidnight(env);

  if ((await pingCountSince(env, "ping", midnight)) >= MAX_PINGS_PER_DAY) return;

  const lastPing = await lastPingTime(env, "ping");
  if (lastPing && t - lastPing < MIN_HOURS_BETWEEN_PINGS * HOUR) return;

  const lastEntry = await lastEntryTime(env);
  if (lastEntry && t - lastEntry < SUPPRESS_AFTER_ENTRY_HOURS * HOUR) return;

  if (Math.random() > PING_PROBABILITY) return;

  const prompt = PING_PROMPTS[Math.floor(Math.random() * PING_PROMPTS.length)];
  await broadcast(env, prompt);
  await logPing(env, "ping");
}

async function runDailyRecap(env: Env): Promise<void> {
  const midnight = localMidnight(env);
  // Guard against double-fire (cron retries, etc.)
  if (await lastPingTimeAfter(env, "daily_recap", midnight)) return;

  const todayEntries = await entriesSince(env, midnight);
  if (todayEntries.length === 0) {
    await broadcast(env, "No entries today 🌙 Want to voice-note a quick recap of your day before bed?");
    await logPing(env, "daily_recap");
    return;
  }
  const recap = await writeDailyRecap(env, todayEntries);
  await broadcast(env, recap);
  await saveReport(env, "daily", midnight, now(), recap, null);
  await logPing(env, "daily_recap");
}

async function runWeeklyRecap(env: Env): Promise<void> {
  const t = now();
  if (await lastPingTimeAfter(env, "weekly_recap", t - 6 * DAY)) return;

  const thisWeek = await entriesSince(env, t - 7 * DAY);
  const lastWeek = await entriesSince(env, t - 14 * DAY, t - 7 * DAY);

  if (thisWeek.length === 0) {
    await broadcast(env, "No entries this week, so no analysis — let's change that next week 💪");
    await logPing(env, "weekly_recap");
    return;
  }

  const deliverySummary = await summarizeDelivery(env, t - 7 * DAY);
  const report = await writeWeeklyAnalysis(env, thisWeek, lastWeek, deliverySummary);
  const series = dailyMoodEnergySeries(env, thisWeek);
  await saveReport(env, "weekly", t - 7 * DAY, t, report, series);

  // Chart via QuickChart (renders Chart.js configs to an image URL).
  const chartUrl = quickChartUrl(series);
  // No key in the link — the dashboard uses /login session cookies now.
  const dashboardUrl = env.PUBLIC_URL;
  if (chartUrl) {
    await sendPhotoToUser(env, chartUrl, "📊 Your week in mood & energy");
  }
  await broadcast(env, `${report}\n\n📈 Full dashboard: ${dashboardUrl}`);
  await logPing(env, "weekly_recap");
}

/** Compact per-day delivery digest for the weekly analysis prompt. */
async function summarizeDelivery(env: Env, since: number): Promise<string | undefined> {
  const rows = await deliverySince(env, since);
  if (rows.length === 0) return undefined;

  const byDay = new Map<string, { wps: number[]; tags: string[]; notes: string[] }>();
  for (const row of rows) {
    const day = new Date(row.created_at * 1000).toLocaleDateString("en-US", {
      timeZone: env.TIMEZONE,
      weekday: "short",
      month: "numeric",
      day: "numeric",
    });
    const bucket = byDay.get(day) ?? { wps: [], tags: [], notes: [] };
    if (row.wps != null) bucket.wps.push(row.wps);
    if (row.delivery_json) {
      const delivery = JSON.parse(row.delivery_json) as Delivery;
      bucket.tags.push(...delivery.tags);
      if (delivery.note) bucket.notes.push(delivery.note);
    }
    byDay.set(day, bucket);
  }

  const lines: string[] = [];
  for (const [day, b] of byDay) {
    const avgWps = b.wps.length
      ? (b.wps.reduce((a, x) => a + x, 0) / b.wps.length).toFixed(1)
      : null;
    const tagCounts = new Map<string, number>();
    for (const tag of b.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    const tags = [...tagCounts.entries()]
      .sort((a, x) => x[1] - a[1])
      .slice(0, 5)
      .map(([tag, n]) => (n > 1 ? `${tag}×${n}` : tag))
      .join(", ");
    const parts = [
      avgWps ? `avg ${avgWps} w/s` : null,
      tags || null,
      b.notes.length ? `notes: ${b.notes.slice(0, 2).join(" | ")}` : null,
    ].filter(Boolean);
    if (parts.length) lines.push(`[${day}] ${parts.join("; ")}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

async function lastPingTimeAfter(env: Env, kind: string, since: number): Promise<boolean> {
  const last = await lastPingTime(env, kind);
  return last != null && last >= since;
}

export type Resolution = "hour" | "day" | "week";

export interface MoodEnergySeries {
  labels: string[];
  mood: (number | null)[];
  energy: (number | null)[];
  moodLo: (number | null)[];
  moodHi: (number | null)[];
  energyLo: (number | null)[];
  energyHi: (number | null)[];
  counts: number[];
}

/** Chronological {sortKey, label} for an entry at the chosen time resolution. */
function bucketFor(env: Env, ts: number, res: Resolution): { key: string; label: string } {
  const tz = env.TIMEZONE;
  const d = new Date(ts * 1000);
  if (res === "hour") {
    const key = d.toLocaleString("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    const label = d.toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric" });
    return { key, label };
  }
  const ymd = d.toLocaleDateString("en-CA", { timeZone: tz }); // sortable "2026-06-14"
  if (res === "week") {
    const [Y, M, D] = ymd.split("-").map(Number);
    const dt = new Date(Date.UTC(Y, M - 1, D));
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // snap to Monday
    const key = dt.toISOString().slice(0, 10);
    const label =
      "wk " + dt.toLocaleDateString("en-US", { timeZone: "UTC", month: "numeric", day: "numeric" });
    return { key, label };
  }
  const label = d.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });
  return { key: ymd, label };
}

export function moodEnergySeries(
  env: Env,
  entries: EntryRow[],
  res: Resolution = "day",
): MoodEnergySeries {
  const buckets = new Map<
    string,
    { label: string; mood: number[]; energy: number[]; count: number }
  >();
  for (const e of entries) {
    const { key, label } = bucketFor(env, e.ts, res);
    const b = buckets.get(key) ?? { label, mood: [], energy: [], count: 0 };
    b.count++;
    if (e.mood != null) b.mood.push(e.mood);
    if (e.energy != null) b.energy.push(e.energy);
    buckets.set(key, b);
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
  const keys = [...buckets.keys()].sort(); // sortKeys are chronological strings
  const g = (k: string) => buckets.get(k)!;
  return {
    labels: keys.map((k) => g(k).label),
    mood: keys.map((k) => mean(g(k).mood)),
    energy: keys.map((k) => mean(g(k).energy)),
    moodLo: keys.map((k) => min(g(k).mood)),
    moodHi: keys.map((k) => max(g(k).mood)),
    energyLo: keys.map((k) => min(g(k).energy)),
    energyHi: keys.map((k) => max(g(k).energy)),
    counts: keys.map((k) => g(k).count),
  };
}

/** Back-compat alias for the weekly-recap chart (day resolution). */
export function dailyMoodEnergySeries(env: Env, entries: EntryRow[]): MoodEnergySeries {
  return moodEnergySeries(env, entries, "day");
}

function quickChartUrl(series: MoodEnergySeries): string | null {
  if (series.labels.length === 0) return null;
  const config = {
    type: "line",
    data: {
      labels: series.labels,
      datasets: [
        { label: "Mood", data: series.mood, borderColor: "#e07a5f", spanGaps: true },
        { label: "Energy", data: series.energy, borderColor: "#3d405b", spanGaps: true },
      ],
    },
    options: { scales: { y: { min: 1, max: 10 } } },
  };
  return `https://quickchart.io/chart?w=800&h=400&c=${encodeURIComponent(JSON.stringify(config))}`;
}
