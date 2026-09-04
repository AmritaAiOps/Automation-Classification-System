"""Packages the app as a single windowed .exe with PyInstaller.

    python build.py

Produces dist/Pharmacy Daily Report.exe -- one file, no console window,
nothing to install on the machine that runs it.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
NAME = "Pharmacy Daily Report"

# Trimming what this app never touches keeps the exe smaller and the cold
# start shorter. Only whole third-party packages are listed: pandas imports
# several of its own submodules internally (pandas.plotting among them), so
# excluding those breaks it at startup -- and in --windowed mode that failure
# is silent.
EXCLUDES = [
    "matplotlib", "scipy", "IPython", "notebook", "jupyter", "sphinx",
    "pytest", "PyQt5", "PyQt6", "PySide2", "PySide6", "tornado", "zmq",
]


def main() -> int:
    started = time.time()

    for folder in ("build", "dist"):
        shutil.rmtree(HERE / folder, ignore_errors=True)
    for spec in HERE.glob("*.spec"):
        spec.unlink()

    command = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--windowed",
        "--name", NAME,
        "--noconfirm",
        "--clean",
        "--collect-all", "ttkbootstrap",
        *sum((["--exclude-module", m] for m in EXCLUDES), []),
        str(HERE / "app.py"),
    ]

    print(" ".join(command[:8]), "...\n")
    result = subprocess.run(command, cwd=HERE)
    if result.returncode != 0:
        print("\nPyInstaller failed.")
        return result.returncode

    exe = HERE / "dist" / f"{NAME}.exe"
    if not exe.is_file():
        print(f"\nExpected {exe} but it isn't there.")
        return 1

    size = exe.stat().st_size / 1024 / 1024
    print("\n" + "=" * 58)
    print(f"  {exe.name}   {size:.1f} MB")
    print(f"  {exe}")
    print(f"  built in {time.time() - started:.0f}s")
    print("=" * 58)
    print("\nDouble-click it. Pick the four files, press Generate Report.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
