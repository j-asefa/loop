import { execFileSync } from "node:child_process";

export const MAX_REVIEW_FILE_BYTES = 512_000;

/** Read Git bytes without replacement objects, lazy fetching or index writes.
 * Callers still select read-only commands and disable command-specific drivers.
 */
export function reviewGit(
  directory: string,
  args: string[],
  { maxBuffer = 5_000_000, input }: { maxBuffer?: number; input?: string } = {},
): Buffer {
  return execFileSync(
    "git",
    [
      "--no-replace-objects",
      "--literal-pathspecs",
      "-c",
      "core.quotePath=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.trustctime=true",
      "-c",
      "core.checkStat=default",
      "-c",
      "core.ignorestat=false",
      ...args,
    ],
    {
      cwd: directory,
      encoding: null,
      input,
      timeout: 10000,
      maxBuffer,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_EXTERNAL_DIFF: "",
        GIT_CONFIG_COUNT: "0",
        GIT_ALLOW_PROTOCOL: "",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
}
