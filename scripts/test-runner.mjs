// Tests choose their own profile/workspace. A live Loop-launched terminal must
// not inject its database, disabled memory setting, daemon flags or credentials.
import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { pathToFileURL } from "node:url";
export function testEnvironment(env, suite) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.startsWith("LOOP_") || key.startsWith("LOOP_TEST_"),
    ),
  );
  if (suite === "vitest") clean.LOOP_PROFILE = "server";
  return clean;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [suite, ...extra] = process.argv.slice(2);
  if (!["vitest", "native"].includes(suite))
    throw new Error("Expected vitest or native suite");
  const args =
    suite === "vitest"
      ? [
          "node_modules/vitest/vitest.mjs",
          "run",
          "test/",
          "--exclude",
          "test/**/*.node.test.ts",
          // "test/" matches any path containing it, so a nested checkout
          // under .tmp (deployment fixtures keep sources there) would be
          // collected as well.
          "--exclude",
          "**/.tmp/**",
          ...extra,
        ]
      : [
          "--import",
          "tsx",
          "--test",
          "--test-concurrency=1",
          ...extra,
          ...globSync("test/*.node.test.ts"),
        ];
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: testEnvironment(process.env, suite),
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
