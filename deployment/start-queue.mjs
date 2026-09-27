import { spawn } from "node:child_process";
const url = process.env.LOOP_QUEUE_READY_URL || "http://loop:3000/api/health";
const deadline = Date.now() + 120_000;
for (;;) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    break;
  } catch {
    if (Date.now() >= deadline) throw new Error("Loop API did not become reachable for the local queue");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
const worker = spawn("node", ["--import", "tsx", "src/server/worker.ts"], { stdio: "inherit", env: process.env });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => worker.kill(signal));
worker.on("error", (error) => { console.error(`Loop queue could not start: ${error.message}`); process.exitCode = 1; });
worker.on("exit", (code) => process.exit(code || 0));
