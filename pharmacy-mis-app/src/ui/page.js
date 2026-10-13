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
  main { display: grid; grid-template-columns: 440px minmax(0, 1fr); min-height: 0; }
  .left  { border-right: 1px solid var(--line); overflow-y: auto; padding: 14px; }
  .right { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; min-height: 0; }

  /*
   * The Dashboard (archive root, source files, manual run, results, log) is
   * not just visually de-emphasised before sign-in — it is not rendered at
   * all, so there is nothing there to click or read until Amrita HIS
   * authentication succeeds. body.locked is the default in the markup below,
   * so this is what a cold launch shows before any script has run, not just
   * after JS decides to hide something.
   */
  body.locked main { display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: 24px; }
  body.locked .left { border-right: none; width: 440px; max-width: 100%; flex: 0 0 auto; overflow: visible; padding: 0; }
  body.locked .left > section.card:not(#loginCard) { display: none; }
  body.locked .right { display: none; }
  body.locked #loginCard { padding: 22px 24px; }
  body.locked #loginCard > h2 { font-size: 13px; margin-bottom: 16px; }

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
  .hint.pull { margin: -4px 0 10px; }
  .hint.flush { margin: 0 0 8px; }
  label.field.dry { margin-bottom: 8px; }
  label.field.dry > span { display: flex; align-items: center; gap: 6px; margin: 0; }
  label.field.dry input { flex: 0 0 auto; }
  .row.gap-top { margin-top: 8px; }
  button.wide { width: 100%; margin-top: 6px; }
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
  .results {
    display: grid; grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: 1px; background: var(--line);
    border-bottom: 1px solid var(--line);
  }
  .cellbox { background: var(--bg-bar); padding: 9px 10px; min-width: 0; }
  .cellbox .col { font: 600 10px/1 var(--mono); color: var(--accent); letter-spacing: .5px; }
  .cellbox .val {
    font: 600 19px/1.25 "Segoe UI Variable Display", "Segoe UI", sans-serif;
    margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cellbox .val.empty { color: var(--dim-1); }
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

  /* ---- Get the files: dates, tabs, per-file rows ---- */
  input[type=date] { color-scheme: dark; }
  .daterow { display: flex; gap: 8px; align-items: flex-end; margin-bottom: 10px; }
  .daterow label { flex: 1; min-width: 0; font-size: 12px; color: var(--ink-dim); }
  .daterow label span { display: block; margin-bottom: 4px; }
  .daterow label input { width: 100%; }
  .dateview { display: flex; align-items: center; gap: 8px; margin: -2px 0 10px; font-size: 12px; color: var(--ink-dim); }
  .dateview select {
    background: var(--bg-deep); color: var(--ink); border: 1px solid var(--line);
    border-radius: 6px; padding: 5px 8px; font: 12px var(--mono);
  }
  button.small { padding: 4px 9px; font-size: 11px; }
  .filelist { margin-top: 10px; }
  .filerow {
    background: var(--bg-deep); border: 1px solid var(--line); border-radius: 6px;
    padding: 8px 10px; margin-top: 8px; transition: border-color .15s, background .15s;
  }
  .filerow.drag { border-color: var(--accent); background: #10202f; }
  .filerow.flash { animation: flash 2.6s ease-out; }
  @keyframes flash { 0%, 55% { border-color: var(--warn); background: #272113; } 100% { border-color: var(--line); background: var(--bg-deep); } }
  .fhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .fname { font-size: 12px; font-weight: 600; min-width: 0; }
  .fmsg { font-size: 11px; color: var(--ink-faint); margin-top: 5px; word-break: break-word; }
  .fmsg.err { color: var(--err); }
  .factions { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .drophint { font-size: 11px; color: var(--ink-faint); }
  .filerow details { margin-top: 6px; font-size: 11px; color: var(--ink-dim); }
  .filerow summary { cursor: pointer; color: var(--ink-faint); user-select: none; }
  .filerow summary:hover { color: var(--accent); }
  .filerow ol { margin: 6px 0 0; padding-left: 18px; line-height: 1.6; }
  .chip {
    font-size: 10px; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
    border: 1px solid var(--line); color: var(--ink-dim); background: var(--bg-bar);
  }
  .chip.running { color: var(--warn); border-color: #5b4a22; }
  .chip.done    { color: var(--ok);   border-color: #2c5b45; }
  .chip.failed  { color: var(--err);  border-color: #6a3a3a; }

  /* ---- readiness bar ---- */
  .readybar { margin-bottom: 10px; }
  .rb-day {
    display: flex; align-items: center; gap: 6px; padding: 4px 7px; border-radius: 5px;
    font: 11px var(--mono); color: var(--ink-dim); cursor: pointer;
  }
  .rb-day > span:first-child { flex: 1; }
  .rb-day.sel { background: var(--panel-2); }
  .mini { padding: 1px 7px; border-radius: 4px; border: 1px solid var(--line); font-size: 10px; }
  .mini.ok   { color: var(--ok);   border-color: #2c5b45; }
  .mini.miss { color: var(--warn); border-color: #5b4a22; }
  .mini.bad  { color: var(--err);  border-color: #6a3a3a; }
  .rb-note { font-size: 11px; color: var(--ink-faint); padding: 4px 7px 0; }
  .rb-note.ok { color: var(--ok); }

  /* ---- sign-in extras + settings ---- */
  /* Once past the sign-in screen the long explanation is just in the way. */
  body:not(.locked) #loginHint { display: none; }
  button.link {
    background: none; border: 0; padding: 0; color: var(--ink-faint); font-size: 11px;
    text-decoration: underline; cursor: pointer; margin: 2px 0 8px;
  }
  button.link:hover { color: var(--accent); }
  .modal {
    position: fixed; inset: 0; background: rgba(5, 8, 12, .65);
    display: flex; align-items: center; justify-content: center; z-index: 10;
  }
  .modal .box {
    width: 440px; max-width: calc(100% - 32px); background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px;
  }
  .modal input[type=text] { width: 100%; }
  .modal h3 { margin: 0 0 12px; font-size: 14px; }
  .modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  .modal .msg { font-size: 12px; color: var(--err); min-height: 16px; margin-top: 8px; }
  input[type=number] {
    background: var(--bg-deep); color: var(--ink); border: 1px solid var(--line);
    border-radius: 6px; padding: 7px 9px; font: 12px var(--mono); width: 90px;
  }
</style>
</head>
<body class="locked">

<header>
  <h1>Pharmacy MIS</h1>
  <span class="sub">Daily Purchase &amp; Inventory Report</span>
  <span class="spacer"></span>
  <div class="session" id="sessionBox" hidden>
    <span class="who" id="sessionWho"></span>
    <button class="logout" id="logoutBtn" title="Log out of Amrita HIS and return to the sign-in screen">Logout</button>
  </div>
  <button class="ghost small" id="settingsBtn" title="HIS address and retries">Settings</button>
  <span class="badge off" id="scraperBadge">portal pull: checking…</span>
  <span class="badge" id="connBadge">connecting…</span>
</header>

<main>
  <div class="left">
    <section class="card" id="loginCard">
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
        <label class="checkline">
          <input type="checkbox" id="rememberPassword">
          Remember password on this PC <span class="hint" style="margin:0">(encrypted)</span>
        </label>
        <button class="link" id="forgetLogin" hidden>Forget saved login</button>
        <label class="checkline">
          <input type="checkbox" id="headless">
          Run the browser in the background
        </label>
        <button class="primary" id="signInBtn">Sign In</button>
        <button class="ghost wide" id="manualModeBtn">Continue without signing in — manual only</button>
      </div>
      <div id="runFields" hidden>
        <div class="login-status ok" id="signedInAs"></div>
      </div>
      <div class="login-status" id="loginStatus"></div>
      <p class="hint" id="loginHint">
        Once signed in, <b>Automatic</b> downloads the three reports for you, with a live status for
        each file. A saved password is encrypted with Windows and works only for your Windows user
        on this PC.
        <br><br>
        Prefer to download the files yourself? <b>Continue without signing in</b> opens the
        <b>Manual</b> tab, which checks and files what you download.
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

    <section class="card">
      <h2>2 · Get the files</h2>
      <div class="daterow">
        <label><span>From</span><input type="date" id="dateFrom"></label>
        <label><span>To</span><input type="date" id="dateTo"></label>
        <button class="ghost" id="yesterdayBtn" title="Reset both dates to yesterday">Yesterday</button>
      </div>
      <div class="dateview" id="dateViewRow" hidden>
        <span>Showing</span><select id="dateView"></select>
      </div>

      <div class="tabs" role="tablist">
        <button role="tab" id="tabAuto" aria-selected="true">Automatic</button>
        <button role="tab" id="tabManual" aria-selected="false">Manual</button>
      </div>

      <div id="paneAuto">
        <p class="hint flush" id="autoNote"></p>
        <button class="primary" id="runExtractBtn">Run Extraction</button>
        <div class="filelist" id="autoList"></div>
      </div>

      <div id="paneManual" hidden>
        <p class="hint flush">
          Download each report in the HIS yourself, then add it here for <b id="manualDate">—</b>.
          Each file is checked, then saved with the same name and in the same folder as Automatic.
        </p>
        <div class="filelist" id="manualList"></div>
      </div>
    </section>

    <section class="card">
      <h2>3 · Report</h2>
      <div class="readybar" id="readyBar"></div>
      <label class="field dry">
        <span>
          <input type="checkbox" id="dryRun">
          Preview only — do not write the master file
        </span>
      </label>
      <button class="primary" id="proceedBtn" disabled>Proceed to Report</button>
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

<div class="modal" id="settingsModal" hidden>
  <div class="box">
    <h3>Settings</h3>
    <label class="field">
      <span>HIS address</span>
      <input type="text" id="setHisUrl" spellcheck="false">
    </label>
    <label class="field">
      <span>Retries for a failed file (0–5)</span>
      <input type="number" id="setRetries" min="0" max="5">
    </label>
    <p class="hint">
      The sign-in form's selectors, and everything else the automation reads, are in the settings
      file — <button class="link" id="settingsFile">show settings file</button>.
      The output folder is the Input Output Files box on the main screen.
    </p>
    <div class="msg" id="settingsMsg"></div>
    <div class="actions">
      <button class="ghost" id="settingsCancel">Cancel</button>
      <button class="primary" style="width:auto;padding:7px 18px" id="settingsSave">Save</button>
    </div>
  </div>
</div>

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

/* ---------- state ---------- */
let files = [];                // the three reports: { key, label, feeds, steps } — from the server, the one list both tabs share
let tab = 'auto';              // 'auto' | 'manual'
let signedIn = false;
let signingIn = false;
let pipelineBusy = false;      // the report pipeline is running (Proceed to Report)
let extracting = false;        // Run Extraction is running
let progress = {};             // progress[isoDate][key] = latest file-progress event from this session's extraction
let rowErrors = {};            // rowErrors[isoDate][key] = why the last file handed to Tab 2 was refused
let status = { dates: [], allReady: false, error: '' };
let viewIso = null;            // the day the two tabs are showing
let defaultDates = null;       // { from, to } = yesterday, from the server
let savedLogin = { available: false, hasPassword: false, username: '' };
let hisConfig = { hisUrl: '', retries: 2 };
let openSteps = new Set();     // which "How to get this file" lists are expanded
let statusSeq = 0;
let lastMaster = null;
let signedInUsername = '';

const busy = () => pipelineBusy || extracting;
const dmy = (iso) => iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);
const fileDef = (key) => files.find((f) => f.key === key);

/* ---------- persisted form state (saved on the server — see core/settings.js) ---------- */
const form = {
  read() {
    return { archiveRoot: $('archiveRoot').value.trim(), dryRun: $('dryRun').checked };
  },
  values() {
    return { archiveRoot: $('archiveRoot').value, tab };
  },
  /** Debounced save to the server. localStorage is no use: the origin carries a fresh port every launch. */
  save() {
    const values = form.values();
    clearTimeout(form._saveTimer);
    form._saveTimer = setTimeout(() => {
      api('/api/settings', values).catch(() => { /* not remembering is not fatal */ });
    }, 300);
  },
  apply(s) {
    if (!s) return;
    $('archiveRoot').value = s.archiveRoot || '';
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
const setLoginStatus = (...a) => setMessage('loginStatus', 'login-status', ...a);

/** One place that decides which buttons are live, from the signed-in / busy / date state. */
function applyState() {
  const b = busy();
  $('spin').hidden = !b;
  const rangeProblem = !$('archiveRoot').value.trim() || !!rangeError();

  $('runExtractBtn').disabled = b || !signedIn || rangeProblem;
  $('runExtractBtn').textContent = extracting ? 'Extracting…' : 'Run Extraction';
  $('proceedBtn').disabled = b || !status.allReady;
  $('proceedBtn').textContent = pipelineBusy ? 'Running…' : 'Proceed to Report';
  $('logoutBtn').disabled = b;
  $('signInBtn').disabled = b || signingIn;
  $('manualModeBtn').disabled = b;
  ['dateFrom', 'dateTo', 'yesterdayBtn'].forEach((id) => { $(id).disabled = b; });

  $('autoNote').textContent = signedIn
    ? (($('headless').checked ? 'The browser runs in the background.' : 'Edge opens so you can watch.')
      + ' A file that fails is tried again ' + hisConfig.retries + (hisConfig.retries === 1 ? ' time' : ' times') + ', then flagged and the rest carry on.')
    : 'Sign in to Amrita HIS (top left) to use automatic extraction — or use the Manual tab.';
}

function setBusy(busyNow) {
  pipelineBusy = busyNow;
  applyState();
}

/* ---------- Amrita HIS sign-in ---------- */

/* Not signed in: sign-in fields shown, Logout hidden. */
function showLoginFields() {
  signedIn = false;
  $('loginFields').hidden = false;
  $('runFields').hidden = true;
  $('sessionBox').hidden = true;
  applyState();
  renderAll();
}
/* Signed in: Logout (and who is signed in) visible in the header. */
function showRunFields(username) {
  signedInUsername = username || signedInUsername;
  signedIn = true;
  $('loginFields').hidden = true;
  $('runFields').hidden = false;
  $('signedInAs').textContent = '✓ Signed in as ' + signedInUsername + ' — verified';
  $('sessionWho').textContent = signedInUsername;
  $('sessionBox').hidden = false;
  applyState();
  renderAll();
}

/**
 * The Dashboard stays unreachable — not merely dimmed — until Amrita HIS
 * authentication succeeds, or "Continue without signing in" is chosen (body
 * starts with the "locked" class already on it, before any script runs). Once
 * unlocked it stays unlocked until Logout, which puts the window back in its
 * cold-launch sign-in state (lockDashboard).
 */
function unlockDashboard() { document.body.classList.remove('locked'); }
function lockDashboard() { document.body.classList.add('locked'); }

function setSigningIn(isBusy) {
  signingIn = isBusy;
  $('signInBtn').textContent = isBusy ? 'Authenticating…' : 'Sign In';
  $('hisUsername').disabled = isBusy;
  $('hisPassword').disabled = isBusy;
  applyState();
}

/** Whether the saved login can stand in for the password field, for the username typed. */
const usingSavedPassword = () => savedLogin.hasPassword && savedLogin.username === $('hisUsername').value.trim();

function updateLoginUi() {
  $('hisPassword').placeholder = usingSavedPassword() ? 'Saved password will be used' : 'Amrita HIS password';
  $('forgetLogin').hidden = !savedLogin.hasPassword;
  $('rememberPassword').disabled = !savedLogin.available;
  $('rememberPassword').parentElement.title = savedLogin.available ? '' : 'This PC cannot encrypt a saved password, so it cannot be remembered.';
  if (savedLogin.hasPassword) $('rememberPassword').checked = true;
}

/**
 * The username field must reflect ONLY this app's own remembered value (the
 * server's settings file), never whatever a browser's or the operating
 * system's form-autofill decides to suggest. Both fields are forced to a known
 * state here, and the password is left empty — nothing in this app ever writes
 * a value into it programmatically (a saved password stays on the server).
 */
function clearLoginFields() {
  $('hisUsername').value = '';
  $('hisPassword').value = '';
  setTimeout(() => { $('hisPassword').value = ''; }, 400);
}

function prefillUsername(username) {
  if (!username) return;
  $('hisUsername').value = username;
  $('rememberUsername').checked = true;
}

$('hisUsername').oninput = updateLoginUi;

/*
 * Reports can be saved by hand (Manual tab) with no Amrita HIS session at all,
 * so the login card offers a way straight past it.
 */
$('manualModeBtn').onclick = () => {
  unlockDashboard();
  $('manualModeBtn').hidden = true;
  setTab('manual');
  setLoginStatus('Manual mode — sign in above whenever automatic extraction is needed.');
};

$('signInBtn').onclick = async () => {
  const username = $('hisUsername').value.trim();
  const password = $('hisPassword').value;

  if (!username) { setLoginStatus('Enter your Amrita HIS username.', 'err'); return; }
  if (!password && !usingSavedPassword()) { setLoginStatus('Enter your Amrita HIS password.', 'err'); return; }

  const payload = {
    username,
    password,
    rememberUsername: $('rememberUsername').checked,
    rememberPassword: $('rememberPassword').checked,
    headless: $('headless').checked,
  };
  // The password has been read into the outgoing request; drop it from the form.
  $('hisPassword').value = '';

  setSigningIn(true);
  setLoginStatus('Authenticating with Amrita HIS…');

  try {
    await api('/api/login', payload);
    setLoginStatus('✓ Logged in to Amrita HIS — verified', 'ok');
    showRunFields(username);
    unlockDashboard();
    setTab('auto');
    try { savedLogin = (await api('/api/status')).savedLogin; } catch (e) { /* keep what we had */ }
    updateLoginUi();
  } catch (err) {
    // err.message is already a complete, specific sentence (e.g. "Incorrect
    // username or password.") — the Dashboard stays locked and the fields stay
    // ready for another attempt.
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

$('forgetLogin').onclick = async () => {
  try {
    await api('/api/credentials/forget', {});
    savedLogin = { ...savedLogin, hasPassword: false };
    $('rememberPassword').checked = false;
    updateLoginUi();
    setLoginStatus('Saved login removed from this PC.', 'ok');
  } catch (err) {
    setLoginStatus('✗ Could not remove the saved login: ' + err.message, 'err');
  }
};

/*
 * Logout: end the signed-in Amrita HIS account and go back to the sign-in
 * screen so a different account can be used. The server refuses while a run is
 * in progress (and the button is disabled then too). If the request fails the
 * session state is re-read from the server rather than assumed.
 */
$('logoutBtn').onclick = async () => {
  if (busy()) return;
  $('logoutBtn').disabled = true;
  $('logoutBtn').textContent = 'Logging out…';
  try {
    await api('/api/logout', {});
    signedInUsername = '';
    progress = {};
    $('hisPassword').value = ''; // the remembered username, if any, stays
    showLoginFields();
    lockDashboard();
    $('manualModeBtn').hidden = false;
    setStatus('Ready.');
    setLoginStatus('Logged out of Amrita HIS. Sign in with the same or a different account.');
  } catch (err) {
    setLoginStatus('✗ Could not log out: ' + err.message, 'err');
    setStatus('Could not log out: ' + err.message, 'err');
    await syncSignedInFields();
  } finally {
    $('logoutBtn').textContent = 'Logout';
    applyState();
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

/* ---------- dates ---------- */
const range = () => ({ from: $('dateFrom').value, to: $('dateTo').value || $('dateFrom').value });

function rangeError() {
  const r = range();
  if (!r.from) return 'Pick a From date.';
  if (r.to < r.from) return 'The To date is before the From date.';
  return '';
}

function onDatesChanged() {
  progress = {};
  rowErrors = {};
  refreshPaths();
  refreshStatus();
}
$('dateFrom').onchange = () => {
  if ($('dateTo').value && $('dateTo').value < $('dateFrom').value) $('dateTo').value = $('dateFrom').value;
  onDatesChanged();
};
$('dateTo').onchange = onDatesChanged;
$('yesterdayBtn').onclick = () => {
  if (!defaultDates) return;
  $('dateFrom').value = defaultDates.from;
  $('dateTo').value = defaultDates.to;
  onDatesChanged();
};
$('dateView').onchange = () => { viewIso = $('dateView').value; renderAll(); };

/* ---------- tabs ---------- */
function setTab(next, save) {
  tab = next;
  $('tabAuto').setAttribute('aria-selected', String(next === 'auto'));
  $('tabManual').setAttribute('aria-selected', String(next === 'manual'));
  $('paneAuto').hidden = next !== 'auto';
  $('paneManual').hidden = next !== 'manual';
  if (save !== false) form.save();
}
$('tabAuto').onclick = () => setTab('auto');
$('tabManual').onclick = () => setTab('manual');

/* ---------- what is ready (both tabs write the same folders, so this is shared) ---------- */
let statusTimer = null;
function refreshStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(loadStatus, 150);
}

async function loadStatus() {
  const seq = ++statusSeq;
  const root = $('archiveRoot').value.trim();
  const problem = !root ? 'Choose the Input Output Files folder first.' : rangeError();
  let next;
  if (problem) {
    next = { dates: [], allReady: false, error: problem };
  } else {
    try { next = { ...(await api('/api/files/status', { archiveRoot: root, ...range() })), error: '' }; }
    catch (err) { next = { dates: [], allReady: false, error: err.message }; }
  }
  if (seq !== statusSeq) return; // a newer request has superseded this one
  status = next;
  if (!status.dates.some((d) => d.iso === viewIso)) viewIso = status.dates.length ? status.dates[0].iso : null;
  renderAll();
}

/** What to show for one file on one day, combining the folder's contents with this session's live progress. */
function fileView(iso, key) {
  const day = status.dates.find((d) => d.iso === iso);
  const f = day && day.files.find((x) => x.key === key);
  const p = (progress[iso] || {})[key];
  if (p && (p.state === 'running' || p.state === 'retrying')) return p;
  if (f && f.state === 'valid') return { state: 'done', rows: f.rows };
  if (p && p.state === 'failed') return p;
  if (f && f.state === 'invalid') return { state: 'failed', error: f.error };
  return { state: extracting ? 'pending' : 'missing' };
}

function renderAll() {
  renderDateView();
  renderAuto();
  renderManual();
  renderReadyBar();
  applyState();
}

function renderDateView() {
  const many = status.dates.length > 1;
  $('dateViewRow').hidden = !many;
  if (!many) return;
  $('dateView').innerHTML = status.dates.map((d) =>
    '<option value="' + d.iso + '"' + (d.iso === viewIso ? ' selected' : '') + '>' + d.dmy + (d.ready ? ' ✓' : '') + '</option>').join('');
}

const AUTO_LABEL = {
  pending: ['Pending', 'pending'],
  missing: ['Pending', 'pending'],
  running: ['Running', 'running'],
  retrying: ['Retrying', 'running'],
  done: ['Done', 'done'],
  failed: ['Failed', 'failed'],
};

function renderAuto() {
  const list = $('autoList');
  if (!viewIso) { list.innerHTML = '<p class="hint">' + esc(status.error || 'Pick the dates above.') + '</p>'; return; }
  list.innerHTML = files.map((def) => {
    const v = fileView(viewIso, def.key);
    const [text, cls] = AUTO_LABEL[v.state] || AUTO_LABEL.pending;
    let detail = '';
    let action = '';
    if (v.state === 'running') detail = 'Attempt ' + v.attempt + ' of ' + v.of + '…';
    else if (v.state === 'retrying') detail = 'Failed — trying again. ' + (v.error || '');
    else if (v.state === 'done') detail = (v.rows != null ? v.rows + ' rows — ' : '') + 'saved';
    else if (v.state === 'failed') {
      detail = v.error || 'Failed.';
      action = '<button class="ghost small" data-manual="' + def.key + '">Switch to manual for this file</button>';
    }
    return '<div class="filerow" data-key="' + def.key + '">'
      + '<div class="fhead"><span class="fname">' + esc(def.label) + '</span><span class="chip ' + cls + '">' + text + '</span></div>'
      + (detail ? '<div class="fmsg' + (v.state === 'failed' ? ' err' : '') + '">' + esc(detail) + '</div>' : '')
      + (action ? '<div class="factions">' + action + '</div>' : '')
      + '</div>';
  }).join('');
}

$('autoList').onclick = (e) => {
  const btn = e.target.closest('button[data-manual]');
  if (btn) goManual(btn.dataset.manual);
};

/** One-click hand-off: Tab 1 gave up on a file, so open Tab 2 with that file's row highlighted. */
function goManual(key) {
  setTab('manual');
  renderManual();
  const row = $('manualList').querySelector('[data-key="' + key + '"]');
  if (!row) return;
  openSteps.add(key);
  const details = row.querySelector('details');
  if (details) details.open = true;
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 2600);
}

function renderManual() {
  const list = $('manualList');
  if (!viewIso) { list.innerHTML = '<p class="hint">' + esc(status.error || 'Pick the dates above.') + '</p>'; return; }
  $('manualDate').textContent = dmy(viewIso);
  list.innerHTML = files.map((def) => {
    const day = status.dates.find((d) => d.iso === viewIso);
    const f = day && day.files.find((x) => x.key === def.key);
    const refused = (rowErrors[viewIso] || {})[def.key];
    let chip = '<span class="chip pending">Not provided</span>';
    let msg = '';
    if (f && f.state === 'valid') { chip = '<span class="chip done">✓ Valid</span>'; msg = f.rows + ' rows — saved as ' + baseName(f.path); }
    else if (f && f.state === 'invalid') { chip = '<span class="chip failed">✗ Invalid</span>'; msg = f.error; }
    if (refused) { chip = '<span class="chip failed">✗ Rejected</span>'; msg = refused; }
    const bad = (f && f.state === 'invalid') || refused;
    return '<div class="filerow" data-key="' + def.key + '">'
      + '<div class="fhead"><span class="fname">' + esc(def.label) + '</span>' + chip + '</div>'
      + (msg ? '<div class="fmsg' + (bad ? ' err' : '') + '">' + esc(msg) + '</div>' : '')
      + '<details' + (openSteps.has(def.key) ? ' open' : '') + '><summary>How to get this file</summary><ol>'
      + def.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol></details>'
      + '<div class="factions">'
      + '<button class="ghost small" data-act="open">Open HIS</button>'
      + '<button class="small" data-act="select">Select file…</button>'
      + '<span class="drophint">or drop it here</span>'
      + '</div></div>';
  }).join('');
}

function baseName(p) { return String(p || '').split(/[\\\\/]/).pop(); }

$('manualList').addEventListener('toggle', (e) => {
  const row = e.target.closest && e.target.closest('[data-key]');
  if (!row) return;
  if (e.target.open) openSteps.add(row.dataset.key); else openSteps.delete(row.dataset.key);
}, true);

$('manualList').onclick = (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const key = btn.closest('[data-key]').dataset.key;
  if (btn.dataset.act === 'open') openHis();
  else selectFileFor(key);
};

/* Drag a file onto a row. The page cannot see a dropped file's path, so its bytes are sent. */
['dragenter', 'dragover'].forEach((type) => $('manualList').addEventListener(type, (e) => {
  const row = e.target.closest && e.target.closest('.filerow');
  if (!row) return;
  e.preventDefault();
  row.classList.add('drag');
}));
$('manualList').addEventListener('dragleave', (e) => {
  const row = e.target.closest && e.target.closest('.filerow');
  if (row && !row.contains(e.relatedTarget)) row.classList.remove('drag');
});
$('manualList').addEventListener('drop', (e) => {
  const row = e.target.closest && e.target.closest('.filerow');
  if (!row) return;
  e.preventDefault();
  row.classList.remove('drag');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) dropFileFor(row.dataset.key, file);
});
// A file dropped anywhere else must not navigate the window away to it.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function setRowError(key, message) {
  rowErrors[viewIso] = rowErrors[viewIso] || {};
  if (message) rowErrors[viewIso][key] = message; else delete rowErrors[viewIso][key];
}

function manualPrecheck() {
  if (!$('archiveRoot').value.trim()) { setStatus('Choose the Input Output Files folder first.', 'err'); return false; }
  if (!viewIso) { setStatus(status.error || 'Pick the dates first.', 'err'); return false; }
  return true;
}

async function afterManualAttempt(key, ok, message) {
  setRowError(key, ok ? '' : message);
  setStatus(ok ? '✓ ' + fileDef(key).label + ' saved for ' + dmy(viewIso) + '.' : '✗ ' + message, ok ? 'ok' : 'err');
  await loadStatus();
}

async function selectFileFor(key) {
  if (!manualPrecheck()) return;
  try {
    const picked = await api('/api/pick-file', { title: 'Select the ' + fileDef(key).label + ' file' });
    if (!picked.path) return;
    await api('/api/files/accept', { archiveRoot: $('archiveRoot').value.trim(), date: viewIso, key, path: picked.path });
    await afterManualAttempt(key, true);
  } catch (err) {
    await afterManualAttempt(key, false, err.message);
  }
}

async function dropFileFor(key, file) {
  if (!manualPrecheck()) return;
  const q = new URLSearchParams({
    token: TOKEN, archiveRoot: $('archiveRoot').value.trim(), date: viewIso, key, name: file.name,
  });
  try {
    const res = await fetch('/api/files/drop?' + q.toString(), {
      method: 'POST',
      headers: { 'x-app-token': TOKEN, 'content-type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({ error: 'Bad response from the app' }));
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    await afterManualAttempt(key, true);
  } catch (err) {
    await afterManualAttempt(key, false, err.message);
  }
}

async function openHis() {
  try { await api('/api/his/open', {}); }
  catch (err) { setStatus('✗ Could not open the HIS: ' + err.message, 'err'); }
}

/* ---------- status bar + Proceed ---------- */
function renderReadyBar() {
  const bar = $('readyBar');
  if (status.error) { bar.innerHTML = '<div class="rb-note">' + esc(status.error) + '</div>'; return; }
  let ready = 0;
  const lines = status.dates.map((d) => {
    const minis = d.files.map((f) => {
      if (f.state === 'valid') ready += 1;
      const cls = f.state === 'valid' ? 'ok' : f.state === 'invalid' ? 'bad' : 'miss';
      const mark = f.state === 'valid' ? '✓ ' : f.state === 'invalid' ? '✗ ' : '';
      return '<span class="mini ' + cls + '" title="' + esc(fileDef(f.key) ? fileDef(f.key).label : f.key) + '">' + mark + f.key + '</span>';
    }).join('');
    return '<div class="rb-day' + (d.iso === viewIso ? ' sel' : '') + '" data-iso="' + d.iso + '"><span>' + d.dmy + '</span>' + minis + '</div>';
  });
  const total = status.dates.length * files.length;
  bar.innerHTML = lines.join('')
    + '<div class="rb-note' + (status.allReady ? ' ok' : '') + '">'
    + (status.allReady ? '✓ All ' + total + ' files are ready.' : ready + ' of ' + total + ' files ready — Proceed unlocks when every file is valid.')
    + '</div>';
}
$('readyBar').onclick = (e) => {
  const day = e.target.closest('.rb-day');
  if (day) { viewIso = day.dataset.iso; renderAll(); }
};

$('proceedBtn').onclick = async () => {
  const payload = form.read();
  if (!payload.archiveRoot) { setStatus('Choose the Input Output Files folder first.', 'err'); return; }
  form.save();
  setBusy(true);
  setStatus('Running…');
  try {
    // The result also arrives over the event stream; this catches the case
    // where the request itself is rejected before a run ever starts.
    await api('/api/proceed', { archiveRoot: payload.archiveRoot, ...range(), dryRun: payload.dryRun });
  } catch (err) {
    setBusy(false);
    setStatus(err.message, 'err');
    refreshStatus();
  }
};

/* ---------- Run Extraction (Tab 1) ---------- */
$('runExtractBtn').onclick = async () => {
  const archiveRoot = $('archiveRoot').value.trim();
  if (!archiveRoot) { setStatus('Choose the Input Output Files folder first.', 'err'); return; }
  const problem = rangeError();
  if (problem) { setStatus(problem, 'err'); return; }
  form.save();
  progress = {};
  extracting = true;
  applyState();
  renderAll();
  setStatus('Extracting…');
  try {
    // Progress and the outcome arrive as events (see connect()); this only
    // catches a request that never started.
    await api('/api/extract', { archiveRoot, ...range() });
  } catch (err) {
    extracting = false;
    applyState();
    setStatus('✗ ' + err.message, 'err');
    await syncSignedInFields();
  }
};

/* ---------- live event stream ---------- */
function connect() {
  const es = new EventSource('/api/events?token=' + TOKEN);
  es.onopen = () => { $('connBadge').textContent = 'live'; $('connBadge').className = 'badge live'; };
  es.onerror = () => { $('connBadge').textContent = 'reconnecting…'; $('connBadge').className = 'badge off'; };
  es.addEventListener('log', (e) => appendLine(JSON.parse(e.data)));

  es.addEventListener('session-ended', () => {
    showLoginFields();
    // Mid-extraction, extract-end reports it itself.
    if (!extracting) setLoginStatus('The Amrita HIS Edge window was closed — sign in again to use automatic extraction.', 'err');
  });

  es.addEventListener('extract-start', () => {
    extracting = true;
    progress = {};
    applyState();
    renderAll();
  });
  es.addEventListener('file-progress', (e) => {
    const d = JSON.parse(e.data);
    progress[d.date] = progress[d.date] || {};
    progress[d.date][d.key] = d;
    if (d.state === 'done') refreshStatus();
    renderAuto();
  });
  es.addEventListener('extract-end', async (e) => {
    const r = JSON.parse(e.data);
    extracting = false;
    await loadStatus();
    if (r.sessionLost) {
      showLoginFields();
      setLoginStatus('✗ The Amrita HIS session ended — sign in again to continue. Files already saved are kept.', 'err');
      setStatus('The Amrita HIS session ended during extraction. Sign in again, or use the Manual tab.', 'err');
    } else if (r.ok) {
      setStatus('✓ Extraction finished — ' + r.done + ' file' + (r.done === 1 ? '' : 's') + ' saved.', 'ok');
    } else {
      setStatus(r.failed + ' file' + (r.failed === 1 ? '' : 's') + ' failed. Use "Switch to manual for this file", or run extraction again.', 'err');
    }
    applyState();
  });

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
    refreshStatus();
  });
}

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
    + ' (' + (cols || 'no') + ' columns), ' + r.write.totalRows + ' date row(s) in the master.'
    + (r.daysProcessed > 1 ? ' ' + r.daysProcessed + ' days processed; showing the last.' : ''),
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
      const l = await api('/api/resolve', { archiveRoot: root, reportDate: $('dateFrom').value || undefined });
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
$('pickRoot').onclick = async () => {
  try {
    const r = await api('/api/pick-folder', { title: 'Select the Input Output Files folder', initial: $('archiveRoot').value.trim() });
    if (!r.path) return;
    $('archiveRoot').value = r.path;
    form.save();
    refreshPaths();
    refreshStatus();
  } catch (err) { setStatus(err.message, 'err'); }
};

$('openMaster').onclick = async () => {
  try { await api('/api/open', { path: lastMaster }); } catch (err) { setStatus(err.message, 'err'); }
};
$('showMaster').onclick = async () => {
  try { await api('/api/reveal', { path: lastMaster }); } catch (err) { setStatus(err.message, 'err'); }
};

$('archiveRoot').oninput = () => { form.save(); refreshPaths(); refreshStatus(); };

/* ---------- settings (HIS address, retries; the rest lives in the settings file) ---------- */
function closeSettings() { $('settingsModal').hidden = true; }
$('settingsBtn').onclick = () => {
  $('setHisUrl').value = hisConfig.hisUrl;
  $('setRetries').value = String(hisConfig.retries);
  $('settingsMsg').textContent = '';
  $('settingsModal').hidden = false;
};
$('settingsCancel').onclick = closeSettings;
$('settingsFile').onclick = async () => {
  try { await api('/api/config/reveal', {}); }
  catch (err) { $('settingsMsg').textContent = '✗ ' + err.message; }
};
$('settingsSave').onclick = async () => {
  try {
    const r = await api('/api/config', { hisUrl: $('setHisUrl').value.trim(), retries: Number($('setRetries').value) });
    hisConfig = r.config;
    closeSettings();
    applyState();
    setStatus('Settings saved.', 'ok');
  } catch (err) {
    $('settingsMsg').textContent = '✗ ' + err.message;
  }
};

/* ---------- boot ---------- */
(async () => {
  connect();
  clearLoginFields();
  try {
    const s = await api('/api/status');
    files = s.files;
    savedLogin = s.savedLogin;
    hisConfig = s.config;
    defaultDates = s.defaults;
    $('dateFrom').value = s.defaults.from;
    $('dateTo').value = s.defaults.to;

    form.apply(s.settings);
    prefillUsername(s.settings.username || savedLogin.username);
    $('headless').checked = s.settings.headless === '1';
    updateLoginUi();

    // A window reload while a sign-in was already open should still show that
    // session rather than a blank login form — the browser is still open on the
    // server side.
    if (s.signedIn && s.signedInUsername) {
      setLoginStatus('✓ Logged in to Amrita HIS — verified', 'ok');
      showRunFields(s.signedInUsername);
      unlockDashboard();
      $('manualModeBtn').hidden = true;
    }
    setTab(s.signedIn ? (s.settings.tab || 'auto') : 'manual', false);

    const b = $('scraperBadge');
    if (s.scraper.available) { b.textContent = 'portal pull: ready'; b.className = 'badge live'; }
    else {
      b.textContent = 'portal pull: unavailable'; b.className = 'badge off';
      $('signInBtn').disabled = true;
      $('loginHint').textContent = 'Puppeteer is not part of this build — use the Manual tab with files downloaded by hand.';
      // No Amrita HIS to sign in to in this build — the manual half must stay
      // fully usable on its own, so there is nothing to gate here.
      unlockDashboard();
      $('manualModeBtn').hidden = true;
      setTab('manual', false);
    }
    appendMeta('Pharmacy MIS ' + s.version + ' — Node ' + s.node);
    appendMeta('Today ' + s.todayDisplay + ' — processing reports for ' + s.reportDateDisplay);
    appendMeta(s.scraper.available
      ? 'Portal pull available.'
      : 'Portal pull (Puppeteer) is not part of this build — use the Manual tab.');
  } catch (err) {
    // The footer this normally goes to is inside the Dashboard, which is
    // exactly what is hidden at this point — so this has to reach the user
    // through the login card instead, or it would be invisible.
    setStatus('Could not reach the app backend: ' + err.message, 'err');
    setLoginStatus('✗ Could not reach the app backend: ' + err.message, 'err');
  }
  applyState();
  refreshPaths();
  refreshStatus();
})();
</script>
</body>
</html>`;
}

module.exports = { page };
