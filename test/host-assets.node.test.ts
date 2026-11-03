import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { gunzipSync } from "node:zlib";
import { rawGet } from "./helpers/raw-http.js";

test("companion assets compress, cache and revalidate without caching entrypoints", async () => {
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
    await mkdir(join(dir, "web/assets"));
    const script =
      "export const data = " + JSON.stringify("fixture ".repeat(2000));
    for (const path of [
      "assets/index-Abcd_123.js",
      "assets/unversioned.js",
      "app.js",
    ])
      await writeFile(join(dir, "web", path), script);
    for (const path of ["index.html", "sw.js", "manifest.webmanifest"])
      await writeFile(join(dir, "web", path), "entrypoint");
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
        assert.equal(
          response.headers.get("cache-control"),
          "public, max-age=0, must-revalidate",
        );
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
      }
    }
    const scriptPath = "/assets/index-Abcd_123.js";
    const plain = await rawGet(host.origin + scriptPath);
    assert.equal(plain.body.toString(), script);
    assert.equal(plain.headers["content-encoding"], undefined);
    const compressed = await rawGet(host.origin + scriptPath, {
      "accept-encoding": "gzip",
    });
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.equal(
      compressed.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
    assert.match(String(compressed.headers.vary), /Accept-Encoding/i);
    assert.equal(gunzipSync(compressed.body).toString(), script);
    assert(compressed.body.length < plain.body.length / 2);
    const cached = await rawGet(host.origin + scriptPath, {
      "accept-encoding": "gzip",
      "if-none-match": String(compressed.headers.etag),
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.match(String(cached.headers.vary), /Accept-Encoding/i);
    const avatarPath = "/avatars/atlas.webp";
    const avatar = await rawGet(host.origin + avatarPath);
    const cachedAvatar = await rawGet(host.origin + avatarPath, {
      "if-none-match": `"unrelated", ${String(avatar.headers.etag).slice(2)}`,
    });
    assert.equal(cachedAvatar.status, 304);
    assert.equal(cachedAvatar.body.length, 0);
    // Stable URLs must pick up replacement artwork after a deployment.
    await writeFile(join(dir, "web/avatars/robots/atlas.webp"), "new artwork");
    await utimes(
      join(dir, "web/avatars/robots/atlas.webp"),
      new Date(),
      new Date(Date.now() + 2000),
    );
    const replaced = await rawGet(host.origin + avatarPath, {
      "if-none-match": String(avatar.headers.etag),
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.toString(), "new artwork");
    assert.notEqual(replaced.headers.etag, avatar.headers.etag);
    for (const path of [
      "/",
      "/sw.js",
      "/manifest.webmanifest",
      "/app.js",
      "/assets/unversioned.js",
    ]) {
      const response = await rawGet(host.origin + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers["cache-control"], "no-store", path);
    }
    assert.equal(
      (await fetch(host.origin + "/avatars/%2e%2e%2f%2e%2e%2fprivate.webp"))
        .status,
      404,
      "The compatibility mapping must preserve the public-root boundary",
    );
    const denied = await rawGet(host.origin + "/api/agents");
    assert.equal(denied.status, 401);
    assert.equal(denied.headers["cache-control"], "no-store");
  } finally {
    await host?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
