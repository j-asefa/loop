import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "./helpers.js";

test(
  "paired conversation latency is measured outside the streaming native host",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "loop-latency-"));
    const child = fork(
      new URL("./fixtures/companion-latency.ts", import.meta.url),
      [],
      {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          LOOP_DATA_DIR: directory,
          LOOP_TEST_HARNESS: "codex",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let diagnostic = "";
    child.stdout!.on("data", (data) => {
      diagnostic += data;
    });
    child.stderr!.on("data", (data) => {
      diagnostic += data;
    });
    let ready: { origin: string; pair: string } | undefined;
    child.on("message", (message) => {
      ready = message as typeof ready;
    });
    t.after(async () => {
      if (child.connected) child.send("stop");
      try {
        await until(
          () => child.exitCode !== null || child.signalCode !== null,
          15_000,
        );
      } catch {
        child.kill("SIGKILL");
        await until(() => child.signalCode !== null);
      }
      await rm(directory, { recursive: true, force: true });
    });
    await until(() => !!ready || child.exitCode !== null);
    assert(ready, diagnostic);
    const { origin } = ready;
    assert.equal((await fetch(origin + "/api/build")).status, 401);
    const redemption = await fetch(origin + "/pair", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: new URLSearchParams(new URL(ready.pair).hash.slice(1)).get(
          "pair",
        ),
        name: "latency fixture",
      }),
    });
    assert.equal(redemption.status, 200);
    const cookie = redemption.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await fetch(origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json());
    const api = async (path: string, body?: object) => {
      const response = await fetch(origin + "/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          Origin: origin,
          "x-loop-csrf": csrf,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      assert(
        response.ok,
        JSON.stringify({ path, status: response.status, data }),
      );
      return data;
    };
    const bootstrap = await api("/bootstrap");
    const agent = await api("/agents", {
      name: "latency-fixture",
      connectionId: "native-codex",
      model: "native-default",
      instructions: "Fixture",
      folderId: bootstrap.folders.find((f: { path?: string }) => f.path)?.id,
    });
    const run = await api("/runs", {
      agentId: agent.id,
      input: "latency-stream",
      idempotencyKey: randomUUID(),
    });
    const samples: number[] = [];
    const started = performance.now();
    let sawStreaming = false,
      completed = false;
    let lastMessages: unknown;
    while (!completed && performance.now() - started < 20_000) {
      const at = performance.now();
      const transcript = await api("/conversations/" + run.conversation_id);
      samples.push(performance.now() - at);
      lastMessages = transcript.messages.map(
        (m: { content: string; run_state?: string }) => ({
          content: m.content.slice(0, 35),
          state: m.run_state,
        }),
      );
      sawStreaming ||= transcript.messages.some(
        (m: { content: string; run_state?: string }) =>
          m.content.includes("Streaming fixture") && m.run_state === "running",
      );
      completed = transcript.messages.some(
        (m: { content: string; run_state?: string }) =>
          m.content.includes("Streaming fixture 79 ") &&
          m.run_state === "completed",
      );
      // Deliberate client load pacing; the clock is in this separate process.
      await until(() => performance.now() - at >= 100, 1000);
    }
    assert(
      sawStreaming && completed,
      JSON.stringify({
        sawStreaming,
        completed,
        lastMessages,
        diagnostic: diagnostic.slice(-2000),
      }),
    );
    assert(samples.length >= 30, "enough external request samples");
    samples.sort((a, b) => a - b);
    const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
    const build = await api("/build");
    assert.equal(build.eventLoop.observing, true);
    assert(build.eventLoop.samples > 0);
    assert(
      p95Ms < 2000,
      `external request p95 ${p95Ms}ms exceeds the pre-extraction bound`,
    );
    t.diagnostic(
      JSON.stringify({
        requests: samples.length,
        p95Ms,
        maxMs: samples.at(-1),
        eventLoop: build.eventLoop,
      }),
    );
  },
);
