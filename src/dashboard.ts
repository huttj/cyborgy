import type { Env, Delivery } from "./types";
import {
  entriesSince,
  latestReport,
  queryMessagesWithEntries,
  getMessage,
  deleteEntriesForMessage,
  deleteEntry,
  insertEntries,
  insertMessage,
  setMessageDelivery,
  now,
} from "./db";
import { extractEntries } from "./llm";
import { transcribe } from "./pipeline";
import { answerWithContext } from "./bot";
import { dailyMoodEnergySeries } from "./scheduled";

const DAY = 86400;

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

/** Paginated, searchable message feed with extracted entries. */
export async function messagesData(env: Env, params: URLSearchParams): Promise<Response> {
  const limit = Number(params.get("limit")) || 20;
  const messages = await queryMessagesWithEntries(env, {
    limit,
    before: Number(params.get("before")) || undefined,
    since: Number(params.get("since")) || undefined,
    q: params.get("q")?.trim() || undefined,
  });
  return Response.json({
    messages: messages.map((m) => ({
      id: m.id,
      createdAt: m.created_at,
      source: m.source,
      role: m.role,
      rawText: m.raw_text,
      r2Key: m.r2_key,
      wps: m.wps,
      words: m.words_json ? (JSON.parse(m.words_json) as unknown[]) : null,
      delivery: m.delivery_json ? (JSON.parse(m.delivery_json) as Delivery) : null,
      entries: m.entries.map((e) => ({
        id: e.id,
        category: e.category,
        summary: e.summary,
        entities: JSON.parse(e.entities) as string[],
        mood: e.mood,
        energy: e.energy,
        notes: e.notes,
      })),
    })),
    nextBefore: messages.length === limit ? messages[messages.length - 1].id : null,
  });
}

/** Charts + categories + latest weekly report, for the Review tab. */
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
  });
}

/** Browser Q&A — same brain as asking the bot in Telegram. */
export async function askHandler(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();
  if (!question) return Response.json({ ok: false, error: "empty question" }, { status: 400 });

  await insertMessage(env, { source: "web", role: "question", rawText: question });
  const answer = await answerWithContext(env, question);
  await insertMessage(env, { source: "web", role: "assistant", rawText: answer });
  return Response.json({ ok: true, answer });
}

/**
 * Re-run the pipeline for one message (heals stuck rows, applies prompt changes).
 * With retranscribe=true, re-transcribes the archived R2 audio first — used to
 * backfill word timestamps or pick up transcription improvements.
 */
export async function reprocessMessage(
  env: Env,
  id: number,
  retranscribe = false,
): Promise<Response> {
  const msg = await getMessage(env, id);
  if (!msg) return Response.json({ ok: false, error: "message not found" }, { status: 404 });

  let text = msg.raw_text;
  if (retranscribe) {
    if (!msg.r2_key?.startsWith("voice/")) {
      return Response.json({ ok: false, error: "no archived audio for message" }, { status: 400 });
    }
    const object = await env.MEDIA.get(msg.r2_key);
    if (!object) return Response.json({ ok: false, error: "audio missing in R2" }, { status: 404 });
    const transcription = await transcribe(env, await object.arrayBuffer());
    text = transcription.text;
    await env.DB.prepare(`UPDATE messages SET raw_text = ?, words_json = ? WHERE id = ?`)
      .bind(text, transcription.words ? JSON.stringify(transcription.words) : null, id)
      .run();
  }
  if (!text) return Response.json({ ok: false, error: "message has no text" }, { status: 400 });

  await deleteEntriesForMessage(env, id);
  const { entries, delivery } = await extractEntries(env, text);
  await insertEntries(env, id, msg.created_at, entries);
  await setMessageDelivery(env, id, delivery, msg.wps);
  return Response.json({ ok: true, retranscribed: retranscribe, text, entries, delivery });
}

/** Delete a message and its entries (R2 media is left in place). */
export async function deleteMessage(env: Env, id: number): Promise<Response> {
  await deleteEntriesForMessage(env, id);
  await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(id).run();
  return Response.json({ ok: true });
}

