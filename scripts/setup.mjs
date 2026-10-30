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
      "loop55-blame-ignore-revs",
    );
    try {
      const revisions = (content) =>
        content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
      const existing = new Set(
        existsSync(ignoreFile)
          ? revisions(readFileSync(ignoreFile, "utf8"))
          : [],
      );
      const requested = revisions(
        readFileSync(
          new URL("../.git-blame-ignore-revs", import.meta.url),
          "utf8",
        ),
      ).filter((revision) => !existing.has(revision));
      // Shallow clones may not have the recorded formatting commits yet.
      // An unavailable revision makes git blame fail even for unrelated files.
      const additions = requested.filter(
        (revision) =>
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision) &&
          spawnSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
            cwd: repository,
            stdio: "ignore",
            env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
          }).status === 0,
      );
      if (additions.length !== requested.length) {
        console.warn(
          `Skipped ${requested.length - additions.length} unavailable formatting revisions; rerun npm run setup after fetching history.`,
        );
      }
      // Append in one write: stale worktrees cannot remove newer revisions,
      // and concurrent setups may only duplicate entries (which Git accepts).
      // A leading newline also handles a preexisting file without a final one.
      appendFileSync(ignoreFile, `\n${additions.join("\n")}\n`, {
        mode: 0o600,
      });
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
  const prior = readFileSync(".env", "utf8");
  const configured = new Set(
    [...prior.matchAll(/^(LOOP55_[A-Z0-9_]+)=/gm)].map((m) => m[1]),
  );
  const migrated = prior.replace(
    /^(LOOP_([A-Z0-9_]+))=(.*)$/gm,
    (line, old, suffix, value) =>
      configured.has("LOOP55_" + suffix)
        ? line
        : "LOOP55_" + suffix + "=" + value,
  );
  if (migrated !== prior) writeFileSync(".env", migrated, { mode: 0o600 });
  if (!/^LOOP55_RUNTIME_TOKEN=.+$/m.test(readFileSync(".env", "utf8"))) {
    appendFileSync(
      ".env",
      `\nLOOP55_RUNTIME_TOKEN=${randomBytes(32).toString("hex")}\n`,
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
  `LOOP55_URL=http://localhost:3000\nPORT=3000\nLOOP55_AUTH_MODE=single-user\nBETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\nLOOP55_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nLOOP55_RUNTIME_TOKEN=${randomBytes(32).toString("hex")}\n`,
  { mode: 0o600 },
);
console.log("Created local configuration.");
