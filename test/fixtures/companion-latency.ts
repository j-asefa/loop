import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { gitProject } from "../git-project.js";

const directory = process.env.LOOP55_DATA_DIR!;
const project = join(directory, "project");
mkdirSync(project);
gitProject(project);
const { WorkspaceHost } = await import("../../src/workspace-host.js");
const { db } = await import("../../src/server/db.js");
const options = {
  harness: "codex" as const,
  version: "fixture",
  project,
  executable: resolve("test/harness.mjs"),
  billing: "existing" as const,
};
const host = new WorkspaceHost(directory, options);
await host.start(options);
process.send!({ origin: host.origin, pair: host.pair().url });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await host.close();
  db.close();
  process.exit(0);
};
process.on("message", () => void stop());
process.on("disconnect", () => void stop());
