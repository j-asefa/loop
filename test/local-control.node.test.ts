import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonClient, ControlError } from "../src/local-control.js";
import { control } from "../src/host-control.js";
import { connectionControl } from "../src/connection.js";

async function fixture(t: TestContext, unix = false) {
  const dir = await mkdtemp(join(tmpdir(), "loop-json-client-"));
  const counts = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const path = req.url!;
    const operation = path.replace(/^\/v1/, "");
    counts.set(path, (counts.get(path) ?? 0) + 1);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (operation === "/split") {
      const bytes = Buffer.from(JSON.stringify({ text: "€" }));
      const split = bytes.indexOf(Buffer.from("€")) + 1;
      res.write(bytes.subarray(0, split));
      setTimeout(() => res.end(bytes.subarray(split)), 10);
    } else if (operation === "/bad") res.end("{");
    else if (operation === "/large") res.end(JSON.stringify("x".repeat(64)));
    else if (operation === "/unicode-limit")
      res.end(JSON.stringify("€".repeat(10)));
    else if (operation === "/refused") {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "Generation refused" }));
    } else if (operation === "/null-error") {
      res.statusCode = 503;
      res.end("null");
    } else if (operation === "/broken") {
      res.setHeader("Content-Length", "100");
      res.write("{");
      setTimeout(() => res.destroy(), 10);
    } else if (operation !== "/slow") {
      res.end(
        JSON.stringify({
          authorization: req.headers.authorization,
          method: req.method,
          input: chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString())
            : null,
        }),
      );
    }
  });
  const socketPath = join(dir, "control.sock");
  await new Promise<void>((resolve) =>
    unix
      ? server.listen(socketPath, resolve)
      : server.listen(0, "127.0.0.1", resolve),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const target = unix
    ? { socketPath }
    : { port: (server.address() as AddressInfo).port };
  return { target, dir, counts, socketPath };
}

test(
  "local JSON transport decodes whole responses and settles failures without replay",
  { timeout: 10000 },
  async (t) => {
    const { target, counts } = await fixture(t);
    const send = jsonClient(target, "fixture-token");
    assert.deepEqual(await send("/ok", { body: { hello: "€" } }), {
      authorization: "Bearer fixture-token",
      method: "POST",
      input: { hello: "€" },
    });
    assert.deepEqual(await send("/split"), { text: "€" });
    await assert.rejects(send("/bad"), /Invalid local control response/);
    await assert.rejects(send("/large", { maxBytes: 16 }), /too large/);
    await assert.rejects(send("/unicode-limit", { maxBytes: 20 }), /too large/);
    await assert.rejects(
      send("/refused"),
      (error) =>
        error instanceof ControlError &&
        error.status === 409 &&
        error.message === "Generation refused",
    );
    await assert.rejects(
      send("/null-error"),
      (error) =>
        error instanceof ControlError &&
        error.status === 503 &&
        error.message === "Local control request failed",
    );
    await assert.rejects(send("/broken"), /interrupted|aborted/);
    await assert.rejects(send("/slow", { timeout: 30 }), /timed out/);
    assert.equal(counts.size, 9);
    for (const count of counts.values())
      assert.equal(count, 1, "transport never repeats a request");
  },
);

test("host control preserves UTF-8 across response chunk boundaries", async (t) => {
  const { target, dir } = await fixture(t);
  assert("port" in target);
  await writeFile(
    join(dir, "control.json"),
    JSON.stringify({ port: target.port, token: "fixture-token" }),
  );
  assert.deepEqual(await control(dir, "split"), { text: "€" });
});

test(
  "connection control uses the private Unix socket and preserves error status",
  { skip: process.platform === "win32" },
  async (t) => {
    const { socketPath } = await fixture(t, true);
    const record = { control: socketPath, token: "fixture-token" };
    assert.deepEqual(await connectionControl(record, "hello", { hello: 1 }), {
      authorization: "Bearer fixture-token",
      method: "POST",
      input: { hello: 1 },
    });
    await assert.rejects(
      connectionControl(record, "refused"),
      (error) =>
        error instanceof ControlError &&
        error.status === 409 &&
        error.message === "Generation refused",
    );
    assert.deepEqual(
      await jsonClient({ socketPath })("/get", { method: "GET" }),
      { method: "GET", input: null },
    );
  },
);
