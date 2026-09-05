# Pharmacy MIS — Daily Purchase & Inventory Report

Sudhamayi Enterprise Pvt. Ltd. — Pharmacy Purchase & Inventory Automation

Reads the three daily source reports, applies the column rules from
`Daily_Report_Field_Mapping.docx`, and appends one row per date to the month's
master report. The window shows every stage as it happens — which file was
identified as what, which rows each filter dropped and why, and exactly which
cells changed in the master.

## What the customer receives

One file, 90 MB:

```
Pharmacy-MIS.exe
```

Optionally `Pharmacy-MIS.exe.sha256` beside it, to confirm the copy arrived
intact. That file is **not** needed to run the application.

Nothing else is required on their machine — no Node.js, no npm, no Python, no
`node_modules`, no source, no `reference/` folder, no template workbook, no
browser, no WebView2, no Visual C++ redistributable, and no internet
connection. The application carries its own browser engine, its own JavaScript
runtime and its own copy of the report template inside the exe.

## Project status

| Half | Status |
| --- | --- |
| **1 · Portal pull (Puppeteer)** | interface + wiring done, body stubbed — admin machine only |
| **2 · Field mapping → master report** | **done** |

The pharmacy portal is reachable only from the admin machine, so half 1 cannot
be developed or run elsewhere. It is loaded defensively and lazily: if it is
absent or broken, the customer's application still starts and the mapping half
works exactly as before. Only the body of `pullFromPortal()` in
[src/scraper/index.js](src/scraper/index.js) needs filling in on the admin
machine.

## Running it

Double-click **`Pharmacy-MIS.exe`**.

The first launch unpacks the application into `%LOCALAPPDATA%\PharmacyMIS\` and
takes a few seconds. Every launch after that is immediate.

1. **Archive root** — the folder that holds (or will hold) `Pharmacy-MIS/`
2. **Report date** — or let it be read from the inputs folder name
3. **Source files** — either a dated inputs folder, or the three files picked
   individually. Both work, and can be mixed.
4. **Run daily report** — tick *Preview only* to see every figure and every
   intended cell change without writing anything.

### Headless

The same exe runs without a window, for Task Scheduler once the portal pull is
in place:

```
Pharmacy-MIS.exe --cli --root C:\Pharmacy-Archive --inputs C:\...\inputs\2026-08-08
Pharmacy-MIS.exe --cli --root C:\Pharmacy-Archive --date 2026-08-08 --dry-run
Pharmacy-MIS.exe --cli --self-test --inputs <folder> --out result.json
Pharmacy-MIS.exe --cli --help
```

It exits non-zero on failure, so a scheduled task reports a problem rather than
silently succeeding.

**One thing to know about output.** The exe is a Windows *GUI-subsystem* binary
— that is what stops a black console window appearing when the customer
double-clicks it. Windows gives such a binary no console of its own, so when it
is started from an interactive Command Prompt its printed output goes nowhere.
Writing to a *pipe* works normally, so anything that spawns it (Task Scheduler
with output redirected, `npm run release-test`) captures everything. For a human
at a prompt, add `--out <file>` to get the result as JSON, and note that every
run is appended to the application log either way.

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

The archive root is chosen by the customer and can be anywhere they can write.
Missing folders are created automatically. Nothing is ever written beside the
exe, so it is safe to keep it in `Program Files`, on a network share or on a
USB stick.

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
├── logs\
│   └── pharmacy-mis-YYYY-MM-DD.log     one per day, pruned after 30 days
└── runtime\
    └── 1.0.0-<payload hash>\           the unpacked application
```

Nothing is written beside the exe, because the exe may be somewhere the
customer cannot write.

### When something goes wrong

Every failure is recorded **twice**: once in the technical log above, and once
in a plain-language copy the customer can actually find.

```
Documents\Pharmacy MIS\Pharmacy MIS - Error Log.txt
```

`%LOCALAPPDATA%` is the correct place for an application's logs and the wrong
place to send a pharmacy user looking — the folder is hidden, the path is long,
and "AppData" means nothing to them. The Documents copy is what a support call
should ask for: it is one file, it opens in Notepad, and it can be attached to
an email without anyone being talked through Explorer.

Each entry carries the time, what was being attempted, what went wrong in
words, the settings in use, the full stage-by-stage log of the run, and the
path to the technical log. It ends with a line telling the customer to send the
file to their IT contact.

The folder is created on the first failure and never before, so a customer who
never has a problem never gets a folder in their Documents. The file keeps one
previous generation and rolls over at 1 MB, so a repeatedly failing run cannot
fill the disk. Documents is resolved through Windows rather than assumed to be
under the user profile, because it is commonly redirected to OneDrive or a
network share.

Everything that can go wrong writes there:

