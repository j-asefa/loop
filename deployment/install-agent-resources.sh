#!/usr/bin/env bash
# Configure resource isolation without restarting or interrupting active runs.
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
service=${1:-loop55.service}
[[ "$service" =~ ^[a-zA-Z0-9_-]+\.service$ ]] || { echo 'Expected a user service name.' >&2; exit 1; }
test -f /sys/fs/cgroup/cgroup.controllers
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
helper_dir="$HOME/.local/lib/loop55"
mkdir -p "$unit_dir/$service.d" "$helper_dir"
install -m 0755 "$source_dir/agent-scope.py" "$helper_dir/agent-scope.py"
# Keep the operator's capacity choices on later upgrades.
if [ ! -f "$unit_dir/loop55-agents.slice" ]; then
  install -m 0644 "$source_dir/loop55-agents.slice" "$unit_dir/loop55-agents.slice"
fi
node "$source_dir/remove-job-shims.mjs"
python3 - "$helper_dir/agent-scope.py" "$unit_dir/$service.d/agent-resources.conf" <<'PY'
import json, pathlib, sys
launcher = 'LOOP55_NATIVE_LAUNCHER=' + sys.argv[1]
# Older agent worktrees still have the cooperative test limiter. Disable it in
# their inherited environment too; current checks retain cleanup without admission.
# Systemd interprets percent specifiers even inside quoted Environment values.
launcher = launcher.replace('%', '%%')
settings = '[Service]\nEnvironment=' + json.dumps(launcher) + '\nEnvironment=LOOP55_HEAVY_SCHEDULING=off\nUnsetEnvironment=LOOP55_JOB_QUEUE_CONFIG LOOP55_JOB_SHIMS LOOP55_JOB_ACTIVE\nMemoryLow=512M\n'
pathlib.Path(sys.argv[2]).write_text(settings)
PY
systemctl --user daemon-reload
systemctl --user start loop55-agents.slice
echo "Agent resource budget installed. Restart $service when idle to enable it."
