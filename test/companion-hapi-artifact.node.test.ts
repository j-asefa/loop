import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
// @ts-expect-error Build utility is a plain-Node module.
import { stageHapiArtifact } from "../scripts/stage-companion-hapi.mjs";

test("compact HAPI artifact retains executable, readiness and modified source without build dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-hapi-artifact-"));
  const buildRoot = join(root, "build"), destination = join(root, "baked");
  const source = join(buildRoot, "helpers/hapi-fixture");
  const binary = join(source, "cli/dist-exe/bun-linux-x64-baseline/hapi");
  mkdirSync(join(source, "cli/src"), { recursive: true });
  mkdirSync(join(source, "node_modules"));
  mkdirSync(join(source, "cli/dist-exe/bun-linux-x64-baseline"), { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
  try {
    writeFileSync(join(source, ".gitignore"), "node_modules/\ncli/dist-exe/\n");
    writeFileSync(join(source, "LICENSE"), "fixture license");
    writeFileSync(join(source, "cli/NOTICE"), "fixture notice");
    writeFileSync(join(source, "cli/src/provider.ts"), "original");
    git(["init", "--quiet"]);
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    writeFileSync(join(source, "cli/src/provider.ts"), "patched");
    writeFileSync(join(source, "cli/src/loopManaged.ts"), "managed source");
    writeFileSync(join(source, "node_modules/build-only.txt"), "excluded");
    writeFileSync(join(source, "loop-build-ready.json"), '{"patchHash":"fixture"}');
    writeFileSync(binary, "#!/bin/sh\nprintf 'fixture-hapi\\n'\n", { mode: 0o755 });
    const baked = stageHapiArtifact(buildRoot, binary, destination);
    rmSync(buildRoot, { recursive: true, force: true });
    assert.equal(execFileSync(baked, ["--version"], { encoding: "utf8" }).trim(), "fixture-hapi");
    const stagedSource = join(destination, "helpers/hapi-fixture");
    assert.equal(readFileSync(join(stagedSource, "loop-build-ready.json"), "utf8"), '{"patchHash":"fixture"}');
    assert.equal(readFileSync(join(stagedSource, "LICENSE"), "utf8"), "fixture license");
    assert.equal(readFileSync(join(stagedSource, "NOTICE"), "utf8"), "fixture notice");
    assert.equal(existsSync(join(stagedSource, "node_modules")), false);
    assert.equal(existsSync(join(stagedSource, ".git")), false);
    const archive = join(stagedSource, "hapi-source.tar.gz");
    const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.doesNotMatch(files, /node_modules|dist-exe|\.git\//);
    for (const [file, content] of [["cli/src/provider.ts", "patched"], ["cli/src/loopManaged.ts", "managed source"]])
      assert.equal(execFileSync("tar", ["-xOf", archive, file], { encoding: "utf8" }), content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
