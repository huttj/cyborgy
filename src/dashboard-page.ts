// ---------------------------------------------------------------------------
// The app shell — Stream / Review / Ask / Memory / Settings tabs, hash-routed,
// no framework. A docked composer (voice, photos, text) captures entries and
// questions in the browser, so the app works without Telegram.
// SVG icons (lucide-style) throughout; no emoji in chrome.
// ---------------------------------------------------------------------------

export function dashboardPage(): Response {
  const build = new Date().toISOString().slice(0, 16).replace("T", " ");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#e07a5f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="cyborgy">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="manifest" href="/manifest.webmanifest">
<title>cyborgy</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/colorjs.io@0.5.2/dist/color.global.js"></script>
<style>
  :root { color-scheme: light dark; --accent: #e07a5f; --line: #8883; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 0 1rem 4rem; line-height: 1.55; }
  header { position: sticky; top: 0; backdrop-filter: blur(12px); background: color-mix(in srgb, Canvas 82%, transparent); z-index: 10; padding: .8rem 0 .5rem; border-bottom: 1px solid var(--line); margin-bottom: 1rem; }
  header h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  nav { display: flex; gap: .4rem; flex-wrap: wrap; }
  nav button { border: 1px solid var(--line); background: none; color: inherit; border-radius: 4px; padding: .25rem .9rem; font-size: .9rem; cursor: pointer; }
  nav button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .view { display: none; } .view.on { display: block; }

  .icon { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vertical-align: -3px; flex: none; }

  /* cards: on mobile the type icon + mood/energy sit in a row ABOVE the box;
     on wide screens they float in the page margins and the box aligns with
     the search bar */
  .card { position: relative; display: grid; grid-template-columns: auto 1fr; grid-template-areas: "type stats" "box box"; row-gap: .3rem; margin: .9rem 0; align-items: center; }
  .typecol, .statcol { display: flex; align-items: center; }
  .typecol { grid-area: type; gap: .5rem; }
  .statcol { grid-area: stats; justify-content: flex-end; gap: .9rem; }
  .typecol .icon { width: 17px; height: 17px; opacity: .65; }
  .stat { display: flex; flex-direction: row; align-items: center; line-height: 1.1; gap: .25rem; }
  .stat .icon { width: 17px; height: 17px; }
  .stat b { font-size: .68rem; opacity: .7; font-weight: 600; }
  .box { grid-area: box; min-width: 0; border: 1px solid var(--line); border-radius: 4px; padding: .65rem .85rem; }
  @media (min-width: 880px) {
    .card { display: block; }
    .typecol { position: absolute; right: calc(100% + .7rem); top: 0; flex-direction: column; gap: .5rem; padding-top: .6rem; }
    .statcol { position: absolute; left: calc(100% + .7rem); top: 0; flex-direction: column; gap: .65rem; padding-top: .6rem; }
    .stat { flex-direction: column; gap: 1px; }
  }

  .meta { opacity: .55; font-size: .78rem; }
  .edate { font-size: .72rem; opacity: .8; white-space: nowrap; padding: .02rem .3rem; border: 1px solid currentColor; border-radius: 3px; margin-left: .25rem; }
  .head { cursor: pointer; user-select: none; }
  .badge { display: inline-block; border-radius: 3px; padding: 0 .45rem; margin-right: .3rem; font-size: .75rem; border: 1px solid var(--line); }
  .entry { padding: .25rem 0; margin: .35rem 0; font-size: .85rem; display: flex; align-items: flex-start; gap: .5rem; }
  .entry .catbadge { margin-top: 1px; }
  .entry .esum { flex: 1; min-width: 0; }
  @media (max-width: 879px) {
    /* pill inline with the text; summary wraps naturally at full width */
    .entry { display: block; }
    .entry .esum { display: inline; }
    .entry .catbadge { margin-right: .4rem; vertical-align: -2px; }
    .entry .delE { float: right; margin-left: .4rem; }
  }
  .catbadge { display: inline-flex; align-items: center; justify-content: center; gap: .25rem; border-radius: 3px; padding: .05rem 0; font-size: .75rem; border: 1px solid; width: 5.4rem; flex: none; }
  /* Review tab: counts ride along, so pills size to content instead */
  #categories .catbadge { width: auto; padding: .05rem .55rem; white-space: nowrap; margin: 0 .35rem .35rem 0; }
  .catrow { display: flex; gap: .55rem; margin-top: .45rem; }
  .catrow .icon { width: 15px; height: 15px; }

  .controls { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .6rem; }
  .controls input[type=search] { flex: 1; min-width: 160px; padding: .4rem .7rem; border-radius: 4px; border: 1px solid var(--line); background: none; color: inherit; font-size: .95rem; }
  .chip { border: 1px solid var(--line); background: none; color: inherit; border-radius: 4px; padding: .2rem .7rem; font-size: .8rem; cursor: pointer; }
  .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .ctl-group { display: inline-flex; gap: .4rem; margin-right: .7rem; }
  .chartlegend { display: flex; gap: 1.2rem; justify-content: center; margin-top: .5rem; font-size: .82rem; }
  .legitem { display: flex; align-items: center; gap: .4rem; }
  .legsw { width: 40px; height: 12px; border-radius: 3px; }

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

  img.ph { max-width: 280px; border-radius: 4px; }
  .gallery { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .4rem; }
  .gallery img.ph { max-width: 180px; max-height: 180px; object-fit: cover; }
  .thumbwrap { position: relative; display: block; width: fit-content; margin-top: .35rem; }
  img.thumb { display: block; max-height: 64px; border-radius: 3px; }
  .thumbn { position: absolute; right: 3px; bottom: 3px; background: #000a; color: #fff; font-size: .65rem; padding: 0 .3rem; border-radius: 3px; }
  .entry .delE { float: none; flex: none; align-self: center; }
  .entry .delE .icon { width: 13px; height: 13px; }
  #more { display: block; margin: 1rem auto; }
  #more[hidden] { display: none; }
  @media (max-width: 480px) { nav button { padding: .25rem .6rem; font-size: .85rem; } }
  button.std { border: 1px solid var(--line); background: none; color: inherit; border-radius: 4px; padding: .4rem 1rem; cursor: pointer; }

  #chat { display: flex; flex-direction: column; gap: .6rem; margin-bottom: 1rem; }
  .msg { padding: .5rem .8rem; border-radius: 4px; max-width: 85%; }
  .msg.q { align-self: flex-end; background: var(--accent); color: #fff; }
  .msg.a { align-self: flex-start; border: 1px solid var(--line); }
  #memText { width: 100%; min-height: 60vh; padding: .7rem .85rem; border-radius: 4px; border: 1px solid var(--line); background: none; color: inherit; font: inherit; line-height: 1.5; resize: vertical; }

  .del { float: right; border: none; background: none; color: inherit; opacity: .4; cursor: pointer; padding: .1rem .2rem; }
  .del:hover { opacity: 1; color: #ef5350; }
  .del.rex:hover { color: var(--accent); }
  .del.rex { margin-right: .45rem; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .rex.busy .icon { animation: rot 1s linear infinite; }
  .rexpop { margin: .5rem 0 .2rem; }
  .rexpop textarea { width: 100%; box-sizing: border-box; padding: .45rem .6rem; border-radius: 4px; border: 1px solid var(--line); background: none; color: inherit; font: inherit; font-size: .9rem; line-height: 1.4; resize: vertical; }
  .rexrow { display: flex; align-items: center; gap: .5rem; margin-top: .4rem; }
  .rexrow .grow { flex: 1; }
  .rexmic { border: 1px solid var(--line); background: none; color: inherit; border-radius: 4px; padding: .2rem .5rem; cursor: pointer; display: inline-flex; align-items: center; }
  .rexmic.on { border-color: var(--accent); color: var(--accent); }
  .rexgo { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 4px; padding: .25rem .85rem; font-size: .85rem; cursor: pointer; }
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

  /* docked composer (Stream + Ask tabs) */
  body.docked { padding-bottom: calc(9rem + env(safe-area-inset-bottom)); }
  #dock { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: none;
    background: color-mix(in srgb, Canvas 88%, transparent); backdrop-filter: blur(12px);
    border-top: 1px solid var(--line); padding: .5rem 1rem calc(.6rem + env(safe-area-inset-bottom)); }
  body.docked #dock { display: block; }
  #dockInner { max-width: 720px; margin: 0 auto; }
  .dockrow { display: flex; align-items: flex-end; gap: .45rem; }
  #dockText { flex: 1; min-width: 0; resize: none; max-height: 40vh; padding: .5rem .7rem; border-radius: 6px;
    border: 1px solid var(--line); background: none; color: inherit; font: inherit; font-size: 1rem; line-height: 1.4; }
  .dbtn { width: 40px; height: 40px; flex: none; border-radius: 50%; border: 1px solid var(--line); background: none;
    color: inherit; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .dbtn .icon { width: 18px; height: 18px; }
  .dbtn.send { background: var(--accent); border-color: var(--accent); color: #fff; }
  .dbtn:disabled { opacity: .4; cursor: default; }
  #micBtn.rec { background: #ef5350; border-color: #ef5350; color: #fff; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 6px #ef535033; } }
  .dockmeta { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-top: .4rem; font-size: .8rem; }
  .dockmeta .chip { padding: .1rem .6rem; }
  .dockmeta .grow { flex: 1; }
  #dockStatus { opacity: .7; }
  #dockStatus.err { color: #ef5350; opacity: 1; }
  #dockVoice { font-size: .88rem; opacity: .75; margin-bottom: .4rem; max-height: 22vh; overflow-y: auto; }
  #dockVoice .pend { font-style: italic; opacity: .7; }
  #dockPhotos { display: flex; gap: .35rem; flex-wrap: wrap; margin-bottom: .4rem; }
  #dockPhotos img { height: 48px; border-radius: 4px; }
  #dockPhotos:empty, #dockVoice:empty { display: none; }
  .linkbtn { border: none; background: none; color: inherit; opacity: .6; cursor: pointer; font-size: .8rem; padding: .1rem .3rem; }
  .linkbtn:hover { opacity: 1; }
  .pendingcard .box { opacity: .75; font-size: .88rem; }
  .pendingcard .box.err { opacity: 1; border-color: #ef5350; }
  .badge.proc { border-color: var(--accent); color: var(--accent); }

  /* settings */
  .setrow { display: flex; align-items: center; gap: .7rem; padding: .55rem 0; border-bottom: 1px solid var(--line); }
  .setrow .grow { flex: 1; }
  .setrow input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); }
  #settings h2 { font-size: 1rem; margin: 1.4rem 0 .3rem; }
</style>
</head>
<body>
<header>
  <h1>🤖 cyborgy</h1>
  <nav>
    <button data-v="stream">Stream</button>
    <button data-v="review">Review</button>
    <button data-v="ask">Ask</button>
    <button data-v="memory">Memory</button>
    <button data-v="settings">Settings</button>
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
  <div class="controls" style="margin:.9rem 0 .4rem">
    <span class="ctl-group" id="resCtl">
      <button class="chip res" data-r="hour">Hour</button>
      <button class="chip res on" data-r="day">Day</button>
      <button class="chip res" data-r="week">Week</button>
    </span>
    <span class="ctl-group" id="winCtl">
      <button class="chip win" data-d="7">7d</button>
      <button class="chip win on" data-d="30">30d</button>
      <button class="chip win" data-d="90">90d</button>
      <button class="chip win" data-d="365">All</button>
    </span>
    <button class="chip" id="errToggle" title="Show min–max range per bucket">± range</button>
  </div>
  <div class="box"><canvas id="moodChart"></canvas></div>
  <div id="chartLegend" class="chartlegend"></div>
  <h2 style="font-size:1rem">This week by category</h2>
  <div id="categories"></div>
  <h2 style="font-size:1rem">Latest weekly analysis</h2>
  <div class="box md" id="report">Loading…</div>
</section>

<section id="memory" class="view">
  <p class="meta" style="margin:.6rem 0">Notes and context for the AI — kept short, injected into every prompt. The Ask assistant can also add to this as it learns.</p>
  <textarea id="memText" placeholder="e.g. I'm vegetarian. 'The gym' means the climbing gym. I track mood mainly to understand work stress."></textarea>
  <div style="display:flex;align-items:center;gap:.8rem;margin-top:.5rem">
    <button class="std" id="memSave">Save</button>
    <span class="meta" id="memStatus"></span>
  </div>
</section>

<section id="ask" class="view">
  <p class="meta" style="margin:.6rem 0">Ask about your journal, e.g. “how was my mood this week?”. Type or record below.</p>
  <div id="chat"></div>
</section>

<section id="settings" class="view">
  <h2>Notifications on this device</h2>
  <p class="meta" id="pushHint"></p>
  <div class="setrow"><span class="grow" id="pushState">…</span>
    <button class="std" id="pushBtn" hidden>Turn on</button>
    <button class="std" id="pushTest" hidden>Send a test</button>
    <button class="std" id="installBtn" hidden>Install app</button>
  </div>
  <h2>Scheduled messages</h2>
  <p class="meta">They show in the Stream and come as notifications to each device that turned them on.</p>
  <label class="setrow"><span class="grow">Check-in pings<br><span class="meta">A few a day, 9am–8pm, skipped when you logged recently</span></span><input type="checkbox" data-n="pings"></label>
  <label class="setrow"><span class="grow">Daily recap<br><span class="meta">9pm</span></span><input type="checkbox" data-n="daily"></label>
  <label class="setrow"><span class="grow">Weekly analysis<br><span class="meta">Sunday 6pm, also on the Review tab</span></span><input type="checkbox" data-n="weekly"></label>
  <div id="adminSec" hidden>
    <h2>Accounts</h2>
    <p class="meta">People ask for access on the sign-in page. Approve sends them a sign-in link (valid 24 hours).</p>
    <div id="userList"></div>
  </div>
  <h2>Account</h2>
  <div class="setrow"><span class="grow meta" id="tgState"></span>
    <form method="POST" action="/logout" style="margin:0"><button class="std">Sign out</button></form>
  </div>
</section>

<div id="dock">
  <div id="dockInner">
    <div id="dockVoice"></div>
    <div id="dockPhotos"></div>
    <div class="dockrow">
      <button class="dbtn" id="micBtn" title="Record">MIC</button>
      <button class="dbtn" id="camBtn" title="Add photos">CAM</button>
      <input type="file" id="photoIn" accept="image/*" multiple hidden>
      <textarea id="dockText" rows="1" placeholder="Log something, or ask…"></textarea>
      <button class="dbtn send" id="sendBtn" title="Send">SEND</button>
    </div>
    <div class="dockmeta">
      <span id="modeCtl"><button class="chip mode on" data-m="auto">Auto</button> <button class="chip mode" data-m="entry">Log</button> <button class="chip mode" data-m="question">Ask</button></span>
      <span id="dockStatus"></span>
      <span class="grow"></span>
      <button class="linkbtn" id="discardBtn" hidden>Discard</button>
    </div>
  </div>
</div>

<footer>cyborgy · build ${build} UTC</footer>

<script>
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
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
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
const api = (path, opts) => fetch((path), opts).then(r => {
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  return r.json();
});

// Browser dictation for steer notes (voice-first, matching how entries are logged).
const SPEECH = window.SpeechRecognition || window.webkitSpeechRecognition;
function wireDictation(btn, ta) {
  let rec = null;
  btn.addEventListener('click', e => {
    e.preventDefault();
    if (rec) { rec.stop(); return; }
    rec = new SPEECH();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    const base = ta.value ? ta.value.trim() + ' ' : '';
    btn.classList.add('on');
    rec.onresult = ev => {
      let s = '';
      for (let i = 0; i < ev.results.length; i++) s += ev.results[i][0].transcript;
      ta.value = base + s;
    };
    rec.onend = () => { btn.classList.remove('on'); rec = null; ta.focus(); };
    rec.onerror = () => { btn.classList.remove('on'); rec = null; };
    rec.start();
  });
}

// --- tabs (hash-routed) ---
let currentView = 'stream';
function show(v) {
  currentView = v;
  document.body.classList.toggle('docked', v === 'stream' || v === 'ask');
  document.getElementById('modeCtl').hidden = v === 'ask';
  dockText.placeholder = v === 'ask' ? 'Ask about your journal…' : 'Log something, or ask…';
  if (v === 'ask') loadChat();
  if (v === 'settings') loadSettings().catch(() => {});
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === v));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  location.hash = v;
  if (v === 'review' && !reviewLoaded) loadReview();
  if (v === 'memory') loadMemory();
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
  const src = m.source.replace(/^(telegram|web)_/, '');
  // Audio tracks: browser recordings are ordered segments; Telegram voice is one file.
  const tracks = (m.audio && m.audio.length)
    ? m.audio.map(a => ({ src: ('/media/' + encodeURIComponent(a.key)), dur: a.duration }))
    : (m.r2Key && !isPhoto ? [{ src: ('/media/' + encodeURIComponent(m.r2Key)), dur: null }] : []);

  // LEFT column: one message-type icon (question/voice/text/photo/assistant/…)
  const typeName = m.role === 'question' ? 'help' : (m.role === 'assistant' || m.role === 'broadcast') ? 'bot' : (SRC_IC[src] || 'chat');
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
    : (m.pending ? '<em>Processing…</em>' : (isPhoto || (m.media && m.media.length) ? '' : '<em>(no text)</em>'));
  if (m.role === 'question') previewText = '<span class="qtext">' + previewText + '</span>';
  const imgs = (m.media && m.media.length) ? m.media : (isPhoto ? [m.r2Key] : []);
  if (imgs.length) {
    previewText += '<span class="thumbwrap"><img class="thumb" loading="lazy" src="' + ('/media/' + encodeURIComponent(imgs[0])) + '">' +
      (imgs.length > 1 ? '<span class="thumbn">+' + (imgs.length - 1) + '</span>' : '') + '</span>';
  }
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
        ? ((m.role === 'assistant' || m.role === 'broadcast') ? '<div class="md">' + md(m.rawText) + '</div>' : '<div>' + esc(m.rawText) + '</div>')
        : (isPhoto ? '' : '<em>(no text)</em>'));
  if (m.role === 'question') text = '<div class="qfull">' + text + '</div>';
  const media = (imgs.length
      ? '<div class="gallery">' + imgs.map(k => '<img class="ph" loading="lazy" src="' + ('/media/' + encodeURIComponent(k)) + '">').join('') + '</div>'
      : '') +
    (tracks.length
      ? '<div class="player"><button class="pbtn">' + icon('play') + '</button><div class="ptrack"><div class="pfill"></div></div><span class="ptime">·</span><button class="prate" title="Playback speed">1×</button>' +
        '<audio preload="metadata" src="' + tracks[0].src + '"></audio></div>'
      : '');
  const delivery = m.delivery
    ? '<div class="meta">' + icon('mic') + ' ' + m.delivery.tags.map(esc).join(', ') + (m.delivery.note ? ' — ' + esc(m.delivery.note) : '') + (m.wps ? ' · ' + m.wps + ' w/s' : '') + '</div>'
    : (m.wps ? '<div class="meta">' + icon('mic') + ' ' + m.wps + ' w/s</div>' : '');
  const answer = m.answer ? '<div class="answer md">' + md(m.answer.text) + '</div>' : '';
  const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  const entryRows = m.entries.map(e =>
    '<div class="entry">' +
    '<span class="catbadge" style="border-color:' + (CAT[e.category]||CAT.other) + ';color:' + (CAT[e.category]||CAT.other) + '">' + icon(CAT_IC[e.category] || 'tag') + esc(e.category) + '</span>' +
    '<span class="esum">' + esc(e.summary) +
    ((e.mood != null || e.energy != null) ? ' <em class="meta">(' + [e.mood != null ? 'mood ' + e.mood : null, e.energy != null ? 'energy ' + e.energy : null].filter(Boolean).join(', ') + ')</em>' : '') +
    // Backdated entry: extractor placed it on a different day than the message.
    ((e.ts != null && !sameDay(e.ts, m.createdAt)) ? ' <span class="edate" title="Logged for an earlier date">📅 ' + new Date(e.ts * 1000).toLocaleDateString([], {weekday:'short', month:'numeric', day:'numeric'}) + '</span>' : '') +
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
        (m.pending ? '<span class="badge proc">processing</span>' : '') +
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

  // Re-extract: single click opens a steer popover (type or dictate an
  // instruction, then submit); double click re-runs plainly with no note.
  const rex = card.querySelector('.rex');
  if (rex) {
    let pop = null;
    const closeRexPop = () => { if (pop) { pop.remove(); pop = null; } };

    const runReprocess = async (note) => {
      if (rex.classList.contains('busy')) return;
      closeRexPop();
      rex.classList.add('busy');
      try {
        const res = await api('/api/admin/reprocess?id=' + m.id, {
          method: 'POST',
          headers: note ? { 'content-type': 'application/json' } : undefined,
          body: note ? JSON.stringify({ note }) : undefined,
        });
        if (res.ok) {
          m.entries = res.entries || [];
          m.delivery = res.delivery || null;
          const fresh = renderMessage(m);
          if (card.classList.contains('open')) fresh.classList.add('open');
          card.replaceWith(fresh);
          return;
        }
        alert('Re-extract failed: ' + (res.error || 'unknown error'));
      } catch { alert('Re-extract failed: request error'); }
      rex.classList.remove('busy');
    };

    const openRexPop = () => {
      if (pop) { closeRexPop(); return; }
      pop = document.createElement('div');
      pop.className = 'rexpop';
      pop.innerHTML =
        '<textarea rows="2" placeholder="Steer the re-extract — e.g. &quot;all of this was yesterday&quot;, &quot;split the poke bowl out&quot;, &quot;drop the Cadence part&quot;. ⌘/Ctrl+Enter to run."></textarea>' +
        '<div class="rexrow">' +
          (SPEECH ? '<button class="rexmic" title="Dictate">' + icon('mic') + '</button>' : '') +
          '<span class="grow"></span>' +
          '<button class="rexgo">Re-extract</button>' +
        '</div>';
      card.querySelector('.box').insertBefore(pop, card.querySelector('.preview'));
      const ta = pop.querySelector('textarea');
      ta.focus();
      pop.querySelector('.rexgo').addEventListener('click', () => runReprocess(ta.value.trim() || null));
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runReprocess(ta.value.trim() || null); }
        else if (e.key === 'Escape') closeRexPop();
      });
      const mic = pop.querySelector('.rexmic');
      if (mic) wireDictation(mic, ta);
    };

    // Distinguish single (popover) from double (plain re-run) click.
    let clickT = null;
    rex.addEventListener('click', () => {
      if (clickT) return;
      clickT = setTimeout(() => { clickT = null; openRexPop(); }, 230);
    });
    rex.addEventListener('dblclick', () => {
      clearTimeout(clickT); clickT = null;
      runReprocess(null);
    });
  }

  // custom player + karaoke wiring. A message can have several audio tracks
  // (browser segments); they play back to back on one timeline.
  const audio = card.querySelector('audio');
  if (audio) {
    const btn = card.querySelector('.pbtn');
    const fill = card.querySelector('.pfill');
    const track = card.querySelector('.ptrack');
    const time = card.querySelector('.ptime');
    const fmt = s => isFinite(s) && s > 0 ? Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0') : '0:00';
    const offsets = []; let acc = 0;
    for (const t of tracks) { offsets.push(acc); acc += t.dur || 0; }
    const knownTotal = tracks.every(t => t.dur);
    let cur = 0;
    const total = () => knownTotal ? acc : audio.duration;
    const absTime = () => offsets[cur] + (audio.currentTime || 0);
    // Load track i (if needed), seek to t seconds into it, optionally play.
    const loadTrack = (i, t, play) => {
      const go = () => {
        try { audio.currentTime = t; } catch {}
        audio.playbackRate = playRate;
        if (play) audio.play().catch(() => {});
      };
      if (i !== cur) {
        cur = i;
        audio.src = tracks[i].src;
        audio.addEventListener('loadedmetadata', go, { once: true });
        audio.load();
      } else if (audio.readyState >= 1) go();
      else audio.addEventListener('loadedmetadata', go, { once: true });
    };
    const seekAbs = (t, play) => {
      let i = tracks.length - 1;
      while (i > 0 && offsets[i] > t) i--;
      loadTrack(i, Math.max(0, t - offsets[i]), play);
    };
    const paint = () => {
      const T = total();
      fill.style.width = (T ? absTime() / T * 100 : 0) + '%';
      time.textContent = fmt(absTime()) + ' / ' + fmt(T);
    };
    btn.addEventListener('click', () => audio.paused ? audio.play().catch(() => {}) : audio.pause());
    audio.addEventListener('play', () => { btn.innerHTML = icon('pause'); audio.playbackRate = playRate; });
    audio.addEventListener('pause', () => btn.innerHTML = icon('play'));
    audio.addEventListener('loadedmetadata', paint);
    audio.addEventListener('timeupdate', paint);
    audio.addEventListener('ended', () => {
      if (cur < tracks.length - 1) loadTrack(cur + 1, 0, true);
      else { words.forEach(w => w.classList.remove('active')); loadTrack(0, 0, false); }
    });
    if (knownTotal) time.textContent = '0:00 / ' + fmt(acc);
    track.addEventListener('click', e => {
      const r = track.getBoundingClientRect();
      const T = total();
      if (T) seekAbs((e.clientX - r.left) / r.width * T, !audio.paused);
    });
    // Playback speed: global, persisted, synced across every player.
    const rateBtn = card.querySelector('.prate');
    audio.playbackRate = playRate;
    rateBtn.textContent = playRate + '×';
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
        seekAbs(parseFloat(w.dataset.s), true);
      });
      audio.addEventListener('timeupdate', () => {
        const t = absTime();
        for (const w of words) w.classList.toggle('active', t >= parseFloat(w.dataset.s) && t < parseFloat(w.dataset.e) + 0.15);
      });
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
let reviewLoaded = false, chart = null;
let resolution = 'day', windowDays = 30, errorBars = false;

