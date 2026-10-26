'use strict';

/**
 * The app's single page, served from memory.
 *
 * Kept as one self-contained string rather than a folder of assets so the
 * packaged exe has nothing to unpack and no paths to resolve at runtime — the
 * whole UI is inside the binary. The session token is stamped in at serve time.
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
    --bg: #10151c;
    --panel: #171e27;
    --panel-2: #1d2733;
    --line: #2a3644;
    --ink: #e6edf5;
    --ink-dim: #93a4b8;
    --ink-faint: #64758a;
    --accent: #4c9be8;
    --ok: #4ec98a;
    --warn: #e8b54c;
    --err: #ef6b6b;
    --step: #b48ce8;
    --bg-deep: #0e141b;
    --bg-bar: #131a23;
    --dim-1: #3f4e61;
    --dim-2: #4a5b70;
    --mono: ui-monospace, "Cascadia Mono", "Consolas", monospace;
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

  /* ---- title bar ---- */
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; min-width: 0;
    background: linear-gradient(180deg, #1b2431, #151d27);
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
    border: 1px solid var(--line); color: var(--ink-dim); background: var(--bg-bar);
  }
  .badge.live { color: var(--ok); border-color: #2c5b45; }
  .badge.off  { color: var(--ink-faint); }

  /* ---- layout ---- */
  main { display: grid; grid-template-columns: 380px minmax(0, 1fr); min-height: 0; }
  .left  { border-right: 1px solid var(--line); overflow-y: auto; padding: 14px; }
  .right { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; min-height: 0; }

  /* Automatic / Manual tabs: each shows only its own cards. */
  body.tab-manual .auto-only, body.tab-auto .manual-only { display: none; }
  /* Signed out: only the login card until Sign In succeeds. */
  body.signed-out .left > :not(#loginCard) { display: none; }

  section.card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; padding: 12px; margin-bottom: 12px;
  }
  section.card > h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .7px;
    color: var(--ink-faint); margin: 0 0 10px; font-weight: 600;
  }
  label.field { display: block; margin-bottom: 10px; }
  label.field > span { display: block; font-size: 12px; color: var(--ink-dim); margin-bottom: 4px; }
  .row { display: flex; gap: 6px; }
  input[type=text], input[type=date], input[type=password] {
    flex: 1; min-width: 0;
    background: var(--bg-deep); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 9px; font: 12px/1.4 var(--mono);
  }
  input:focus { outline: none; border-color: var(--accent); }
  input::placeholder { color: var(--dim-2); }

  button {
    background: var(--panel-2); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 11px; font-size: 12px; cursor: pointer;
    white-space: nowrap; transition: border-color .12s, background .12s;
  }
  button:hover:not(:disabled) { border-color: #3d4d60; background: #232f3d; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary {
    background: #1d5fa8; border-color: #2b74c4; color: #fff; font-weight: 600;
    width: 100%; padding: 10px; font-size: 13px;
  }
  button.primary:hover:not(:disabled) { background: #2470c4; }
  button.ghost { background: transparent; }

  .hint { font-size: 11px; color: var(--ink-faint); margin: 6px 0 0; }
  .hint.flush { margin: 0 0 8px; }
  label.field.dry { margin-bottom: 8px; }
  label.field.dry > span { display: flex; align-items: center; gap: 6px; margin: 0; }
  label.field.dry input { flex: 0 0 auto; }
  .row.gap-top { margin-top: 8px; }
  button.flex1 { flex: 1; }
  #copyLog { padding: 4px 9px; }
  #clearLog { padding: 3px 8px; }
  .hint code { font-family: var(--mono); color: var(--ink-dim); }

  .tabs { display: flex; gap: 4px; margin-bottom: 10px; }
  .tabs button {
    flex: 1; padding: 6px; font-size: 11px;
    border-radius: 5px; background: var(--bg-bar);
  }
  .tabs button[aria-selected=true] {
    background: #23334a; border-color: var(--accent); color: #fff;
  }

  .paths {
    font: 11px/1.7 var(--mono); color: var(--ink-faint);
    border-top: 1px dashed var(--line); margin-top: 10px; padding-top: 8px;
    word-break: break-all;
  }
  .paths b { color: var(--ink-dim); font-weight: 500; }

  /* ---- results strip ---- */
  .results { border-bottom: 1px solid var(--line); max-height: 40vh; overflow: auto; background: var(--bg-bar); }
  .results table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .results th, .results td { padding: 6px 10px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line); }
  .results th { position: sticky; top: 0; background: var(--bg-bar); font-size: 10px; font-weight: 600; color: var(--ink-faint); }
  .results th:first-child, .results td:first-child { text-align: left; font-weight: 600; }
  .results td.changed { background: #16241d; }
  .results td.empty { color: var(--dim-1); }
  .results tr.fail td { color: #e5736a; text-align: left; white-space: normal; }

  /* ---- log ---- */
  .logwrap { display: grid; grid-template-rows: auto 1fr; min-height: 0; }
  .logbar {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 14px; border-bottom: 1px solid var(--line);
    background: var(--bg-bar); font-size: 11px; color: var(--ink-faint);
  }
  .logbar .spacer { flex: 1; }
  .logbar label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  #log {
    overflow-y: auto; padding: 8px 0 20px;
    font: 12px/1.65 var(--mono);
    scrollbar-gutter: stable;
  }
  .line { display: flex; padding: 0 14px; white-space: pre-wrap; word-break: break-word; }
  .line:hover { background: #141b24; }
  .line .t { color: var(--dim-1); flex: 0 0 66px; }
  .line .m { flex: 1; min-width: 0; }
  .line.debug { color: var(--ink-faint); }
  .line.info  { color: var(--ink-dim); }
  .line.step  { color: var(--step); font-weight: 600; margin-top: 6px; }
  .line.ok    { color: var(--ok); }
  .line.warn  { color: var(--warn); }
  .line.error { color: var(--err); }
  .line.meta  { color: #5d6f85; font-style: italic; }
  .disclose {
    color: var(--dim-2); cursor: pointer; user-select: none;
    border: 0; background: none; padding: 0 0 0 6px; font: inherit;
  }
  .disclose:hover { color: var(--accent); }
  .values {
    margin: 2px 0 4px 66px; padding: 6px 9px;
    background: #0d1319; border-left: 2px solid var(--line);
    color: var(--ink-faint); font-size: 11px;
    max-height: 190px; overflow-y: auto;
  }

  /* ---- footer ---- */
  footer {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 14px; border-top: 1px solid var(--line);
    background: var(--bg-bar); font-size: 12px;
  }
  footer .msg { flex: 1; color: var(--ink-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  footer .msg.err { color: var(--err); }
  footer .msg.ok  { color: var(--ok); }

  .spin {
    width: 12px; height: 12px; flex: 0 0 12px;
    border: 2px solid #2b3a4c; border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  [hidden] { display: none !important; }

  /* ---- login card ---- */
  /* Header: who is signed in, and the Logout button (hidden until someone is). */
  .session { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .session .who { font-size: 12px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  button.logout { padding: 4px 12px; border-color: #5a3a3a; color: #f0b4b4; }
  button.logout:hover:not(:disabled) { border-color: var(--err); background: #2a1c1f; }
  label.checkline { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-dim); margin: 8px 0; cursor: pointer; }
  input[type=password] { width: 100%; }
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
</style>
</head>
<body class="tab-auto signed-out">

<header>
  <h1>Pharmacy MIS</h1>
  <span class="sub">Daily Purchase &amp; Inventory Report</span>
  <span class="spacer"></span>
  <div class="session" id="sessionBox" hidden>
    <span class="who" id="sessionWho"></span>
    <button class="logout" id="logoutBtn" title="Log out of Amrita HIS and return to the sign-in screen">Logout</button>
  </div>
  <span class="badge off" id="scraperBadge">portal pull: checking…</span>
  <span class="badge" id="connBadge">connecting…</span>
</header>

<main>
  <div class="left">
    <div class="tabs" id="modeTabs" role="tablist">
      <button role="tab" id="tabAuto" aria-selected="true">Automatic run</button>
      <button role="tab" id="tabManual" aria-selected="false">Manual run</button>
    </div>
    <section class="card auto-only" id="loginCard">
      <h2>Amrita HIS Login</h2>
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
        <div class="row">
          <label class="field flex1"><span>From</span><input type="date" id="fromDate"></label>
          <label class="field flex1"><span>To</span><input type="date" id="toDate"></label>
        </div>
        <button class="primary" id="runPortalBtn">Run</button>
      </div>
      <div class="login-status" id="loginStatus"></div>
      <div class="summary" id="runSummary" hidden></div>
      <p class="hint" id="loginHint">
        Puppeteer signs in to Amrita HIS with these credentials — nothing to type into a browser
        window yourself. Once signed in and verified, <b>Run</b> pulls the day's reports.
        No credentials, or reports already exported by hand? Use the <b>Manual run</b> tab.
      </p>
    </section>

    <section class="card">
      <h2>1 · Input Output Files</h2>
      <label class="field">
        <span>Folder that holds (or will hold) <code>Pharmacy-MIS/</code></span>
        <div class="row">
          <input type="text" id="archiveRoot" placeholder="C:\\Pharmacy-MIS-Archive">
          <button id="pickRoot">Browse…</button>
        </div>
      </label>
      <div class="paths" id="paths">Choose a folder to see where this run will read and write.</div>
    </section>

    <section class="card manual-only">
      <h2>2 · Source files</h2>
      <div class="tabs" role="tablist">
        <button role="tab" id="tabFolder" aria-selected="true">Inputs folder</button>
        <button role="tab" id="tabFiles" aria-selected="false">Pick files</button>
      </div>

      <div id="paneFolder">
        <label class="field">
          <span>Dated inputs folder</span>
          <div class="row">
            <input type="text" id="inputFolder" placeholder="…\\inputs\\2026-08-08">
            <button id="pickInput">Browse…</button>
          </div>
        </label>
        <p class="hint">
          Every <code>.csv</code>/<code>.xlsx</code> in the folder is read and identified by its
          <b>column layout</b>, so filenames do not matter. Left blank, the conventional
          <code>inputs/DD-MM-YYYY</code> folder under the Input Output Files folder is used.
        </p>
      </div>

      <div id="paneFiles" hidden>
        <label class="field">
          <span>PRQ Details → columns C, D</span>
          <div class="row"><input type="text" id="filePRQ" placeholder="not selected"><button data-pick="PRQ">…</button></div>
        </label>
        <label class="field">
          <span>PO Detail Report → columns E, F, G</span>
          <div class="row"><input type="text" id="filePO" placeholder="not selected"><button data-pick="PO">…</button></div>
        </label>
        <label class="field">
          <span>Purchase Report / GRN → columns H, I, J</span>
          <div class="row"><input type="text" id="fileGRN" placeholder="not selected"><button data-pick="GRN">…</button></div>
        </label>
        <p class="hint">
          Slots are a convenience only — each file is still verified against its column layout,
          so a file put in the wrong slot is placed correctly anyway.
        </p>
      </div>
    </section>

    <section class="card manual-only">
      <h2>3 · Run (manual / preview)</h2>
      <p class="hint flush">
        For files already pulled or exported by hand. The <b>Automatic run</b> tab is the normal
        path — it pulls straight from Amrita HIS and runs this same pipeline.
      </p>
      <label class="field dry">
        <span>
          <input type="checkbox" id="dryRun">
          Preview only — do not write the master file
        </span>
      </label>
      <button class="primary" id="runBtn">Run daily report</button>
      <div class="row gap-top">
        <button id="openMaster" class="ghost flex1" disabled>Open master</button>
        <button id="showMaster" class="ghost flex1" disabled>Show in folder</button>
      </div>
    </section>
  </div>

  <div class="right">
    <div class="results" id="results"></div>
    <div class="logwrap">
      <div class="logbar">
        <span id="logCount">0 lines</span>
        <span class="spacer"></span>
        <label><input type="checkbox" id="showDebug"> show detail</label>
        <label><input type="checkbox" id="autoScroll" checked> follow</label>
        <button class="ghost" id="clearLog">Clear</button>
      </div>
      <div id="log"></div>
    </div>
    <footer>
      <div class="spin" id="spin" hidden></div>
      <div class="msg" id="statusMsg">Ready.</div>
      <button class="ghost" id="copyLog">Copy log</button>
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

/* ---------- persisted form state (saved on the server — see core/settings.js) ---------- */
const form = {
  read() {
    return {
      archiveRoot: $('archiveRoot').value.trim(),
      inputFolder: mode === 'folder' ? $('inputFolder').value.trim() : '',
      files: mode === 'files' ? {
        PRQ: $('filePRQ').value.trim() || null,
        PO: $('filePO').value.trim() || null,
        GRN: $('fileGRN').value.trim() || null,
      } : {},
      dryRun: $('dryRun').checked,
    };
  },
  values() {
    return {
      archiveRoot: $('archiveRoot').value,
      inputFolder: $('inputFolder').value,
      filePRQ: $('filePRQ').value,
      filePO: $('filePO').value,
      fileGRN: $('fileGRN').value,
      mode,
    };
  },
  /** Debounced save to the server. localStorage is no use: the origin carries a fresh port every launch. */
  save() {
    const values = form.values();
    clearTimeout(form._saveTimer);
    form._saveTimer = setTimeout(() => {
      api('/api/settings', values).catch(() => { /* not remembering is not fatal */ });
    }, 300);
  },
  /** Fill the form in from whatever was last saved. */
  apply(s) {
    if (!s) return;
    $('archiveRoot').value = s.archiveRoot || '';
    $('inputFolder').value = s.inputFolder || '';
    $('filePRQ').value = s.filePRQ || '';
    $('filePO').value = s.filePO || '';
    $('fileGRN').value = s.fileGRN || '';
    if (s.mode) setMode(s.mode);
  },
};

/* ---------- source mode ---------- */
let mode = 'folder';
function setMode(next) {
  mode = next;
  $('tabFolder').setAttribute('aria-selected', String(next === 'folder'));
  $('tabFiles').setAttribute('aria-selected', String(next === 'files'));
  $('paneFolder').hidden = next !== 'folder';
  $('paneFiles').hidden = next !== 'files';
  form.save();
}
$('tabFolder').onclick = () => setMode('folder');
$('tabFiles').onclick = () => setMode('files');

/* ---------- results strip ---------- */
const FIELDS = [
  ['C', 'Total no of PRQ'], ['D', 'PRQ Itemwise'],
  ['E', 'PO Created'], ['F', 'PO Items'], ['G', 'Total PO Value'],
  ['H', 'Total no of GRN'], ['I', 'GRN Itemwise'], ['J', 'Total GRN Value'],
];
const MONEY = new Set(['G', 'J']);

// One table row per date run, newest last; a re-run of the same date replaces its row.
const resultRows = new Map();
function renderResults(date, r) {
  if (date == null) resultRows.clear();
  else resultRows.set(date, r);
  const head = '<tr><th>Date</th>' + FIELDS.map(([k, l]) => '<th title="' + l + '">' + k + ' ' + l + '</th>').join('') + '</tr>';
  const rows = [...resultRows].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, res]) => {
    if (!res.ok) return '<tr class="fail"><td>' + d + '</td><td colspan="' + FIELDS.length + '">✗ ' + String(res.error || 'Run failed').replace(/</g, '&lt;') + '</td></tr>';
    const changed = new Set(((res.write && res.write.changes) || []).filter((c) => c.action !== 'skipped (no value from source)').map((c) => c.field));
    return '<tr><td>' + d + '</td>' + FIELDS.map(([key]) => {
      const v = res.fields[key];
      const shown = v == null ? '—' :
        MONEY.has(key) ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                       : Number(v).toLocaleString('en-IN');
      return '<td class="' + (changed.has(key) ? 'changed' : '') + (v == null ? ' empty' : '') + '">' + shown + '</td>';
    }).join('') + '</tr>';
  }).join('');
  $('results').innerHTML = resultRows.size ? '<table>' + head + rows + '</table>' : '';
}
renderResults(null);

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
 * Fill el with the given text, plus a real, clickable link when one is given
 * — for errors like a Puppeteer/Edge launch failure, where the message alone
 * ("Code: 0") means nothing to whoever is looking at it, but a link to what
 * that code means (or a general troubleshooting guide) does. Built with DOM
 * calls rather than innerHTML so nothing in text or label is ever parsed as
 * markup. The link opens in the operator's normal browser, not this window
 * (see main.js's setWindowOpenHandler for target="_blank").
 */
function setMessage(id, base, text, kind, link, label) {
  const el = $(id);
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
  el.className = base + (kind ? ' ' + kind : '');
}

const setStatus = (...a) => setMessage('statusMsg', 'msg', ...a);
function setBusy(busy) {
  $('spin').hidden = !busy;
  $('runBtn').disabled = busy;
  $('runBtn').textContent = busy ? 'Running…' : 'Run daily report';
  // Duplicate-run protection: only one pipeline write / Puppeteer session at
  // a time, so every entry point is locked together.
  pipelineBusy = busy;
  $('runPortalBtn').disabled = busy;
  $('runPortalBtn').textContent = busy ? 'Running…' : 'Run';
  $('logoutBtn').disabled = busy;
  $('signInBtn').disabled = busy || signingIn;
}

/* ---------- Amrita HIS sign-in (two steps: Sign In, then Run) ---------- */
let signingIn = false;
let pipelineBusy = false;
let lastRunWasPortal = false; // which button started the run in flight, for the run-end handler below

const setLoginStatus = (...a) => setMessage('loginStatus', 'login-status', ...a);

/* Not signed in: sign-in fields shown, Logout hidden. */
function showLoginFields() {
  document.body.classList.add('signed-out');
  setTab('auto');
  $('loginFields').hidden = false;
  $('runFields').hidden = true;
  $('sessionBox').hidden = true;
}
let signedInUsername = '';
/* Signed in: Run shown, Logout (and who is signed in) visible in the header. */
function showRunFields(username) {
  signedInUsername = username || signedInUsername;
  document.body.classList.remove('signed-out');
  $('loginFields').hidden = true;
  $('runFields').hidden = false;
  $('signedInAs').textContent = '✓ Signed in as ' + signedInUsername + ' — verified';
  $('sessionWho').textContent = signedInUsername;
  $('sessionBox').hidden = false;
}

function setSigningIn(busy) {
  signingIn = busy;
  $('signInBtn').disabled = busy || pipelineBusy;
  $('signInBtn').textContent = busy ? 'Authenticating…' : 'Sign In';
  $('hisUsername').disabled = busy;
  $('hisPassword').disabled = busy;
}

function renderPortalSummary(result) {
  const box = $('runSummary');
  if (!result || !result.portalFiles) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML =
    '<span class="k">Pharmacy PRQ Details</span><span class="v">✓ Downloaded</span>'
    + '<span class="k">Purchase Order Detail Report - Pharmacy</span><span class="v">✓ Downloaded</span>'
    + '<span class="k">Purchase Report Pharmacy Detail</span><span class="v">✓ Downloaded</span>'
    + '<span class="k">Reports downloaded</span><span class="v big">' + esc(result.portalFiles.length) + '</span>';
}

/**
 * The username field must reflect ONLY this app's own remembered value
 * (the server's settings file — never the password), never whatever a
 * browser's or the operating system's own form-autofill decides to suggest
 * for a field named "username"/"password". Both fields are therefore forced to
 * a known state here rather than trusted to already be blank: they are cleared
 * at boot, the username is then set from our own store if there is one, and the
 * password is left empty — nothing in this app ever writes a value into it
 * programmatically.
 */
function clearLoginFields() {
  $('hisUsername').value = '';
  $('hisPassword').value = '';
  // Autofill (browser or OS-level) can act asynchronously, after this
  // function has already run — the password is enforced empty one more time
  // shortly after, without depending on any one moment being "late enough".
  setTimeout(() => { $('hisPassword').value = ''; }, 400);
}

function prefillUsername(username) {
  if (!username) return;
  $('hisUsername').value = username;
  $('rememberUsername').checked = true;
}

function setTab(t) {
  document.body.classList.toggle('tab-auto', t === 'auto');
  document.body.classList.toggle('tab-manual', t === 'manual');
  $('tabAuto').setAttribute('aria-selected', String(t === 'auto'));
  $('tabManual').setAttribute('aria-selected', String(t === 'manual'));
}
$('tabAuto').onclick = () => setTab('auto');
$('tabManual').onclick = () => setTab('manual');

/* Automatic-run dates default to yesterday (local time); the user can change either. */
(function setDefaultDates() {
  const d = new Date(Date.now() - 864e5);
  const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  $('fromDate').value = iso;
  $('toDate').value = iso;
})();


/* Step 1: Sign In — authenticates and verifies, but does not pull any report yet. */
$('signInBtn').onclick = async () => {
  const username = $('hisUsername').value.trim();
  const password = $('hisPassword').value;

  // Sign In only needs credentials — the input/output folder is a
  // Dashboard setting, read fresh when Run is clicked, not asked for here.
  if (!username) { setLoginStatus('Enter your Amrita HIS username.', 'err'); return; }
  if (!password) { setLoginStatus('Enter your Amrita HIS password.', 'err'); return; }

  const payload = {
    username,
    password,
    rememberUsername: $('rememberUsername').checked,
  };
  // The password has been read into the outgoing request; drop it from the
  // form and from this closure's reach as soon as it is no longer needed.
  $('hisPassword').value = '';

  setSigningIn(true);
  setLoginStatus('Authenticating with Amrita HIS…');

  try {
    // /api/login's JSON response is { ok: true } on success — no "error"
    // field, so api() resolves normally — or throws with the portal's own
    // message on failure (see api()'s definition above: any "error" field
    // makes it throw), which is exactly what the catch below wants.
    await api('/api/login', payload);
    setLoginStatus('✓ Logged in to Amrita HIS — verified', 'ok');
    showRunFields(username);
  } catch (err) {
    // err.message is already a complete, specific sentence (e.g. "Incorrect
    // username or password.") — no need to prefix it with anything, and the
    // fields stay ready for another attempt
    // until it reads correctly.
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

/*
 * Logout: end the signed-in Amrita HIS account and go back to the sign-in
 * screen so a different account can be used. The server refuses while a run is
 * in progress (and the button is disabled then too). If the request fails the
 * session state is re-read from the server rather than assumed.
 */
$('logoutBtn').onclick = async () => {
  $('logoutBtn').disabled = true;
  $('logoutBtn').textContent = 'Logging out…';
  try {
    await api('/api/logout', {});
    signedInUsername = '';
    renderPortalSummary(null);
    $('hisPassword').value = ''; // the remembered username, if any, stays
    showLoginFields();
    setStatus('Ready.');
    setLoginStatus('Logged out of Amrita HIS. Sign in with the same or a different account.');
  } catch (err) {
    setLoginStatus('✗ Could not log out: ' + err.message, 'err');
    setStatus('Could not log out: ' + err.message, 'err');
    await syncSignedInFields();
  } finally {
    $('logoutBtn').textContent = 'Logout';
    $('logoutBtn').disabled = pipelineBusy;
  }
};

/* Step 2: Run — pulls the three Amrita HIS reports through the session Sign In left waiting, for the Input Output Files folder and From/To dates set right now. */
$('runPortalBtn').onclick = async () => {
  const archiveRoot = $('archiveRoot').value.trim();
  if (!archiveRoot) { setStatus('Choose the Input Output Files folder first.', 'err'); return; }

  lastRunWasPortal = true;
  setBusy(true);
  setLoginStatus('Running Amrita HIS automation…', 'ok');
  renderPortalSummary(null);
  $('openMaster').disabled = true;
  $('showMaster').disabled = true;

  try {
    // The definitive outcome — including a login-vs-automation failure
    // distinction via result.stage — arrives over the SSE 'run-end' event
    // (handled in connect() below): /api/run-portal's JSON response also
    // carries an "error" field on a failed run, which api() treats as a
    // request failure, so it is not read here at all.
    await api('/api/run-portal', { archiveRoot, fromDate: $('fromDate').value || undefined, toDate: $('toDate').value || undefined });
  } catch (err) {
    setBusy(false);
    setLoginStatus('✗ ' + err.message, 'err', err.docLink, err.docLinkLabel);
    // A failed run no longer means a lost sign-in — ask the server whether the
    // Edge session is still open rather than assuming either way.
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
/* Prefix and whether to append the screenshot path, per failed-run stage. */
const RUN_FAILURE = {
  login: ['Amrita HIS session problem: ', false],
  // Stopped during the portal pull itself — the classification stage never
  // ran, so there is nothing in the master file from this attempt.
  portal: ['Stopped during the portal pull (classification was not run): ', true],
  automation: ['Report automation failed: ', true],
};

function connect() {
  const es = new EventSource('/api/events?token=' + TOKEN);
  es.onopen = () => { $('connBadge').textContent = 'live'; $('connBadge').className = 'badge live'; };
  es.onerror = () => { $('connBadge').textContent = 'reconnecting…'; $('connBadge').className = 'badge off'; };
  es.addEventListener('log', (e) => appendLine(JSON.parse(e.data)));
  es.addEventListener('login-wait', (e) => {
    setLoginStatus('✗ ' + JSON.parse(e.data).error + '\\nSign in in the Edge window — the app continues once you are in.', 'err');
  });
  es.addEventListener('session-ended', () => {
    showLoginFields();
    // Mid-run, the run-end that follows reports the failure itself.
    if (!lastRunWasPortal) setLoginStatus('The Amrita HIS session ended (signed out or Edge closed) — sign in again to run.', 'err');
  });
  es.addEventListener('run-start', (e) => {
    const d = JSON.parse(e.data);
    setBusy(true);
    renderResults(null);
    appendMeta('--- run started ' + new Date(d.at).toLocaleString() + (d.dryRun ? ' (preview only)' : '') + ' ---');
  });
  es.addEventListener('run-end', (e) => {
    const r = JSON.parse(e.data);
    finishRun(r);
    if (r.more) return; // more dates still to run: stay busy until the last one
    setBusy(false);
    if (lastRunWasPortal) {
      // The Edge session stays signed in after a run unless the portal signed
      // it out (or Edge was closed) — r.signedIn says which.
      if (r.signedIn) showRunFields(signedInUsername);
      else showLoginFields();
      lastRunWasPortal = false;
      if (r.ok) {
        setLoginStatus(r.signedIn
          ? '✓ Automation completed — still signed in. Run again any time; use Logout to sign out.'
          : '✓ Automation completed. Sign in again to run once more.', 'ok');
        renderPortalSummary(r);
      } else {
        const [prefix, withShot] = RUN_FAILURE[r.stage] || RUN_FAILURE.automation;
        setLoginStatus(
          '✗ ' + prefix + r.error + (withShot && r.screenshot ? ' — screenshot: ' + r.screenshot : ''),
          'err',
          r.docLink,
          r.docLinkLabel,
        );
      }
    }
  });
}

let lastMaster = null;
function finishRun(r) {
  renderResults(r.date || 'run', r);
  if (!r.ok) {
    setStatus(r.error || 'Run failed.', 'err');
    appendMeta('--- run failed ---');
    return;
  }
  lastMaster = r.layout.masterFile;
  $('openMaster').disabled = !r.write.written;
  $('showMaster').disabled = !r.write.written;

  const written = r.write.written;
  const cols = Object.entries(r.fields).filter(([, v]) => v != null).map(([k]) => k).join('');
  setStatus(
    (written ? 'Saved — ' : 'Preview — ')
    + r.date + ' ' + r.write.mode + ' at row ' + r.write.row
    + ' (' + (cols || 'no') + ' columns), ' + r.write.totalRows + ' date row(s) in the master.',
    'ok',
  );
  appendMeta('--- run finished ---');
}

/* ---------- path preview ---------- */
let resolveTimer = null;
async function refreshPaths() {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(async () => {
    const root = $('archiveRoot').value.trim();
    if (!root) {
      $('paths').textContent = 'Choose a folder to see where this run will read and write.';
      return;
    }
    try {
      const l = await api('/api/resolve', { archiveRoot: root });
      if (!l.ok) { $('paths').textContent = l.error || 'Could not resolve those paths.'; return; }
      $('paths').innerHTML =
        '<b>month</b> ' + esc(l.monthFolder) + '<br>'
        + '<b>date folder</b> ' + esc(l.dayInputsDir) + '<br>'
        + '<b>master</b> ' + esc(l.masterFile);
    } catch (err) {
      $('paths').textContent = err.message;
    }
  }, 180);
}

/* ---------- pickers ---------- */
async function pick(endpoint, opts, id) {
  try {
    const r = await api(endpoint, opts);
    if (!r.path) return;
    $(id).value = r.path;
    form.save();
    refreshPaths();
  } catch (err) { setStatus(err.message, 'err'); }
}

$('pickRoot').onclick = () => pick('/api/pick-folder', { title: 'Select the Input Output Files folder', initial: $('archiveRoot').value.trim() }, 'archiveRoot');
$('pickInput').onclick = () => pick('/api/pick-folder', { title: "Select the day's inputs folder", initial: $('inputFolder').value.trim() }, 'inputFolder');
document.querySelectorAll('button[data-pick]').forEach((btn) => {
  const slot = btn.dataset.pick;
  btn.onclick = () => pick('/api/pick-file', { title: 'Select the ' + slot + ' file' }, 'file' + slot);
});

$('openMaster').onclick = async () => {
  try { await api('/api/open', { path: lastMaster }); } catch (err) { setStatus(err.message, 'err'); }
};
$('showMaster').onclick = async () => {
  try { await api('/api/reveal', { path: lastMaster }); } catch (err) { setStatus(err.message, 'err'); }
};

/* ---------- run ---------- */
/* The report date is not asked for: the server takes it from the inputs folder / file names (e.g. 08-08-2026), else yesterday. */
$('runBtn').onclick = async () => {
  const payload = form.read();
  if (!payload.archiveRoot) { setStatus('Choose the Input Output Files folder first.', 'err'); return; }
  form.save();
  lastRunWasPortal = false;
  renderPortalSummary(null);
  setLoginStatus('');
  setBusy(true);
  setStatus('Running…');
  try {
    // The result also arrives over the event stream; this catches the case
    // where the request itself is rejected before a run ever starts.
    await api('/api/run', payload);
  } catch (err) {
    setBusy(false);
    setStatus(err.message, 'err');
  }
};

$('archiveRoot').oninput = () => { form.save(); refreshPaths(); };
['inputFolder', 'filePRQ', 'filePO', 'fileGRN'].forEach((id) => { $(id).oninput = form.save; });

/* ---------- boot ---------- */
(async () => {
  connect();
  clearLoginFields();
  try {
    const s = await api('/api/status');
    form.apply(s.settings);
    prefillUsername(s.settings.username);

    // A window reload while a Sign In had already succeeded (but Run had not
    // been clicked yet) should still show the waiting session rather than a
    // blank login form — the browser is still open on the server side.
    if (s.signedIn && s.signedInUsername) {
      setLoginStatus('✓ Logged in to Amrita HIS — verified', 'ok');
      showRunFields(s.signedInUsername);
    }

    const b = $('scraperBadge');
    if (s.scraper.available) { b.textContent = 'portal pull: ready'; b.className = 'badge live'; }
    else {
      b.textContent = 'portal pull: unavailable'; b.className = 'badge off';
      $('signInBtn').disabled = true;
      $('loginHint').textContent = 'Puppeteer is not part of this build — use the manual run below with files pulled or exported by hand.';
      // No Amrita HIS to sign in to in this build — the mapping/manual half
      // must stay fully usable on its own, so there is nothing to gate here.
      document.body.classList.remove('signed-out');
      setTab('manual');
    }
    appendMeta('Pharmacy MIS ' + s.version + ' — Node ' + s.node);
    appendMeta('Today ' + s.todayDisplay + ' — processing reports for ' + s.reportDateDisplay);
    appendMeta(s.scraper.available
      ? 'Portal pull available.'
      : 'Portal pull (Puppeteer) is not part of this build — map files pulled or exported by hand.');
  } catch (err) {
    // The footer this normally goes to is inside the Dashboard, which is
    // exactly what is hidden at this point — so this has to reach the user
    // through the login card instead, or it would be invisible.
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
