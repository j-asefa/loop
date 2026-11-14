import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliDriver } from "../src/native-auth/cli.js";

// Exercise descriptor-selected argv and URL admission through the real CLI
// driver and child-process boundary. This is a fixture, not provider validation.
for (const entry of [
  {
    name: "codex",
    method: "oauth",
    args: ["login", "--device-auth"],
    host: "auth.openai.com",
    manual: false,
  },
  {
    name: "claude",
    method: "oauth",
    args: ["auth", "login", "--claudeai"],
    host: "oauth.claude.ai",
    manual: true,
  },
  {
    name: "claude",
    method: "console",
    args: ["auth", "login", "--console"],
    host: "claude.com",
    manual: true,
  },
  {
    name: "grok",
    method: "oauth",
    args: ["login", "--device-auth"],
    host: "accounts.x.ai",
    manual: false,
  },
]) {
  test(`${entry.name}/${entry.method}: preserves argv and accepts only its sign-in domains`, async () => {
    const project = await mkdtemp(join(tmpdir(), "loop-cli-sign-in-"));
    const executable = join(project, "fixture.mjs");
    const valid = `https://${entry.host}/authorize`;
    const rejected = [
      `https://${entry.host}.evil.test/authorize`,
      `https://user@${entry.host}/authorize`,
      "https://evil.test/authorize",
      ...(entry.name === "grok"
        ? ["https://nested.accounts.x.ai/authorize"]
        : []),
    ];
    await writeFile(
      executable,
      `#!${process.execPath}
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
assert.deepEqual(process.argv.slice(2), ${JSON.stringify(entry.args)});
assert.equal(process.env.BROWSER, 'false');
assert.equal(process.env.DISABLE_AUTOUPDATER, '1');
${entry.name === "grok" ? "assert.equal(process.env.GROK_DISABLE_AUTOUPDATER, '1');" : ""}
const output = ${JSON.stringify([...rejected, valid, "ABCD-12345", ...(entry.manual ? ["Paste verification code"] : [])].join("\n") + "\n")};
${entry.manual ? `createInterface({input:process.stdin}).once('line', value => { assert.equal(value,'fixture-code'); process.exit(0); }); process.stdout.write(output);` : `process.stdout.write(output, () => process.exit(0));`}
`,
      { mode: 0o755 },
    );
    const driver = cliDriver({ name: entry.name, executable, project });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10000);
    const links: string[] = [];
    let prompts = 0;
    try {
      await driver.login("fixture", entry.method, {
        signal: abort.signal,
        link(url, code) {
          links.push(url);
          assert.equal(code, entry.manual ? undefined : "ABCD-12345");
        },
        async prompt(request) {
          prompts++;
          assert.equal(
            request.message,
            "Paste the verification code from Claude",
          );
          return "fixture-code";
        },
      });
      assert.ok(links.length > 0);
      assert.ok(links.every((url) => url === valid));
      assert.equal(prompts, entry.manual ? 1 : 0);
    } finally {
      clearTimeout(timeout);
      await driver.dispose();
      await rm(project, { recursive: true, force: true });
    }
  });
}
