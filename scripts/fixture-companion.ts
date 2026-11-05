// Companion workspace for browser fixtures: the production WorkspaceHost on
// loopback, launched without enabling a harness (as when the runtime is chosen
// later in the app) and without an execution process, so seeded runs keep the
// states the fixture gives them. Prints its origin and a device pairing link
// once listening; the caller pairs and seeds connections and data itself.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

process.env.LOOP_PROFILE = "companion";
await import("../test/helpers/install");
const { WorkspaceHost } = await import("../src/workspace-host");
const dir = process.env.LOOP_DATA_DIR;
if (!dir) throw new Error("LOOP_DATA_DIR is required");
const options = {
  harness: "codex" as const,
  version: "fixture",
  project: join(dir, "fixture"),
  executable: resolve("test/harness.mjs"),
  billing: "existing" as const,
};
mkdirSync(options.project, { recursive: true });
const inert = {
  open: async () => {},
  schedule: async () => {},
  close: async () => {},
};
const host = new WorkspaceHost(dir, options, inert);
await host.start(options, undefined, undefined, true);
console.log(JSON.stringify({ origin: host.origin, pair: host.pair().url }));
const stop = () => {
  void host.close().finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