| Failure | Written by |
| --- | --- |
| the exe cannot unpack or start the application | the launcher, before any of the app runs |
| the application window fails to open | `src/app/main.js` |
| an unhandled error at any point | `src/app/main.js` |
| **a report run fails** — much the commonest case | `src/ui/server.js` |
| a scheduled or command-line run fails | `src/app/headless.js` |

On top of the file, a startup failure also shows a dialog naming the stage that
failed, what to try, and where the error file is — with **Copy error details**
and **Show me the error file** buttons — rather than disappearing silently.
`npm run release-test` provokes a real failed run and checks the file appears,
says what went wrong, and tells the customer what to do with it.

## Layout

```
src/
  app/
    main.js            Electron main process: window, lifecycle, failure dialog
    headless.js        --cli / --help / --self-test
  pipeline.js          the five stages of a run, logged as they happen
  core/
    appdata.js         the writable locations, and the application log
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
    server.js          127.0.0.1 + per-launch token, log streamed over SSE
    page.js            the whole UI, one self-contained page, no external assets
    dialogs.js         native file/folder pickers
tools/
  build.js                 the one production build
  launcher/Launcher.cs     the single-file launcher the customer runs (C#)
  launcher/Pack.cs         build-time LZMS compressor (developer machine only)
  make-icon.js             generates assets/icon.ico
  gen-template.js          re-bakes the reference format into src/excel/template.js
  selftest.js              79 checks against the real reference files
  release-test.js          checks the built exe, in isolation, as a customer
  audit-dependencies.js    every DLL the exe asks Windows for, from its PE
                           import table — how "nothing to install" is checked
  check-failure-dialog.js  provokes the launcher's failure path and confirms
                           the customer actually sees a dialog
```

## Development

```
npm install
npm start           # open the app window from source
npm test            # 79 checks against ../reference
npm run build       # -> dist/Pharmacy-MIS.exe   (1-5 min, see below)
npm run release-test # checks the built exe, not the source  (~5 min)
npm run audit-deps  # lists every DLL the exe asks Windows for
npm run check-failure-dialog  # proves the launcher's error dialog appears
```

Build time is dominated by compressing the payload — LZMS takes about 90
seconds on 240 MB, and verifies itself by decompressing and comparing before
the payload is used.

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

`npm run build` is the only production command. It does eight things:

1. bakes `../reference/Daily Report for coding.xlsx` into
   `src/excel/template.js` as base64, so the exe carries the master report's
   exact formatting and no reference file is ever shipped
2. generates `assets/icon.ico` (drawn in code by `tools/make-icon.js`, so the
   icon is reproducible rather than a committed binary)
3. runs the source self-test and **refuses to build if it fails**
4. has `electron-builder --dir` assemble the Electron application
5. removes the locales and helper executables the application never loads
6. packs the whole application into one brotli-compressed payload
7. compiles the launcher with `csc.exe` (the C# compiler that ships with
   Windows) and appends the payload to it
8. verifies the result and writes `Pharmacy-MIS.exe.sha256`

### Why Electron, and why a launcher of our own

**The window.** The previous build started a local server and opened the
machine's own Edge with `--app=<url>`. That is broken in a way that only shows
up away from the developer's machine: Edge's launcher process hands the command
line to the real browser process and exits about 80 ms later (measured). The old
`main.js` watched that launcher for `exit` and treated it as "the user closed
the window", so it shut its own server down roughly a second after starting —
and the window that did appear then showed *"This site can't be reached."* It
also made the GUI depend on a browser the customer might not have. Electron
carries its own Chromium, so the window belongs to the application, its lifetime
is not something that has to be guessed at, and there is nothing to install.

**The single file.** `electron-builder`'s own `portable` target is the obvious
way to get one exe, and it was tried first. Its NSIS stub exits with code 1 on
this machine without unpacking anything, printing nothing and logging nothing —
precisely the opaque third-party failure this whole exercise exists to remove.
[tools/launcher/Launcher.cs](tools/launcher/Launcher.cs) replaces it: the whole
application, compressed and appended to the end of the launcher, unpacked into
`%LOCALAPPDATA%` on first run, keyed by version and payload hash. Every step is
ours, every failure is shown to the user in words and written to the log.

**Why the launcher is C# and about 20 KB.** The first working version of it was
a Node single executable, and it did the same job — but a copy of `node.exe` is
91 MB. That was half the release, spent on a runtime whose only work was to
decompress and spawn. Rewriting it against components Windows already has took
the release from 176 MB to about 91 MB. It uses two in-box Windows components:

| Component | Used for | Present on |
| --- | --- | --- |
| .NET Framework 4.x | the launcher itself | Windows 10 1903+ and Windows 11, non-removable |
| `cabinet.dll` (Compression API) | LZMS decompression | every Windows since 8 |

LZMS matters: it compresses this payload to 90 MB where Deflate — the only
thing .NET Framework offers natively — manages 104 MB, and it is only 1.6 MB
behind Brotli, which .NET Framework does not have at all.