// Value→color scales (perceptual Lab interpolation via colorjs.io):
// mood red(1)→blue(10), energy gray(1)→green(10). Cached per integer value.
const haveColor = typeof Color !== 'undefined';
// Vivid endpoints; mood interpolates in OKLCH so it stays saturated through
// the midpoint (red→magenta→blue) instead of going muddy gray as Lab does.
const MOOD_SCALE = haveColor ? Color.range('#ff1744', '#2979ff', { space: 'oklch' }) : null;
const ENERGY_SCALE = haveColor ? Color.range('#4a4a4a', '#00e676', { space: 'lab' }) : null;
const colorCache = new Map();
function heightColor(scale, v) {
  if (!scale || v == null || !isFinite(v)) return undefined;
  const t = Math.max(0, Math.min(1, (v - 1) / 9));
  const key = scale === MOOD_SCALE ? 'm' + t.toFixed(2) : 'e' + t.toFixed(2);
  let c = colorCache.get(key);
  if (!c) { c = scale(t).to('srgb').toString({ format: 'hex' }); colorCache.set(key, c); }
  return c;
}
// A vertical canvas gradient spanning the y-axis (value 1 at the bottom → 10
// at the top), so the line's color tracks its height smoothly. Built lazily
// once the chart area exists; falls back to a solid color before first layout
// and for the legend swatch.
function gradientCss(scale) {
  if (!scale) return '#888';
  const stops = [];
  for (let i = 0; i <= 4; i++) stops.push(heightColor(scale, 1 + (i / 4) * 9));
  return 'linear-gradient(90deg,' + stops.join(',') + ')';
}
// Shared vertical canvas gradient over the y-axis (value 1 bottom → 10 top).
// alphaHex (2 hex digits) makes a translucent variant for the range band.
function vGradient(ctx, scale, alphaHex) {
  const area = ctx.chart.chartArea;
  if (!area || !scale) return null;
  const g = ctx.chart.ctx.createLinearGradient(0, area.bottom, 0, area.top);
  for (let i = 0; i <= 10; i++) {
    const col = heightColor(scale, 1 + (i / 10) * 9);
    if (!col) return null;
    g.addColorStop(i / 10, col + (alphaHex || ''));
  }
  return g;
}
function byHeight(scale, fallback) {
  return {
    borderColor: ctx => vGradient(ctx, scale) || fallback,
    pointBackgroundColor: ctx => heightColor(scale, ctx.parsed.y) || fallback,
    pointBorderColor: ctx => heightColor(scale, ctx.parsed.y) || fallback,
  };
}

