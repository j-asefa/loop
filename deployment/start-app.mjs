import { spawnSync, spawn } from "node:child_process";
process.env.LOOP_ENVIRONMENTS_FILE ||= "/private/environments.json";
if (process.env.LOOP_NATIVE_ADMISSION === "1") {
  const result = spawnSync(
    "node",
    ["--import", "tsx", "deployment/provision-environments.ts"],
    // Parsing an invalid secret document can include an excerpt in a native
    // exception. Only the fixed status message below may reach service logs.
    { stdio: "ignore", env: process.env },
  );
  if (result.status !== 0)
    console.error(
      "Native provisioning is unavailable; starting Loop with stored content and existing routes.",
    );
}
const child = spawn("node", ["--import", "tsx", "src/server/serve.ts"], {
  stdio: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code || 0));
