// Supervise both processes as one deployable unit. Persistent data is outside the image.
import { spawn } from "node:child_process";
const children = ["index", "worker"].map((name) =>
  spawn(process.execPath, ["--import", "tsx", `src/server/${name}.ts`], {
    stdio: "inherit",
    env: process.env,
  }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1000).unref();
}
children.forEach((c) => c.on("exit", (code) => stop(code || 1)));
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
