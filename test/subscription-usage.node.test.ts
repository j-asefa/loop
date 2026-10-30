import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  captureClaudeUsage,
  claudeUsageFile,
  configureClaudeUsage,
  readClaudeUsage,
  readCodexUsage,
} from "../native/subscription-usage.mjs";

test("Claude status-line usage is minimized, sampled and expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop55-usage-"));
  try {
    const file = claudeUsageFile(dir);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(
      await captureClaudeUsage(
        JSON.stringify({
          session_id: "private-session",
          rate_limits: {
            five_hour: { used_percentage: 43.2, resets_at: reset },
            seven_day: { used_percentage: 18.9, resets_at: reset + 86400 },
          },
        }),
        file,
      ),
      true,
    );
    const stored = readFileSync(file, "utf8");
    assert.equal(stored.includes("private-session"), false);
    assert.equal((await readClaudeUsage(file)).fiveHour?.usedPercent, 43.2);
    assert.equal(
      await captureClaudeUsage(JSON.stringify({ rate_limits: {} }), file),
      false,
    );
    assert.equal(readFileSync(file, "utf8"), stored);
    writeFileSync(
      file,
      JSON.stringify({
        observedAt: new Date().toISOString(),
        fiveHour: { usedPercent: 80, resetsAt: "2020-01-01T00:00:00Z" },
      }),
    );
    assert.deepEqual(await readClaudeUsage(file), { status: "unavailable" });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("Claude status-line setup preserves an existing user command", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop55-usage-"));
  try {
    const file = join(dir, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        theme: "dark",
        statusLine: { type: "command", command: "my-status" },
      }),
    );
    assert.equal(configureClaudeUsage(dir, "/opt/hook.mjs"), false);
    assert.equal(
      JSON.parse(readFileSync(file, "utf8")).statusLine.command,
      "my-status",
    );
    writeFileSync(file, JSON.stringify({ theme: "dark" }));
    assert.equal(configureClaudeUsage(dir, "/opt/hook.mjs"), true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "dark");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("Codex usage reads the worker's shared app-server without exposing its token", async () => {
  const calls: string[] = [];
  class Socket extends EventEmitter {
    constructor(
      _endpoint: string,
      options: { headers: { Authorization: string } },
    ) {
      super();
      assert.equal(options.headers.Authorization, "Bearer secret");
      queueMicrotask(() => this.emit("open"));
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      calls.push(request.method);
      if (request.id)
        queueMicrotask(() =>
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                id: request.id,
                result:
                  request.method === "account/rateLimits/read"
                    ? {
                        rateLimits: {
                          limitId: "codex",
                          primary: {
                            usedPercent: 31,
                            windowDurationMins: 300,
                            resetsAt: 1_900_000_000,
                          },
                        },
                      }
                    : {},
              }),
            ),
          ),
        );
    }
    close() {
      this.emit("close");
    }
    terminate() {
      this.close();
    }
  }
  const result = await readCodexUsage({
    endpoint: "ws://127.0.0.1",
    token: "secret",
    WebSocketCtor: Socket,
  });
  assert.equal(result.status, "live");
  assert.equal(
    (result.rateLimits as { primary: { usedPercent: number } }).primary
      .usedPercent,
    31,
  );
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(calls, [
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ]);
});
