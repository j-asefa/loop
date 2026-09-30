// Native protocol fixture only: synthetic OAuth, no model requests.
// Usage: node native/check-opencode-discovery.mjs /absolute/path/to/guarded-opencode [runner-service.mjs]
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Provide the guarded OpenCode executable");
const root = await mkdtemp(join(tmpdir(), "loop-native-discovery-"));
try {
  let service = process.argv[3];
  if (!service) {
    const { buildNativeAuth } = await import("../scripts/build-native-auth.mjs");
    await buildNativeAuth(join(root, "bundle"));
    service = join(root, "bundle/native-auth/service.mjs");
  }
  const { discoverOpencode, logoutOpencode } = await import(
    pathToFileURL(resolve(service)).href
  );
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENAI_API_KEY: "forbidden-fixture-key",
    OPENCODE_CONFIG_CONTENT: '{"enabled_providers":["unsafe"]}',
  };
  await mkdir(join(root, "data/opencode"), { recursive: true });
  const authPath = join(root, "data/opencode/auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 9999999999999,
      },
    }),
    { mode: 0o600 },
  );
  const options = { executable: resolve(process.argv[2]), project: root, env };
  const result = await discoverOpencode(options);
  assert.equal(result.authenticated, true);
  assert.equal(result.executionGuard, "loop-subscription-v1");
  assert.ok(result.models.length > 0);
  assert.ok(result.models.every((model) => model.id.startsWith("openai/")));
  assert.ok(!JSON.stringify(result).includes("fixture-access"));
  await writeFile(
    authPath,
    JSON.stringify({ openai: { type: "api", key: "fixture-key" } }),
  );
  assert.equal((await discoverOpencode(options)).authenticated, false);
  const unrelated = { type: "api", key: "unrelated-fixture-key" };
  for (const openai of [
    {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 9999999999999,
    },
    { type: "api", key: "fixture-key" },
  ]) {
    await writeFile(authPath, JSON.stringify({ openai, unrelated }));
    await logoutOpencode(options);
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(stored.openai, undefined);
    assert.deepEqual(stored.unrelated, unrelated);
    assert.equal((await discoverOpencode(options)).authenticated, false);
  }
  // Already signed-out is an idempotent native operation.
  await logoutOpencode(options);
  assert.deepEqual(
    JSON.parse(await readFile(authPath, "utf8")).unrelated,
    unrelated,
  );
  console.log(
    JSON.stringify({
      nativeDiscovery: "passed",
      models: result.models.length,
      authChange: "rejected",
      nativeLogout: "passed",
      unrelatedCredentials: "preserved",
      inference: "not_run",
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