/** Delete a single extracted entry, leaving the raw message intact. */
export async function deleteEntryHandler(env: Env, id: number): Promise<Response> {
  await deleteEntry(env, id);
  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// The app shell — Stream / Review / Ask tabs, hash-routed, no framework.
// ---------------------------------------------------------------------------

export function dashboardPage(key: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>cyborgy</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<style>
  :root { color-scheme: light dark; --accent: #e07a5f; --line: #8883; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 0 1rem 4rem; line-height: 1.55; }
  header { position: sticky; top: 0; backdrop-filter: blur(12px); background: color-mix(in srgb, Canvas 82%, transparent); z-index: 10; padding: .8rem 0 .5rem; border-bottom: 1px solid var(--line); margin-bottom: 1rem; }
  header h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  nav { display: flex; gap: .4rem; }
  nav button { border: 1px solid var(--line); background: none; color: inherit; border-radius: 999px; padding: .25rem .9rem; font-size: .9rem; cursor: pointer; }
  nav button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .view { display: none; } .view.on { display: block; }
  .card { border: 1px solid var(--line); border-radius: 14px; padding: .9rem 1rem; margin: .8rem 0; }
  .meta { opacity: .55; font-size: .78rem; }
  .badge { display: inline-block; border-radius: 6px; padding: 0 .45rem; margin-right: .3rem; font-size: .75rem; border: 1px solid var(--line); }
  .cat { border: 1px solid; }
  .entry { padding: .3rem 0 .3rem .8rem; border-left: 2px solid var(--line); margin: .35rem 0; font-size: .9rem; }
  .controls { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .6rem; }
  .controls input[type=search] { flex: 1; min-width: 160px; padding: .4rem .7rem; border-radius: 10px; border: 1px solid var(--line); background: none; color: inherit; font-size: .95rem; }
  .chip { border: 1px solid var(--line); background: none; color: inherit; border-radius: 999px; padding: .2rem .7rem; font-size: .8rem; cursor: pointer; }
  .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .w { cursor: pointer; border-radius: 3px; padding: 0 1px; }
  .w:hover { background: #8883; }
  .w.active { background: color-mix(in srgb, var(--accent) 45%, transparent); }
  audio { width: 100%; margin-top: .4rem; height: 36px; }
  img.ph { max-width: 280px; border-radius: 10px; margin-top: .4rem; }
  #more { display: block; margin: 1rem auto; }
  button.std { border: 1px solid var(--line); background: none; color: inherit; border-radius: 10px; padding: .4rem 1rem; cursor: pointer; }
  pre.report { white-space: pre-wrap; font-family: inherit; margin: 0; }
  /* Ask */
  #chat { display: flex; flex-direction: column; gap: .6rem; margin-bottom: 1rem; }
  .msg { padding: .6rem .9rem; border-radius: 14px; max-width: 85%; white-space: pre-wrap; }
  .msg.q { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
  .msg.a { align-self: flex-start; border: 1px solid var(--line); border-bottom-left-radius: 4px; }
  #askForm { display: flex; gap: .5rem; }
  #askInput { flex: 1; padding: .55rem .8rem; border-radius: 12px; border: 1px solid var(--line); background: none; color: inherit; font-size: 1rem; }
  .del { float: right; border: none; background: none; color: inherit; opacity: .35; cursor: pointer; font-size: .9rem; padding: 0 .2rem; }
  .del:hover { opacity: 1; color: #ef5350; }
  .md p { margin: .4rem 0; } .md ul, .md ol { margin: .3rem 0; padding-left: 1.3rem; }
  .md h1, .md h2, .md h3 { font-size: 1rem; margin: .6rem 0 .2rem; }
  .md code { background: #8882; border-radius: 4px; padding: 0 .25rem; font-size: .85em; }
</style>
</head>
<body>
<header>
  <h1>🤖 cyborgy</h1>
  <nav>
    <button data-v="stream">Stream</button>
    <button data-v="review">Review</button>
    <button data-v="ask">Ask</button>
  </nav>
</header>

<section id="stream" class="view">
  <div class="controls">
    <input type="search" id="q" placeholder="Search entries, foods, people…">
    <button class="chip range" data-d="1">Today</button>
    <button class="chip range on" data-d="7">7d</button>
    <button class="chip range" data-d="30">30d</button>
    <button class="chip range" data-d="0">All</button>
  </div>
  <div id="feed"></div>
  <button id="more" class="std" hidden>Load more</button>
</section>

<section id="review" class="view">
  <div class="card"><canvas id="moodChart"></canvas></div>
  <h2 style="font-size:1rem">This week by category</h2>
  <div id="categories"></div>
  <h2 style="font-size:1rem">Latest weekly analysis</h2>
  <div class="card md" id="report">Loading…</div>
</section>

<section id="ask" class="view">
  <div id="chat"></div>
  <form id="askForm">
    <input id="askInput" placeholder="Ask about your journal… (e.g. how was my mood this week?)" autocomplete="off">
    <button class="std" type="submit">Ask</button>
  </form>
</section>

<script>
const KEY = ${JSON.stringify(key)};
const CAT = { food:'#7cb342', exercise:'#fb8c00', activity:'#42a5f5', social:'#ab47bc',
              work:'#78909c', mood:'#ef5350', thought:'#26a69a', sleep:'#5c6bc0', other:'#9e9e9e' };
const CAT_ICON = { food:'🍽️', exercise:'🏃', activity:'🎨', social:'👥', work:'💼',
                   mood:'🌗', thought:'💭', sleep:'😴', other:'📌' };
const SRC_ICON = { voice:'🎙️', text:'💬', photo:'📷', shortcut:'⌚', web:'🌐', bot:'🤖' };
const ROLE_ICON = { entry:'📝', question:'❓', assistant:'🤖' };
const esc = s => s == null ? '' : String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const md = s => DOMPurify.sanitize(marked.parse(s || ''));
const api = (path, opts) => fetch(path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY), opts).then(r => r.json());
const catBadge = c => '<span class="badge cat" style="border-color:' + (CAT[c]||CAT.other) + ';background:' + (CAT[c]||CAT.other) + '22">' + (CAT_ICON[c]||CAT_ICON.other) + ' ' + esc(c) + '</span>';

// --- tabs (hash-routed) ---
function show(v) {
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === v));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  location.hash = v;
  if (v === 'review' && !reviewLoaded) loadReview();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.v));

// --- Stream ---
let nextBefore = null, rangeDays = 7, query = '';
const feed = document.getElementById('feed');
const moreBtn = document.getElementById('more');

function sinceParam() {
  if (!rangeDays) return '';
  if (rangeDays === 1) { const d = new Date(); d.setHours(0,0,0,0); return '&since=' + Math.floor(d.getTime()/1000); }
  return '&since=' + (Math.floor(Date.now()/1000) - rangeDays*86400);
}

async function loadFeed(reset) {
  if (reset) { feed.innerHTML = '<div class="meta">Loading…</div>'; nextBefore = null; }
  const data = await api('/api/messages?limit=20' + sinceParam()
    + (query ? '&q=' + encodeURIComponent(query) : '')
    + (nextBefore ? '&before=' + nextBefore : ''));
  if (reset) feed.innerHTML = '';
  if (reset && data.messages.length === 0) feed.innerHTML = '<em>Nothing here — go log something!</em>';
  for (const m of data.messages) feed.appendChild(renderMessage(m));
  nextBefore = data.nextBefore;
  moreBtn.hidden = !nextBefore;
}

function renderMessage(m) {
  const card = document.createElement('div');
  card.className = 'card';
  const when = new Date(m.createdAt * 1000).toLocaleString([], {weekday:'short', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit'});
  const text = (m.words && m.words.length)
    ? '<div class="transcript">' + m.words.map(w => '<span class="w" data-s="' + w.start + '" data-e="' + w.end + '">' + esc(w.word) + '</span>').join(' ') + '</div>'
    : (m.rawText ? '<div>' + esc(m.rawText) + '</div>' : '<em>(no text)</em>');
  const media = m.r2Key
    ? (m.r2Key.startsWith('photo/')
        ? '<img class="ph" loading="lazy" src="/media/' + encodeURIComponent(m.r2Key) + '?key=' + encodeURIComponent(KEY) + '">'
        : '<audio controls preload="none" src="/media/' + encodeURIComponent(m.r2Key) + '?key=' + encodeURIComponent(KEY) + '"></audio>')
    : '';
  const delivery = m.delivery
    ? '<div class="meta">🗣 ' + m.delivery.tags.map(esc).join(', ') + (m.delivery.note ? ' — ' + esc(m.delivery.note) : '') + (m.wps ? ' · ' + m.wps + ' w/s' : '') + '</div>'
    : (m.wps ? '<div class="meta">🗣 ' + m.wps + ' w/s</div>' : '');
  const entries = m.entries.map(e =>
    '<div class="entry" style="border-left-color:' + (CAT[e.category]||CAT.other) + '">' +
    '<button class="del delE" data-eid="' + e.id + '" title="Delete this entry">✕</button>' +
    catBadge(e.category) + esc(e.summary) +
    ((e.mood != null || e.energy != null) ? ' <em class="meta">(' + [e.mood != null ? 'mood ' + e.mood : null, e.energy != null ? 'energy ' + e.energy : null].filter(Boolean).join(', ') + ')</em>' : '') +
    (e.entities.length ? '<div class="meta">' + e.entities.map(esc).join(' · ') + '</div>' : '') +
    '</div>').join('');
  const src = m.source.replace('telegram_','');
  card.innerHTML = '<div class="meta">' +
    '<button class="del delM" data-mid="' + m.id + '" title="Delete message + its entries">✕</button>' +
    when + ' · <span class="badge">' + (SRC_ICON[src]||'') + ' ' + esc(src) + '</span><span class="badge">' + (ROLE_ICON[m.role]||'') + ' ' + esc(m.role) + '</span></div>'
    + text + media + delivery + (entries ? '<div style="margin-top:.5rem">' + entries + '</div>' : '');

  // karaoke wiring
  const audio = card.querySelector('audio');
  const words = [...card.querySelectorAll('.w')];
  if (audio && words.length) {
    card.querySelector('.transcript').addEventListener('click', e => {
      const w = e.target.closest('.w'); if (!w) return;
      audio.currentTime = parseFloat(w.dataset.s); audio.play();
    });
    audio.addEventListener('timeupdate', () => {
      const t = audio.currentTime;
      for (const w of words) w.classList.toggle('active', t >= parseFloat(w.dataset.s) && t < parseFloat(w.dataset.e) + 0.15);
    });
    audio.addEventListener('ended', () => words.forEach(w => w.classList.remove('active')));
  }
  return card;
}

// Delete buttons (event delegation on the feed).
feed.addEventListener('click', async e => {
  const delM = e.target.closest('.delM');
  const delE = e.target.closest('.delE');
  if (delM && confirm('Delete this message and all its entries?')) {
    await api('/api/admin/messages?id=' + delM.dataset.mid, { method: 'DELETE' });
    delM.closest('.card').remove();
  } else if (delE && confirm('Delete this entry?')) {
    await api('/api/admin/entries?id=' + delE.dataset.eid, { method: 'DELETE' });
    delE.closest('.entry').remove();
  }
});

moreBtn.onclick = () => loadFeed(false);
document.querySelectorAll('.chip.range').forEach(b => b.onclick = () => {
  document.querySelectorAll('.chip.range').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); rangeDays = Number(b.dataset.d); loadFeed(true);
});
let qTimer;
document.getElementById('q').addEventListener('input', e => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { query = e.target.value.trim(); loadFeed(true); }, 350);
});

// --- Review ---
let reviewLoaded = false;
async function loadReview() {
  reviewLoaded = true;
  const data = await api('/api/dashboard');
  new Chart(document.getElementById('moodChart'), {
    type: 'line',
    data: { labels: data.series.labels, datasets: [
      { label: 'Mood', data: data.series.mood, borderColor: CAT.mood, spanGaps: true, tension: .3 },
      { label: 'Energy', data: data.series.energy, borderColor: CAT.sleep, spanGaps: true, tension: .3 },
    ]},
    options: { scales: { y: { min: 1, max: 10 } } },
  });
  document.getElementById('categories').innerHTML = Object.entries(data.categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => catBadge(c) + '<span class="meta">× ' + n + '</span> ')
    .join(' ') || '<em>No entries this week yet.</em>';
  document.getElementById('report').innerHTML =
    data.latestWeeklyReport ? md(data.latestWeeklyReport.markdown) : '<em>No weekly report yet — it generates Sunday evenings.</em>';
}

// --- Ask ---
const chat = document.getElementById('chat');
document.getElementById('askForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('askInput');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  chat.insertAdjacentHTML('beforeend', '<div class="msg q">' + esc(question) + '</div>');
  const pending = document.createElement('div');
  pending.className = 'msg a md'; pending.textContent = '…thinking';
  chat.appendChild(pending); pending.scrollIntoView({behavior:'smooth'});
  try {
    const res = await api('/api/ask', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ question }) });
    if (res.ok) pending.innerHTML = md(res.answer);
    else pending.textContent = 'Error: ' + (res.error || 'something went wrong');
  } catch { pending.textContent = 'Error: request failed'; }
  pending.scrollIntoView({behavior:'smooth'});
});

// --- boot ---
show(['stream','review','ask'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'stream');
loadFeed(true);
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
