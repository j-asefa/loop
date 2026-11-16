import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Harness = "codex" | "pi";
type Reply = { result?: unknown; error?: unknown; waitFor?: string };
type Observation = {
  type: "launch" | "request";
  harness: Harness;
  cwd: string;
  method?: string;
  params?: { cwd?: string; cwds?: string[]; threadId?: string };
};

/** Explicit subprocesses and wire replies; no adapter internals are replaced. */
export function harnessFixture(directory: string) {
  const root = join(directory, "fixture-harnesses");
  mkdirSync(root);
  const control = join(root, "replies.json");
  const audit = join(root, "audit.jsonl");
  let replies: Record<Harness, Record<string, Reply>>;
  let gate = 0;
  const save = () => {
    writeFileSync(control + ".next", JSON.stringify(replies));
    renameSync(control + ".next", control);
  };
  const reset = () => {
    replies = {
      codex: {},
      pi: {
        get_commands: {
          result: {
            commands: [
              {
                name: "pi-command",
                source: "extension",
                description: "Pi command",
              },
            ],
          },
        },
      },
    };
    save();
    rmSync(audit, { force: true });
  };
  for (const harness of ["codex", "pi"] as const)
    writeFileSync(
      join(root, harness),
      `#!${process.execPath}
process.env.LOOP_TEST_HARNESS = ${JSON.stringify(harness)};
process.env.LOOP_TEST_HARNESS_REPLIES = ${JSON.stringify(control)};
process.env.LOOP_TEST_HARNESS_AUDIT = ${JSON.stringify(audit)};
import(${JSON.stringify(pathToFileURL(resolve("test/harness.mjs")).href)});
`,
      { mode: 0o755 },
    );
  reset();
  const observations = (): Observation[] =>
    existsSync(audit)
      ? readFileSync(audit, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const respond = (harness: Harness, method: string, reply: Reply) => {
    replies[harness][method] = reply;
    save();
  };
  return {
    executable: (harness: Harness) => join(root, harness),
    reset,
    respond,
    launches: (harness: Harness) =>
      observations().filter(
        (row) => row.type === "launch" && row.harness === harness,
      ),
    requests: (harness: Harness, method: string) =>
      observations().filter(
        (row) =>
          row.type === "request" &&
          row.harness === harness &&
          row.method === method,
      ),
    hold(harness: Harness, method: string, result: unknown) {
      const release = join(root, "gate-" + ++gate);
      respond(harness, method, { result, waitFor: release });
      return () => writeFileSync(release, "released");
    },
  };
}
