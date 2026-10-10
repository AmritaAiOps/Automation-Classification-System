# Pharmacy MIS — Daily Purchase & Inventory Report

Sudhamayi Enterprise Pvt. Ltd. — Pharmacy Purchase & Inventory Automation

Reads the three daily source reports, applies the column rules from
`Daily_Report_Field_Mapping.docx`, and appends one row per date to the month's
master report. The web page shows every stage as it happens: which file was
identified as what, which rows each filter dropped and why, and exactly which
cells changed in the master.

It runs as a web app on one PC or server (Node.js 20+, Microsoft Edge for the
portal pull). Staff open it in a browser.

## Project status

| Half | Status |
| --- | --- |
| **1 · Portal pull (Puppeteer, driving Microsoft Edge)** | **done** |
| **2 · Field mapping → master report** | **done** |

The pharmacy portal is reachable only from the admin machine, so half 1 can
only be exercised there. It runs Microsoft Edge, headful and maximized, so the
operator watches the run happen live rather than trusting a text log alone; any
failure aborts the run immediately, saves a screenshot of the failing page to
`%LOCALAPPDATA%\PharmacyMIS\screenshots\`, and does not fall through to the
mapping stage. It is loaded defensively and lazily: if Puppeteer is missing or
broken, the customer's application still starts and the mapping half works
exactly as before. `pullFromPortal()` in
[src/scraper/index.js](src/scraper/index.js) is the entry point, on the admin
machine.

Three portal behaviours worth knowing if this file is touched again, each
confirmed against a live run and each easy to reintroduce by "simplifying" the
code that guards against it:

- **An empty-report alert can arrive before Puppeteer can attach to the tab
  showing it.** The portal answers some runs with a plain `alert()` on the
  report tab it opens for itself, and a renderer blocked on an unhandled alert
  cannot be attached to afterwards — `Page.enable` simply hangs on it. Dialog
  capture is armed while every new tab is still paused at
  `waitForDebuggerOnStart`, via `captureDialogsEverywhere()`, not after the
  fact.
- **Selecting every option in the Purchase Tax Scheme list has to be a real
  mouse click, not `option.selected = true`.** The form is a SpagoBI/ExtJS
  widget over the actual `<select>`, and it submits from its own recorded
  selection, not from the element. Assigning `.selected` leaves the DOM reading
  "52/52 selected" while the request on the wire still carries one scheme —
  confirmed by capturing the actual `PurchaseTaxScheme` parameter sent to the
  server, and it is why every field audit until this was found kept certifying
  a real day's data as a genuine zero. `selectAllByRealClicks()` in
  [src/scraper/index.js](src/scraper/index.js) clicks the first option and
  Shift-clicks the last, and verifies the DOM afterwards rather than trusting
  that the click landed.
- **That click has to happen before any combo box's dropdown is opened.**
  `selectDropdownValue()` (used for GRN Type / GRN Status) leaves its dropdown
  list open over the form, and the first of the two clicks the tax-scheme
  selection needs is spent closing that overlay instead of anchoring the
  range — again invisible in the DOM afterwards. `runGrnReport()` selects
  the tax schemes first for this reason, and `selectAllByRealClicks()` also
  presses Escape before it starts, so the order does not have to be perfect
  every time it is called.

`tools/check-alert-capture.js` (`npm run check-alert-capture`) is a regression
check for the first of these against a local page, not the real portal, so it
runs without portal access.

## Running it

Set these, then start the server (PowerShell):

```powershell
$env:APP_PASSWORD = "choose-a-password"          # required
$env:ARCHIVE_ROOT = "D:\Pharmacy-MIS-Archive"     # required; a folder on the server
$env:APP_USER = "admin"                          # optional, default admin
$env:PORT = "8080"                               # optional, default 8080
npm install
npm run web
```

- Browsers sign in with HTTP Basic Auth (APP_USER / APP_PASSWORD). That is only safe
  over HTTPS, so for access from outside the LAN put it behind a Cloudflare Tunnel
  (`cloudflared tunnel --url http://localhost:8080`).
- Same network: open `http://<server-ip>:8080` and allow the port in Windows Firewall.
- Always on: a Task Scheduler task "At startup" running `node src/web.js` with the variables above.
- The portal pull runs Edge headless. If the portal rejects that, set
  `PHARMACY_MIS_HEADFUL=1` to get a visible window on the server.
