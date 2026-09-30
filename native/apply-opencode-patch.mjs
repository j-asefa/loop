import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const auditedCommit = "545f51d26cc39a907d2867492d498d9607ea5fa4";

// Context matches must be unique. Stage every edit before touching the checkout.
export function patchSources(read) {
  const changes = new Map();
  function edit(path, from, to) {
    const source = changes.get(path) ?? read(path);
    if (source.split(from).length !== 2)
      throw new Error("OpenCode patch context missing or ambiguous: " + path);
    changes.set(path, source.replace(from, to));
  }
  const provider = "packages/opencode/src/provider/provider.ts";
  edit(
    provider,
    'import os from "os"',
    'import { guardSDK } from "../loop-execution-guard"\nimport os from "os"',
  );
  edit(
    provider,
    "        const key = Hash.fast(\n",
    "        guardSDK(model, provider, options)\n\n        const key = Hash.fast(\n",
  );
  const oauth = "packages/opencode/src/plugin/openai/codex.ts";
  edit(
    oauth,
    'import os from "os"',
    'import { guardOAuth } from "../../loop-execution-guard"\nimport os from "os"',
  );
  edit(
    oauth,
    "            const currentAuth = await getAuth()\n",
    "            const currentAuth = await getAuth()\n            guardOAuth(currentAuth, requestInput)\n",
  );
  const llm = "packages/opencode/src/session/llm.ts";
  edit(
    llm,
    "import { LayerNode }",
    'import { guardRuntime } from "../loop-execution-guard"\nimport { LayerNode }',
  );
  edit(
    llm,
    '    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {\n',
    '    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {\n      guardRuntime(flags)\n',
  );
  const health =
    "packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts";
  edit(
    health,
    "import { Config }",
    'import { executionGuardStatus } from "@/loop-execution-guard"\nimport { Config }',
  );
  edit(
    health,
    "return { healthy: true as const, version: InstallationVersion }",
    "return { healthy: true as const, version: InstallationVersion, loopExecutionGuard: executionGuardStatus() }",
  );
  edit(
    "packages/opencode/src/server/routes/instance/httpapi/groups/global.ts",
    "  healthy: Schema.Literal(true),\n  version: Schema.String,",
    "  healthy: Schema.Literal(true),\n  version: Schema.String,\n  loopExecutionGuard: Schema.Struct({ revision: Schema.String, active: Schema.Boolean }),",
  );
  return changes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (
    !root ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim() !== auditedCommit
  )
    throw new Error("Requires exact audited OpenCode source commit");
  const originals = new Map();
  const changes = patchSources((path) => {
    const source = execFileSync("git", ["show", "HEAD:" + path], {
      cwd: root,
      encoding: "utf8",
    });
    originals.set(path, source);
    return source;
  });
  changes.set(
    "packages/opencode/src/loop-execution-guard.ts",
    readFileSync(
      new URL("./opencode-execution-guard.ts", import.meta.url),
      "utf8",
    ),
  );
  for (const [path, content] of changes) {
    const destination = join(root, path);
    if (!existsSync(destination)) {
      if (originals.has(path))
        throw new Error("OpenCode source missing: " + path);
      continue;
    }
    const current = readFileSync(destination, "utf8");
    if (current !== content && current !== originals.get(path))
      throw new Error("Preserving existing OpenCode changes: " + path);
  }
  for (const [path, content] of changes)
    writeFileSync(join(root, path), content);
}