The compiler is `csc.exe` from that same in-box .NET Framework, at a fixed path
under `%SystemRoot%\Microsoft.NET\Framework64`. No SDK, no Visual Studio and
nothing to download. `/target:winexe` makes it a GUI-subsystem binary, so
Windows never gives it a console window — checked in the build and again in the
release check. Dropping the Node route also removed `postject` and `rcedit` from
the build: the C# compiler writes the version resource from assembly attributes
and takes the icon with `/win32icon`.

### Code signing

The exe is unsigned. Windows SmartScreen will therefore show *"Windows
protected your PC"* on a machine that has not seen the file before — **More
info → Run anyway**, once. This is Windows commenting on the publisher, not a
sign that anything is missing.

For production, sign it with an OV or EV certificate; an EV certificate clears
SmartScreen immediately, an OV one builds reputation over time:

```powershell
signtool sign /fd SHA256 /f cert.pfx /p <password> `
  /tr http://timestamp.digicert.com /td SHA256 dist\Pharmacy-MIS.exe
```

Signing is not required for development and the build does not depend on it.
Re-run `npm run release-test` after signing, and regenerate the SHA-256.

Signing appends the certificate to the end of the file, which moves the payload
trailer away from where it was written. The launcher therefore searches
backwards for it rather than reading a fixed offset, so signing before or after
appending both work — the release cannot be broken by the act of signing it.

## Verifying a release

```
npm run release-test
```

This tests `dist/Pharmacy-MIS.exe` and nothing else. It copies **only** the exe
into a scratch folder, copies the three reference inputs in under meaningless
names, and then checks, through the exe:

- the Windows version metadata, icon, GUI subsystem and SHA-256
- the exe's own built-in diagnostic (`--self-test`), including the embedded
  template and UI, the loopback server and its token check
- a real run against the reference dataset, asserting all eight figures
- the generated workbook's title band, headers, widths, borders, merged cells
  and number formats
- update-in-place, append, and month rollover
- the error paths: no `--root`, a missing folder, an empty folder, malformed
  files, and a run with only one of the three sources
- the exe run from five different working directories, after being renamed, and
  with `PATH` cut down to `System32` so no Node, npm or Python is reachable
- that nothing was written beside the exe
- that a window opens on a bare double-click, is still open fifteen seconds
  later, and that closing it shuts the application down
- that a failed run writes a readable error file into the customer's Documents
  folder, naming what went wrong and what to do with it

## Runtime dependencies

**None that the customer has to install.** Everything the application needs is
either inside the exe or already part of Windows.

Inside the exe: the browser engine, the JavaScript runtime, the Excel writer,
the report template and the whole UI.

Already part of Windows — these are components, not downloads, and none can be
uninstalled on a supported system:

| What | Used for | Present on |
| --- | --- | --- |
| .NET Framework 4.x | the launcher that unpacks and starts the app | Windows 10 1903 and later, Windows 11 |
| `cabinet.dll` | decompressing the payload (LZMS) | every Windows since 8 |
| core Windows DLLs | the application itself | every Windows 10/11 — verified against the exe's PE import table by `npm run audit-deps` |

Requires **64-bit Windows 10 or 11**. Explorer is used only for the *Open
master* and *Show in folder* buttons; neither is needed to generate a report.

A note on the .NET Framework line, since it is the one thing here that is not
strictly unconditional: this used to be a Node single executable with no
dependency at all, which cost 91 MB — half the release — for a runtime that
only decompressed and spawned. The trade was made deliberately, to halve the
download. If a target machine somehow lacks .NET Framework 4.x, Windows itself
prompts to enable it; the application cannot show its own dialog in that case,
because nothing of it has run yet. Reverting to the zero-dependency launcher is
a contained change if that ever matters more than the size.

At build time, `exceljs` is the single runtime dependency: no native `.node`
binaries anywhere in its tree, nothing spawning an external process, and nothing
reading an asset relative to its own install location. `npm audit` flags a
moderate advisory against the `uuid` version `exceljs` pins; it is not reachable
from anything this application does, but it is worth re-checking when exceljs
next updates.

## Known limitations

- **x64 only.** There is no ARM64 build. Add `arm64` to the electron-builder
  target and build on, or cross-build for, that architecture if it is needed.
- **Unsigned.** See *Code signing* above.
- **First launch is slower.** The first run unpacks the application into
  `%LOCALAPPDATA%`, which takes a few seconds and about 240 MB of disk. Later
  runs skip it entirely. The exe itself is 90 MB.
- **Not verified on a genuinely clean Windows machine.** This development
  machine has neither Hyper-V nor Windows Sandbox, so no true bare VM was
  available. The isolation in `npm run release-test` — a folder holding nothing
  but the exe, a stripped `PATH`, several working directories, and a renamed
  copy — is the strongest verification available without one. It does not cover
  AppLocker/WDAC policies that block unsigned executables outright.
- **The portal pull is stubbed.** It is admin-machine-only and cannot prevent
  the customer's application from starting.
