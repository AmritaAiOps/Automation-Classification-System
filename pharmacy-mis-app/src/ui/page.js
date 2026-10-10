'use strict';

/**
 * The app's single page, served from memory.
 *
 * Kept as one self-contained string rather than a folder of assets so the
 * server has no static paths to resolve. The session token is stamped in at
 * serve time.
 */

function page(token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pharmacy MIS — Daily Report</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #10151c;
    --panel: #171e27;
    --panel-2: #1d2733;
    --panel-3: #131a23;
    --input: #0e141b;
    --hover: #141b24;
    --code-bg: #0d1319;
    --line: #2a3644;
    --line-2: #3d4d60;
    --ink: #e6edf5;
    --ink-dim: #93a4b8;
    --ink-faint: #64758a;
    --ink-ghost: #3f4e61;
    --accent: #4c9be8;
    --accent-bg: #23334a;
    --primary: #1d5fa8;
    --primary-line: #2b74c4;
    --primary-hover: #2470c4;
    --changed: #16241d;
    --ok: #4ec98a;
    --warn: #e8b54c;
    --err: #ef6b6b;
    --step: #b48ce8;
    --mono: ui-monospace, "Cascadia Mono", "Consolas", monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f3f5f8;
      --panel: #ffffff;
      --panel-2: #eef2f6;
      --panel-3: #f7f9fb;
      --input: #ffffff;
      --hover: #eef2f6;
      --code-bg: #f3f5f8;
      --line: #d6dde6;
      --line-2: #b4c0ce;
      --ink: #17202b;
      --ink-dim: #44546a;
      --ink-faint: #6b7b8f;
      --ink-ghost: #a3b0bf;
      --accent: #1f6fc5;
      --accent-bg: #e3eefa;
      --primary: #1d5fa8;
      --primary-line: #1d5fa8;
      --primary-hover: #17508f;
      --changed: #e3f4ea;
      --ok: #1f8a55;
      --warn: #a8740f;
      --err: #c83b3b;
      --step: #7a4fc0;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid;
    grid-template-rows: auto 1fr;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    overflow: hidden;
  }
  a { color: var(--accent); }

  /* ---- title bar ---- */
  header {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 10px 16px; min-width: 0;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .2px; flex: 0 0 auto; }
  header .sub {
    color: var(--ink-faint); font-size: 12px; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  header .spacer { flex: 1; min-width: 8px; }
  .badge {
    font-size: 11px; padding: 3px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--ink-dim); background: var(--panel-3);
  }
  .badge.live { color: var(--ok); border-color: currentColor; }
  .badge.off  { color: var(--ink-faint); }

  /* ---- layout ---- */
  main { display: grid; grid-template-columns: 380px minmax(0, 1fr); min-height: 0; }
  .left  { border-right: 1px solid var(--line); overflow-y: auto; padding: 14px; }
  .right { display: grid; grid-template-rows: auto auto 1fr auto; min-width: 0; min-height: 0; }

  /*
   * Before sign-in only the login card is rendered — not just dimmed, so there
   * is nothing behind it to click or read. body.locked is in the markup, so a
   * cold load shows this before any script runs.
   */
  body.locked main { display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: 24px 16px; }
  body.locked .left { border-right: none; width: 440px; max-width: 100%; flex: 0 0 auto; overflow: visible; padding: 0; }
  body.locked .left > :not(#loginCard) { display: none !important; }
  body.locked #loginCard { display: block !important; padding: 22px 24px; }
  body.locked #loginCard > h2 { font-size: 13px; margin-bottom: 16px; }
  body.locked .right { display: none; }
  body:not(.locked) #manualModeBtn { display: none; }

  section.card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; padding: 12px; margin-bottom: 12px;
  }
  section.card.manual { border-top: 2px solid var(--warn); }
  section.card > h2 {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; text-transform: uppercase; letter-spacing: .7px;
    color: var(--ink-faint); margin: 0 0 10px; font-weight: 600;
  }
  label.field { display: block; margin-bottom: 10px; }
  label.field > span { display: block; font-size: 12px; color: var(--ink-dim); margin-bottom: 4px; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  input[type=text], input[type=date], input[type=password] {
    flex: 1; min-width: 0; width: 100%;
    background: var(--input); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 9px; font: 12px/1.4 var(--mono);
  }
  .row input[type=date] { flex: 1 1 130px; width: auto; }
  input[type=file] { width: 100%; font-size: 12px; color: var(--ink-dim); }
  input:focus { outline: none; border-color: var(--accent); }
  input::placeholder { color: var(--ink-ghost); }

  button {
    background: var(--panel-2); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 11px; font-size: 12px; cursor: pointer;
    white-space: nowrap; transition: border-color .12s, background .12s;
  }
  button:hover:not(:disabled) { border-color: var(--line-2); background: var(--hover); }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button.primary {
    background: var(--primary); border-color: var(--primary-line); color: #fff; font-weight: 600;
    width: 100%; padding: 10px; font-size: 13px;
  }
  button.primary:hover:not(:disabled) { background: var(--primary-hover); }
  button.ghost { background: transparent; }
  button.wide { width: 100%; margin-top: 8px; }
  button.link {
    background: none; border: 0; padding: 4px 0; margin-top: 10px;
    color: var(--accent); width: 100%; text-align: center;
  }
  button.link:hover:not(:disabled) { background: none; text-decoration: underline; }

  .hint { font-size: 11px; color: var(--ink-faint); margin: 6px 0 0; }
  .hint.lead { margin: 0 0 10px; }

  /* ---- task menu ---- */
  .tabs { display: flex; gap: 4px; margin-bottom: 12px; }
  .tabs button {
    flex: 1; padding: 7px 6px; font-size: 12px;
    border-radius: 6px; background: var(--panel-3);
  }
  .tabs button[aria-selected=true] {
    background: var(--accent-bg); border-color: var(--accent); color: var(--ink); font-weight: 600;
  }
  .tabs button[data-task=manual][aria-selected=true] { border-color: var(--warn); }

  .chip {
    font: 600 10px/1.6 "Segoe UI", system-ui, sans-serif; letter-spacing: .3px; text-transform: none;
    padding: 1px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--ink-faint);
  }
  .chip.portal { color: var(--accent); border-color: var(--accent); }
  .chip.manual { color: var(--warn); border-color: var(--warn); }

  .paths {
    font: 11px/1.7 var(--mono); color: var(--ink-faint);
    border-top: 1px dashed var(--line); margin-top: 10px; padding-top: 8px;
    word-break: break-all;
  }
  .paths b { color: var(--ink-dim); font-weight: 500; }

  /* ---- results strip ---- */
  .resultsbar {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 14px; font-size: 11px; color: var(--ink-faint);
    background: var(--panel-3); border-bottom: 1px solid var(--line);
  }
  .results {
    display: grid; grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: 1px; background: var(--line);
    border-bottom: 1px solid var(--line);
  }
  .cellbox { background: var(--panel-3); padding: 9px 10px; min-width: 0; }
  .cellbox .col { font: 600 10px/1 var(--mono); color: var(--accent); letter-spacing: .5px; }
  .cellbox .val {
    font: 600 19px/1.25 "Segoe UI Variable Display", "Segoe UI", sans-serif;
    margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cellbox .val.empty { color: var(--ink-ghost); }
  .cellbox .lbl {
    font-size: 10px; color: var(--ink-faint); margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cellbox.changed { background: var(--changed); }

  /* ---- log ---- */
  .logwrap { display: grid; grid-template-rows: auto 1fr; min-height: 0; }
  .logbar {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 14px; border-bottom: 1px solid var(--line);
    background: var(--panel-3); font-size: 11px; color: var(--ink-faint);
  }
  .logbar .spacer { flex: 1; }
  .logbar label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  #log {
    overflow-y: auto; padding: 8px 0 20px;
    font: 12px/1.65 var(--mono);
    scrollbar-gutter: stable;
  }
  .line { display: flex; padding: 0 14px; white-space: pre-wrap; word-break: break-word; }
  .line:hover { background: var(--hover); }
  .line .t { color: var(--ink-ghost); flex: 0 0 66px; }
  .line .m { flex: 1; min-width: 0; }
  .line.debug { color: var(--ink-faint); }
  .line.info  { color: var(--ink-dim); }
  .line.step  { color: var(--step); font-weight: 600; margin-top: 6px; }
  .line.ok    { color: var(--ok); }
  .line.warn  { color: var(--warn); }
  .line.error { color: var(--err); }
  .line.meta  { color: var(--ink-faint); font-style: italic; }
  .disclose {
    color: var(--ink-ghost); cursor: pointer; user-select: none;
    border: 0; background: none; padding: 0 0 0 6px; font: inherit;
  }
  .disclose:hover { color: var(--accent); }
  .values {
    margin: 2px 0 4px 66px; padding: 6px 9px;
    background: var(--code-bg); border-left: 2px solid var(--line);
    color: var(--ink-faint); font-size: 11px;
    max-height: 190px; overflow-y: auto;
  }

  /* ---- footer ---- */
  footer {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 14px; border-top: 1px solid var(--line);
    background: var(--panel-3); font-size: 12px;
  }
  footer .msg { flex: 1; color: var(--ink-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  footer .msg.err { color: var(--err); }
  footer .msg.ok  { color: var(--ok); }

  .spin {
    width: 12px; height: 12px; flex: 0 0 12px;
    border: 2px solid var(--line); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  [hidden] { display: none !important; }

  /* ---- login card ---- */
  label.checkline { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-dim); margin: 8px 0; cursor: pointer; }
  .login-status { font-size: 12px; margin-top: 8px; min-height: 16px; }
  .login-status.ok { color: var(--ok); }
  .login-status.err { color: var(--err); white-space: pre-wrap; }
  .summary {
    display: grid; grid-template-columns: 1fr auto; gap: 4px 10px;
    font-size: 12px; color: var(--ink-dim); margin-top: 8px;
  }
  .summary .k { color: var(--ink-faint); }
  .summary .v { color: var(--ok); font-weight: 600; text-align: right; }
  .summary .v.big { color: var(--accent); font-size: 15px; }

  /* ---- narrow screens: one column, page scrolls ---- */
  @media (max-width: 760px) {
    body { display: block; overflow: auto; height: auto; }
    main { grid-template-columns: minmax(0, 1fr); }
    .left { border-right: none; border-bottom: 1px solid var(--line); overflow: visible; padding: 16px; }
    .right { grid-template-rows: auto auto 60vh auto; }
    .results { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    header { padding: 10px 16px; }
    header .sub { flex-basis: 100%; order: 5; }
  }
</style>
</head>
<body class="locked">

<header>
  <h1>Pharmacy MIS</h1>
  <span class="sub">Daily Purchase &amp; Inventory Report · <span id="todayDisplay">—</span></span>
  <span class="spacer"></span>
  <span class="badge off" id="scraperBadge">portal pull: checking…</span>
  <span class="badge" id="connBadge">connecting…</span>
  <button class="ghost" id="logoutBtn" hidden style="padding:4px 12px">Log out</button>
</header>

<main>
  <div class="left">
    <nav class="tabs" id="taskNav" role="tablist" aria-label="Task">
      <button role="tab" data-task="portal" aria-selected="true">Portal pull</button>
      <button role="tab" data-task="manual" aria-selected="false">Manual upload</button>
      <button role="tab" data-task="files" aria-selected="false">Files</button>
    </nav>

    <!-- ===== Portal pull ===== -->
    <section class="card" id="loginCard" data-task="portal">
      <h2>Amrita HIS <span class="chip portal">automatic</span></h2>
      <div id="loginFields">
        <label class="field">
          <span>Username</span>
          <input type="text" id="hisUsername" placeholder="Amrita HIS username" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" id="hisPassword" placeholder="Amrita HIS password" autocomplete="new-password">
        </label>
        <label class="checkline">
          <input type="checkbox" id="rememberUsername" checked>
          Remember username
        </label>
        <button class="primary" id="signInBtn">Sign In</button>
      </div>
      <div id="runFields" hidden>
        <div class="login-status ok" id="signedInAs"></div>
        <button class="primary" id="runPortalBtn">Pull &amp; run</button>
        <button class="ghost wide" id="signOutBtn">Sign out / switch account</button>
      </div>
      <div class="login-status" id="loginStatus"></div>
      <div class="summary" id="runSummary" hidden></div>
      <p class="hint" id="loginHint">Signs in to Amrita HIS for you, then pulls the PRQ, PO and GRN reports for the dates below.</p>
      <button class="link" id="manualModeBtn">No credentials? Manual upload instead →</button>
    </section>

    <section class="card" id="dateCard" data-task="portal">
      <h2>Dates to pull</h2>
      <div class="row">
        <input type="date" id="reportDate" title="From date" aria-label="From date">
        <span class="hint" style="margin:0">to</span>
        <input type="date" id="toDate" title="To date (blank = single day)" aria-label="To date">
        <button id="todayBtn" class="ghost" title="Reset to yesterday">Yesterday</button>
      </div>
      <p class="hint">Each day in the range is pulled in turn. Leave "to" blank for one day.</p>
    </section>

    <!-- ===== Manual upload ===== -->
    <section class="card manual" data-task="manual" hidden>
      <h2>Manual upload <span class="chip manual">not from HIS</span></h2>
      <p class="hint lead">For reports exported by hand. Writes the same master row a portal pull would.</p>
      <label class="field">
        <span>Report date</span>
        <input type="date" id="manualDate">
      </label>
      <label class="field">
        <span>PRQ Details → columns C, D</span>
        <input type="file" id="filePRQ" accept=".csv,.xlsx">
      </label>
      <label class="field">
        <span>PO Detail Report → columns E, F, G</span>
        <input type="file" id="filePO" accept=".csv,.xlsx">
      </label>
      <label class="field">
        <span>Purchase Report / GRN → columns H, I, J</span>
        <input type="file" id="fileGRN" accept=".csv,.xlsx">
      </label>
      <p class="hint lead">Each file is checked against its column layout, so one in the wrong slot is still placed correctly.</p>
      <label class="checkline">
        <input type="checkbox" id="dryRun">
        Preview only — don't write the master file
      </label>
      <button class="primary" id="runBtn">Run manual report</button>
    </section>

    <!-- ===== Files ===== -->
    <section class="card" data-task="files" hidden>
      <h2>Files on the server</h2>
      <label class="field">
        <span>Date</span>
        <input type="date" id="filesDate">
      </label>
      <div class="paths" id="pathsIn">Pick a date to see its input files.</div>
      <button class="ghost wide" id="saveInputs" disabled>Save input files to this PC…</button>
      <div class="paths" id="pathsOut">Pick a date to see that month's master.</div>
      <button class="ghost wide" id="saveMaster" disabled>Save master to this PC…</button>
      <div class="paths" id="laptopBox" hidden>
        <b>Laptop folder</b> <span id="laptopDirName">not set</span>
        <div class="row" style="margin-top:6px">
          <button class="ghost" id="pickDir">Choose folder…</button>
          <button class="ghost" id="forgetDir" hidden>Forget</button>
        </div>
        <label class="checkline"><input type="checkbox" id="autoSave" disabled> Save master here automatically after each run</label>
      </div>
      <p class="hint">Input files are the reports pulled from HIS. Manual uploads are not kept on the server.</p>
      <p class="hint" id="saveHint" hidden>This connection can't open a save dialog, so files go to the browser's Downloads folder. Open the site via http://localhost or HTTPS to choose a folder.</p>
    </section>
  </div>

  <div class="right">
    <div class="resultsbar">
      <span>Last result</span>
      <span class="chip" id="resultSource">no run yet</span>
      <span id="resultDate"></span>
    </div>
    <div class="results" id="results"></div>
    <div class="logwrap">
      <div class="logbar">
        <span id="logCount">0 lines</span>
        <span class="spacer"></span>
        <label><input type="checkbox" id="showDebug"> show detail</label>
        <label><input type="checkbox" id="autoScroll" checked> follow</label>
        <button class="ghost" id="clearLog" style="padding:3px 8px">Clear</button>
      </div>
      <div id="log"></div>
    </div>
    <footer>
      <div class="spin" id="spin" hidden></div>
      <div class="msg" id="statusMsg">Ready.</div>
      <button class="ghost" id="copyLog" style="padding:4px 9px">Copy log</button>
    </footer>
  </div>
</main>

<script>
const TOKEN = ${JSON.stringify(token)};

const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path + '?token=' + TOKEN, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-app-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: 'Bad response from the app' }));
  if (!res.ok || data.error) {
    throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), {
      screenshot: data.screenshot || null,
      docLink: data.docLink || null,
      docLinkLabel: data.docLinkLabel || null,
    });
  }
  return data;
};

