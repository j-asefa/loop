// Native protocol fixture: synthetic API credentials, no prompts or inference.
// Usage: node native/check-pi-discovery.mjs /absolute/path/to/pi [service.mjs]
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Provide the pinned Pi executable");
const root = await mkdtemp(join(tmpdir(), "loop-pi-discovery-"));
try {
  let service = process.argv[3];
  if (!service) {
    const { buildNativeAuth } =
      await import("../scripts/build-native-auth.mjs");
    await buildNativeAuth(join(root, "bundle"));
    service = join(root, "bundle/native-auth/service.mjs");
  }
  const { discoverPi, inspectPiAuth, logoutPi } = await import(
    pathToFileURL(resolve(service)).href
  );
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const options = {
    executable: resolve(process.argv[2]),
    project: root,
    env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir },
  };
  const empty = await discoverPi(options);
  assert.equal(empty.authenticated, false);
  assert.equal(empty.authMethod, "existing");
  assert.deepEqual(empty.models, []);
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      openai: { type: "api_key", key: "synthetic-pi-fixture-key" },
    }),
    { mode: 0o600 },
  );
  const status = await inspectPiAuth(options);
  assert.equal(status.authenticated, true);
  assert.ok(status.providers.includes("openai"));
  const result = await discoverPi(options);
  assert.equal(result.authMethod, "existing");
  assert.equal(result.authenticated, true);
  assert.ok(result.models.length > 0);
  assert.ok(result.models.every((model) => model.id.startsWith("openai/")));
  assert.ok(!JSON.stringify(result).includes("synthetic-pi-fixture-key"));
  await logoutPi(options);
  await logoutPi(options); // Repeat sign-out is harmless.
  assert.equal((await inspectPiAuth(options)).authenticated, false);
  assert.deepEqual((await discoverPi(options)).models, []);
  console.log(
    JSON.stringify({
      nativePiDiscovery: "passed",
      models: result.models.length,
      credentialRemoval: "passed",
      nativeLogout: "passed",
      inference: "not_run",
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
