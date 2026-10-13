# Two-tab extraction — test checklist

Run after every build. Use a scratch Input Output Files folder (e.g. `C:\Temp\MIS-Test`).
Sign in with a real Amrita HIS account for the Automatic tests.

## 1. Happy path — Automatic
- [ ] Sign in. The window shows **Get the files** with the **Automatic** tab selected and Logout in the header.
- [ ] From / To both default to yesterday. Click **Run Extraction**.
- [ ] Each of the three files goes **Pending → Running → Done** (with a row count), and the log scrolls.
- [ ] Files are in `…\inputs\DD-MM-YYYY\` named `<Report>_DD-MM-YYYY.csv`.
- [ ] The status bar under **Report** shows all three ticked and **Proceed to Report** becomes enabled.
- [ ] **Proceed to Report** fills the results strip and writes the master row.
- [ ] Pick a 2-day range: two date folders are made, a "Showing" dropdown appears, and Proceed stays disabled until both days are complete.
- [ ] Tick **Run the browser in the background** and sign in again: no Edge window, same result.

## 2. Login failure
- [ ] Wrong password → red message "Incorrect username or password." The dashboard stays locked; no stack trace.
- [ ] Sign in, then close the Edge window → the window returns to sign-in with a clear message.
- [ ] Mid-extraction, sign out of the HIS in Edge → extraction stops with "session ended — sign in again"; files already saved are kept.
- [ ] **Remember password** ticked, sign in, close and reopen the app: the username is filled and the password box says "Saved password will be used"; Sign In works with it empty. **Forget saved login** removes it.

## 3. A file fails / is missing — and the hand-off
- [ ] Make one report fail (e.g. temporarily set a wrong report title in Settings or disconnect the network). It is retried 2 times (log shows "trying again"), then goes red **Failed** with a readable reason, and the other files still run.
- [ ] A day with no data in the portal shows Failed: "The portal has no data for this date…".
- [ ] Click **Switch to manual for this file** → the Manual tab opens with that file's row highlighted and its steps expanded.
- [ ] With a file missing, **Proceed to Report** is disabled and the status bar shows the missing file in amber.

## 4. Manual tab and bad uploads
- [ ] **Open HIS** opens the HIS address from Settings in your normal browser.
- [ ] Download a report by hand and use **Select file…**: green ✓ Valid, row count shown, file moved to `…\DD-MM-YYYY\<Report>_DD-MM-YYYY.<ext>` (same name/folder as Automatic).
- [ ] Do the same by dragging the file onto the row.
- [ ] Upload the wrong report (e.g. PRQ on the PO row) → red: "This looks like the Pharmacy PRQ Details report, not…". Nothing is saved.
- [ ] Upload an empty file, a `.pdf`, and a CSV with unrelated columns → each is refused with its own readable message.
- [ ] Re-upload a valid file for the same report → the old one is kept in `previous\`, not overwritten.
- [ ] Mix: get two files automatically, one manually → Proceed enables once all three are valid.

## 5. Shared behaviour
- [ ] **Logout** returns to the sign-in screen; a different account can sign in. Logout is disabled during a run.
- [ ] Close the exe during/after a session: no Edge process is left in Task Manager.
- [ ] **Settings**: change retries and HIS address, Save; "show settings file" opens `config.json`. A bad address (not http/https) is refused.