/* ---------- task menu ---------- */
function showTask(name) {
  document.querySelectorAll('#taskNav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.task === name)));
  document.querySelectorAll('.left > section[data-task]').forEach((s) => { s.hidden = s.dataset.task !== name; });
  try { localStorage.setItem('task', name); } catch (e) { /* storage blocked */ }
}
document.querySelectorAll('#taskNav button').forEach((b) => { b.onclick = () => showTask(b.dataset.task); });
try { const t = localStorage.getItem('task'); if (t) showTask(t); } catch (e) { /* storage blocked */ }

/* ---------- manual form ---------- */
const form = {
  read() {
    return { reportDate: $('manualDate').value.trim(), dryRun: $('dryRun').checked };
  },
  /** Uploaded files as { slot: {name, data(base64)} } — the server stages them for one run. */
  async files() {
    const out = {};
    for (const slot of ['PRQ', 'PO', 'GRN']) {
      const f = $('file' + slot).files[0];
      if (!f) continue;
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(new Error('Could not read ' + f.name));
        r.readAsDataURL(f);
      });
      out[slot] = { name: f.name, data };
    }
    return out;
  },
};

/* ---------- results strip ---------- */
const FIELDS = [
  ['C', 'Total no of PRQ'], ['D', 'PRQ Itemwise'],
  ['E', 'PO Created'], ['F', 'PO Items'], ['G', 'Total PO Value'],
  ['H', 'Total no of GRN'], ['I', 'GRN Itemwise'], ['J', 'Total GRN Value'],
];
const MONEY = new Set(['G', 'J']);

