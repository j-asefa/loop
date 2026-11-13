import { ViewportSessionId } from "../src/shared/contract-ids.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  callRoute,
  clearAuthorization,
  fetchStream,
} from "../src/client/api.js";
import { workspaceApi } from "../src/shared/workspace-api.js";
import { MAX_UPLOAD_BYTES } from "../src/shared/uploads.js";
import { until } from "./helpers.js";

test("typed multipart routes use the compiled app without replaying writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-library-transport-"));
  const originalFetch = globalThis.fetch;
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("LOOP_")),
  );
  const child = fork(
    new URL("./fixtures/contracts-http.mjs", import.meta.url),
    [],
    {
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...environment,
        NODE_ENV: "test",
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
  const requests: string[] = [];
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
    const archive = await readFile("test/fixtures/chatgpt-export.zip");
    const bytes = Buffer.from("<p>source-private upload</p>");
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
        requests.push(url.pathname);
        return originalFetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            origin,
          },
        });
      };
      // Diagnostics has no JSON body on success. Exercise the typed caller over
      // both real transports, preserving one submission and the empty 204.
      const beforeDiagnostics = requests.filter((path) =>
        path.endsWith("/ui/viewport-diagnostics"),
      ).length;
      assert.equal(
        await callRoute(
          workspaceApi.viewportDiagnostics,
          {
            body: {
              session: ViewportSessionId.parse(randomUUID()),
              samples: [
                {
                  elapsed: 1,
                  viewport: Array(9).fill(0),
                  dialog: [],
                  header: [],
                  input: [],
                  body: [],
                  flags: Array(8).fill(0),
                },
              ],
            },
          },
          source,
        ),
        undefined,
      );
      assert.equal(
        requests.filter((path) => path.endsWith("/ui/viewport-diagnostics"))
          .length,
        beforeDiagnostics + 1,
      );
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
  } finally {
    globalThis.fetch = originalFetch;
    clearAuthorization();
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
