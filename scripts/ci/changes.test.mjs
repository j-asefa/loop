import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { classify, changedPaths, selection, browserImage } from "./changes.mjs";
const full = {
  code: true,
  containers: true,
  companion: true,
  native: true,
  service: true,
};
test("docs skip, client and root tests retain all application checks", () => {
  assert.equal(classify(["README.md", "docs/development.md"]).code, false);
  for (const path of [
    "src/client/App.tsx",
    "test/access.test.ts",
    "test/connection.node.test.ts",
  ]) {
    assert.deepEqual(classify([path]), {
      code: true,
      containers: false,
      companion: false,
      native: false,
      service: false,
    });
  }
});
test("every deployment/shared/unknown input fails open to full coverage", () => {
  for (const path of [
    "src/server/github-pulls.ts",
    "src/server/db.ts",
    "src/shared/news.ts",
    "src/native-auth/runner.ts",
    "src/service.ts",
    "runtime/broker.mjs",
    "native/loopManaged.ts",
    "migrations/064.sql",
    "package-lock.json",
    "package.json",
    "deployment/native/package-lock.json",
    ".github/workflows/ci.yml",
    "scripts/ci/changes.mjs",
    "scripts/helpers/design-fixture.mjs",
    "test/helpers/cloudflared.mjs",
    "docs/example.ts",
    "new-directory/input",
    "src/server/execution-location.ts",
  ])
    assert.deepEqual(classify([path]), full, path);
  assert.deepEqual(classify(["src/client/App.tsx", "native/new.mjs"]), full);
});
test("manual/schedule/push always run full, diff failures never skip", () => {
  for (const name of ["workflow_dispatch", "schedule", "push"])
    assert.deepEqual(selection(name, {}), full);
  assert.deepEqual(
    selection("pull_request", { pull_request: { base: { sha: "bad" } } }),
    full,
  );
});
test("real git diff covers all commits, deletions, renames and unusual filenames", () => {
  const cwd = mkdtempSync(join(tmpdir(), "loop-ci-diff-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    mkdirSync(join(cwd, "src/client"), { recursive: true });
    writeFileSync(join(cwd, "src/client/move.ts"), "original");
    writeFileSync(join(cwd, "Dockerfile"), "original");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    renameSync(
      join(cwd, "src/client/move.ts"),
      join(cwd, "native new\nname.ts"),
    );
    git("add", ".");
    git("commit", "-m", "rename");
    rmSync(join(cwd, "Dockerfile"));
    git("add", ".");
    git("commit", "-m", "delete");
    const paths = changedPaths(base, "HEAD", cwd);
    assert.deepEqual(
      new Set(paths),
      new Set(["src/client/move.ts", "native new\nname.ts", "Dockerfile"]),
    );
    assert.deepEqual(classify(paths), full);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("image tracks the resolved lock and rejects partial version updates", () => {
  const packages = Object.fromEntries(
    ["playwright-core", "playwright", "@playwright/test"].map((n) => [
      `node_modules/${n}`,
      { version: "1.63.0" },
    ]),
  );
  assert.equal(
    browserImage({ packages }),
    "mcr.microsoft.com/playwright:v1.63.0-noble",
  );
  packages["node_modules/playwright-core"].version = "1.64.0";
  assert.throws(() => browserImage({ packages }), /match/);
});

test("deployment definitions select their independent production checks", () => {
  assert.deepEqual(classify(["Dockerfile"]), {
    code: true,
    containers: true,
    companion: false,
    native: false,
    service: false,
  });
  assert.deepEqual(
    classify(["Dockerfile.companion", "scripts/service-lifecycle-smoke.mjs"]),
    {
      code: true,
      containers: false,
      companion: true,
      native: false,
      service: true,
    },
  );
});
