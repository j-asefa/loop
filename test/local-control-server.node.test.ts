import test from "node:test";
import assert from "node:assert/strict";
import { request, type RequestOptions } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "./helpers/gateway.js";
import { Problem } from "../src/shared/problem.js";
import { control } from "../src/host-control.js";
import { ControlError } from "../src/local-control.js";

function send(options: RequestOptions, chunks: Buffer[] = [Buffer.from("{}")]) {
  return new Promise<{ status: number; value: any }>((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", method: "POST", ...options },
      (res) => {
        const response: Buffer[] = [];
        res.on("data", (chunk) => response.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode!,
              value: JSON.parse(Buffer.concat(response).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () =>
      req.destroy(new Error("Fixture request timed out")),
    );
    void (async () => {
      for (let index = 0; index < chunks.length; index++) {
        req.write(chunks[index]);
        if (index + 1 < chunks.length)
          await new Promise((resolve) => setTimeout(resolve, 20));
      }
      req.end();
    })().catch(reject);
  });
}

test("host control preserves safe problems and refuses malformed authentication", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "loop-control-server-"));
  const host = createHost(dir);
  t.after(async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  });
  let calls = 0;
  host.workspace.admin = async (path, input) => {
    calls++;
    if (path === "/enable")
      throw new Problem(409, "Choose an installed runtime.", {
        private: "/private/fixture-secret",
      });
    if (path === "/internal") throw new Error("/private/fixture-secret");
    return input;
  };
  await host.listen();
  const record = JSON.parse(await readFile(join(dir, "control.json"), "utf8"));
  const headers = {
    authorization: "Bearer " + record.token,
    "content-type": "application/json",
  };
  const target = { port: record.port, path: "/echo", headers };
  assert.deepEqual(
    await send({
      ...target,
      headers: {
        ...headers,
        authorization: "Bearer " + "é".repeat(record.token.length),
      },
    }),
    {
      status: 403,
      value: { error: "Local control authentication required" },
    },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    control(dir, "enable"),
    (error) =>
      error instanceof ControlError &&
      error.status === 409 &&
      error.message === "Choose an installed runtime.",
  );
  assert.deepEqual(await send({ ...target, path: "/internal" }), {
    status: 400,
    value: { error: "Invalid control request" },
  });
  for (const chunks of [
    [],
    [Buffer.from("{")],
    [Buffer.from(JSON.stringify("x".repeat(100000)))],
  ]) {
    assert.equal((await send(target, chunks)).status, 400);
  }
  assert.equal(
    (
      await send({
        ...target,
        headers: { authorization: headers.authorization },
      })
    ).status,
    400,
  );
  assert.equal((await send({ ...target, method: "GET" })).status, 405);
  assert.equal(
    (
      await send({
        ...target,
        headers: { ...headers, origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const bytes = Buffer.from(JSON.stringify({ text: "€" }));
  const split = bytes.indexOf(Buffer.from("€")) + 1;
  assert.deepEqual(
    await send(target, [bytes.subarray(0, split), bytes.subarray(split)]),
    { status: 200, value: { text: "€" } },
  );
  const boundary = JSON.stringify("x".repeat(99998));
  assert.equal(Buffer.byteLength(boundary), 100000);
  assert.equal((await send(target, [Buffer.from(boundary)])).status, 200);
  assert.equal(calls, 4, "invalid input never reaches workspace dispatch");
});

test("the public host exposes Problem messages but hides arbitrary errors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "loop-host-problem-"));
  const host = createHost(dir);
  t.after(async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  });
  await host.listen();
  const secret = new URL(host.pair().url).hash.slice(6);
  const paired = await fetch(host.origin + "/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: host.origin },
    body: JSON.stringify({ secret }),
  });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get("set-cookie")!.split(";")[0];
  for (const [error, status, message] of [
    [
      new Problem(409, "Refresh the workspace state.", {
        private: "/private/fixture-secret",
      }),
      409,
      "Refresh the workspace state.",
    ],
    [
      new Error("/private/fixture-secret"),
      400,
      "Invalid request or unavailable asset.",
    ],
  ] as const) {
    host.workspace.http = () => {
      throw error;
    };
    const response = await fetch(host.origin + "/api/agents", {
      headers: { cookie },
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: message });
  }
});
