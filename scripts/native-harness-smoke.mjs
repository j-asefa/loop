// Run inside the runtime image with no signed-in home and no model prompt.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "loop55-harness-smoke-"));
for (const mode of ["host", "container"]) {
  for (const provider of ["codex", "claude"]) {
    const home = join(root, mode, provider);
    mkdirSync(home, { recursive: true });
    const skill = join(
      home,
      provider === "codex" ? ".agents" : ".claude",
      "skills",
      "loop55-discovery-fixture",
    );
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: loop55-discovery-fixture\ndescription: A harmless discovery fixture\n---\nSay hello.\n",
    );
    const p = spawn(process.execPath, ["/runtime/entry.mjs"], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LOOP55_RUNTIME_MODE: mode,
        LOOP55_RUNTIME_WORKDIR: home,
        DISABLE_AUTOUPDATER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    p.stdout.on("data", (c) => (output += c));
    p.stderr.resume();
    const timer = setTimeout(() => p.kill(), 25000);
    p.stdin.end(JSON.stringify({ provider, action: "capabilities" }) + "\n");
    const code = await new Promise((r, j) => {
      p.once("error", j);
      p.once("close", r);
    });
    clearTimeout(timer);
    assert.equal(code, 0, provider + " command discovery succeeds");
    const result = output
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((e) => e.result)?.result;
    assert.equal(result?.available, true);
    assert.ok(
      result.commands.some((c) => c.name === "loop55-discovery-fixture"),
      provider + " discovers the isolated skill",
    );
    console.log(
      "PASS: real " +
        provider +
        " " +
        mode +
        " command discovery with an unsigned-in test home, no model turn.",
    );
    if (provider === "claude" && mode === "host") {
      const child = spawn(
        "claude",
        [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
        ],
        {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, DISABLE_AUTOUPDATER: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let buffer = "",
        accepted = false;
      const deadline = setTimeout(() => child.kill(), 25000);
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const m = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (
            m.type === "control_response" &&
            m.response?.request_id === "context-check"
          ) {
            accepted = m.response.subtype === "success";
            child.kill();
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: "context-check",
          request: {
            subtype: "initialize",
            appendSystemPrompt: "Historical context: " + "x".repeat(180000),
          },
        }) + "\n",
      );
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      clearTimeout(deadline);
      assert.ok(
        accepted,
        "Real Claude accepts long appended context over streamed initialization without a model turn",
      );
      console.log(
        "PASS: real Claude initializes with long streamed context, no prompt or model turn.",
      );
    }
  }
}
rmSync(root, { recursive: true, force: true });