function renderResults(fields, changes) {
  const changed = new Set((changes || []).filter((c) => c.action !== 'skipped (no value from source)').map((c) => c.field));
  $('results').innerHTML = FIELDS.map(([key, label]) => {
    const v = fields ? fields[key] : null;
    const shown = v == null ? '—' :
      MONEY.has(key) ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                     : Number(v).toLocaleString('en-IN');
    return '<div class="cellbox' + (changed.has(key) ? ' changed' : '') + '">'
      + '<div class="col">' + key + '</div>'
      + '<div class="val' + (v == null ? ' empty' : '') + '" title="' + shown + '">' + shown + '</div>'
      + '<div class="lbl" title="' + label + '">' + label + '</div>'
      + '</div>';
  }).join('');
}
renderResults(null, null);

function setResultSource(portal, date) {
  $('resultSource').textContent = portal ? 'Portal pull' : 'Manual upload';
  $('resultSource').className = 'chip ' + (portal ? 'portal' : 'manual');
  $('resultDate').textContent = date || '';
}

/* ---------- log ---------- */
const logEl = $('log');
let lineCount = 0;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function appendLine(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'line ' + entry.level;
  if (entry.level === 'debug' && !$('showDebug').checked) wrap.hidden = true;
  wrap.dataset.level = entry.level;

  const time = entry.ts ? new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false }) : '';
  const pad = '  '.repeat(entry.indent || 0);

  wrap.innerHTML = '<span class="t">' + esc(time) + '</span><span class="m">' + pad + esc(entry.message) + '</span>';

  // A rule that counted things carries the list it counted; keep it one click away.
  const values = entry.detail && Array.isArray(entry.detail.values) ? entry.detail.values : null;
  if (values && values.length) {
    const btn = document.createElement('button');
    btn.className = 'disclose';
    btn.textContent = '[' + values.length + ' ▾]';
    const box = document.createElement('div');
    box.className = 'values';
    box.hidden = true;
    box.textContent = values.join('\\n');
    btn.onclick = () => {
      box.hidden = !box.hidden;
      btn.textContent = '[' + values.length + (box.hidden ? ' ▾]' : ' ▴]');
    };
    wrap.querySelector('.m').appendChild(btn);
    logEl.appendChild(wrap);
    logEl.appendChild(box);
  } else {
    logEl.appendChild(wrap);
  }

  lineCount += 1;
  $('logCount').textContent = lineCount + (lineCount === 1 ? ' line' : ' lines');
  if ($('autoScroll').checked) logEl.scrollTop = logEl.scrollHeight;
}