// Min–max range as a translucent height-gradient band behind the mean line:
// a "hi" dataset filling down to the adjacent "lo" dataset.
function band(loArr, hiArr, scale) {
  return [
    { label: '_hi', data: hiArr, borderColor: 'transparent',
      backgroundColor: ctx => vGradient(ctx, scale, '33') || 'transparent',
      pointRadius: 0, fill: '+1', spanGaps: true, tension: .3 },
    { label: '_lo', data: loArr, borderColor: 'transparent', backgroundColor: 'transparent',
      pointRadius: 0, fill: false, spanGaps: true, tension: .3 },
  ];
}

async function loadReview() {
  reviewLoaded = true;
  const data = await api('/api/dashboard?res=' + resolution + '&days=' + windowDays);
  const s = data.series;
  const datasets = [];
  if (errorBars) {
    datasets.push(...band(s.moodLo, s.moodHi, MOOD_SCALE));
    datasets.push(...band(s.energyLo, s.energyHi, ENERGY_SCALE));
  }
  datasets.push({ label: 'Mood', data: s.mood, borderColor: CAT.mood, backgroundColor: CAT.mood, spanGaps: true, tension: .3, ...byHeight(MOOD_SCALE, CAT.mood) });
  datasets.push({ label: 'Energy', data: s.energy, borderColor: CAT.sleep, backgroundColor: CAT.sleep, spanGaps: true, tension: .3, ...byHeight(ENERGY_SCALE, CAT.sleep) });

  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('moodChart'), {
    type: 'line',
    data: { labels: s.labels, datasets },
    options: {
      animation: false,
      scales: { y: { min: 1, max: 10 } },
      plugins: { legend: { display: false } }, // custom gradient legend below
    },
  });

  document.getElementById('chartLegend').innerHTML =
    '<span class="legitem"><span class="legsw" style="background:' + gradientCss(MOOD_SCALE) + '"></span>Mood</span>' +
    '<span class="legitem"><span class="legsw" style="background:' + gradientCss(ENERGY_SCALE) + '"></span>Energy</span>';

  document.getElementById('categories').innerHTML = Object.entries(data.categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => '<span class="catbadge" style="border-color:' + (CAT[c]||CAT.other) + ';color:' + (CAT[c]||CAT.other) + '">' + icon(CAT_IC[c] || 'tag') + esc(c) + ' × ' + n + '</span>')
    .join(' ') || '<em>No entries this week yet.</em>';
  document.getElementById('report').innerHTML =
    data.latestWeeklyReport ? md(data.latestWeeklyReport.markdown) : '<em>No weekly report yet — it generates Sunday evenings.</em>';
}

