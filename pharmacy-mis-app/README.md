# Pharmacy MIS — Daily Purchase & Inventory Report

Sudhamayi Enterprise Pvt. Ltd. — Pharmacy Purchase & Inventory Automation

Reads the three daily source reports, applies the column rules from
`Daily_Report_Field_Mapping.docx`, and appends one row per date to the month's
master report. The window shows every stage as it happens — which file was
identified as what, which rows each filter dropped and why, and exactly which
cells changed in the master.

## Project status

The project has two halves:

| Half | Status |
| --- | --- |
| **1 · Portal pull (Puppeteer)** | interface + wiring done, body stubbed — see below |
| **2 · Field mapping → master report** | **done** |

The pharmacy portal is reachable only from the admin machine, so half 1 cannot
be developed or run on a personal computer. It is not bolted on later: the app
already calls it at the front of a run, streams its log into the same window,
and drops files where the mapping half looks for them. On the admin machine,
only the body of `pullFromPortal()` in [src/scraper/index.js](src/scraper/index.js)
has to be filled in — nothing above or around it changes.

## Running it

Double-click **`dist/Pharmacy-MIS.exe`**. One file, no installer, no runtime to
install; it starts in about 0.2 s.

1. **Archive root** — the folder that holds (or will hold) `Pharmacy-MIS/`
2. **Report date** — or let it be read from the inputs folder name
3. **Source files** — either a dated inputs folder, or the three files picked
   individually. Both work, and can be mixed.
4. **Run daily report** — tick *Preview only* to see every figure and every
   intended cell change without writing anything.

### Headless

The same binary runs without a window, for Task Scheduler once the portal pull
is in place:

```
Pharmacy-MIS.exe --cli --root C:\Pharmacy-Archive --inputs C:\...\inputs\2026-08-08
Pharmacy-MIS.exe --cli --root C:\Pharmacy-Archive --date 2026-08-08 --dry-run
Pharmacy-MIS.exe --cli --help
```

Exits non-zero on failure, so a scheduled task reports a problem instead of
silently succeeding.

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

Column K (Pending GRN) and L–Q are outside this automation. They are read but
never written, so anything entered there by hand survives every run.

## How files are identified

By **column layout, not filename**. The portal exports
`Pharmacy PRQ Details(1).CSV`, users rename files, and the Puppeteer half will
name its downloads differently again — so each file is matched against the set
of headers it actually carries ([src/core/detect.js](src/core/detect.js)). The
filename only breaks a tie between two equally good matches.

A consequence worth knowing: putting a file in the wrong slot in *Pick files*
mode still produces the right answer, and the log says so.

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

- One row per date, appended in order, `S.No` renumbered on every save.
- Re-running a date **updates that row in place** rather than adding a duplicate
  — including a blank row already sitting there for an upcoming day.
- A new month creates a new master, starting at row 1, seeded from the reference
  format (title band, headers, widths, borders, number formats all preserved).
- Written to a temp file and renamed over the target, so an interrupted run
  cannot leave a half-written master. If the file is open in Excel, the app says
  so plainly instead of failing obscurely.

## Layout

```
src/
  main.js              starts the server, opens the app window
  cli.js               headless entry (--cli)
  pipeline.js          the five stages of a run, logged as they happen
  core/
    logger.js          the log every stage writes to; the window's live feed
    csv.js             RFC-4180 reader (quoted newlines, Indian-grouped amounts)
    sheet.js           CSV + XLSX reduced to one common shape
    detect.js          identify a file by its column layout
    paths.js           the monthly folder convention
  mapping/
    rules.js           shared predicates: isAutoPrq, hasLetterSuffix, parseAmount
    prq.js po.js grn.js   one module per section
  excel/
    master.js          read/append/update the master report
    template.js        GENERATED — the reference format, baked in as base64
  scraper/
    index.js           half 1: interface done, body stubbed
  ui/
    server.js          127.0.0.1 + token, log streamed over SSE
    page.js            the whole UI, one self-contained page
    dialogs.js         native Windows file/folder pickers
tools/
  build.js             bundle -> SEA blob -> exe
  gen-template.js      re-bake the reference format
  selftest.js          77 checks against the real reference files
```

## Development

```
npm install
npm start        # open the app window
npm test         # 77 checks against ../reference
npm run build    # dist/Pharmacy-MIS.exe  (~35 s)
```

`npm test` runs the real files in `../reference` through the whole pipeline and
asserts the eight figures, the identification (including after renaming), the
preserved formatting, append-vs-update, month rollover, dry run, and the error
paths. Expected figures for the reference set:

```
C=21  D=29  E=26  F=31  G=1674801.30  H=80  I=169  J=2656763.31
```