function appendMeta(text) {
  appendLine({ ts: new Date().toISOString(), level: 'meta', indent: 0, message: text });
}

$('showDebug').onchange = () => {
  const show = $('showDebug').checked;
  logEl.querySelectorAll('.line[data-level=debug]').forEach((el) => { el.hidden = !show; });
};
$('clearLog').onclick = () => { logEl.innerHTML = ''; lineCount = 0; $('logCount').textContent = '0 lines'; };
$('copyLog').onclick = async () => {
  const text = [...logEl.querySelectorAll('.line')].map((el) => el.textContent).join('\\n');
  try { await navigator.clipboard.writeText(text); setStatus('Log copied to the clipboard.', 'ok'); }
  catch (e) { setStatus('Could not copy: ' + e.message, 'err'); }
};

/* ---------- status ---------- */

/**
 * Fill el with the given text, plus a clickable link when one is given — for
 * errors like an Edge launch failure, where the message alone ("Code: 0")
 * means nothing but a link to what it means does. Built with DOM calls rather
 * than innerHTML so nothing in text or label is ever parsed as markup.
 */
function renderMessageWithLink(el, text, link, label) {
  el.textContent = '';
  el.appendChild(document.createTextNode(text));
  if (link) {
    el.appendChild(document.createTextNode(' — '));
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label || 'what this means';
    el.appendChild(a);
  }
}