- One run at a time and one portal sign-in, shared by everyone using the site.

The page opens on the Amrita HIS sign-in screen, with **Reports to process** at the top
of that card: a date field, pre-filled with yesterday but editable to any date. It is
the one date control on the page, and both ways on from here read it.

- **Sign In**, then **Run**: Puppeteer signs in, pulls the reports for that date and
  maps them in one go.
- **Continue without signing in (manual run)**: for reports already exported by hand.
  Upload the three files (PRQ, PO, GRN); nothing is fetched, and the master row written
  is exactly the same.

Either way, the results are written under `ARCHIVE_ROOT` on the server, and the
**Download master** button fetches the month's workbook. Tick *Preview only* to see
every figure and every intended cell change without writing anything.

The **Reports to process** date always wins over whatever the uploaded file names look
like they are for, but a mismatch is not silent: the log names both dates and says
which one the run used. If no date is set at all, it falls back to a date in the file names.

### Command line

The same pipeline without a browser, for Task Scheduler:

```
npm run cli -- --root D:\Pharmacy-MIS-Archive --inputs D:\...\inputs\2026-08-08
npm run cli -- --root D:\Pharmacy-MIS-Archive --date 2026-08-08 --dry-run
npm run cli -- --root D:\Pharmacy-MIS-Archive --username <user>   # password in PHARMACY_MIS_PASSWORD
npm run cli -- --help
```

It exits non-zero on failure, so a scheduled task reports a problem rather than
silently succeeding. Every run is appended to the application log either way.

## The column rules

Straight from the field-mapping document. Each rule lives in its own module and
logs what it did.

### PRQ → columns C, D — [src/mapping/prq.js](src/mapping/prq.js)

| Column | Source | Rule |
| --- | --- | --- |
| C — Total no. of PRQ | PRQ No. | distinct, excluding any starting `AUTO` |
| D — PRQ Itemwise | Item Name | distinct drug names on the same non-AUTO rows |

`AUTO/P/26/540` is system-generated and dropped from both. `P/AMPU/26/3864` counts.

### Purchase Order → columns E, F, G — [src/mapping/po.js](src/mapping/po.js)

Two filters, in order: drop rows whose **PRQ No.** starts `AUTO`, then drop rows
whose **PO No.** ends in a letter suffix (a split/amended PO).

| Column | Source | Rule |
| --- | --- | --- |
| E — PO Created | PO No. | distinct, on the twice-filtered rows |
| F — PO Items | Item Name | distinct drug names, same rows as E |
| G — Total PO Value | Grand Total | taken as printed from the totals row |

`SE/PH/2026-27/3910-A` ends in `-A` and is excluded from E. `SE/PH/2026-27/3919` counts.

G is deliberately **not** a sum of the filtered rows — the document says to take
the figure as printed, which covers the whole sheet.

### GRN → columns H, I, J — [src/mapping/grn.js](src/mapping/grn.js)

| Column | Source | Rule |
| --- | --- | --- |
| H — Total no. of GRN | PO No. | distinct |
| I — GRN Itemwise | Drug Description | distinct drug names |
| J — Total GRN Value | Grand Total | taken as printed from the totals row |

No AUTO or suffix filtering — the GRN section applies neither rule.

> **One thing to confirm with the business.** Column H is labelled *Total no.
> of GRN* but is counted off **PO No.**, not **GRN No.** On the reference day
> those differ — 80 distinct PO numbers against 83 distinct GRN numbers,
> because one purchase order can be received in more than one goods receipt —
> and the figure the mapping document gives for H is **80**. The code therefore
> matches the specified figure, and both numbers are pinned in `npm test` so
> the difference cannot be closed by accident. If the intended meaning is
> really "distinct GRN numbers", H should be 83 and the expected figures need
> updating first.

Column K (Pending GRN) and L–Q are outside this automation. They are read but
never written, so anything entered there by hand survives every run.

## How files are identified

