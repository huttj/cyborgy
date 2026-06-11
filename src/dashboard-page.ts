// ---------------------------------------------------------------------------
// The app shell — Stream / Review / Ask tabs, hash-routed, no framework.
// SVG icons (lucide-style) throughout; no emoji in chrome.
// ---------------------------------------------------------------------------

export function dashboardPage(key: string | null): Response {
  const build = new Date().toISOString().slice(0, 16).replace("T", " ");
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
  nav button { border: 1px solid var(--line); background: none; color: inherit; border-radius: 4px; padding: .25rem .9rem; font-size: .9rem; cursor: pointer; }
  nav button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .view { display: none; } .view.on { display: block; }

  .icon { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vertical-align: -3px; flex: none; }

  /* cards: box aligns with the search bar; type/stat columns float in the
     page margins on wide screens, fall back inline on narrow ones */
  .card { position: relative; display: flex; gap: .55rem; margin: .9rem 0; align-items: flex-start; }
  .typecol, .statcol { display: flex; flex-direction: column; gap: .5rem; align-items: center; min-width: 1.6rem; padding-top: .6rem; }
  .statcol { gap: .65rem; }
  .typecol .icon { width: 17px; height: 17px; opacity: .65; }
  .stat { display: flex; flex-direction: column; align-items: center; line-height: 1.1; gap: 1px; }
  .stat .icon { width: 17px; height: 17px; }
  .stat b { font-size: .68rem; opacity: .7; font-weight: 600; }
  .box { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 4px; padding: .65rem .85rem; }
  @media (min-width: 880px) {
    .card { display: block; }
    .typecol { position: absolute; right: calc(100% + .7rem); top: 0; }
    .statcol { position: absolute; left: calc(100% + .7rem); top: 0; }
  }

  .meta { opacity: .55; font-size: .78rem; }
  .head { cursor: pointer; user-select: none; }
  .badge { display: inline-block; border-radius: 3px; padding: 0 .45rem; margin-right: .3rem; font-size: .75rem; border: 1px solid var(--line); }
  .entry { padding: .25rem 0; margin: .35rem 0; font-size: .85rem; display: flex; align-items: flex-start; gap: .5rem; }
  .entry .catbadge { margin-top: 1px; }
  .entry .esum { flex: 1; min-width: 0; }
  .catbadge { display: inline-flex; align-items: center; justify-content: center; gap: .25rem; border-radius: 3px; padding: .05rem 0; font-size: .75rem; border: 1px solid; width: 5.4rem; flex: none; }
  .catrow { display: flex; gap: .55rem; margin-top: .45rem; }
  .catrow .icon { width: 15px; height: 15px; }

  .controls { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .6rem; }
  .controls input[type=search] { flex: 1; min-width: 160px; padding: .4rem .7rem; border-radius: 4px; border: 1px solid var(--line); background: none; color: inherit; font-size: .95rem; }
  .chip { border: 1px solid var(--line); background: none; color: inherit; border-radius: 4px; padding: .2rem .7rem; font-size: .8rem; cursor: pointer; }
  .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }

  .w { cursor: pointer; border-radius: 3px; padding: 0 1px; }
  .w:hover { background: #8883; }
  .w.active { background: color-mix(in srgb, var(--accent) 45%, transparent); }

  /* custom audio player — divider above separates it from the transcript */
  .player { display: flex; align-items: center; gap: .6rem; margin-top: .6rem; padding: .55rem .3rem 0; border-top: 1px solid var(--line); }
  .pbtn { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line); background: none; color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; flex: none; }
  .pbtn .icon { width: 13px; height: 13px; }
  .ptrack { flex: 1; height: 6px; border-radius: 3px; background: #8883; cursor: pointer; overflow: hidden; }
  .pfill { height: 100%; width: 0; background: var(--accent); }
  .ptime { font-size: .72rem; opacity: .6; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .prate { border: 1px solid var(--line); border-radius: 3px; background: none; color: inherit; opacity: .7; cursor: pointer; font-size: .7rem; padding: .05rem .35rem; flex: none; font-variant-numeric: tabular-nums; }
  .prate:hover { opacity: 1; }

  img.ph { max-width: 280px; border-radius: 4px; margin-top: .4rem; }
  img.thumb { display: block; max-height: 64px; border-radius: 3px; margin-top: .35rem; }
  .entry .delE { float: none; flex: none; align-self: center; }
  .entry .delE .icon { width: 13px; height: 13px; }
  #more { display: block; margin: 1rem auto; }
  button.std { border: 1px solid var(--line); background: none; color: inherit; border-radius: 4px; padding: .4rem 1rem; cursor: pointer; }

  #chat { display: flex; flex-direction: column; gap: .6rem; margin-bottom: 1rem; }
  .msg { padding: .5rem .8rem; border-radius: 4px; max-width: 85%; }
  .msg.q { align-self: flex-end; background: var(--accent); color: #fff; }
  .msg.a { align-self: flex-start; border: 1px solid var(--line); }
  #askForm { display: flex; gap: .5rem; }
  #askInput { flex: 1; padding: .55rem .8rem; border-radius: 4px; border: 1px solid var(--line); background: none; color: inherit; font-size: 1rem; }

  .del { float: right; border: none; background: none; color: inherit; opacity: .4; cursor: pointer; padding: .1rem .2rem; }
  .del:hover { opacity: 1; color: #ef5350; }
  .del.rex:hover { color: var(--accent); }
  .del.rex { margin-right: .45rem; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .rex.busy .icon { animation: rot 1s linear infinite; }
  .tog { border: none; background: none; color: inherit; opacity: .65; cursor: pointer; padding: .15rem .5rem .15rem 0; margin-left: -4px; }
  .tog .icon { transition: transform .15s; width: 13px; height: 13px; vertical-align: -2px; }
  .card.open .tog .icon { transform: rotate(90deg); }
  .preview { cursor: pointer; margin-top: .3rem; font-size: .85rem; }
  .preview .qtext { font-weight: 600; }
  .preview .digest { margin-top: .35rem; font-size: .82rem; opacity: .8; display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
  .card.open .preview { display: none; }
  .card .detail { display: none; } .card.open .detail { display: block; margin-top: .35rem; font-size: .85rem; }
  .digest .dcount { margin-left: auto; }
  .qfull { font-weight: 600; }
  .answer { margin-top: .5rem; padding-top: .5rem; border-top: 1px solid var(--line); font-size: .85rem; }
  .aiblock { border-top: 1px solid var(--line); margin-top: .6rem; padding-top: .55rem; }

  .md p { margin: .25rem 0; } .md ul, .md ol { margin: .2rem 0; padding-left: 1.2rem; }
  .md li { margin: .1rem 0; } .md li p { margin: 0; }
  .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3 { font-size: 1rem; margin: .5rem 0 .15rem; }
  .md code { background: #8882; border-radius: 3px; padding: 0 .25rem; font-size: .85em; }
  footer { margin-top: 3rem; text-align: center; opacity: .35; font-size: .7rem; }
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
  <div class="box" style="margin:.9rem 0"><canvas id="moodChart"></canvas></div>
  <h2 style="font-size:1rem">This week by category</h2>
  <div id="categories"></div>
  <h2 style="font-size:1rem">Latest weekly analysis</h2>
  <div class="box md" id="report">Loading…</div>
</section>

<section id="ask" class="view">
  <div id="chat"></div>
  <form id="askForm">
    <input id="askInput" placeholder="Ask about your journal… (e.g. how was my mood this week?)" autocomplete="off">
    <button class="std" type="submit">Ask</button>
  </form>
</section>

<footer>cyborgy · build ${build} UTC</footer>

<script>
const KEY = ${JSON.stringify(key ?? "")}; // empty when cookie-authed — requests then rely on the session cookie
const BUILD = ${JSON.stringify(build)};
console.log('cyborgy build', BUILD);

const CAT = { food:'#7cb342', exercise:'#fb8c00', activity:'#42a5f5', social:'#ab47bc',
              work:'#78909c', mood:'#ef5350', thought:'#26a69a', sleep:'#5c6bc0', other:'#9e9e9e' };
const PATHS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  bot: '<rect x="4" y="10" width="16" height="10" rx="2"/><circle cx="12" cy="4" r="2"/><path d="M12 6v4"/><path d="M9 15h.01M15 15h.01"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  watch: '<circle cx="12" cy="12" r="6"/><path d="M12 10v2l1.5 1.5"/><path d="M9 4l.5 2.5M15 4l-.5 2.5M9 20l.5-2.5M15 20l-.5-2.5"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>',
  meh: '<circle cx="12" cy="12" r="10"/><path d="M8 15h8"/><path d="M9 9h.01M15 9h.01"/>',
  frown: '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><path d="M9 9h.01M15 9h.01"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m4 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  play: '<polygon points="7 4 19 12 7 20 7 4"/>',
  pause: '<path d="M9 4H7v16h2zM17 4h-2v16h2z"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Z"/><path d="M21 15v7"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.51 4.04 3 5.5l7 7Z"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  tag: '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>',
};
const icon = (name, style) => '<svg class="icon"' + (style ? ' style="' + style + '"' : '') + ' viewBox="0 0 24 24">' + (PATHS[name] || PATHS.tag) + '</svg>';
const CAT_IC = { food:'utensils', exercise:'pulse', activity:'star', social:'users', work:'briefcase', mood:'heart', thought:'bulb', sleep:'moon', other:'tag' };
const SRC_IC = { voice:'mic', text:'chat', photo:'camera', shortcut:'watch', web:'globe', bot:'bot' };

const scaleColor = v => v <= 3 ? '#ef5350' : v <= 5 ? '#fb8c00' : v <= 7 ? '#fdd835' : '#7cb342';
const moodIcon = v => v <= 4 ? 'frown' : v <= 6 ? 'meh' : 'smile';

const esc = s => s == null ? '' : String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const stripMd = s => (s || '').replace(/\\[(.*?)\\]\\(.*?\\)/g, '$1').replace(/[*_#>~]/g, '');
const md = s => DOMPurify.sanitize(marked.parse(s || ''));
const withKey = p => KEY ? p + (p.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY) : p;
const api = (path, opts) => fetch(withKey(path), opts).then(r => r.json());

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
let playRate = (() => { try { return [1, 1.5, 2].includes(Number(localStorage.getItem('cyborgy-rate'))) ? Number(localStorage.getItem('cyborgy-rate')) : 1; } catch { return 1; } })();
const rendered = new Set();
const feed = document.getElementById('feed');
const moreBtn = document.getElementById('more');

function sinceParam() {
  if (!rangeDays) return '';
  if (rangeDays === 1) { const d = new Date(); d.setHours(0,0,0,0); return '&since=' + Math.floor(d.getTime()/1000); }
  return '&since=' + (Math.floor(Date.now()/1000) - rangeDays*86400);
}

async function loadFeed(reset) {
  if (reset) { feed.innerHTML = '<div class="meta">Loading…</div>'; nextBefore = null; rendered.clear(); }
  const data = await api('/api/messages?limit=20' + sinceParam()
    + (query ? '&q=' + encodeURIComponent(query) : '')
    + (nextBefore ? '&before=' + nextBefore : ''));
  // Advance the cursor BEFORE rendering — a render error must never re-serve this page.
  nextBefore = data.nextBefore;
  moreBtn.hidden = !nextBefore;
  if (reset) feed.innerHTML = '';
  if (reset && data.messages.length === 0) feed.innerHTML = '<em>Nothing here — go log something!</em>';
  for (const m of data.messages) {
    if (rendered.has(m.id)) continue;
    rendered.add(m.id);
    try { feed.appendChild(renderMessage(m)); }
    catch (err) { console.error('render failed for message', m.id, err); }
  }
}

function renderMessage(m) {
  const card = document.createElement('div');
  card.className = 'card';
  const when = new Date(m.createdAt * 1000).toLocaleString([], {weekday:'short', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit'});
  const isPhoto = m.r2Key && m.r2Key.startsWith('photo/');
  const src = m.source.replace('telegram_','');

  // LEFT column: one message-type icon (question/voice/text/photo/assistant/…)
  const typeName = m.role === 'question' ? 'help' : m.role === 'assistant' ? 'bot' : (SRC_IC[src] || 'chat');
  const typecol = '<div class="typecol" title="' + esc(m.role === 'entry' ? src : m.role) + '">' + icon(typeName) + '</div>';

  // RIGHT column: mood/energy averages, icon colored by value + number
  const moods = []; const energies = [];
  for (const e of m.entries) {
    if (e.mood != null) moods.push(e.mood);
    if (e.energy != null) energies.push(e.energy);
  }
  const avg = xs => xs.length ? Math.round(xs.reduce((a,b)=>a+b,0)/xs.length*10)/10 : null;
  const moodAvg = avg(moods), energyAvg = avg(energies);
  const statcol = '<div class="statcol">' +
    (moodAvg != null ? '<div class="stat" title="avg mood">' + icon(moodIcon(moodAvg), 'color:' + scaleColor(moodAvg)) + '<b>' + moodAvg + '</b></div>' : '') +
    (energyAvg != null ? '<div class="stat" title="avg energy">' + icon('zap', 'color:' + scaleColor(energyAvg)) + '<b>' + energyAvg + '</b></div>' : '') +
    '</div>';

  // collapsed preview: first words, digest line, horizontal category icon row
  const allWords = stripMd(m.rawText).split(/\\s+/).filter(Boolean);
  let previewText = allWords.length
    ? esc(allWords.slice(0, 16).join(' ')) + (allWords.length > 16 ? ' …' : '')
    : (isPhoto ? '' : '<em>(no text)</em>');
  if (m.role === 'question') previewText = '<span class="qtext">' + previewText + '</span>';
  if (isPhoto) previewText += '<img class="thumb" loading="lazy" src="' + withKey('/media/' + encodeURIComponent(m.r2Key)) + '">';
  // One digest line: category icons left, entry count pushed to the far right.
  const cats = [...new Set(m.entries.map(e => e.category))];
  let digest = '';
  if (m.entries.length) {
    digest += '<div class="digest">' +
      cats.map(c => '<span title="' + esc(c) + '">' + icon(CAT_IC[c] || 'tag', 'color:' + (CAT[c]||CAT.other)) + '</span>').join('') +
      '<span class="dcount">' + m.entries.length + (m.entries.length === 1 ? ' entry' : ' entries') + '</span></div>';
  }
  if (m.answer) {
    const aw = stripMd(m.answer.text).split(/\\s+/).filter(Boolean);
    digest += '<div class="digest"><span>' + icon('bot') + ' ' + esc(aw.slice(0, 14).join(' ')) + (aw.length > 14 ? ' …' : '') + '</span></div>';
  }

  // expanded detail: transcript + player, then a divider, then the AI material
  let text = (m.words && m.words.length)
    ? '<div class="transcript">' + m.words.map(w => '<span class="w" data-s="' + w.start + '" data-e="' + w.end + '">' + esc(w.word) + '</span>').join(' ') + '</div>'
    : (m.rawText
        ? (m.role === 'assistant' ? '<div class="md">' + md(m.rawText) + '</div>' : '<div>' + esc(m.rawText) + '</div>')
        : (isPhoto ? '' : '<em>(no text)</em>'));
  if (m.role === 'question') text = '<div class="qfull">' + text + '</div>';
  const media = m.r2Key
    ? (isPhoto
        ? '<img class="ph" loading="lazy" src="' + withKey('/media/' + encodeURIComponent(m.r2Key)) + '">'
        : '<div class="player"><button class="pbtn">' + icon('play') + '</button><div class="ptrack"><div class="pfill"></div></div><span class="ptime">·</span><button class="prate" title="Playback speed">1×</button>' +
          '<audio preload="metadata" src="' + withKey('/media/' + encodeURIComponent(m.r2Key)) + '"></audio></div>')
    : '';
  const delivery = m.delivery
    ? '<div class="meta">' + icon('mic') + ' ' + m.delivery.tags.map(esc).join(', ') + (m.delivery.note ? ' — ' + esc(m.delivery.note) : '') + (m.wps ? ' · ' + m.wps + ' w/s' : '') + '</div>'
    : (m.wps ? '<div class="meta">' + icon('mic') + ' ' + m.wps + ' w/s</div>' : '');
  const answer = m.answer ? '<div class="answer md">' + md(m.answer.text) + '</div>' : '';
  const entryRows = m.entries.map(e =>
    '<div class="entry">' +
    '<span class="catbadge" style="border-color:' + (CAT[e.category]||CAT.other) + ';color:' + (CAT[e.category]||CAT.other) + '">' + icon(CAT_IC[e.category] || 'tag') + esc(e.category) + '</span>' +
    '<span class="esum">' + esc(e.summary) +
    ((e.mood != null || e.energy != null) ? ' <em class="meta">(' + [e.mood != null ? 'mood ' + e.mood : null, e.energy != null ? 'energy ' + e.energy : null].filter(Boolean).join(', ') + ')</em>' : '') +
    '</span>' +
    (e.id != null ? '<button class="del delE" data-eid="' + e.id + '" title="Delete this entry">' + icon('trash') + '</button>' : '') +
    '</div>').join('');
  // divider goes BEFORE the AI material (delivery analysis + extraction)
  const aiblock = (delivery || entryRows)
    ? '<div class="aiblock">' + delivery + (entryRows ? '<div style="margin-top:.4rem">' + entryRows + '</div>' : '') + '</div>'
    : '';

  card.innerHTML =
    typecol +
    '<div class="box">' +
      '<div class="head meta">' +
        '<button class="del delM" data-mid="' + m.id + '" title="Delete message + its entries">' + icon('trash') + '</button>' +
        (m.role === 'entry' && (m.rawText || isPhoto) ? '<button class="del rex" title="Re-run extraction">' + icon('refresh') + '</button>' : '') +
        '<button class="tog" title="Expand/collapse">' + icon('chev') + '</button>' +
        when + ' · <span class="badge">' + esc(src) + '</span>' +
      '</div>' +
      '<div class="preview">' + previewText + digest + '</div>' +
      '<div class="detail">' + text + media + answer + aiblock + '</div>' +
    '</div>' +
    statcol;

  card.querySelector('.head').addEventListener('click', e => {
    if (e.target.closest('.del')) return;
    card.classList.toggle('open');
  });
  card.querySelector('.preview').addEventListener('click', () => card.classList.add('open'));

  // Re-extract: re-run the LLM over this message, redraw the card in place.
  const rex = card.querySelector('.rex');
  if (rex) rex.addEventListener('click', async () => {
    if (rex.classList.contains('busy')) return;
    rex.classList.add('busy');
    try {
      const res = await api('/api/admin/reprocess?id=' + m.id, { method: 'POST' });
      if (res.ok) {
        m.entries = res.entries || [];
        m.delivery = res.delivery || null;
        const fresh = renderMessage(m);
        if (card.classList.contains('open')) fresh.classList.add('open');
        card.replaceWith(fresh);
      } else alert('Re-extract failed: ' + (res.error || 'unknown error'));
    } catch { alert('Re-extract failed: request error'); }
    rex.classList.remove('busy');
  });

  // custom player + karaoke wiring
  const audio = card.querySelector('audio');
  if (audio) {
    const btn = card.querySelector('.pbtn');
    const fill = card.querySelector('.pfill');
    const track = card.querySelector('.ptrack');
    const time = card.querySelector('.ptime');
    const fmt = s => isFinite(s) && s > 0 ? Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0') : '0:00';
    btn.addEventListener('click', () => audio.paused ? audio.play() : audio.pause());
    audio.addEventListener('play', () => btn.innerHTML = icon('pause'));
    audio.addEventListener('pause', () => btn.innerHTML = icon('play'));
    audio.addEventListener('loadedmetadata', () => time.textContent = '0:00 / ' + fmt(audio.duration));
    audio.addEventListener('timeupdate', () => {
      fill.style.width = (audio.duration ? audio.currentTime / audio.duration * 100 : 0) + '%';
      time.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
    });
    track.addEventListener('click', e => {
      const r = track.getBoundingClientRect();
      if (audio.duration) audio.currentTime = (e.clientX - r.left) / r.width * audio.duration;
    });
    // Playback speed: global, persisted, synced across every player.
    const rateBtn = card.querySelector('.prate');
    audio.playbackRate = playRate;
    rateBtn.textContent = playRate + '×';
    audio.addEventListener('play', () => { audio.playbackRate = playRate; });
    rateBtn.addEventListener('click', () => {
      const RATES = [1, 1.5, 2];
      playRate = RATES[(RATES.indexOf(playRate) + 1) % RATES.length] || 1;
      try { localStorage.setItem('cyborgy-rate', String(playRate)); } catch {}
      document.querySelectorAll('audio').forEach(a => a.playbackRate = playRate);
      document.querySelectorAll('.prate').forEach(b => b.textContent = playRate + '×');
    });

    const words = [...card.querySelectorAll('.w')];
    if (words.length) {
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
  }
  return card;
}

// Deletes: whole message, or a single extracted entry.
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
    .map(([c, n]) => '<span class="catbadge" style="border-color:' + (CAT[c]||CAT.other) + ';color:' + (CAT[c]||CAT.other) + '">' + icon(CAT_IC[c] || 'tag') + esc(c) + ' × ' + n + '</span>')
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
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
