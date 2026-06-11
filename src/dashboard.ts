import type { Env } from "./types";
import { entriesSince, latestReport, now } from "./db";
import { dailyMoodEnergySeries } from "./scheduled";

const DAY = 86400;

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
})();
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