function setStatus(text, kind, link, linkLabel) {
  const el = $('statusMsg');
  renderMessageWithLink(el, text, link, linkLabel);
  el.className = 'msg' + (kind ? ' ' + kind : '');
}
function setBusy(busy) {
  $('spin').hidden = !busy;
  // Duplicate-run protection: only one pipeline write / Puppeteer session at
  // a time, so every entry point is locked together.
  pipelineBusy = busy;
  $('runBtn').disabled = busy;
  $('runBtn').textContent = busy ? 'Running…' : 'Run manual report';
  $('runPortalBtn').disabled = busy;
  $('runPortalBtn').textContent = busy ? 'Running…' : 'Pull & run';
  $('signOutBtn').disabled = busy;
  $('signInBtn').disabled = busy || signingIn;
}

/* ---------- Amrita HIS sign-in (two steps: Sign In, then Run) ---------- */
let signingIn = false;
let pipelineBusy = false;
let reportDateIso = null; // set from the server at boot — the single source of truth for "yesterday"
let lastRunWasPortal = false; // which path the run in flight came from (set by run-start)
let portalReports = []; // [{key,label}] from /api/status, for the run summary

function setLoginStatus(text, kind, link, linkLabel) {
  const el = $('loginStatus');
  renderMessageWithLink(el, text, link, linkLabel);
  el.className = 'login-status' + (kind ? ' ' + kind : '');
}

function showLoginFields() {
  $('loginFields').hidden = false;
  $('runFields').hidden = true;
}
let signedInUsername = '';
function showRunFields(username) {
  signedInUsername = username || signedInUsername;
  $('loginFields').hidden = true;
  $('runFields').hidden = false;
  $('signedInAs').textContent = '✓ Signed in as ' + signedInUsername;
}

/** Leave the sign-in screen for the dashboard. Stays unlocked until Log out. */
function unlockDashboard() {
  document.body.classList.remove('locked');
  $('logoutBtn').hidden = false;
}

function setSigningIn(busy) {
  signingIn = busy;
  $('signInBtn').disabled = busy || pipelineBusy;
  $('signInBtn').textContent = busy ? 'Authenticating…' : 'Sign In';
  $('hisUsername').disabled = busy;
  $('hisPassword').disabled = busy;
  $('logoutBtn').disabled = busy;
}

function renderPortalSummary(result) {
  const box = $('runSummary');
  if (!result || !result.portalFiles) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = portalReports.map((r) => '<span class="k">' + esc(r.label) + '</span><span class="v">✓</span>').join('')
    + '<span class="k">Reports downloaded</span><span class="v big">' + esc(result.portalFiles.length) + '</span>';
}

/**
 * The username field reflects only this app's own remembered value (never the
 * password), not whatever browser autofill suggests. Both fields are forced to
 * a known state: username from our store, password always blank.
 */
async function loadSavedUsername() {
  $('hisUsername').value = '';
  $('hisPassword').value = '';
  try {
    const r = await api('/api/saved-username');
    if (r.username) {
      $('hisUsername').value = r.username;
      $('rememberUsername').checked = true;
    }
  } catch (e) { /* not fatal — the user can just type it */ }
  // Autofill can land after this ran; clear the password once more.
  setTimeout(() => { $('hisPassword').value = ''; }, 400);
}

/* Manual upload needs no HIS session — /api/run never touches the portal. */
$('manualModeBtn').onclick = () => {
  unlockDashboard();
  showTask('manual');
};