document.querySelectorAll('#resCtl .res').forEach(b => b.onclick = () => {
  document.querySelectorAll('#resCtl .res').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); resolution = b.dataset.r; loadReview();
});
document.querySelectorAll('#winCtl .win').forEach(b => b.onclick = () => {
  document.querySelectorAll('#winCtl .win').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); windowDays = Number(b.dataset.d); loadReview();
});
document.getElementById('errToggle').onclick = () => {
  errorBars = !errorBars;
  document.getElementById('errToggle').classList.toggle('on', errorBars);
  loadReview();
};

// --- Memory ---
const memText = document.getElementById('memText');
const memStatus = document.getElementById('memStatus');
let memDirty = false;
memText.addEventListener('input', () => { memDirty = true; memStatus.textContent = 'unsaved changes'; });
async function loadMemory() {
  if (memDirty) return; // don't clobber edits in progress
  const d = await api('/api/memory');
  memText.value = d.memory || '';
  memStatus.textContent = '';
}
document.getElementById('memSave').onclick = async () => {
  memStatus.textContent = 'saving…';
  await api('/api/memory', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memory: memText.value }) });
  memDirty = false; memStatus.textContent = 'saved';
};

// --- Ask (chat view) ---
const chat = document.getElementById('chat');
let chatLoaded = false;
function chatBubble(cls, html) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.innerHTML = html;
  chat.appendChild(el);
  return el;
}
// Recent questions + answers, so the chat has its history after a reload.
async function loadChat() {
  if (chatLoaded) return;
  chatLoaded = true;
  try {
    const data = await api('/api/messages?limit=40&since=' + (Math.floor(Date.now()/1000) - 3*86400));
    const qs = data.messages.filter(m => m.role === 'question' && m.answer).slice(0, 8).reverse();
    for (const m of qs) {
      chatBubble('q', esc(m.rawText));
      chatBubble('a md', md(m.answer.text));
    }
  } catch {}
}

