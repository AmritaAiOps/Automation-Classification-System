"""Screenshots the packaged exe's window, to confirm the GUI renders from the
built binary and not only from source. Development aid only."""
import subprocess, sys, time
from pathlib import Path
from PIL import ImageGrab
from pywinauto import Desktop

exe = Path(__file__).parent / "dist" / "Pharmacy Daily Report.exe"
proc = subprocess.Popen([str(exe)])
window = None
for _ in range(40):
    try:
        window = Desktop(backend="uia").window(title="Pharmacy Daily Report")
        window.wait("visible", timeout=2)
        break
    except Exception:
        time.sleep(1)
if window is None:
    proc.kill(); sys.exit("the exe never showed a window")

window.set_focus()
time.sleep(1.5)
r = window.rectangle()
print(f"window rect: {r.width()}x{r.height()} at ({r.left},{r.top})", flush=True)
out = Path(__file__).parent / "shots" / "exe-window.png"
ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom), all_screens=True).save(out)
print(f"saved {out.name}", flush=True)
print(f"process alive after render: {proc.poll() is None}", flush=True)
window.close(); time.sleep(1)
if proc.poll() is None: proc.kill()
print("done", flush=True)
