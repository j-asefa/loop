import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  callRoute,
  clearAuthorization,
  fetchStream,
} from "../src/client/api.js";
import { workspaceApi } from "../src/shared/workspace-api.js";
import { MAX_UPLOAD_BYTES } from "../src/shared/uploads.js";
import { Host } from "../src/host.js";
import { composeSourceId } from "../src/linked-docker.js";
import { until } from "./helpers.js";

test("typed multipart and runtime routes use the compiled app directly and through the paired Docker proxy without replaying writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-library-transport-"));
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
  const { codexFixture, fixtureToken } = await import(
    resolve("test/helpers/codex-server.mjs")
  );
  const codex = await codexFixture();
  const child = fork(
    new URL("./fixtures/contracts-http.mjs", import.meta.url),
    [],
    {
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...environment,
        NODE_ENV: "test",
        LOOP_PROFILE: "server",
        LOOP_ALLOWED_RUNTIME_ORIGINS: new URL(codex.url).origin,
        LOOP_AUTH_MODE: "single-user",
        LOOP_DATA_DIR: join(directory, "data"),
        LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      },
    },
  );
  let logs = "",
    port = 0,
    host: Host | undefined;
  child.stdout!.on("data", (data) => {
    logs += data;
  });
  child.stderr!.on("data", (data) => {
    logs += data;
  });
  child.on("message", (message) => {
    port = (message as { port: number }).port;
  });
  const requests: string[] = [];
  try {
    await until(() => {
      assert.equal(child.exitCode, null, logs);
      return port !== 0;
    });
    const direct = `http://127.0.0.1:${port}`;
    const container = "c".repeat(64);
    await writeFile(
      join(directory, "inspect.json"),
      JSON.stringify([
        {
          Id: container,
          Config: {
            Labels: {
              "com.docker.compose.project": "contracts",
              "com.docker.compose.service": "app",
            },
          },
          State: { Running: true },
          NetworkSettings: {
            Ports: {
              "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }],
            },
          },
        },
      ]),
    );
    const docker = join(directory, "docker");
    await writeFile(
      docker,
      `#!/bin/sh\nif [ "$1" = ps ]; then echo '${container}'; else cat '${directory}/inspect.json'; fi\n`,
    );
    await chmod(docker, 0o755);
    process.env.PATH = directory + ":" + (originalPath || "");
    host = new Host(directory, {
      harness: "codex",
      version: "fixture",
      project: "/fixture",
      billing: { mode: "existing", description: "fixture" },
      capabilities: {
        approvals: true,
        questions: true,
        resume: true,
        liveAttach: false,
        terminal: false,
      },
    });
    let localRequests = 0;
    host.workspace = {
      http: (_req, res) => {
        localRequests++;
        res.writeHead(500);
        res.end();
      },
      status: () => ({}),
      admin: async () => ({}),
      connect: () => () => {},
      originChanged: () => {},
    };
    await host.listen();
    const secret = new URL(host.pair().url).hash.slice(6);
    const paired = await originalFetch(host.origin + "/pair", {
      method: "POST",
      headers: { origin: host.origin, "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const sourceId = `docker:${composeSourceId("contracts", "app")}`;
    const sources = await originalFetch(host.origin + "/api/agent-sources", {
      headers: { cookie },
    }).then((r) => r.json());
    assert.ok(sources.some((source: { id: string }) => source.id === sourceId));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: new EventTarget(),
    });
    const archive = await readFile("test/fixtures/chatgpt-export.zip");
    const bytes = Buffer.from("<p>source-private upload</p>");
    for (const [origin, source] of [
      [direct, ""],
      [host.origin, sourceId],
    ]) {
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
        requests.push(url.pathname);
        return originalFetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            origin,
            ...(source ? { cookie } : {}),
          },
        });
      };
      const runtime = await callRoute(
        workspaceApi.runtimeHostCreate,
        {
          body: {
            name: "Contract runtime",
            url: codex.url,
            token: fixtureToken,
            kind: "codex-app-server",
          },
        },
        source,
      );
      assert.ok(
        (await callRoute(workspaceApi.runtimeHostList, {}, source)).some(
          (item) => item.id === runtime.id,
        ),
      );
      const subscription = await callRoute(
        workspaceApi.subscriptionCreate,
        {
          body: {
            provider: "codex",
            label: "Contract account",
            runtimeHostId: runtime.id,
          },
        },
        source,
      );
      const status = await callRoute(
        workspaceApi.subscriptionAction,
        { params: { id: subscription.id, action: "status" }, body: {} },
        source,
      );
      assert.ok("authenticated" in status && status.authenticated);
      assert.doesNotMatch(
        JSON.stringify(status),
        /device_code|access_token|refresh_token|secret/,
      );
      assert.ok(!JSON.stringify(status).includes(fixtureToken));
      const folder = await callRoute(
        workspaceApi.folderCreate,
        { body: { name: source || "direct", kind: "project" } },
        source,
      );
      const upload = await callRoute(
        workspaceApi.uploadCreate,
        {
          body: { folderId: folder.id },
          file: new Blob([bytes], { type: "text/html" }),
          filename: "private.html",
        },
        source,
      );
      assert.equal(upload.size, bytes.length);
      const response = await fetchStream(
        workspaceApi.objectFile,
        { params: { id: upload.objectId }, query: { preview: "html" } },
        source,
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-security-policy")!, /sandbox/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const repeated = await fetchStream(
        workspaceApi.objectFile,
        {
          params: { id: upload.objectId },
          query: { preview: ["html", "html"] },
        },
        source,
      );
      assert.equal(
        repeated.status,
        200,
        repeated.ok ? "" : await repeated.text(),
      );
      assert.equal(
        repeated.headers.get("content-type"),
        "application/octet-stream",
      );
      const preview = await callRoute(
        workspaceApi.importPreview,
        { file: new Blob([archive]), filename: "export.zip" },
        source,
      );
      assert.ok(preview.summary.messages > 0);
      const receipt = await callRoute(
        workspaceApi.importStart,
        { params: { id: preview.id } },
        source,
      );
      assert.ok("id" in receipt);
      await callRoute(
        workspaceApi.importCancel,
        { params: { id: preview.id } },
        source,
      );
      const uploadRequests = () =>
        requests.filter((path) => path.endsWith("/uploads")).length;
      const start = uploadRequests();
      await assert.rejects(
        callRoute(
          workspaceApi.uploadCreate,
          {
            file: new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)]),
            filename: "large.bin",
          },
          source,
        ),
        { status: 413 },
      );
      assert.equal(
        uploadRequests() - start,
        1,
        "refused writes are not retried",
      );
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(
        callRoute(
          workspaceApi.uploadCreate,
          { file: new Blob([bytes]), filename: "aborted.html" },
          source,
          abort.signal,
        ),
        { name: "AbortError" },
      );
      const transport = globalThis.fetch;
      let mutations = 0;
      globalThis.fetch = async (input, init) => {
        const result = await transport(input, init);
        if (init?.method === "POST") {
          mutations++;
          await result.arrayBuffer();
          throw new TypeError("Connection lost after commit");
        }
        return result;
      };
      await assert.rejects(
        callRoute(
          workspaceApi.uploadCreate,
          {
            body: { folderId: folder.id },
            file: new Blob([bytes]),
            filename: "uncertain.html",
          },
          source,
        ),
      );
      assert.equal(
        mutations,
        1,
        "an uncertain committed upload is not replayed",
      );
      globalThis.fetch = transport;
      const listed = await callRoute(
        workspaceApi.artifactList,
        { query: { folder: folder.id } },
        source,
      );
      assert.equal(
        listed.items.length,
        2,
        "only the two successful uploads were stored in this project",
      );
      assert.ok(!listed.items.some((item) => item.title === "aborted.html"));
    }
    assert.equal(
      localRequests,
      0,
      "linked reads and writes never reach the paired host's local workspace",
    );
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
    await host?.close();
    await codex.close();
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      if (child.connected) child.send("close");
      else child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
