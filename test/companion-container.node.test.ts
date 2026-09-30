import test from "node:test";
import assert from "node:assert/strict";
import { LocalRuntime, choices } from "../src/local-runtime.js";

test("companion refuses nested Docker before preparing helpers or credentials", async () => {
  const previous = process.env.LOOP_COMPANION_CONTAINER;
  process.env.LOOP_COMPANION_CONTAINER = "1";
  try {
    for (const execution of ["docker", "both"]) {
      const runtime = new LocalRuntime(
        "/unused-fixture",
        choices("both", execution, "/workspaces"),
      );
      await assert.rejects(
        runtime.prepare(),
        /supports --execution native only/,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.LOOP_COMPANION_CONTAINER;
    else process.env.LOOP_COMPANION_CONTAINER = previous;
  }
});

test("a corrupt baked tunnel binary is never executed and falls back to the pinned download", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { helper } = await import("../src/tunnel.js");
  const root = await mkdtemp(join(tmpdir(), "loop-baked-helper-"));
  const previous = process.env.LOOP_BAKED_HELPERS;
  const originalFetch = globalThis.fetch;
  let requested = "";
  try {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/tunnel.ts", "utf8"),
    );
    const release = source.match(/const RELEASE = "([^"]+)"/)![1];
    const baked = join(root, "baked");
    await mkdir(join(baked, "helpers", release), { recursive: true });
    await writeFile(
      join(baked, "helpers", release, "cloudflared"),
      "untrusted binary",
    );
    process.env.LOOP_BAKED_HELPERS = baked;
    globalThis.fetch = async (input) => {
      requested = String(input);
      return new Response("", { status: 503 });
    };
    await assert.rejects(
      helper(join(root, "state")),
      /download failed \(503\)/,
    );
    assert.ok(
      requested.startsWith(
        `https://github.com/cloudflare/cloudflared/releases/download/${release}/`,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.LOOP_BAKED_HELPERS;
    else process.env.LOOP_BAKED_HELPERS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped Docker command selects all four runtimes with empty preferences", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseArgs } = await import("node:util");
  const dockerfile = readFileSync("Dockerfile.companion", "utf8");
  const cmd = JSON.parse(dockerfile.match(/^CMD (.+)$/m)![1]);
  const { values, positionals } = parseArgs({
    args: cmd.slice(1),
    allowPositionals: true,
    options: {
      foreground: { type: "boolean" },
      execution: { type: "string" },
      providers: { type: "string" },
    },
  });
  assert.equal(positionals[0], "start");
  const selection = choices(
    values.providers ?? "both",
    values.execution ?? "native",
    "/workspaces",
  );
  assert.deepEqual(selection.providers, ["codex", "claude", "opencode", "pi"]);
  assert.equal(selection.execution, "native");
});