/* Step 1: Sign In — authenticates and verifies, but does not pull any report yet. */
$('signInBtn').onclick = async () => {
  const username = $('hisUsername').value.trim();
  const password = $('hisPassword').value;

  if (!username) { setLoginStatus('Enter your Amrita HIS username.', 'err'); return; }
  if (!password) { setLoginStatus('Enter your Amrita HIS password.', 'err'); return; }

  const payload = {
    username,
    password,
    rememberUsername: $('rememberUsername').checked,
  };
  // The password is in the outgoing request; drop it from the form now.
  $('hisPassword').value = '';

  setSigningIn(true);
  setLoginStatus('Authenticating with Amrita HIS…');

  try {
    // Resolves on { ok: true }; throws with the portal's own message otherwise.
    await api('/api/login', payload);
    setLoginStatus('');
    showRunFields(username);
    unlockDashboard();
    showTask('portal');
  } catch (err) {
    setLoginStatus(
      '✗ ' + err.message + (err.screenshot ? ' — screenshot: ' + err.screenshot : ''),
      'err',
      err.docLink,
      err.docLinkLabel,
    );
  } finally {
    setSigningIn(false);
  }
};

/* Log out: end any portal session and go back to the sign-in screen. */
$('logoutBtn').onclick = async () => {
  try { await api('/api/cancel-login'); } catch (err) { /* best effort */ }
  signedInUsername = '';
  $('hisPassword').value = '';
  showLoginFields();
  setLoginStatus('');
  $('logoutBtn').hidden = true;
  document.body.classList.add('locked');
};

/* Cancel a verified-but-not-yet-run sign-in, e.g. to switch accounts. */
$('signOutBtn').onclick = async () => {
  try { await api('/api/cancel-login'); } catch (err) { /* best effort */ }
  showLoginFields();
  setLoginStatus('');
};

/* Step 2: pull the three HIS reports for the chosen range through the open session. */
$('runPortalBtn').onclick = async () => {
  lastRunWasPortal = true;
  setBusy(true);
  setLoginStatus('Running Amrita HIS automation…', 'ok');
  renderPortalSummary(null);

  try {
    // The outcome arrives over the 'batch-end' / 'run-end' events (see connect()).
    await api('/api/run-portal', {
      fromDate: $('reportDate').value.trim() || reportDateIso,
      toDate: $('toDate').value.trim() || null,
    });
  } catch (err) {
    setBusy(false);
    setLoginStatus('✗ ' + err.message, 'err', err.docLink, err.docLinkLabel);
    // A failed run doesn't necessarily mean a lost sign-in — ask the server.
    await syncSignedInFields();
  }
};

async function syncSignedInFields() {
  try {
    const s = await api('/api/status');
    if (s.signedIn && s.signedInUsername) showRunFields(s.signedInUsername);
    else showLoginFields();
  } catch (e) {
    showLoginFields();
  }
}

/* ---------- live event stream ---------- */
function connect() {
  const es = new EventSource('/api/events?token=' + TOKEN);
  es.onopen = () => { $('connBadge').textContent = 'live'; $('connBadge').className = 'badge live'; };
  es.onerror = () => { $('connBadge').textContent = 'reconnecting…'; $('connBadge').className = 'badge off'; };
  es.addEventListener('log', (e) => appendLine(JSON.parse(e.data)));
  es.addEventListener('session-ended', () => {
    showLoginFields();
    // Mid-run, the run-end that follows reports the failure itself.
    if (!pipelineBusy) setLoginStatus('The Amrita HIS Edge window was closed — sign in again to run.', 'err');
  });
  es.addEventListener('run-start', (e) => {
    const d = JSON.parse(e.data);
    lastRunWasPortal = !!d.usingPortal;
    setBusy(true);
    renderResults(null, null);
    appendMeta('--- [' + (d.usingPortal ? 'Portal pull' : 'Manual upload') + '] run started '
      + new Date(d.at).toLocaleString() + (d.dryRun ? ' (preview only)' : '') + ' ---');
  });
  es.addEventListener('date-start', (e) => {
    const d = JSON.parse(e.data);
    setLoginStatus('Running Amrita HIS automation — date ' + d.index + ' of ' + d.total + ' (' + d.date + ')…', 'ok');
    appendMeta('=== ' + d.date + ' (' + d.index + ' of ' + d.total + ') ===');
  });
  es.addEventListener('batch-end', (e) => {
    const b = JSON.parse(e.data);
    setBusy(false);
    if (b.signedIn) showRunFields();
    else showLoginFields();
    const lines = b.results.map((x) => (x.ok ? '✓ ' : '✗ ') + x.date + (x.ok ? '' : ' — ' + x.error))
      .concat(b.skipped.map((d) => '– ' + d + ' — not run'));
    appendMeta('--- [Portal pull] batch finished ---\\n' + lines.join('\\n'));
    if (b.ok) {
      setLoginStatus('✓ ' + b.results.length + ' date(s) completed'
        + (b.signedIn ? ' — still signed in.' : '. Sign in again to run once more.'), 'ok');
    } else {
      const done = b.results.filter((x) => x.ok).length;
      setLoginStatus('✗ ' + done + ' of ' + (b.results.length + b.skipped.length) + ' date(s) completed. '
        + b.failures + (b.skipped.length ? ' Not run: ' + b.skipped.join(', ') + '.' : '')
        + (b.screenshot ? ' — screenshot: ' + b.screenshot : ''), 'err', b.docLink, b.docLinkLabel);
    }
  });
  es.addEventListener('run-end', (e) => {
    const r = JSON.parse(e.data);
    // A portal batch sends one run-end per date; batch-end above clears busy.
    if (!lastRunWasPortal) setBusy(false);
    finishRun(r);
    if (lastRunWasPortal && r.ok) renderPortalSummary(r);
  });
}

