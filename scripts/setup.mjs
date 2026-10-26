import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Linked worktrees share this local Git configuration. Run before the .env
// early return so existing installations get the blame setting too.
const repository = fileURLToPath(new URL("..", import.meta.url));
if (
  existsSync(new URL("../.git", import.meta.url)) &&
  existsSync(new URL("../.git-blame-ignore-revs", import.meta.url))
) {
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repository,
    encoding: "utf8",
  });
  // Older worktrees may not contain .git-blame-ignore-revs yet. Keep the
  // configured copy with the shared Git metadata, not in one agent's worktree.
  let configured = false;
  if (common.status === 0) {
    const ignoreFile = resolve(
      repository,
      common.stdout.trim(),
      "loop-blame-ignore-revs",
    );
    try {
      writeFileSync(
        ignoreFile,
        readFileSync(new URL("../.git-blame-ignore-revs", import.meta.url)),
      );
      configured =
        spawnSync(
          "git",
          ["config", "--local", "blame.ignoreRevsFile", ignoreFile],
          { cwd: repository, stdio: "ignore" },
        ).status === 0;
    } catch {
      // A read-only Git directory must not prevent local environment setup.
    }
  }
  if (configured) {
    console.log("Git blame ignores the recorded formatting commits.");
  } else {
    console.warn(
      "Could not configure Git blame; rerun npm run setup when the Git directory is writable.",
    );
  }
}

if (existsSync(".env")) {
  if (!/^LOOP_RUNTIME_TOKEN=.+$/m.test(readFileSync(".env", "utf8"))) {
    appendFileSync(
      ".env",
      `\nLOOP_RUNTIME_TOKEN=${randomBytes(32).toString("hex")}\n`,
    );
    console.log(
      "Added runtime service authentication; existing secrets preserved.",
    );
  }
  console.log(".env already exists; preserved");
  process.exit(0);
}
writeFileSync(
  ".env",
  `LOOP_URL=http://localhost:3000\nPORT=3000\nLOOP_AUTH_MODE=single-user\nBETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\nLOOP_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nLOOP_RUNTIME_TOKEN=${randomBytes(32).toString("hex")}\n`,
  { mode: 0o600 },
);
console.log("Created local configuration.");
