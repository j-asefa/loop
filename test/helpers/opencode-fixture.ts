import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";
import type { TestContext } from "node:test";
import { OpenCode } from "../../src/adapters/opencode.js";
import { until } from "../helpers.js";

type Control = {
  history?: unknown[];
  status?: Record<string, unknown>;
  failures?: Record<string, number>;
  events?: { type: string; properties: unknown }[];
  disconnect?: boolean;
  resetCalls?: boolean;
};
export function nativeMessage(id: string, error?: unknown) {
  return {
    info: { id, role: "assistant", error },
    parts: [
      {
        id: id + "-text",
        messageID: id,
        sessionID: "ses_1",
        type: "text",
        text: id,
      },
      {
        id: id + "-tool",
        messageID: id,
        sessionID: "ses_1",
        type: "tool",
        tool: "fixture",
        state: { status: "completed" },
      },
    ],
  };
}
export async function opencodeFixture(t: TestContext, history: unknown[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "loop-opencode-recovery-"));
  const path = join(dir, "control.sock");
  const executable = join(dir, "opencode");
  await writeFile(
    executable,
    `#!${process.execPath}
process.env.LOOP_TEST_HARNESS = "opencode";
process.env.LOOP_TEST_OPENCODE_SOCKET = ${JSON.stringify(path)};
process.env.LOOP_TEST_OPENCODE_HISTORY = ${JSON.stringify(JSON.stringify(history))};
import(${JSON.stringify(pathToFileURL(resolve("test/harness.mjs")).href)});
`,
    { mode: 0o755 },
  );
  const events: any[] = [];
  const adapter = new OpenCode(
    {
      harness: "opencode",
      executable,
      project: dir,
      version: "fixture",
      billing: "existing",
    },
    (event) => events.push(event),
  );
  let disposed: Promise<void> | undefined;
  const dispose = () =>
    (disposed ??= (async () => {
      await adapter.dispose();
      await rm(dir, { recursive: true, force: true });
    })());
  t.after(dispose);
  await adapter.start();
  const control = (command: Control = {}) =>
    new Promise<{ calls: string[] }>((resolve, reject) => {
      const socket = createConnection(path);
      let output = "";
      socket.setTimeout(5000, () =>
        socket.destroy(new Error("Fixture control timed out")),
      );
      socket.once("error", reject);
      socket.on("data", (chunk) => (output += chunk));
      socket.once("end", () => {
        try {
          const reply = JSON.parse(output);
          if (reply.error) reject(new Error(reply.error));
          else resolve(reply);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("connect", () => socket.end(JSON.stringify(command) + "\n"));
    });
  const idle = () =>
    control({
      events: [
        {
          type: "session.status",
          properties: { sessionID: "ses_1", status: { type: "idle" } },
        },
      ],
    });
  const recover = async () => {
    const before = events.length;
    await control({ status: { ses_1: { type: "busy" } }, disconnect: true });
    await until(() =>
      events
        .slice(before)
        .some((e) => e.type === "error" && /connection lost/.test(e.message)),
    );
    await until(() =>
      events
        .slice(before)
        .some((e) => e.type === "status" && e.status === "running"),
    );
    events.length = 0;
  };
  return { adapter, events, control, idle, recover, dispose };
}
