#!/usr/bin/env bash
# Install immutable operational helpers from a successfully deployed checkout.
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
revision=$(git -C "$source_dir" rev-parse HEAD)
target="$HOME/setup/storage-tools/$revision"
if [ ! -d "$target" ]; then
  mkdir -p "$HOME/setup/storage-tools"
  stage=$(mktemp -d "$HOME/setup/storage-tools/.install-XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  for file in archive-backups.py storage-policy.py storage-command.py reserved-volume.py; do
    install -m 0755 "$source_dir/$file" "$stage/$file"
  done
  mv "$stage" "$target"
fi
ln -sfn "$target" "$HOME/setup/storage-tools/current"
