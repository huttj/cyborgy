import type { Env, Delivery } from "./types";
import {
  entriesSince,
  latestReport,
  recentMessagesWithEntries,
  getMessage,
  deleteEntriesForMessage,
  insertEntries,
  setMessageDelivery,
  now,
} from "./db";
import { extractEntries } from "./llm";
import { dailyMoodEnergySeries } from "./scheduled";

/** Re-run extraction for one message (heals stuck rows, applies prompt changes). */
export async function reprocessMessage(env: Env, id: number): Promise<Response> {
  const msg = await getMessage(env, id);
  if (!msg?.raw_text) {
    return Response.json({ ok: false, error: "message not found or has no text" }, { status: 404 });
  }
  await deleteEntriesForMessage(env, id);
  const { entries, delivery } = await extractEntries(env, msg.raw_text);
  await insertEntries(env, id, msg.created_at, entries);
  await setMessageDelivery(env, id, delivery, msg.wps);
  return Response.json({ ok: true, entries, delivery });
}

/** Delete a message and its entries (R2 media is left in place). */
export async function deleteMessage(env: Env, id: number): Promise<Response> {
  await deleteEntriesForMessage(env, id);
  await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(id).run();
  return Response.json({ ok: true });
}

const DAY = 86400;

/** Raw messages + what the LLM extracted from each — the admin feed. */
export async function messagesData(env: Env): Promise<Response> {
  const messages = await recentMessagesWithEntries(env, 50);
  return Response.json({
    messages: messages.map((m) => ({
      id: m.id,
      createdAt: m.created_at,
      source: m.source,
      role: m.role,
      rawText: m.raw_text,
      r2Key: m.r2_key,
      wps: m.wps,
      delivery: m.delivery_json ? (JSON.parse(m.delivery_json) as Delivery) : null,
      entries: m.entries.map((e) => ({
        category: e.category,
        summary: e.summary,
        entities: JSON.parse(e.entities) as string[],
        mood: e.mood,
        energy: e.energy,
        notes: e.notes,
      })),
    })),
  });
}

export async function dashboardData(env: Env): Promise<Response> {
  const [entries, weekly] = await Promise.all([
    entriesSince(env, now() - 28 * DAY),
    latestReport(env, "weekly"),
  ]);

  const series = dailyMoodEnergySeries(env, entries);

  const categoryCounts: Record<string, number> = {};
  const recent = entries.filter((e) => e.ts >= now() - 7 * DAY);
  for (const e of recent) categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;

  return Response.json({
    series,
    categoryCounts,
    totalEntries: entries.length,
    latestWeeklyReport: weekly
      ? { markdown: weekly.content_md, createdAt: weekly.created_at }
      : null,
    recentEntries: recent
      .slice(-30)
      .reverse()
      .map((e) => ({
        ts: e.ts,
        category: e.category,
        summary: e.summary,
        mood: e.mood,
        energy: e.energy,
      })),
  });
}

export function dashboardPage(key: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>cyborgy</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 1rem; margin: 1rem 0; }
  .entry { padding: .35rem 0; border-bottom: 1px solid #8882; font-size: .9rem; }
  .entry .meta { opacity: .6; font-size: .8rem; }
  .badge { display: inline-block; background: #8882; border-radius: 6px; padding: 0 .4rem; margin-right: .3rem; font-size: .8rem; }
  pre.report { white-space: pre-wrap; font-family: inherit; }
</style>
</head>
<body>
<h1>🤖 cyborgy</h1>
<div class="card"><canvas id="moodChart"></canvas></div>
<h2>This week by category</h2>
<div id="categories"></div>
<h2>Latest weekly analysis</h2>
<div class="card"><pre class="report" id="report">Loading…</pre></div>
<h2>Recent entries</h2>
<div id="entries"></div>
<h2>Message feed <small style="opacity:.6">(what you sent → what got extracted)</small></h2>
<div id="messages"></div>
<script>
(async () => {
  const res = await fetch('/api/dashboard?key=' + encodeURIComponent(${JSON.stringify(key)}));
  const data = await res.json();

  new Chart(document.getElementById('moodChart'), {
    type: 'line',
    data: {
      labels: data.series.labels,
      datasets: [
        { label: 'Mood', data: data.series.mood, borderColor: '#e07a5f', spanGaps: true },
        { label: 'Energy', data: data.series.energy, borderColor: '#3d405b', spanGaps: true },
      ],
    },
    options: { scales: { y: { min: 1, max: 10 } } },
  });

  document.getElementById('categories').innerHTML = Object.entries(data.categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => '<span class="badge">' + cat + ' × ' + n + '</span>')
    .join(' ') || '<em>No entries this week yet.</em>';

  document.getElementById('report').textContent =
    data.latestWeeklyReport ? data.latestWeeklyReport.markdown : 'No weekly report yet — it generates Sunday evenings.';

  document.getElementById('entries').innerHTML = data.recentEntries.map(e => {
    const when = new Date(e.ts * 1000).toLocaleString();
    const scores = [e.mood != null ? 'mood ' + e.mood : null, e.energy != null ? 'energy ' + e.energy : null].filter(Boolean).join(', ');
    return '<div class="entry"><span class="badge">' + e.category + '</span>' + e.summary +
      (scores ? ' <em>(' + scores + ')</em>' : '') + '<div class="meta">' + when + '</div></div>';
  }).join('') || '<em>Nothing yet — go log something!</em>';

  const esc = s => s == null ? '' : String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const mres = await fetch('/api/messages?key=' + encodeURIComponent(${JSON.stringify(key)}));
  const mdata = await mres.json();
  document.getElementById('messages').innerHTML = mdata.messages.map(m => {
    const when = new Date(m.createdAt * 1000).toLocaleString();
    const media = m.r2Key
      ? (m.r2Key.startsWith('photo/')
          ? '<div><img src="/media/' + encodeURIComponent(m.r2Key) + '?key=' + encodeURIComponent(${JSON.stringify(key)}) + '" style="max-width:280px;border-radius:8px"></div>'
          : '<div><audio controls preload="none" src="/media/' + encodeURIComponent(m.r2Key) + '?key=' + encodeURIComponent(${JSON.stringify(key)}) + '"></audio></div>')
      : '';
    const delivery = m.delivery
      ? '<div class="meta">delivery: ' + m.delivery.tags.map(esc).join(', ') +
        (m.delivery.note ? ' — ' + esc(m.delivery.note) : '') + (m.wps ? ' · ' + m.wps + ' w/s' : '') + '</div>'
      : (m.wps ? '<div class="meta">' + m.wps + ' w/s</div>' : '');
    const entries = m.entries.map(e =>
      '<div class="entry" style="margin-left:1rem"><span class="badge">' + esc(e.category) + '</span>' + esc(e.summary) +
      ((e.mood != null || e.energy != null) ? ' <em>(' + [e.mood != null ? 'mood ' + e.mood : null, e.energy != null ? 'energy ' + e.energy : null].filter(Boolean).join(', ') + ')</em>' : '') +
      (e.entities.length ? '<div class="meta">entities: ' + e.entities.map(esc).join(', ') + '</div>' : '') +
      '</div>').join('');
    return '<div class="card"><div class="meta">' + when + ' · <span class="badge">' + esc(m.source) + '</span><span class="badge">' + esc(m.role) + '</span></div>' +
      (m.rawText ? '<div>' + esc(m.rawText) + '</div>' : '<em>(no text)</em>') + media + delivery +
      (entries ? '<div style="margin-top:.5rem">' + entries + '</div>' : '') + '</div>';
  }).join('') || '<em>No messages yet.</em>';
})();
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
