#!/usr/bin/env bash
# Install/build on the Ubuntu host (which has native compilation tools), then
# run browser fixtures with the image's preinstalled engines/system libraries.
# Mount the exact setup-node runtime so better-sqlite3 has the same Node ABI.
set -euo pipefail
: "${LOOP55_CI_BROWSER_IMAGE:?Set the image resolved from package-lock.json}"
node_root=$(node -p 'require("node:path").dirname(require("node:path").dirname(process.execPath))')
docker run --rm --init --ipc=host \
  --mount "type=bind,source=$PWD,target=/work" \
  --mount "type=bind,source=$node_root,target=/opt/loop55-node,readonly" \
  --workdir /work \
  --env PATH=/opt/loop55-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --env CI=true --env LOOP55_BROWSER --env LOOP55_BROWSER_WORKERS \
  "$LOOP55_CI_BROWSER_IMAGE" "$@"
