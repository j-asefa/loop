import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const versions = JSON.parse(read("deployment/versions.json"));

test("managed lockfile and container pins match the release manifest", () => {
  const deps = JSON.parse(read("deployment/native/package.json")).dependencies;
  const lock = JSON.parse(read("deployment/native/package-lock.json"));
  for (const [pkg, version] of Object.entries({
    "@openai/codex": versions.codex,
    "opencode-ai": versions.opencode,
    "@earendil-works/pi-coding-agent": versions.pi,
    "@anthropic-ai/claude-code": versions.claudeCode,
  })) {
    assert.equal(deps[pkg], version);
    assert.equal(lock.packages[""].dependencies[pkg], version);
    assert.equal(lock.packages[`node_modules/${pkg}`].version, version);
  }
  const runtime = read("Dockerfile.runtime");
  assert.ok(runtime.includes(`ARG CODEX_VERSION=${versions.codex}\n`));
  assert.ok(runtime.includes(`ARG CLAUDE_CODE_VERSION=${versions.claudeCode}\n`));
});