// --- Composer (docked on Stream + Ask) ---
// Voice is recorded as a series of short segments: a new MediaRecorder every
// ~25s, each uploaded as soon as it closes and transcribed on the server, so
// no single transcription is long and the transcript shows while you talk.
// The draft (a server message in state 'open') survives a reload.
const MAX_SEGMENT_MS = 25000;
const DRAFT_KEY = 'cyborgy.draft';
const dockText = document.getElementById('dockText');
const dockVoice = document.getElementById('dockVoice');
const dockPhotos = document.getElementById('dockPhotos');
const dockStatus = document.getElementById('dockStatus');
const micBtn = document.getElementById('micBtn');
const camBtn = document.getElementById('camBtn');
const sendBtn = document.getElementById('sendBtn');
const discardBtn = document.getElementById('discardBtn');
const photoIn = document.getElementById('photoIn');
micBtn.innerHTML = icon('mic'); camBtn.innerHTML = icon('camera'); sendBtn.innerHTML = icon('send');

let mode = 'auto';
let draft = null;           // { id, idP, seq, uploads: [], segments: [], photos: [] }
let recording = false, stream = null, recorder = null, rollTimer = null, recStart = 0, clockTimer = null;
let wakeLock = null, pollTimer = null;

function setStatus(text, isErr) {
  dockStatus.textContent = text || '';
  dockStatus.classList.toggle('err', !!isErr);
}
function saveDraftRef() {
  try {
    if (draft && draft.id) localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: draft.id, seq: draft.seq, text: dockText.value }));
    else if (!dockText.value) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: dockText.value }));
  } catch {}
}
function newDraft() {
  return { id: null, idP: null, seq: 0, uploads: [], segments: [], photos: [] };
}
// The server message is created lazily, on the first segment or photo.
function draftId(d) {
  if (!d.idP) {
    d.idP = api('/api/capture', { method: 'POST' }).then(r => {
      if (!r.id) throw new Error(r.error || 'could not start a capture');
      d.id = r.id;
      if (d === draft) saveDraftRef();
      return r.id;
    });
  }
  return d.idP;
}
function renderDock() {
  const d = draft;
  const segs = d ? d.segments : [];
  const parts = segs.map(sg => sg.transcript == null
    ? '<span class="pend">transcribing…</span>'
    : esc(sg.transcript));
  dockVoice.innerHTML = segs.length ? icon('mic') + ' ' + parts.join(' ') : '';
  dockVoice.scrollTop = dockVoice.scrollHeight;
  dockPhotos.innerHTML = d ? d.photos.map(u => '<img src="' + u + '">').join('') : '';
  const hasContent = !!(dockText.value.trim() || segs.length || (d && d.photos.length) || recording);
  discardBtn.hidden = !hasContent;
  autosize();
}
function autosize() {
  dockText.style.height = 'auto';
  dockText.style.height = Math.min(dockText.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
}
dockText.addEventListener('input', () => { renderDock(); saveDraftRef(); });

// Poll segment transcripts while any are pending.
function schedulePoll() {
  clearTimeout(pollTimer);
  const d = draft;
  if (!d || !d.id) return;
  const pending = d.segments.some(sg => sg.transcript == null) || d.uploads.length > 0;
  if (!pending && !recording) return;
  pollTimer = setTimeout(async () => {
    try {
      const r = await api('/api/capture/' + d.id);
      if (d !== draft) return;
      if (r.segments) {
        for (const sg of r.segments) {
          const mine = d.segments.find(x => x.seq === sg.seq);
          if (mine) mine.transcript = sg.transcript;
        }
        renderDock();
      }
    } catch {}
    schedulePoll();
  }, 1500);
}

const mimeType = () =>
  typeof MediaRecorder === 'undefined' ? '' :
  MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
  MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
const streamAlive = st => !!st && st.getAudioTracks().some(t => t.readyState === 'live' && !t.muted);

async function ensureStream() {
  if (streamAlive(stream)) return stream;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getAudioTracks().forEach(t => { t.onended = micLost; });
  return stream;
}
function releaseStream() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}