let lastMaster = null;
let lastInputs = [];
function finishRun(r) {
  const source = lastRunWasPortal ? 'Portal' : 'Manual';
  if (!r.ok) {
    setStatus(source + ': ' + (r.error || 'Run failed.'), 'err');
    appendMeta('--- [' + source + '] run failed ---');
    return;
  }
  renderResults(r.fields, r.write && r.write.changes);
  setResultSource(lastRunWasPortal, r.date);
  $('filesDate').value = r.date;
  refreshPaths();

  const cols = Object.entries(r.fields).filter(([, v]) => v != null).map(([k]) => k).join('');
  setStatus(
    source + ': ' + (r.write.written ? 'Saved — ' : 'Preview — ')
    + r.date + ' ' + r.write.mode + ' at row ' + r.write.row
    + ' (' + (cols || 'no') + ' columns), ' + r.write.totalRows + ' date row(s) in the master.',
    'ok',
  );
  appendMeta('--- [' + source + '] run finished ---');
  if (r.write.written && laptopDir && $('autoSave').checked) {
    saveToLaptop(r.layout.masterFile, false)
      .then((ok) => setStatus(ok ? 'Master also saved to laptop folder "' + laptopDir.name + '".'
        : 'Master NOT saved to the laptop folder — open Files and click Save master to re-allow access.', ok ? 'ok' : 'err'))
      .catch((err) => setStatus('Laptop folder save failed: ' + err.message, 'err'));
  }
}

/* ---------- Files tab ---------- */
let resolveTimer = null;
async function refreshPaths() {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(async () => {
    const date = $('filesDate').value.trim();
    if (!date) {
      $('pathsIn').textContent = 'Pick a date to see its input files.';
      $('pathsOut').textContent = "Pick a date to see that month's master.";
      $('saveInputs').disabled = $('saveMaster').disabled = true;
      return;
    }
    try {
      const l = await api('/api/resolve', { reportDate: date });
      if (!l.ok) { $('pathsIn').textContent = $('pathsOut').textContent = l.error || 'Could not resolve those paths.'; return; }
      lastInputs = l.inputFiles;
      lastMaster = l.masterExists ? l.masterFile : null;
      $('pathsIn').innerHTML = l.inputFiles.length
        ? '<b>pulled for this date</b> ' + l.inputFiles.map((f) => esc(baseName(f))).join(' · ')
        : '<b>nothing pulled for this date yet</b>';
      $('pathsOut').innerHTML = l.masterExists
        ? '<b>this month</b> ' + esc(baseName(l.masterFile))
        : '<b>no master workbook for this month yet</b>';
      $('saveInputs').disabled = !l.inputFiles.length;
      $('saveMaster').disabled = !l.masterExists;
    } catch (err) {
      $('pathsIn').textContent = $('pathsOut').textContent = err.message;
    }
  }, 180);
}
$('filesDate').oninput = refreshPaths;

