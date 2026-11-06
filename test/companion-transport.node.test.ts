import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { callRoute, readRoute, clearAuthorization } from "../src/client/api.js";
import { workspaceApi } from "../src/shared/workspace-api.js";
import { until } from "./helpers.js";

test("typed companion auth uses compiled sockets without leaking credentials or replaying starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-companion-transport-"));
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH;
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("LOOP_")),
  );
  const project = join(directory, "project"),
    bin = join(directory, "bin");
  await mkdir(project);
  await mkdir(bin);
  for (const name of ["pi", "grok"]) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nexport LOOP_TEST_HARNESS=${name}\nexport LOOP_TEST_AUTH_DIR='${directory}'\nexec '${process.execPath}' '${process.cwd()}/test/auth-harness.mjs' "$@"\n`,
      { mode: 0o755 },
    );
  }
  const child = fork(
    new URL("./fixtures/contracts-http.mjs", import.meta.url),
    [],
    {
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...environment,
        NODE_ENV: "test",
        PATH: bin + ":" + (originalPath || ""),
        LOOP_DATA_DIR: join(directory, "data"),
        LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      },
    },
  );
  let logs = "",
    port = 0;
  child.stdout!.on("data", (data) => {
    logs += data;
  });
  child.stderr!.on("data", (data) => {
    logs += data;
  });
  child.on("message", (message) => {
    port = (message as { port: number }).port;
  });
  try {
    await until(() => {
      assert.equal(child.exitCode, null, logs);
      return port !== 0;
    });
    const direct = `http://127.0.0.1:${port}`;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: new EventTarget(),
    });
    for (const [origin, source] of [[direct, ""]]) {
      clearAuthorization();
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: {
          href: origin + "/",
          search: source ? "?source=" + encodeURIComponent(source) : "",
        },
      });
      globalThis.fetch = (input, init) => {
        const url = new URL(String(input), origin);
        return originalFetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            origin,
          },
        });
      };
      const controller = new AbortController();
      const projectResult = await callRoute(
        workspaceApi.workspaceProjectCreate,
        { body: { path: project } },
        source,
      );
      const providers = await readRoute(
        workspaceApi.runtimeAuthProviders,
        { params: { name: "pi" }, query: { projectId: projectResult.id } },
        source,
        controller.signal,
      );
      assert.equal(providers.providers[0].id, "anthropic");
      const stream = await globalThis.fetch(
        "/api" +
          (source ? "/agent-sources/" + encodeURIComponent(source) : "") +
          "/events",
        { signal: controller.signal },
      );
      assert.equal(stream.status, 200);
      let events = "";
      const observing = (async () => {
        try {
          for await (const chunk of stream.body!)
            events += Buffer.from(chunk).toString();
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
      })();
      try {
        const commandId = randomUUID();
        const startInput = {
          params: { name: "pi" as const },
          body: {
            projectId: projectResult.id,
            provider: "anthropic",
            method: "api",
            commandId,
          },
        };
        const transport = globalThis.fetch;
        let starts = 0;
        globalThis.fetch = async (input, init) => {
          const result = await transport(input, init);
          if (String(input).endsWith("/auth/start")) {
            starts++;
            await result.arrayBuffer();
            throw new TypeError("Lost start response");
          }
          return result;
        };
        await assert.rejects(
          callRoute(workspaceApi.runtimeAuthStart, startInput, source),
          /Couldn’t reach Loop/,
        );
        assert.equal(
          starts,
          1,
          "uncertain sign-in starts are never automatically replayed",
        );
        globalThis.fetch = transport;
        const resumed = await callRoute(
          workspaceApi.runtimeAuthStart,
          startInput,
          source,
        );
        assert.equal(resumed.attempt?.commandId, commandId);
        let waiting = resumed;
        await until(async () => {
          waiting = await readRoute(
            workspaceApi.runtimeAuthStatus,
            { params: { name: "pi" } },
            source,
            controller.signal,
          );
          return !!waiting.attempt?.prompt;
        });
        const credential = "transport-private-api-key";
        const accepted = await callRoute(
          workspaceApi.runtimeAuthInput,
          {
            params: { name: "pi" },
            body: {
              attemptId: waiting.attempt!.id,
              promptId: waiting.attempt!.prompt!.id,
              value: credential,
            },
          },
          source,
        );
        assert.doesNotMatch(
          JSON.stringify(accepted),
          /transport-private|fixture-private|device_code|access_token|refresh_token/,
        );
        await until(
          async () =>
            (
              await readRoute(
                workspaceApi.runtimeAuthStatus,
                { params: { name: "pi" } },
                source,
                controller.signal,
              )
            ).attempt?.state === "complete",
        );
        const grok = await callRoute(
          workspaceApi.runtimeAuthStart,
          {
            params: { name: "grok" },
            body: {
              projectId: projectResult.id,
              provider: "xai",
              method: "oauth",
              commandId: randomUUID(),
            },
          },
          source,
        );
        let device = grok;
        await until(async () => {
          device = await readRoute(
            workspaceApi.runtimeAuthStatus,
            { params: { name: "grok" } },
            source,
            controller.signal,
          );
          return !!device.attempt?.code;
        });
        assert.equal(device.attempt?.code, "KSXH-JR4E");
        assert.equal(
          device.attempt?.url,
          "https://accounts.x.ai/oauth2/device?user_code=KSXH-JR4E",
        );
        assert.doesNotMatch(
          JSON.stringify(device),
          /device_code|access_token|refresh_token|credentials/,
        );
        const cancelled = await callRoute(
          workspaceApi.runtimeAuthCancel,
          { params: { name: "grok" }, body: { attemptId: grok.attempt!.id } },
          source,
        );
        assert.equal(cancelled.attempt?.state, "cancelled");
        assert.ok(
          events.length,
          "the real event stream is observed during authentication",
        );
        assert.doesNotMatch(
          events + logs,
          /transport-private|fixture-private|fixture-token-private/,
        );
      } finally {
        controller.abort();
        await observing;
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    clearAuthorization();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    for (const [key, descriptor] of [
      ["location", originalLocation],
      ["window", originalWindow],
    ] as const)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      if (child.connected) child.send("close");
      else child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
