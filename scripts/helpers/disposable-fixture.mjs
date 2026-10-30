import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Only synthetic packaging fixtures opt in. Workspaces and arbitrary /tmp
// directories must never become cleanup candidates based on their names.
export function markDisposableFixture(directory) {
  const info = statSync(directory);
  let processStart = null,
    processGroup = null;
  try {
    const fields = readFileSync(`/proc/${process.pid}/stat`, "utf8")
      .split(")")
      .slice(1)
      .join(")")
      .trim()
      .split(/\s+/);
    processStart = fields[19];
    processGroup = Number(fields[2]);
  } catch {
    /* Non-Linux fixtures still clean themselves in their finally block. */
  }
  writeFileSync(
    join(directory, ".loop55-disposable.json"),
    JSON.stringify({
      version: 1,
      kind: "package-smoke",
      created: Date.now() / 1000,
      uid: process.getuid?.(),
      inode: info.ino,
      device: info.dev,
      pid: process.pid,
      process_start: processStart,
      process_group: processGroup,
    }),
    { mode: 0o600, flag: "wx" },
  );
}