// One segment: its own MediaRecorder, so every upload is a complete file.
// Returns a promise that resolves once the segment's upload has started.
function startSegment() {
  const d = draft;
  const mt = mimeType();
  const rec = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined);
  const chunks = [];
  const seq = d.seq++;
  const startedAt = Date.now();
  let rolled = false;
  let resolveStop;
  rec.stopped = new Promise(r => { resolveStop = r; });
  const roll = () => {
    // Close this segment and open the next without a gap. The 1s data
    // callback is the clock (timers are throttled in background tabs).
    if (rolled || rec.state !== 'recording') return;
    rolled = true;
    rec.stop();
    if (recorder === rec && recording) startSegment();
  };
  rec.ondataavailable = e => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
    if (Date.now() - startedAt >= MAX_SEGMENT_MS) roll();
  };
  rec.onstop = () => {
    const duration = (Date.now() - startedAt) / 1000;
    if (!rec.cancelled && duration >= 0.4 && chunks.length) {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const seg = { seq, duration, transcript: null };
      d.segments.push(seg);
      d.segments.sort((a, b) => a.seq - b.seq);
      const up = draftId(d)
        .then(id => fetch(('/api/capture/' + id + '/segments?seq=' + seq + '&duration=' + duration.toFixed(2)),
          { method: 'POST', headers: { 'content-type': blob.type }, body: blob }))
        .then(r => r.json())
        .then(r => { if (!r.ok) throw new Error(r.error || 'upload failed'); })
        .catch(err => { seg.failed = true; seg.transcript = ''; if (d === draft) setStatus('A segment did not upload: ' + err.message, true); })
        .finally(() => { d.uploads = d.uploads.filter(x => x !== up); if (d === draft) { renderDock(); schedulePoll(); } });
      d.uploads.push(up);
      if (d === draft) { saveDraftRef(); renderDock(); schedulePoll(); }
    }
    resolveStop();
  };
  rec.start(1000);
  recorder = rec;
  clearTimeout(rollTimer);
  rollTimer = setTimeout(roll, MAX_SEGMENT_MS + 2000);
}

