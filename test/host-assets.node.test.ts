import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

test("companion host serves replacement robots at current and legacy avatar URLs", async () => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(join(resolve(".tmp"), "loop-avatar-host-"));
  let host: import("../src/host.js").Host | undefined;
  try {
    // Compile the production host beside an isolated copy of its shipped assets.
    await build({
      entryPoints: ["src/host.ts"],
      outfile: join(dir, "host.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const artwork = resolve("public/avatars/robots");
    await cp(artwork, join(dir, "web/avatars/robots"), { recursive: true });
    await writeFile(join(dir, "private.webp"), "private fixture");
    const { Host } = (await import(
      pathToFileURL(join(dir, "host.mjs")).href
    )) as typeof import("../src/host.js");
    host = new Host(join(dir, "state"), {
      harness: "codex",
      version: "fixture",
      project: dir,
      billing: { mode: "existing", description: "fixture only" },
      capabilities: {
        approvals: false,
        questions: false,
        resume: false,
        liveAttach: false,
        terminal: false,
      },
    });
    host.workspace = {
      http: () => assert.fail("Asset requests must be handled by the host"),
      status: () => ({}),
      admin: async () => ({}),
      connect: () => () => {},
      originChanged: () => {},
    };
    await host.listen();
    const names = (await readdir(artwork)).filter((name) =>
      name.endsWith(".webp"),
    );
    assert.equal(names.length, 100);
    for (const name of names) {
      const expected = await readFile(join(artwork, name));
      for (const prefix of ["/avatars/", "/avatars/robots/"]) {
        const response: Response = await fetch(host.origin + prefix + name);
        assert.equal(response.status, 200, prefix + name);
        assert.equal(response.headers.get("content-type"), "image/webp");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
      }
    }
    assert.equal(
      (await fetch(host.origin + "/avatars/%2e%2e%2f%2e%2e%2fprivate.webp"))
        .status,
      404,
      "The compatibility mapping must preserve the public-root boundary",
    );
    assert.equal((await fetch(host.origin + "/api/agents")).status, 401);
  } finally {
    await host?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
