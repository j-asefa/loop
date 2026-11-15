import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "loop-agy-enablement-"));
const originalPath = process.env.PATH;
process.env.LOOP_DATA_DIR = root;
process.env.PATH = root + delimiter + (originalPath ?? "");
const { db } = await import("../src/server/db");
const { OWNER } = await import("../src/server/workspace-identity");
const { nativeSessions } = await import("../src/server/native-sessions");
const { runtimeEnable, authOptions } =
  await import("../src/server/execution-runtime-actions");
db.prepare(
  "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES('project',?,'Project','project',0)",
).run(OWNER);
db.prepare("INSERT INTO project_paths(folder_id,path) VALUES('project',?)").run(
  root,
);
afterAll(async () => {
  await nativeSessions.close();
  db.close();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

it.each(["1.4.9", "1.5.1", "1.5.2-rc.1", "unknown"])(
  "rejects %s before new Antigravity enablement or sign-in can register or probe a session",
  async (version) => {
    const log = join(root, "calls");
    writeFileSync(log, "");
    writeFileSync(
      join(root, "agy"),
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] !== "--version") process.exit(93);
console.log(${JSON.stringify(version)});
`,
      { mode: 0o755 },
    );
    await expect(
      runtimeEnable({
        name: "antigravity",
        projectId: "project",
        billing: "existing",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      authOptions({ name: "antigravity", projectId: "project" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--version",
      "--version",
    ]);
    expect(
      nativeSessions.projects.savedRegistration("antigravity"),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT count(*) n FROM connections WHERE owner_id=?")
        .get(OWNER),
    ).toEqual({ n: 0 });
  },
);
