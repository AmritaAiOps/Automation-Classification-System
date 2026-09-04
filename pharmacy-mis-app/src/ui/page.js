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
    padding: 10px 16px;
    background: linear-gradient(180deg, #1b2431, #151d27);
    border-bottom: 1px solid var(--line);
  }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .2px; }
  header .sub { color: var(--ink-faint); font-size: 12px; }
  header .spacer { flex: 1; }
  .badge {
    font-size: 11px; padding: 3px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--ink-dim); background: #131a23;
  }
  .badge.live { color: var(--ok); border-color: #2c5b45; }
  .badge.off  { color: var(--ink-faint); }

  /* ---- layout ---- */
  main { display: grid; grid-template-columns: 380px 1fr; min-height: 0; }
  .left  { border-right: 1px solid var(--line); overflow-y: auto; padding: 14px; }
  .right { display: grid; grid-template-rows: auto 1fr auto; min-height: 0; }

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
  input[type=text], input[type=date] {
    flex: 1; min-width: 0;
    background: #0e141b; color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 9px; font: 12px/1.4 var(--mono);
  }
  input:focus { outline: none; border-color: var(--accent); }
  input::placeholder { color: #4a5b70; }

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
  .hint code { font-family: var(--mono); color: var(--ink-dim); }

  .tabs { display: flex; gap: 4px; margin-bottom: 10px; }
  .tabs button {
    flex: 1; padding: 6px; font-size: 11px;
    border-radius: 5px; background: #131a23;
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
  .results {
    display: grid; grid-template-columns: repeat(8, 1fr);
    gap: 1px; background: var(--line);
    border-bottom: 1px solid var(--line);
  }
  .cellbox { background: #131a23; padding: 9px 10px; min-width: 0; }
  .cellbox .col { font: 600 10px/1 var(--mono); color: var(--accent); letter-spacing: .5px; }
  .cellbox .val {
    font: 600 19px/1.25 "Segoe UI Variable Display", "Segoe UI", sans-serif;
    margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cellbox .val.empty { color: #3f4e61; }
  .cellbox .lbl {
    font-size: 10px; color: var(--ink-faint); margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cellbox.changed { background: #16241d; }

  /* ---- log ---- */
  .logwrap { display: grid; grid-template-rows: auto 1fr; min-height: 0; }
  .logbar {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 14px; border-bottom: 1px solid var(--line);
    background: #131a23; font-size: 11px; color: var(--ink-faint);
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
  .line .t { color: #3f4e61; flex: 0 0 66px; }
  .line .m { flex: 1; min-width: 0; }
  .line.debug { color: var(--ink-faint); }
  .line.info  { color: var(--ink-dim); }
  .line.step  { color: var(--step); font-weight: 600; margin-top: 6px; }
  .line.ok    { color: var(--ok); }
  .line.warn  { color: var(--warn); }
  .line.error { color: var(--err); }
  .line.meta  { color: #5d6f85; font-style: italic; }
  .disclose {
    color: #4a5b70; cursor: pointer; user-select: none;
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
    background: #131a23; font-size: 12px;
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
</style>
</head>
<body>

<header>
  <h1>Pharmacy MIS</h1>
  <span class="sub">Daily Purchase &amp; Inventory Report</span>
  <span class="spacer"></span>
  <span class="badge off" id="scraperBadge">portal pull: checking…</span>
  <span class="badge" id="connBadge">connecting…</span>
</header>

<main>
  <div class="left">
    <section class="card">
      <h2>1 · Archive root</h2>
      <label class="field">
        <span>Folder that holds (or will hold) <code>Pharmacy-MIS/</code></span>
        <div class="row">
          <input type="text" id="archiveRoot" placeholder="C:\\Pharmacy-MIS-Archive">
          <button id="pickRoot">Browse…</button>
        </div>
      </label>
      <label class="field">
        <span>Report date</span>
        <div class="row">
          <input type="date" id="reportDate">
          <button id="todayBtn" class="ghost" title="Set to today">Today</button>
        </div>
      </label>
      <div class="paths" id="paths">Choose a root and a date to see where this run will read and write.</div>
    </section>

    <section class="card">
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
          <code>inputs/&lt;date&gt;</code> path under the archive root is used.
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

    <section class="card">
      <h2>3 · Run</h2>
      <label class="field" style="margin-bottom:8px">
        <span style="display:flex;align-items:center;gap:6px;margin:0">
          <input type="checkbox" id="dryRun" style="flex:0 0 auto">
          Preview only — do not write the master file
        </span>
      </label>
      <button class="primary" id="runBtn">Run daily report</button>
      <div class="row" style="margin-top:8px">
        <button id="openMaster" class="ghost" disabled style="flex:1">Open master</button>
        <button id="showMaster" class="ghost" disabled style="flex:1">Show in folder</button>
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
  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
};

/* ---------- persisted form state ---------- */
const STATE_KEY = 'pharmacy-mis-state';
const form = {
  read() {
    return {
      archiveRoot: $('archiveRoot').value.trim(),
      reportDate: $('reportDate').value.trim(),
      inputFolder: mode === 'folder' ? $('inputFolder').value.trim() : '',
      files: mode === 'files' ? {
        PRQ: $('filePRQ').value.trim() || null,
        PO: $('filePO').value.trim() || null,
        GRN: $('fileGRN').value.trim() || null,
      } : {},
      dryRun: $('dryRun').checked,
    };
  },
  save() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        archiveRoot: $('archiveRoot').value,
        inputFolder: $('inputFolder').value,
        filePRQ: $('filePRQ').value,
        filePO: $('filePO').value,
        fileGRN: $('fileGRN').value,
        mode,
      }));
    } catch (e) { /* storage may be unavailable */ }
  },
  restore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { s = null; }
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
function setStatus(text, kind) {
  const el = $('statusMsg');
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}
function setBusy(busy) {
  $('spin').hidden = !busy;
  $('runBtn').disabled = busy;
  $('runBtn').textContent = busy ? 'Running…' : 'Run daily report';
}

/* ---------- live event stream ---------- */
function connect() {
  const es = new EventSource('/api/events?token=' + TOKEN);
  es.onopen = () => { $('connBadge').textContent = 'live'; $('connBadge').className = 'badge live'; };
  es.onerror = () => { $('connBadge').textContent = 'reconnecting…'; $('connBadge').className = 'badge off'; };
  es.addEventListener('log', (e) => appendLine(JSON.parse(e.data)));
  es.addEventListener('run-start', (e) => {
    const d = JSON.parse(e.data);
    setBusy(true);
    renderResults(null, null);
    appendMeta('--- run started ' + new Date(d.at).toLocaleString() + (d.dryRun ? ' (preview only)' : '') + ' ---');
  });
  es.addEventListener('run-end', (e) => {
    const r = JSON.parse(e.data);
    setBusy(false);
    finishRun(r);
  });
}

let lastMaster = null;
function finishRun(r) {
  if (!r.ok) {
    setStatus(r.error || 'Run failed.', 'err');
    appendMeta('--- run failed ---');
    return;
  }
  renderResults(r.fields, r.write && r.write.changes);
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
    const date = $('reportDate').value.trim();
    if (!root || !date) {
      $('paths').textContent = 'Choose a root and a date to see where this run will read and write.';
      return;
    }
    try {
      const l = await api('/api/resolve', { archiveRoot: root, reportDate: date });
      if (!l.ok) { $('paths').textContent = l.error || 'Could not resolve those paths.'; return; }
      $('paths').innerHTML =
        '<b>month</b> ' + esc(l.monthFolder) + '<br>'
        + '<b>inputs</b> ' + esc(l.dayInputsDir) + '<br>'
        + '<b>master</b> ' + esc(l.masterFile);
    } catch (err) {
      $('paths').textContent = err.message;
    }
  }, 180);
}

/* ---------- pickers ---------- */
$('pickRoot').onclick = async () => {
  try {
    const r = await api('/api/pick-folder', { title: 'Select the archive root folder', initial: $('archiveRoot').value.trim() });
    if (r.path) { $('archiveRoot').value = r.path; form.save(); refreshPaths(); }
  } catch (err) { setStatus(err.message, 'err'); }
};

$('pickInput').onclick = async () => {
  try {
    const r = await api('/api/pick-folder', { title: "Select the day's inputs folder", initial: $('inputFolder').value.trim() });
    if (!r.path) return;
    $('inputFolder').value = r.path;
    if (r.dateFromName && !$('reportDate').value) {
      $('reportDate').value = r.dateFromName;
      setStatus('Date ' + r.dateFromName + ' taken from the folder name.');
    }
    form.save();
    refreshPaths();
  } catch (err) { setStatus(err.message, 'err'); }
};

document.querySelectorAll('button[data-pick]').forEach((btn) => {
  btn.onclick = async () => {
    const slot = btn.dataset.pick;
    try {
      const r = await api('/api/pick-file', { title: 'Select the ' + slot + ' file' });
      if (!r.path) return;
      $('file' + slot).value = r.path;
      if (r.dateFromName && !$('reportDate').value) $('reportDate').value = r.dateFromName;
      form.save();
      refreshPaths();
    } catch (err) { setStatus(err.message, 'err'); }
  };
});

$('openMaster').onclick = async () => {
  try { await api('/api/open', { path: lastMaster }); } catch (err) { setStatus(err.message, 'err'); }
};
$('showMaster').onclick = async () => {
  try { await api('/api/reveal', { path: lastMaster }); } catch (err) { setStatus(err.message, 'err'); }
};

$('todayBtn').onclick = () => {
  const d = new Date();
  $('reportDate').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  refreshPaths();
};

/* ---------- run ---------- */
$('runBtn').onclick = async () => {
  const payload = form.read();
  if (!payload.archiveRoot) { setStatus('Choose the archive root folder first.', 'err'); return; }
  if (!payload.reportDate) { setStatus('Set the report date first.', 'err'); return; }
  form.save();
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

['archiveRoot', 'reportDate'].forEach((id) => { $(id).oninput = () => { form.save(); refreshPaths(); }; });
['inputFolder', 'filePRQ', 'filePO', 'fileGRN'].forEach((id) => { $(id).oninput = form.save; });

/* ---------- boot ---------- */
(async () => {
  form.restore();
  if (!$('reportDate').value) $('todayBtn').click();
  connect();
  refreshPaths();
  try {
    const s = await api('/api/status');
    const b = $('scraperBadge');
    if (s.scraper.available) { b.textContent = 'portal pull: ready'; b.className = 'badge live'; }
    else { b.textContent = 'portal pull: admin machine only'; b.className = 'badge off'; }
    appendMeta('Pharmacy MIS ' + s.version + ' — Node ' + s.node);
    appendMeta(s.scraper.available
      ? 'Portal pull available.'
      : 'Portal pull (Puppeteer) is not part of this build — map files pulled or exported by hand.');
  } catch (err) {
    setStatus('Could not reach the app backend: ' + err.message, 'err');
  }
})();
</script>
</body>
</html>`;
}

module.exports = { page };
