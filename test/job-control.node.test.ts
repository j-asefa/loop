import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { cancelQueuedJob } from "../deployment/job-client.mjs";
import { underlyingCommand } from "../deployment/job-executables.mjs";
import { signedMessage } from "../deployment/job-protocol.mjs";

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function withListener(
  run: (context: {
    directory: string;
    descriptor: string;
    key: string;
    identity: string;
  }) => Promise<void>,
  reply: (
    socket: Socket,
    request: ReturnType<typeof signedMessage>,
    key: string,
    directory: string,
  ) => Promise<void> | void,
) {
  const directory = mkdtempSync(join(tmpdir(), "loop-job-control-"));
  const identity = randomUUID(),
    key = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let failure: unknown;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "",
      replied = false;
    socket.on("data", (chunk) => {
      if (replied) return;
      input += chunk;
      if (!input.includes("\n")) return;
      replied = true;
      try {
        assert.equal(
          input.includes(key),
          false,
          "the private key never crosses the connection",
        );
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        void Promise.resolve(reply(socket, request, key, directory)).catch(
          (error) => {
            failure = error;
            socket.destroy();
          },
        );
      } catch (error) {
        failure = error;
        socket.destroy();
      }
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    mkdirSync(join(directory, "job-" + identity), { mode: 0o700 });
    const descriptor = join(directory, "job-" + identity, "control.json");
    writeFileSync(descriptor, JSON.stringify({ port, key }), { mode: 0o600 });
    await run({ directory, descriptor, key, identity });
    if (failure) throw failure;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
}

async function worker(descriptor: string) {
  const child = spawn(
    process.execPath,
    [resolve("deployment/job-worker.mjs"), descriptor],
    { stdio: "ignore" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code] = await once(child, "close");
    return code;
  } finally {
    clearTimeout(timer);
  }
}

test("a replacement control listener cannot authorize a worker or reflect its proof", async () => {
  for (const attack of [
    "unsigned",
    "reflected",
    "wrong-key",
    "old-connection",
    "tampered",
  ]) {
    await withListener(
      async ({ descriptor, directory }) => {
        assert.equal(await worker(descriptor), 125, attack);
        assert.equal(
          existsSync(join(directory, "must-not-run")),
          false,
          attack,
        );
      },
      (socket, request, key, directory) => {
        const execute = {
          command: process.execPath,
          args: [
            "-e",
            "require('fs').writeFileSync(" +
              JSON.stringify(join(directory, "must-not-run")) +
              ",'bad')",
          ],
          cwd: directory,
          env: { PATH: process.env.PATH },
          stdio: "ignore",
          label: "spoof fixture",
        };
        const response =
          attack === "unsigned"
            ? { execute }
            : attack === "reflected"
              ? request
              : signedMessage(
                  attack === "wrong-key" ? "0".repeat(64) : key,
                  attack === "old-connection" ? "0".repeat(64) : request.nonce,
                  "response",
                  { execute },
                );
        if (attack === "tampered" && "body" in response)
          response.body = {
            execute: { ...execute, label: "modified payload" },
          };
        socket.end(JSON.stringify(response) + "\n");
      },
    );
  }
});

test("split UTF-8 characters preserve authenticated arguments, environment and working directory", async () => {
  const unicode = "café-😀-東京";
  await withListener(
    async ({ descriptor, directory }) => {
      assert.equal(await worker(descriptor), 0);
      const observed = JSON.parse(
        readFileSync(join(directory, "observed.json"), "utf8"),
      );
      assert.deepEqual(observed, {
        argument: unicode,
        env: unicode,
        cwd: join(directory, unicode),
      });
    },
    async (socket, request, key, directory) => {
      const cwd = join(directory, unicode);
      mkdirSync(cwd);
      const execute = {
        command: process.execPath,
        args: [
          "-e",
          "require('fs').writeFileSync(" +
            JSON.stringify(join(directory, "observed.json")) +
            ",JSON.stringify({argument:process.argv[1],env:process.env.UNICODE_FIXTURE,cwd:process.cwd()}))",
          unicode,
        ],
        cwd,
        env: { PATH: process.env.PATH, UNICODE_FIXTURE: unicode },
        stdio: "ignore",
        label: "Unicode fixture",
      };
      const bytes = Buffer.from(
        JSON.stringify(
          signedMessage(key, request.nonce, "response", { execute }),
        ) + "\n",
      );
      const split = bytes.indexOf(Buffer.from("é")) + 1;
      assert.ok(split > 0);
      socket.write(bytes.subarray(0, split));
      await delay(50);
      socket.write(bytes.subarray(split));
    },
  );
});

test("operator cancellation rejects an unauthenticated acknowledgement without disclosing its key", async () => {
  await withListener(
    async ({ directory, identity }) => {
      await assert.rejects(
        cancelQueuedJob(
          {
            pueue: "/unused",
            config: "/unused",
            group: "loop-heavy",
            jobs: directory,
          },
          identity,
        ),
        /unavailable/,
      );
    },
    (socket) => {
      socket.end('{"cancelled":true}\n');
    },
  );
});

test("reinstall discovers executable replacements and never selects its own shims", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loop-job-executables-"));
  try {
    const bin = join(directory, "shims"),
      replacement = join(directory, "replacement"),
      old = join(directory, "old");
    for (const path of [bin, replacement, old]) mkdirSync(path);
    for (const program of ["npm", "npx"]) {
      writeFileSync(join(bin, program), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      writeFileSync(join(replacement, program), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
    }
    // Executable directories and stale or non-executable files are not commands.
    mkdirSync(join(old, "npm"));
    writeFileSync(join(old, "npx"), "#!/bin/sh\n", { mode: 0o600 });
    const alias = join(directory, "shim-alias");
    symlinkSync(bin, alias);
    const options = {
      bin,
      node: process.execPath,
      path: [alias, old, replacement].join(delimiter),
    };
    for (const commands of [
      { node: "/missing/node", npm: "/missing/npm", npx: "/missing/npx" },
      { node: "/missing/node", npm: join(old, "npm"), npx: join(old, "npx") },
      { node: "/missing/node", npm: join(bin, "npm"), npx: join(alias, "npx") },
    ]) {
      const input = { ...options, previous: { commands } };
      assert.equal(await underlyingCommand("node", input), process.execPath);
      for (const name of ["npm", "npx"])
        assert.equal(
          await underlyingCommand(name, input),
          join(replacement, name),
        );
    }
    await assert.rejects(
      underlyingCommand("npm", { ...options, path: bin }),
      /Cannot find/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
