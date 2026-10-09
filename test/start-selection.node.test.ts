import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choices } from "../src/local-runtime.js";

test("CLI rejects every direct harness entry point before starting execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-cli-hapi-only-"));
  const exec = promisify(execFile);
  const run = (args: string[]) =>
    exec(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env: { ...process.env, LOOP_HOME: root },
      timeout: 10000,
    });
  try {
    for (const action of [
      "codex",
      "claude",
      "claude-code",
      "pi",
      "opencode",
      "acp",
      "laptop",
    ])
      await assert.rejects(run([action]), /Unknown command/);
    for (const option of [
      "--direct",
      "--executable",
      "--resume",
      "--billing",
      "--acp-arg",
    ])
      await assert.rejects(run(["start", option]), /Unknown option/);
    const { stdout } = await run(["--help"]);
    assert.match(stdout, /Discover installed harnesses/);
    assert.doesNotMatch(stdout, /loop codex|--direct|loop acp/);
    assert.deepEqual(choices("installed", "native", "/project"), {
      providers: ["codex", "claude", "opencode", "pi"],
      execution: "native",
      project: "/project",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
