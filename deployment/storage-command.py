#!/usr/bin/python3
"""Optional PATH entry for npm, npx and Docker storage preflight checks."""
import json
import os
from pathlib import Path
import sys

program = Path(sys.argv[0]).name
config_path = Path(os.environ.get("LOOP55_STORAGE_CONFIG", Path.home() / "setup/storage-policy.json"))
config = json.loads(config_path.read_text())
executable = config["executables"][program]
if not Path(executable).is_absolute() or Path(executable).resolve() == Path(__file__).resolve():
    raise SystemExit("Invalid underlying command in storage policy")
helper = Path.home() / "setup/storage-tools/current/storage-policy.py"
os.execv(sys.executable, [sys.executable, str(helper), "exec", "--config", str(config_path),
                         "--program", program, "--executable", executable, "--", *sys.argv[1:]])
