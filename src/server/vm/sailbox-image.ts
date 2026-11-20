import { createHash } from "node:crypto";

// The experiment image. Sail builds custom images only through its SDK, which
// Loop does not bundle, so Loop builds a "golden" Sailbox instead: boot
// SAILBOX_BASE_IMAGE with no volume mounted, run INSTALL_SCRIPT over exec,
// take a filesystem-only checkpoint, and start every experiment from that
// checkpoint. The third-party installers therefore never run beside the
// harness credentials. Each experiment mounts the auth volume after it starts
// (VmProvider.mountVolume); a fork's checkpoint reattaches it, and volume
// contents are never part of a checkpoint. The checkpoint id is saved as
// vm_provider_configs.base_image_ref with SAILBOX_IMAGE_VERSION, and a
// version change means the image is rebuilt.
//
// Install sources (checked 2026-11-20): Claude Code
// https://code.claude.com/docs/en/setup, Codex https://github.com/openai/codex,
// Antigravity https://antigravity.google/docs/getting-started?tab=cli, Pi
// https://github.com/earendil-works/pi. The installers fetch their latest
// releases; the image version pins the script, not the harness versions.

/** Each owner's credentials live on their own volume, so two owners sharing
 * one Sail account never mount each other's sign-ins. */
export function authVolumeName(owner: string) {
  return `loop-auth-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}`;
}
export const AUTH_MOUNT_PATH = "/mnt/loop-auth";
export const WORKSPACE_PATH = "/workspace";
export const SAIL_APP_NAME = "loop-experiments";
/** Golden checkpoints stay usable for a year; Sail's default is seven days. */
export const GOLDEN_CHECKPOINT_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Credential files, relative to the home directory, kept on the auth volume
 * under the harness's directory. Everything else a harness writes, including
 * its session transcripts, stays on the VM's own disk. */
export const HARNESS_CREDENTIALS = {
  claude: [".claude/.credentials.json"],
  codex: [".codex/auth.json"],
  antigravity: [
    ".gemini/oauth_creds.json",
    ".gemini/google_accounts.json",
    ".gemini/antigravity-cli/antigravity-oauth-token",
  ],
  pi: [".pi/agent/auth.json"],
} as const;

export const INSTALL_SCRIPT = `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \\
  git gh curl ca-certificates ripgrep jq sqlite3 build-essential pkg-config \\
  util-linux openssh-client unzip xz-utils python3 python3-venv python3-pip golang
# Docker ships with the base image; fail early if it does not.
command -v docker
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pnpm @openai/codex
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
curl -fsSL https://bun.sh/install | bash
curl -LsSf https://astral.sh/uv/install.sh | sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
curl -fsSL https://claude.ai/install.sh | bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
cat > /etc/profile.d/loop-paths.sh <<'PATHS'
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
PATHS
# Claude Code asks onboarding questions until this is recorded; the file is
# local to each VM and holds no credential.
[ -f "$HOME/.claude.json" ] || echo '{"hasCompletedOnboarding":true}' > "$HOME/.claude.json"
install -m 0755 /dev/stdin /usr/local/bin/loop-vm-init <<'INIT'
${initScript()}
INIT
for harness in claude codex agy pi; do
  PATH="$HOME/.local/bin:$PATH" command -v "$harness"
done
`;

/** Runs on every experiment before its first turn. It only creates links and
 * the workspace repository, so running it again changes nothing. */
export function initScript() {
  const links = Object.entries(HARNESS_CREDENTIALS)
    .flatMap(([harness, files]) =>
      files.map((file) => `link ${harness} ${file}`),
    )
    .join("\n");
  return `#!/bin/bash
set -euo pipefail
auth="\${LOOP_AUTH_MOUNT:-${AUTH_MOUNT_PATH}}"
workspace="\${LOOP_WORKSPACE:-${WORKSPACE_PATH}}"
link() {
  local target="$auth/$1/$(basename "$2")" path="$HOME/$2"
  mkdir -p "$auth/$1" "$(dirname "$path")"
  chmod 700 "$auth/$1"
  # A regular file here is newer than the volume's copy: either the harness
  # signed in before the link existed, or it refreshed the credential by
  # replacing the link with a file. Either way it is kept, on the volume.
  if [ -f "$path" ] && [ ! -L "$path" ]; then
    mv -f "$path" "$target"
  fi
  ln -sfn "$target" "$path"
}
${links}
mkdir -p "$workspace"
cd "$workspace"
if [ ! -d .git ]; then
  git init -q -b main
  git -c user.name=Loop -c user.email=loop@localhost commit -q --allow-empty -m "Initial experiment workspace"
fi`;
}

export const SAILBOX_IMAGE_VERSION = createHash("sha256")
  .update(INSTALL_SCRIPT)
  .digest("hex")
  .slice(0, 16);
