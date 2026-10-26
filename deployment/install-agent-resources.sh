#!/usr/bin/env bash
# Configure resource isolation without restarting or interrupting active runs.
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
service=${1:-loop.service}
[[ "$service" =~ ^[a-zA-Z0-9_-]+\.service$ ]] || { echo 'Expected a user service name.' >&2; exit 1; }
test -f /sys/fs/cgroup/cgroup.controllers
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
helper_dir="$HOME/.local/lib/loop"
mkdir -p "$unit_dir/$service.d" "$helper_dir"
install -m 0755 "$source_dir/agent-scope.py" "$helper_dir/agent-scope.py"
# Keep the operator's capacity choices on later upgrades.
if [ ! -f "$unit_dir/loop-agents.slice" ]; then
  install -m 0644 "$source_dir/loop-agents.slice" "$unit_dir/loop-agents.slice"
fi
python3 - "$helper_dir/agent-scope.py" "$unit_dir/$service.d/agent-resources.conf" <<'PY'
import json, pathlib, sys
launcher = 'LOOP_NATIVE_LAUNCHER=' + sys.argv[1]
# Systemd interprets percent specifiers even inside quoted Environment values.
launcher = launcher.replace('%', '%%')
pathlib.Path(sys.argv[2]).write_text('[Service]\nEnvironment=' + json.dumps(launcher) + '\nMemoryLow=512M\n')
PY
systemctl --user daemon-reload
systemctl --user start loop-agents.slice
echo "Agent resource budget installed. Restart $service when idle to enable it."