async function startRecording() {
  if (recording) return;
  if (typeof MediaRecorder === 'undefined') { setStatus('This browser cannot record audio.', true); return; }
  try {
    await ensureStream();
  } catch (err) {
    setStatus('No microphone access: ' + (err.message || err), true);
    return;
  }
  if (!draft) draft = newDraft();
  draftId(draft).catch(err => setStatus(err.message, true));
  recording = true;
  micBtn.classList.add('rec'); micBtn.innerHTML = icon('square');
  setStatus('');
  recStart = Date.now();
  clockTimer = setInterval(tickClock, 500); tickClock();
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  startSegment();
  renderDock();
}
function tickClock() {
  const s = Math.floor((Date.now() - recStart) / 1000);
  setStatus('Recording ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
}
// Stop recording; resolves after the last segment's upload has been queued.
async function stopRecording(cancel) {
  if (!recording) return;
  recording = false;
  clearTimeout(rollTimer); clearInterval(clockTimer);
  micBtn.classList.remove('rec'); micBtn.innerHTML = icon('mic');
  setStatus('');
  const rec = recorder; recorder = null;
  if (rec && rec.state === 'recording') {
    rec.cancelled = !!cancel;
    rec.stop();
    await rec.stopped;
  }
  releaseStream();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  renderDock();
}
// The OS cut the mic (app in the background, call, lock screen). Do not
// resume by itself: the user must know there is a gap.
function micLost() {
  if (!recording) return;
  stopRecording();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  setStatus('Recording stopped: the microphone was cut off. Tap the mic to continue.', true);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && recording && !streamAlive(stream)) micLost();
});
micBtn.addEventListener('click', () => recording ? stopRecording() : startRecording());

// Photos: downscale to JPEG (max 1600px) in the browser, then upload.
camBtn.addEventListener('click', () => photoIn.click());
photoIn.addEventListener('change', async () => {
  const files = [...photoIn.files];
  photoIn.value = '';
  if (!files.length) return;
  if (!draft) draft = newDraft();
  const d = draft;
  for (const f of files) {
    try {
      const blob = await toJpeg(f);
      const url = URL.createObjectURL(blob);
      d.photos.push(url);
      renderDock();
      const up = draftId(d)
        .then(id => fetch(('/api/capture/' + id + '/photos'), { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob }))
        .then(r => r.json())
        .then(r => { if (!r.ok) throw new Error(r.error || 'upload failed'); })
        .catch(err => { if (d === draft) setStatus('A photo did not upload: ' + err.message, true); })
        .finally(() => { d.uploads = d.uploads.filter(x => x !== up); });
      d.uploads.push(up);
    } catch (err) {
      setStatus('Could not read that photo: ' + (err.message || err), true);
    }
  }
});
function toJpeg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1600;
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unsupported image')); };
    img.src = url;
  });
}

document.querySelectorAll('#modeCtl .mode').forEach(b => b.onclick = () => {
  document.querySelectorAll('#modeCtl .mode').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); mode = b.dataset.m;
});

discardBtn.addEventListener('click', async () => {
  if (!confirm('Discard this draft (recording, photos and text)?')) return;
  const d = draft;
  await stopRecording(true);
  draft = null; dockText.value = '';
  saveDraftRef(); renderDock(); setStatus('');
  if (d && d.idP) {
    try { const id = await d.idP; await Promise.allSettled(d.uploads); await api('/api/capture/' + id, { method: 'DELETE' }); } catch {}
  }
});

// Send is fire-and-forget: the composer clears at once and the result
// appears in the feed (or the chat on the Ask tab) when it is ready.
async function send() {
  const text = dockText.value.trim();
  const d = draft;
  const hasMedia = recording || (d && (d.segments.length || d.photos.length || d.uploads.length));
  if (!text && !hasMedia) return;
  const onAsk = currentView === 'ask';
  const sendMode = onAsk ? 'question' : mode;
  const hadVoice = recording || (d && d.segments.length > 0);
  await stopRecording();
  draft = null; dockText.value = '';
  saveDraftRef(); renderDock(); setStatus('');

  const preview = text || (hadVoice ? 'Voice note' : 'Photo');
  let placeholder;
  if (onAsk) {
    chatBubble('q', esc(text || 'Voice question'));
    placeholder = chatBubble('a md', '…thinking');
    placeholder.scrollIntoView({ behavior: 'smooth' });
  } else {
    placeholder = document.createElement('div');
    placeholder.className = 'card pendingcard';
    placeholder.innerHTML = '<div class="box">' + icon('refresh') + ' Processing… ' + esc(preview.slice(0, 120)) + '</div>';
    feed.prepend(placeholder);
    if (feed.querySelector('em')) feed.querySelector('em').remove();
  }
  const fail = msg => {
    if (onAsk) placeholder.textContent = msg;
    else { const b = placeholder.querySelector('.box'); b.classList.add('err'); b.textContent = msg; }
  };
  try {
    const id = d ? await draftId(d) : await draftId(newDraft());
    if (d) await Promise.allSettled(d.uploads);
    const res = await api('/api/capture/' + id + '/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, mode: sendMode }),
    });
    if (!res.ok) return fail(res.error || 'Something went wrong.');
    if (res.intent === 'empty') {
      if (onAsk) placeholder.textContent = 'I did not hear anything in that recording.';
      else placeholder.remove();
      return;
    }
    const m = res.message;
    if (onAsk) {
      if (hadVoice && placeholder.previousSibling) placeholder.previousSibling.innerHTML = esc(m.rawText || '');
      placeholder.innerHTML = m.answer ? md(m.answer.text)
        : esc('Logged ' + m.entries.length + (m.entries.length === 1 ? ' entry.' : ' entries.'));
    } else {
      rendered.add(m.id);
      const card = renderMessage(m);
      if (m.answer) card.classList.add('open');
      placeholder.replaceWith(card);
    }
    if (m.role === 'question') loadMemory(); // the assistant may have saved a memory
  } catch (err) {
    fail('Saved, but the request failed (' + (err.message || err) + '). It will retry automatically.');
  }
}
sendBtn.addEventListener('click', send);
dockText.addEventListener('keydown', e => {
  const desktop = window.matchMedia('(pointer: fine)').matches;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (desktop && !e.shiftKey))) { e.preventDefault(); send(); }
});