By **column layout, not filename**. The portal exports
`Pharmacy PRQ Details(1).CSV`, users rename files, and the Puppeteer half will
name its downloads differently again — so each file is matched against the set
of headers it actually carries ([src/core/detect.js](src/core/detect.js)). The
filename only breaks a tie between two equally good matches.

Consequences worth knowing, all covered by `npm run release-test`:

- renamed files are still placed correctly
- a file put in the wrong slot in *Pick files* mode still lands in the right one
- extra files in the folder are reported and skipped, not guessed at
- a duplicated export loses to the better-matching copy, and the log says so
- an empty, malformed or non-spreadsheet file is refused with a readable message
- a missing PRQ, PO or GRN leaves that section's columns untouched rather than
  zeroing them, and the run still succeeds

## Output

```
<archive root>/
└── Pharmacy-MIS/
    └── 2026/
        └── 08-August/
            ├── inputs/
            │   └── 2026-08-08/          raw pulls, never edited in place
            └── outputs/
                └── Master_Report_August_2026.xlsx
```

The archive root is the server's `ARCHIVE_ROOT` folder. Missing folders are created
automatically.

- One row per date, appended in order, `S.No` renumbered on every save.
- Re-running a date **updates that row in place** rather than adding a duplicate
  — including a blank row already sitting there for an upcoming day.
- A new month creates a new master, starting at the first data row, seeded from
  the reference format (title band, headers, widths, borders, merged cells and
  number formats all preserved).
- Written to a temp file and renamed over the target, so an interrupted run
  cannot leave a half-written master. If the file is open in Excel, the app says
  so plainly instead of failing obscurely.

## Where the application keeps its own files

```
%LOCALAPPDATA%\PharmacyMIS\
├── logs\pharmacy-mis-YYYY-MM-DD.log          one per day, pruned after 30 days
├── screenshots\failure_<step>_<time>.png     portal failures, pruned after 30 days
└── credentials.json                            the remembered username, never a password
```

Failures, including the stage-by-stage log of a failed run, are written to the day's
log file. Run results and the master workbooks live under `ARCHIVE_ROOT`.

## Layout

```
src/
  web.js               entry point: the HTTP server (npm run web)
  app/headless.js      the command line (npm run cli)
  pipeline.js          the five stages of a run, logged as they happen
  portalRun.js         one date, or a range, pulled from the portal and mapped
  core/
    appdata.js         the writable locations, and the application log
    logger.js          the log every stage writes to; the page's live feed
    credentials.js     the remembered username
    portalSession.js   the one signed-in portal session
    csv.js             RFC-4180 reader (quoted newlines, Indian-grouped amounts)
    sheet.js           CSV + XLSX reduced to one common shape
    detect.js          identify a file by its column layout
    paths.js           the monthly folder convention
  mapping/
    rules.js           shared predicates: isAutoPrq, hasLetterSuffix, parseAmount
    prq.js po.js grn.js   one module per section
  excel/
    master.js          read/append/update the master report
    template.js        GENERATED: the reference format, baked in as base64
  scraper/
    index.js           half 1: Puppeteer driving Microsoft Edge
  ui/
    server.js          HTTP server: Basic Auth, JSON API, log streamed over SSE, download
    page.js            the whole UI, one self-contained page, no external assets
tools/
  gen-template.js          re-bakes the reference format into src/excel/template.js
  selftest.js              checks against the real reference files
  check-alert-capture.js   regression check for the empty-report alert race
                           against a local page; see Project status above
```

## Development

```
npm install
npm run web                   # run the server from source
npm test                      # checks against ../reference
npm run check-alert-capture   # regression check for the empty-report alert race (launches a real browser)
```

`npm test` runs the real files in `../reference` through the whole pipeline and
asserts the eight figures, the identification (including after renaming), the
preserved formatting, append-vs-update, month rollover, dry run, the download
path guard, and the error paths.

If the master's reference format changes, drop the new workbook into
`../reference/` and run `node tools/gen-template.js` to re-bake the template.

## Known limitations

- **The portal pull needs Microsoft Edge on the machine that runs the server**, and
  that machine must be able to reach the Amrita HIS portal.
- **Headless Edge is untried against the live portal.** Set `PHARMACY_MIS_HEADFUL=1` if
  the portal rejects it.
- **One user at a time.** One run lock and one portal sign-in are shared by every
  browser session.