If the master's reference format changes, drop the new workbook into
`../reference/` and run `npm run build` — step 1 re-bakes the template.

## How the exe is built

`esbuild` bundles the app and `exceljs` into one file, `--experimental-sea-config`
turns that into a SEA blob, `rcedit` rewrites the runtime's Windows identity
(so it shows as "Pharmacy MIS" rather than "Node.js" in Explorer/Task Manager),
and `postject` injects the blob into that branded copy of `node.exe`. rcedit has
to run *before* postject — doing it after leaves the two tools fighting over the
same PE section and the injection call hangs.

The window is the machine's own Edge/WebView2 in `--app` mode, so no browser
engine is bundled. That is what keeps this a single ~88 MB file that starts in
~0.2 s and builds in ~45 s, rather than an Electron install of several hundred
megabytes. Windows 11 ships WebView2 and Edge, so there is nothing to install;
if neither Edge nor Chrome is found, the app falls back to the default browser.

The `postject` step prints `warning: The signature seems corrupted!` — expected,
because injecting a section invalidates `node.exe`'s Authenticode signature (the
official Node build ships one, verified against the OpenJS Foundation; the
shipped exe is unsigned). This is a real distribution consideration, not just a
build warning — see [Distributing to another machine](#distributing-to-another-machine).

### The window is a console-subsystem app — and the exe hides its console itself

`node.exe`, and therefore this exe, is a Windows *console-subsystem* binary
(confirmed via its PE header: Subsystem = 3 / IMAGE_SUBSYSTEM_WINDOWS_CUI).
That is what lets `--cli` print output to a terminal or a scheduled task. The
cost is that Windows allocates a visible black console window on every launch
that has no parent console of its own — which is exactly what a double-click
from Explorer is.

`src/main.js` handles this itself: on a normal (non-`--cli`) launch it
re-spawns itself with `windowsHide: true` (which passes `CREATE_NO_WINDOW` to
Windows, so no console is created at all) and the original, visible-console
process exits immediately. `--cli` never takes this path, so a terminal or Task
Scheduler run is unaffected. Verified by launching the exe with no parent
console and confirming no new `conhost.exe` process appears while the app still
starts its server and opens its window normally.

## Distributing to another machine

The exe is fully self-contained — confirmed by running it from a bare folder
with nothing else in it and a `PATH` stripped down to just `System32`, i.e. no
Node, npm, or anything else this project's dev environment provides. Both the
GUI launch and `--cli` work identically in that isolation. Its only runtime
dependencies, checked via the exe's actual PE import table, are core Windows
DLLs present on every Windows 10/11 install (`KERNEL32`, `USER32`, `SHELL32`,
`ADVAPI32`, `WS2_32`, `CRYPT32`, `ole32`, `USERENV`, `WINMM`, `IPHLPAPI`,
`dbghelp`) — no Visual C++ Redistributable, because the official Node.js
Windows build statically links its CRT. Its only *soft* dependency is Edge or
Chrome for the app window, which falls back to the default browser if absent.
There is no true Windows VM on this dev machine (Windows 11 Home has neither
Windows Sandbox nor Hyper-V) — this isolation test, plus the PE-level DLL audit
above, is the strongest verification available without one; it does not cover
ARM64 Windows, ancient/unpatched Windows 10, or a machine with AppLocker/WDAC
policies that block unsigned executables outright.

**Files needed on the other machine:** just `Pharmacy-MIS.exe`. Nothing else —
no `reference/` folder, no `node_modules`, no installer.

**Send it, then have the recipient run, before double-clicking:**
```powershell
Unblock-File .\Pharmacy-MIS.exe      # lifts the "downloaded from the internet" flag
Get-FileHash .\Pharmacy-MIS.exe      # compare against the .sha256 file `npm run build` writes
```
The exe is unsigned (see above), so Windows SmartScreen will still show
"Windows protected your PC" on first run regardless — click **More info** →
**Run anyway**. That is a one-time prompt from Windows about the file's
publisher, not a sign that anything is missing or broken.

## Dependencies

One at runtime: `exceljs`, for reading and writing `.xlsx` with formatting
intact — audited down through its full transitive dependency tree (`archiver`,
`dayjs`, `fast-csv`, `jszip`, `readable-stream`, `saxes`, `tmp`, `unzipper`,
`uuid`): no native `.node` binaries anywhere in it, nothing spawns an external
process, and nothing reads an asset relative to its own install location (which
would have broken once bundled) — the only `fs` reads in the whole tree are of
the xlsx file paths this app passes in itself. `npm audit` flags a moderate
advisory against the `uuid` version `exceljs` pins; it is not reachable from
anything this app does — no untrusted input goes near it — but it is worth
re-checking when exceljs next updates.
