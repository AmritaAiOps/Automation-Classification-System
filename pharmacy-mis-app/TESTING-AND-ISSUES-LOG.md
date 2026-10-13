# Testing and issues log

A running record of what was tested, what went wrong, and what was done about it.
Newest section first. Dates are 2026. No credentials appear here or anywhere in the app's
files: tests pass them through environment variables only.

---

## 13 Oct: multi-date runs, Automatic / Manual tabs, download cancels

### Changes made this session
- **Multi-date runs.** Added From/To date pickers (default: yesterday) and a results table with
  one row per date. A failed date shows a red row and the other dates carry on.
- **Report-major pull.** Each of the three reports is opened once and run for every date in the
  range, instead of reopening every report for every date.
- **Automatic run / Manual run tabs.** The Automatic tab has the sign-in, dates and Run. The
  Manual tab has the source files and "Run daily report". The login-only first screen was
  removed; Logout returns to the login fields on the dashboard.
- **Speed.** Shorter fixed sleeps and typing delays; the menu-search typing delay (90 ms/char)
  was left alone because faster typing is read as a barcode scan by the portal.
- **Download wait cut from 300 s to 30 s**, with an env override (`PHARMACY_MIS_DOWNLOAD_TIMEOUT_MS`).
- **Retries.** A cancelled/stalled download is retried: first by re-clicking Run Report on the same
  form, then by reopening the report; the last try always reopens it.
- **Edge flags** that turn off download protection (`msSmartScreenProtection`, `DownloadBubble`,
  `--safebrowsing-disable-download-protection`).

### Issues faced
| # | Issue | Cause | Resolution |
|---|-------|-------|------------|
| 1 | Portal icons missing after the speed pass | I blocked images and fonts on the portal tab; its icons are icon fonts | Interception removed. Rule since: only sleeps and typing delays are tuned, never what the page loads |
| 2 | Automatic and Manual tabs showed the same cards | A cleanup deleted the CSS rule that hides the other tab's cards | Rule restored |
| 3 | `unlockDashboard()` call left behind after removing the lock screen | Incomplete removal | Found by grep and removed (it would have thrown after sign-in) |
| 4 | Build failed with `EPERM, Permission denied: ...\dist` | The old `Pharmacy-MIS.exe` was still running; the build deletes `dist` first | Close the app, rebuild |
| 5 | Report download stalls, "downloads-hub" tab opens, no file lands (waited up to 5 minutes) | See "Root-cause finding" below | 30 s wait, fast cancel detection, retries, Edge flags |
| 6 | "Could not select all Purchase Tax Scheme / Creation Status options: selected 1 of N" on a reused form | The reused form can keep the previous date's selections | One retry with the report reopened |
| 7 | Multi-date pull aborted with "Target closed / detached Frame" | Network/VPN dropped mid-run (the page hung ~2 min, then the browser connection closed) | Environmental, not a code bug. Runs after it failed with "address did not resolve" for the same reason |

### Root-cause finding on the download stall
Edge's own download events (traced with `PHARMACY_MIS_TRACE_DOWNLOADS=1`) show what happens: the
download starts, a first chunk of data arrives (about 14 KB), and then Edge reports
`state: "canceled"` with 0 bytes within about a second. A `.crdownload` partial file is left
behind and never grows, and the old code simply waited for it until the 5-minute timeout.

- It is **not** caused by changing dates, and **not** by the report-major order: it happens on the
  first download of a session, on the first date of a freshly opened report, and in the old
  date-by-date order too.
- It is **not** our code closing the report tab: tab open/close logging showed only the portal's own
  grid worker tabs and Edge's downloads tab.
- It is **not** the portal being busy because of my back-to-back tests: a run after a 2.5-minute pause
  was just as bad.
- Not proven, but the best remaining suspect is Edge's download-safety checks (CSV served from a
  servlet URL with no content length). Turning them off with launch flags raised the clean rate.

### Test results (3 dates, 7-9 Oct, test login, three reports each = 9 downloads)

| Run | Setup | Result | Pull time |
|-----|-------|--------|-----------|
| Earlier, single date 12 Oct | one date, new code | 3/3 downloads, all clean | 30 s |
| 1-2 | report-major, 5-min wait | stalled; waited the full timeout | 150+ s |
| 3-6 | report-major, 30 s wait, retry added | 1-2 dates lost per run | 60-260 s |
| 7-8 | + fast cancel detection, instrumented | 3/3 dates, then 1 date lost | 72 s, 89 s |
| 9 | report-major, after 2.5 min quiet | 1 of 3 dates ok | 128 s |
| 10 | report-major, after 2.5 min quiet | 0 of 3 dates ok (worst run) | 143 s |
| 11-12 | **old order** (all 3 reports per date, then next date), same retries | 3/3 dates ok; then 2/3 dates ok | 99 s, 114 s |
| 13-15 | report-major + Edge download flags | 3/3 ok (58 s); 2/3 ok (61 s); 3/3 ok (53 s) | 53-61 s |
| 16 | report-major + flags | invalid: network dropped (see issue 7) | n/a |

Reading of the numbers: the old order is not more reliable (it also loses dates), and when nothing
is cancelled the new order is about twice as fast (about 55 s against 100 s for 3 dates). With the
Edge flags, 2 of 3 runs were fully clean. Sample sizes are small and the portal's behaviour varies,
so treat this as "better", not "fixed".

### Offline tests
`npm test` (88 checks: report logic, Excel writing, embedded page script syntax): 88 passed,
0 failed after each change. They do not exercise the portal or the window.

### Open items
- The cancel still happens occasionally. If a run loses a date, running that date again on its own works.
- If it keeps happening in daily use, the fallback is the old date-by-date order (which has the same cancels but is slower).
- A live look at the packaged exe's window (tabs, table) has not been done by me; only the code was checked.

---

## History from earlier commits (from git log, 4 Sep - 12 Oct)

| Date | What was fixed or changed |
|------|---------------------------|
| 4-8 Sep | First versions of the daily mapping app; launcher recovers when the runtime folder is locked |
| 12 Sep | Launcher unpack path kept under Windows' 260-character limit; portal pull pointed at the HIS entry URL with connection-state reporting; Puppeteer loaded by dynamic import (require failed); reports opened from the sidebar menu without a coordinate click; archive root and input folder remembered between launches (localStorage was useless because the port changes every launch); the report form is searched inside frames; release exe committed via Git LFS, old Python app removed |
| 21 Sep | Portal-pull hangs and wrong-data bugs fixed; report date made one editable field |
| 22 Sep | Major rework |
| 3 Oct | Release exe rebuilt, Excel template updated |
| 10 Oct | Electron exe temporarily converted to a web app, then restored on main |
| 12 Oct | Zip payload and dead-code removal; "Input Output Files" rename, Logout, date-wise folders; exe rebuilt |
| 13 Oct | Home page rebuild (login/dashboard), then this session's work above |