/* ---------- uploads / download ---------- */
['PRQ', 'PO', 'GRN'].forEach((slot) => {
  $('file' + slot).onchange = () => {
    const f = $('file' + slot).files[0];
    const m = f && /([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(f.name);
    if (m && !$('manualDate').value) $('manualDate').value = m[0];
  };
});

const canPick = window.isSecureContext && typeof window.showSaveFilePicker === 'function';
if (!canPick) $('saveHint').hidden = false;
function baseName(file) {
  return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf(String.fromCharCode(92))) + 1);
}
function downloadUrl(file) { return '/api/download?token=' + TOKEN + '&path=' + encodeURIComponent(file); }
async function fetchBlob(file) {
  const res = await fetch(downloadUrl(file));
  if (!res.ok) throw new Error('Could not fetch ' + baseName(file) + ' from the server.');
  return res.blob();
}
function plainDownload(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function writeHandle(handle, blob) {
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}
/** Save one server file; with a picker the user chooses where, otherwise it goes to Downloads. */
async function saveFileAs(file) {
  const blob = await fetchBlob(file);
  if (!canPick) { plainDownload(blob, baseName(file)); return; }
  await writeHandle(await window.showSaveFilePicker({ suggestedName: baseName(file) }), blob);
}
/** Save several server files into one folder the user chooses. */
async function saveFilesToFolder(files) {
  if (!canPick || typeof window.showDirectoryPicker !== 'function') {
    for (const f of files) plainDownload(await fetchBlob(f), baseName(f));
    return;
  }
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  for (const f of files) {
    const handle = await dir.getFileHandle(baseName(f), { create: true });
    await writeHandle(handle, await fetchBlob(f));
  }
}
async function saveToPc(task, okText) {
  try { await task(); setStatus(okText, 'ok'); }
  catch (err) { if (err && err.name !== 'AbortError') setStatus(err.message, 'err'); }
}

/* ---------- laptop folder: chosen once, remembered by the browser (IndexedDB) ---------- */
let laptopDir = null;
const idb = (mode, fn) => new Promise((resolve, reject) => {
  const open = indexedDB.open('pharmacy-mis', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = fn(open.result.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  };
});
function renderLaptopDir() {
  $('laptopDirName').textContent = laptopDir ? laptopDir.name : 'not set';
  $('autoSave').disabled = !laptopDir;
  $('forgetDir').hidden = !laptopDir;
}
/** Write one server file into the laptop folder; false when there is no folder or no permission yet. */
async function saveToLaptop(file, interactive) {
  if (!laptopDir) return false;
  let perm = await laptopDir.queryPermission({ mode: 'readwrite' });
  // The browser only allows the permission prompt from a click, so automatic saves skip it.
  if (perm !== 'granted' && interactive) perm = await laptopDir.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return false;
  await writeHandle(await laptopDir.getFileHandle(baseName(file), { create: true }), await fetchBlob(file));
  return true;
}
if (canDirPicker()) {
  $('laptopBox').hidden = false;
  idb('readonly', (st) => st.get('dir')).then((h) => { laptopDir = h || null; renderLaptopDir(); }).catch(() => {});
  try { $('autoSave').checked = localStorage.getItem('autoSave') === '1'; } catch (e) { /* storage blocked */ }
}
function canDirPicker() { return window.isSecureContext && typeof window.showDirectoryPicker === 'function'; }
$('pickDir').onclick = async () => {
  try {
    laptopDir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idb('readwrite', (st) => st.put(laptopDir, 'dir'));
    renderLaptopDir();
  } catch (err) { if (err && err.name !== 'AbortError') setStatus(err.message, 'err'); }
};
$('forgetDir').onclick = async () => {
  laptopDir = null;
  try { await idb('readwrite', (st) => st.delete('dir')); } catch (e) { /* nothing stored */ }
  renderLaptopDir();
};
$('autoSave').onchange = () => { try { localStorage.setItem('autoSave', $('autoSave').checked ? '1' : '0'); } catch (e) { /* storage blocked */ } };

$('saveMaster').onclick = () => {
  if (!lastMaster) return;
  if (laptopDir) saveToPc(async () => { if (!(await saveToLaptop(lastMaster, true))) throw new Error('No permission to write to the laptop folder.'); }, 'Master saved to laptop folder "' + laptopDir.name + '".');
  else saveToPc(() => saveFileAs(lastMaster), 'Master saved to this PC.');
};
$('saveInputs').onclick = () => { if (lastInputs.length) saveToPc(() => saveFilesToFolder(lastInputs), 'Input files saved to this PC.'); };

$('todayBtn').onclick = () => {
  // "Yesterday" is the previous calendar day as computed by the server
  // (core/paths.js getPreviousCalendarDay), so every date agrees with it.
  if (reportDateIso) { $('reportDate').value = reportDateIso; $('toDate').value = ''; }
};

/* ---------- manual run ---------- */
$('runBtn').onclick = async () => {
  const payload = form.read();
  if (!payload.reportDate) { setStatus('Manual: set the report date first.', 'err'); return; }
  lastRunWasPortal = false;
  setBusy(true);
  setStatus('Manual: running…');
  try {
    // The result arrives over the event stream; this catches a rejected request.
    payload.files = await form.files();
    await api('/api/run', payload);
  } catch (err) {
    setBusy(false);
    setStatus('Manual: ' + err.message, 'err');
  }
};

/* ---------- boot ---------- */
(async () => {
  connect();
  loadSavedUsername();
  try {
    const s = await api('/api/status');
    reportDateIso = s.reportDate;
    portalReports = s.scraper.reports || [];
    $('todayDisplay').textContent = 'today ' + s.todayDisplay;
    for (const id of ['reportDate', 'manualDate', 'filesDate']) if (!$(id).value) $(id).value = s.reportDate;

    // A reload while a Sign In is still open server-side restores that state.
    if (s.signedIn && s.signedInUsername) {
      showRunFields(s.signedInUsername);
      unlockDashboard();
    }

    const b = $('scraperBadge');
    if (s.scraper.available) { b.textContent = 'portal pull: ready'; b.className = 'badge live'; }
    else {
      b.textContent = 'portal pull: unavailable'; b.className = 'badge off';
      $('signInBtn').disabled = true;
      document.querySelector('#taskNav [data-task=portal]').disabled = true;
      $('loginHint').textContent = 'Puppeteer is not part of this build — use Manual upload.';
      // Nothing to sign in to: the manual half must work on its own.
      unlockDashboard();
      showTask('manual');
    }
    appendMeta('Pharmacy MIS ' + s.version + ' — Node ' + s.node);
    appendMeta('Today ' + s.todayDisplay + ' — default report date ' + s.reportDateDisplay);
  } catch (err) {
    // The footer is hidden while locked, so report this on the login card too.
    setStatus('Could not reach the app backend: ' + err.message, 'err');
    setLoginStatus('✗ Could not reach the app backend: ' + err.message, 'err');
  }
  refreshPaths();
})();
</script>
</body>
</html>`;
}

module.exports = { page };