// Restore a draft after a reload (recording or photos not yet sent).
async function restoreDraft() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch {}
  if (!saved) return;
  if (saved.text) dockText.value = saved.text;
  if (saved.id) {
    try {
      const r = await fetch(('/api/capture/' + saved.id)).then(x => x.ok ? x.json() : null);
      if (r && r.state === 'open') {
        draft = newDraft();
        draft.id = r.id; draft.idP = Promise.resolve(r.id);
        draft.segments = r.segments.map(sg => ({ seq: sg.seq, duration: sg.duration, transcript: sg.transcript }));
        draft.seq = Math.max(saved.seq || 0, ...r.segments.map(sg => sg.seq + 1), 0);
        draft.photos = r.photos.map(k => ('/media/' + encodeURIComponent(k)));
        schedulePoll();
      }
    } catch {}
  }
  saveDraftRef();
  renderDock();
}

// --- Settings ---
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredInstall = e;
  document.getElementById('installBtn').hidden = false;
});
document.getElementById('installBtn').onclick = async () => {
  if (deferredInstall) { await deferredInstall.prompt(); deferredInstall = null; }
  document.getElementById('installBtn').hidden = true;
};
function b64urlBytes(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function currentSub() {
  if (!pushSupported) return null;
  try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch { return null; }
}
async function loadSettings() {
  const st = await api('/api/settings');
  document.querySelectorAll('#settings [data-n]').forEach(cb => { cb.checked = !!st.notify[cb.dataset.n]; });
  document.getElementById('tgState').textContent =
    (st.email ? 'Signed in as ' + st.email + '. ' : '') + 'Timezone: ' + st.timezone + '.' +
    (st.telegram ? ' The Telegram bot is on too.' : '');
  document.getElementById('adminSec').hidden = !st.isAdmin;
  if (st.isAdmin) loadUsers();
  const state = document.getElementById('pushState');
  const btn = document.getElementById('pushBtn');
  const test = document.getElementById('pushTest');
  const hint = document.getElementById('pushHint');
  hint.textContent = '';
  btn.hidden = true; test.hidden = true;
  if (!st.push) { state.textContent = 'Push is not set up on the server (no VAPID keys).'; return; }
  if (!pushSupported) {
    state.textContent = 'This browser cannot get notifications.';
    if (isIOS && !isStandalone) hint.textContent = 'On iPhone: tap Share, then “Add to Home Screen”, and open cyborgy from there.';
    return;
  }
  const sub = await currentSub();
  if (sub) { state.textContent = 'Notifications are on for this device.'; btn.textContent = 'Turn off'; btn.hidden = false; test.hidden = false; }
  else if (Notification.permission === 'denied') state.textContent = 'Notifications are blocked in the browser settings for this site.';
  else { state.textContent = 'Notifications are off for this device.'; btn.textContent = 'Turn on'; btn.hidden = false; }
}
async function loadUsers() {
  const list = document.getElementById('userList');
  const { users } = await api('/api/admin/users');
  const label = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected' };
  list.innerHTML = users.map(u =>
    '<div class="setrow"><span class="grow">' + esc(u.email || '(owner, no email yet)') +
    '<br><span class="meta">' + label[u.status] + (u.isAdmin ? ' · admin' : '') +
    ' · since ' + new Date(u.createdAt * 1000).toLocaleDateString() + '</span></span>' +
    (u.isAdmin ? '' :
      (u.status !== 'approved' ? '<button class="std" data-uid="' + u.id + '" data-st="approved">Approve</button>' : '') +
      (u.status !== 'rejected' ? '<button class="std" data-uid="' + u.id + '" data-st="rejected">' + (u.status === 'approved' ? 'Remove access' : 'Reject') + '</button>' : '')) +
    '</div>').join('') || '<p class="meta">No accounts yet.</p>';
}
document.getElementById('userList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-uid]');
  if (!b) return;
  if (b.dataset.st === 'rejected' && !confirm('Remove access for this account?')) return;
  b.disabled = true;
  const r = await api('/api/admin/users/' + b.dataset.uid, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: b.dataset.st }),
  });
  if (!r.ok) alert(r.error || 'Failed');
  else if (b.dataset.st === 'approved' && r.emailed === false) alert('Approved, but the sign-in email could not be sent. They can ask for a link on the sign-in page.');
  loadUsers();
});
document.getElementById('pushBtn').onclick = async () => {
  const sub = await currentSub();
  if (sub) {
    await api('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe();
    return loadSettings();
  }
  try {
    const { key } = await api('/api/push/key');
    if (!key) throw new Error('no server key');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return loadSettings();
    const reg = await navigator.serviceWorker.ready;
    const nsub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(key) });
    await api('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(nsub.toJSON()) });
  } catch (err) { alert('Could not turn on notifications: ' + (err.message || err)); }
  loadSettings();
};
document.getElementById('pushTest').onclick = async () => {
  const r = await api('/api/push/test', { method: 'POST' });
  document.getElementById('pushHint').textContent = r.sent ? 'Sent to ' + r.sent + (r.sent === 1 ? ' device.' : ' devices.') : 'No device got it.';
};
document.querySelectorAll('#settings [data-n]').forEach(cb => cb.onchange = async () => {
  const notify = {}; notify[cb.dataset.n] = cb.checked;
  await api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notify }) });
});

// --- boot ---
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
show(['stream','review','ask','memory','settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'stream');
loadFeed(true);
restoreDraft();
// A notification tap opens /?compose=1: focus the composer to answer it.
if (new URLSearchParams(location.search).get('compose')) {
  history.replaceState(null, '', location.pathname + location.hash);
  setTimeout(() => dockText.focus(), 300);
}
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
